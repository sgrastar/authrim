import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessCheckBody, accessCheckResultFrom, httpAccessCheck } from './access-check';
import { checkApiKeyBody, createdCheckApiKeyFrom, httpCheckApiKeys } from './check-api-keys';
import { MalformedResponseError } from './end-user-groups';
import { createFakeAuthz } from './fake/end-user-authz-fake';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('the access check request', () => {
	it('asks a permission as a string, and about one resource as an object', () => {
		expect(accessCheckBody({ subject_id: ' u ', permission: ' documents:read ' })).toEqual({
			subject_id: 'u',
			permission: 'documents:read'
		});
		expect(
			accessCheckBody({
				subject_id: 'u',
				permission: 'documents:read',
				resource_id: '42',
				resource_group_id: 'g'
			})
		).toEqual({
			subject_id: 'u',
			permission: { resource: 'documents', id: '42', action: 'read' },
			resource_context: { group_id: 'g' }
		});
	});

	it('reads the decision and its debug details', () => {
		expect(
			accessCheckResultFrom({
				allowed: true,
				resolved_via: ['group_role', 3],
				final_decision: 'allow',
				debug: { matched_rules: ['role:editor'], path: ['group:g'], evaluation_time_ms: 2.5 }
			})
		).toEqual({
			allowed: true,
			resolved_via: ['group_role'],
			final_decision: 'allow',
			reason: null,
			matched_rules: ['role:editor'],
			path: ['group:g'],
			evaluation_time_ms: 2.5
		});
		expect(accessCheckResultFrom({ allowed: false, reason: 'no_match' })).toMatchObject({
			final_decision: 'deny',
			reason: 'no_match',
			evaluation_time_ms: null
		});
	});

	it('passes a relationship to check only with both its parts', () => {
		expect(
			accessCheckBody({
				subject_id: 'u',
				permission: 'a:b',
				rebac: { relation: ' viewer ', object: 'document:1' }
			}).rebac
		).toEqual({ relation: 'viewer', object: 'document:1' });
		expect(
			accessCheckBody({
				subject_id: 'u',
				permission: 'a:b',
				rebac: { relation: 'viewer', object: '' }
			})
		).not.toHaveProperty('rebac');
	});

	it('answers from the fake only where a grant holds, and until it ends', async () => {
		const { accessCheck } = createFakeAuthz({
			grants: {
				grp_jp: [
					{
						id: 'g1',
						role_id: 'role_editor',
						role_name: 'editor',
						role_display_name: null,
						scope_type: 'group',
						scope_target: 'group:grp_jp',
						expires_at: null,
						assigned_by: null,
						created_at: null
					}
				]
			},
			userRoles: {}
		});
		const ask = (group?: string) =>
			accessCheck.check({
				subject_id: 'usr_aiko',
				permission: 'documents:write',
				resource_group_id: group
			});
		await expect(ask('grp_jp')).resolves.toMatchObject({ allowed: true });
		await expect(ask('grp_eng')).resolves.toMatchObject({ allowed: false });
		await expect(ask()).resolves.toMatchObject({ allowed: false });
		const grant = (expires_at: number) => ({
			grants: {
				grp_eng: [
					{
						id: 'g2',
						role_id: 'role_editor',
						role_name: 'editor',
						role_display_name: null,
						scope_type: 'global' as const,
						scope_target: '',
						expires_at,
						assigned_by: null,
						created_at: null
					}
				]
			},
			userRoles: {},
			now: Date.UTC(2030, 0, 1)
		});
		const check = { subject_id: 'usr_aiko', permission: 'documents:write' };
		await expect(
			createFakeAuthz(grant(Date.UTC(2029, 0, 1))).accessCheck.check(check)
		).resolves.toMatchObject({ allowed: false });
		await expect(
			createFakeAuthz(grant(Date.UTC(2031, 0, 1))).accessCheck.check(check)
		).resolves.toMatchObject({ allowed: true });
	});

	it('takes an answer without a decision as a failure, never as denied', async () => {
		expect(() => accessCheckResultFrom({ reason: 'x' })).toThrow(MalformedResponseError);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('not json', { status: 200 }))
		);
		await expect(
			httpAccessCheck('acme').check({ subject_id: 'u', permission: 'a:b' })
		).rejects.toBeInstanceOf(MalformedResponseError);
	});

	it('checks one resource as the engine does: the id-qualified permission or a wildcard', async () => {
		const role = (permissions: string[]) => ({
			roles: [
				{
					id: 'role_x',
					name: 'x',
					display_name: null,
					description: null,
					permissions,
					is_system: false,
					role_type: 'custom',
					grant_tier: 1,
					assignment_count: 0,
					created_at: null,
					updated_at: null
				}
			],
			grants: {},
			userRoles: {
				usr_aiko: [
					{
						id: 'ura',
						role_id: 'role_x',
						role_name: 'x',
						role_display_name: null,
						scope_type: 'global' as const,
						scope_target: '',
						expires_at: null,
						created_at: null
					}
				]
			}
		});
		const ask = (permissions: string[]) =>
			createFakeAuthz(role(permissions)).accessCheck.check({
				subject_id: 'usr_aiko',
				permission: 'documents:read',
				resource_id: '42'
			});
		await expect(ask(['documents:read'])).resolves.toMatchObject({ allowed: false });
		await expect(ask(['documents:42:read'])).resolves.toMatchObject({ allowed: true });
		await expect(ask(['documents:*'])).resolves.toMatchObject({ allowed: true });
		await expect(ask(['*'])).resolves.toMatchObject({ allowed: true });
	});

	it('posts to the admin access check', async () => {
		const fetchMock = vi.fn(async () => json({ allowed: false }));
		vi.stubGlobal('fetch', fetchMock);
		await httpAccessCheck('acme').check({ subject_id: 'u', permission: 'a:b' });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/access-check');
		expect(init.method).toBe('POST');
	});

	it('answers from the fake by the user’s effective roles', async () => {
		const { accessCheck } = createFakeAuthz();
		await expect(
			accessCheck.check({ subject_id: 'usr_chen', permission: 'documents:write' })
		).resolves.toMatchObject({ allowed: true });
		await expect(
			accessCheck.check({ subject_id: 'usr_chen', permission: 'invoices:approve' })
		).resolves.toMatchObject({ allowed: false, resolved_via: [] });
	});
});

