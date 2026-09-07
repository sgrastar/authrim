import { API_BASE_URL, adminFetch } from '$lib/api/admin-request';

export interface RuntimeProfileRecord {
	id: string;
	kind: 'audit' | 'residency';
	label: string;
	description?: string;
	builtin?: boolean;
	version?: number;
	metadata?: Record<string, unknown>;
	[key: string]: unknown;
}

export type RuntimeProfileKind = RuntimeProfileRecord['kind'];
export type RuntimeProfileReferenceResolution =
	| 'configured'
	| 'not_configured'
	| 'reference_only'
	| 'inline_config';
export type RuntimeProfileReferenceSeverity = 'info' | 'warning' | 'error';
export type RuntimeProfileReferenceActivation = 'ready' | 'warning_only' | 'blocked';

export interface RuntimeProfileReferenceStatusEntry {
	path: string;
	type: string;
	resolution: RuntimeProfileReferenceResolution;
	severity: RuntimeProfileReferenceSeverity;
	activation: RuntimeProfileReferenceActivation;
	bindingRef?: string;
	connectionRef?: string;
	reference?: string;
	reason?: string;
}

export interface RuntimeProfileActivationStatus {
	state: 'ready' | 'warning' | 'blocked';
	activatable: boolean;
	severity: RuntimeProfileReferenceSeverity;
	blockingReasons: string[];
	warnings: string[];
}

export interface RuntimeProfileReferenceManagementPolicy {
	mode: 'setup_only';
	future: 'admin_ui_planned';
	activationPolicy: 'save_ok_activate_ng';
	note: string;
}

export interface RuntimeProfileReferenceCatalog {
	bindingRefs: {
		d1: string[];
		r2: string[];
		hyperdrive: string[];
		all: string[];
	};
	connectionRefs: {
		all: string[];
	};
}

export interface RuntimeProfileListResponse {
	profiles: Record<string, RuntimeProfileRecord[]>;
	reference_status?: Record<string, Record<string, RuntimeProfileReferenceStatusEntry[]>>;
	activation_status?: Record<string, Record<string, RuntimeProfileActivationStatus>>;
	reference_management?: RuntimeProfileReferenceManagementPolicy;
	reference_catalog?: RuntimeProfileReferenceCatalog;
}

export interface RuntimeProfileDefaultsResponse {
	defaults: {
		auditProfileId: string;
		residencyProfileId: string;
	};
	effective?: {
		audit?: RuntimeProfileRecord | null;
		residency?: RuntimeProfileRecord | null;
	};
	reference_status?: Record<string, RuntimeProfileReferenceStatusEntry[]>;
	activation_status?: Record<string, RuntimeProfileActivationStatus>;
	reference_management?: RuntimeProfileReferenceManagementPolicy;
	reference_catalog?: RuntimeProfileReferenceCatalog;
}

async function parseResponse<T>(response: Response): Promise<T> {
	if (!response.ok) {
		const error = await response.json().catch(() => ({ error: 'unknown_error' }));
		throw new Error(error.error_description || error.message || error.error || 'Request failed');
	}
	return response.json() as Promise<T>;
}

export const adminRuntimeProfilesAPI = {
	async list(kind: RuntimeProfileKind, includeBuiltins = true) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/runtime-profiles?kind=${kind}&include_builtins=${includeBuiltins ? 'true' : 'false'}`,
			{ skipTenantHeader: true }
		);

		return parseResponse<RuntimeProfileListResponse>(response);
	},

	async getDefaults() {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/runtime-profiles/defaults`, {
			skipTenantHeader: true
		});
		return parseResponse<RuntimeProfileDefaultsResponse>(response);
	},

	async updateDefaults(body: { auditProfileId?: string; residencyProfileId?: string }) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/runtime-profiles/defaults`, {
			method: 'PUT',
			skipTenantHeader: true,
			includeJsonContentType: true,
			body: JSON.stringify(body)
		});
		return parseResponse(response);
	},

	async get(kind: RuntimeProfileKind, id: string) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/runtime-profiles/${kind}/${id}`, {
			skipTenantHeader: true
		});
		return parseResponse<{
			profile: RuntimeProfileRecord;
			reference_status?: RuntimeProfileReferenceStatusEntry[];
			activation_status?: RuntimeProfileActivationStatus;
			reference_management?: RuntimeProfileReferenceManagementPolicy;
			reference_catalog?: RuntimeProfileReferenceCatalog;
		}>(response);
	},

	async upsert(kind: RuntimeProfileKind, id: string, body: Record<string, unknown>) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/runtime-profiles/${kind}/${id}`, {
			method: 'PUT',
			skipTenantHeader: true,
			includeJsonContentType: true,
			body: JSON.stringify(body)
		});
		return parseResponse<{
			created: boolean;
			profile: RuntimeProfileRecord;
			reference_status?: RuntimeProfileReferenceStatusEntry[];
			activation_status?: RuntimeProfileActivationStatus;
			reference_management?: RuntimeProfileReferenceManagementPolicy;
			reference_catalog?: RuntimeProfileReferenceCatalog;
		}>(response);
	},

	async remove(kind: RuntimeProfileKind, id: string) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/runtime-profiles/${kind}/${id}`, {
			method: 'DELETE',
			skipTenantHeader: true
		});
		return parseResponse<{ deleted: boolean }>(response);
	}
};
