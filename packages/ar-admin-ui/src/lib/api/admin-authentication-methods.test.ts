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
			guestLoginEnabled: false,
			passkeyGuestUpgradeEnabled: true,
			emailOtpGuestUpgradeEnabled: true,
			totpLoginEnabled: true,
			totpSignupEnabled: false,
			totpReauthEnabled: true,
			totpAccountLinkEnabled: true,
			totpPreset: 'strong',
			totpDefaultAcr: 'urn:authrim:aal:3'
		});
	});

	it('reads and keeps the per-provider re-authentication evidence setting', async () => {
		mockAdminSettingsAPI.getSettings.mockResolvedValue({
			version: 'v1',
			values: {
				'authentication-methods.external_provider_usage': JSON.stringify([
					{
						id: 'entra',
						providerId: 'p-entra',
						reauthEnabled: true,
						reauthAcceptWithoutAuthTime: true
					},
					{ id: 'github', providerId: 'p-github', reauthEnabled: true }
				])
			}
		});
		mockAdminExternalProvidersAPI.list.mockResolvedValue({
			providers: [
				{ id: 'p-entra', slug: 'entra', name: 'Entra', providerType: 'oidc', enabled: true },
				{ id: 'p-github', slug: 'github', name: 'GitHub', providerType: 'oauth2', enabled: true }
			]
		});

		const result = await adminAuthenticationMethodsAPI.get('tenant-a');

		expect(result.externalProviderUsages).toEqual([
			expect.objectContaining({
				id: 'entra',
				reauthEnabled: true,
				reauthAcceptWithoutAuthTime: true
			}),
			// No ID token dates a new login: never re-authenticates, whatever was saved.
			expect.objectContaining({
				id: 'github',
				reauthEnabled: false,
				reauthAcceptWithoutAuthTime: false
			})
		]);

		mockAdminSettingsAPI.updateSettings.mockResolvedValue({ version: 'v2', values: {} });
		await adminAuthenticationMethodsAPI.update(
			result.settings,
			result.builtIn,
			result.directoryPassword,
			result.humanVerification,
			[],
			result.externalProviderUsages,
			'tenant-a'
		);
		const saved = JSON.parse(
			mockAdminSettingsAPI.updateSettings.mock.calls[0][1].set[
				'authentication-methods.external_provider_usage'
			]
		) as Array<Record<string, unknown>>;
		expect(saved[0]).toMatchObject({ id: 'entra', reauthAcceptWithoutAuthTime: true });
		expect(saved[1]).toMatchObject({ id: 'github', reauthEnabled: false });
		expect(saved[1]).not.toHaveProperty('reauthAcceptWithoutAuthTime');
	});

	it("never shows another provider's entry that once had the same slug", async () => {
		mockAdminSettingsAPI.getSettings.mockResolvedValue({
			version: 'v1',
			values: {
				'authentication-methods.external_provider_usage': JSON.stringify([
					{
						id: 'corp',
						providerId: 'p-old',
						reauthEnabled: true,
						reauthAcceptWithoutAuthTime: true
					}
				])
			}
		});
		mockAdminExternalProvidersAPI.list.mockResolvedValue({
			providers: [{ id: 'p-new', slug: 'corp', name: 'Corp', providerType: 'oidc', enabled: true }]
		});

		const result = await adminAuthenticationMethodsAPI.get('tenant-a');

		expect(result.externalProviderUsages[0]).toMatchObject({
			id: 'corp',
			providerId: 'p-new',
			reauthAcceptWithoutAuthTime: false
		});
	});

	it('keeps guest promotion independent from signup and login permissions', async () => {
		mockAdminSettingsAPI.getSettings.mockResolvedValue({
			version: 'v3',
			values: {
				'authentication-methods.guest.login_enabled': true,
				'authentication-methods.passkey.signup_enabled': false,
				'authentication-methods.passkey.login_enabled': false,
				'authentication-methods.passkey.guest_upgrade_enabled': true,
				'authentication-methods.email_otp.signup_enabled': true,
				'authentication-methods.email_otp.guest_upgrade_enabled': false
			}
		});
		const result = await adminAuthenticationMethodsAPI.get('tenant-b');
		expect(result.builtIn).toMatchObject({
			guestLoginEnabled: true,
			passkeySignupEnabled: false,
			passkeyLoginEnabled: false,
			passkeyGuestUpgradeEnabled: true,
			emailOtpSignupEnabled: true,
			emailOtpGuestUpgradeEnabled: false
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
			guestLoginEnabled: false,
			passkeyGuestUpgradeEnabled: true,
			emailOtpGuestUpgradeEnabled: true,
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
					'authentication-methods.guest.login_enabled': false,
					'authentication-methods.passkey.guest_upgrade_enabled': true,
					'authentication-methods.email_otp.guest_upgrade_enabled': true,
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
