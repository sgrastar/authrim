import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeTenantInfo, wireRow } from './fake/tenant-info-fake';
import { ApiError } from './api-error';
import { httpTenantInfo, tenantInfoFromRow } from './tenant-info';

afterEach(() => vi.unstubAllGlobals());

describe('tenant info from the wire', () => {
	const info = tenantInfoFromRow(wireRow());

	it('turns the names into the page shape', () => {
		expect(info).toMatchObject({
			tenantId: 'acme',
			name: 'Acme Corporation',
			issuer: 'https://acme.auth.example.com',
			loginUrl: 'https://acme.auth.example.com/login',
			loginBaseUrl: 'https://login.example.com',
			components: { loginUi: true, adminUi: true, saml: true, async: true, vc: true },
			profiles: {
				registryBackend: 'kv',
				audit: { id: 'standard', inherited: true },
				residency: { id: 'jp', inherited: false }
			}
		});
	});

	it('lists the endpoint groups in a fixed order and leaves out what is only kept for old callers', () => {
		expect(info.endpoints.map((group) => group.id)).toEqual([
			'well_known',
			'oidc',
			'oauth_extensions',
			'saml',
			'vc',
			'ciba',
			'scim',
			'admin_api'
		]);
		const saml = info.endpoints.find((group) => group.id === 'saml')!;
		expect(saml.endpoints.map((endpoint) => endpoint.id)).toEqual([
			'sso',
			'idp_metadata',
			'sp_metadata',
			'acs',
			'slo'
		]);
	});

	it('keeps an address that is not set as none, and a profile that could not be read as an error', () => {
		const single = tenantInfoFromRow(wireRow({ singleTenant: true, profilesUnreadable: true }));
		expect(single.sharedLoginUrl).toBeNull();
		expect(single.discoverUrl).toBeNull();
		expect(single.profiles).toBeNull();
		expect(single.profilesError).toBe('residency_profile_not_found:jp');
	});

	it('leaves out a group the API did not send, and does not fail on a missing field', () => {
		const row = wireRow();
		delete row.vc;
		delete row.components;
		const partial = tenantInfoFromRow(row);
		expect(partial.endpoints.some((group) => group.id === 'vc')).toBe(false);
		expect(partial.components.saml).toBe(false);
	});
});

describe('the HTTP client', () => {
	it('names the tenant in the path and sends no tenant header', async () => {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify(wireRow()), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const info = await httpTenantInfo.get('ac me');
		expect(info.name).toBe('Acme Corporation');
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/tenants/ac%20me/info');
		expect(new Headers(init.headers).has('X-Tenant-Id')).toBe(false);
	});

	it('throws the API error', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }))
		);
		await expect(httpTenantInfo.get('acme')).rejects.toBeInstanceOf(ApiError);
	});
});

describe('the fake client', () => {
	it('fails with the status asked for', async () => {
		await expect(createFakeTenantInfo({ fail: 404 }).get('acme')).rejects.toMatchObject({
			status: 404
		});
	});
});
