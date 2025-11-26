/**
 * API Client for Authrim
 * Handles communication with the backend API
 */

import { browser } from '$app/environment';

// Type definitions
interface User {
	id: string;
	email: string;
	email_verified: boolean;
	name?: string | null;
	picture?: string | null;
	phone_number?: string | null;
	phone_number_verified?: boolean;
	given_name?: string | null;
	family_name?: string | null;
	created_at: number;
	updated_at: number;
	last_login_at?: number;
	[key: string]: unknown;
}

interface Passkey {
	id: string;
	user_id: string;
	credential_id: string;
	device_name?: string;
	created_at: number;
	last_used_at?: number;
}

interface Client {
	client_id: string;
	client_name: string;
	redirect_uris: string[];
	grant_types: string[];
	response_types: string[];
	scope?: string;
	logo_uri?: string | null;
	client_uri?: string | null;
	policy_uri?: string | null;
	tos_uri?: string | null;
	is_trusted?: boolean;
	skip_consent?: boolean;
	allow_claims_without_scope?: boolean;
	created_at: number;
	updated_at: number;
}

interface Activity {
	id: string;
	type: string;
	timestamp: number;
	[key: string]: unknown;
}

interface AuditLogEntry {
	id: string;
	userId?: string;
	user?: {
		id: string;
		email: string;
		name?: string;
		picture?: string;
	};
	action: string;
	resourceType?: string;
	resourceId?: string;
	ipAddress?: string;
	userAgent?: string;
	metadata?: Record<string, unknown>;
	createdAt: string;
}

interface CustomField {
	key: string;
	value: unknown;
}

interface ScimToken {
	tokenHash: string;
	description: string;
	createdAt: string;
	expiresAt: string | null;
	enabled: boolean;
}

interface APIError {
	error: string;
	error_description: string;
}

// Get API base URL from environment variable or use default
// In production (Cloudflare Pages), set PUBLIC_API_BASE_URL in .env file
// In development, it defaults to localhost:8786
// If browser is available, use window.location.origin, otherwise use localhost
function getApiBaseUrl(): string {
	// Try to get from environment variable (if set during build)
	try {
		// Use dynamic import to avoid build-time errors
		const envUrl = import.meta.env.PUBLIC_API_BASE_URL;
		if (envUrl) return envUrl;
	} catch {
		// Environment variable not set
	}

	// In browser, use current origin as fallback
	if (browser && typeof window !== 'undefined') {
		return window.location.origin;
	}

	// Default for SSR/build time
	return 'http://localhost:8786';
}

export const API_BASE_URL = getApiBaseUrl();

/**
 * Generic fetch wrapper with error handling
 */
async function apiFetch<T>(
	endpoint: string,
	options: RequestInit = {}
): Promise<{ data?: T; error?: APIError }> {
	try {
		const url = `${API_BASE_URL}${endpoint}`;
		const response = await fetch(url, {
			...options,
			headers: {
				'Content-Type': 'application/json',
				...options.headers
			}
		});

		const data = await response.json();

		if (!response.ok) {
			return { error: data };
		}

		return { data };
	} catch (error) {
		console.error('API fetch error:', error);
		return {
			error: {
				error: 'network_error',
				error_description: error instanceof Error ? error.message : 'Network error occurred'
			}
		};
	}
}

/**
 * Admin API - User Management
 */
export const adminUsersAPI = {
	/**
	 * List users with pagination and search
	 */
	async list(
		params: {
			page?: number;
			limit?: number;
			search?: string;
			verified?: 'true' | 'false';
		} = {}
	) {
		const queryParams = new URLSearchParams();
		if (params.page) queryParams.set('page', params.page.toString());
		if (params.limit) queryParams.set('limit', params.limit.toString());
		if (params.search) queryParams.set('search', params.search);
		if (params.verified) queryParams.set('verified', params.verified);

		const query = queryParams.toString();
		return apiFetch<{
			users: User[];
			pagination: {
				page: number;
				limit: number;
				total: number;
				totalPages: number;
				hasNext: boolean;
				hasPrev: boolean;
			};
		}>(`/api/admin/users${query ? '?' + query : ''}`);
	},

	/**
	 * Get user details by ID
	 */
	async get(userId: string) {
		return apiFetch<{
			user: User;
			passkeys: Passkey[];
			customFields: CustomField[];
		}>(`/api/admin/users/${userId}`);
	},

	/**
	 * Create a new user
	 */
	async create(userData: {
		email: string;
		name?: string;
		email_verified?: boolean;
		phone_number?: string;
		phone_number_verified?: boolean;
		[key: string]: unknown;
	}) {
		return apiFetch<{ user: User }>('/api/admin/users', {
			method: 'POST',
			body: JSON.stringify(userData)
		});
	},

	/**
	 * Update user
	 */
	async update(
		userId: string,
		updates: {
			name?: string;
			email_verified?: boolean;
			phone_number?: string;
			phone_number_verified?: boolean;
			picture?: string;
		}
	) {
		return apiFetch<{ user: User }>(`/api/admin/users/${userId}`, {
			method: 'PUT',
			body: JSON.stringify(updates)
		});
	},

	/**
	 * Delete user
	 */
	async delete(userId: string) {
		return apiFetch<{ success: boolean; message: string }>(`/api/admin/users/${userId}`, {
			method: 'DELETE'
		});
	}
};

