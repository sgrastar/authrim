/**
 * Authentication Store
 * Manages user authentication state across the application
 */

import { writable, derived } from 'svelte/store';
import { browser } from '$app/environment';
import { API_BASE_URL, buildDiagnosticHeaders } from '$lib/api/client';

export interface AuthUser {
	userId: string;
	email: string;
	name?: string;
}

interface AuthState {
	isAuthenticated: boolean;
	user: AuthUser | null;
	sessionId: string | null;
}

/**
 * Fetch user info from /api/sessions/status endpoint using session cookie
 * Returns null if not authenticated or fetch fails
 */
async function fetchUserInfoFromSession(): Promise<{
	sub: string;
	email?: string;
	name?: string;
} | null> {
	try {
		const url = `${API_BASE_URL}/api/sessions/status`;
		const response = await fetch(url, {
			credentials: 'include', // Send session cookie
			headers: buildDiagnosticHeaders()
		});
		if (response.ok) {
			const data = await response.json();
			if (data.active && data.user_id) {
				return {
					sub: data.user_id,
					email: data.email,
					name: data.name
				};
			}
		}
	} catch {
		// Silently fail - user may not be authenticated
	}
	return null;
}

function createAuthStore() {
	let currentState: AuthState = {
		isAuthenticated: false,
		user: null,
		sessionId: null
	};

	const { subscribe, set } = writable<AuthState>(currentState);
	const setState = (nextState: AuthState) => {
		currentState = nextState;
		set(nextState);
	};

	return {
		subscribe,

		/**
		 * Login - keep session and user info in memory only.
		 */
		login: (sessionId: string, user: AuthUser) => {
			setState({
				isAuthenticated: true,
				sessionId,
				user
			});
		},

		/**
		 * Logout - clear session and redirect
		 */
		logout: async () => {
			if (browser) {
				// Call logout endpoint to clear server-side session and cookie
				try {
					await fetch(`${API_BASE_URL}/logout`, {
						method: 'GET',
						credentials: 'include',
						headers: buildDiagnosticHeaders()
					});
				} catch {
					// Silently ignore logout API errors
				}
			}

			setState({
				isAuthenticated: false,
				sessionId: null,
				user: null
			});
		},

		/**
		 * Check if user is authenticated
		 */
		checkAuth: (): boolean => {
			if (!browser) return false;
			return currentState.isAuthenticated;
		},

		/**
		 * Refresh auth state from in-memory state.
		 */
		refresh: () => {
			if (!browser) return;
			setState(currentState);
		},

		/**
		 * Check session cookie and fetch user info from /userinfo if authenticated
		 * This is useful when user logged in via OIDC flow (op-auth) without going through UI login
		 */
		refreshFromSession: async () => {
			if (!browser) return;

			// Try to fetch user info using session cookie
			const userInfo = await fetchUserInfoFromSession();

			if (userInfo) {
				// User is authenticated via session cookie
				const userId = userInfo.sub;
				const userEmail = userInfo.email || '';
				const userName = userInfo.name;

				setState({
					isAuthenticated: true,
					sessionId: null,
					user: {
						userId,
						email: userEmail,
						name: userName || undefined
					}
				});
			} else {
				setState({
					isAuthenticated: false,
					sessionId: null,
					user: null
				});
			}
		}
	};
}

export const auth = createAuthStore();

// Derived stores for convenience
export const isAuthenticated = derived(auth, ($auth) => $auth.isAuthenticated);
export const currentUser = derived(auth, ($auth) => $auth.user);
