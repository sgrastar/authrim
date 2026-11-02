import { describe, expect, it } from 'vitest';
import {
	base32Encode,
	base64UrlToBytes,
	groupTransactionCode,
	keyConfirmationCode
} from './confirmation-code';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('base32Encode (RFC 4648 test vectors, no padding)', () => {
	it.each([
		['', ''],
		['f', 'MY'],
		['fo', 'MZXQ'],
		['foo', 'MZXW6'],
		['foob', 'MZXW6YQ'],
		['fooba', 'MZXW6YTB'],
		['foobar', 'MZXW6YTBOI']
	])('%j -> %s', (input, expected) => {
		expect(base32Encode(bytes(input))).toBe(expected);
	});
});

describe('base64UrlToBytes', () => {
	it('decodes url-safe input with or without padding', () => {
		expect(Array.from(base64UrlToBytes('-_8')!)).toEqual([251, 255]);
		expect(Array.from(base64UrlToBytes('-_8=')!)).toEqual([251, 255]);
	});

	it('rejects characters outside the alphabet and impossible lengths', () => {
		expect(base64UrlToBytes('ab+/')).toBeNull();
		expect(base64UrlToBytes('a')).toBeNull();
	});
});

describe('keyConfirmationCode', () => {
	it('groups the first 8 base32 characters 4-4', () => {
		// "foobar" -> MZXW6YTBOI; base64url of "foobar" is Zm9vYmFy
		expect(keyConfirmationCode('Zm9vYmFy')).toBe('MZXW-6YTB');
	});

	it('uses a 32-byte SHA-256 thumbprint', () => {
		const thumbprint = 'A'.repeat(43); // 32 zero bytes
		expect(keyConfirmationCode(thumbprint)).toBe('AAAA-AAAA');
	});

	it('returns null for input that is not a usable thumbprint', () => {
		expect(keyConfirmationCode('')).toBeNull();
		expect(keyConfirmationCode('Zm9v')).toBeNull(); // 3 bytes -> 5 chars
		expect(keyConfirmationCode('not base64url!')).toBeNull();
	});
});

describe('groupTransactionCode', () => {
	it('groups six digits 3-3 and leaves anything else alone', () => {
		expect(groupTransactionCode('123456')).toBe('123 456');
		expect(groupTransactionCode('12345')).toBe('12345');
	});
});
