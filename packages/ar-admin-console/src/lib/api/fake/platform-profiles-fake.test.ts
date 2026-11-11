import { describe, expect, it } from 'vitest';
import { platformProfileFromRow } from '../platform-profiles';
import { createFakePlatformProfiles } from './platform-profiles-fake';

describe('the platform profiles client and fake', () => {
	it('reads a profile as the Admin API answers it', () => {
		expect(
			platformProfileFromRow({
				id: 'psp_1',
				name: 'Short',
				values: { 'session.default_ttl': 3_600_000 },
				version: 2,
				locked: true,
				state: 'deleting',
				overriding_tenants: 4,
				created_at: 1,
				updated_at: 2
			})
		).toEqual({
			id: 'psp_1',
			name: 'Short',
			values: { 'session.default_ttl': 3_600_000 },
			version: 2,
			locked: true,
			state: 'deleting',
			overridingTenants: 4,
			created_at: 1,
			updated_at: 2
		});
		expect(platformProfileFromRow({ id: 'x' })).toMatchObject({
			state: 'active',
			overridingTenants: null,
			locked: false
		});
	});

	it('locks and saves on the version read, and keeps names apart', async () => {
		const client = createFakePlatformProfiles('psp_');
		const made = await client.create({ name: 'A', values: {} });
		const locked = await client.setLocked(made.id, made.version, true);
		expect(locked).toMatchObject({ locked: true, version: 2 });
		await expect(
			client.update(made.id, made.version, { name: 'A', values: {} })
		).rejects.toMatchObject({ status: 409 });
		await expect(client.create({ name: 'a', values: {} })).rejects.toMatchObject({ status: 409 });
	});

	it('refuses to delete one a tenant’s flow uses', async () => {
		const client = createFakePlatformProfiles('psp_', [], { inUse: ['psp_1'] });
		await client.create({ name: 'A', values: {} });
		await expect(client.remove('psp_1')).rejects.toMatchObject({ code: 'profile_in_use' });
	});

	it('answers with the bodies the Admin API sends', async () => {
		const client = createFakePlatformProfiles('psp_', [], { limit: 1 });
		const made = await client.create({ name: 'A', values: {} });
		await expect(client.update(made.id, 99, { name: 'A', values: {} })).rejects.toMatchObject({
			body: { error: 'conflict', current_version: 1 }
		});
		await expect(client.create({ name: 'B', values: {} })).rejects.toMatchObject({
			code: 'limit_reached',
			body: { error: 'limit_reached' }
		});
	});
});
