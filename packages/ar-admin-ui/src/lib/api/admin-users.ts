/**
 * Admin Users API Client
 *
 * Provides API calls for user management:
 * - List users with pagination, search, and filtering
 * - Get user details
 * - Create, update, delete users
 * - Suspend, lock users
 */

import { API_BASE_URL, adminFetch } from './admin-request';

function adminUserPath(id: string): string {
	return `${API_BASE_URL}/api/admin/users/${encodeURIComponent(id)}`;
}

export interface PasskeyProvider {
	aaguid: string;
	name: string | null;
	icon_dark: string | null;
	icon_light: string | null;
	known: boolean;
}

/**
 * User entity
 */
export interface User {
	id: string;
	tenant_id: string;
	email: string | null;
	name: string | null;
	given_name: string | null;
	family_name: string | null;
	nickname: string | null;
	preferred_username: string | null;
	picture: string | null;
	phone_number: string | null;
	email_verified: boolean;
	phone_number_verified: boolean;
	user_type: string;
	is_active: boolean;
	pii_partition: string;
	pii_status: string;
	created_at: number;
	updated_at: number;
	last_login_at: number | null;
	status: 'active' | 'inactive' | 'suspended' | 'locked' | 'deleted';
	suspended_at: number | null;
	suspended_until: number | null;
	locked_at: number | null;
	locked_until: number | null;
	passkeys?: Array<{
		id: string;
		device_name: string | null;
		aaguid: string | null;
		provider: PasskeyProvider | null;
		created_at: number;
		last_used_at: number | null;
	}>;
	totp_credentials?: Array<{
		id: string;
		label: string | null;
		algorithm: 'SHA1' | 'SHA256';
		digits: number;
		period: number;
		window: number;
		status: 'pending' | 'active' | 'disabled';
		created_at: number;
		activated_at: number | null;
		last_used_at: number | null;
	}>;
	customFields?: UserCustomField[];
	missing_required_fields?: UserMissingRequiredField[];
}

export interface UserCustomField {
	field_name: string;
	field_value: string;
	field_type: string;
}

export interface UserMissingRequiredField {
	field_key: string;
	label: string;
	field_type: string;
}

export interface AccountSupportExternalReference {
	system: string;
	kind: string;
	reference: string;
}

export interface AccountSupportContextDocument {
	schema_version: 1;
	summary?: string;
	external_references: AccountSupportExternalReference[];
}

export interface AccountSupportContextView {
	context: AccountSupportContextDocument;
	version: number;
	created_by: string | null;
	updated_by: string | null;
	created_at: number | null;
	updated_at: number | null;
}

export interface AccountLegalHold {
	id: string;
	subject_type: 'account';
	account_id: string;
	state: 'active' | 'released' | 'expired';
	reason_code: string;
	case_reference: string | null;
	expires_at: number | null;
	version: number;
	created_by: string;
	created_at: number;
	released_by: string | null;
	released_at: number | null;
	release_reason: string | null;
	updated_at: number;
}

/**
 * Pagination info
 */
export interface OffsetPagination {
	mode?: 'offset';
	page: number;
	limit: number;
	total: number;
	totalPages: number;
	hasNext: boolean;
	hasPrev: boolean;
}

export interface CursorPagination {
	mode: 'cursor' | 'exact';
	limit: number;
	nextCursor: string | null;
	hasNext: boolean;
	cursorReset?: boolean;
}

export type Pagination = OffsetPagination | CursorPagination;

/**
 * User list response
 */
export interface UserListResponse {
	users: User[];
	pagination: Pagination;
}

/**
 * User list parameters
 */
export interface UserListParams {
	page?: number;
	limit?: number;
	search?: string;
	verified?: boolean;
	status?: 'active' | 'suspended' | 'locked';
	cursor?: string;
}

/**
 * Create user input
 */
export interface CreateUserInput {
	email: string;
	name?: string;
	given_name?: string;
	family_name?: string;
	email_verified?: boolean;
}

