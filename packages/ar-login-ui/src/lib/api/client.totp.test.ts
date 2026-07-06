// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({
	browser: true,
	dev: false,
	building: false,
	version: 'test'
}));

vi.mock('$lib/stores/diagnostic', () => ({
	getDiagnosticSessionId: vi.fn(() => 'diag-test')
}));

async function loadClient() {
	vi.resetModules();
	return import('./client');
}

describe('LoginUI TOTP API adapter', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sessionStorage.clear();
	});

	it('uses TOTP login endpoints and preserves authorization continuation flags', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ challenge_id: 'totp_challenge', expires_in: 300 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						sessionId: 'session_123',
						session: {
							userId: 'user_123',
							createdAt: 1,
							expiresAt: 2,
							authTime: 3,
							acr: 'urn:authrim:aal:2',
							amr: ['otp', 'totp']
						},
						user: {
							id: 'user_123',
							email: 'person@example.com'
						}
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			);
		Object.defineProperty(globalThis, 'fetch', {
			value: fetchMock,
			configurable: true
		});
		const { totpAPI } = await loadClient();

		await totpAPI.startLogin({ identifier: 'person@example.com' });
		await totpAPI.verifyLogin({
			challengeId: 'totp_challenge',
			code: '123456',
			authorizationChallengeId: 'oauth_challenge',
			deferAuthorizationContinuation: true
		});

		expect(fetchMock.mock.calls[0]?.[0].toString()).toContain('/api/auth/totp/login/start');
		expect(fetchMock.mock.calls[1]?.[0].toString()).toContain('/api/auth/totp/login/verify');
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			identifier: 'person@example.com'
		});
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
			challenge_id: 'totp_challenge',
			code: '123456',
			authorization_challenge_id: 'oauth_challenge',
			defer_authorization_continuation: true
		});
	});

	it('uses challenge-based signup activation without sending the setup secret back', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						challenge_id: 'signup_challenge',
						expires_in: 600,
						credential: {
							id: 'credential_123',
							label: 'Authenticator app',
							algorithm: 'SHA1',
							digits: 6,
							period: 30,
							window: 1,
							status: 'pending',
							created_at: 1,
							activated_at: null,
							last_used_at: null
						},
						secret: 'GEZDGNBVGY3TQOJQ',
						otpauth_uri: 'otpauth://totp/Authrim:person@example.com',
						profile: {
							algorithm: 'SHA1',
							digits: 6,
							period: 30,
							window: 1
						}
					}),
					{
						status: 201,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						ok: true,
						success: true,
						backup_codes: ['ABCD-EFGH-IJKL'],
						sessionId: 'session_signup',
						session: {
							userId: 'user_signup',
							createdAt: 1,
							expiresAt: 2,
							authTime: 3,
							acr: 'urn:authrim:aal:2',
							amr: ['otp', 'totp']
						},
						user: {
							id: 'user_signup',
							email: 'person@example.com'
						}
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			);
		Object.defineProperty(globalThis, 'fetch', {
			value: fetchMock,
			configurable: true
		});
		const { totpAPI } = await loadClient();

		await totpAPI.createSignupOptions({
			email: 'person@example.com',
			name: 'Person',
			label: 'Work phone',
			custom_fields: { department: 'platform' },
			authorizationChallengeId: 'oauth_signup',
			human_verification_response: 'human-token'
		});
		await totpAPI.activateSignup({
			challengeId: 'signup_challenge',
			code: '123456',
			deferAuthorizationContinuation: true
		});

		expect(fetchMock.mock.calls[0]?.[0].toString()).toContain('/api/auth/totp/signup/options');
		expect(fetchMock.mock.calls[1]?.[0].toString()).toContain('/api/auth/totp/signup/activate');
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			email: 'person@example.com',
			name: 'Person',
			label: 'Work phone',
			custom_fields: { department: 'platform' },
			authorization_challenge_id: 'oauth_signup',
			human_verification_response: 'human-token'
		});
		const activationBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
		expect(activationBody).toEqual({
			challenge_id: 'signup_challenge',
			code: '123456',
			defer_authorization_continuation: true
		});
		expect(activationBody).not.toHaveProperty('secret');
		expect(activationBody).not.toHaveProperty('otpauth_uri');
	});
});
