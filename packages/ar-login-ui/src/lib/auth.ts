/**
 * Authrim Auth Configuration
 *
 * Provides configuration values for the Login UI.
 *
 * SDK integration note:
 * When @authrim/sveltekit SDK is published, this module will be updated to use:
 *   import { createAuthrim } from '@authrim/sveltekit';
 *   export const authrim = createAuthrim({ issuer, clientId });
 * Until then, this module provides the same config values that the SDK would use.
 */

import { browser } from '$app/env';

export interface AuthConfig {
	issuer: string;
	clientId: string;
}

/**
 * Get the issuer URL from environment or current origin.
 * Resolution: PUBLIC_AUTHRIM_ISSUER → PUBLIC_API_BASE_URL → window.origin → localhost
 */
function getIssuer(): string {
	try {
		const envIssuer = import.meta.env.PUBLIC_AUTHRIM_ISSUER;
		if (envIssuer) return envIssuer;
	} catch {
		// Environment variable not set
	}

	try {
		const envUrl = import.meta.env.PUBLIC_API_BASE_URL;
		if (envUrl) return envUrl;
	} catch {
		// Environment variable not set
	}

	if (browser && typeof window !== 'undefined') {
		return window.location.origin;
	}

	return 'http://localhost:8786';
}

/**
 * Get the client ID from environment.
 * Resolution: PUBLIC_LOGIN_UI_CLIENT_ID → 'login-ui'
 */
function getClientId(): string {
	try {
		const envClientId = import.meta.env.PUBLIC_LOGIN_UI_CLIENT_ID;
		if (envClientId) return envClientId;
	} catch {
		// Environment variable not set
	}

	return 'login-ui';
}

/**
 * Get auth configuration for the Login UI.
 * Used by API clients and OAuth flows.
 */
export function getAuthConfig(): AuthConfig {
	return {
		issuer: getIssuer(),
		clientId: getClientId()
	};
}
