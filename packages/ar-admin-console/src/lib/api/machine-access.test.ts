import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictError } from './api-error';
import {
	LIST_MAX_PAGES,
	httpMachineAccess,
	pickPublicJwk,
	machinePrincipalFromRow,
	reachFromScopes,
	scopesFromReach
} from './machine-access';
import { fakeMachineAccess } from './fake/machine-access-fake';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('machine principals from the wire', () => {
	it('reads the camelCase principal with its permissions, reach and keys', () => {
		const principal = machinePrincipalFromRow({
			id: 'amp_1',
			clientId: 'ci',
			displayName: 'CI',
			description: '',
			principalType: 'ci',
			status: 'disabled',
			tokenTtlSeconds: 300,
			permissions: ['a:b:c', 7],
			tenantScopes: [{ scopeMode: 'allow', tenantId: 't1' }],
			credentials: [{ id: 'k1', kid: 'kid1', alg: 'ES256', status: 'rotating', expiresAt: 5 }],
			updatedAt: 9
		});
		expect(principal).toMatchObject({
			clientId: 'ci',
			description: null,
			status: 'disabled',
			tokenTtlSeconds: 300,
			permissions: ['a:b:c'],
			reach: { mode: 'tenants', tenantIds: ['t1'] }
		});
		expect(principal.keys[0]).toMatchObject({ kid: 'kid1', status: 'rotating', expiresAt: 5 });
	});

	it('turns reach into the API tenant_scopes and back', () => {
		expect(scopesFromReach({ mode: 'none' })).toEqual([{ scope_mode: 'none' }]);
		expect(scopesFromReach({ mode: 'all' })).toEqual([{ scope_mode: 'all' }]);
		expect(scopesFromReach({ mode: 'tenants', tenantIds: ['a', 'b'] })).toEqual([
			{ scope_mode: 'allow', tenant_id: 'a' },
			{ scope_mode: 'allow', tenant_id: 'b' }
		]);
		expect(reachFromScopes([{ scopeMode: 'all', tenantId: null }])).toEqual({ mode: 'all' });
		expect(reachFromScopes([])).toEqual({ mode: 'none' });
	});
});

describe('the machine access client', () => {
	it('lists with the largest page, in the tenant given', async () => {
		const fetchMock = vi.fn(async () => json({ items: [{ id: 'amp_1', clientId: 'ci' }] }));
		vi.stubGlobal('fetch', fetchMock);
		const list = await httpMachineAccess('t1').list();
		expect(list[0].clientId).toBe('ci');
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toContain('/api/admin/machine-access/principals?limit=100&page=1');
		expect(new Headers(init.headers).get('X-Tenant-Id')).toBe('t1');
	});

	it('creates with the API field names', async () => {
		const fetchMock = vi.fn(async () => json({ principal: { id: 'amp_1' } }, 201));
		vi.stubGlobal('fetch', fetchMock);
		await httpMachineAccess('t1').create({
			clientId: ' ci ',
			displayName: ' CI ',
			principalType: 'ci',
			tokenTtlSeconds: 600,
			permissions: ['a:b:c'],
			reach: { mode: 'tenants', tenantIds: ['t1'] }
		});
		const init = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0][1];
		expect(JSON.parse(init.body as string)).toEqual({
			client_id: 'ci',
			display_name: 'CI',
			principal_type: 'ci',
			token_ttl_seconds: 600,
			permissions: ['a:b:c'],
			tenant_scopes: [{ scope_mode: 'allow', tenant_id: 't1' }]
		});
	});

	it('adds a key with the principal’s reach and no permissions list of its own', async () => {
		const fetchMock = vi.fn(async () => json({ credential: { id: 'k1', kid: 'kid1' } }, 201));
		vi.stubGlobal('fetch', fetchMock);
		await httpMachineAccess('t1').addKey('amp_1', {
			kid: 'kid1',
			displayName: 'kid1',
			alg: 'ES256',
			publicJwk: {
				kty: 'EC',
				crv: 'P-256',
				x: 'a',
				y: 'b',
				backup: { d: 'secret' },
				d: 'x'
			} as never,
			expiresAt: 99
		});
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toContain('/principals/amp_1/credentials');
		expect(JSON.parse(init.body as string)).toMatchObject({
			kid: 'kid1',
			alg: 'ES256',
			public_jwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
			permissions: [],
			// The key reaches all of what its principal reaches, now and after later changes.
			tenant_scopes: [{ scope_mode: 'all' }],
			expires_at: 99
		});
		// Nothing outside the allowlist is sent: no nested object, no private member.
		expect(init.body as string).not.toContain('secret');
		expect(init.body as string).not.toContain('backup');
	});

	it('revokes a key with DELETE and disables with POST', async () => {
		const fetchMock = vi.fn(async () => json({ success: true }));
		vi.stubGlobal('fetch', fetchMock);
		const client = httpMachineAccess('t1');
		await client.revokeKey('amp_1', 'k1');
		await client.disable('amp_1');
		const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
		expect([calls[0][0].split('/principals/')[1], calls[0][1].method]).toEqual([
			'amp_1/credentials/k1',
			'DELETE'
		]);
		expect([calls[1][0].split('/principals/')[1], calls[1][1].method]).toEqual([
			'amp_1/disable',
			'POST'
		]);
	});
});

