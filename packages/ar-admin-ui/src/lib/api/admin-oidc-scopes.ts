import { API_BASE_URL, adminFetch } from '$lib/api/admin-request';

export type OidcScopeType = 'system' | 'custom';

export interface OidcScopeLocalization {
	display_name?: string;
	description?: string;
}

export interface OidcScope {
	id: string;
	tenant_id: string;
	name: string;
	display_name: string;
	description?: string | null;
	scope_type: OidcScopeType;
	enabled: boolean | number;
	localizations: Record<string, OidcScopeLocalization>;
	created_at: number;
	updated_at: number;
}

async function parseResponse<T>(response: Response): Promise<T> {
	if (!response.ok) {
		const payload = (await response.json().catch(() => ({ error: 'Request failed' }))) as Record<
			string,
			unknown
		>;
		throw new Error(
			(typeof payload.error_description === 'string' && payload.error_description) ||
				(typeof payload.error === 'string' && payload.error) ||
				'Request failed'
		);
	}
	return response.json() as Promise<T>;
}

function jsonRequest<T>(path: string, method: string, body?: unknown): Promise<T> {
	return adminFetch(`${API_BASE_URL}${path}`, {
		method,
		includeJsonContentType: body !== undefined,
		body: body === undefined ? undefined : JSON.stringify(body)
	}).then(parseResponse<T>);
}

export const adminOidcScopesAPI = {
	async list() {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/field-mapping/oidc-scopes`);
		return parseResponse<{ scopes: OidcScope[] }>(response);
	},

	async create(body: {
		name: string;
		display_name: string;
		description?: string | null;
		scope_type?: OidcScopeType;
		enabled?: boolean;
		localizations?: Record<string, OidcScopeLocalization>;
	}) {
		return jsonRequest<{ scope: OidcScope }>('/api/admin/field-mapping/oidc-scopes', 'POST', body);
	},

	async update(
		id: string,
		body: Partial<{
			display_name: string;
			description: string | null;
			enabled: boolean;
			localizations: Record<string, OidcScopeLocalization>;
		}>
	) {
		return jsonRequest<{ scope: OidcScope }>(
			`/api/admin/field-mapping/oidc-scopes/${encodeURIComponent(id)}`,
			'PUT',
			body
		);
	},

	async delete(id: string) {
		return jsonRequest<{ success: true }>(
			`/api/admin/field-mapping/oidc-scopes/${encodeURIComponent(id)}`,
			'DELETE'
		);
	}
};
