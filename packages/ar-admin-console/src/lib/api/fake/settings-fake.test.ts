import { describe, expect, it } from 'vitest';
import { persona } from '#lib/access/personas.js';
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
		expect(result.sources['session.ttl.passkey']).toBe('default');
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
			set: { 'session.default_ttl': 7200000, 'session.max_ttl': 1 }
		});
		expect(saved.applied).toEqual(['session.default_ttl']);
		expect(saved.rejected['session.max_ttl']).toMatch(/>=/);
		await expect(
			api.patch(tenant, 'session', { ifMatch: version, set: { 'session.default_ttl': 60000 } })
		).rejects.toBeInstanceOf(ConflictError);
		await expect(
			api.patch(tenant, 'session', { ifMatch: saved.version, set: { 'session.max_ttl': 1 } })
		).rejects.toBeInstanceOf(RejectedError);

		const viewer = createFakeSettings({ access: () => persona('viewer').access });
		const current = await viewer.get(tenant, 'session');
		const denied = viewer.patch(tenant, 'session', { ifMatch: current.version, clear: [] });
		await expect(denied).rejects.toMatchObject({ status: 403 });
		const support = createFakeSettings({ access: () => persona('support').access });
		await expect(support.get(tenant, 'session')).rejects.toBeInstanceOf(ApiError);
	});

	it('reads locked settings with the platform value and refuses to change them', async () => {
		const key = 'oauth.access_token_expiry';
		const api = createFakeSettings({
			locked: [key],
			stored: { platform: { [key]: 900 }, 'tenant:acme': { [key]: 1800 } }
		});
		const read = await api.get(tenant, 'oauth');
		expect(read.locked).toEqual([key]);
		// The tenant's own value is ignored while the platform's applies.
		expect(read.values[key]).toBe(900);
		expect(read.sources[key]).toBe('platform');
		// The tenant's stored value is set aside, not gone.
		expect(read.setAside).toEqual([key]);
		await expect(
			api.patch(tenant, 'oauth', { ifMatch: read.version, set: { [key]: 600 } })
		).rejects.toMatchObject({ rejected: { [key]: expect.stringMatching(/^locked_by_platform/) } });
		await expect(
			api.patch(tenant, 'oauth', { ifMatch: read.version, disable: [key] })
		).rejects.toBeInstanceOf(RejectedError);

		// Clearing the tenant's stale value is allowed; the platform edits the value itself.
		const cleared = await api.patch(tenant, 'oauth', { ifMatch: read.version, clear: [key] });
		expect(cleared.cleared).toEqual([key]);
		const platform = await api.get({ level: 'platform' }, 'oauth');
		expect(platform.locked).toEqual([key]);
		const set = await api.patch({ level: 'platform' }, 'oauth', {
			ifMatch: platform.version,
			set: { [key]: 1200 }
		});
		expect(set.applied).toEqual([key]);
	});

	it('lists nothing as locked by default', async () => {
		const api = createFakeSettings();
		expect((await api.get(tenant, 'oauth')).locked).toEqual([]);
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

	it('keeps each setting to the scopes it can be set at, as the API does', async () => {
		const api = createFakeSettings({
			stored: {
				platform: { 'security.admin_step_up_overrides': { 'tenant.delete': 'L2' } },
				'tenant:acme': { 'security.admin_step_up_enforced': false }
			}
		});
		const read = await api.get(tenant, 'security');
		// A platform-only switch stored for a tenant, and a tenant-only map stored for the
		// platform, are both ignored.
		expect(read.sources['security.admin_step_up_enforced']).toBe('default');
		expect(read.values['security.admin_step_up_enforced']).toBe(true);
		expect(read.inherited.sources['security.admin_step_up_overrides']).toBe('default');
		expect(read.values['security.admin_step_up_overrides']).toEqual({});
		// Neither set nor cleared at a scope it cannot be set at.
		await expect(
			api.patch(tenant, 'security', {
				ifMatch: read.version,
				set: { 'security.admin_keyring_dc_api': true },
				clear: ['security.admin_step_up_enforced']
			})
		).rejects.toBeInstanceOf(RejectedError);
		const platform = await api.get({ level: 'platform' }, 'security');
		await expect(
			api.patch({ level: 'platform' }, 'security', {
				ifMatch: platform.version,
				set: { 'security.admin_step_up_enforced': false }
			})
		).resolves.toMatchObject({ applied: ['security.admin_step_up_enforced'] });
	});
});
