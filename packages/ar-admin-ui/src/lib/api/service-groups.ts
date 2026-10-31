import { settingsContext } from '$lib/stores/settings-context.svelte';
import { API_BASE_URL, adminFetch } from './admin-request';
export type { Expression, Field, ServiceGroup, GroupSnapshot } from '@authrim/ar-lib-core';
import type { Field, ServiceGroup } from '@authrim/ar-lib-core';
export interface ServiceGroupCatalog {
	revision: number;
	groups: ServiceGroup[];
	dependencies: Record<string, string[]>;
	fields: Record<string, Field>;
	scans: {
		binding_ref: string;
		rule_version: number;
		processed: number;
		failures: number;
		status: string;
	}[];
}
export async function serviceGroupsRequest<T>(
	path = '',
	method = 'GET',
	data?: unknown
): Promise<T> {
	const tenant = settingsContext.tenantId;
	const response = await adminFetch(`${API_BASE_URL}/api/admin/service-groups${path}`, {
		method,
		...(data === undefined ? {} : { includeJsonContentType: true, body: JSON.stringify(data) })
	});
	const result = await response.json();
	if (settingsContext.tenantId !== tenant) throw new Error('group_tenant_changed');
	if (!response.ok) throw new Error(result.error ?? 'group_request_failed');
	return result as T;
}
