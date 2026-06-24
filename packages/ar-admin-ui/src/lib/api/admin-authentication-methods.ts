import {
	adminSettingsAPI,
	SettingsConflictError,
	type CategorySettings
} from '$lib/api/admin-settings';
import {
	adminExternalProvidersAPI,
	type ExternalIdPProvider
} from '$lib/api/admin-external-providers';
import {
	adminDirectoryConnectorsAPI,
	type DirectoryConnectorsResponse
} from '$lib/api/admin-directory-connectors';
import { adminSAMLAPI, type SAMLProvider } from '$lib/api/admin-saml';

const CATEGORY = 'authentication-methods';
const EXTERNAL_PROVIDERS_KEY = 'authentication-methods.external_providers';
const EXTERNAL_PROVIDER_USAGE_KEY = 'authentication-methods.external_provider_usage';
const PASSKEY_LOGIN_ENABLED_KEY = 'authentication-methods.passkey.login_enabled';
const PASSKEY_SIGNUP_ENABLED_KEY = 'authentication-methods.passkey.signup_enabled';
const PASSKEY_REAUTH_ENABLED_KEY = 'authentication-methods.passkey.reauth_enabled';
const PASSKEY_ACCOUNT_LINK_ENABLED_KEY = 'authentication-methods.passkey.account_link_enabled';
const LEGACY_PASSKEY_ENABLED_KEY = 'authentication-methods.passkey.enabled';
const EMAIL_OTP_LOGIN_ENABLED_KEY = 'authentication-methods.email_otp.login_enabled';
const EMAIL_OTP_SIGNUP_ENABLED_KEY = 'authentication-methods.email_otp.signup_enabled';
const EMAIL_OTP_REAUTH_ENABLED_KEY = 'authentication-methods.email_otp.reauth_enabled';
const EMAIL_OTP_ACCOUNT_LINK_ENABLED_KEY = 'authentication-methods.email_otp.account_link_enabled';
const LEGACY_EMAIL_OTP_ENABLED_KEY = 'authentication-methods.email_otp.enabled';
const HUMAN_VERIFICATION_PROVIDER_KEY = 'authentication-methods.human_verification.provider';
const HUMAN_VERIFICATION_LOGIN_ENABLED_KEY =
	'authentication-methods.human_verification.login_enabled';
const HUMAN_VERIFICATION_SIGNUP_ENABLED_KEY =
	'authentication-methods.human_verification.signup_enabled';
const HUMAN_VERIFICATION_REAUTH_ENABLED_KEY =
	'authentication-methods.human_verification.reauth_enabled';

export const DEFAULT_HUMAN_VERIFICATION_PROVIDER = 'human-verification-cloudflare-turnstile';

export type AuthenticationMethodProviderType = 'oidc' | 'oauth2' | 'saml' | 'vc' | 'custom';
export type AuthenticationMethodProviderStartMode = 'oauth_redirect' | 'saml_sp' | 'direct';

export interface AuthenticationMethodExternalProvider {
	id: string;
	name: string;
	type: AuthenticationMethodProviderType;
	startMode: AuthenticationMethodProviderStartMode;
	startUrl: string;
	enabled: boolean;
	loginEnabled: boolean;
	signupEnabled: boolean;
	slug?: string;
	iconUrl?: string;
	iconName?: string;
	buttonColor?: string;
	buttonText?: string;
}

export interface AuthenticationMethodExternalProviderUsage {
	id: string;
	providerId: string;
	name: string;
	type: 'oidc' | 'oauth2' | 'saml';
	enabled: boolean;
	autoLinkEmail: boolean;
	priority: number;
	loginEnabled: boolean;
	signupEnabled: boolean;
	reauthEnabled: boolean;
	accountLinkEnabled: boolean;
}

