import {
	adminSettingsAPI,
	SettingsConflictError,
	type CategorySettings
} from '$lib/api/admin-settings';

const CATEGORY = 'login-methods';
const EXTERNAL_PROVIDERS_KEY = 'login-methods.external_providers';
const PASSKEY_LOGIN_ENABLED_KEY = 'login-methods.passkey.login_enabled';
const PASSKEY_SIGNUP_ENABLED_KEY = 'login-methods.passkey.signup_enabled';
const PASSKEY_REAUTH_ENABLED_KEY = 'login-methods.passkey.reauth_enabled';
const PASSKEY_ACCOUNT_LINK_ENABLED_KEY = 'login-methods.passkey.account_link_enabled';
const LEGACY_PASSKEY_ENABLED_KEY = 'login-methods.passkey.enabled';
const EMAIL_OTP_LOGIN_ENABLED_KEY = 'login-methods.email_otp.login_enabled';
const EMAIL_OTP_SIGNUP_ENABLED_KEY = 'login-methods.email_otp.signup_enabled';
const EMAIL_OTP_REAUTH_ENABLED_KEY = 'login-methods.email_otp.reauth_enabled';
const EMAIL_OTP_ACCOUNT_LINK_ENABLED_KEY = 'login-methods.email_otp.account_link_enabled';
const LEGACY_EMAIL_OTP_ENABLED_KEY = 'login-methods.email_otp.enabled';

export type LoginMethodProviderType = 'oidc' | 'oauth2' | 'saml' | 'vc' | 'custom';
export type LoginMethodProviderStartMode = 'oauth_redirect' | 'saml_sp' | 'direct';

export interface LoginMethodExternalProvider {
	id: string;
	name: string;
	type: LoginMethodProviderType;
	startMode: LoginMethodProviderStartMode;
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

export interface LoginMethodBuiltInSettings {
	passkeyLoginEnabled: boolean;
	passkeySignupEnabled: boolean;
	passkeyReauthEnabled: boolean;
	passkeyAccountLinkEnabled: boolean;
	emailOtpLoginEnabled: boolean;
	emailOtpSignupEnabled: boolean;
	emailOtpReauthEnabled: boolean;
	emailOtpAccountLinkEnabled: boolean;
}

export interface LoginMethodSettingsResponse {
	settings: CategorySettings;
	builtIn: LoginMethodBuiltInSettings;
	providers: LoginMethodExternalProvider[];
}

function parseProviders(value: unknown): LoginMethodExternalProvider[] {
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

function isProviderLike(value: unknown): value is Partial<LoginMethodExternalProvider> {
	return typeof value === 'object' && value !== null;
}

function normalizeProvider(
	provider: Partial<LoginMethodExternalProvider>
): LoginMethodExternalProvider {
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

function normalizeType(value: unknown): LoginMethodProviderType {
	if (value === 'oidc' || value === 'oauth2' || value === 'saml' || value === 'vc') return value;
	return 'custom';
}

function normalizeStartMode(
	value: unknown,
	type: LoginMethodProviderType
): LoginMethodProviderStartMode {
	if (value === 'oauth_redirect' || value === 'saml_sp' || value === 'direct') return value;
	if (type === 'saml') return 'saml_sp';
	if (type === 'oidc' || type === 'oauth2') return 'oauth_redirect';
	return 'direct';
}

function serializeProviders(providers: LoginMethodExternalProvider[]): string {
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

function parseBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		if (normalized === 'true') return true;
		if (normalized === 'false') return false;
	}
	return fallback;
}

export const adminLoginMethodsAPI = {
	async get(tenantId?: string): Promise<LoginMethodSettingsResponse> {
		const settings = await adminSettingsAPI.getSettings(CATEGORY, tenantId);
		const legacyPasskeyEnabled = parseBoolean(settings.values[LEGACY_PASSKEY_ENABLED_KEY], true);
		const legacyEmailOtpEnabled = parseBoolean(settings.values[LEGACY_EMAIL_OTP_ENABLED_KEY], true);
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
			providers: parseProviders(settings.values[EXTERNAL_PROVIDERS_KEY])
		};
	},

	async update(
		settings: CategorySettings,
		builtIn: LoginMethodBuiltInSettings,
		providers: LoginMethodExternalProvider[],
		tenantId?: string
	) {
		try {
			return await adminSettingsAPI.updateSettings(
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
						[EXTERNAL_PROVIDERS_KEY]: serializeProviders(providers)
					}
				},
				tenantId
			);
		} catch (error) {
			if (error instanceof SettingsConflictError) throw error;
			throw error;
		}
	}
};
