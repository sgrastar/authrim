import { settingsContext } from '$lib/stores/settings-context.svelte';

export const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

function getSessionId(): string | null {
	if (typeof localStorage !== 'undefined') {
		return localStorage.getItem('sessionId');
	}
	return null;
}

function resolveTenantId(candidate?: string): string | null {
	const resolved =
		candidate?.trim() || settingsContext.tenantId || settingsContext.availableTenants[0]?.id || '';

	return resolved || null;
}

export function buildAdminHeaders(
	headers?: HeadersInit,
	options: {
		tenantId?: string;
		includeJsonContentType?: boolean;
		skipTenantHeader?: boolean;
	} = {}
): Headers {
	const resolvedHeaders = new Headers(headers);

	if (options.includeJsonContentType && !resolvedHeaders.has('Content-Type')) {
		resolvedHeaders.set('Content-Type', 'application/json');
	}

	const sessionId = getSessionId();
	if (sessionId && sessionId !== 'session-from-cookie') {
		resolvedHeaders.set('X-Session-Id', sessionId);
	}

	const tenantId = resolveTenantId(options.tenantId);
	if (tenantId && !options.skipTenantHeader) {
		resolvedHeaders.set('X-Tenant-Id', tenantId);
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
	const { tenantId, includeJsonContentType = false, skipTenantHeader = false, headers, ...rest } =
		options;

	return fetch(input, {
		...rest,
		credentials: rest.credentials ?? 'include',
		headers: buildAdminHeaders(headers, { tenantId, includeJsonContentType, skipTenantHeader })
	});
}
