// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	signalAllAcceptedCredentials,
	signalCurrentUserDetails,
	signalUnknownCredential,
	shouldSignalUnknownCredentialAfterLoginFailure,
	shouldSignalUnknownCredentialAfterRegistrationFailure
} from './signal';
import type { AccountProfile } from '$lib/api/account';

function setPublicKeyCredential(value: unknown) {
	Object.defineProperty(window, 'PublicKeyCredential', {
		value,
		configurable: true,
		writable: true
	});
}

describe('WebAuthn Signal API helpers', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		setPublicKeyCredential(undefined);
	});

	it('signals accepted credential IDs when the browser supports the API', async () => {
		const signalAllAcceptedCredentialsMock = vi.fn().mockResolvedValue(undefined);
		setPublicKeyCredential({
			signalAllAcceptedCredentials: signalAllAcceptedCredentialsMock
		});

		await signalAllAcceptedCredentials({
			rp_id: 'login.example.com',
			user_id: 'dXNlci0wMDE',
			credential_ids: ['credential-1', 'credential-2']
		});

		expect(signalAllAcceptedCredentialsMock).toHaveBeenCalledWith({
			rpId: 'login.example.com',
			userId: 'dXNlci0wMDE',
			allAcceptedCredentialIds: ['credential-1', 'credential-2']
		});
	});

	it('signals an unknown credential when the browser supports the API', async () => {
		const signalUnknownCredentialMock = vi.fn().mockResolvedValue(undefined);
		setPublicKeyCredential({
			signalUnknownCredential: signalUnknownCredentialMock
		});

		await signalUnknownCredential('credential-orphan', 'login.example.com');

		expect(signalUnknownCredentialMock).toHaveBeenCalledWith({
			rpId: 'login.example.com',
			credentialId: 'credential-orphan'
		});
	});

	it('signals current user details using the WebAuthn user handle encoding', async () => {
		const signalCurrentUserDetailsMock = vi.fn().mockResolvedValue(undefined);
		setPublicKeyCredential({
			signalCurrentUserDetails: signalCurrentUserDetailsMock
		});

		const profile: AccountProfile = {
			user_id: 'user-001',
			email: 'user@example.com',
			email_verified: true,
			name: 'Example User',
			given_name: null,
			family_name: null,
			locale: null,
			picture: null
		};

		await signalCurrentUserDetails(profile, 'login.example.com');

		expect(signalCurrentUserDetailsMock).toHaveBeenCalledWith({
			rpId: 'login.example.com',
			userId: 'dXNlci0wMDE',
			name: 'user@example.com',
			displayName: 'Example User'
		});
	});

	it('does not fail the caller when Signal API is unsupported or throws', async () => {
		await expect(signalAllAcceptedCredentials(undefined)).resolves.toBeUndefined();
		await expect(signalCurrentUserDetails(null)).resolves.toBeUndefined();

		setPublicKeyCredential({
			signalAllAcceptedCredentials: vi.fn().mockRejectedValue(new Error('not available'))
		});

		await expect(
			signalAllAcceptedCredentials({
				rp_id: 'login.example.com',
				user_id: 'dXNlci0wMDE',
				credential_ids: []
			})
		).resolves.toBeUndefined();
	});

	it('limits unknown credential signaling to safe error classes', () => {
		expect(
			shouldSignalUnknownCredentialAfterRegistrationFailure({
				error: 'verification_failed',
				error_description: 'Verification failed'
			})
		).toBe(true);
		expect(
			shouldSignalUnknownCredentialAfterRegistrationFailure({
				error: 'network_error',
				error_description: 'Network error'
			})
		).toBe(false);
		expect(
			shouldSignalUnknownCredentialAfterLoginFailure({
				error: 'interaction_required',
				error_description: 'Passkey failed',
				webauthn_signal: { unknown_credential: true }
			})
		).toBe(true);
		expect(
			shouldSignalUnknownCredentialAfterLoginFailure({
				error: 'interaction_required',
				error_description: 'Passkey failed'
			})
		).toBe(false);
	});
});
