/**
 * Login Methods API Client
 *
 * Fetches available login methods and UI configuration from the backend.
 * Used to dynamically render authentication options on the login page.
 */

import { buildDiagnosticHeaders, API_BASE_URL } from '$lib/api/client';
import { authrimFetch } from '$lib/authrim/fetch';

// =============================================================================
// Types
// =============================================================================

export interface PasskeyMethod {
	enabled: boolean;
	capabilities: string[];
}

export interface EmailCodeMethod {
	enabled: boolean;
	steps: string[];
}

export interface SocialProvider {
	id: string;
	name: string;
	slug?: string;
	iconUrl?: string;
	buttonColor?: string;
	buttonColorDark?: string;
	buttonText?: string;
}

export interface SocialMethod {
	enabled: boolean;
	providers: SocialProvider[];
}

export interface LoginMethods {
	passkey: PasskeyMethod;
	emailCode: EmailCodeMethod;
	social: SocialMethod;
}

export interface LoginUIConfig {
	theme: string;
	variant: string;
	branding: {
		logoUrl: string | null;
		brandName: string;
	};
	supportedLocales: string[];
}

export interface LoginMethodsMeta {
	cacheTTL: number;
	revision: string;
}

export interface LoginMethodsResponse {
	methods: LoginMethods;
	ui: LoginUIConfig;
	meta: LoginMethodsMeta;
}

export interface LoginMethodsError {
	error: {
		code: string;
		message: string;
	};
}

// =============================================================================
// API Client
// =============================================================================

let cachedResponse: LoginMethodsResponse | null = null;
let cacheExpiry = 0;

/**
 * Fetch available login methods from the backend.
 * Results are cached per the server-provided TTL.
 */
export async function fetchLoginMethods(): Promise<{
	data?: LoginMethodsResponse;
	error?: LoginMethodsError;
}> {
	// Return cached response if still valid
	if (cachedResponse && Date.now() < cacheExpiry) {
		return { data: cachedResponse };
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 15000);

	try {
		const response = await authrimFetch('/api/auth/login-methods', {
			baseUrl: API_BASE_URL,
			method: 'GET',
			headers: buildDiagnosticHeaders({ Accept: 'application/json' }),
			signal: controller.signal
		});

		const data = await response.json();

		if (!response.ok) {
			return { error: data as LoginMethodsError };
		}

		const result = data as LoginMethodsResponse;

		// Cache the response
		cachedResponse = result;
		cacheExpiry = Date.now() + (result.meta.cacheTTL || 300) * 1000;

		return { data: result };
	} catch {
		// Stale-while-revalidate: return stale cache on network error
		if (cachedResponse) {
			return { data: cachedResponse };
		}
		return {
			error: {
				error: {
					code: 'NETWORK_ERROR',
					message: 'Failed to fetch login methods'
				}
			}
		};
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Clear the cached login methods response
 */
export function clearLoginMethodsCache(): void {
	cachedResponse = null;
	cacheExpiry = 0;
}