export type AccountCreationOperationState =
	| 'preparing'
	| 'reserved'
	| 'writing'
	| 'directory_pending'
	| 'succeeded'
	| 'blocked'
	| 'canceled';

export interface AccountCreationOperation {
	operation_id: string;
	state: AccountCreationOperationState;
	user_id?: string;
}

export type IdentifierReplacementOperationState =
	| 'directory_pending'
	| 'authoritative_switch_pending'
	| 'authoritative_switched'
	| 'revocation_pending'
	| 'completed'
	| 'blocked_forward_repair'
	| 'canceled';

const IDENTIFIER_REPLACEMENT_STATES: readonly IdentifierReplacementOperationState[] = [
	'directory_pending',
	'authoritative_switch_pending',
	'authoritative_switched',
	'revocation_pending',
	'completed',
	'blocked_forward_repair',
	'canceled'
];

export interface IdentifierReplacementOperation {
	operation_id: string;
	authority: 'self_service' | 'admin' | 'scim' | 'external_idp';
	state: IdentifierReplacementOperationState;
	attention_required: boolean;
	error_code: string | null;
	created_at: number;
	updated_at: number;
	completed_at: number | null;
}

export type CreateUserResult =
	| { status: 'created'; user: User }
	| {
			status: 'pending';
			operation_id: string;
			state: AccountCreationOperationState;
			status_url: string;
	  };

/**
 * Update user input
 */
export interface UpdateUserInput {
	email?: string;
	name?: string;
	given_name?: string;
	family_name?: string;
	nickname?: string;
	preferred_username?: string;
	phone_number?: string;
	email_verified?: boolean;
	phone_number_verified?: boolean;
	[key: string]: string | boolean | number | null | undefined;
}

/**
 * Admin Users API
 */
