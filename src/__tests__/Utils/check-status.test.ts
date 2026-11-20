import { checkStatusWA, parsePhoneNumberParts } from '../../Utils/check-status'

describe('WhatsApp status checker input handling', () => {
	it('splits international Pakistan numbers using the country calling code', () => {
		expect(parsePhoneNumberParts('923001234567')).toEqual({
			countryCode: '92',
			nationalNumber: '3001234567'
		})
	})

	it('accepts JID-shaped number input during normalization but validates length', async () => {
		await expect(checkStatusWA('12345@s.whatsapp.net')).rejects.toThrow(/valid international number/)
	})

	it('rejects empty input before making a network request', async () => {
		await expect(checkStatusWA('')).rejects.toThrow(/please provide a phone number/)
	})
})
