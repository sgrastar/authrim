import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/env/public', () => ({
	PUBLIC_API_PROXY_BACKEND_URL: '',
	PUBLIC_API_BASE_URL: 'https://login.example.com',
	PUBLIC_AUTHRIM_ISSUER: 'https://login.example.com',
	PUBLIC_HUMAN_VERIFICATION_PROVIDER: ''
}));
vi.mock('$app/env/private', () => ({
	EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKENS: undefined,
	EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKEN: undefined
}));

import { clearAuthenticationMethodsServerCache } from '#lib/server/authentication-methods-cache.js';
import { load } from '../routes/+layout.server';

const banner = {
	text: 'This is the staging environment.',
	textLocalizations: {},
	noindex: true
};
const answer = {
	methods: {},
	ui: {},
	environmentBanner: banner,
	meta: { cacheTTL: 60, revision: 't' }
};

function event(env: Record<string, unknown>) {
	const url = new URL('https://login.example.com/login');
	return {
		request: new Request(url),
		url,
		locals: { locale: 'en' } as App.Locals,
		platform: { env },
		cookies: { get: () => undefined, set: vi.fn() },
		getClientAddress: () => '192.0.2.10'
	};
}
const router = (fetch: ReturnType<typeof vi.fn>) => ({ AR_ROUTER: { fetch } });

async function bootstrap(e: ReturnType<typeof event>) {
	const { loginUIThemeBootstrapHandle } = await import('../hooks.server');
	await loginUIThemeBootstrapHandle({
		event: e as never,
		resolve: async () => new Response('x')
	});
}

describe('environment banner on the plain sign-in entry (cache only)', () => {
	beforeEach(() => clearAuthenticationMethodsServerCache());

	it('a cached answer gives the SSR band data and the X-Robots-Tag header, with no fetch', async () => {
		const { getCachedAuthenticationMethodsForRequest, securityHeadersHandle } =
			await import('../hooks.server');
		// Something else (a lite request, an auth page) has cached the answer.
		const seedFetch = vi.fn(async () => Response.json(answer));
		await getCachedAuthenticationMethodsForRequest(
			event(router(seedFetch)) as never,
			router(seedFetch)
		);
		expect(seedFetch).toHaveBeenCalledTimes(1);

		const fetch = vi.fn();
		const e = event(router(fetch));
		await bootstrap(e);
		expect(fetch).not.toHaveBeenCalled();
		expect(e.locals.authenticationMethods).toBeUndefined();
		expect(e.locals.peekedAuthenticationMethods).toBeTruthy();
		expect(
			((await load({ locals: e.locals } as never)) as { environmentBanner: unknown })
				.environmentBanner
		).toMatchObject({ text: 'This is the staging environment.', noindex: true, locale: 'en' });

		const response = await securityHeadersHandle({
			event: e as never,
			resolve: async () =>
				new Response('x', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
		});
		expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
	});

	it('a cache miss gives nothing on the server and makes no request', async () => {
		const fetch = vi.fn();
		const e = event(router(fetch));
		await bootstrap(e);
		expect(fetch).not.toHaveBeenCalled();
		expect(e.locals.peekedAuthenticationMethods).toBeNull();
		expect(
			((await load({ locals: e.locals } as never)) as { environmentBanner: unknown })
				.environmentBanner
		).toBeNull();
	});
});
