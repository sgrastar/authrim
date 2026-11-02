/**
 * The key confirmation code: what the admin compares with the code Keyring shows for its new
 * key. It is the first 8 characters of the RFC 4648 base32 (no padding) encoding of the holder
 * key's RFC 7638 thumbprint, grouped 4-4 (`ABCD-EFGH`).
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Bytes of a base64url string (padding optional), or null when it is not valid base64url. */
export function base64UrlToBytes(input: string): Uint8Array | null {
	const value = input.replace(/={0,2}$/, '');
	if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** RFC 4648 base32 without padding. */
export function base32Encode(bytes: Uint8Array): string {
	let output = '';
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
		buffer &= (1 << bits) - 1;
	}
	if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
	return output;
}

/** `ABCD-EFGH` for a base64url thumbprint, or null when it cannot yield 8 characters. */
export function keyConfirmationCode(thumbprint: string): string | null {
	const bytes = base64UrlToBytes(thumbprint);
	if (!bytes) return null;
	const head = base32Encode(bytes).slice(0, 8);
	if (head.length < 8) return null;
	return `${head.slice(0, 4)}-${head.slice(4)}`;
}

/** `123 456` for a 6-digit transaction code; anything else is returned unchanged. */
export function groupTransactionCode(code: string): string {
	return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
