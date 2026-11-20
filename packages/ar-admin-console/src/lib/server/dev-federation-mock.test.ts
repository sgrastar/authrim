import { describe, expect, it, vi } from 'vitest';
import { createFakeFederationSources } from '#lib/api/fake/federation-sources-fake.js';
import { answerFederationMock } from './dev-federation-mock.js';

const TRUST = ['field-mapping', 'federation-trust-sources'];
const ID = 'test-federation';

describe('the dev mock for SAML federations', () => {
	it('lists the sources in the wire shape, with their status', async () => {
		const client = createFakeFederationSources();
		const answer = await answerFederationMock(client, TRUST, 'GET', undefined);
		expect(answer?.status).toBe(200);
		const body = answer!.body as { federationTrustSources: Record<string, unknown>[] };
		expect(body.federationTrustSources).toHaveLength(3);
		expect(body.federationTrustSources[0]).toMatchObject({
			id: ID,
			displayName: 'Test federation',
			lifecycleState: 'active',
			status: { sourceState: 'healthy', entityCount: 1200 }
		});
		expect(body.federationTrustSources[0].protocolPayload).toBeTypeOf('object');
	});

	it('answers the entity view with the query, and the type names the server uses', async () => {
		const client = createFakeFederationSources();
		const answer = await answerFederationMock(
			client,
			[...TRUST, ID, 'entities'],
			'GET',
			undefined,
			new URLSearchParams('state=explicit&limit=5')
		);
		const body = answer!.body as { items: Record<string, unknown>[]; total: number };
		expect(body.total).toBe(1);
		expect(body.items[0]).toMatchObject({
			explicitProviderId: 'saml-explicit-7',
			explicitProviderType: 'saml_sp'
		});
	});

	it('refuses a stale save with a 409 in the wire shape', async () => {
		const client = createFakeFederationSources();
		const answer = await answerFederationMock(client, [...TRUST, ID], 'PUT', {
			sourceKey: 'k',
			displayName: 'x',
			lifecycleState: 'active',
			protocolPayload: {},
			expectedUpdatedAt: 1
		});
		expect(answer).toMatchObject({ status: 409, body: { error: 'conflict' } });
	});

	it('makes a connection of a materialized entity, so the page it opens exists', async () => {
		const client = createFakeFederationSources();
		const made = vi.fn();
		const entity = (await client.entities(ID, { state: 'participating', limit: 1 })).items[0];
		const answer = await answerFederationMock(
			client,
			['saml-federation-sources', ID, 'entities', 'materialize'],
			'POST',
			{ entityId: entity.entityId, providerType: 'saml_sp', name: 'Library' },
			new URLSearchParams(),
			made
		);
		expect(answer?.status).toBe(201);
		expect(answer!.body).toMatchObject({
			providerType: 'saml_sp',
			entityId: entity.entityId,
			enabled: false
		});
		expect(made).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'Library',
				input: expect.objectContaining({ providerType: 'sp' })
			})
		);
	});

	it('refreshes a source and ignores every other path', async () => {
		const client = createFakeFederationSources();
		const refreshed = await answerFederationMock(
			client,
			['saml-federation-sources', ID, 'refresh-metadata'],
			'POST',
			{}
		);
		expect(refreshed?.body).toMatchObject({ success: true, entityCount: 1200 });
		expect(await answerFederationMock(client, ['clients'], 'GET', undefined)).toBeNull();
		expect(await answerFederationMock(client, [...TRUST, ID, 'nope'], 'GET', undefined)).toBeNull();
	});
});