/**
 * Admin API - Client Management
 */
export const adminClientsAPI = {
	/**
	 * List OAuth clients with pagination and search
	 */
	async list(params: { page?: number; limit?: number; search?: string } = {}) {
		const queryParams = new URLSearchParams();
		if (params.page) queryParams.set('page', params.page.toString());
		if (params.limit) queryParams.set('limit', params.limit.toString());
		if (params.search) queryParams.set('search', params.search);

		const query = queryParams.toString();
		return apiFetch<{
			clients: Client[];
			pagination: {
				page: number;
				limit: number;
				total: number;
				totalPages: number;
				hasNext: boolean;
				hasPrev: boolean;
			};
		}>(`/api/admin/clients${query ? '?' + query : ''}`);
	},

	/**
	 * Get client details by ID
	 */
	async get(clientId: string) {
		return apiFetch<{ client: Client }>(`/api/admin/clients/${clientId}`);
	},

	/**
	 * Update client
	 */
	async update(
		clientId: string,
		updates: {
			client_name?: string;
			redirect_uris?: string[];
			grant_types?: string[];
			scope?: string;
			logo_uri?: string | null;
			client_uri?: string | null;
			policy_uri?: string | null;
			tos_uri?: string | null;
			is_trusted?: boolean;
			skip_consent?: boolean;
			allow_claims_without_scope?: boolean;
		}
	) {
		return apiFetch<{ client: Client }>(`/api/admin/clients/${clientId}`, {
			method: 'PUT',
			body: JSON.stringify(updates)
		});
	},

	/**
	 * Delete client
	 */
	async delete(clientId: string) {
		return apiFetch<{ success: boolean; message: string }>(`/api/admin/clients/${clientId}`, {
			method: 'DELETE'
		});
	},

	/**
	 * Bulk delete clients
	 */
	async bulkDelete(clientIds: string[]) {
		return apiFetch<{ success: boolean; deleted: number; requested: number; errors?: string[] }>(
			'/api/admin/clients/bulk',
			{
				method: 'DELETE',
				body: JSON.stringify({ client_ids: clientIds })
			}
		);
	}
};

/**
 * Admin API - Statistics
 */
export const adminStatsAPI = {
	/**
	 * Get admin dashboard statistics
	 */
	async get() {
		return apiFetch<{
			stats: {
				activeUsers: number;
				totalUsers: number;
				registeredClients: number;
				newUsersToday: number;
				loginsToday: number;
			};
			recentActivity: Activity[];
		}>('/api/admin/stats');
	}
};

/**
 * Admin Sessions API
 */
export const adminSessionsAPI = {
	/**
	 * List sessions with pagination
	 */
	async list(
		params: {
			page?: number;
			limit?: number;
			userId?: string;
			active?: 'true' | 'false';
		} = {}
	) {
		const queryParams = new URLSearchParams();
		if (params.page) queryParams.set('page', params.page.toString());
		if (params.limit) queryParams.set('limit', params.limit.toString());
		if (params.userId) queryParams.set('userId', params.userId);
		if (params.active) queryParams.set('active', params.active);

		const query = queryParams.toString();
		return apiFetch<{
			sessions: Array<{
				id: string;
				user_id: string;
				user_email: string;
				user_name?: string;
				created_at: string;
				last_accessed_at: string;
				expires_at: string;
				ip_address?: string;
				user_agent?: string;
				is_active: boolean;
			}>;
			pagination: {
				page: number;
				limit: number;
				total: number;
				totalPages: number;
				hasNext: boolean;
				hasPrev: boolean;
			};
		}>(`/api/admin/sessions${query ? '?' + query : ''}`);
	},

	/**
	 * Get session details by ID
	 */
	async get(sessionId: string) {
		return apiFetch<{
			id: string;
			user_id: string;
			user_email: string;
			user_name?: string;
			created_at: string;
			last_accessed_at: string;
			expires_at: string;
			ip_address?: string;
			user_agent?: string;
			is_active: boolean;
		}>(`/api/admin/sessions/${sessionId}`);
	},

	/**
	 * Revoke a session
	 */
	async revoke(sessionId: string) {
		return apiFetch<{ success: boolean }>(`/api/admin/sessions/${sessionId}`, {
			method: 'DELETE'
		});
	}
};

