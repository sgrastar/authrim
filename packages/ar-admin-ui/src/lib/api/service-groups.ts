import { settingsContext } from '#lib/stores/settings-context.svelte.js';
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
/** Add (POST) or remove (DELETE) a manual membership of a group; the API's message on failure. */
export async function setManualGroupMember(
	groupId: string,
	subjectId: string,
	present: boolean
): Promise<void> {
	const tenant = settingsContext.tenantId;
	const base = `${API_BASE_URL}/api/admin/groups/${encodeURIComponent(groupId)}/members`;
	const response = await adminFetch(
		present ? base : `${base}/${encodeURIComponent(subjectId)}`,
		present
			? {
					method: 'POST',
					includeJsonContentType: true,
					body: JSON.stringify({ subject_id: subjectId })
				}
			: { method: 'DELETE' }
	);
	if (settingsContext.tenantId !== tenant) throw new Error('group_tenant_changed');
	if (!response.ok) {
		const result = (await response.json().catch(() => ({}))) as {
			error?: string;
			error_description?: string;
		};
		throw new Error(result.error_description ?? result.error ?? 'group_request_failed');
	}
}
export interface GroupMemberRow {
	subject_id: string;
	assignment_source: string;
	lifecycle_state: string;
	effective: boolean;
}
/** The members of a group from the canonical memberships (every source, manual included). */
export async function listGroupMembers(groupId: string): Promise<GroupMemberRow[]> {
	const tenant = settingsContext.tenantId;
	const response = await adminFetch(
		`${API_BASE_URL}/api/admin/groups/${encodeURIComponent(groupId)}/members`
	);
	const result = (await response.json().catch(() => ({}))) as {
		members?: GroupMemberRow[];
		error?: string;
		error_description?: string;
	};
	if (settingsContext.tenantId !== tenant) throw new Error('group_tenant_changed');
	if (!response.ok)
		throw new Error(result.error_description ?? result.error ?? 'group_request_failed');
	return result.members ?? [];
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
