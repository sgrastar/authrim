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

describe('LoginUI passkey Direct Auth adapter', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sessionStorage.clear();
	});

	it('uses canonical Direct Auth endpoints and redeems the artifact into a managed session', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ challenge_id: 'chal_login', options: { challenge: 'abc' } }),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ direct_auth_artifact: 'artifact_login', expires_in: 60 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						ok: true,
						redirect_url: '/authorize?client_id=rp_web&_confirmed=true',
						session: {
							userId: 'user_login',
							createdAt: 1,
							expiresAt: 2,
							authTime: 1700000123,
							acr: 'urn:mace:incommon:iap:bronze',
							amr: ['passkey']
						},
						user: {
							id: 'user_login',
							email: 'user@example.com',
							name: 'Example User'
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
		const { passkeyAPI } = await loadClient();

		const options = await passkeyAPI.getLoginOptions({
			authorizationChallengeId: 'oauth_login_challenge'
		});
		const verified = await passkeyAPI.verifyLogin({
			challengeId: options.data!.challengeId,
			credential: { id: 'credential' },
			authorizationChallengeId: 'oauth_login_challenge',
			deferAuthorizationContinuation: true
		});

		expect(fetchMock.mock.calls[0]?.[0].toString()).toContain(
			'/api/v1/auth/direct/passkey/login/start'
		);
		expect(fetchMock.mock.calls[1]?.[0].toString()).toContain(
			'/api/v1/auth/direct/passkey/login/finish'
		);
		expect(fetchMock.mock.calls[2]?.[0].toString()).toContain('/api/v1/auth/direct/session');
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
			authorization_challenge_id: 'oauth_login_challenge'
		});
		for (const [url] of fetchMock.mock.calls) {
			expect(url.toString()).not.toContain('/api/auth/passkeys');
			expect(url.toString()).not.toContain('/api/auth/email-codes');
		}
		expect(verified.data).toMatchObject({
			userId: 'user_login',
			redirect_url: '/authorize?client_id=rp_web&_confirmed=true',
			session: {
				authTime: 1700000123,
				acr: 'urn:mace:incommon:iap:bronze',
				amr: ['passkey']
			},
			user: {
				email: 'user@example.com'
			}
		});
		expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
			authorization_challenge_id: 'oauth_login_challenge',
			defer_authorization_continuation: true
		});
	});

	it('uses canonical Email Code endpoints and redeems the artifact into a managed session', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						attempt_id: 'attempt_email',
						expires_in: 300,
						masked_email: 'u***@example.com'
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ direct_auth_artifact: 'artifact_email', expires_in: 60 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						ok: true,
						redirect_url: '/authorize?client_id=rp_email&_confirmed=true',
						session: {
							userId: 'user_email',
							createdAt: 1,
							expiresAt: 2,
							authTime: 1700000456,
							acr: 'urn:mace:incommon:iap:bronze',
							amr: ['email_code']
						},
						user: {
							id: 'user_email',
							email: 'user@example.com',
							name: null
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
		const { emailCodeAPI } = await loadClient();

		const send = await emailCodeAPI.send({
			email: 'User@Example.com',
			invite_token: 'invite_123',
			authorizationChallengeId: 'oauth_email_challenge',
			custom_fields: { team: 'platform' },
			runtimeInteractionId: 'runtime_email_1'
		});
		const verified = await emailCodeAPI.verify({
			email: 'user@example.com',
			code: '123456',
			authorizationChallengeId: 'oauth_email_challenge'
		});

		expect(send.data).toMatchObject({
			success: true,
			messageId: 'attempt_email'
		});
		expect(fetchMock.mock.calls[0]?.[0].toString()).toContain(
			'/api/v1/auth/direct/email-code/send'
		);
		expect(fetchMock.mock.calls[1]?.[0].toString()).toContain(
			'/api/v1/auth/direct/email-code/verify'
		);
		expect(fetchMock.mock.calls[2]?.[0].toString()).toContain('/api/v1/auth/direct/session');
		for (const [url] of fetchMock.mock.calls) {
			expect(url.toString()).not.toContain('/api/auth/passkeys');
			expect(url.toString()).not.toContain('/api/auth/email-codes');
		}
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
			client_id: 'login-ui',
			channel: 'browser',
			invite_token: 'invite_123',
			authorization_challenge_id: 'oauth_email_challenge',
			runtime_interaction_id: 'runtime_email_1',
			custom_fields: { team: 'platform' }
		});
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
			attempt_id: 'attempt_email',
			code: '123456',
			channel: 'browser'
		});
		expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
			authorization_challenge_id: 'oauth_email_challenge',
			channel: 'browser',
			client_id: 'login-ui',
			direct_auth_artifact: 'artifact_email'
		});
		expect(verified.data).toMatchObject({
			success: true,
			userId: 'user_email',
			redirect_url: '/authorize?client_id=rp_email&_confirmed=true',
			session: {
				authTime: 1700000456,
				acr: 'urn:mace:incommon:iap:bronze',
				amr: ['email_code']
			}
		});
	});

	it('keeps the request pending and replays it through a tenant placement write fence', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error: 'temporarily_unavailable',
						error_description: 'Tenant data is temporarily unavailable. Retry shortly.',
						extensions: {
							reason: 'tenant_placement_write_fence',
							retryable: true,
							retry_after_ms: 250
						}
					}),
					{ status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '1' } }
				)
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						attempt_id: 'attempt_after_write_fence',
						expires_in: 300,
						masked_email: 'u***@example.com'
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
			);
		Object.defineProperty(globalThis, 'fetch', { value: fetchMock, configurable: true });
		const { emailCodeAPI } = await loadClient();

		await expect(emailCodeAPI.send({ email: 'user@example.com' })).resolves.toMatchObject({
			data: { success: true, messageId: 'attempt_after_write_fence' }
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(fetchMock.mock.calls[0]?.[1]?.body);
	});

	it('keeps the Email Code request loading until routed provisioning is ready', async () => {
		const token = 'A'.repeat(43);
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						status: 'provisioning',
						provisioning_token: token,
						status_endpoint: '/api/v1/auth/account-provisioning/status',
						retry_after_ms: 250
					}),
					{ status: 202, headers: { 'Content-Type': 'application/json' } }
				)
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ status: 'pending', retry_after_ms: 250 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ status: 'ready' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						attempt_id: 'attempt_after_provisioning',
						expires_in: 300,
						masked_email: 'u***@example.com'
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
			);
		Object.defineProperty(globalThis, 'fetch', {
			value: fetchMock,
			configurable: true
		});
		const { emailCodeAPI } = await loadClient();

		await expect(emailCodeAPI.send({ email: 'user@example.com' })).resolves.toMatchObject({
			data: { success: true, messageId: 'attempt_after_provisioning' }
		});

		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(fetchMock.mock.calls[1]?.[0].toString()).toContain(
			'/api/v1/auth/account-provisioning/status'
		);
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
			provisioning_token: token
		});
		const initialBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		const retriedBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
		expect(retriedBody).toEqual(initialBody);
	});

	it('continues polling when the resumed request returns a second provisioning operation', async () => {
		const firstToken = 'A'.repeat(43);
		const secondToken = 'B'.repeat(43);
		const accepted = (token: string) =>
			new Response(
				JSON.stringify({
					status: 'provisioning',
					provisioning_token: token,
					status_endpoint: '/api/v1/auth/account-provisioning/status',
					retry_after_ms: 250
				}),
				{ status: 202, headers: { 'Content-Type': 'application/json' } }
			);
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(accepted(firstToken))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ status: 'ready' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(accepted(secondToken))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ status: 'pending', retry_after_ms: 250 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ status: 'ready' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						attempt_id: 'attempt_after_second_operation',
						expires_in: 300,
						masked_email: 'u***@example.com'
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
			);
		Object.defineProperty(globalThis, 'fetch', { value: fetchMock, configurable: true });
		const { emailCodeAPI } = await loadClient();

		await expect(emailCodeAPI.send({ email: 'user@example.com' })).resolves.toMatchObject({
			data: { success: true, messageId: 'attempt_after_second_operation' }
		});

		expect(fetchMock).toHaveBeenCalledTimes(6);
		const initialBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual(initialBody);
		expect(JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body))).toEqual(initialBody);
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
			provisioning_token: firstToken
		});
		expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
			provisioning_token: secondToken
		});
	});

	it('redeems a valid Email Verification Protocol artifact without entering the OTP state', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ direct_auth_artifact: 'artifact_evp', expires_in: 60 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						ok: true,
						redirect_url: '/account',
						session: {
							userId: 'user_email',
							createdAt: 1,
							expiresAt: 2,
							authTime: 1700000456,
							acr: 'urn:mace:incommon:iap:bronze',
							amr: ['email_verification_protocol']
						},
						user: {
							id: 'user_email',
							email: 'user@example.com',
							name: null
						}
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
			);
		Object.defineProperty(globalThis, 'fetch', {
			value: fetchMock,
			configurable: true
		});
		const { emailCodeAPI } = await loadClient();

		const result = await emailCodeAPI.send({
			email: 'user@example.com',
			deferAuthorizationContinuation: true,
			runtimeInteractionId: 'runtime_email_1',
			emailVerification: {
				token: 'evt-presentation',
				challengeId: 'evp_challenge_1',
				interactionId: 'runtime_email_1'
			}
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
			email_verification_token: 'evt-presentation',
			email_verification_challenge_id: 'evp_challenge_1',
			runtime_interaction_id: 'runtime_email_1'
		});
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
			direct_auth_artifact: 'artifact_evp',
			defer_authorization_continuation: true
		});
		expect(result.data).toMatchObject({
			success: true,
			verified: true,
			userId: 'user_email',
			redirect_url: '/account',
			session: { amr: ['email_verification_protocol'] }
		});
	});

	it('retains Email Code PKCE state after an invalid code so the attempt can be retried', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						attempt_id: 'attempt_retry',
						expires_in: 300,
						masked_email: 'u***@example.com'
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: 'invalid_code', error_description: 'Invalid code' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ direct_auth_artifact: 'artifact_retry', expires_in: 60 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						ok: true,
						session: { userId: 'user_email', createdAt: 1, expiresAt: 2 },
						user: { id: 'user_email', email: 'user@example.com', name: null }
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
			);
		Object.defineProperty(globalThis, 'fetch', {
			value: fetchMock,
			configurable: true
		});
		const { emailCodeAPI } = await loadClient();

		await emailCodeAPI.send({ email: 'user@example.com' });
		const invalid = await emailCodeAPI.verify({
			email: 'user@example.com',
			code: '000000'
		});
		const valid = await emailCodeAPI.verify({
			email: 'user@example.com',
			code: '123456'
		});

		expect(invalid.error).toMatchObject({ error: 'invalid_code' });
		expect(valid.data).toMatchObject({ success: true, userId: 'user_email' });
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
			attempt_id: 'attempt_retry',
			code: '000000'
		});
		expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
			attempt_id: 'attempt_retry',
			code: '123456'
		});
	});

	it('uses the Directory Password endpoint and preserves authorization continuation', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					ok: true,
					redirect_url: '/authorize?client_id=rp_directory&_confirmation_challenge=confirm',
					session: {
						userId: 'user_directory',
						createdAt: 1,
						expiresAt: 2,
						authTime: 1700000789,
						acr: 'urn:mace:incommon:iap:bronze',
						amr: ['pwd', 'directory']
					},
					user: {
						id: 'user_directory',
						email: 'alice@example.com',
						name: 'Alice Example'
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
		const { directoryPasswordAPI } = await loadClient();

		const verified = await directoryPasswordAPI.login({
			username: 'alice',
			password: 'correct',
			inviteToken: 'invite-token',
			authorizationChallengeId: 'oauth_directory_challenge'
		});

		expect(fetchMock.mock.calls[0]?.[0].toString()).toContain('/api/auth/directory-password/login');
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
			username: 'alice',
			password: 'correct',
			invite_token: 'invite-token',
			authorization_challenge_id: 'oauth_directory_challenge'
		});
		expect(verified.data).toMatchObject({
			success: true,
			userId: 'user_directory',
			redirect_url: '/authorize?client_id=rp_directory&_confirmation_challenge=confirm',
			session: {
				authTime: 1700000789,
				acr: 'urn:mace:incommon:iap:bronze',
				amr: ['pwd', 'directory']
			}
		});
	});

	it('returns Directory Password migration transactions without converting them to sessions', async () => {
		const fetchMock = vi.fn(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						ok: false,
						migration: {
							required: true,
							action: 'require_passkey',
							transaction_id: 'damt_1',
							transaction_token: 'migration-token',
							expires_at: 1700001000,
							campaign_id: 'damc_1',
							state: 'passkey_required',
							reason: 'immediate',
							passkey_required_at: 1700000000,
							email_code_fallback_mode: 'migration_recovery'
						},
						user: {
							id: 'user_directory',
							email: 'alice@example.com',
							name: 'Alice Example'
						}
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			)
		);
		Object.defineProperty(globalThis, 'fetch', {
			value: fetchMock,
			configurable: true
		});
		const { directoryPasswordAPI } = await loadClient();

		const verified = await directoryPasswordAPI.login({
			username: 'alice',
			password: 'correct'
		});

		expect(verified.data).toMatchObject({
			success: false,
			migration: {
				required: true,
				action: 'require_passkey',
				transaction_id: 'damt_1',
				transaction_token: 'migration-token',
				campaign_id: 'damc_1'
			}
		});
		expect(verified.data).not.toHaveProperty('session');
	});

	it('keeps optional Directory Password migration prompts attached to successful sessions', async () => {
		const fetchMock = vi.fn(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						ok: true,
						expires_in: 3600,
						session: {
							userId: 'user_directory',
							createdAt: 1700000000,
							expiresAt: 1700003600,
							authTime: 1700000000,
							acr: 'urn:mace:incommon:iap:bronze',
							amr: ['pwd', 'directory']
						},
						user: {
							id: 'user_directory',
							email: 'alice@example.com',
							name: 'Alice Example'
						},
						migration: {
							required: false,
							action: 'prompt_passkey',
							campaign_id: 'damc_1',
							state: 'prompted',
							passkey_required_at: null,
							transaction_ttl_seconds: 600
						}
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			)
		);
		Object.defineProperty(globalThis, 'fetch', {
			value: fetchMock,
			configurable: true
		});
		const { directoryPasswordAPI } = await loadClient();

		const verified = await directoryPasswordAPI.login({
			username: 'alice',
			password: 'correct'
		});

		expect(verified.data).toMatchObject({
			success: true,
			userId: 'user_directory',
			migration: {
				required: false,
				action: 'prompt_passkey',
				campaign_id: 'damc_1'
			}
		});
	});

	it('starts and verifies Directory Password migration passkey registration', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						challenge_id: 'challenge_migration',
						options: { challenge: 'webauthn-challenge' }
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						ok: true,
						redirect_url: '/authorize?client_id=rp_directory&_confirmed=true',
						session: {
							userId: 'user_directory',
							createdAt: 1,
							expiresAt: 2,
							authTime: 1700000456,
							acr: 'urn:mace:incommon:iap:bronze',
							amr: ['pwd', 'directory', 'passkey']
						},
						user: {
							id: 'user_directory',
							email: 'directory@example.com',
							name: 'Directory User'
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
		const { directoryPasswordAPI } = await loadClient();

		const options = await directoryPasswordAPI.migrationPasskeyOptions({
			transactionId: 'damt_1',
			transactionToken: 'migration-token',
			displayName: 'Directory User'
		});
		const verified = await directoryPasswordAPI.migrationPasskeyVerify({
			transactionId: 'damt_1',
			transactionToken: 'migration-token',
			challengeId: options.data!.challenge_id,
			credential: { id: 'credential' },
			deviceName: 'Work laptop'
		});

		expect(fetchMock.mock.calls[0]?.[0].toString()).toContain(
			'/api/auth/directory-password/migration/passkey/options'
		);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
			transaction_id: 'damt_1',
			transaction_token: 'migration-token',
			display_name: 'Directory User'
		});
		expect(fetchMock.mock.calls[1]?.[0].toString()).toContain(
			'/api/auth/directory-password/migration/passkey/verify'
		);
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
			transaction_id: 'damt_1',
			transaction_token: 'migration-token',
			challenge_id: 'challenge_migration',
			device_name: 'Work laptop'
		});
		expect(verified.data).toMatchObject({
			userId: 'user_directory',
			redirect_url: '/authorize?client_id=rp_directory&_confirmed=true',
			session: {
				amr: ['pwd', 'directory', 'passkey']
			}
		});
	});

	it('sends and verifies Directory Password migration email-code fallback', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						challenge_id: 'email_challenge_1',
						expires_in: 300,
						masked_email: 'al***@example.com'
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						ok: true,
						redirect_url: '/authorize?client_id=rp_directory&_confirmed=true',
						session: {
							userId: 'user_directory',
							createdAt: 1,
							expiresAt: 2,
							authTime: 1700000456,
							acr: 'urn:mace:incommon:iap:bronze',
							amr: ['pwd', 'directory', 'otp']
						},
						user: {
							id: 'user_directory',
							email: 'directory@example.com',
							name: 'Directory User'
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
		const { directoryPasswordAPI } = await loadClient();

		const sent = await directoryPasswordAPI.migrationEmailCodeSend({
			transactionId: 'damt_email_1',
			transactionToken: 'migration-email-token'
		});
		const verified = await directoryPasswordAPI.migrationEmailCodeVerify({
			transactionId: 'damt_email_1',
			transactionToken: 'migration-email-token',
			challengeId: sent.data!.challenge_id,
			code: '123456'
		});

		expect(fetchMock.mock.calls[0]?.[0].toString()).toContain(
			'/api/auth/directory-password/migration/email-code/send'
		);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
			transaction_id: 'damt_email_1',
			transaction_token: 'migration-email-token'
		});
		expect(fetchMock.mock.calls[1]?.[0].toString()).toContain(
			'/api/auth/directory-password/migration/email-code/verify'
		);
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
			transaction_id: 'damt_email_1',
			transaction_token: 'migration-email-token',
			challenge_id: 'email_challenge_1',
			code: '123456'
		});
		expect(verified.data).toMatchObject({
			userId: 'user_directory',
			redirect_url: '/authorize?client_id=rp_directory&_confirmed=true',
			session: {
				amr: ['pwd', 'directory', 'otp']
			}
		});
	});
});