export interface AuthenticationMethodBuiltInSettings {
	passkeyLoginEnabled: boolean;
	passkeySignupEnabled: boolean;
	passkeyReauthEnabled: boolean;
	passkeyAccountLinkEnabled: boolean;
	emailOtpLoginEnabled: boolean;
	emailOtpSignupEnabled: boolean;
	emailOtpReauthEnabled: boolean;
	emailOtpAccountLinkEnabled: boolean;
}

export interface AuthenticationMethodHumanVerificationSettings {
	provider: string;
	loginEnabled: boolean;
	signupEnabled: boolean;
	reauthEnabled: boolean;
}

export interface AuthenticationMethodDirectoryPasswordSettings {
	loginEnabled: boolean;
	configured: boolean;
	connectorCount: number;
	defaultConnectorId: string;
	autoProvision: boolean;
	config: DirectoryConnectorsResponse | null;
}

export interface AuthenticationMethodSettingsResponse {
	settings: CategorySettings;
	builtIn: AuthenticationMethodBuiltInSettings;
	directoryPassword: AuthenticationMethodDirectoryPasswordSettings;
	humanVerification: AuthenticationMethodHumanVerificationSettings;
	providers: AuthenticationMethodExternalProvider[];
	externalProviderUsages: AuthenticationMethodExternalProviderUsage[];
}

function parseProviders(value: unknown): AuthenticationMethodExternalProvider[] {
	if (Array.isArray(value)) {
		return value.filter(isProviderLike).map(normalizeProvider);
	}
	if (typeof value !== 'string' || !value.trim()) return [];
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isProviderLike).map(normalizeProvider);
	} catch {
		return [];
	}
}

function isProviderLike(value: unknown): value is Partial<AuthenticationMethodExternalProvider> {
	return typeof value === 'object' && value !== null;
}

function normalizeProvider(
	provider: Partial<AuthenticationMethodExternalProvider>
): AuthenticationMethodExternalProvider {
	const type = normalizeType(provider.type);
	const legacyEnabled = provider.enabled !== false;
	const loginEnabled = parseBoolean(provider.loginEnabled, legacyEnabled);
	const signupEnabled = parseBoolean(provider.signupEnabled, legacyEnabled);
	const enabled = legacyEnabled && (loginEnabled || signupEnabled);
	return {
		id: String(provider.id || ''),
		name: String(provider.name || ''),
		type,
		startMode: normalizeStartMode(provider.startMode, type),
		startUrl: String(provider.startUrl || ''),
		enabled,
		loginEnabled,
		signupEnabled,
		slug: provider.slug ? String(provider.slug) : undefined,
		iconUrl: provider.iconUrl ? String(provider.iconUrl) : undefined,
		iconName: provider.iconName ? String(provider.iconName) : undefined,
		buttonColor: provider.buttonColor ? String(provider.buttonColor) : undefined,
		buttonText: provider.buttonText ? String(provider.buttonText) : undefined
	};
}

function normalizeType(value: unknown): AuthenticationMethodProviderType {
	if (value === 'oidc' || value === 'oauth2' || value === 'saml' || value === 'vc') return value;
	return 'custom';
}

function normalizeStartMode(
	value: unknown,
	type: AuthenticationMethodProviderType
): AuthenticationMethodProviderStartMode {
	if (value === 'oauth_redirect' || value === 'saml_sp' || value === 'direct') return value;
	if (type === 'saml') return 'saml_sp';
	if (type === 'oidc' || type === 'oauth2') return 'oauth_redirect';
	return 'direct';
}

function serializeProviders(providers: AuthenticationMethodExternalProvider[]): string {
	return JSON.stringify(
		providers.map((provider) => ({
			id: provider.id.trim(),
			name: provider.name.trim(),
			type: provider.type,
			startMode: provider.startMode,
			startUrl: provider.startUrl.trim(),
			enabled: provider.enabled,
			loginEnabled: provider.loginEnabled,
			signupEnabled: provider.signupEnabled,
			...(provider.slug?.trim() ? { slug: provider.slug.trim() } : {}),
			...(provider.iconUrl?.trim() ? { iconUrl: provider.iconUrl.trim() } : {}),
			...(provider.iconName?.trim() ? { iconName: provider.iconName.trim() } : {}),
			...(provider.buttonColor?.trim() ? { buttonColor: provider.buttonColor.trim() } : {}),
			...(provider.buttonText?.trim() ? { buttonText: provider.buttonText.trim() } : {})
		}))
	);
}

