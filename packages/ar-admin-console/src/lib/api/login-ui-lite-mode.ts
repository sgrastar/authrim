/**
 * The tenant's lite Login UI switch (`/api/admin/login-ui/lite-mode`): a server-rendered sign-in
 * for very poor networks. Reading gives the published mode, what the settings record, and whether
 * the tenant could switch on now (`readiness.issues` say why not). Switching publishes the mode
 * to the tenant's policy store; switching on is refused (409 `lite_mode_unsupported`, with the
 * issues) while the lite Login UI cannot do everything the tenant uses, and 409
 * `lite_mode_change_in_progress` while another switch is under way. The setting
 * `login-ui.lite_mode` only records the mode; the settings PATCH refuses it.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { ApiError, errorFromResponse } from './api-error';
import { stepUpHeaders, withStepUp } from './admin-step-up';

const PATH = `${API_BASE_URL}/api/admin/login-ui/lite-mode`;

export type LiteMode = 'off' | 'always';

export const LITE_ISSUE_CODES = [
	'not_released',
	'policy_store_unavailable',
	'method_unsupported',
	'flow_component_unsupported',
	'flow_screen_missing',
	'screen_block_unsupported',
	'screen_method_unsupported',
	'account_block_unsupported',
	'client_login_ui_url',
	'issuer_origin_mismatch',
	'account_page_path_custom'
] as const;

export type LiteIssueCode = (typeof LITE_ISSUE_CODES)[number];

/** One reason the lite Login UI cannot serve the tenant; `subject` and `detail` are identifiers. */
export interface LiteIssue {
	code: LiteIssueCode | (string & {});
	subject?: string;
	detail?: string;
}

export interface LiteHumanVerificationRequired {
	login: boolean;
	signup: boolean;
	reauth: boolean;
}

export interface LiteModeStatus {
	mode: LiteMode;
	policy_revision: string | null;
	generation?: number;
	updated_at: string | null;
	human_verification_required?: LiteHumanVerificationRequired;
	change_in_progress: boolean;
	/** What the setting `login-ui.lite_mode` records (the console's record of the mode). */
	recorded_mode: LiteMode;
	readiness: { ready: boolean; issues: LiteIssue[] };
}

export interface LiteModeSwitched {
	mode: LiteMode;
	policy_revision: string;
	generation: number;
	updated_at: string | null;
	human_verification_required?: LiteHumanVerificationRequired;
	/** False when the console's record (the setting) could not be written; the mode is live. */
	recorded: boolean;
}

/** Switching on was refused: the lite Login UI cannot serve the tenant yet (`issues` say why). */
export class LiteUnsupportedError extends ApiError {
	readonly issues: LiteIssue[];

	constructor(message: string, body: Record<string, unknown>) {
		super(409, 'lite_mode_unsupported', message, body);
		this.name = 'LiteUnsupportedError';
		this.issues = Array.isArray(body.issues) ? (body.issues as LiteIssue[]) : [];
	}
}

/** Another switch is under way: try again shortly. */
export class LiteChangeInProgressError extends ApiError {
	constructor(message: string, body: Record<string, unknown>) {
		super(409, 'lite_mode_change_in_progress', message, body);
		this.name = 'LiteChangeInProgressError';
	}
}

export interface LiteModeClient {
	get(signal?: AbortSignal): Promise<LiteModeStatus>;
	set(mode: LiteMode): Promise<LiteModeSwitched>;
}

/** The Admin API, through the console's same-origin proxy. */
export const httpLiteMode: LiteModeClient = {
	async get(signal) {
		const response = await adminFetch(PATH, { signal });
		if (!response.ok) throw await errorFromResponse(response);
		return (await response.json()) as LiteModeStatus;
	},
	async set(mode) {
		return withStepUp(async (receipt) => {
			const response = await adminFetch(PATH, {
				method: 'PUT',
				body: JSON.stringify({ mode }),
				headers: stepUpHeaders(receipt),
				includeJsonContentType: true
			});
			if (response.status === 409) {
				const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
				const message =
					typeof body.error_description === 'string' ? body.error_description : 'Conflict';
				if (body.error === 'lite_mode_change_in_progress') {
					throw new LiteChangeInProgressError(message, body);
				}
				throw new LiteUnsupportedError(message, body);
			}
			if (!response.ok) throw await errorFromResponse(response);
			return (await response.json()) as LiteModeSwitched;
		});
	}
};
