/**
 * Admin Custom Claims Schema API Client
 *
 * Provides methods for managing custom claim schemas:
 * - List, create, update, delete schemas
 * - Rename field_key (2-phase)
 * - Retry failed operations
 * - Reserved OIDC claim names
 * - Statistics
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

// =============================================================================
// Types
// =============================================================================

/** Valid field types for custom claims */
export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'enum';

/** Operation status */
export type OperationStatus = 'active' | 'renaming' | 'deleting' | 'error';

/** Scope evaluation mode */
export type ScopeMode = 'all' | 'any';

/** String validation rules */
export interface StringValidation {
	min_length?: number;
	max_length?: number;
	pattern?: string;
}

/** Number validation rules */
export interface NumberValidation {
	min?: number;
	max?: number;
}

/** Enum validation rules */
export interface EnumValidation {
	enum_values: string[];
}

/** Date validation rules */
export interface DateValidation {
	min_date?: string;
	max_date?: string;
}

/** Validation rules discriminated by field type */
export type ValidationRules = StringValidation | NumberValidation | EnumValidation | DateValidation;

/** Custom claim schema */
export interface CustomClaimSchema {
	id: string;
	tenant_id: string;
	field_key: string;
	display_label: string;
	field_type: FieldType;
	is_pii: number;
	is_required: number;
	is_active: number;
	validation_rules: string | null;
	include_in_id_token: number;
	include_in_userinfo: number;
	include_in_introspection: number;
	required_scopes: string | null;
	scope_mode: ScopeMode;
	is_system: number;
	is_searchable: number;
	is_exportable: number;
	is_vc_claim: number;
	claim_namespace: string | null;
	description: string | null;
	display_order: number;
	schema_version: number;
	operation_status: OperationStatus;
	operation_detail: string | null;
	created_by: string | null;
	created_at: number;
	updated_at: number;
	show_on_registration?: number;
	registration_required?: number;
	registration_order?: number;
	registration_placeholder?: string | null;
}

/** Pagination info */
export interface PaginationInfo {
	page: number;
	limit: number;
	total: number;
	total_pages: number;
}

/** List response */
export interface CustomClaimsListResponse {
	schemas: CustomClaimSchema[];
	pagination: PaginationInfo;
}

/** Get response with user count */
export interface CustomClaimGetResponse {
	schema: CustomClaimSchema;
	user_count: number;
	user_count_approximate: boolean;
}

/** Stats response */
export interface CustomClaimStats {
	total: number;
	active_non_pii: number;
	active_pii: number;
	non_pii_users_with_data: number;
	pii_users_with_data: number;
	pii_users_approximate: boolean;
	field_usage: Array<{ field_name: string; count: number }>;
	error_count: number;
}

/** Rename response */
export interface RenameResponse {
	schema: CustomClaimSchema;
	affected_users: number;
	old_key: string;
	new_key: string;
}

/** Create/Update request body */
export interface CustomClaimSchemaInput {
	field_key?: string;
	display_label?: string;
	field_type?: FieldType;
	is_pii?: boolean;
	is_required?: boolean;
	is_active?: boolean;
	validation_rules?: ValidationRules | null;
	include_in_id_token?: boolean;
	include_in_userinfo?: boolean;
	include_in_introspection?: boolean;
	required_scopes?: string[] | null;
	scope_mode?: ScopeMode;
	is_searchable?: boolean;
	is_exportable?: boolean;
	is_vc_claim?: boolean;
	claim_namespace?: string | null;
	description?: string | null;
	display_order?: number;
	show_on_registration?: boolean;
	registration_required?: boolean;
	registration_order?: number;
	registration_placeholder?: string | null;
}

// =============================================================================
// API Client
// =============================================================================

