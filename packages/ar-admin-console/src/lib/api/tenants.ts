/**
 * Tenants (`/api/admin/tenants`), as platform administrators manage them: the list, one tenant,
 * creating one, copying one into a new tenant (`/clone`) and deleting one.
 *
 * Every route here is a platform route, so no tenant header is sent. Creating and copying start
 * a provisioning that runs in the background (202): the new tenant is listed at once as
 * `provisioning` and becomes `active` when it is done (`provisioning()` says how far it got).
 * Deleting is a job too: the tenant turns `deleting` at once and its data goes later.
 *
 * Deleting always asks for step-up (`tenant.delete`); copying asks for it when admin access or
 * webhooks are copied. The refusal is met once and the request repeated with the receipt.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';
import { stepUpHeaders, withStepUp } from './admin-step-up';

export const TENANT_LIFECYCLE_STATES = [
	'provisioning',
	'active',
	'suspended',
	'frozen',
	'migration_read_only',
	'deleting',
	'deleted',
	'restore_pending',
	'restore_validating'
] as const;
export type TenantLifecycleState = (typeof TENANT_LIFECYCLE_STATES)[number];

export type TenantIsolationPolicy = 'tenant_exclusive' | 'shared_pool';

export interface Tenant {
	id: string;
	/** The code people type to find the tenant (the id when none was given). */
	code: string;
	name: string;
	description: string | null;
	isolationPolicy: TenantIsolationPolicy;
	lifecycleState: TenantLifecycleState;
	/** The tenant the deployment opens by default; it cannot be deleted. */
	isDefault: boolean;
	/** Epoch ms. */
	createdAt: number | null;
	updatedAt: number | null;
}

export interface TenantList {
	tenants: Tenant[];
	/** The deployment runs one tenant only: tenants cannot be created, copied or deleted. */
	singleTenantMode: boolean;
}

export interface TenantInput {
	id: string;
	name: string;
	code?: string;
	description?: string;
	isolationPolicy: TenantIsolationPolicy;
}

/** What a copy takes from the source, as the clone API names it. */
export const TENANT_COPY_PARTS = [
	'settings',
	'secret_settings',
	'roles',
	'admin_access',
	'clients',
	'client_credentials',
	'webhooks',
	'webhook_secrets'
] as const;
export type TenantCopyPart = (typeof TENANT_COPY_PARTS)[number];
export type TenantCopyOptions = Record<TenantCopyPart, boolean>;

export interface TenantProvisioningStatus {
	status: 'queued' | 'running' | 'waiting_retry' | 'blocked' | 'succeeded' | 'canceled';
	kind: 'create' | 'clone';
	currentStep: string | null;
	lastErrorCode: string | null;
	/** Epoch ms. */
	updatedAt: number | null;
}

export interface TenantsClient {
	list(signal?: AbortSignal): Promise<TenantList>;
	get(tenantId: string, signal?: AbortSignal): Promise<Tenant>;
	/** An id already used answers 409. */
	create(input: TenantInput): Promise<Tenant>;
	/** A new tenant `input.id` with what `copy` selects from `sourceTenantId`. */
	copy(sourceTenantId: string, input: TenantInput, copy: TenantCopyOptions): Promise<Tenant>;
	/** The tenant turns `deleting`; its data is removed by a background job. */
	remove(tenantId: string): Promise<void>;
	/** Null when there is no provisioning for the tenant (404). */
	provisioning(tenantId: string, signal?: AbortSignal): Promise<TenantProvisioningStatus | null>;
}

type Row = Record<string, unknown>;

const record = (value: unknown): Row =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null =>
	typeof value === 'string' && value !== '' ? value : null;

/** The API sends seconds for tenants; a value already in ms (≥ 1e12) is kept. */
function epochMs(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
	return value < 1e12 ? value * 1000 : value;
}

function lifecycleState(value: unknown): TenantLifecycleState {
	return (TENANT_LIFECYCLE_STATES as readonly unknown[]).includes(value)
		? (value as TenantLifecycleState)
		: 'active';
}

export function tenantFromRow(value: unknown): Tenant {
	const row = record(value);
	const id = text(row.id);
	return {
		id,
		code: text(row.tenant_code) || id,
		name: text(row.name) || id,
		description: textOrNull(row.description),
		isolationPolicy: row.isolation_policy === 'shared_pool' ? 'shared_pool' : 'tenant_exclusive',
		lifecycleState: lifecycleState(row.lifecycle_state),
		isDefault: row.is_default === true || row.is_default === 1,
		createdAt: epochMs(row.created_at),
		updatedAt: epochMs(row.updated_at)
	};
}

const PROVISIONING_STATUSES = [
	'queued',
	'running',
	'waiting_retry',
	'blocked',
	'succeeded',
	'canceled'
] as const;

export function provisioningFromRow(value: unknown): TenantProvisioningStatus {
	const row = record(value);
	return {
		status: (PROVISIONING_STATUSES as readonly unknown[]).includes(row.status)
			? (row.status as TenantProvisioningStatus['status'])
			: 'queued',
		kind: row.operation_kind === 'clone' ? 'clone' : 'create',
		currentStep: textOrNull(row.current_step),
		lastErrorCode: textOrNull(row.last_error_code),
		updatedAt: epochMs(row.updated_at)
	};
}

/** The create and clone request body (blank optional fields are left out). */
export function tenantBody(input: TenantInput): Row {
	const code = input.code?.trim();
	const description = input.description?.trim();
	return {
		id: input.id.trim(),
		name: input.name.trim(),
		...(code ? { tenant_code: code } : {}),
		...(description ? { description } : {}),
		isolation_policy: input.isolationPolicy
	};
}

async function readJson(response: Response): Promise<Row> {
	if (!response.ok) throw await errorFromResponse(response);
	if (response.status === 204) return {};
	return record(await response.json().catch(() => ({})));
}

export function httpTenants(): TenantsClient {
	const base = `${API_BASE_URL}/api/admin/tenants`;
	const tenantUrl = (id: string) => `${base}/${encodeURIComponent(id)}`;
	const get = (url: string, signal?: AbortSignal) =>
		adminFetch(url, { signal, skipTenantHeader: true });
	const send = (url: string, method: string, body?: unknown, receipt?: string) =>
		adminFetch(url, {
			method,
			skipTenantHeader: true,
			headers: stepUpHeaders(receipt),
			...(body === undefined ? {} : { includeJsonContentType: true, body: JSON.stringify(body) })
		});

	return {
		async list(signal) {
			const body = await readJson(await get(base, signal));
			return {
				tenants: (Array.isArray(body.tenants) ? body.tenants : []).map(tenantFromRow),
				singleTenantMode: body.single_tenant_mode === true
			};
		},
		async get(tenantId, signal) {
			return tenantFromRow(await readJson(await get(tenantUrl(tenantId), signal)));
		},
		async create(input) {
			return tenantFromRow(await readJson(await send(base, 'POST', tenantBody(input))));
		},
		async copy(sourceTenantId, input, copy) {
			const body = { ...tenantBody(input), copy };
			return withStepUp(async (receipt) =>
				tenantFromRow(
					await readJson(await send(`${tenantUrl(sourceTenantId)}/clone`, 'POST', body, receipt))
				)
			);
		},
		async remove(tenantId) {
			await withStepUp(async (receipt) =>
				readJson(await send(tenantUrl(tenantId), 'DELETE', undefined, receipt))
			);
		},
		async provisioning(tenantId, signal) {
			const response = await get(`${tenantUrl(tenantId)}/provisioning`, signal);
			if (response.status === 404) return null;
			return provisioningFromRow(await readJson(response));
		}
	};
}