export const adminUsersAPI = {
	/**
	 * List users with pagination, search, and filtering
	 * GET /api/admin/users
	 */
	async list(params?: UserListParams): Promise<UserListResponse> {
		const searchParams = new URLSearchParams();

		if (params?.page) searchParams.set('page', String(params.page));
		if (params?.limit) searchParams.set('limit', String(params.limit));
		if (params?.search) searchParams.set('search', params.search);
		if (params?.verified !== undefined) searchParams.set('verified', String(params.verified));
		if (params?.status) searchParams.set('status', params.status);
		if (params?.cursor) searchParams.set('cursor', params.cursor);

		const queryString = searchParams.toString();
		const url = `${API_BASE_URL}/api/admin/users${queryString ? `?${queryString}` : ''}`;

		let response = await adminFetch(url);
		let cursorReset = false;
		if (response.status === 409 && params?.cursor) {
			const error = (await response
				.clone()
				.json()
				.catch(() => null)) as { error?: string } | null;
			if (error?.error === 'cursor_stale') {
				searchParams.delete('cursor');
				const retryQuery = searchParams.toString();
				response = await adminFetch(
					`${API_BASE_URL}/api/admin/users${retryQuery ? `?${retryQuery}` : ''}`
				);
				cursorReset = true;
			}
		}

		if (!response.ok) {
			throw new Error('Failed to fetch users');
		}

		const result = (await response.json()) as UserListResponse;
		if (cursorReset && result.pagination.mode === 'cursor') {
			result.pagination.cursorReset = true;
		}
		return result;
	},

	/**
	 * Get user details
	 * GET /api/admin/users/:id
	 */
	async get(id: string): Promise<User> {
		const response = await adminFetch(adminUserPath(id));

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error('User not found');
			}
			throw new Error('Failed to fetch user');
		}

		const data = (await response.json()) as {
			user: User;
			passkeys?: User['passkeys'];
			totp_credentials?: User['totp_credentials'];
			customFields?: UserCustomField[];
			missing_required_fields?: UserMissingRequiredField[];
		};
		return {
			...data.user,
			passkeys: data.user.passkeys ?? data.passkeys,
			totp_credentials: data.user.totp_credentials ?? data.totp_credentials ?? [],
			customFields: data.user.customFields ?? data.customFields ?? [],
			missing_required_fields:
				data.user.missing_required_fields ?? data.missing_required_fields ?? []
		};
	},

	async resetTotp(id: string): Promise<{ ok: boolean; deleted: number }> {
		const response = await adminFetch(`${adminUserPath(id)}/totp/reset`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify({})
		});
		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to reset TOTP');
		}
		return response.json();
	},

	/**
	 * Create a new user
	 * POST /api/admin/users
	 */
	async create(
		data: CreateUserInput,
		options?: { idempotencyKey?: string }
	): Promise<CreateUserResult> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/users`, {
			method: 'POST',
			includeJsonContentType: true,
			headers: options?.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : undefined,
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to create user');
		}

		const result = await response.json();
		if (response.status === 202) {
			if (
				result.status !== 'pending' ||
				typeof result.operation_id !== 'string' ||
				typeof result.state !== 'string' ||
				typeof result.status_url !== 'string'
			) {
				throw new Error('Invalid pending account creation response');
			}
			return {
				status: 'pending',
				operation_id: result.operation_id,
				state: result.state,
				status_url: result.status_url
			};
		}
		return { status: 'created', user: result.user };
	},

	async getCreationOperation(operationId: string): Promise<AccountCreationOperation> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/users/operations/${encodeURIComponent(operationId)}`
		);
		if (!response.ok) {
			throw new Error('Failed to fetch account creation status');
		}
		const result = (await response.json()) as AccountCreationOperation;
		if (
			result.operation_id !== operationId ||
			typeof result.state !== 'string' ||
			(result.state === 'succeeded' && typeof result.user_id !== 'string')
		) {
			throw new Error('Invalid account creation status response');
		}
		return result;
	},

	async listIdentifierReplacements(id: string): Promise<IdentifierReplacementOperation[]> {
		const response = await adminFetch(`${adminUserPath(id)}/identifier-replacements`);
		if (!response.ok) throw new Error('Failed to fetch identifier operations');
		const result = (await response.json()) as { operations?: unknown };
		if (
			!Array.isArray(result.operations) ||
			result.operations.length > 20 ||
			result.operations.some((entry) => {
				if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
				const operation = entry as Record<string, unknown>;
				return (
					typeof operation.operation_id !== 'string' ||
					!['self_service', 'admin', 'scim', 'external_idp'].includes(
						String(operation.authority)
					) ||
					typeof operation.state !== 'string' ||
					!IDENTIFIER_REPLACEMENT_STATES.includes(
						operation.state as IdentifierReplacementOperationState
					) ||
					typeof operation.attention_required !== 'boolean' ||
					!(operation.error_code === null || typeof operation.error_code === 'string') ||
					typeof operation.created_at !== 'number' ||
					typeof operation.updated_at !== 'number' ||
					!(operation.completed_at === null || typeof operation.completed_at === 'number')
				);
			})
		) {
			throw new Error('Invalid identifier operations response');
		}
		return result.operations as IdentifierReplacementOperation[];
	},

	async resumeIdentifierReplacement(
		id: string,
		operationId: string
	): Promise<{
		operation_id: string;
		state: IdentifierReplacementOperationState;
		attention_required: boolean;
	}> {
		const response = await adminFetch(
			`${adminUserPath(id)}/identifier-replacements/${encodeURIComponent(operationId)}/resume`,
			{ method: 'POST', includeJsonContentType: true, body: JSON.stringify({}) }
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to resume operation');
		}
		const result = (await response.json()) as Record<string, unknown>;
		if (
			result.operation_id !== operationId ||
			typeof result.state !== 'string' ||
			!IDENTIFIER_REPLACEMENT_STATES.includes(
				result.state as IdentifierReplacementOperationState
			) ||
			typeof result.attention_required !== 'boolean' ||
			result.attention_required !== (result.state === 'blocked_forward_repair')
		) {
			throw new Error('Invalid identifier operation response');
		}
		return result as {
			operation_id: string;
			state: IdentifierReplacementOperationState;
			attention_required: boolean;
		};
	},

	async getSupportContext(id: string): Promise<AccountSupportContextView> {
		const response = await adminFetch(`${adminUserPath(id)}/support-context`);
		if (!response.ok) throw new Error('Failed to fetch account support context');
		return response.json();
	},

	async replaceSupportContext(
		id: string,
		input: { expected_version: number; context: AccountSupportContextDocument }
	): Promise<AccountSupportContextView> {
		const response = await adminFetch(`${adminUserPath(id)}/support-context`, {
			method: 'PUT',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to save support context');
		}
		return response.json();
	},

	async listLegalHolds(id: string): Promise<AccountLegalHold[]> {
		const response = await adminFetch(`${adminUserPath(id)}/legal-holds`);
		if (!response.ok) throw new Error('Failed to fetch account legal holds');
		const result = (await response.json()) as { items?: AccountLegalHold[] };
		if (!Array.isArray(result.items)) throw new Error('Invalid account legal hold response');
		return result.items;
	},

	async createLegalHold(
		id: string,
		input: { reason_code: string; case_reference?: string; expires_at?: string }
	): Promise<AccountLegalHold> {
		const response = await adminFetch(`${adminUserPath(id)}/legal-holds`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to create legal hold');
		}
		return response.json();
	},

	async releaseLegalHold(
		id: string,
		holdId: string,
		input: { expected_version: number; reason_code: string }
	): Promise<AccountLegalHold> {
		const response = await adminFetch(
			`${adminUserPath(id)}/legal-holds/${encodeURIComponent(holdId)}/release`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify(input)
			}
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to release legal hold');
		}
		return response.json();
	},

	/**
	 * Update a user
	 * PUT /api/admin/users/:id
	 */
	async update(id: string, data: UpdateUserInput): Promise<User> {
		const response = await adminFetch(adminUserPath(id), {
			method: 'PUT',
			includeJsonContentType: true,
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to update user');
		}

		const result = await response.json();
		return result.user;
	},

	/**
	 * Delete a user (soft delete)
	 * DELETE /api/admin/users/:id
	 */
	async delete(id: string): Promise<void> {
		const response = await adminFetch(adminUserPath(id), {
			method: 'DELETE'
		});

		if (!response.ok) {
			throw new Error('Failed to delete user');
		}
	},

	/**
	 * Suspend a user
	 * POST /api/admin/users/:id/suspend
	 */
	async suspend(
		id: string,
		reasonCode: string = 'admin_action',
		options?: { durationHours?: number; reasonDetail?: string }
	): Promise<void> {
		const response = await adminFetch(`${adminUserPath(id)}/suspend`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify({
				reason_code: reasonCode,
				...(options?.durationHours && { duration_hours: options.durationHours }),
				...(options?.reasonDetail && { reason_detail: options.reasonDetail })
			})
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to suspend user');
		}
	},

	/**
	 * Lock a user account
	 * POST /api/admin/users/:id/lock
	 */
	async lock(
		id: string,
		reasonCode: string = 'admin_action',
		options?: { unlockAt?: string; reasonDetail?: string }
	): Promise<void> {
		const response = await adminFetch(`${adminUserPath(id)}/lock`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify({
				reason_code: reasonCode,
				...(options?.unlockAt && { unlock_at: options.unlockAt }),
				...(options?.reasonDetail && { reason_detail: options.reasonDetail })
			})
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to lock user');
		}
	},

	/**
	 * Activate (restore) a suspended or locked user
	 * POST /api/admin/users/:id/activate
	 */
	async activate(
		id: string,
		reasonCode: string = 'admin_action',
		options?: { reasonDetail?: string }
	): Promise<{ user_id: string; status: string; previous_status: string; effective_at: string }> {
		const response = await adminFetch(`${adminUserPath(id)}/activate`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify({
				reason_code: reasonCode,
				...(options?.reasonDetail && { reason_detail: options.reasonDetail })
			})
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to activate user');
		}

		return response.json();
	}
};