describe('Check API keys', () => {
	it('lists the keys and revokes one', async () => {
		const fetchMock = vi.fn(async (url: string) =>
			url.includes('limit')
				? json({
						keys: [{ id: 'k', name: 'Docs', is_active: true, allowed_operations: ['check'] }],
						total: 41,
						page: 3,
						limit: 20
					})
				: json({ success: true, id: 'k' })
		);
		vi.stubGlobal('fetch', fetchMock);
		const client = httpCheckApiKeys('acme');
		await expect(client.list(3, 20)).resolves.toEqual({
			items: [expect.objectContaining({ id: 'k', is_active: true, allowed_operations: ['check'] })],
			page: 3,
			limit: 20,
			total: 41
		});
		expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/check-api-keys?page=3&limit=20');
		await client.revoke('k');
		const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/check-api-keys/k');
		expect(init.method).toBe('DELETE');
	});

	it('creates a key: the end in seconds, the secret from the response', async () => {
		const fetchMock = vi.fn(async () =>
			json(
				{
					id: 'k2',
					api_key: 'chk_live_secret',
					key_prefix: 'chk_live_ab',
					name: 'Docs',
					client_id: 'docs-backend',
					allowed_operations: ['check', 'batch'],
					rate_limit_tier: 'moderate',
					expires_at: 1770007200,
					created_at: 1760000000
				},
				201
			)
		);
		vi.stubGlobal('fetch', fetchMock);
		const created = await httpCheckApiKeys('acme').create({
			name: ' Docs ',
			client_id: 'docs-backend',
			allowed_operations: ['check', 'batch'],
			expires_at: 1770007200_000
		});
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/check-api-keys');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({
			name: 'Docs',
			client_id: 'docs-backend',
			allowed_operations: ['check', 'batch'],
			expires_at: 1770007200
		});
		expect(created.api_key).toBe('chk_live_secret');
		expect(created.key).toMatchObject({
			id: 'k2',
			is_active: true,
			expires_at: 1770007200_000,
			key_prefix: 'chk_live_ab'
		});
	});

	it('leaves the end out when there is none, and refuses an answer without the secret', async () => {
		expect(
			checkApiKeyBody({
				name: 'a',
				client_id: 'b',
				allowed_operations: ['check'],
				expires_at: null
			})
		).toEqual({ name: 'a', client_id: 'b', allowed_operations: ['check'] });
		expect(createdCheckApiKeyFrom({ id: 'k' }).api_key).toBe('');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json({ id: 'k' }, 201))
		);
		await expect(
			httpCheckApiKeys('acme').create({
				name: 'a',
				client_id: 'b',
				allowed_operations: ['check'],
				expires_at: null
			})
		).rejects.toBeInstanceOf(MalformedResponseError);
	});

	it('passes the API’s refusal on, with its code', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json({ error: 'capability_disabled', error_description: 'off' }, 403))
		);
		await expect(
			httpCheckApiKeys('acme').create({
				name: 'a',
				client_id: 'b',
				allowed_operations: ['check'],
				expires_at: null
			})
		).rejects.toMatchObject({ status: 403, code: 'capability_disabled' });
	});

	it('the fake makes a key that is listed first, and refuses an empty name', async () => {
		const { checkApiKeys } = createFakeAuthz();
		const made = await checkApiKeys.create({
			name: 'New',
			client_id: 'c',
			allowed_operations: ['check'],
			expires_at: null
		});
		expect(made.api_key).toMatch(/^chk_live_/);
		expect((await checkApiKeys.list()).items[0]).toMatchObject({ name: 'New', is_active: true });
		await expect(
			checkApiKeys.create({
				name: ' ',
				client_id: 'c',
				allowed_operations: ['check'],
				expires_at: null
			})
		).rejects.toMatchObject({ status: 400 });
	});

	it('the fake refuses an unknown operation and a past end, and can answer capability_disabled', async () => {
		const { checkApiKeys } = createFakeAuthz();
		const input = { name: 'n', client_id: 'c', allowed_operations: ['check'], expires_at: null };
		await expect(
			checkApiKeys.create({ ...input, allowed_operations: ['write'] })
		).rejects.toMatchObject({ status: 400 });
		await expect(checkApiKeys.create({ ...input, allowed_operations: [''] })).rejects.toMatchObject(
			{ status: 400 }
		);
		await expect(checkApiKeys.create({ ...input, expires_at: 1000 })).rejects.toMatchObject({
			status: 400
		});
		await expect(
			checkApiKeys.create({ ...input, allowed_operations: ['check', 'batch', 'subscribe'] })
		).resolves.toBeTruthy();
		await expect(
			createFakeAuthz({ failOn: { 'keys.create': 'capability_disabled' } }).checkApiKeys.create(
				input
			)
		).rejects.toMatchObject({ status: 403, code: 'capability_disabled' });
	});
});
