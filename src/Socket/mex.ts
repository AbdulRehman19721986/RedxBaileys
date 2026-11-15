import { Boom } from '@hapi/boom'
import { getBinaryNodeChild, S_WHATSAPP_NET, type BinaryNode } from '../WABinary'

const wMexQuery = (
	variables: Record<string, unknown>,
	queryId: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string
) => {
	return query({
		tag: 'iq',
		attrs: {
			id: generateMessageTag(),
			type: 'get',
			to: S_WHATSAPP_NET,
			xmlns: 'w:mex'
		},
		content: [
			{
				tag: 'query',
				attrs: { query_id: queryId },
				content: Buffer.from(JSON.stringify({ variables }), 'utf-8')
			}
		]
	})
}

/**
 * WhatsApp occasionally returns a compact binary payload for newsletter
 * metadata instead of the JSON GraphQL body. Only the newsletter metadata
 * endpoint is allowed to recover the channel identifier from that payload.
 */
export const extractNewsletterJidFromBinaryNode = (node: BinaryNode | undefined): string | null => {
	const candidates = new Set<string>()
	const addCandidate = (value: unknown) => {
		if (typeof value !== 'string' && !(value instanceof Uint8Array)) {
			return
		}

		const text = typeof value === 'string' ? value : Buffer.from(value).toString('latin1')
		const explicit = text.match(/(?<![0-9])(120363\d{7,18})(?![0-9])/g) || []
		for (const digits of explicit) {
			candidates.add(`${digits}@newsletter`)
		}
		}
	}

	const visit = (current: BinaryNode | undefined, depth = 0) => {
		if (!current || depth > 8) return
		for (const value of Object.values(current.attrs || {})) addCandidate(value)
		if (Array.isArray(current.content)) {
			for (const child of current.content) visit(child, depth + 1)
		} else {
			addCandidate(current.content)
		}
	}

	visit(node)
	return candidates.size === 1 ? [...candidates][0]! : null
}

const parseWMexJson = (content: BinaryNode['content']): Record<string, unknown> | null => {
	const raw = typeof content === 'string'
		? content
		: content instanceof Uint8Array
			? Buffer.from(content).toString('utf8')
			: null
	if (!raw) return null

	const candidates = [raw.trim()]
	const firstObject = raw.indexOf('{')
	if (firstObject > 0) candidates.push(raw.slice(firstObject).trim())

	for (const candidate of candidates) {
		if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue
		try {
			const parsed: unknown = JSON.parse(candidate)
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>
			}
		} catch {
			// Try the next possible JSON boundary before reporting a bad payload.
		}
	}
	return null
}

export const executeWMexQuery = async <T>(
	variables: Record<string, unknown>,
	queryId: string,
	dataPath: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string
): Promise<T> => {
	const result = await wMexQuery(variables, queryId, query, generateMessageTag)
	const child = getBinaryNodeChild(result, 'result')
	const action = (dataPath || '').startsWith('xwa2_')
		? dataPath.substring(5).replace(/_/g, ' ')
		: dataPath?.replace(/_/g, ' ')

	if (child?.content) {
		const data = parseWMexJson(child.content)
		if (!data) {
			if (dataPath === 'xwa2_newsletter_metadata') {
				const id = extractNewsletterJidFromBinaryNode(child)
				if (id) return { id } as T
			}
			throw new Boom(`Failed to parse ${action} response: expected a JSON WMex result.`, {
				statusCode: 502,
				data: { queryId, dataPath, responseTag: result.tag, responseAttrs: result.attrs }
			})
		}

		const errors = Array.isArray(data.errors) ? data.errors : []
		if (errors.length > 0) {
			const firstError = errors[0] as { extensions?: { error_code?: number }; message?: string }
			const errorMessages = errors.map((err: { message?: string }) => err.message || 'Unknown error').join(', ')
			const errorCode = firstError.extensions?.error_code || 400
			throw new Boom(`GraphQL server error: ${errorMessages}`, { statusCode: errorCode, data: firstError })
		}

		const response = dataPath ? (data.data as Record<string, unknown> | undefined)?.[dataPath] : data.data
		if (typeof response !== 'undefined') {
			return response as T
		}
	}

	throw new Boom(`Failed to ${action}, unexpected response structure.`, {
		statusCode: 400,
		data: { responseTag: result.tag, responseAttrs: result.attrs }
	})
}
