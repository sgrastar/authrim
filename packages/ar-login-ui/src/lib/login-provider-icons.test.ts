import { describe, expect, it } from 'vitest';

import type { ExternalProvider } from '$lib/api/login-methods';
import { getExternalProviderIconClass } from '$lib/login-provider-icons';

function provider(overrides: Partial<ExternalProvider>): ExternalProvider {
	return {
		id: 'provider',
		name: 'Provider',
		type: 'oidc',
		startMode: 'oauth_redirect',
		...overrides
	};
}

describe('getExternalProviderIconClass', () => {
	it('matches X provider names only when the full provider name is X or x.com', () => {
		expect(getExternalProviderIconClass(provider({ name: 'X' }))).toBe('i-ph-x-logo');
		expect(getExternalProviderIconClass(provider({ name: 'x.com' }))).toBe('i-ph-x-logo');
		expect(getExternalProviderIconClass(provider({ name: 'Twitter Login' }))).toBe('i-ph-x-logo');
		expect(getExternalProviderIconClass(provider({ name: 'evil-x.com.example' }))).toBe(
			'i-ph-sign-in'
		);
	});
});
