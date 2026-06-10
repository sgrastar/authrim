/**
 * Login Methods API Client
 *
 * Fetches available login methods and UI configuration from the backend.
 * Used to dynamically render authentication options on the login page.
 */

import { buildDiagnosticHeaders } from '$lib/api/client';
import { authrimFetch } from '$lib/authrim/fetch';

// =============================================================================
// Types
// =============================================================================

export interface PasskeyMethod {
	enabled: boolean;
	loginEnabled?: boolean;
	signupEnabled?: boolean;
	reauthEnabled?: boolean;
	accountLinkEnabled?: boolean;
	capabilities: string[];
}

export interface EmailCodeMethod {
	enabled: boolean;
	loginEnabled?: boolean;
	signupEnabled?: boolean;
	reauthEnabled?: boolean;
	accountLinkEnabled?: boolean;
	steps: string[];
}

export interface DirectoryPasswordMethod {
	enabled: boolean;
	label: string;
	steps: string[];
}

export type ExternalProviderType = 'oidc' | 'oauth2' | 'saml' | 'vc' | 'custom';
export type ExternalProviderStartMode = 'oauth_redirect' | 'saml_sp' | 'direct';

export interface ExternalProvider {
	id: string;
	name: string;
	type: ExternalProviderType;
	startMode: ExternalProviderStartMode;
	enabled?: boolean;
	loginEnabled?: boolean;
	signupEnabled?: boolean;
	slug?: string;
	iconUrl?: string;
	iconName?: string;
	buttonColor?: string;
	buttonColorDark?: string;
	buttonText?: string;
	startUrl?: string;
}

export interface ExternalMethod {
	enabled: boolean;
	providers: ExternalProvider[];
}

export interface LoginMethods {
	passkey: PasskeyMethod;
	emailCode: EmailCodeMethod;
	directoryPassword: DirectoryPasswordMethod;
	external: ExternalMethod;
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
