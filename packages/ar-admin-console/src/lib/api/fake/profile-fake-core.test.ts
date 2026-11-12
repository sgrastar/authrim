import { describe, expect, it } from 'vitest';
import { createFakeSessionProfiles } from './session-profiles-fake';
import { createFakePlatformProfiles } from './platform-profiles-fake';
import { fakeLayer, type FakeProfileCopy } from './profile-fake-core';

describe('the profile fakes and the platform layer', () => {
	it('reports Default’s layer, overridden once saved and cleared on revert', async () => {
		const client = createFakeSessionProfiles();
		const before = await client.get('default');
		expect(before.layer).toMatchObject({ scope: 'tenant', overridden: false });
		const saved = await client.update('default', before.version, {
			name: 'Default',
			values: { 'session.default_ttl': 3_600_000 }
		});
		expect(saved.layer?.overridden).toBe(true);
		const reverted = await client.revert('default');
		expect(reverted.layer?.overridden).toBe(false);
		// A version read before the revert is stale.
		await expect(
			client.update('default', saved.version, { name: 'Default', values: {} })
		).rejects.toThrow();
		// And stays stale after the next save.
		await client.update('default', reverted.version, { name: 'Default', values: {} });
		await expect(
			client.update('default', saved.version, { name: 'Default', values: {} })
		).rejects.toThrow();
	});

	it('saves a platform profile’s copy and refuses one the platform sets aside', async () => {
		const client = createFakeSessionProfiles([
			{
				id: 'psp_a',
				name: 'A',
				is_system: false,
				values: {},
				version: 0,
				created_at: null,
				updated_at: null,
				layer: fakeLayer()
			},
			{
				id: 'psp_locked',
				name: 'Locked',
				is_system: false,
				values: {},
				version: 0,
				created_at: null,
				updated_at: null,
				layer: fakeLayer({ locked: true, editable: false })
			}
		]);
		const copy = await client.saveCopy('psp_a', null, { 'session.default_ttl': 3_600_000 });
		expect(copy.layer).toMatchObject({ overridden: true, copyVersion: 1 });
		await expect(client.saveCopy('psp_a', null, {})).rejects.toThrow();
		await expect(client.saveCopy('psp_locked', null, {})).rejects.toMatchObject({
			code: 'profile_not_editable'
		});
	});

	it('refuses a new profile when the platform does not allow it', async () => {
		const client = createFakeSessionProfiles([], { creationNotAllowed: true });
		await expect(client.create({ name: 'X', values: {} })).rejects.toMatchObject({
			code: 'profile_creation_not_allowed'
		});
	});
});

describe('the tenant fakes over the platform fakes (the dev mock)', () => {
	const setUp = () => {
		const copies = new Map<string, FakeProfileCopy>();
		const platform = createFakePlatformProfiles(
			'psp_',
			[
				{
					id: 'psp_1',
					name: 'Short',
					values: { 'session.default_ttl': 3_600_000 },
					version: 1,
					locked: false,
					state: 'active',
					overridingTenants: 0,
					created_at: null,
					updated_at: null
				}
			],
			{ overridingTenants: (id) => (copies.has(id) ? 1 : 0) }
		);
		const tenant = createFakeSessionProfiles([], { platform, copies });
		return { platform, tenant };
	};

	it('shows what the platform holds now: a change, a lock, a new and a deleted profile', async () => {
		const { platform, tenant } = setUp();
		expect((await tenant.get('psp_1')).layer).toMatchObject({ scope: 'platform', editable: true });
		const changed = await platform.update('psp_1', 1, {
			name: 'Shorter',
			values: { 'session.default_ttl': 1_800_000 }
		});
		const read = await tenant.get('psp_1');
		expect(read).toMatchObject({ name: 'Shorter', values: { 'session.default_ttl': 1_800_000 } });
		await platform.setLocked('psp_1', changed.version, true);
		expect((await tenant.get('psp_1')).layer).toMatchObject({ locked: true, editable: false });
		const created = await platform.create({ name: 'Long', values: {} });
		expect((await tenant.list()).map((profile) => profile.id)).toContain(created.id);
		await platform.remove(created.id);
		expect((await tenant.list()).map((profile) => profile.id)).not.toContain(created.id);
	});

	it('keeps the tenant’s copy, sets it aside under a lock and counts it on the platform', async () => {
		const { platform, tenant } = setUp();
		const saved = await tenant.saveCopy('psp_1', null, { 'session.default_ttl': 600_000 });
		expect(saved.layer).toMatchObject({ overridden: true, copyVersion: 1 });
		expect(saved.values).toEqual({ 'session.default_ttl': 600_000 });
		expect((await platform.get('psp_1')).overridingTenants).toBe(1);
		const changed = await platform.update('psp_1', 1, { name: 'Short', values: {} });
		expect((await tenant.get('psp_1')).layer?.platformUpdated).toBe(true);
		// Saving the copy again keeps the version it was made from: still behind the platform.
		const again = await tenant.saveCopy('psp_1', 1, { 'session.default_ttl': 900_000 });
		expect(again.layer?.platformUpdated).toBe(true);
		await platform.setLocked('psp_1', changed.version, true);
		const locked = await tenant.get('psp_1');
		expect(locked.layer).toMatchObject({ overridden: false, overrideInactive: true });
		expect(locked.values).toEqual({});
		const reverted = await tenant.revert('psp_1');
		expect(reverted.layer).toMatchObject({ overridden: false, overrideInactive: false });
		expect((await platform.get('psp_1')).overridingTenants).toBe(0);
	});
});
