import { API_BASE_URL, adminFetch } from '$lib/api/admin-request';

export interface RuntimeProfileRecord {
	id: string;
	kind: 'storage' | 'audit' | 'residency';
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

export type StorageBoundaryClass = 'auth_core' | 'pii' | 'custom_extension' | 'authorization';

export type StorageSlice =
	| 'identity_core'
	| 'identity_pii'
	| 'custom_claims'
	| 'registration_fields'
	| 'custom_pii'
	| 'passkeys'
	| 'linked_identities'
	| 'consent'
	| 'authorization';

export interface StorageSliceBoundaryPolicy {
	slice: StorageSlice;
	boundaryClass: StorageBoundaryClass;
	tenantOverrideAllowed: boolean;
	d1Default: boolean;
	nonD1OptionRequired: boolean;
}

export interface StorageProfileTenantOverridePolicy {
	authCoreSlice: string;
	authCoreSlices: string[];
	slicePolicies: Record<string, StorageSliceBoundaryPolicy>;
	environmentDefaultStorageProfileId: string;
	tenantOverrideAllowed: boolean;
	violationCode?: string;
	reason?: string;
}

export interface StorageProfileOperatorGuidance {
	profileId: string;
	deploymentProfile: 'shared-d1' | 'tenant-d1' | 'external-durable' | 'legacy-custom';
	selectionScope: 'deployment';
	recommendedScale: 'small' | 'medium_large' | 'regulated_or_large' | 'custom';
	warnings: string[];
	requirements: string[];
	upgradeTargets: string[];
}

export interface StorageProfileDeploymentSelectionPolicy {
	profileId: string;
	environmentDefaultStorageProfileId: string;
	deploymentSelectionAllowed: boolean;
	selectionScope: 'deployment';
	isEnvironmentDefault: boolean;
	guidance: StorageProfileOperatorGuidance;
}

export interface TenantDatabaseStatsSummary {
	active_tenant_core_databases: number;
	stats_rows: number;
	missing_stats_count: number;
	stale_stats_count: number;
	warning_count: number;
	strong_warning_count: number;
	stale_file_size_count: number;
	unavailable_file_size_count: number;
}

export interface TenantDatabaseStatsStatus {
	available: boolean;
	staleAfterHours: number;
	cutoffIso: string;
	summary: TenantDatabaseStatsSummary | null;
	attentionRequired: boolean;
	unavailableReason?: 'db_admin_not_configured' | 'query_failed';
}

export interface RuntimeRegistrySecurityNotificationStatus {
	available: boolean;
	attentionRequired: boolean;
	summary: {
		pending_count: number;
		failed_count: number;
		dead_letter_count: number;
		critical_count: number;
		high_count: number;
		latest_created_at: string | null;
	} | null;
	unavailableReason?: 'db_admin_not_configured' | 'query_failed';
}

export type StorageProfileCapabilityState = 'supported' | 'partial' | 'unsupported' | 'planned';
export type StorageProfileCapabilityCriticality =
	| 'security_critical'
	| 'user_critical'
	| 'admin_critical'
	| 'non_critical';

export interface StorageProfileCapabilityStatusEntry {
	id: string;
	label: string;
	state: StorageProfileCapabilityState;
	criticality: StorageProfileCapabilityCriticality;
	detail: string;
}

export interface StorageProfileCapabilityStatus {
	profileId: string;
	deploymentProfile: 'shared-d1' | 'tenant-d1' | 'external-durable' | 'legacy-custom';
	mvpReady: boolean;
	unsupportedCount: number;
	partialCount: number;
	capabilities: StorageProfileCapabilityStatusEntry[];
}

export interface StorageProfileListPolicy {
	authCoreSlice: string;
	authCoreSlices: string[];
	slicePolicies: Record<string, StorageSliceBoundaryPolicy>;
	environmentDefaultStorageProfileId: string;
	tenantDatabaseStatsStatus?: TenantDatabaseStatsStatus | null;
	runtimeRegistrySecurityNotifications?: RuntimeRegistrySecurityNotificationStatus | null;
	capabilityStatus?: Record<string, StorageProfileCapabilityStatus>;
	tenantOverrideEligibility: Record<string, StorageProfileTenantOverridePolicy>;
	deploymentSelectionPolicy?: {
		selectionScope: 'deployment';
		environmentDefaultStorageProfileId: string;
		profiles: Record<string, StorageProfileDeploymentSelectionPolicy>;
	};
}

export interface RuntimeProfileListResponse {
	profiles: Record<string, RuntimeProfileRecord[]>;
	reference_status?: Record<string, Record<string, RuntimeProfileReferenceStatusEntry[]>>;
	activation_status?: Record<string, Record<string, RuntimeProfileActivationStatus>>;
	reference_management?: RuntimeProfileReferenceManagementPolicy;
	reference_catalog?: RuntimeProfileReferenceCatalog;
	storage_policy?: StorageProfileListPolicy;
}

export interface RuntimeProfileDefaultsResponse {
	defaults: {
		storageProfileId: string;
		auditProfileId: string;
		residencyProfileId: string;
	};
	effective?: {
		storage?: RuntimeProfileRecord | null;
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

	async updateDefaults(body: {
		storageProfileId?: string;
		auditProfileId?: string;
		residencyProfileId?: string;
	}) {
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
			storage_policy?: StorageProfileTenantOverridePolicy & {
				deploymentSelectionPolicy?: StorageProfileDeploymentSelectionPolicy;
				capabilityStatus?: StorageProfileCapabilityStatus;
			};
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
