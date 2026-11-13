import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/env/public', () => ({
	PUBLIC_API_PROXY_BACKEND_URL: '',
	PUBLIC_API_BASE_URL: '',
	PUBLIC_AUTHRIM_ISSUER: '',
	PUBLIC_HUMAN_VERIFICATION_PROVIDER: ''
}));
vi.mock('$app/env/private', () => ({
	EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKENS: undefined,
	EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKEN: undefined
}));

import { load } from './+layout.server';
import { litePageContentSecurityPolicy } from '#lib/server/lite/guard.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const methods = {
	ui: { branding: { brandName: 'Acme' } },
	environmentBanner: {
		text: 'This is the staging environment.',
		textLocalizations: {},
		noindex: true
	}
};

describe('lite layout and the environment banner', () => {
	it('hands the banner to the root layout and shares its answer with the response headers', async () => {
		const locals: Record<string, unknown> = { locale: 'en', authenticationMethods: methods };
		const data = (await load({ locals } as never)) as { environmentBanner: unknown };
		expect(data.environmentBanner).toEqual({
			text: 'This is the staging environment.',
			textLocalizations: {},
			noindex: true,
			locale: 'en'
		});
	});

	it('records an answer it had to read itself, so the noindex header can follow', async () => {
		vi.resetModules();
		const locals: Record<string, unknown> = { locale: 'en' };
		const { load: freshLoad } = await import('./+layout.server');
		// No answer in the locals and none readable: no banner, nothing recorded.
		const data = (await freshLoad({
			locals,
			request: new Request('https://login.example.com/login'),
			url: new URL('https://login.example.com/login'),
			platform: { env: {} },
			fetch: async () => new Response('', { status: 500 })
		} as never)) as { environmentBanner: unknown };
		expect(data.environmentBanner).toBeNull();
		expect(locals.authenticationMethods).toBeUndefined();
	});

	it('is styled by the lite stylesheet, which the lite CSP allows by hash alone', async () => {
		const css = readFileSync(
			fileURLToPath(new URL('../../lib/lite/lite.css', import.meta.url)),
			'utf8'
		);
		expect(css).toContain('.environment-banner');
		const csp = await litePageContentSecurityPolicy();
		expect(csp).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'(;|$)/);
	});
});
