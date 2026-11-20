import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpDestinationProfiles } from './destination-profiles';

vi.mock('#lib/auth/tenant-scope.svelte.js', () => ({ tenantScope: { tenantId: 'ambient' } }));
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const profile = (state: string) => ({
	id: 'p1',
	destinationType: 'saml',
	displayName: 'Mine',
	lifecycleState: state,
	version: { id: 'v1', lifecycleState: state, schema: {} }
});
const input = {
	destinationType: 'saml' as const,
	displayName: 'Mine',
	profileKey: 'mine_abc',
	schema: { destinationType: 'saml', attributes: [] }
};
const calls = (fetcher: ReturnType<typeof vi.fn>) =>
	fetcher.mock.calls.map(
		([url, init]) =>
			`${(init as RequestInit)?.method ?? 'GET'} ${String(url).split('/api/admin/field-mapping/')[1]}`
	);

describe('saving an output source', () => {
	it('writes, reviews and switches it on in one go, as a tenant profile', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(json({ result: profile('draft') }))
			.mockResolvedValueOnce(json({}))
			.mockResolvedValueOnce(json({}))
			.mockResolvedValueOnce(json({ destinationProfiles: [profile('active')] }));
		vi.stubGlobal('fetch', fetcher);
		const saved = await httpDestinationProfiles.save('tenant-A', input);
		expect(calls(fetcher)).toEqual([
			'POST destination-profiles',
			'POST destination-profiles/p1/versions/v1/review',
			'POST destination-profiles/p1/versions/v1/activate',
			'GET destination-profiles'
		]);
		const body = JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body));
		expect(body).toMatchObject({
			destinationType: 'saml',
			profileKey: 'mine_abc',
			ownerScopeType: 'tenant',
			displayName: 'Mine'
		});
		expect(saved).toMatchObject({ active: true, profile: { id: 'p1', lifecycleState: 'active' } });
	});

	it('changes an existing one in place, without a key or scope', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(json({ result: profile('draft') }))
			.mockResolvedValueOnce(json({}))
			.mockResolvedValueOnce(json({}))
			.mockResolvedValueOnce(json({ destinationProfiles: [profile('active')] }));
		vi.stubGlobal('fetch', fetcher);
		await httpDestinationProfiles.save('tenant-A', { ...input, id: 'p1' });
		expect(calls(fetcher)[0]).toBe('PUT destination-profiles/p1');
		const body = JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body));
		expect(body).not.toHaveProperty('profileKey');
		expect(body).not.toHaveProperty('ownerScopeType');
	});

	it('keeps a draft and says why when the review stops it', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(json({ result: profile('draft') }))
			.mockResolvedValueOnce(json({ message: 'blocking warning' }, 400));
		vi.stubGlobal('fetch', fetcher);
		const saved = await httpDestinationProfiles.save('tenant-A', input);
		expect(saved).toMatchObject({ active: false, reason: 'blocking warning' });
		// It was written; nothing was activated.
		expect(calls(fetcher)).toHaveLength(2);
	});

	it('lists the profiles of one kind only', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValueOnce(
				json({
					destinationProfiles: [
						profile('active'),
						{ ...profile('active'), id: 'o', destinationType: 'oidc' }
					]
				})
			)
		);
		const rows = await httpDestinationProfiles.list('tenant-A', 'saml');
		expect(rows.map((row) => row.id)).toEqual(['p1']);
	});
});
