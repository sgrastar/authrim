import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeTenantDomains } from './fake/tenant-domains-fake';
import {
	hostnameValid,
	httpTenantDomains,
	normalizeHostname,
	tenantDomainFromRow,
	validationRecordsFrom
} from './tenant-domains';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const row = (over: Record<string, unknown> = {}) => ({
	id: 'd1',
	tenant_id: 'acme',
	hostname: 'login.acme.example',
	is_active: true,
	is_primary: false,
	status: 'pending',
	cloudflare_zone_id: 'z',
	cloudflare_custom_hostname_id: 'h',
	ssl_status: 'pending_validation',
	validation_records: null,
	last_sync_at: 10,
	created_at: 5,
	...over
});

describe('custom domains from the wire', () => {
	it('reads a domain, with seconds turned into ms', () => {
		expect(tenantDomainFromRow(row())).toMatchObject({
			id: 'd1',
			tenantId: 'acme',
			isActive: true,
			isPrimary: false,
			status: 'pending',
			managedByCloudflare: true,
			lastSyncAt: 10_000,
			createdAt: 5_000
		});
		expect(
			tenantDomainFromRow(row({ cloudflare_custom_hostname_id: null }))?.managedByCloudflare
		).toBe(false);
	});

	it('leaves deleted domains and unknown states out', () => {
		expect(tenantDomainFromRow(row({ status: 'deleted' }))).toBeNull();
		expect(tenantDomainFromRow(row({ status: 'odd' }))).toBeNull();
		expect(tenantDomainFromRow({ status: 'active' })).toBeNull();
	});

	it('reads the records to publish, and only those', () => {
		expect(
			validationRecordsFrom({
				ownership_verification: { type: 'txt', name: '_cf.x', value: 'v1' },
				ownership_verification_http: { http_url: 'http://x/.well-known/a', http_body: 'b' },
				ssl_validation_records: [
					{ txt_name: '_acme.x', txt_value: 'v2' },
					{ http_url: 'http://x/.well-known/c', http_body: 'd' },
					{ status: 'pending' },
					'junk'
				]
			})
		).toEqual([
			{ kind: 'ownership', type: 'TXT', name: '_cf.x', value: 'v1' },
			{ kind: 'ownership', type: 'HTTP', name: 'http://x/.well-known/a', value: 'b' },
			{ kind: 'certificate', type: 'TXT', name: '_acme.x', value: 'v2' },
			{ kind: 'certificate', type: 'HTTP', name: 'http://x/.well-known/c', value: 'd' }
		]);
		expect(validationRecordsFrom(null)).toEqual([]);
	});

	it('checks hostnames as the API does', () => {
		expect(normalizeHostname(' Login.Example.COM. ')).toBe('login.example.com');
		expect(hostnameValid('login.example.com')).toBe(true);
		expect(hostnameValid('Login.Example.com.')).toBe(true);
		expect(hostnameValid('localhost')).toBe(false);
		expect(hostnameValid('https://login.example.com')).toBe(false);
		expect(hostnameValid('-a.example.com')).toBe(false);
		expect(hostnameValid(`${'a'.repeat(250)}.com`)).toBe(false);
	});
});

describe('the custom domains client', () => {
	it('lists one tenant’s domains on the platform route, without a tenant header', async () => {
		const fetchMock = vi.fn(async () =>
			json({
				domains: [
					row(),
					row({ id: 'd2', status: 'deleted' }),
					row({ id: 'd3', tenant_id: 'other' })
				],
				cloudflare_configured: true
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		const list = await httpTenantDomains().list('acme');
		expect(list.cloudflareConfigured).toBe(true);
		expect(list.domains.map((domain) => domain.id)).toEqual(['d1']);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/platform/tenant-vanity-domains?tenant_id=acme');
		expect(new Headers(init.headers).has('X-Tenant-Id')).toBe(false);
	});

	it('adds with the tenant, the normalized hostname and the primary choice', async () => {
		const fetchMock = vi.fn(async () => json({ domain: row() }, 201));
		vi.stubGlobal('fetch', fetchMock);
		await httpTenantDomains().add('acme', ' Login.Acme.Example. ', false);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(String(init.body))).toEqual({
			tenant_id: 'acme',
			hostname: 'login.acme.example',
			is_primary: false
		});
		expect(new Headers(init.headers).get('Idempotency-Key')).toBeTruthy();
	});

	it('reads the domain from either answer shape', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(json(row({ is_primary: true, status: 'active' })))
				.mockResolvedValueOnce(json({ domain: row({ status: 'active' }) }))
		);
		const client = httpTenantDomains();
		expect((await client.makePrimary('d1')).isPrimary).toBe(true);
		expect((await client.verify('d1')).status).toBe('active');
	});
});

describe('the fake', () => {
	it('refuses a hostname in use, a primary that is not active, and lite-mode primaries', async () => {
		const client = fakeTenantDomains({ liteTenants: ['acme'] });
		await expect(client.add('other', 'login.acme.example', false)).rejects.toMatchObject({
			status: 400
		});
		await expect(client.makePrimary('dom_id')).rejects.toMatchObject({
			code: 'lite_mode_unsupported'
		});
		const plain = fakeTenantDomains();
		await expect(plain.makePrimary('dom_id')).rejects.toMatchObject({ status: 400 });
	});
});
