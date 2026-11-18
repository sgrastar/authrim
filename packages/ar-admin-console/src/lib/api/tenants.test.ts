import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictError } from './api-error';
import { fakeTenants } from './fake/tenants-fake';
import { httpTenants, provisioningFromRow, tenantBody, tenantFromRow } from './tenants';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('tenants from the wire', () => {
	it('reads a tenant, with seconds turned into ms and the code falling back to the id', () => {
		expect(
			tenantFromRow({
				id: 'acme',
				tenant_code: null,
				name: 'Acme',
				description: '',
				isolation_policy: 'shared_pool',
				lifecycle_state: 'suspended',
				is_default: 1,
				created_at: 1_700_000_000,
				updated_at: 1_700_000_000_000
			})
		).toEqual({
			id: 'acme',
			code: 'acme',
			name: 'Acme',
			description: null,
			isolationPolicy: 'shared_pool',
			lifecycleState: 'suspended',
			isDefault: true,
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_000
		});
	});

	it('reads an unknown state as active and an unknown policy as the tenant’s own', () => {
		expect(tenantFromRow({ id: 'x', lifecycle_state: 'odd' })).toMatchObject({
			name: 'x',
			lifecycleState: 'active',
			isolationPolicy: 'tenant_exclusive',
			isDefault: false,
			createdAt: null
		});
	});

	it('reads a provisioning status', () => {
		expect(
			provisioningFromRow({
				status: 'blocked',
				operation_kind: 'clone',
				current_step: 'copy',
				last_error_code: 'E1',
				updated_at: 10
			})
		).toEqual({
			status: 'blocked',
			kind: 'clone',
			currentStep: 'copy',
			lastErrorCode: 'E1',
			updatedAt: 10_000
		});
	});

	it('leaves blank optional fields out of the request body', () => {
		expect(
			tenantBody({ id: ' acme ', name: ' Acme ', code: ' ', isolationPolicy: 'tenant_exclusive' })
		).toEqual({ id: 'acme', name: 'Acme', isolation_policy: 'tenant_exclusive' });
	});
});

describe('the tenants client', () => {
	it('lists without a tenant header', async () => {
		const fetchMock = vi.fn(async () =>
			json({ tenants: [{ id: 'a', name: 'A' }], single_tenant_mode: true })
		);
		vi.stubGlobal('fetch', fetchMock);
		const list = await httpTenants().list();
		expect(list.singleTenantMode).toBe(true);
		expect(list.tenants.map((tenant) => tenant.id)).toEqual(['a']);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/tenants');
		expect(new Headers(init.headers).has('X-Tenant-Id')).toBe(false);
	});

	it('copies with the chosen parts under `copy`', async () => {
		const fetchMock = vi.fn(async () =>
			json({ id: 'b', name: 'B', lifecycle_state: 'provisioning' }, 202)
		);
		vi.stubGlobal('fetch', fetchMock);
		const copy = {
			settings: true,
			secret_settings: false,
			roles: true,
			admin_access: false,
			clients: true,
			saml_providers: true,
			client_credentials: false,
			webhooks: false,
			webhook_secrets: false
		};
		const created = await httpTenants().copy(
			'a/b',
			{ id: 'b', name: 'B', isolationPolicy: 'tenant_exclusive' },
			copy
		);
		expect(created.lifecycleState).toBe('provisioning');
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/tenants/a%2Fb/clone');
		expect(JSON.parse(String(init.body))).toEqual({
			id: 'b',
			name: 'B',
			isolation_policy: 'tenant_exclusive',
			copy
		});
		expect(new Headers(init.headers).get('Idempotency-Key')).toBeTruthy();
	});

	it('deletes with DELETE and passes a refusal on', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(json({ job_id: 'j' }, 202))
			.mockResolvedValueOnce(json({ error: 'conflict', message: 'busy' }, 409));
		vi.stubGlobal('fetch', fetchMock);
		await httpTenants().remove('acme');
		expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
		await expect(httpTenants().remove('acme')).rejects.toBeInstanceOf(ConflictError);
	});

	it('reads no provisioning as null', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json({ error: 'not_found' }, 404))
		);
		await expect(httpTenants().provisioning('acme')).resolves.toBeNull();
	});
});

describe('the fake', () => {
	it('refuses an id in use and copying admin access with webhooks', async () => {
		const client = fakeTenants();
		await expect(
			client.create({ id: 'acme', name: 'Acme', isolationPolicy: 'tenant_exclusive' })
		).rejects.toMatchObject({ status: 400 });
		const all = {
			settings: true,
			secret_settings: false,
			roles: true,
			admin_access: true,
			clients: false,
			saml_providers: false,
			client_credentials: false,
			webhooks: true,
			webhook_secrets: false
		};
		await expect(
			client.copy('acme', { id: 'n', name: 'N', isolationPolicy: 'tenant_exclusive' }, all)
		).rejects.toMatchObject({ code: 'step_up_separate_operations' });
	});
});