/**
 * Auth API - Passkey
 */
export const passkeyAPI = {
	/**
	 * Get registration options for Passkey
	 */
	async getRegisterOptions(data: { email: string; name?: string; userId?: string }) {
		return apiFetch<{ options: unknown; userId: string }>('/api/auth/passkey/register/options', {
			method: 'POST',
			body: JSON.stringify(data)
		});
	},

	/**
	 * Verify Passkey registration
	 */
	async verifyRegistration(data: { userId: string; credential: unknown; deviceName?: string }) {
		return apiFetch<{
			verified: boolean;
			passkeyId: string;
			sessionId: string;
			message: string;
			userId: string;
			user: User;
		}>('/api/auth/passkey/register/verify', {
			method: 'POST',
			body: JSON.stringify(data)
		});
	},

	/**
	 * Get authentication options for Passkey login
	 */
	async getLoginOptions(data: { email?: string }) {
		return apiFetch<{ options: unknown; challengeId: string }>('/api/auth/passkey/login/options', {
			method: 'POST',
			body: JSON.stringify(data)
		});
	},

	/**
	 * Verify Passkey authentication
	 */
	async verifyLogin(data: { challengeId: string; credential: unknown }) {
		return apiFetch<{
			verified: boolean;
			sessionId: string;
			userId: string;
			user: User;
		}>('/api/auth/passkey/login/verify', {
			method: 'POST',
			body: JSON.stringify(data)
		});
	}
};

/**
 * Auth API - Email Code (OTP)
 */
export const emailCodeAPI = {
	/**
	 * Send verification code to email
	 */
	async send(data: { email: string; name?: string }) {
		return apiFetch<{ success: boolean; message: string; messageId?: string; code?: string }>(
			'/api/auth/email-code/send',
			{
				method: 'POST',
				body: JSON.stringify(data),
				credentials: 'include'
			}
		);
	},

	/**
	 * Verify email code
	 */
	async verify(data: { code: string; email: string }) {
		return apiFetch<{
			success: boolean;
			sessionId: string;
			userId: string;
			user: User;
		}>('/api/auth/email-code/verify', {
			method: 'POST',
			body: JSON.stringify(data),
			credentials: 'include'
		});
	}
};

/**
 * Admin API - Audit Log
 */
export const adminAuditLogAPI = {
	/**
	 * List audit log entries with filtering and pagination
	 */
	async list(
		params: {
			page?: number;
			limit?: number;
			user_id?: string;
			action?: string;
			resource_type?: string;
			resource_id?: string;
			start_date?: string;
			end_date?: string;
		} = {}
	) {
		const queryParams = new URLSearchParams();
		if (params.page) queryParams.set('page', params.page.toString());
		if (params.limit) queryParams.set('limit', params.limit.toString());
		if (params.user_id) queryParams.set('user_id', params.user_id);
		if (params.action) queryParams.set('action', params.action);
		if (params.resource_type) queryParams.set('resource_type', params.resource_type);
		if (params.resource_id) queryParams.set('resource_id', params.resource_id);
		if (params.start_date) queryParams.set('start_date', params.start_date);
		if (params.end_date) queryParams.set('end_date', params.end_date);

		const query = queryParams.toString();
		return apiFetch<{
			entries: AuditLogEntry[];
			pagination: {
				page: number;
				limit: number;
				total: number;
				totalPages: number;
			};
		}>(`/api/admin/audit-log${query ? '?' + query : ''}`);
	},

	/**
	 * Get audit log entry details by ID
	 */
	async get(entryId: string) {
		return apiFetch<AuditLogEntry>(`/api/admin/audit-log/${entryId}`);
	}
};

/**
 * Admin API - Settings
 */
