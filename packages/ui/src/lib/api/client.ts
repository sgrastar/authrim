/**
 * API Client for Enrai
 * Handles communication with the backend API
 */

import { env } from '$env/dynamic/public';

// Get API base URL from environment variable or default to localhost
// In production (Cloudflare Pages), set PUBLIC_API_BASE_URL to your deployed router URL
// In development, it defaults to localhost:8786
export const API_BASE_URL =
	typeof window !== 'undefined'
		? env.PUBLIC_API_BASE_URL || 'http://localhost:8786'
		: env.PUBLIC_API_BASE_URL || 'http://localhost:8786';

/**
 * Generic fetch wrapper with error handling
 */
async function apiFetch<T>(
	endpoint: string,
	options: RequestInit = {}
): Promise<{ data?: T; error?: any }> {
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
	async list(params: {
		page?: number;
		limit?: number;
		search?: string;
		verified?: 'true' | 'false';
	} = {}) {
		const queryParams = new URLSearchParams();
		if (params.page) queryParams.set('page', params.page.toString());
		if (params.limit) queryParams.set('limit', params.limit.toString());
		if (params.search) queryParams.set('search', params.search);
		if (params.verified) queryParams.set('verified', params.verified);

		const query = queryParams.toString();
		return apiFetch<{
			users: any[];
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
			user: any;
			passkeys: any[];
			customFields: any[];
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
		[key: string]: any;
	}) {
		return apiFetch<{ user: any }>('/api/admin/users', {
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
		return apiFetch<{ user: any }>(`/api/admin/users/${userId}`, {
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
			clients: any[];
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
		return apiFetch<{ client: any }>(`/api/admin/clients/${clientId}`);
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
			recentActivity: any[];
		}>('/api/admin/stats');
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
		return apiFetch<{ options: any; userId: string }>('/api/auth/passkey/register/options', {
			method: 'POST',
			body: JSON.stringify(data)
		});
	},

	/**
	 * Verify Passkey registration
	 */
	async verifyRegistration(data: { userId: string; credential: any; deviceName?: string }) {
		return apiFetch<{ verified: boolean; passkeyId: string; message: string }>(
			'/api/auth/passkey/register/verify',
			{
				method: 'POST',
				body: JSON.stringify(data)
			}
		);
	},

	/**
	 * Get authentication options for Passkey login
	 */
	async getLoginOptions(data: { email?: string }) {
		return apiFetch<{ options: any; challengeId: string }>('/api/auth/passkey/login/options', {
			method: 'POST',
			body: JSON.stringify(data)
		});
	},

	/**
	 * Verify Passkey authentication
	 */
	async verifyLogin(data: { challengeId: string; credential: any }) {
		return apiFetch<{
			verified: boolean;
			sessionId: string;
			userId: string;
			user: any;
		}>('/api/auth/passkey/login/verify', {
			method: 'POST',
			body: JSON.stringify(data)
		});
	}
};

/**
 * Auth API - Magic Link
 */
export const magicLinkAPI = {
	/**
	 * Send magic link to email
	 */
	async send(data: { email: string; name?: string; redirect_uri?: string }) {
		return apiFetch<{ success: boolean; message: string; messageId?: string; magic_link_url?: string }>(
			'/api/auth/magic-link/send',
			{
				method: 'POST',
				body: JSON.stringify(data)
			}
		);
	},

	/**
	 * Verify magic link token
	 */
	async verify(token: string) {
		return apiFetch<{
			success: boolean;
			sessionId: string;
			userId: string;
			user: any;
		}>(`/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`);
	}
};
