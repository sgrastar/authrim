/**
 * Admin Authentication Store (Svelte 5 Runes)
 *
 * Manages admin authentication state using Svelte 5's $state rune.
 * Provides reactive state for authentication status, user info, and loading states.
 */

import { browser } from '$app/environment';
import { adminAuthAPI, AuthError } from '$lib/api/admin-auth';

/**
 * Admin user information
 */
export interface AdminUser {
	userId: string;
	email: string;
	name?: string;
	roles: string[];
}

/**
 * Admin authentication state
 */
interface AdminAuthState {
	isAuthenticated: boolean;
	isLoading: boolean;
	user: AdminUser | null;
	error: string | null;
}

/**
 * Create admin authentication store
 */
function createAdminAuthStore() {
	// Reactive state using Svelte 5 $state rune
	let state = $state<AdminAuthState>({
		isAuthenticated: false,
		isLoading: true,
		user: null,
		error: null
	});

	return {
		/**
		 * Get current state (readonly)
		 */
		get current(): AdminAuthState {
			return state;
		},

		/**
		 * Check if authenticated
		 */
		get isAuthenticated(): boolean {
			return state.isAuthenticated;
		},

		/**
		 * Check if loading
		 */
		get isLoading(): boolean {
			return state.isLoading;
		},

		/**
		 * Get current user
		 */
		get user(): AdminUser | null {
			return state.user;
		},

		/**
		 * Get current error
		 */
		get error(): string | null {
			return state.error;
		},

		/**
		 * Check authentication status by calling /api/admin/sessions/me
		 */
		async checkAuth(): Promise<void> {
			if (!browser) return;

			state.isLoading = true;
			state.error = null;

			try {
				const session = await adminAuthAPI.checkSession();

				if (session) {
					state.isAuthenticated = true;
					state.user = {
						userId: session.user_id,
						email: session.email || '',
						name: session.name,
						roles: session.roles
					};
				} else {
					state.isAuthenticated = false;
					state.user = null;
				}
			} catch (err) {
				state.isAuthenticated = false;
				state.user = null;

				if (err instanceof AuthError && err.code === 'forbidden') {
					state.error = err.message;
				}
			} finally {
				state.isLoading = false;
			}
		},

		/**
		 * Set authenticated state after successful login
		 */
		setAuthenticated(user: AdminUser): void {
			state.isAuthenticated = true;
			state.user = user;
			state.isLoading = false;
			state.error = null;
		},

		/**
		 * Clear authentication state
		 */
		clearAuth(): void {
			state.isAuthenticated = false;
			state.user = null;
			state.error = null;
		},

		/**
		 * Set error message
		 */
		setError(error: string): void {
			state.error = error;
		},

		/**
		 * Clear error message
		 */
		clearError(): void {
			state.error = null;
		},

		/**
		 * Set loading state
		 */
		setLoading(loading: boolean): void {
			state.isLoading = loading;
		}
	};
}

/**
 * Admin authentication store singleton
 */
export const adminAuth = createAdminAuthStore();
