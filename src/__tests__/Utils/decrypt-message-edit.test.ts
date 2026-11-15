import { createCipheriv, hkdfSync } from 'node:crypto'
import P from 'pino'
import { proto } from '../../../WAProto/index.js'
import type { WAMessage } from '../../Types'
import type { SignalRepositoryWithLIDStore } from '../../Types/Signal'
import { decryptMessageNode } from '../../Utils/decode-wa-message'
import { decryptMessageEdit, isEncryptedMessageEdit } from '../../Utils/decrypt-message-edit'
import { processMessage } from '../../Utils/process-message'
import { jidNormalizedUser } from '../../WABinary'

const secret = Buffer.alloc(32, 7)
const iv = Buffer.alloc(12, 8)
const originalId = 'fictional-original-message'
const editorPn = '123450001:5@s.whatsapp.net'
const editorPnUser = jidNormalizedUser(editorPn)
const groupJid = '120363000000000000@g.us'
const plaintext = proto.Message.encode({
	protocolMessage: {
		type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
		key: { id: originalId, fromMe: false },
		editedMessage: { conversation: 'Fictional corrected message' },
		timestampMs: 1700000000000
	}
}).finish()
const derivedKey = Buffer.from(
	hkdfSync(
		'sha256',
		secret,
		Buffer.alloc(32),
		Buffer.from(originalId + editorPnUser + editorPnUser + 'Message Edit'),
		32
	)
)
const cipher = createCipheriv('aes-256-gcm', derivedKey, iv)
const encryptedPayload = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
const targetKey = {
	remoteJid: groupJid,
	fromMe: false,
	id: originalId,
	participant: editorPn,
	participantAlt: editorPn
}
const encryptedEdit: proto.Message.ISecretEncryptedMessage = {
	secretEncType: proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT,
	targetMessageKey: targetKey,
	encIv: iv,
	encPayload: encryptedPayload
}

describe('encrypted WhatsApp MESSAGE_EDIT', () => {
	it('authenticates and decrypts an independently encrypted edit payload', () => {
		const decoded = decryptMessageEdit(encryptedEdit, {
			originalSenderJid: editorPn,
			originalMsgId: originalId,
			messageSecret: secret,
			editorJid: editorPn
		})
		expect(decoded.protocolMessage?.editedMessage?.conversation).toBe('Fictional corrected message')
		expect(isEncryptedMessageEdit({ secretEncryptedMessage: encryptedEdit })).toBe(true)
		expect(isEncryptedMessageEdit({ conversation: 'plain' })).toBe(false)
	})

	it('rejects incorrect secrets, JIDs, IVs and ciphertext', () => {
		const context = { originalSenderJid: editorPn, originalMsgId: originalId, messageSecret: secret, editorJid: editorPn }
		expect(() => decryptMessageEdit(encryptedEdit, { ...context, editorJid: '999999999@lid' })).toThrow()
		expect(() => decryptMessageEdit(encryptedEdit, { ...context, messageSecret: Buffer.alloc(32, 9) })).toThrow()
		expect(() => decryptMessageEdit({ ...encryptedEdit, encIv: Buffer.alloc(11) }, context)).toThrow(/IV length/)
		const damaged = Buffer.from(encryptedPayload)
		damaged[0] = damaged[0]! ^ 1
		expect(() => decryptMessageEdit({ ...encryptedEdit, encPayload: damaged }, context)).toThrow()
	})

	it('emits messages.update when getMessage retains the original message secret', async () => {
		const events: Array<{ name: string; payload: unknown }> = []
		const originalContent = { messageContextInfo: { messageSecret: secret }, conversation: 'Original message' } as proto.IMessage
		const incoming: WAMessage = {
			key: { remoteJid: groupJid, fromMe: false, id: 'edit-envelope-id', participant: editorPn, participantAlt: editorPn },
			message: { secretEncryptedMessage: encryptedEdit },
			messageTimestamp: 1700000000
		}
		const context = {
			shouldProcessHistoryMsg: false,
			creds: { me: { id: '999999999@s.whatsapp.net', lid: '999999999@lid' } },
			keyStore: {},
			ev: { emit: (name: string, payload: unknown) => { events.push({ name, payload }); return true } },
			options: {},
			signalRepository: {},
			getMessage: async () => originalContent
		} as unknown as Parameters<typeof processMessage>[1]
		await processMessage(incoming, context)
		const update = events.find(event => event.name === 'messages.update')?.payload as Array<{ key: WAMessage['key']; update: { message?: proto.IMessage } }>
		expect(update).toHaveLength(1)
		expect(update[0]!.key.id).toBe(originalId)
		expect(update[0]!.update.message?.editedMessage?.message?.conversation).toBe('Fictional corrected message')
	})

	it('preserves the outer message secret when unwrapping linked-device messages', async () => {
		const repository = { lidMapping: { getLIDForPN: async () => null } } as unknown as SignalRepositoryWithLIDStore
		const decoded = decryptMessageNode(
			{
				tag: 'message',
				attrs: { id: 'fictional-linked-device', from: '12025550199@s.whatsapp.net', recipient: editorPn, t: '1700000000' },
				content: [{
					tag: 'plaintext',
					attrs: {},
					content: proto.Message.encode({
						messageContextInfo: { messageSecret: secret },
						deviceSentMessage: {
							destinationJid: editorPn,
							message: { conversation: 'Linked device message', messageContextInfo: { deviceListMetadataVersion: 2 } }
						}
					}).finish()
				}]
			},
			'12025550199@s.whatsapp.net',
		'999999999@lid',
			repository,
			P({ level: 'silent' })
		)
		await decoded.decrypt()
		expect(Buffer.from(decoded.fullMessage.message?.messageContextInfo?.messageSecret || [])).toEqual(secret)
		expect(decoded.fullMessage.message?.messageContextInfo?.deviceListMetadataVersion).toBe(2)
	})
})
