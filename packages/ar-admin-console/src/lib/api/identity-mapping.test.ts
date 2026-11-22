import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpIdentityMapping } from './identity-mapping';
import type { MappingSetSaveRequest } from './mapping-set';

vi.mock('#lib/auth/tenant-scope.svelte.js', () => ({ tenantScope: { tenantId: 'ambient' } }));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
const json = (body: unknown, status = 200, etag?: string) =>
	new Response(JSON.stringify(body), { status, headers: etag ? { ETag: etag } : {} });
const request: MappingSetSaveRequest = {
	display_name: 'Synthetic set',
	enabled: true,
	confirm_impact: 3,
	content: { catalogVersionId: 'catalog', rules: [] }
};
const saved = {
	id: 'set',
	created: false,
	content_version: 'v2',
	version_id: 'v2',
	snapshot_id: 'snapshot'
};
const options = { idempotencyKey: 'operation-0001', version: 'v1' };

describe('HTTP IdentityMappingClient', () => {
	it('keeps facade metadata and ETag and sends the whole content with tenant auth', async () => {
		const detail = {
			...saved,
			protocol: 'saml',
			destination_profile_id: 'profile',
			destination_profile: { profileId: 'profile', fields: [{ key: 'mail' }] },
			references: { count: 3 },
			content: request.content
		};
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(json(detail, 200, '"v1"'))
			.mockResolvedValueOnce(json(saved, 200, '"v2"'));
		vi.stubGlobal('fetch', fetcher);
		const api = httpIdentityMapping();
		const read = await api.setContent('tenant-A', 'set/a');
		expect(read).toEqual({ ...detail, etag: '"v1"' });
		const result = await api.saveSet('tenant-A', 'set/a', request, {
			...options,
			version: read.etag ?? read.content_version
		});
		expect(result).toMatchObject({
			kind: 'success',
			value: { content_version: 'v2', etag: '"v2"' }
		});
		const [url, init] = fetcher.mock.calls[1];
		expect(url).toBe('/api/admin/identity-mapping/sets/set%2Fa');
		expect(init).toMatchObject({
			method: 'PUT',
			credentials: 'include',
			body: JSON.stringify(request)
		});
		const headers = new Headers(init.headers);
		expect(headers.get('X-Tenant-Id')).toBe('tenant-A');
		expect(headers.get('If-Match')).toBe('"v1"');
		expect(headers.get('Idempotency-Key')).toBe(options.idempotencyKey);
	});
	it('uses facade create/delete and preview=true routes, with version tokens on update previews', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(json({ ...saved, created: true }, 201, '"v2"'))
			.mockResolvedValueOnce(json({ id: 'set', deleted: true, owner: 'tenant' }))
			.mockResolvedValueOnce(json({ preview: true, valid: false, stage_failed: 'validate' }))
			.mockResolvedValueOnce(json({ preview: true, valid: true }));
		vi.stubGlobal('fetch', fetcher);
		const api = httpIdentityMapping();
		expect(
			(await api.createSet('t', { ...request, field_mapping_key: 'synthetic' }, 'create-operation'))
				.kind
		).toBe('success');
		expect((await api.deleteSet('t', 'set', options)).kind).toBe('success');
		expect(await api.previewSave('t', request, { setId: 'set', version: 'v1' })).toMatchObject({
			valid: false,
			stage_failed: 'validate'
		});
		await api.previewSave('t', { ...request, field_mapping_key: 'new' });
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			'/api/admin/identity-mapping/sets',
			'/api/admin/identity-mapping/sets/set',
			'/api/admin/identity-mapping/sets/set?preview=true',
			'/api/admin/identity-mapping/sets?preview=true'
		]);
		expect(new Headers(fetcher.mock.calls[1][1].headers).get('If-Match')).toBe('"v1"');
		expect(new Headers(fetcher.mock.calls[2][1].headers).get('If-Match')).toBe('"v1"');
	});
	it.each([
		{
			body: {
				error: 'impact_confirmation_required',
				references: { count: 5, scan_complete: false }
			},
			status: 409,
			kind: 'impact_confirmation_required'
		},
		{ body: { error: 'conflict', content_version: 'v2' }, status: 409, kind: 'conflict' },
		{ body: { error: 'precondition_failed' }, status: 412, kind: 'conflict' },
		{
			body: {
				error: 'internal_error',
				stage_failed: 'compile',
				version_id: 'v2',
				version_discarded: false
			},
			status: 500,
			kind: 'stage_failed'
		},
		{
			body: { error: 'outcome_unknown', stage_failed: 'activate', version_discarded: false },
			status: 500,
			kind: 'outcome_unknown'
		},
		{ body: { error: 'result_unknown' }, status: 409, kind: 'outcome_unknown' }
	])(
		'returns $kind and never retries an ambiguous or refused write',
		async ({ body, status, kind }) => {
			const fetcher = vi.fn().mockResolvedValue(json(body, status));
			vi.stubGlobal('fetch', fetcher);
			const result = await httpIdentityMapping().saveSet('t', 'set', request, options);
			expect(result).toMatchObject({ kind, body });
			expect(fetcher).toHaveBeenCalledTimes(1);
		}
	);
	it('returns paused, not a conflict, for a write refused while a release is verified', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(
				json({ error: 'ADMIN_MUTATION_PAUSED_FOR_RELEASE', phase: 'verifying' }, 409)
			);
		vi.stubGlobal('fetch', fetcher);
		const result = await httpIdentityMapping().saveSet('t', 'set', request, options);
		expect(result).toEqual({ kind: 'paused' });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it('keeps the 503 release answer an unknown outcome: the router sends it for a lost call too', async () => {
		const body = { error: 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE' };
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(body, 503)));
		const result = await httpIdentityMapping().saveSet('t', 'set', request, options);
		expect(result).toMatchObject({ kind: 'outcome_unknown', body });
	});
	it('keeps transport and unreadable completion unknown and refuses a missing version before sending', async () => {
		const fetcher = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('network'))
			.mockResolvedValueOnce(new Response('invalid json'));
		vi.stubGlobal('fetch', fetcher);
		const api = httpIdentityMapping();
		for (let index = 0; index < 2; index++)
			expect(await api.saveSet('t', 'set', request, options)).toMatchObject({
				kind: 'outcome_unknown',
				idempotencyKey: options.idempotencyKey
			});
		await expect(api.saveSet('t', 'set', request, { ...options, version: '' })).rejects.toThrow(
			'current'
		);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it('replays placement-fence admission with the same key and body only', async () => {
		vi.useFakeTimers();
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				json(
					{
						error: 'temporarily_unavailable',
						extensions: {
							reason: 'tenant_placement_write_fence',
							retryable: true,
							retry_after_ms: 250
						}
					},
					503
				)
			)
			.mockResolvedValueOnce(json(saved, 200, '"v2"'));
		vi.stubGlobal('fetch', fetcher);
		const work = httpIdentityMapping().saveSet('t', 'set', request, options);
		await vi.advanceTimersByTimeAsync(300);
		expect((await work).kind).toBe('success');
		expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
	});
	it('uses actual catalog/profile, explain, test-user and preview-change payloads', async () => {
		const fetcher = vi.fn().mockImplementation(() => Promise.resolve(json({})));
		vi.stubGlobal('fetch', fetcher);
		const api = httpIdentityMapping();
		await api.sets('t');
		await api.catalogs('t');
		await api.destinationProfiles('t');
		await api.testUsers('t');
		await api.previewSetChange('t', 'set', request.content, 'tu_fixture');
		const oidc = {
			client_id: 'app',
			subject: { kind: 'test_user', id: 'tu_fixture' },
			surface: 'userinfo'
		} satisfies Parameters<typeof api.explain>[1];
		await api.explain('t', oidc);
		const saml = {
			sp_entity_id: 'https://synthetic.invalid/sp',
			subject: { kind: 'test_user', id: 'tu_fixture' },
			consent: 'required'
		} satisfies Parameters<typeof api.explainSaml>[1];
		await api.explainSaml('t', saml);
		await api.replaceTestUsers(
			't',
			[{ label: 'Synthetic', attributes: { department: 'fixture' } }],
			'replace-operation'
		);
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			'/api/admin/identity-mapping/sets',
			'/api/admin/identity-mapping/catalogs',
			'/api/admin/identity-mapping/destination-profiles',
			'/api/admin/identity-mapping/test-users',
			'/api/admin/identity-mapping/sets/set/preview-change',
			'/api/admin/identity-mapping/explain',
			'/api/admin/identity-mapping/explain',
			'/api/admin/identity-mapping/test-users'
		]);
		expect(JSON.parse(fetcher.mock.calls[4][1].body)).toEqual({
			content: request.content,
			sample: { test_user_id: 'tu_fixture' }
		});
		expect(JSON.parse(fetcher.mock.calls[5][1].body)).toEqual(oidc);
		expect(JSON.parse(fetcher.mock.calls[6][1].body)).toEqual(saml);
		expect(JSON.parse(fetcher.mock.calls[7][1].body)).toEqual({
			test_users: [{ label: 'Synthetic', attributes: { department: 'fixture' } }]
		});
	});
	it('retains standard authorization and validation errors', async () => {
		const fetcher = vi
			.fn()
			.mockImplementation(() =>
				Promise.resolve(
					json({ error: 'forbidden', error_description: 'Settings read required' }, 403)
				)
			);
		vi.stubGlobal('fetch', fetcher);
		await expect(httpIdentityMapping().catalogs('t')).rejects.toMatchObject({
			status: 403,
			code: 'forbidden'
		});
		await expect(httpIdentityMapping().saveSet('t', 'set', request, options)).rejects.toMatchObject(
			{ status: 403, code: 'forbidden' }
		);
	});
});