function parseExternalProviderUsage(
	value: unknown
): Record<string, Partial<AuthenticationMethodExternalProviderUsage>> {
	const rawItems =
		typeof value === 'string'
			? safeParseArray<Partial<AuthenticationMethodExternalProviderUsage>>(value)
			: Array.isArray(value)
				? value
				: [];
	const entries = rawItems
		.filter((item) => typeof item === 'object' && item !== null && typeof item.id === 'string')
		.map((item) => [String(item.id), item] as const);
	return Object.fromEntries(entries);
}

function safeParseArray<T>(value: string): T[] {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function providerAuthenticationMethodId(provider: ExternalIdPProvider): string {
	return provider.slug?.trim() || provider.id;
}

function normalizeSAMLProvider(
	provider: SAMLProvider,
	index: number
): AuthenticationMethodExternalProviderUsage {
	const id = `saml:${provider.id}`;
	return {
		id,
		providerId: provider.id,
		name: provider.name,
		type: 'saml',
		enabled: provider.enabled,
		autoLinkEmail: true,
		priority: index,
		loginEnabled: provider.enabled,
		signupEnabled: provider.enabled,
		reauthEnabled: provider.enabled,
		accountLinkEnabled: provider.enabled
	};
}

function resolveExternalProviderUsages(
	providers: ExternalIdPProvider[],
	samlProviders: SAMLProvider[],
	usageById: Record<string, Partial<AuthenticationMethodExternalProviderUsage>>
): AuthenticationMethodExternalProviderUsage[] {
	const oauthProviders = providers.map((provider) => {
		const id = providerAuthenticationMethodId(provider);
		const saved = usageById[id] ?? usageById[provider.id] ?? {};
		const providerEnabled = provider.enabled !== false;
		const defaultEnabled = providerEnabled;
		const accountLinkAvailable = providerEnabled && provider.autoLinkEmail !== false;
		return {
			id,
			providerId: provider.id,
			name: provider.name,
			type: provider.providerType,
			enabled: providerEnabled,
			autoLinkEmail: provider.autoLinkEmail !== false,
			priority: provider.priority,
			loginEnabled: providerEnabled && parseBoolean(saved.loginEnabled, defaultEnabled),
			signupEnabled: providerEnabled && parseBoolean(saved.signupEnabled, defaultEnabled),
			reauthEnabled: providerEnabled && parseBoolean(saved.reauthEnabled, defaultEnabled),
			accountLinkEnabled:
				accountLinkAvailable && parseBoolean(saved.accountLinkEnabled, accountLinkAvailable)
		};
	});

	const samlIdentityProviders = samlProviders
		.filter((provider) => provider.providerType === 'saml_idp')
		.map((provider, index) => {
			const normalized = normalizeSAMLProvider(provider, providers.length + index);
			const saved = usageById[normalized.id] ?? usageById[normalized.providerId] ?? {};
			const defaultEnabled = normalized.enabled;
			return {
				...normalized,
				loginEnabled: normalized.enabled && parseBoolean(saved.loginEnabled, defaultEnabled),
				signupEnabled: normalized.enabled && parseBoolean(saved.signupEnabled, defaultEnabled),
				reauthEnabled: normalized.enabled && parseBoolean(saved.reauthEnabled, defaultEnabled),
				accountLinkEnabled:
					normalized.enabled &&
					parseBoolean(saved.accountLinkEnabled, normalized.accountLinkEnabled)
			};
		});

	return [...oauthProviders, ...samlIdentityProviders];
}

function serializeExternalProviderUsages(
	providers: AuthenticationMethodExternalProviderUsage[]
): string {
	return JSON.stringify(
		providers.map((provider) => ({
			id: provider.id,
			providerId: provider.providerId,
			loginEnabled: provider.enabled && provider.loginEnabled,
			signupEnabled: provider.enabled && provider.signupEnabled,
			reauthEnabled: provider.enabled && provider.reauthEnabled,
			accountLinkEnabled: provider.enabled && provider.autoLinkEmail && provider.accountLinkEnabled
		}))
	);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		if (normalized === 'true') return true;
		if (normalized === 'false') return false;
	}
	return fallback;
}

