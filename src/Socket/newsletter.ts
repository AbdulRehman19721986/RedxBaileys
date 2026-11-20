import type { NewsletterCreateResponse, SocketConfig, WAMediaUpload, WAMessage } from '../Types'
import { createHash, randomBytes } from 'crypto'
import { proto } from '../../WAProto/index.js'
import { aesEncryptGCM, hmacSign } from '../Utils/crypto'
import { jidNormalizedUser } from '../WABinary'
import type { NewsletterMetadata, NewsletterUpdate } from '../Types'
import { QueryIds, XWAPaths } from '../Types'
import { generateProfilePicture } from '../Utils/messages-media'
import { getBinaryNodeChild } from '../WABinary'
import { makeGroupsSocket } from './groups'
import { executeWMexQuery as genericExecuteWMexQuery } from './mex'

/** Accept a bare invite code or a WhatsApp channel/post permalink. */
const extractNewsletterInviteCode = (value: string): string => {
	const trimmed = String(value || '').trim()
	if (!trimmed) {
		throw new Error('Newsletter invite code or channel URL is required')
	}

	// URL() needs a scheme. Keep bare invite codes untouched, while allowing
	// whatsapp.com/channel/<code>/<post-id>?... links used by channel shares.
	const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
	try {
		const url = new URL(candidate)
		const host = url.hostname.toLowerCase().replace(/^www\./, '')
		if (host === 'whatsapp.com' || host === 'm.whatsapp.com') {
			const match = url.pathname.match(/^\/channel\/([^/]+)(?:\/[^/]+)?\/?$/i)
			if (match?.[1]) return decodeURIComponent(match[1])
			throw new Error('Invalid WhatsApp Channel invite link')
		}
	} catch (error) {
		// A bare invite code is expected and should pass through unchanged.
		if (/^https?:\/\//i.test(trimmed) || trimmed.includes('whatsapp.com/')) {
			throw error
		}
	}

	return trimmed
}

const parseNewsletterCreateResponse = (response: NewsletterCreateResponse): NewsletterMetadata => {
	const { id, thread_metadata: thread, viewer_metadata: viewer } = response
	return {
		id: id,
		owner: undefined,
		name: thread.name.text,
		creation_time: parseInt(thread.creation_time, 10),
		description: thread.description.text,
		invite: thread.invite,
		subscribers: parseInt(thread.subscribers_count, 10),
		verification: thread.verification,
		picture: {
			id: thread.picture.id,
			directPath: thread.picture.direct_path
		},
		mute_state: viewer.mute
	}
}

const parseNewsletterMetadata = (result: unknown): NewsletterMetadata | null => {
	if (typeof result !== 'object' || result === null) {
		return null
	}

	// Already-flat shape: { id, name, invite, ... }
	if ('id' in result && typeof result.id === 'string') {
		// If it also has thread_metadata, parse it properly rather than returning raw.
		const r = result as Record<string, unknown>
		if (r.thread_metadata && typeof r.thread_metadata === 'object') {
			return parseNewsletterCreateResponse(result as NewsletterCreateResponse)
		}

		return result as NewsletterMetadata
	}

	// Wrapped in result key (legacy)
	if ('result' in result && typeof result.result === 'object' && result.result !== null) {
		return parseNewsletterMetadata(result.result)
	}

	// Raw GraphQL shape from METADATA query:
	// { id, state, thread_metadata: { name: { text }, invite, ... }, viewer_metadata: { mute } }
	// This is identical to NewsletterCreateResponse — reuse that parser.
	const r = result as Record<string, unknown>
	if (r.thread_metadata && typeof r.thread_metadata === 'object') {
		try {
			return parseNewsletterCreateResponse(result as NewsletterCreateResponse)
		} catch {
			// Partial data — build best-effort flat object
			const thread = r.thread_metadata as Record<string, unknown>
			const nameObj = thread.name as Record<string, unknown> | undefined
			const name = typeof thread.name === 'string' ? thread.name : ((nameObj?.text as string | undefined) ?? 'Unknown')
			return {
				id: (r.id as string) ?? '',
				name,
				invite: thread.invite as string | undefined,
				description: (thread.description as Record<string, unknown> | undefined)?.text as string | undefined,
				subscribers: thread.subscribers_count ? parseInt(thread.subscribers_count as string, 10) : undefined,
				verification: thread.verification as 'VERIFIED' | 'UNVERIFIED' | undefined
			}
		}
	}

	return null
}