describe('LoginUI challenge and consent adapter boundary', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sessionStorage.clear();
	});

	it('uses managed-session fetch defaults for login challenge and consent calls', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						challenge_id: 'login_challenge',
						client: {
							client_id: 'rp_123',
							client_name: 'Example RP'
						}
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						challenge_id: 'consent_challenge',
						client: {
							client_id: 'rp_123',
							client_name: 'Example RP'
						},
						scopes: []
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ redirect_url: 'https://rp.example.com/callback' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			);
		Object.defineProperty(globalThis, 'fetch', {
			value: fetchMock,
			configurable: true
		});
		const { loginChallengeAPI, consentAPI } = await loadClient();

		await loginChallengeAPI.getData('login challenge');
		await consentAPI.getData('consent challenge');
		await consentAPI.submit({
			challenge_id: 'consent_challenge',
			approved: true,
			consent_item_decisions: {
				openid: 'granted'
			}
		});

		expect(fetchMock.mock.calls[0]?.[0].toString()).toContain(
			'/auth/login-challenge?challenge_id=login+challenge'
		);
		expect(fetchMock.mock.calls[1]?.[0].toString()).toContain(
			'/auth/consent?challenge_id=consent+challenge'
		);
		expect(fetchMock.mock.calls[2]?.[0].toString()).toContain('/auth/consent');
		for (const call of fetchMock.mock.calls) {
			expect(call[1]?.credentials).toBe('include');
			expect(new Headers(call[1]?.headers).get('X-Diagnostic-Session-Id')).toBe('diag-test');
		}
	});
});

