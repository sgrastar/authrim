import { describe, expect, it } from 'vitest';
import { createFakeSettings } from '$lib/api/fake/settings-fake';
import type { SettingsTarget } from '$lib/api/settings';
import { STAYING_SIGNED_IN, type SettingsSection } from './placement';
import {
	changedBetween,
	changes,
	fallbackOf,
	fieldOf,
	readBadge,
	sectionView,
	valuesFrom,
	type Loaded
} from './settings-model';

const tenant: SettingsTarget = { level: 'tenant', tenantId: 'acme' };
const levels = { session: 'edit', oauth: 'edit' } as const;

async function load(options: Parameters<typeof createFakeSettings>[0] = {}): Promise<Loaded> {
	const client = createFakeSettings(options);
	return {
		session: await client.get(tenant, 'session'),
		oauth: await client.get(tenant, 'oauth')
	};
}

const section = (id: string): SettingsSection =>
	STAYING_SIGNED_IN.sections.find((s) => s.id === id)!;

describe('the badge of a setting that is only read', () => {
	it('says a setting in development has no effect yet, before anything else', () => {
		expect(readBadge({ status: 'in_development' }, { v: 1, here: true, locked: true })).toBe(
			'inDevelopment'
		);
		expect(readBadge({}, { v: 1, here: true, locked: true })).toBe('locked');
		expect(readBadge({ status: 'active' }, { v: 1, here: true })).toBe('here');
		expect(readBadge({}, { v: 1, here: false })).toBeNull();
	});
});

describe('a settings page’s values', () => {
	it('knows which values are set here and which are inherited', async () => {
		const loaded = await load({
			stored: { 'tenant:acme': { 'session.default_ttl': 3600000 } },
			env: { 'oauth.access_token_expiry': 900 }
		});
		const values = valuesFrom(STAYING_SIGNED_IN, loaded);
		expect(values[fieldOf('session.default_ttl')]).toEqual({ v: 3600000, here: true });
		expect(values[fieldOf('oauth.access_token_expiry')]).toEqual({ v: 900, here: false });
		expect(fallbackOf('oauth.access_token_expiry', loaded)).toEqual({ value: 900, source: 'env' });
		expect(fallbackOf('session.default_ttl', loaded)).toEqual({
			value: 86400000,
			source: 'default'
		});
	});

	it('shows primary settings, keeps the rest in Advanced, and search ones only when set here', async () => {
		const plain = valuesFrom(STAYING_SIGNED_IN, await load());
		const view = sectionView(section('sign-in'), plain, levels);
		expect(view.primary.map((s) => s.key)).toEqual([
			'session.default_ttl',
			'session.refresh_default',
			'oauth.sso_enabled'
		]);
		expect(view.setHere).toBe(0);
		const logout = sectionView(section('logout'), plain, levels);
		expect(logout.advanced.map((s) => s.key)).not.toContain('session.backchannel_logout_token_exp');

		const tuned = valuesFrom(
			STAYING_SIGNED_IN,
			await load({
				stored: {
					'tenant:acme': {
						'session.backchannel_logout_token_exp': 600,
						'session.backchannel_request_timeout_ms': 5000
					}
				}
			})
		);
		const tunedView = sectionView(section('logout'), tuned, levels);
		expect(tunedView.advanced.map((s) => s.key)).toContain('session.backchannel_logout_token_exp');
		expect(tunedView.setHere).toBe(2);
	});

	it('shows a dependent setting only while what it depends on is on the screen', async () => {
		const values = valuesFrom(STAYING_SIGNED_IN, await load());
		const limit = 'oauth.refresh_token_absolute_expiry';
		expect(
			sectionView(section('app-tokens'), values, levels).advanced.map((s) => s.key)
		).not.toContain(limit);
		values[fieldOf('oauth.refresh_token_absolute_expiry_enabled')] = { v: true, here: true };
		expect(sectionView(section('app-tokens'), values, levels).advanced.map((s) => s.key)).toContain(
			limit
		);
	});

	it('marks settings the scope above has fixed, and never sends them', async () => {
		const saved = valuesFrom(
			STAYING_SIGNED_IN,
			await load({ locked: ['oauth.access_token_expiry'] })
		);
		expect(saved[fieldOf('oauth.access_token_expiry')]).toEqual({
			v: 3600,
			here: false,
			locked: true
		});
		expect(saved[fieldOf('oauth.id_token_expiry')].locked).toBeUndefined();
		expect(changes(STAYING_SIGNED_IN, saved, structuredClone(saved)).size).toBe(0);
	});

	it('leaves out settings of categories the admin cannot see', async () => {
		const values = valuesFrom(STAYING_SIGNED_IN, await load());
		const view = sectionView(section('sign-in'), values, { session: 'view', oauth: 'none' });
		expect(view.primary.map((s) => s.key)).toEqual([
			'session.default_ttl',
			'session.refresh_default'
		]);
	});

	it('sends changed values and clears released ones, per category', async () => {
		const saved = valuesFrom(
			STAYING_SIGNED_IN,
			await load({ stored: { 'tenant:acme': { 'oauth.access_token_expiry': 900 } } })
		);
		const current = structuredClone(saved);
		current[fieldOf('session.default_ttl')] = { v: 7200000, here: true };
		current[fieldOf('oauth.access_token_expiry')] = { v: 3600, here: false };
		const out = changes(STAYING_SIGNED_IN, saved, current);
		expect(out.get('session')).toEqual({ set: { 'session.default_ttl': 7200000 } });
		expect(out.get('oauth')).toEqual({ clear: ['oauth.access_token_expiry'] });
		expect(changes(STAYING_SIGNED_IN, saved, saved).size).toBe(0);
	});

	it('names what someone else changed between two loads', async () => {
		const before = valuesFrom(STAYING_SIGNED_IN, await load());
		const after = valuesFrom(
			STAYING_SIGNED_IN,
			await load({ stored: { 'tenant:acme': { 'oauth.sso_enabled': true } } })
		);
		expect(changedBetween(before, after)).toEqual(['oauth.sso_enabled']);
	});
});
