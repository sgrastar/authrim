/**
 * Authentication Store
 * Manages user authentication state across the application
 */

import { writable, derived } from 'svelte/store';
import { browser } from '$app/environment';

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
		const response = await fetch('/api/sessions/status', {
			credentials: 'include' // Send session cookie
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
	const initialState: AuthState = {
		isAuthenticated: false,
		user: null,
		sessionId: null
	};

	const { subscribe, set } = writable<AuthState>(initialState);

	// Initialize from localStorage on browser
	if (browser) {
		const sessionId = localStorage.getItem('sessionId');
		const userId = localStorage.getItem('userId');
		const userEmail = localStorage.getItem('userEmail');
		const userName = localStorage.getItem('userName');

		if (sessionId && userId) {
			set({
				isAuthenticated: true,
				sessionId,
				user: {
					userId,
					email: userEmail || '',
					name: userName || undefined
				}
			});
		}
	}

	return {
		subscribe,

		/**
		 * Login - store session and user info
		 */
		login: (sessionId: string, user: AuthUser) => {
			if (browser) {
				localStorage.setItem('sessionId', sessionId);
				localStorage.setItem('userId', user.userId);
				localStorage.setItem('userEmail', user.email);
				if (user.name) {
					localStorage.setItem('userName', user.name);
				}
			}

			set({
				isAuthenticated: true,
				sessionId,
				user
			});
		},

		/**
		 * Logout - clear session and redirect
		 */
		logout: () => {
			if (browser) {
				localStorage.removeItem('sessionId');
				localStorage.removeItem('userId');
				localStorage.removeItem('userEmail');
				localStorage.removeItem('userName');
			}

			set({
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
			const sessionId = localStorage.getItem('sessionId');
			const userId = localStorage.getItem('userId');
			return !!(sessionId && userId);
		},

		/**
		 * Refresh auth state from localStorage
		 */
		refresh: () => {
			if (!browser) return;

			const sessionId = localStorage.getItem('sessionId');
			const userId = localStorage.getItem('userId');
			const userEmail = localStorage.getItem('userEmail');
			const userName = localStorage.getItem('userName');

			if (sessionId && userId) {
				set({
					isAuthenticated: true,
					sessionId,
					user: {
						userId,
						email: userEmail || '',
						name: userName || undefined
					}
				});
			} else {
				set({
					isAuthenticated: false,
					sessionId: null,
					user: null
				});
			}
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
				const sessionId = 'session-from-cookie'; // Placeholder - actual session ID is in cookie
				const userId = userInfo.sub;
				const userEmail = userInfo.email || '';
				const userName = userInfo.name;

				// Store in localStorage for future use
				localStorage.setItem('sessionId', sessionId);
				localStorage.setItem('userId', userId);
				if (userEmail) localStorage.setItem('userEmail', userEmail);
				if (userName) localStorage.setItem('userName', userName);

				set({
					isAuthenticated: true,
					sessionId,
					user: {
						userId,
						email: userEmail,
						name: userName || undefined
					}
				});
			} else {
				// Not authenticated or session expired
				localStorage.removeItem('sessionId');
				localStorage.removeItem('userId');
				localStorage.removeItem('userEmail');
				localStorage.removeItem('userName');

				set({
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