describe('LoginUI external IdP adapter boundary', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sessionStorage.clear();
	});

	it('builds a PKCE-protected start URL without returning the code verifier to UI routes', async () => {
		const { externalIdpAPI } = await loadClient();

		const result = await externalIdpAPI.startLogin('github', 'https://login.example.com/callback');
		const url = new URL(result.url);

		expect(url.pathname).toBe('/api/external/github/start');
		expect(url.searchParams.get('client_id')).toBe('login-ui');
		expect(url.searchParams.get('redirect_uri')).toBe('https://login.example.com/callback');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(url.searchParams.has('code_verifier')).toBe(false);
		expect(result).not.toHaveProperty('codeVerifier');
	});

	it('encodes the provider id as a single path segment', async () => {
		const { externalIdpAPI } = await loadClient();

		const result = await externalIdpAPI.startLogin(
			'github/../evil',
			'https://login.example.com/callback'
		);
		const url = new URL(result.url);

		expect(url.pathname).toBe('/api/external/github%2F..%2Fevil/start');
	});

	it('builds a SAML SP start URL with return_url and without PKCE parameters', async () => {
		const { externalIdpAPI } = await loadClient();

		const result = await externalIdpAPI.startLogin(
			'saml:saml-idp-1',
			'https://login.example.com/',
			'/saml/sp/login?idp=saml-idp-1',
			'saml_sp'
		);
		const url = new URL(result.url);

		expect(url.pathname).toBe('/saml/sp/login');
		expect(url.searchParams.get('idp')).toBe('saml-idp-1');
		expect(url.searchParams.get('return_url')).toBe('https://login.example.com/');
		expect(url.searchParams.has('client_id')).toBe(false);
		expect(url.searchParams.has('code_challenge')).toBe(false);
	});

	it('adds human verification responses only to Authrim-managed external start URLs', async () => {
		const { externalIdpAPI } = await loadClient();

		const result = await externalIdpAPI.startLogin(
			'github',
			'https://login.example.com/callback',
			undefined,
			'oauth_redirect',
			{ token: 'human-token' }
		);
		const url = new URL(result.url);

		expect(url.pathname).toBe('/api/external/github/start');
		expect(url.searchParams.get('human_verification_response')).toBe('human-token');
		expect(url.searchParams.has('cf_turnstile_response')).toBe(false);
	});
});
