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
