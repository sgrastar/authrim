import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminTenantsAPI, type CloneTenantResponse } from './admin-tenants';

describe('adminTenantsAPI', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('posts explicit clone options to the source tenant clone endpoint', async () => {
		const response = {
			id: 'destination',
			tenant_code: 'destination',
			name: 'Destination',
			description: null,
			isolation_policy: 'tenant_exclusive',
			lifecycle_state: 'active',
			is_default: false,
			created_at: 1,
			updated_at: 1,
			source_tenant_id: 'source tenant',
			source_tenant_name: 'Source',
			copy: {
				settings: true,
				secret_settings: false,
				clients: true,
				client_credentials: false,
				roles: true,
				admin_access: false,
				webhooks: false,
				webhook_secrets: false
			},
			cloned_items: {
				settings: 1,
				secret_settings_skipped: 0,
				unclassified_settings_skipped: 0,
				clients: 1,
				client_settings: 1,
				client_contracts: 1,
				client_web_origins: 1,
				client_trust_policies: 1,
				client_consent_overrides_skipped: 0,
				client_flow_assignments_skipped: 0,
				roles: 1,
				role_assignment_rules: 1,
				role_references_unresolved: 0,
				role_assignment_rules_skipped: 0,
				admin_roles: 0,
				admin_role_assignments: 0,
				admin_role_assignments_skipped: 0,
				admin_role_inheritance_unresolved: 0,
				webhooks: 0,
				client_webhooks_skipped: 0
			},
			signing_keys: { copied: false, generated: true },
			warnings: []
		} satisfies CloneTenantResponse;
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify(response), {
				status: 201,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		const result = await adminTenantsAPI.clone(
			'source tenant',
			{
				id: 'destination',
				name: 'Destination',
				copy: response.copy
			},
			'clone-request-1'
		);

		expect(result).toEqual(response);
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/tenants/source%20tenant/clone'),
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					id: 'destination',
					name: 'Destination',
					copy: response.copy
				})
			})
		);
		expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get('Idempotency-Key')).toBe(
			'clone-request-1'
		);
	});

	it('accepts an asynchronous Control Plane tenant clone operation', async () => {
		const response = {
			id: 'destination',
			tenant_code: 'destination',
			name: 'Destination',
			description: null,
			isolation_policy: 'tenant_exclusive',
			lifecycle_state: 'provisioning',
			is_default: false,
			created_at: 1,
			updated_at: 1,
			source_tenant_id: 'source',
			source_tenant_name: 'Source',
			copy: {
				settings: true,
				secret_settings: false,
				clients: false,
				client_credentials: false,
				roles: true,
				admin_access: false,
				webhooks: false,
				webhook_secrets: false
			},
			provisioning: {
				mode: 'control-plane',
				operation_id: 'tenant_clone_destination',
				tenant_id: 'destination',
				operation_kind: 'clone',
				source_tenant_id: 'source',
				isolation_policy: 'tenant_exclusive',
				status: 'queued',
				current_step: 'request_accepted',
				attempt_count: 0,
				next_attempt_at: null,
				last_error_code: null,
				created_at: 1,
				updated_at: 1,
				completed_at: null,
				preparation_result: null,
				capacity_operation_ids: {},
				steps: []
			}
		} satisfies CloneTenantResponse;
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify(response), {
				status: 202,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(
			adminTenantsAPI.clone('source', {
				id: 'destination',
				name: 'Destination',
				copy: response.copy
			})
		).resolves.toEqual(response);
	});

	it('surfaces clone API errors', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ error_description: 'Source tenant must be active' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(
			adminTenantsAPI.clone('source', {
				id: 'destination',
				name: 'Destination',
				copy: {
					settings: true,
					secret_settings: false,
					clients: false,
					client_credentials: false,
					roles: true,
					admin_access: false,
					webhooks: false,
					webhook_secrets: false
				}
			})
		).rejects.toThrow('Source tenant must be active');
	});

	it('starts placement migration with a caller-generated idempotency key', async () => {
		const operation = {
			operation_id: 'tenant-placement:abc',
			tenant_id: 'tenant a',
			target_isolation_policy: 'tenant_exclusive',
			status: 'queued',
			current_step: 'wait_control',
			attempt_count: 0,
			next_attempt_at: null,
			last_error_code: null,
			lookup_progress: { prepared_rows: 0, activated_rows: 0, verified_rows: 0 },
			steps: [],
			created_at: 1,
			started_at: null,
			completed_at: null,
			updated_at: 1,
			control_status: 'available',
			control: null
		};
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify(operation), {
				status: 202,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		const idempotencyKey = '00000000-0000-4000-8000-000000000001';
		await expect(
			adminTenantsAPI.startPlacementMigration('tenant a', idempotencyKey)
		).resolves.toEqual(operation);
		expect(fetchMock.mock.calls[0]?.[0]).toContain(
			'/api/admin/tenants/tenant%20a/placement-migrations'
		);
		expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get('Idempotency-Key')).toBe(
			idempotencyKey
		);
		expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get('X-Tenant-Id')).toBe('tenant a');
	});

	it('uses the platform tenant inventory context when loading lifecycle jobs', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ jobs: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(adminTenantsAPI.lifecycleJobs('fapi2')).resolves.toEqual([]);

		expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/admin/tenants/fapi2/lifecycle/jobs');
		expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get('X-Tenant-Id')).toBeNull();
	});

	it('uses the platform tenant inventory context for lifecycle mutations', async () => {
		const response = {
			job_id: 'job-1',
			status: 'pending',
			tenant_id: 'fapi2',
			lifecycle_state: 'active',
			validation_required: false
		};
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify(response), {
				status: 202,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(
			adminTenantsAPI.lifecycleCommand(
				'fapi2',
				'suspend',
				{
					expected_state: 'active',
					expected_updated_at: 1,
					reason: 'maintenance'
				},
				'00000000-0000-4000-8000-000000000002'
			)
		).resolves.toEqual(response);

		expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get('X-Tenant-Id')).toBeNull();
	});

	it('uses the platform tenant inventory context when retrying a lifecycle job', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(null, { status: 204 }));

		await expect(adminTenantsAPI.retryLifecycleJob('fapi2', 'job 1')).resolves.toBeUndefined();

		expect(fetchMock.mock.calls[0]?.[0]).toContain(
			'/api/admin/tenants/fapi2/lifecycle/jobs/job%201/retry'
		);
		expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get('X-Tenant-Id')).toBeNull();
	});

	it('treats a missing latest placement migration as an empty state', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
		await expect(adminTenantsAPI.latestPlacementMigration('tenant-a')).resolves.toBeNull();
	});
});
