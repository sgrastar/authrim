export const LOGIN_UI_SESSION_STORAGE_KEYS = {
	diagnosticSessionId: 'authrim:loginui:diagnostic:session_id',
	directEmailCodeStatePrefix: 'authrim:loginui:direct:email_code:',
	externalProviderId: 'authrim:loginui:external:provider_id',
	externalReturnUrl: 'authrim:loginui:external:return_url',
	signupCustomFields: 'authrim:loginui:signup:custom_fields'
} as const;

export const LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS = {
	diagnosticSessionId: 'authrim_diagnostic_session_id',
	directEmailCodeStatePrefix: 'authrim_loginui_direct_email_code:',
	externalProviderId: 'oauth_provider_id',
	externalReturnUrl: 'oauth_return_url',
	pkceCodeVerifier: 'pkce_code_verifier',
	signupCustomFields: 'signup_custom_fields'
} as const;

export function setLoginUiSessionItem(key: string, value: string): void {
	sessionStorage.setItem(key, value);
}

export function getLoginUiSessionItem(key: string): string | null {
	return sessionStorage.getItem(key);
}

export function consumeLoginUiSessionItem(key: string, legacyKeys: string[] = []): string | null {
	const value = sessionStorage.getItem(key);
	sessionStorage.removeItem(key);

	for (const legacyKey of legacyKeys) {
		const legacyValue = sessionStorage.getItem(legacyKey);
		sessionStorage.removeItem(legacyKey);
		if (value === null && legacyValue !== null) {
			return legacyValue;
		}
	}

	return value;
}

export function removeLoginUiSessionItems(keys: string[]): void {
	for (const key of keys) {
		sessionStorage.removeItem(key);
	}
}
