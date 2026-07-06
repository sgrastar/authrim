import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	mockAdminSettingsAPI,
	mockAdminExternalProvidersAPI,
	mockAdminSAMLAPI,
	mockAdminDirectoryConnectorsAPI
} = vi.hoisted(() => ({
	mockAdminSettingsAPI: {
		getSettings: vi.fn(),
		updateSettings: vi.fn()
	},
	mockAdminExternalProvidersAPI: {
		list: vi.fn()
	},
	mockAdminSAMLAPI: {
		listProviders: vi.fn()
	},
	mockAdminDirectoryConnectorsAPI: {
		get: vi.fn()
	}
}));

vi.mock('$lib/api/admin-settings', () => ({
	SettingsConflictError: class SettingsConflictError extends Error {},
	adminSettingsAPI: mockAdminSettingsAPI
}));

vi.mock('$lib/api/admin-external-providers', () => ({
	adminExternalProvidersAPI: mockAdminExternalProvidersAPI
}));

vi.mock('$lib/api/admin-saml', () => ({
	adminSAMLAPI: mockAdminSAMLAPI
}));

vi.mock('$lib/api/admin-directory-connectors', () => ({
	adminDirectoryConnectorsAPI: mockAdminDirectoryConnectorsAPI
}));

import { adminAuthenticationMethodsAPI } from './admin-authentication-methods';
import type {
	AuthenticationMethodBuiltInSettings,
	AuthenticationMethodDirectoryPasswordSettings,
	AuthenticationMethodHumanVerificationSettings
} from './admin-authentication-methods';

describe('adminAuthenticationMethodsAPI', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockAdminExternalProvidersAPI.list.mockResolvedValue({ providers: [] });
		mockAdminSAMLAPI.listProviders.mockResolvedValue({ providers: [] });
		mockAdminDirectoryConnectorsAPI.get.mockResolvedValue(null);
	});

	it('reads TOTP built-in settings with legacy fallback and preset fields', async () => {
		mockAdminSettingsAPI.getSettings.mockResolvedValue({
			version: 'v1',
			values: {
				'authentication-methods.totp.enabled': true,
				'authentication-methods.totp.signup_enabled': false,
				'authentication-methods.totp.reauth_enabled': true,
				'authentication-methods.totp.account_link_enabled': true,
				'authentication-methods.totp.preset': 'strong',
				'authentication-methods.totp.default_acr': 'urn:authrim:aal:3'
			}
		});

		const result = await adminAuthenticationMethodsAPI.get('tenant-a');

		expect(mockAdminSettingsAPI.getSettings).toHaveBeenCalledWith(
			'authentication-methods',
			'tenant-a'
		);
		expect(result.builtIn).toMatchObject({
			totpLoginEnabled: true,
			totpSignupEnabled: false,
			totpReauthEnabled: true,
			totpAccountLinkEnabled: true,
			totpPreset: 'strong',
			totpDefaultAcr: 'urn:authrim:aal:3'
		});
	});

	it('writes TOTP built-in settings through the authentication-methods category', async () => {
		mockAdminSettingsAPI.updateSettings.mockResolvedValue({
			version: 'v2',
			values: {}
		});
		const settings = {
			category: 'authentication-methods',
			version: 'v1',
			values: {},
			sources: {}
		};
		const builtIn: AuthenticationMethodBuiltInSettings = {
			passkeyLoginEnabled: true,
			passkeySignupEnabled: true,
			passkeyReauthEnabled: true,
			passkeyAccountLinkEnabled: true,
			emailOtpLoginEnabled: true,
			emailOtpSignupEnabled: true,
			emailOtpReauthEnabled: true,
			emailOtpAccountLinkEnabled: true,
			totpLoginEnabled: true,
			totpSignupEnabled: false,
			totpReauthEnabled: true,
			totpAccountLinkEnabled: true,
			totpPreset: 'strong',
			totpDefaultAcr: 'urn:authrim:aal:3'
		};
		const directoryPassword: AuthenticationMethodDirectoryPasswordSettings = {
			loginEnabled: false,
			configured: false,
			connectorCount: 0,
			defaultConnectorId: '',
			autoProvision: false,
			config: null
		};
		const humanVerification: AuthenticationMethodHumanVerificationSettings = {
			provider: 'human-verification-cloudflare-turnstile',
			loginEnabled: false,
			signupEnabled: false,
			reauthEnabled: false
		};

		await adminAuthenticationMethodsAPI.update(
			settings,
			builtIn,
			directoryPassword,
			humanVerification,
			[],
			[],
			'tenant-a'
		);

		expect(mockAdminSettingsAPI.updateSettings).toHaveBeenCalledWith(
			'authentication-methods',
			expect.objectContaining({
				ifMatch: 'v1',
				set: expect.objectContaining({
					'authentication-methods.totp.login_enabled': true,
					'authentication-methods.totp.signup_enabled': false,
					'authentication-methods.totp.reauth_enabled': true,
					'authentication-methods.totp.account_link_enabled': true,
					'authentication-methods.totp.preset': 'strong',
					'authentication-methods.totp.default_acr': 'urn:authrim:aal:3'
				})
			}),
			'tenant-a'
		);
	});
});
