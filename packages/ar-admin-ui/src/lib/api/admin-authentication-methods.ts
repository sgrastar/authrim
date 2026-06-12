import {
	adminSettingsAPI,
	SettingsConflictError,
	type CategorySettings
} from '$lib/api/admin-settings';

const SETTINGS_CATEGORY = 'authentication-methods';
const EXTERNAL_PROVIDERS_KEY = 'authentication-methods.external_providers';

export type AuthenticationMethodProviderType = 'oidc' | 'oauth2' | 'saml' | 'vc' | 'custom';
export type AuthenticationMethodProviderStartMode = 'oauth_redirect' | 'saml_sp' | 'direct';

export interface AuthenticationMethodExternalProvider {
	id: string;
	name: string;
	type: AuthenticationMethodProviderType;
	startMode: AuthenticationMethodProviderStartMode;
	startUrl: string;
	enabled: boolean;
	slug?: string;
	iconUrl?: string;
	iconName?: string;
	buttonColor?: string;
	buttonText?: string;
}

export interface AuthenticationMethodSettingsResponse {
	settings: CategorySettings;
	providers: AuthenticationMethodExternalProvider[];
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
	return {
		id: String(provider.id || ''),
		name: String(provider.name || ''),
		type,
		startMode: normalizeStartMode(provider.startMode, type),
		startUrl: String(provider.startUrl || ''),
		enabled: provider.enabled !== false,
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
			...(provider.slug?.trim() ? { slug: provider.slug.trim() } : {}),
			...(provider.iconUrl?.trim() ? { iconUrl: provider.iconUrl.trim() } : {}),
			...(provider.iconName?.trim() ? { iconName: provider.iconName.trim() } : {}),
			...(provider.buttonColor?.trim() ? { buttonColor: provider.buttonColor.trim() } : {}),
			...(provider.buttonText?.trim() ? { buttonText: provider.buttonText.trim() } : {})
		}))
	);
}

export const adminAuthenticationMethodsAPI = {
	async get(tenantId?: string): Promise<AuthenticationMethodSettingsResponse> {
		const settings = await adminSettingsAPI.getSettings(SETTINGS_CATEGORY, tenantId);
		return {
			settings,
			providers: parseProviders(settings.values[EXTERNAL_PROVIDERS_KEY])
		};
	},

	async updateProviders(
		settings: CategorySettings,
		providers: AuthenticationMethodExternalProvider[],
		tenantId?: string
	) {
		try {
			return await adminSettingsAPI.updateSettings(
				SETTINGS_CATEGORY,
				{
					ifMatch: settings.version,
					set: {
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
