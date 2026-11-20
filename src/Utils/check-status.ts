import { randomUUID } from 'crypto'
import type { AuthenticationCreds } from '../Types'
import { initAuthCreds } from './auth-utils'

/**
 * Standalone, best-effort WhatsApp registration status check.
 * Ported from the MIT-licensed StableBail extra utility by Team Qadeer.
 * Uses throwaway credentials; it does not connect or register the caller's account.
 * WhatsApp may rate-limit or change this undocumented endpoint; results are not an official verdict.
 */
const REGISTRATION_BASE_URL = 'https://v.whatsapp.net/v2'
const REGISTRATION_USER_AGENT = 'WhatsApp/2.24.12.78 iOS/17.5.1 Device/Apple-iPhone_13'
const APPEAL_GRAPHQL_URL = 'https://graph.whatsapp.com/graphql'
const APPEAL_STATUS_DOC_ID = '25573756098908502'

export type WAStatusKind = 'active' | 'banned' | 'blocked' | 'rate_limited' | 'error'
export interface WABanInfo {
	banType: 'permanent' | 'temporary'
	violationType: number | string | null
	canAppeal: boolean
	appealToken: string
	banTime: number | null
	banDate: string | null
	appealStatus: string | null
	appealCreatedAt: string | null
}
export interface WAStatusResult {
	number: string
	status: WAStatusKind
	isBanned: boolean
	isNeedOfficialWa: boolean
	banInfo: WABanInfo | null
}
export interface CheckStatusOptions {
	appealAccessToken?: string
	timeoutMs?: number
}

const COUNTRY_CALLING_CODES = [
	'1', '7', '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45',
	'46', '47', '48', '49', '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63',
	'64', '65', '66', '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98', '212',
	'213', '216', '218', '220', '221', '234', '254', '351', '352', '353', '354', '358', '380',
	'880', '966', '971', '972', '973', '974', '977'
]

export const parsePhoneNumberParts = (digits: string) => {
	for (const prefix of [...COUNTRY_CALLING_CODES].sort((a, b) => b.length - a.length)) {
		if (digits.startsWith(prefix)) return { countryCode: prefix, nationalNumber: digits.slice(prefix.length) }
	}
	return { countryCode: digits.slice(0, 2), nationalNumber: digits.slice(2) }
}

const buildExistParams = (creds: AuthenticationCreds, countryCode: string, nationalNumber: string) => {
	const regId = Buffer.alloc(4)
	regId.writeInt32BE(creds.registrationId || 0)
	const signedKeyId = Buffer.alloc(3)
	signedKeyId.writeUInt16BE((creds.signedPreKey?.keyId || 1) & 0xffff, 1)
	return {
		cc: countryCode, in: nationalNumber, Rc: '0', lg: 'en', lc: 'GB', mistyped: '6',
		authkey: Buffer.from(creds.noiseKey.public).toString('base64url'),
		e_regid: regId.toString('base64url'), e_keytype: 'BQ',
		e_ident: Buffer.from(creds.signedIdentityKey.public).toString('base64url'),
		e_skey_id: signedKeyId.toString('base64url'),
		e_skey_val: Buffer.from(creds.signedPreKey.keyPair.public).toString('base64url'),
		e_skey_sig: Buffer.from(creds.signedPreKey.signature).toString('base64url'),
		fdid: randomUUID(), network_ratio_type: '1', expid: randomUUID(), simnum: '1', hasav: '2'
	}
}

interface ExistResponse {
	status?: string
	reason?: string
	appeal_token?: string
	violation_type?: number | string
	custom_block_screen?: unknown
	[key: string]: unknown
}
const requestExist = async (params: Record<string, string>, timeoutMs: number) => {
	const qs = new URLSearchParams(params)
	const response = await fetch(REGISTRATION_BASE_URL + '/exist?' + qs.toString(), {
		headers: { 'User-Agent': REGISTRATION_USER_AGENT },
		signal: AbortSignal.timeout(timeoutMs)
	})
	const body = (await response.json().catch(() => ({}))) as ExistResponse
	return { ok: response.ok, body }
}
interface AppealStatus {
	status?: string
	ban_time?: number
	appeal_creation_time?: number
	[key: string]: unknown
}
const requestAppealStatus = async (appealToken: string, accessToken: string, timeoutMs: number) => {
	try {
		const response = await fetch(APPEAL_GRAPHQL_URL, {
			method: 'POST',
			headers: { 'User-Agent': REGISTRATION_USER_AGENT, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				variables: JSON.stringify({ app_id: 'dev.app.id', request_token: appealToken }),
				access_token: accessToken, doc_id: APPEAL_STATUS_DOC_ID, lang: 'en_GB'
			}),
			signal: AbortSignal.timeout(timeoutMs)
		})
		const data = (await response.json().catch(() => ({}))) as {
			data?: { whatsapp_support_ban_appeal_status?: AppealStatus }
		}
		return data.data?.whatsapp_support_ban_appeal_status || null
	} catch {
		return null
	}
}

/**
 * Checks one international number using WhatsApp's registration endpoint.
 * This is a best-effort signal, not an official ban-verification API.
 * Avoid bulk enumeration; WhatsApp can rate-limit requests.
 */
export const checkStatusWA = async (phoneNumber: string, options: CheckStatusOptions = {}): Promise<WAStatusResult> => {
	if (!phoneNumber) throw new Error('checkStatusWA: please provide a phone number')
	let raw = String(phoneNumber).trim()
	if (raw.includes('@')) raw = raw.slice(0, raw.indexOf('@'))
	if (raw.includes(':')) raw = raw.slice(0, raw.indexOf(':'))
	const digits = raw.replace(/\D/g, '')
	if (digits.length < 7 || digits.length > 15) {
		throw new Error('checkStatusWA: provide a valid international number (7–15 digits, including country code)')
	}
	const number = '+' + digits
	const parts = parsePhoneNumberParts(digits)
	const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 15000, 1000), 30000)
	const build = (status: WAStatusKind, isBanned: boolean, isNeedOfficialWa: boolean, banInfo: WABanInfo | null = null) =>
		({ number, status, isBanned, isNeedOfficialWa, banInfo })

	let response: { ok: boolean; body: ExistResponse }
	try {
		response = await requestExist(buildExistParams(initAuthCreds(), parts.countryCode, parts.nationalNumber), timeoutMs)
	} catch {
		return build('error', false, false)
	}
	const body = response.body
	if (body.appeal_token) {
		const appeal = options.appealAccessToken
			? await requestAppealStatus(body.appeal_token, options.appealAccessToken, timeoutMs)
			: null
		const appealStatus = appeal?.status || null
		const banType = appealStatus === 'BANNED' ? 'permanent' : 'temporary'
		return build('banned', true, false, {
			banType, violationType: body.violation_type ?? null, canAppeal: banType !== 'permanent',
			appealToken: body.appeal_token, banTime: appeal?.ban_time ?? null,
			banDate: appeal?.ban_time ? new Date(appeal.ban_time * 1000).toISOString() : null,
			appealStatus,
			appealCreatedAt: appeal?.appeal_creation_time
				? new Date(appeal.appeal_creation_time * 1000).toISOString()
				: null
		})
	}
	if (body.custom_block_screen) return build('blocked', false, true)
	if (body.reason === 'temporarily_unavailable') return build('rate_limited', false, false)
	if ((response.ok && (body.status === 'ok' || body.status === 'sent')) || body.reason === 'incorrect') {
		return build('active', false, false)
	}
	return build('error', false, false)
}
