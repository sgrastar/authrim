import { describe, expect, it } from 'vitest';
import { LITE_FORM_MAX_BYTES, readLiteForm } from '../form';

function post(body: BodyInit | null, headers: Record<string, string> = {}) {
	return new Request('https://login.example/login', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
		body
	});
}

describe('readLiteForm', () => {
	it('reads urlencoded fields', async () => {
		const result = await readLiteForm(post('email=a%40example.com&txn=abc&empty='));
		expect(result.ok && Object.fromEntries(result.fields)).toEqual({
			email: 'a@example.com',
			txn: 'abc',
			empty: ''
		});
	});

	it('refuses other media types', async () => {
		expect(
			await readLiteForm(post('x=1', { 'content-type': 'multipart/form-data; boundary=x' }))
		).toEqual({ ok: false, reason: 'unsupported_media_type' });
	});

	it('refuses a body over the limit, declared or streamed', async () => {
		const big = 'a=' + 'x'.repeat(LITE_FORM_MAX_BYTES);
		expect(await readLiteForm(post(big))).toEqual({ ok: false, reason: 'too_large' });
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(big));
				controller.close();
			}
		});
		const undeclared = new Request('https://login.example/login', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: stream,
			// @ts-expect-error Node requires duplex for a streamed body.
			duplex: 'half'
		});
		expect(await readLiteForm(undeclared)).toEqual({ ok: false, reason: 'too_large' });
	});

	it('refuses repeated fields, too many fields, long values and bad encoding', async () => {
		expect(await readLiteForm(post('a=1&a=2'))).toEqual({ ok: false, reason: 'malformed' });
		expect(
			await readLiteForm(post(Array.from({ length: 40 }, (_, i) => `f${i}=1`).join('&')))
		).toEqual({ ok: false, reason: 'malformed' });
		expect(await readLiteForm(post(`a=${'x'.repeat(5000)}`))).toEqual({
			ok: false,
			reason: 'malformed'
		});
		expect(await readLiteForm(post('a=%E0%A4%A'))).toEqual({ ok: false, reason: 'malformed' });
	});
});

describe('a passkey assertion', () => {
	it('reads the largest assertion the passkey check accepts, and no other field as long', async () => {
		const { readLitePasskeyCredential } = await import('../totp-passkey');
		const credential = JSON.stringify({
			id: 'A'.repeat(1400),
			rawId: 'A'.repeat(1400),
			type: 'public-key',
			response: {
				authenticatorData: 'B'.repeat(2048),
				clientDataJSON: 'C'.repeat(2048),
				signature: 'D'.repeat(1024),
				userHandle: 'E'.repeat(512)
			},
			authenticatorAttachment: 'cross-platform'
		});
		const form = { txn: 't', csrf: 'c', op: 'o'.repeat(22), challenge: 'pk-1', credential };
		const read = await readLiteForm(post(new URLSearchParams(form).toString()));
		expect(read.ok).toBe(true);
		if (read.ok) expect(readLitePasskeyCredential(read.fields.get('credential'))).not.toBeNull();
		const other = await readLiteForm(
			post(new URLSearchParams({ code: 'x'.repeat(4097) }).toString())
		);
		expect(other).toEqual({ ok: false, reason: 'malformed' });
	});
});