export const adminSettingsAPI = {
	/**
	 * Get system settings
	 */
	async get() {
		return apiFetch<{
			settings: {
				general: {
					siteName: string;
					logoUrl: string;
					language: string;
					timezone: string;
				};
				appearance: {
					primaryColor: string;
					secondaryColor: string;
					fontFamily: string;
				};
				security: {
					sessionTimeout: number;
					mfaEnforced: boolean;
					passwordMinLength: number;
					passwordRequireSpecialChar: boolean;
				};
				email: {
					emailProvider: 'resend' | 'cloudflare' | 'smtp';
					smtpHost: string;
					smtpPort: number;
					smtpUsername: string;
					smtpPassword: string;
				};
				advanced: {
					accessTokenTtl: number;
					idTokenTtl: number;
					refreshTokenTtl: number;
					passkeyEnabled: boolean;
					magicLinkEnabled: boolean;
				};
				ciba?: {
					enabled: boolean;
					defaultExpiresIn: number;
					minExpiresIn: number;
					maxExpiresIn: number;
					defaultInterval: number;
					minInterval: number;
					maxInterval: number;
					supportedDeliveryModes: string[];
					userCodeEnabled: boolean;
					bindingMessageMaxLength: number;
					notificationsEnabled: boolean;
					notificationProviders?: {
						email?: boolean;
						sms?: boolean;
						push?: boolean;
					};
				};
			};
		}>('/api/admin/settings');
	},

	/**
	 * Update system settings
	 */
	async update(settings: {
		general?: {
			siteName?: string;
			logoUrl?: string;
			language?: string;
			timezone?: string;
		};
		appearance?: {
			primaryColor?: string;
			secondaryColor?: string;
			fontFamily?: string;
		};
		security?: {
			sessionTimeout?: number;
			mfaEnforced?: boolean;
			passwordMinLength?: number;
			passwordRequireSpecialChar?: boolean;
		};
		email?: {
			emailProvider?: 'resend' | 'cloudflare' | 'smtp';
			smtpHost?: string;
			smtpPort?: number;
			smtpUsername?: string;
			smtpPassword?: string;
		};
		advanced?: {
			accessTokenTtl?: number;
			idTokenTtl?: number;
			refreshTokenTtl?: number;
			passkeyEnabled?: boolean;
			magicLinkEnabled?: boolean;
		};
		ciba?: {
			enabled?: boolean;
			defaultExpiresIn?: number;
			minExpiresIn?: number;
			maxExpiresIn?: number;
			defaultInterval?: number;
			minInterval?: number;
			maxInterval?: number;
			supportedDeliveryModes?: string[];
			userCodeEnabled?: boolean;
			bindingMessageMaxLength?: number;
			notificationsEnabled?: boolean;
			notificationProviders?: {
				email?: boolean;
				sms?: boolean;
				push?: boolean;
			};
		};
	}) {
		return apiFetch<{
			success: boolean;
			message: string;
			settings: Record<string, unknown>;
		}>('/api/admin/settings', {
			method: 'PUT',
			body: JSON.stringify({ settings })
		});
	}
};

/**
 * Device Flow API
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 */
export const deviceFlowAPI = {
	/**
	 * Verify device code with user approval
	 */
	async verifyDeviceCode(userCode: string, approve: boolean = true) {
		return apiFetch<{
			success: boolean;
			message?: string;
		}>('/api/device/verify', {
			method: 'POST',
			body: JSON.stringify({
				user_code: userCode,
				approve
			})
		});
	}
};

/**
 * SCIM Token Management API
 * For managing SCIM 2.0 provisioning tokens
 */
export const adminScimTokensAPI = {
	/**
	 * List all SCIM tokens
	 */
	async list() {
		return apiFetch<{
			tokens: ScimToken[];
			total: number;
		}>('/api/admin/scim-tokens');
	},

	/**
	 * Create a new SCIM token
	 */
	async create(description?: string, expiresInDays?: number) {
		return apiFetch<{
			token: string;
			tokenHash: string;
			description: string;
			expiresInDays: number;
			message: string;
		}>('/api/admin/scim-tokens', {
			method: 'POST',
			body: JSON.stringify({
				description,
				expiresInDays
			})
		});
	},

	/**
	 * Revoke a SCIM token
	 */
	async revoke(tokenHash: string) {
		return apiFetch<{
			message: string;
		}>(`/api/admin/scim-tokens/${tokenHash}`, {
			method: 'DELETE'
		});
	}
};
