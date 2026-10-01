import { describe, expect, it } from 'vitest';
import { persona } from '$lib/access/personas';
import { ApiError, ConflictError, RejectedError } from '../api-error';
import type { SettingsTarget } from '../settings';
import { createFakeSettings } from './settings-fake';

const tenant: SettingsTarget = { level: 'tenant', tenantId: 'acme' };

describe('the in-memory Settings API', () => {
	it('resolves a value from this scope, then the environment, then the default', async () => {
		const api = createFakeSettings({
			stored: { 'tenant:acme': { 'session.default_ttl': 3600000 } },
			env: { 'session.max_ttl': 172800000 }
		});
		const result = await api.get(tenant, 'session');
		expect(result.sources['session.default_ttl']).toBe('kv');
		expect(result.sources['session.max_ttl']).toBe('env');
		expect(result.values['session.max_ttl']).toBe(172800000);
		expect(result.sources['session.min_ttl']).toBe('default');
	});

	it('inherits from the scopes above, as the API does, and says what applies without an override', async () => {
		const api = createFakeSettings({
			stored: {
				platform: { 'rate_limit.strict': 50 },
				'tenant:acme': { 'oauth.access_token_expiry': 900 },
				'client:app': { 'oauth.access_token_expiry': 300 }
			}
		});
		const limits = await api.get(tenant, 'rate-limit');
		expect(limits.values['rate_limit.strict']).toBe(50);
		expect(limits.sources['rate_limit.strict']).toBe('platform');

		const client: SettingsTarget = { level: 'client', tenantId: 'acme', clientId: 'app' };
		const oauth = await api.get(client, 'oauth');
		expect(oauth.values['oauth.access_token_expiry']).toBe(300);
		expect(oauth.sources['oauth.access_token_expiry']).toBe('kv');
		expect(oauth.inherited.values['oauth.access_token_expiry']).toBe(900);
		expect(oauth.inherited.sources['oauth.access_token_expiry']).toBe('tenant');
	});

	it('refuses a stale version, bad values, and changes the admin may not make', async () => {
		const api = createFakeSettings();
		const { version } = await api.get(tenant, 'session');
		const saved = await api.patch(tenant, 'session', {
			ifMatch: version,
			set: { 'session.default_ttl': 7200000, 'session.min_ttl': 1 }
		});
		expect(saved.applied).toEqual(['session.default_ttl']);
		expect(saved.rejected['session.min_ttl']).toMatch(/>=/);
		await expect(
			api.patch(tenant, 'session', { ifMatch: version, set: { 'session.default_ttl': 60000 } })
		).rejects.toBeInstanceOf(ConflictError);
		await expect(
			api.patch(tenant, 'session', { ifMatch: saved.version, set: { 'session.min_ttl': 1 } })
		).rejects.toBeInstanceOf(RejectedError);

		const viewer = createFakeSettings({ access: () => persona('viewer').access });
		const current = await viewer.get(tenant, 'session');
		const denied = viewer.patch(tenant, 'session', { ifMatch: current.version, clear: [] });
		await expect(denied).rejects.toMatchObject({ status: 403 });
		const support = createFakeSettings({ access: () => persona('support').access });
		await expect(support.get(tenant, 'session')).rejects.toBeInstanceOf(ApiError);
	});

	it('reads fixed settings as locked and refuses to change them', async () => {
		const api = createFakeSettings({ locked: ['oauth.access_token_expiry'] });
		const { version, locked } = await api.get(tenant, 'oauth');
		expect(locked).toEqual(['oauth.access_token_expiry']);
		await expect(
			api.patch(tenant, 'oauth', { ifMatch: version, set: { 'oauth.access_token_expiry': 600 } })
		).rejects.toBeInstanceOf(RejectedError);
	});

	it('lets someone else save first, to show a conflict', async () => {
		const api = createFakeSettings({ othersSaveFirst: { 'oauth.sso_enabled': true } });
		const { version } = await api.get(tenant, 'oauth');
		await expect(
			api.patch(tenant, 'oauth', { ifMatch: version, set: { 'oauth.access_token_expiry': 600 } })
		).rejects.toBeInstanceOf(ConflictError);
		const latest = await api.get(tenant, 'oauth');
		expect(latest.values['oauth.sso_enabled']).toBe(true);
	});
});