function resolveDirectoryPassword(
	config: DirectoryConnectorsResponse | null
): AuthenticationMethodDirectoryPasswordSettings {
	const defaultConnectorId = config?.default_connector_id || 'campus';
	const connectors = config?.connectors ?? [];
	const configured = connectors.some(
		(connector) =>
			connector.id === defaultConnectorId &&
			(connector.transport === 'relay' || connector.endpoint_url.trim().length > 0) &&
			connector.auth_mode === 'hmac' &&
			connector.connector_id.trim().length > 0 &&
			connector.key_id.trim().length > 0 &&
			connector.secret_ref.trim().length > 0
	);
	return {
		loginEnabled: Boolean(config?.enabled) && configured,
		configured,
		connectorCount: connectors.length,
		defaultConnectorId,
		autoProvision: Boolean(config?.auto_provision),
		config
	};
}

export const adminAuthenticationMethodsAPI = {
	async get(tenantId?: string): Promise<AuthenticationMethodSettingsResponse> {
		const [settings, externalProviders, samlProviders, directoryConnectors] = await Promise.all([
			adminSettingsAPI.getSettings(CATEGORY, tenantId),
			adminExternalProvidersAPI
				.list(tenantId ? { tenant_id: tenantId } : {})
				.then((response) => response.providers)
				.catch(() => []),
			adminSAMLAPI
				.listProviders()
				.then((response) => response.providers)
				.catch(() => []),
			tenantId ? adminDirectoryConnectorsAPI.get(tenantId).catch(() => null) : Promise.resolve(null)
		]);
		const directoryPassword = resolveDirectoryPassword(directoryConnectors);
		const legacyPasskeyEnabled = parseBoolean(settings.values[LEGACY_PASSKEY_ENABLED_KEY], true);
		const legacyEmailOtpEnabled = parseBoolean(settings.values[LEGACY_EMAIL_OTP_ENABLED_KEY], true);
		const usageById = parseExternalProviderUsage(settings.values[EXTERNAL_PROVIDER_USAGE_KEY]);
		return {
			settings,
			builtIn: {
				passkeyLoginEnabled: parseBoolean(
					settings.values[PASSKEY_LOGIN_ENABLED_KEY],
					legacyPasskeyEnabled
				),
				passkeySignupEnabled: parseBoolean(
					settings.values[PASSKEY_SIGNUP_ENABLED_KEY],
					legacyPasskeyEnabled
				),
				passkeyReauthEnabled: parseBoolean(
					settings.values[PASSKEY_REAUTH_ENABLED_KEY],
					legacyPasskeyEnabled
				),
				passkeyAccountLinkEnabled: parseBoolean(
					settings.values[PASSKEY_ACCOUNT_LINK_ENABLED_KEY],
					legacyPasskeyEnabled
				),
				emailOtpLoginEnabled: parseBoolean(
					settings.values[EMAIL_OTP_LOGIN_ENABLED_KEY],
					legacyEmailOtpEnabled
				),
				emailOtpSignupEnabled: parseBoolean(
					settings.values[EMAIL_OTP_SIGNUP_ENABLED_KEY],
					legacyEmailOtpEnabled
				),
				emailOtpReauthEnabled: parseBoolean(
					settings.values[EMAIL_OTP_REAUTH_ENABLED_KEY],
					legacyEmailOtpEnabled
				),
				emailOtpAccountLinkEnabled: parseBoolean(
					settings.values[EMAIL_OTP_ACCOUNT_LINK_ENABLED_KEY],
					legacyEmailOtpEnabled
				)
			},
			directoryPassword,
			humanVerification: {
				provider: String(
					settings.values[HUMAN_VERIFICATION_PROVIDER_KEY] || DEFAULT_HUMAN_VERIFICATION_PROVIDER
				),
				loginEnabled: parseBoolean(settings.values[HUMAN_VERIFICATION_LOGIN_ENABLED_KEY], false),
				signupEnabled: parseBoolean(settings.values[HUMAN_VERIFICATION_SIGNUP_ENABLED_KEY], false),
				reauthEnabled: parseBoolean(settings.values[HUMAN_VERIFICATION_REAUTH_ENABLED_KEY], false)
			},
			providers: parseProviders(settings.values[EXTERNAL_PROVIDERS_KEY]),
			externalProviderUsages: resolveExternalProviderUsages(
				externalProviders,
				samlProviders,
				usageById
			)
		};
	},

	async update(
		settings: CategorySettings,
		builtIn: AuthenticationMethodBuiltInSettings,
		directoryPassword: AuthenticationMethodDirectoryPasswordSettings,
		humanVerification: AuthenticationMethodHumanVerificationSettings,
		providers: AuthenticationMethodExternalProvider[],
		externalProviderUsages: AuthenticationMethodExternalProviderUsage[],
		tenantId?: string
	) {
		try {
			const result = await adminSettingsAPI.updateSettings(
				CATEGORY,
				{
					ifMatch: settings.version,
					set: {
						[PASSKEY_LOGIN_ENABLED_KEY]: builtIn.passkeyLoginEnabled,
						[PASSKEY_SIGNUP_ENABLED_KEY]: builtIn.passkeySignupEnabled,
						[PASSKEY_REAUTH_ENABLED_KEY]: builtIn.passkeyReauthEnabled,
						[PASSKEY_ACCOUNT_LINK_ENABLED_KEY]: builtIn.passkeyAccountLinkEnabled,
						[EMAIL_OTP_LOGIN_ENABLED_KEY]: builtIn.emailOtpLoginEnabled,
						[EMAIL_OTP_SIGNUP_ENABLED_KEY]: builtIn.emailOtpSignupEnabled,
						[EMAIL_OTP_REAUTH_ENABLED_KEY]: builtIn.emailOtpReauthEnabled,
						[EMAIL_OTP_ACCOUNT_LINK_ENABLED_KEY]: builtIn.emailOtpAccountLinkEnabled,
						[HUMAN_VERIFICATION_PROVIDER_KEY]:
							humanVerification.provider || DEFAULT_HUMAN_VERIFICATION_PROVIDER,
						[HUMAN_VERIFICATION_LOGIN_ENABLED_KEY]: humanVerification.loginEnabled,
						[HUMAN_VERIFICATION_SIGNUP_ENABLED_KEY]: humanVerification.signupEnabled,
						[HUMAN_VERIFICATION_REAUTH_ENABLED_KEY]: humanVerification.reauthEnabled,
						[EXTERNAL_PROVIDER_USAGE_KEY]: serializeExternalProviderUsages(externalProviderUsages),
						[EXTERNAL_PROVIDERS_KEY]: serializeProviders(providers)
					}
				},
				tenantId
			);
			if (tenantId && directoryPassword.config) {
				await adminDirectoryConnectorsAPI.update(tenantId, {
					enabled: directoryPassword.loginEnabled,
					default_connector_id: directoryPassword.config.default_connector_id,
					auto_provision: directoryPassword.config.auto_provision,
					connectors: directoryPassword.config.connectors
				});
			}
			return result;
		} catch (error) {
			if (error instanceof SettingsConflictError) throw error;
			throw error;
		}
	}
};
