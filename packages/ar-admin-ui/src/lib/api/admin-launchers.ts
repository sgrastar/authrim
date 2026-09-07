import { API_BASE_URL, adminFetch } from '$lib/api/admin-request';

export type LauncherApplicationType = 'standalone' | 'oidc_client' | 'saml_sp';
export type LauncherLaunchType =
	| 'bookmark'
	| 'saml_sp_initiated'
	| 'oidc_third_party_initiated'
	| 'saml_idp_initiated';
export type LauncherVisibilityMode = 'everyone' | 'users' | 'groups' | 'attributes';
export type LauncherAttributeOperator =
	| 'equals'
	| 'not_equals'
	| 'contains'
	| 'starts_with'
	| 'ends_with'
	| 'exists';

export interface LauncherAttributeRule {
	id: string;
	attribute_key: string;
	operator: LauncherAttributeOperator;
	attribute_value: string | null;
}

export interface ApplicationLauncher {
	id: string;
	application_type: LauncherApplicationType;
	application_id: string | null;
	name: string;
	description: string | null;
	category: string | null;
	launch_type: LauncherLaunchType;
	launch_url: string | null;
	deep_link_url: string | null;
	open_in_new_tab: boolean;
	icon_type: 'phosphor' | 'image';
	icon_value: string;
	icon_color: string;
	background_color: string;
	grid_width: number;
	sort_order: number;
	enabled: boolean;
	allow_favorite: boolean;
	visibility: {
		mode: LauncherVisibilityMode;
		attribute_match: 'all' | 'any';
		user_ids: string[];
		group_ids: string[];
		attribute_rules: LauncherAttributeRule[];
	};
	created_at: number;
	updated_at: number;
}

export type LauncherInput = Omit<ApplicationLauncher, 'id' | 'created_at' | 'updated_at'>;

export interface LauncherOptions {
	oidc_clients: Array<{
		client_id: string;
		client_name: string;
		initiate_login_uri: string | null;
		logo_uri: string | null;
	}>;
	groups: Array<{ id: string; group_key: string; display_name: string }>;
	attribute_keys: string[];
	phosphor_icons: string[];
}

async function parseResponse<T>(response: Response): Promise<T> {
	if (!response.ok) {
		const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		throw new Error(
			(typeof payload.error_description === 'string' && payload.error_description) ||
				(typeof payload.error === 'string' && payload.error) ||
				'Request failed'
		);
	}
	if (response.status === 204) return undefined as T;
	return response.json() as Promise<T>;
}

function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
	return adminFetch(`${API_BASE_URL}${path}`, {
		method,
		includeJsonContentType: body !== undefined,
		body: body === undefined ? undefined : JSON.stringify(body)
	}).then(parseResponse<T>);
}

export const adminLaunchersAPI = {
	list: () => request<{ launchers: ApplicationLauncher[] }>('/api/admin/launchers'),
	options: () => request<LauncherOptions>('/api/admin/launchers/options'),
	create: (body: LauncherInput) =>
		request<{ launcher: ApplicationLauncher }>('/api/admin/launchers', 'POST', body),
	update: (id: string, body: LauncherInput) =>
		request<{ launcher: ApplicationLauncher }>(
			`/api/admin/launchers/${encodeURIComponent(id)}`,
			'PUT',
			body
		),
	reorder: (launcherIds: string[]) =>
		request<{ launchers: ApplicationLauncher[] }>('/api/admin/launchers/order', 'PUT', {
			launcher_ids: launcherIds
		}),
	delete: (id: string) => request<void>(`/api/admin/launchers/${encodeURIComponent(id)}`, 'DELETE')
};