describe('pickPublicJwk', () => {
	it('keeps only allowlisted string members', () => {
		expect(
			pickPublicJwk({
				kty: 'EC',
				crv: 'P-256',
				x: 'a',
				y: 'b',
				n: 'ignored for EC',
				alg: 'ES256',
				use: 'sig',
				kid: 'k',
				key_ops: ['verify'],
				extra: 'no',
				nested: { d: 'secret' },
				d: 'secret'
			})
		).toEqual({
			kty: 'EC',
			crv: 'P-256',
			x: 'a',
			y: 'b',
			alg: 'ES256',
			use: 'sig',
			kid: 'k',
			key_ops: ['verify']
		});
	});

	it('drops values that are not plain strings', () => {
		expect(
			pickPublicJwk({ kty: 'RSA', n: 'n', e: { d: 'x' }, alg: 1, key_ops: ['verify', { d: 1 }] })
		).toEqual({ kty: 'RSA', n: 'n' });
	});
});

describe('listing every page', () => {
	const item = (id: string) => ({ id, clientId: id });
	const pageOf = (count: number, from: number) =>
		Array.from({ length: count }, (_, index) => item(`p${from + index}`));

	it('reads pages until one is empty, even after a short page', async () => {
		const pages = [pageOf(100, 0), pageOf(100, 100), pageOf(40, 200), []];
		const fetchMock = vi.fn(async (url: string) => {
			const page = Number(new URL(url, 'http://x').searchParams.get('page'));
			return json({ items: pages[page - 1] ?? [] });
		});
		vi.stubGlobal('fetch', fetchMock);
		const list = await httpMachineAccess('t1').list();
		expect(list).toHaveLength(240);
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(String(fetchMock.mock.calls[1][0])).toContain('limit=100&page=2');
	});

	it('stops at the page cap', async () => {
		const fetchMock = vi.fn(async () => json({ items: [item('p')] }));
		vi.stubGlobal('fetch', fetchMock);
		await httpMachineAccess('t1').list();
		expect(fetchMock).toHaveBeenCalledTimes(LIST_MAX_PAGES);
	});

	it('honours the abort signal between pages', async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn(async () => {
			controller.abort();
			return json({ items: [item('p')] });
		});
		vi.stubGlobal('fetch', fetchMock);
		await expect(httpMachineAccess('t1').list(controller.signal)).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('the fake follows the API', () => {
	it('uses a client id and a kid once', async () => {
		const fake = fakeMachineAccess();
		await expect(
			fake.create({
				clientId: 'ci-deployer',
				displayName: 'x',
				principalType: 'ci',
				tokenTtlSeconds: 600,
				permissions: [],
				reach: { mode: 'none' }
			})
		).rejects.toBeInstanceOf(ConflictError);
		await expect(
			fake.addKey('amp_ci', {
				kid: 'ci-2026-11',
				displayName: 'x',
				alg: 'ES256',
				publicJwk: {}
			})
		).rejects.toBeInstanceOf(ConflictError);
	});
});
