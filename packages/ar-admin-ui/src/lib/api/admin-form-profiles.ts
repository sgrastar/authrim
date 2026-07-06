import { API_BASE_URL, adminFetch } from '$lib/api/admin-request';

export type FormProfileKind =
	| 'registration'
	| 'profile_completion'
	| 'login'
	| 'consent'
	| 'code_input'
	| 'custom';
export type FormProfileBlockType =
	| 'identity_field'
	| 'auth_widget'
	| 'code_input_widget'
	| 'consent_widget'
	| 'heading'
	| 'text'
	| 'security_verification'
	| 'divider'
	| 'layout_row';
export type FormProfileValueType = 'text' | 'boolean';
export type FormProfileCanvasLayout = 'narrow' | 'wide';
export type FormProfileHumanVerificationTiming = 'initial' | 'submit';

export interface FormProfileSettings {
	canvas_layout?: FormProfileCanvasLayout;
}

export interface FormProfileField {
	field: string;
	label: string;
	required: boolean;
	block_type?: FormProfileBlockType;
	block_id?: string;
	value_type?: FormProfileValueType | null;
	auth_method?: string | null;
	code_input_mode?: 'auto' | 'mail_otp' | 'totp' | null;
	external_idp_show_action_text?: boolean | null;
	text?: string | null;
	help_text?: string | null;
	placeholder?: string | null;
	human_verification_timing?: FormProfileHumanVerificationTiming | null;
	layout_columns?: number | null;
	layout_column?: number | null;
	order?: number;
}

export interface FormProfileLocalization {
	display_name?: string;
	description?: string;
	fields?: Record<
		string,
		Partial<Pick<FormProfileField, 'label' | 'text' | 'help_text' | 'placeholder'>>
	>;
}

export interface FormProfile {
	id: string;
	tenant_id: string;
	profile_key: string;
	display_name: string;
	description?: string | null;
	form_kind: FormProfileKind;
	fields: FormProfileField[];
	localizations: Record<string, FormProfileLocalization>;
	settings: FormProfileSettings;
	is_active: boolean | number;
	is_system: boolean | number;
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

export const adminFormProfilesAPI = {
	async list() {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/form-profiles`);
		return parseResponse<{ profiles: FormProfile[] }>(response);
	},

	async get(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/form-profiles/${encodeURIComponent(id)}`
		);
		return parseResponse<{ profile: FormProfile }>(response);
	},

	async create(body: {
		profile_key?: string;
		display_name: string;
		description?: string | null;
		form_kind: FormProfileKind;
		fields: FormProfileField[];
		localizations?: Record<string, FormProfileLocalization>;
		settings?: FormProfileSettings;
		is_active?: boolean;
	}) {
		return jsonRequest<{ profile: FormProfile }>('/api/admin/form-profiles', 'POST', body);
	},

	async update(
		id: string,
		body: Partial<{
			display_name: string;
			description: string | null;
			form_kind: FormProfileKind;
			fields: FormProfileField[];
			localizations: Record<string, FormProfileLocalization>;
			settings: FormProfileSettings;
			is_active: boolean;
		}>
	) {
		return jsonRequest<{ profile: FormProfile }>(
			`/api/admin/form-profiles/${encodeURIComponent(id)}`,
			'PUT',
			body
		);
	},

	async delete(id: string) {
		return jsonRequest<{ success: true }>(
			`/api/admin/form-profiles/${encodeURIComponent(id)}`,
			'DELETE'
		);
	}
};