export const makeNewsletterSocket = (config: SocketConfig) => {
	const sock = makeGroupsSocket(config)
	const { query, generateMessageTag } = sock

	const executeWMexQuery = <T>(variables: Record<string, unknown>, queryId: string, dataPath: string): Promise<T> => {
		return genericExecuteWMexQuery<T>(variables, queryId, dataPath, query, generateMessageTag)
	}

	const newsletterUpdate = async (jid: string, updates: NewsletterUpdate) => {
		const variables = {
			newsletter_id: jid,
			updates: {
				...updates,
				settings: null
			}
		}
		return executeWMexQuery(variables, QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update')
	}

	const newsletterMetadata = async (type: 'invite' | 'jid', key: string): Promise<NewsletterMetadata | null> => {
		const lookupKey = type === 'invite' ? extractNewsletterInviteCode(key) : key.trim()
		const variables = {
			fetch_creation_time: true,
			fetch_full_image: true,
			fetch_viewer_metadata: true,
			input: { key: lookupKey, type: type.toUpperCase() }
		}
		const result = await executeWMexQuery<unknown>(variables, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata)
		return parseNewsletterMetadata(result)
	}

	const newsletterJidFromInvite = async (inviteOrUrl: string): Promise<string> => {
		const metadata = await newsletterMetadata('invite', inviteOrUrl)
		if (!metadata?.id?.endsWith('@newsletter')) {
			throw new Error('Unable to resolve WhatsApp Channel JID from the supplied invite link')
		}

		return metadata.id
	}

	return {
		...sock,
		newsletterCreate: async (name: string, description?: string): Promise<NewsletterMetadata> => {
			const variables = {
				input: {
					name,
					description: description ?? null
				}
			}
			const rawResponse = await executeWMexQuery<NewsletterCreateResponse>(
				variables,
				QueryIds.CREATE,
				XWAPaths.xwa2_newsletter_create
			)
			return parseNewsletterCreateResponse(rawResponse)
		},

		newsletterUpdate,

		newsletterSubscribers: async (jid: string) => {
			return executeWMexQuery<{ subscribers: number }>(
				{ newsletter_id: jid },
				QueryIds.SUBSCRIBERS,
				XWAPaths.xwa2_newsletter_subscribers
			)
		},

		newsletterMetadata,
		newsletterJidFromInvite,

		newsletterFollow: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_join_v2)
		},

		newsletterUnfollow: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.xwa2_newsletter_leave_v2)
		},

		newsletterMute: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.MUTE, XWAPaths.xwa2_newsletter_mute_v2)
		},

		newsletterUnmute: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNMUTE, XWAPaths.xwa2_newsletter_unmute_v2)
		},

		newsletterUpdateName: async (jid: string, name: string) => {
			return await newsletterUpdate(jid, { name })
		},

		newsletterUpdateDescription: async (jid: string, description: string) => {
			return await newsletterUpdate(jid, { description })
		},

		newsletterUpdatePicture: async (jid: string, content: WAMediaUpload) => {
			const { img } = await generateProfilePicture(content)
			return await newsletterUpdate(jid, { picture: img.toString('base64') })
		},

		newsletterRemovePicture: async (jid: string) => {
			return await newsletterUpdate(jid, { picture: '' })
		},

		/**
		 * Vote in a channel poll using the original decoded newsletter WAMessage.
		 * Pass 1-based option indexes or exact option names. The original message
		 * must come from the 'newsletter.message' event so its messageSecret is intact.
		 */
		newsletterVote: async (jid: string, pollMessage: WAMessage, selections: Array<string | number> | string | number[]) => {
			const message = pollMessage?.message
			const poll = message?.pollCreationMessage || message?.pollCreationMessageV2 || message?.pollCreationMessageV3
			if (!poll) throw new Error('Provided channel message is not a poll or has no decoded poll options.')

			const rawSecret = pollMessage.messageContextInfo?.messageSecret
			const secret = typeof rawSecret === 'string' ? Buffer.from(rawSecret, 'base64') : Buffer.from(rawSecret || [])
			if (secret.length !== 32) throw new Error('Poll messageSecret missing/invalid. Capture the original newsletter.message event; history counters are not enough.')

			const pollKey = pollMessage.key
			if (!pollKey?.id) throw new Error('Poll creation message key/id is missing.')
			const options = Array.isArray(poll.options) ? poll.options : []
			if (!options.length) throw new Error('Poll has no selectable options.')

			const requested = (Array.isArray(selections) ? selections : [selections]).filter(value => value !== null && value !== undefined)
			const selected = new Map<string, { optionName: string }>()
			for (const item of requested) {
				if (typeof item === 'number' || /^\\d+$/.test(String(item).trim())) {
					const index = Number(item)
					if (!Number.isSafeInteger(index) || index < 1 || index > options.length) throw new Error(`Poll option index ${item} is out of range (1-${options.length}).`)
					const option = options[index - 1]!
					selected.set(option.optionName || '', option)
					continue
				}
				const wanted = String(item).normalize('NFC').trim().replace(/\\s+/g, ' ').toLocaleLowerCase()
				const option = options.find(candidate => String(candidate.optionName || '').normalize('NFC').trim().replace(/\\s+/g, ' ').toLocaleLowerCase() === wanted)
				if (!option) throw new Error(`Poll option not found: ${String(item)}. Available: ${options.map(option => option.optionName).join(' | ')}`)
				selected.set(option.optionName || '', option)
			}
			if (!selected.size) throw new Error('Select at least one poll option.')
			const max = Number(poll.selectableOptionsCount || 1)
			if (selected.size > max) throw new Error(`This poll allows only ${max} selection(s).`)

			const socketUser = sock.user as any
			const voter = jidNormalizedUser(socketUser?.id || socketUser?.lid || '')
			if (!voter) throw new Error('Connected account JID is unavailable.')
			const creator = jidNormalizedUser(pollKey.participant || pollKey.remoteJid || jid)
			const sign = Buffer.concat([Buffer.from(pollKey.id), Buffer.from(creator), Buffer.from(voter), Buffer.from('Poll Vote'), Buffer.from([1])])
			const key0 = hmacSign(secret, Buffer.alloc(32), 'sha256')
			const encryptionKey = hmacSign(sign, key0, 'sha256')
			const aad = Buffer.from(pollKey.id + String.fromCharCode(0) + voter)
			const selectedOptions = [...selected.values()].map(option => createHash('sha256').update(Buffer.from(option.optionName || '', 'utf8')).digest())
			const voteBytes = proto.Message.PollVoteMessage.encode({ selectedOptions }).finish()
			const iv = randomBytes(12)
			const vote = { encPayload: aesEncryptGCM(voteBytes, encryptionKey, iv, aad), encIv: iv }
			await sock.sendMessage(jid, { pollUpdateMessage: { pollCreationMessageKey: pollKey, vote, senderTimestampMs: Date.now() } } as any)
			return { ok: true, votedFor: [...selected.keys()] }
		},

		newsletterReactMessage: async (jid: string, serverId: string, reaction?: string) => {
			await query({
				tag: 'message',
				attrs: {
					to: jid,
					...(reaction ? {} : { edit: '7' }),
					type: 'reaction',
					server_id: serverId,
					id: generateMessageTag()
				},
				content: [
					{
						tag: 'reaction',
						attrs: reaction ? { code: reaction } : {}
					}
				]
			})
		},

		newsletterFetchMessages: async (jid: string, count: number, since: number, after: number) => {
			const messageUpdateAttrs: { count: string; since?: string; after?: string } = {
				count: count.toString()
			}
			if (typeof since === 'number') {
				messageUpdateAttrs.since = since.toString()
			}

			if (after) {
				messageUpdateAttrs.after = after.toString()
			}

			const result = await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					type: 'get',
					xmlns: 'newsletter',
					to: jid
				},
				content: [
					{
						tag: 'message_updates',
						attrs: messageUpdateAttrs
					}
				]
			})
			return result
		},

		subscribeNewsletterUpdates: async (jid: string): Promise<{ duration: string } | null> => {
			const result = await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					type: 'set',
					xmlns: 'newsletter',
					to: jid
				},
				content: [{ tag: 'live_updates', attrs: {}, content: [] }]
			})
			const liveUpdatesNode = getBinaryNodeChild(result, 'live_updates')
			const duration = liveUpdatesNode?.attrs?.duration
			return duration ? { duration: duration } : null
		},

		newsletterAdminCount: async (jid: string): Promise<number> => {
			const response = await executeWMexQuery<{ admin_count: number }>(
				{ newsletter_id: jid },
				QueryIds.ADMIN_COUNT,
				XWAPaths.xwa2_newsletter_admin_count
			)
			return response.admin_count
		},

		newsletterChangeOwner: async (jid: string, newOwnerJid: string) => {
			await executeWMexQuery(
				{ newsletter_id: jid, user_id: newOwnerJid },
				QueryIds.CHANGE_OWNER,
				XWAPaths.xwa2_newsletter_change_owner
			)
		},

		newsletterDemote: async (jid: string, userJid: string) => {
			await executeWMexQuery({ newsletter_id: jid, user_id: userJid }, QueryIds.DEMOTE, XWAPaths.xwa2_newsletter_demote)
		},

		newsletterDelete: async (jid: string) => {
			await executeWMexQuery({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2)
		}
	}
}

export type NewsletterSocket = ReturnType<typeof makeNewsletterSocket>
