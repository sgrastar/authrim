/**
 * Sample data for Staying signed in (Storybook, tests): a tenant that has set a few values
 * itself, and a deployment that sets one, so every kind of source shows.
 */
import { adminAccess } from '$lib/access/admin-access.svelte';
import { createFakeSettings, type FakeSettingsOptions } from '$lib/api/fake/settings-fake';
import type { SettingsClient } from '$lib/api/settings';

export const DEMO_TENANT = 'acme';

export function demoSettings(options: FakeSettingsOptions = {}): SettingsClient {
	return createFakeSettings({
		// Follows Storybook's Admin toolbar unless a story fixes the admin.
		access: () => adminAccess.current,
		latency: 200,
		stored: {
			[`tenant:${DEMO_TENANT}`]: {
				'session.default_ttl': 43_200_000,
				'oauth.sso_enabled': true,
				'session.ttl.passkey': 1_209_600_000
			}
		},
		env: { 'oauth.refresh_token_expiry': 2_592_000 },
		...options
	});
}
