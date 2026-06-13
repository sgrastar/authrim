import { settingsContext } from '$lib/stores/settings-context.svelte';

export const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';
const MAX_ADMIN_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function shouldAttachIdempotencyKey(method?: string): boolean {
	return !IDEMPOTENT_METHODS.has((method ?? 'GET').toUpperCase());
}

function createIdempotencyKey(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	const bytes = new Uint8Array(16);
	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
		crypto.getRandomValues(bytes);
	}
	return `admin-ui-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function getPersistedTenantId(): string | null {
	if (typeof sessionStorage !== 'undefined') {
		const tenantId = sessionStorage.getItem('settings_tenant_id')?.trim();
		return tenantId && tenantId !== 'default' ? tenantId : null;
	}
	return null;
}

function resolveTenantId(candidate?: string): string | null {
	const resolved =
		candidate?.trim() ||
		settingsContext.tenantId?.trim() ||
		settingsContext.availableTenants[0]?.id ||
		getPersistedTenantId() ||
		'';

	return resolved || null;
}

export function buildAdminHeaders(
	headers?: HeadersInit,
	options: {
		tenantId?: string;
		includeJsonContentType?: boolean;
		skipTenantHeader?: boolean;
		method?: string;
	} = {}
): Headers {
	const resolvedHeaders = new Headers(headers);

	if (options.includeJsonContentType && !resolvedHeaders.has('Content-Type')) {
		resolvedHeaders.set('Content-Type', 'application/json');
	}

	const tenantId = resolveTenantId(options.tenantId);
	if (tenantId && !options.skipTenantHeader) {
		resolvedHeaders.set('X-Tenant-Id', tenantId);
	}

	if (shouldAttachIdempotencyKey(options.method) && !resolvedHeaders.has('Idempotency-Key')) {
		resolvedHeaders.set('Idempotency-Key', createIdempotencyKey());
	}

	return resolvedHeaders;
}

export async function adminFetch(
	input: string,
	options: RequestInit & {
		tenantId?: string;
		includeJsonContentType?: boolean;
		skipTenantHeader?: boolean;
	} = {}
): Promise<Response> {
	const {
		tenantId,
		includeJsonContentType = false,
		skipTenantHeader = false,
		headers,
		...rest
	} = options;

	const response = await fetch(input, {
		...rest,
		credentials: rest.credentials ?? 'include',
		headers: buildAdminHeaders(headers, {
			tenantId,
			includeJsonContentType,
			skipTenantHeader,
			method: rest.method
		})
	});

	const contentLength = response.headers.get('content-length');
	if (contentLength) {
		const parsed = Number.parseInt(contentLength, 10);
		if (Number.isFinite(parsed) && parsed > MAX_ADMIN_API_RESPONSE_BYTES) {
			throw new Error('Admin API response is too large');
		}
	}

	return response;
}
