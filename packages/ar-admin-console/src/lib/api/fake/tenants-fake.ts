/**
 * In-memory tenants for Storybook and tests. Follows the Admin API's rules the pages react to:
 * an id or code is used once (400), a new tenant or copy starts `provisioning`, a deleted tenant turns
 * `deleting`, the default tenant cannot be deleted, copying admin access and webhooks together
 * is refused (400 `step_up_separate_operations`), and a step-up the admin cancels stops a write
 * (`cancelStepUp`).
 */
import { StepUpCancelledError } from '../admin-step-up';
import { ApiError } from '../api-error';
import type {
	Tenant,
	TenantCopyOptions,
	TenantInput,
	TenantProvisioningStatus,
	TenantsClient
} from '../tenants';

export type FakeTenantsCall = keyof TenantsClient;

export interface FakeTenantsOptions {
	tenants?: Tenant[];
	delay?: number;
	failOn?: Partial<Record<FakeTenantsCall, 403 | 404 | 500>>;
	singleTenantMode?: boolean;
	/** Deleting and copying with a step-up run into one the admin cancels. */
	cancelStepUp?: boolean;
	/** Every copy request the fake was given, newest last. */
	copies?: Array<{ source: string; input: TenantInput; copy: TenantCopyOptions }>;
}

const NOW = Date.UTC(2026, 10, 14, 2, 0, 0);
const DAY = 86_400_000;

export function sampleTenants(): Tenant[] {
	const tenant = (over: Partial<Tenant> & Pick<Tenant, 'id' | 'name'>): Tenant => ({
		code: over.id,
		description: null,
		isolationPolicy: 'tenant_exclusive',
		lifecycleState: 'active',
		isDefault: false,
		createdAt: NOW - 90 * DAY,
		updatedAt: NOW - 3 * DAY,
		...over
	});
	return [
		tenant({ id: 'default', name: 'Default', isDefault: true, createdAt: NOW - 400 * DAY }),
		tenant({
			id: 'acme',
			name: 'Acme Corporation',
			description: 'Production tenant for Acme employees.',
			createdAt: NOW - 120 * DAY,
			updatedAt: NOW - DAY
		}),
		tenant({
			id: 'acme-staging',
			name: 'Acme (staging)',
			isolationPolicy: 'shared_pool',
			createdAt: NOW - 60 * DAY
		}),
		tenant({
			id: 'globex',
			name: 'Globex',
			lifecycleState: 'suspended',
			createdAt: NOW - 30 * DAY,
			updatedAt: NOW - 2 * DAY
		}),
		tenant({
			id: 'initech',
			name: 'Initech',
			lifecycleState: 'provisioning',
			createdAt: NOW - 600_000,
			updatedAt: NOW - 600_000
		})
	];
}

export function fakeTenants(options: FakeTenantsOptions = {}): TenantsClient {
	const tenants = (options.tenants ?? sampleTenants()).map((tenant) => ({ ...tenant }));
	const delay = options.delay ?? 0;
	const wait = () => new Promise((resolve) => setTimeout(resolve, delay));
	const fail = async (call: FakeTenantsCall) => {
		await wait();
		const status = options.failOn?.[call];
		if (status) throw new ApiError(status, status === 403 ? 'forbidden' : 'error', 'fake');
	};
	const find = (id: string) => {
		const tenant = tenants.find((candidate) => candidate.id === id);
		if (!tenant) throw new ApiError(404, 'not_found', 'Tenant not found');
		return tenant;
	};
	const add = (input: TenantInput): Tenant => {
		// As the API: a repeated id or code is a plain 400, not a conflict.
		const id = input.id.trim();
		const code = input.code?.trim() || id;
		if (tenants.some((tenant) => tenant.id === id || tenant.code === code)) {
			throw new ApiError(400, 'invalid_request', 'Tenant ID already exists');
		}
		const tenant: Tenant = {
			id: input.id.trim(),
			code: input.code?.trim() || input.id.trim(),
			name: input.name.trim(),
			description: input.description?.trim() || null,
			isolationPolicy: input.isolationPolicy,
			lifecycleState: 'provisioning',
			isDefault: false,
			createdAt: NOW,
			updatedAt: NOW
		};
		tenants.push(tenant);
		return { ...tenant };
	};

	return {
		async list() {
			await fail('list');
			return {
				tenants: tenants.map((tenant) => ({ ...tenant })),
				singleTenantMode: options.singleTenantMode ?? false
			};
		},
		async get(tenantId) {
			await fail('get');
			return { ...find(tenantId) };
		},
		async create(input) {
			await fail('create');
			return add(input);
		},
		async copy(source, input, copy) {
			await fail('copy');
			const from = find(source);
			if (from.lifecycleState !== 'active') {
				throw new ApiError(400, 'invalid_request', 'Source tenant must be active');
			}
			if (copy.admin_access && copy.webhooks) {
				throw new ApiError(400, 'step_up_separate_operations', 'Two step-ups');
			}
			if (options.cancelStepUp && (copy.admin_access || copy.webhooks)) {
				throw new StepUpCancelledError();
			}
			options.copies?.push({ source, input, copy: { ...copy } });
			return add(input);
		},
		async remove(tenantId) {
			await fail('remove');
			const tenant = find(tenantId);
			if (tenant.isDefault) {
				throw new ApiError(400, 'invalid_request', 'Cannot delete the default tenant');
			}
			if (options.cancelStepUp) throw new StepUpCancelledError();
			tenant.lifecycleState = 'deleting';
		},
		async provisioning(tenantId): Promise<TenantProvisioningStatus | null> {
			await fail('provisioning');
			const tenant = find(tenantId);
			if (tenant.lifecycleState !== 'provisioning') return null;
			return {
				status: 'running',
				kind: 'create',
				currentStep: 'allocate_database',
				lastErrorCode: null,
				updatedAt: NOW
			};
		}
	};
}
