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

export type StorageBoundaryClass = 'auth_core' | 'pii' | 'custom_extension';

export type StorageSlice =
	| 'users_core'
	| 'users_pii'
	| 'custom_claims'
	| 'registration_fields'
	| 'custom_pii';

export interface StorageSliceBoundaryPolicy {
	slice: StorageSlice;
	boundaryClass: StorageBoundaryClass;
	tenantOverrideAllowed: boolean;
	d1Default: boolean;
	nonD1OptionRequired: boolean;
	compatibilityShorthand?: boolean;
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

export interface StorageProfileListPolicy {
	authCoreSlice: string;
	authCoreSlices: string[];
	slicePolicies: Record<string, StorageSliceBoundaryPolicy>;
	environmentDefaultStorageProfileId: string;
	tenantOverrideEligibility: Record<string, StorageProfileTenantOverridePolicy>;
}

export interface RuntimeProfileListResponse {
	profiles: Record<string, RuntimeProfileRecord[]>;
	storage_policy?: StorageProfileListPolicy;
}

export interface RuntimeProfileDefaultsResponse {
	defaults: {
		storageProfileId: string;
		auditProfileId: string;
		residencyProfileId: string;
	};
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

	async updateDefaults(body: { auditProfileId: string }) {
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
			storage_policy?: StorageProfileTenantOverridePolicy;
		}>(response);
	},

	async upsert(kind: RuntimeProfileKind, id: string, body: Record<string, unknown>) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/runtime-profiles/${kind}/${id}`, {
			method: 'PUT',
			skipTenantHeader: true,
			includeJsonContentType: true,
			body: JSON.stringify(body)
		});
		return parseResponse<{ created: boolean; profile: RuntimeProfileRecord }>(response);
	},

	async remove(kind: RuntimeProfileKind, id: string) {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/runtime-profiles/${kind}/${id}`, {
			method: 'DELETE',
			skipTenantHeader: true
		});
		return parseResponse<{ deleted: boolean }>(response);
	}
};
