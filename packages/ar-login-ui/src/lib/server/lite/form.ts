/**
 * Reading a lite form: `application/x-www-form-urlencoded` only, read with a byte limit before it
 * is parsed (a large body or a flood of fields costs nothing before the limit), each field at
 * most once and of bounded length. A lite action reads its body through this, never through
 * `request.formData()`.
 */

export const LITE_FORM_MAX_BYTES = 16 * 1024;
export const LITE_FORM_MAX_FIELDS = 32;
export const LITE_FORM_MAX_VALUE_LENGTH = 4096;

/**
 * Fields whose value may be longer: a passkey assertion (`credential`, its JSON), whose parts
 * the action bounds one by one (totp-passkey.ts `readLitePasskeyCredential`: up to two 1,364-character
 * credential IDs and an RSA-4096 signature). The whole body stays within LITE_FORM_MAX_BYTES.
 */
const LITE_FORM_LONG_VALUE_LENGTHS: ReadonlyMap<string, number> = new Map([['credential', 9216]]);

export type LiteFormRefusal = 'unsupported_media_type' | 'too_large' | 'malformed';

export type LiteFormResult =
	| { ok: true; fields: ReadonlyMap<string, string> }
	| { ok: false; reason: LiteFormRefusal };

export function isLiteFormContentType(value: string | null): boolean {
	return (value ?? '').split(';')[0]?.trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

/** Whether a request's declared length is already over the limit (checked before routing). */
export function liteFormDeclaredTooLarge(request: Request): boolean {
	const declared = request.headers.get('content-length');
	if (declared === null) return false;
	const length = Number(declared);
	return !Number.isSafeInteger(length) || length < 0 || length > LITE_FORM_MAX_BYTES;
}

async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

export async function readLiteForm(request: Request): Promise<LiteFormResult> {
	if (!isLiteFormContentType(request.headers.get('content-type'))) {
		return { ok: false, reason: 'unsupported_media_type' };
	}
	if (liteFormDeclaredTooLarge(request)) return { ok: false, reason: 'too_large' };
	const body = await readLimited(request, LITE_FORM_MAX_BYTES);
	if (!body) return { ok: false, reason: 'too_large' };
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(body);
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	const fields = new Map<string, string>();
	if (text === '') return { ok: true, fields };
	const pairs = text.split('&');
	if (pairs.length > LITE_FORM_MAX_FIELDS) return { ok: false, reason: 'malformed' };
	for (const pair of pairs) {
		const equals = pair.indexOf('=');
		let name: string;
		let value: string;
		try {
			name = decodeURIComponent((equals < 0 ? pair : pair.slice(0, equals)).replace(/\+/gu, ' '));
			value = equals < 0 ? '' : decodeURIComponent(pair.slice(equals + 1).replace(/\+/gu, ' '));
		} catch {
			return { ok: false, reason: 'malformed' };
		}
		const limit = LITE_FORM_LONG_VALUE_LENGTHS.get(name) ?? LITE_FORM_MAX_VALUE_LENGTH;
		if (!name || fields.has(name) || value.length > limit) {
			return { ok: false, reason: 'malformed' };
		}
		fields.set(name, value);
	}
	return { ok: true, fields };
}
