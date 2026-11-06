import { describe, expect, it, vi } from 'vitest';
import { _shouldUseResolvedTenantBranding, load } from './+layout.server';

describe('Login UI tenant branding route continuity', () => {
	it.each([
		'/callback',
		'/ciba',
		'/consent',
		'/device',
		'/device/authorize',
		'/error',
		'/login',
		'/logged-out',
		'/logout-complete',
		'/reauth',
		'/signup',
		'/verify-email-code'
	])('keeps resolved tenant branding on %s', (routeId) => {
		expect(_shouldUseResolvedTenantBranding(routeId)).toBe(true);
	});

	it('keeps resolved tenant branding throughout account routes', () => {
		expect(_shouldUseResolvedTenantBranding('/account')).toBe(true);
		expect(_shouldUseResolvedTenantBranding('/account/security')).toBe(true);
	});

	it('still uses discovery policy for unresolved public routes', () => {
		expect(_shouldUseResolvedTenantBranding('/discover')).toBe(false);
		expect(_shouldUseResolvedTenantBranding('/')).toBe(false);
		expect(_shouldUseResolvedTenantBranding(null)).toBe(false);
	});
});

describe('Login UI theme hint', () => {
	const run = (hint: string | undefined) =>
		load({
			locals: {},
			url: new URL('https://tenant.example.com/login'),
			route: { id: '/login' },
			cookies: {
				get: (name: string) => (name === 'authrim_theme_hint' ? hint : undefined),
				set: vi.fn()
			}
		} as never) as Promise<{ themeHint: string | null }>;

	it('passes the cookie on when it names a mode', async () => {
		expect((await run('dark')).themeHint).toBe('dark');
		expect((await run('light')).themeHint).toBe('light');
	});

	it('passes nothing on when the cookie is absent or not a mode', async () => {
		expect((await run(undefined)).themeHint).toBeNull();
		expect((await run('sepia')).themeHint).toBeNull();
	});
});
