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

		const options = await passkeyAPI.getLoginOptions({});
		const verified = await passkeyAPI.verifyLogin({
			challengeId: options.data!.challengeId,
			credential: { id: 'credential' },
			authorizationChallengeId: 'oauth_login_challenge'
		});

		expect(fetchMock.mock.calls[0]?.[0].toString()).toContain(
			'/api/v1/auth/direct/passkey/login/start'
		);
		expect(fetchMock.mock.calls[1]?.[0].toString()).toContain(
			'/api/v1/auth/direct/passkey/login/finish'
		);
		expect(fetchMock.mock.calls[2]?.[0].toString()).toContain('/api/v1/auth/direct/session');
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
			authorization_challenge_id: 'oauth_login_challenge'
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
			custom_fields: { team: 'platform' }
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
			authorizationChallengeId: 'oauth_directory_challenge'
		});

		expect(fetchMock.mock.calls[0]?.[0].toString()).toContain('/api/auth/directory-password/login');
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
			username: 'alice',
			password: 'correct',
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

	it('returns direct external provider start URLs without adding OAuth parameters', async () => {
		const { externalIdpAPI } = await loadClient();

		const result = await externalIdpAPI.startLogin(
			'wallet-vp',
			'https://login.example.com/callback',
			'/vp/login?profile=employee',
			'direct'
		);
		const url = new URL(result.url);

		expect(url.pathname).toBe('/vp/login');
		expect(url.searchParams.get('profile')).toBe('employee');
		expect(url.searchParams.has('redirect_uri')).toBe(false);
		expect(url.searchParams.has('code_challenge')).toBe(false);
	});
});
