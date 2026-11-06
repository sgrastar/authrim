import { describe, expect, it, vi } from 'vitest';
import {
	createLiteBackendClient,
	isForwardableSetCookie,
	parseSetCookie,
	pathMatches
} from '../backend-client';

function answer(setCookies: string[], body: unknown = { ok: true }, status = 200) {
	const headers = new Headers({ 'Content-Type': 'application/json' });
	for (const cookie of setCookies) headers.append('Set-Cookie', cookie);
	return new Response(JSON.stringify(body), { status, headers });
}

function client(fetch: (url: string, init: RequestInit) => Promise<Response>, extra = {}) {
	return createLiteBackendClient({
		fetcher: { fetch: vi.fn(fetch) },
		publicOrigin: 'https://id.example',
		backendBaseUrl: 'https://backend.internal/',
		cookieHeader: 'authrim_session=s1; theme=dark',
		clientIp: '203.0.113.7',
		userAgent: 'test-agent',
		originVerified: true,
		...extra
	});
}

describe('the lite backend client', () => {
	it('passes cookies set by one call to the next, as a browser would', async () => {
		const seen: Headers[] = [];
		const backend = client(async (_url, init) => {
			seen.push(new Headers(init.headers));
			return seen.length === 1
				? answer([
						'authrim_flow=f1; Path=/; Secure; HttpOnly; SameSite=Lax',
						'authrim_step=one; Path=/api; Secure',
						'theme=; Path=/; Secure; Max-Age=0'
					])
				: answer([]);
		});
		await backend.request('/api/v1/direct/session', { json: { a: 1 } });
		await backend.request('/api/v1/flow/submit', { json: { b: 2 } });
		expect(seen[0]?.get('cookie')).toBe('authrim_session=s1; theme=dark');
		// Both new cookies are kept (not just the last header), the deleted one is gone; the cookie
		// with the longer matching Path comes first, as a browser sends it.
		expect(seen[1]?.get('cookie')).toBe('authrim_step=one; authrim_session=s1; authrim_flow=f1');
		expect(backend.setCookies()).toEqual([
			'authrim_flow=f1; Path=/; Secure; HttpOnly; SameSite=Lax',
			'authrim_step=one; Path=/api; Secure',
			'theme=; Path=/; Secure; Max-Age=0'
		]);
	});

	it('keeps cookies of the same name and another Path apart, and sends each where it belongs', async () => {
		const seen: Headers[] = [];
		const backend = client(
			async (_url, init) => {
				seen.push(new Headers(init.headers));
				if (seen.length === 1) {
					return answer(['sid=root; Path=/; Secure', 'sid=api; Path=/api; Secure']);
				}
				if (seen.length === 2) return answer(['sid=; Path=/api; Secure; Max-Age=0']);
				return answer([]);
			},
			{ cookieHeader: null }
		);
		await backend.request('/api/v1/a');
		await backend.request('/api/v1/b');
		await backend.request('/logout');
		await backend.request('/api/v1/c');
		expect(seen[1]?.get('cookie')).toBe('sid=api; sid=root');
		// The /api cookie is never sent outside /api; deleting it leaves the root one.
		expect(seen[2]?.get('cookie')).toBe('sid=root');
		expect(seen[3]?.get('cookie')).toBe('sid=root');
	});

	it('replaces or removes every browser cookie of the same name, not just the first', async () => {
		const seen: Headers[] = [];
		const backend = client(
			async (_url, init) => {
				seen.push(new Headers(init.headers));
				return seen.length === 1
					? answer(['authrim_session=; Path=/; Secure; Max-Age=0', 'theme=light; Path=/; Secure'])
					: answer([]);
			},
			{ cookieHeader: 'authrim_session=a; authrim_session=b; theme=dark; theme=blue' }
		);
		await backend.request('/api/v1/a');
		await backend.request('/api/v1/b');
		expect(seen[0]?.get('cookie')).toBe(
			'authrim_session=a; authrim_session=b; theme=dark; theme=blue'
		);
		expect(seen[1]?.get('cookie')).toBe('theme=light');
	});

	it('lets a valid Max-Age decide whether a cookie is deleted, as a browser does', async () => {
		const seen: Headers[] = [];
		const backend = client(
			async (_url, init) => {
				seen.push(new Headers(init.headers));
				return seen.length === 1
					? answer([
							'kept=1; Path=/; Secure; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
							'gone=1; Path=/; Secure; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
						])
					: answer([]);
			},
			{ cookieHeader: 'gone=0' }
		);
		await backend.request('/api/v1/a');
		await backend.request('/api/v1/b');
		expect(seen[1]?.get('cookie')).toBe('kept=1');
	});

	it('lets no cookie the browser would refuse change what the next call sends', async () => {
		const seen: Headers[] = [];
		const backend = client(async (_url, init) => {
			seen.push(new Headers(init.headers));
			return seen.length === 1
				? answer([
						'authrim_session=evil; Path=/; Secure; Domain=example',
						'authrim_session=; Path=/; Max-Age=0',
						'__Host-x=1; Path=/api; Secure'
					])
				: answer([]);
		});
		await backend.request('/api/v1/a');
		await backend.request('/api/v1/b');
		expect(seen[1]?.get('cookie')).toBe('authrim_session=s1; theme=dark');
		expect(backend.setCookies()).toEqual([]);
	});

	it('calls the backends for the public origin, with the edge IP, and Origin only when verified', async () => {
		const calls: Array<{ url: string; headers: Headers; init: RequestInit }> = [];
		const capture = async (url: string, init: RequestInit) => {
			calls.push({ url, headers: new Headers(init.headers), init });
			return answer([]);
		};
		await client(capture).request('/api/v1/direct/email/send', { json: { email: 'a@b' } });
		await client(capture, { originVerified: false, clientIp: null }).request('/api/v1/x');
		expect(calls[0]?.url).toBe('https://id.example/api/v1/direct/email/send');
		expect(calls[0]?.init).toMatchObject({ method: 'POST', redirect: 'manual' });
		expect(calls[0]?.headers.get('cf-connecting-ip')).toBe('203.0.113.7');
		expect(calls[0]?.headers.get('x-forwarded-for')).toBe('203.0.113.7');
		expect(calls[0]?.headers.get('origin')).toBe('https://id.example');
		expect(calls[0]?.headers.get('x-authrim-forwarded-host')).toBe('id.example');
		expect(calls[0]?.headers.get('content-type')).toBe('application/json');
		expect(calls[1]?.init.method).toBe('GET');
		expect(calls[1]?.headers.has('origin')).toBe(false);
		expect(calls[1]?.headers.has('cf-connecting-ip')).toBe(false);
	});

	it('refuses a path that is not a local path', async () => {
		const backend = client(async () => answer([]));
		await expect(backend.request('//evil.example/x')).rejects.toThrow('lite_backend_path');
		await expect(backend.request('https://evil.example/x')).rejects.toThrow('lite_backend_path');
		await expect(backend.request('/\\evil.example/x')).rejects.toThrow('lite_backend_path');
		await expect(backend.request('/a\nb')).rejects.toThrow('lite_backend_path');
		await expect(backend.request('/a\tb')).rejects.toThrow('lite_backend_path');
	});

	it('answers a body that is not JSON as null', async () => {
		const backend = client(async () => new Response('<html>', { status: 502 }));
		await expect(backend.request('/api/v1/x')).resolves.toMatchObject({ status: 502, json: null });
	});
});

