import {
	adminSettingsAPI,
	SettingsConflictError,
	type CategorySettings
} from '$lib/api/admin-settings';

const CATEGORY = 'login-methods';
const EXTERNAL_PROVIDERS_KEY = 'login-methods.external_providers';

export type LoginMethodProviderType = 'oidc' | 'oauth2' | 'saml' | 'vc' | 'custom';
export type LoginMethodProviderStartMode = 'oauth_redirect' | 'saml_sp' | 'direct';

export interface LoginMethodExternalProvider {
	id: string;
	name: string;
	type: LoginMethodProviderType;
	startMode: LoginMethodProviderStartMode;
	startUrl: string;
	enabled: boolean;
	slug?: string;
	iconUrl?: string;
	buttonColor?: string;
	buttonText?: string;
}

export interface LoginMethodSettingsResponse {
	settings: CategorySettings;
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
	return {
		id: String(provider.id || ''),
		name: String(provider.name || ''),
		type,
		startMode: normalizeStartMode(provider.startMode, type),
		startUrl: String(provider.startUrl || ''),
		enabled: provider.enabled !== false,
		slug: provider.slug ? String(provider.slug) : undefined,
		iconUrl: provider.iconUrl ? String(provider.iconUrl) : undefined,
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
			...(provider.slug?.trim() ? { slug: provider.slug.trim() } : {}),
			...(provider.iconUrl?.trim() ? { iconUrl: provider.iconUrl.trim() } : {}),
			...(provider.buttonColor?.trim() ? { buttonColor: provider.buttonColor.trim() } : {}),
			...(provider.buttonText?.trim() ? { buttonText: provider.buttonText.trim() } : {})
		}))
	);
}

export const adminLoginMethodsAPI = {
	async get(tenantId?: string): Promise<LoginMethodSettingsResponse> {
		const settings = await adminSettingsAPI.getSettings(CATEGORY, tenantId);
		return {
			settings,
			providers: parseProviders(settings.values[EXTERNAL_PROVIDERS_KEY])
		};
	},

	async updateProviders(
		settings: CategorySettings,
		providers: LoginMethodExternalProvider[],
		tenantId?: string
	) {
		try {
			return await adminSettingsAPI.updateSettings(
				CATEGORY,
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
