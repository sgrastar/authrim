import { adminFetch, API_BASE_URL } from './admin-request';
import { errorFromResponse } from './api-error';

export type DirectoryPasswordStatus = 'ready' | 'disabled' | 'unconfigured';

export interface DirectoryPasswordStatusClient {
	get(tenantId: string, signal?: AbortSignal): Promise<DirectoryPasswordStatus>;
}

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
	value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const present = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

/** Use the same connector readiness criteria as the existing Admin UI. */
export function directoryPasswordStatusFromRow(value: unknown): DirectoryPasswordStatus {
	const row = record(value);
	const defaultId = present(row.default_connector_id) ? row.default_connector_id : 'campus';
	const connectors = Array.isArray(row.connectors) ? row.connectors : [];
	const configured = connectors.some((value) => {
		const connector = record(value);
		return (
			connector.id === defaultId &&
			(connector.transport === 'relay' || present(connector.endpoint_url)) &&
			connector.auth_mode === 'hmac' &&
			present(connector.connector_id) &&
			present(connector.key_id) &&
			present(connector.secret_ref)
		);
	});
	if (!configured) return 'unconfigured';
	return row.enabled === true ? 'ready' : 'disabled';
}

export const httpDirectoryPasswordStatus: DirectoryPasswordStatusClient = {
	async get(tenantId, signal) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(tenantId)}/directory-connectors`,
			{ tenantId, signal }
		);
		if (!response.ok) throw await errorFromResponse(response);
		return directoryPasswordStatusFromRow(await response.json());
	}
};