export const adminCustomClaimsAPI = {
	/**
	 * List custom claim schemas with filtering and pagination
	 */
	async listSchemas(params?: {
		page?: number;
		limit?: number;
		search?: string;
		field_type?: FieldType;
		is_pii?: string;
		is_active?: string;
		is_system?: '0' | '1';
		operation_status?: OperationStatus;
	}): Promise<CustomClaimsListResponse> {
		const searchParams = new URLSearchParams();
		if (params?.page) searchParams.set('page', params.page.toString());
		if (params?.limit) searchParams.set('limit', params.limit.toString());
		if (params?.search) searchParams.set('search', params.search);
		if (params?.field_type) searchParams.set('field_type', params.field_type);
		if (params?.is_pii) searchParams.set('is_pii', params.is_pii);
		if (params?.is_active) searchParams.set('is_active', params.is_active);
		if (params?.is_system) searchParams.set('is_system', params.is_system);
		if (params?.operation_status) searchParams.set('operation_status', params.operation_status);

		const response = await fetch(`${API_BASE_URL}/api/admin/custom-claims?${searchParams}`, {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to list custom claim schemas');
		}

		return response.json();
	},

	/**
	 * Create a new custom claim schema
	 */
	async createSchema(data: CustomClaimSchemaInput): Promise<{ schema: CustomClaimSchema }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/custom-claims`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to create custom claim schema');
		}

		return response.json();
	},

	/**
	 * Get reserved OIDC claim names
	 */
	async getReservedNames(): Promise<{ reserved_names: string[] }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/custom-claims/reserved-names`, {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			throw new Error('Failed to get reserved names');
		}

		return response.json();
	},

	/**
	 * Get statistics
	 */
	async getStats(): Promise<CustomClaimStats> {
		const response = await fetch(`${API_BASE_URL}/api/admin/custom-claims/stats`, {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			throw new Error('Failed to get custom claim stats');
		}

		return response.json();
	},

	/**
	 * Get a single schema with user count
	 */
	async getSchema(id: string): Promise<CustomClaimGetResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/custom-claims/${id}`, {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to get custom claim schema');
		}

		return response.json();
	},

	/**
	 * Update a schema
	 */
	async updateSchema(
		id: string,
		data: CustomClaimSchemaInput
	): Promise<{ schema: CustomClaimSchema }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/custom-claims/${id}`, {
			method: 'PUT',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to update custom claim schema');
		}

		return response.json();
	},

	/**
	 * Delete a schema (2-phase cascade)
	 */
	async deleteSchema(id: string): Promise<{ success: boolean; deleted_id: string }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/custom-claims/${id}`, {
			method: 'DELETE',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to delete custom claim schema');
		}

		return response.json();
	},

	/**
	 * Rename field_key (2-phase)
	 */
	async renameSchema(id: string, newFieldKey: string): Promise<RenameResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/custom-claims/${id}/rename`, {
			method: 'PATCH',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ new_field_key: newFieldKey })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to rename custom claim schema');
		}

		return response.json();
	},

	/**
	 * Retry a failed operation
	 */
	async retryOperation(
		id: string
	): Promise<{ success: boolean; action: string; schema?: CustomClaimSchema }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/custom-claims/${id}/retry`, {
			method: 'POST',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to retry operation');
		}

		return response.json();
	}
};

// =============================================================================
// Utility Functions
// =============================================================================

/** Get human-readable field type label */
export function getFieldTypeLabel(type: FieldType): string {
	const labels: Record<FieldType, string> = {
		string: 'String',
		number: 'Number',
		boolean: 'Boolean',
		date: 'Date',
		enum: 'Enum'
	};
	return labels[type] || type;
}

/** Get operation status display info */
export function getOperationStatusInfo(status: OperationStatus): {
	label: string;
	color: string;
} {
	switch (status) {
		case 'active':
			return { label: 'Active', color: 'green' };
		case 'renaming':
			return { label: 'Renaming...', color: 'yellow' };
		case 'deleting':
			return { label: 'Deleting...', color: 'yellow' };
		case 'error':
			return { label: 'Error', color: 'red' };
		default:
			return { label: status, color: 'gray' };
	}
}

/** Parse validation_rules JSON safely */
export function parseValidationRules(json: string | null): ValidationRules | null {
	if (!json) return null;
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}

/** Parse required_scopes JSON safely */
export function parseRequiredScopes(json: string | null): string[] | null {
	if (!json) return null;
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}

/** Format timestamp to readable date */
export function formatTimestamp(ts: number): string {
	return new Date(ts * 1000).toLocaleString();
}
