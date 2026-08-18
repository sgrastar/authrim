import { describe, expect, it } from 'vitest';
import { _shouldUseResolvedTenantBranding } from './+layout.server';

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
