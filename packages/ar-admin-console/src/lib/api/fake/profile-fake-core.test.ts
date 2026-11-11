import { describe, expect, it } from 'vitest';
import { createFakeSessionProfiles } from './session-profiles-fake';
import { fakeLayer } from './profile-fake-core';

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
