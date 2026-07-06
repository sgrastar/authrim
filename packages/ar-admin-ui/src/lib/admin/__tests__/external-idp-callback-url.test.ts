import { describe, expect, it } from 'vitest';
import { buildExternalIdPCallbackUrl } from '../external-idp-callback-url';

describe('buildExternalIdPCallbackUrl', () => {
	it('builds the callback URL from the tenant issuer and provider identifier', () => {
		expect(buildExternalIdPCallbackUrl('https://first.test.authrim.com', 'samplesauth0')).toBe(
			'https://first.test.authrim.com/auth/external/samplesauth0/callback'
		);
	});

	it('normalizes a trailing slash on the tenant issuer', () => {
		expect(buildExternalIdPCallbackUrl('https://first.test.authrim.com/', 'samplesauth0')).toBe(
			'https://first.test.authrim.com/auth/external/samplesauth0/callback'
		);
	});

	it('returns null until both inputs are available', () => {
		expect(buildExternalIdPCallbackUrl(null, 'samplesauth0')).toBeNull();
		expect(buildExternalIdPCallbackUrl('https://first.test.authrim.com', '')).toBeNull();
	});
});
