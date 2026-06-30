/**
 * Authentication Methods API Client
 *
 * Fetches available authentication methods and UI configuration from the backend.
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
export type ExternalProviderStartMode = 'oauth_redirect' | 'saml_sp';

export interface ExternalProvider {
	id: string;
	name: string;
	type: ExternalProviderType;
	startMode: ExternalProviderStartMode;
	enabled?: boolean;
	loginEnabled?: boolean;
	signupEnabled?: boolean;
	reauthEnabled?: boolean;
	accountLinkEnabled?: boolean;
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

export type HumanVerificationFailurePolicy = 'fail_closed' | 'fail_open';

export interface HumanVerificationMethod {
	enabled: boolean;
	provider: string;
	siteKey: string | null;
	loginEnabled: boolean;
	signupEnabled: boolean;
	reauthEnabled: boolean;
	failurePolicy: HumanVerificationFailurePolicy;
	widget: {
		actionPrefix: string;
		theme: 'auto';
		size: 'flexible';
		mode: 'managed' | 'checkbox' | 'invisible' | 'score';
	};
}

export interface AuthenticationMethods {
	passkey: PasskeyMethod;
	emailCode: EmailCodeMethod;
	directoryPassword: DirectoryPasswordMethod;
	humanVerification: HumanVerificationMethod;
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
	selfService?: {
		accountPageEnabled: boolean;
		accountPagePath: string;
	};
}

export interface AuthenticationMethodsMeta {
	cacheTTL: number;
	revision: string;
}

export interface AuthenticationMethodsResponse {
	methods: AuthenticationMethods;
	ui: LoginUIConfig;
	meta: AuthenticationMethodsMeta;
}

export interface AuthenticationMethodsError {
	error: {
		code: string;
		message: string;
	};
}

// =============================================================================
// API Client
// =============================================================================

let cachedResponse: AuthenticationMethodsResponse | null = null;
let cacheExpiry = 0;
let inFlightRequest: Promise<{
	data?: AuthenticationMethodsResponse;
	error?: AuthenticationMethodsError;
}> | null = null;

/**
 * Fetch available authentication methods from the backend.
 * Results are cached per the server-provided TTL.
 */
export async function fetchAuthenticationMethods(): Promise<{
	data?: AuthenticationMethodsResponse;
	error?: AuthenticationMethodsError;
}> {
	if (cachedResponse && Date.now() < cacheExpiry) {
		return { data: cachedResponse };
	}
	if (inFlightRequest) {
		return inFlightRequest;
	}

	inFlightRequest = (async () => {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 15000);

		try {
			const response = await authrimFetch('/api/auth/authentication-methods', {
				method: 'GET',
				headers: buildDiagnosticHeaders({ Accept: 'application/json' }),
				signal: controller.signal
			});

			const data = await response.json();

			if (!response.ok) {
				return { error: data as AuthenticationMethodsError };
			}

			const result = data as AuthenticationMethodsResponse;

			cachedResponse = result;
			cacheExpiry = Date.now() + (result.meta.cacheTTL || 180) * 1000;

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
						message: 'Failed to fetch authentication methods'
					}
				}
			};
		} finally {
			clearTimeout(timeoutId);
			inFlightRequest = null;
		}
	})();

	return inFlightRequest;
}

/**
 * Clear the cached authentication methods response
 */
export function clearAuthenticationMethodsCache(): void {
	cachedResponse = null;
	cacheExpiry = 0;
}