describe('which backend cookies are passed on to the browser', () => {
	const https = new URL('https://id.example');
	const forwardable = (raw: string, origin = https) => {
		const cookie = parseSetCookie(raw);
		return cookie !== null && isForwardableSetCookie(cookie, origin);
	};

	it('only host-only cookies with a Path, Secure on https, and their prefix rules', () => {
		expect(forwardable('a=1; Path=/; Secure; HttpOnly')).toBe(true);
		expect(forwardable('a=1; Path=/; Secure; Domain=example')).toBe(false);
		expect(forwardable('a=1; Secure')).toBe(false);
		expect(forwardable('a=1; Path=/')).toBe(false);
		expect(forwardable('__Host-a=1; Path=/api; Secure')).toBe(false);
		expect(forwardable('__Host-a=1; Path=/; Secure')).toBe(true);
		expect(forwardable('__Secure-a=1; Path=/')).toBe(false);
		expect(forwardable('a=1; Path=/', new URL('http://localhost:5173'))).toBe(true);
		expect(forwardable('bad name=1; Path=/; Secure')).toBe(false);
	});
});

describe('path-match', () => {
	it('follows RFC 6265', () => {
		expect(pathMatches('/', '/anything')).toBe(true);
		expect(pathMatches('/api', '/api')).toBe(true);
		expect(pathMatches('/api', '/api/v1')).toBe(true);
		expect(pathMatches('/api/', '/api/v1')).toBe(true);
		expect(pathMatches('/api', '/apix')).toBe(false);
		expect(pathMatches('/api/v1', '/api')).toBe(false);
	});
});
