import { describe, expect, it } from 'vitest';
import { ApiError } from '../api-error';
import { createFakeFederationSources, mockEntities } from './federation-sources-fake';

const ID = 'test-federation';

describe('the fake federation sources', () => {
	it('searches and pages on the server side, never handing over all 1,200', async () => {
		const fake = createFakeFederationSources();
		const first = await fake.entities(ID, { limit: 50 });
		expect(first.items).toHaveLength(50);
		expect(first.total).toBe(1200);
		expect(first.nextCursor).toBe('50');
		const second = await fake.entities(ID, { limit: 50, cursor: first.nextCursor! });
		expect(second.items[0].entityId).not.toBe(first.items[0].entityId);
		const last = await fake.entities(ID, { limit: 200, cursor: '1100' });
		expect(last.items).toHaveLength(100);
		expect(last.nextCursor).toBeNull();
	});

	it('filters by text, role and state, and caps the page at 200', async () => {
		const fake = createFakeFederationSources();
		expect((await fake.entities(ID, { q: 'excluded-2' })).items.map((e) => e.entityId)).toEqual([
			'https://sp.excluded-2.example/shibboleth'
		]);
		const idps = await fake.entities(ID, { role: 'saml_idp', limit: 500 });
		expect(idps.items).toHaveLength(200);
		expect(idps.items.every((entity) => entity.role === 'saml_idp')).toBe(true);
		expect((await fake.entities(ID, { state: 'excluded' })).total).toBe(3);
		expect((await fake.entities(ID, { state: 'explicit' })).total).toBe(1);
		expect((await fake.entities(ID, { state: 'participating', limit: 1 })).total).toBe(1196);
	});

	it('refuses a save made over a version that has since changed', async () => {
		const fake = createFakeFederationSources();
		const source = await fake.get(ID);
		const write = {
			sourceKey: source.sourceKey,
			name: 'A',
			lifecycleState: 'active' as const,
			payload: source.payload
		};
		await fake.update(ID, { ...write, expectedUpdatedAt: source.updatedAt });
		await expect(
			fake.update(ID, { ...write, expectedUpdatedAt: source.updatedAt })
		).rejects.toMatchObject({
			status: 409
		});
		expect((await fake.get(ID)).name).toBe('A');
	});

	it('can always conflict, for a story about the conflict', async () => {
		const fake = createFakeFederationSources({ conflictOnSave: true });
		const source = await fake.get(ID);
		await expect(
			fake.update(ID, {
				sourceKey: source.sourceKey,
				name: 'A',
				lifecycleState: 'active',
				payload: {},
				expectedUpdatedAt: source.updatedAt
			})
		).rejects.toBeInstanceOf(ApiError);
	});

	it('makes an entity an explicit connection once, and says so the second time', async () => {
		const fake = createFakeFederationSources({ entities: mockEntities(20) });
		const entity = (await fake.entities(ID, { state: 'participating', limit: 1 })).items[0];
		const made = await fake.materialize(ID, { entityId: entity.entityId, providerType: 'sp' });
		expect(made.providerType).toBe('sp');
		const after = await fake.entities(ID, { q: entity.entityId });
		expect(after.items[0]).toMatchObject({ explicitProviderId: made.providerId });
		await expect(
			fake.materialize(ID, { entityId: entity.entityId, providerType: 'sp' })
		).rejects.toMatchObject({ status: 409, code: 'saml_explicit_provider_exists' });
	});

	it('reports a refresh with the entities and the verification, or the failure it was given', async () => {
		const fake = createFakeFederationSources();
		const result = await fake.refresh(ID);
		expect(result).toMatchObject({ entityCount: 1200, verificationStatus: 'verified' });
		const failing = createFakeFederationSources({ refresh: new ApiError(502, 'bad', 'bad') });
		await expect(failing.refresh(ID)).rejects.toBeInstanceOf(ApiError);
	});

	it('makes a source that a later read finds, and refuses the same address twice', async () => {
		const fake = createFakeFederationSources({ sources: [] });
		const write = {
			sourceKey: 'https://m.example/a.xml',
			name: 'Made',
			lifecycleState: 'active' as const,
			payload: {
				metadataUrl: 'https://m.example/a.xml',
				runtimeResolution: { roles: ['saml_idp'] }
			}
		};
		const { id } = await fake.create(write);
		expect((await fake.get(id)).roles).toEqual(['saml_idp']);
		await expect(fake.create(write)).rejects.toMatchObject({ status: 409 });
	});
});
