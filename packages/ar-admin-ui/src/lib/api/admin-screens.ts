import { API_BASE_URL, adminFetch } from '#lib/api/admin-request.js';

export type ScreenKind =
	| 'registration'
	| 'profile_completion'
	| 'login'
	| 'consent'
	| 'code_input'
	| 'account'
	| 'custom';
export type ScreenBlockType =
	| 'identity_field'
	| 'auth_widget'
	| 'guest_login_widget'
	| 'auth_switch_link'
	| 'code_input_widget'
	| 'consent_widget'
	| 'heading'
	| 'text'
	| 'security_verification'
	| 'divider'
	| 'layout_row'
	| 'link'
	/** Parts of the new admin console: shown here, edited there. */
	| 'select'
	| 'radio'
	| 'checkbox'
	| 'account_upgrade_widget'
	| 'account_profile_widget'
	| 'account_device_list_widget'
	| 'account_session_widget'
	| 'account_passkey_widget'
	| 'account_totp_widget'
	| 'account_consent_widget'
	| 'account_activity_widget'
	| 'account_social_account_widget'
	| 'account_launcher_widget';
export type ScreenValueType = 'text' | 'boolean';
export type ScreenCanvasLayout = 'narrow' | 'wide';
export type ScreenHumanVerificationTiming = 'initial' | 'submit';
export type ScreenDisplayConditionMode = 'always' | 'feature_enabled' | 'hidden';
export type ScreenDisplayConditionFeature =
	| 'passkey'
	| 'mail_otp'
	| 'mail_otp_totp'
	| 'totp'
	| 'external_idp'
	| 'directory_password';

export interface ScreenDisplayCondition {
	mode: ScreenDisplayConditionMode;
	feature?: ScreenDisplayConditionFeature | null;
}

export interface ScreenSettings {
	canvas_layout?: ScreenCanvasLayout;
	base_preset_key?: string;
	base_preset_version?: number;
}

export interface ScreenField {
	field: string;
	label: string;
	required: boolean;
	block_type?: ScreenBlockType;
	block_id?: string;
	value_type?: ScreenValueType | null;
	auth_method?: string | null;
	code_input_mode?: 'auto' | 'mail_otp' | 'totp' | null;
	external_idp_show_action_text?: boolean | null;
	text?: string | null;
	help_text?: string | null;
	placeholder?: string | null;
	href?: string | null;
	human_verification_timing?: ScreenHumanVerificationTiming | null;
	display_condition?: ScreenDisplayCondition | null;
	layout_columns?: number | null;
	layout_column?: number | null;
	order?: number;
	/** Set by the new admin console only (this editor keeps a screen that has them read-only). */
	show_label?: boolean;
	store_to_profile?: boolean;
	answer_targets?: string[];
	options?: { value: string; label: string }[];
	/** A link that leaves the screen by an exit (not a URL), and a link drawn as a button. */
	link_action?: 'url' | 'next' | 'back' | 'skip' | 'exit' | null;
	link_exit?: string | null;
	link_style?: 'text' | 'button' | null;
}

/** Block types only the new admin console edits. */
const NEW_CONSOLE_BLOCK_TYPES: ReadonlySet<string> = new Set(['select', 'radio', 'checkbox']);

/**
 * Whether a screen uses what only the new admin console edits: a choice or checkbox part, a hidden
 * label, an answer kept off the profile, its own options, a row of three columns, or a link that
 * leaves the screen by an exit or is drawn as a button. This editor
 * would lose them on save (it knows none of them), so it shows such a screen without editing it.
 */
export function screenNeedsNewConsole(fields: readonly ScreenField[]): boolean {
	return fields.some(
		(field) =>
			NEW_CONSOLE_BLOCK_TYPES.has(String(field.block_type ?? '')) ||
			field.show_label === false ||
			field.store_to_profile === false ||
			(field.answer_targets?.length ?? 0) > 0 ||
			(field.options?.length ?? 0) > 0 ||
			(field.block_type === 'layout_row' && (field.layout_columns ?? 1) > 2) ||
			(Boolean(field.link_action) && field.link_action !== 'url') ||
			field.link_style === 'button'
	);
}

export interface ScreenLocalization {
	display_name?: string;
	description?: string;
	fields?: Record<
		string,
		Partial<Pick<ScreenField, 'label' | 'text' | 'help_text' | 'placeholder'>>
	>;
}

export interface Screen {
	id: string;
	tenant_id: string;
	screen_key: string;
	display_name: string;
	description?: string | null;
	screen_kind: ScreenKind;
	fields: ScreenField[];
	localizations: Record<string, ScreenLocalization>;
	settings: ScreenSettings;
	is_active: boolean | number;
	is_system: boolean | number;
	/** The change counter the API checks (If-Match) before saving over the screen. */
	version?: number;
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

function jsonRequest<T>(
	path: string,
	method: string,
	body?: unknown,
	headers?: Record<string, string>
): Promise<T> {
	return adminFetch(`${API_BASE_URL}${path}`, {
		method,
		includeJsonContentType: body !== undefined,
		body: body === undefined ? undefined : JSON.stringify(body),
		headers
	}).then(parseResponse<T>);
}

export const adminScreensAPI = {
	async list() {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/screens`);
		return parseResponse<{ screens: Screen[] }>(response);
	},

	async get(id: string) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/screens/${encodeURIComponent(id)}`
		);
		return parseResponse<{ screen: Screen }>(response);
	},

	async create(body: {
		screen_key?: string;
		display_name: string;
		description?: string | null;
		screen_kind: ScreenKind;
		fields: ScreenField[];
		localizations?: Record<string, ScreenLocalization>;
		settings?: ScreenSettings;
		is_active?: boolean;
	}) {
		return jsonRequest<{ screen: Screen }>('/api/admin/screens', 'POST', body);
	},

	/** `version` is the one the screen was read at: a change saved since then is refused (409). */
	async update(
		id: string,
		version: number,
		body: Partial<{
			display_name: string;
			description: string | null;
			screen_kind: ScreenKind;
			fields: ScreenField[];
			localizations: Record<string, ScreenLocalization>;
			settings: ScreenSettings;
			is_active: boolean;
		}>
	) {
		return jsonRequest<{ screen: Screen }>(
			`/api/admin/screens/${encodeURIComponent(id)}`,
			'PUT',
			body,
			{ 'If-Match': `"${version}"` }
		);
	},

	async delete(id: string, version?: number) {
		return jsonRequest<{ success: true }>(
			`/api/admin/screens/${encodeURIComponent(id)}`,
			'DELETE',
			undefined,
			version === undefined ? undefined : { 'If-Match': `"${version}"` }
		);
	}
};
