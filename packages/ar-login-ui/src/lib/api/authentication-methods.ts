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
	digits?: number;
	steps: string[];
}

export interface TotpMethod {
	enabled: boolean;
	loginEnabled?: boolean;
	signupEnabled?: boolean;
	reauthEnabled?: boolean;
	accountLinkEnabled?: boolean;
	preset: 'compatible' | 'strong';
	algorithm: 'SHA1' | 'SHA256';
	digits: number;
	period: number;
	window: number;
	defaultAcr: string;
	requirement: {
		mode: 'optional' | 'required';
	};
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

export type LoginUITextField =
	| 'tagline'
	| 'brandPanelTitle'
	| 'brandPanelText'
	| 'footerText'
	| 'loginTitle'
	| 'registrationTitle'
	| 'accountTitle';

export type LoginUITextLocalizations = Record<string, Partial<Record<LoginUITextField, string>>>;

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
	totp: TotpMethod;
	directoryPassword: DirectoryPasswordMethod;
	humanVerification: HumanVerificationMethod;
	external: ExternalMethod;
}

export interface LoginUIConfig {
	theme: string;
	variant: string;
	themeTemplate?: 'classic' | 'meridian' | 'split-brand-panel' | 'fullbleed-glass';
	branding: {
		logoUrl: string | null;
		faviconUrl?: string | null;
		brandName: string;
	};
	pageTemplate?: {
		layout: 'centered_card' | 'split_panel' | 'fullbleed_card';
		fontFamily: 'system' | 'rounded' | 'serif' | 'mono';
		fontScale: 'compact' | 'comfortable' | 'spacious';
		backgroundColor: string;
		accentColor?: string;
		titleColor?: string;
		textColor?: string;
		copyColor?: string;
		logoDisplay: 'auto' | 'image' | 'text' | 'hidden';
		logoLayout?: 'stack' | 'row';
		headerEnabled: boolean;
		subtitleEnabled: boolean;
		footerEnabled: boolean;
		poweredByEnabled: boolean;
		authSwitchLinkEnabled: boolean;
		topbarPosition?:
			| 'below_card'
			| 'in_card'
			| 'top_right'
			| 'bottom_left'
			| 'bottom_center'
			| 'bottom_right'
			| 'hidden';
		themeToggleEnabled?: boolean;
		languageSelectEnabled?: boolean;
		languageSwitcherPosition: 'below_card' | 'top_right' | 'hidden';
		headerStyle?: 'center' | 'bar';
		footerStyle?: 'simple' | 'bar';
		splitFrame?: 'full' | 'card';
		splitPanelSide?: 'left' | 'right';
		splitPanelWidth?: 'narrow' | 'wide';
		splitBackgroundMode?: 'shared' | 'brand' | 'panel';
		loginPanelBackgroundColor?: string;
		loginPanelBackgroundGradientColor?: string;
		loginPanelBackgroundOpacity?: number;
		brandContentMode?: 'logo_copy' | 'logo' | 'none';
		brandPosition?: 'top' | 'center' | 'bottom';
		brandAlign?: 'left' | 'center' | 'right';
		brandPanelTitle: string | null;
		brandPanelText: string | null;
	};
	appearance?: {
		backgroundImageUrl: string | null;
		loginPanelBackgroundImageUrl?: string | null;
		thumbnailUrl?: string | null;
		customCss: string | null;
		headerText: string | null;
		textLocalizations?: LoginUITextLocalizations;
		footerText: string | null;
		footerLinks: Array<{ label: string; url: string }>;
		customBlocks: Array<{
			position: string;
			type: string;
			content: string;
			url?: string;
			alt?: string;
		}>;
	};
	supportedLocales: string[];
	defaultLocale: string;
	primaryLocales?: string[];
	showEnglishLanguageNames?: boolean;
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

const cachedResponses = new Map<
	string,
	{ response: AuthenticationMethodsResponse; expiry: number }
>();
const inFlightRequests = new Map<
	string,
	Promise<{
		data?: AuthenticationMethodsResponse;
		error?: AuthenticationMethodsError;
	}>
>();
const inFlightRequestTokens = new Map<string, symbol>();
let cachedResponse: AuthenticationMethodsResponse | null = null;

/**
 * Fetch available authentication methods from the backend.
 * Results are cached per the server-provided TTL.
 */
export interface AuthenticationMethodsFetchOptions {
	forceRefresh?: boolean;
}

export async function fetchAuthenticationMethods(
	options: AuthenticationMethodsFetchOptions = {}
): Promise<{
	data?: AuthenticationMethodsResponse;
	error?: AuthenticationMethodsError;
}> {
	return fetchAuthenticationMethodsForClient(null, options);
}

export async function fetchAuthenticationMethodsForClient(
	clientId?: string | null,
	options: AuthenticationMethodsFetchOptions = {}
): Promise<{
	data?: AuthenticationMethodsResponse;
	error?: AuthenticationMethodsError;
}> {
	const cacheKey = clientId?.trim() || '__tenant__';
	const cached = cachedResponses.get(cacheKey);
	if (!options.forceRefresh && cached && Date.now() < cached.expiry) {
		cachedResponse = cached.response;
		return { data: cached.response };
	}
	const activeRequest = inFlightRequests.get(cacheKey);
	if (!options.forceRefresh && activeRequest) {
		return activeRequest;
	}

	const requestToken = Symbol(cacheKey);
	const request = (async () => {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 15000);

		try {
			const path = clientId?.trim()
				? `/api/auth/authentication-methods?client_id=${encodeURIComponent(clientId.trim())}`
				: '/api/auth/authentication-methods';
			const response = await authrimFetch(path, {
				method: 'GET',
				headers: buildDiagnosticHeaders({ Accept: 'application/json' }),
				signal: controller.signal,
				...(options.forceRefresh ? { cache: 'reload' as const } : {})
			});

			const data = await response.json();

			if (!response.ok) {
				return { error: data as AuthenticationMethodsError };
			}

			const result = data as AuthenticationMethodsResponse;

			cachedResponse = result;
			const expiry = Date.now() + (result.meta.cacheTTL || 180) * 1000;
			cachedResponses.set(cacheKey, { response: result, expiry });

			return { data: result };
		} catch {
			// Stale-while-revalidate: return stale cache on network error
			if (cached?.response) {
				return { data: cached.response };
			}
			if (cacheKey === '__tenant__' && cachedResponse) {
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
			if (inFlightRequestTokens.get(cacheKey) === requestToken) {
				inFlightRequests.delete(cacheKey);
				inFlightRequestTokens.delete(cacheKey);
			}
		}
	})();

	inFlightRequests.set(cacheKey, request);
	inFlightRequestTokens.set(cacheKey, requestToken);
	return request;
}

/**
 * Clear the cached authentication methods response
 */
export function clearAuthenticationMethodsCache(): void {
	cachedResponse = null;
	cachedResponses.clear();
	inFlightRequests.clear();
	inFlightRequestTokens.clear();
}
