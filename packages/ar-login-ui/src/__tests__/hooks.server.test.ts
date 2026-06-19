import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/discovery-session', () => ({
	REMEMBERED_TENANT_COOKIE: 'authrim_remembered_tenant',
	getRememberedTenantHost: () => undefined
}));

describe('Login UI proxy hooks', () => {
	it('proxies browser-facing OIDC and SAML protocol paths', async () => {
		const { shouldProxyPath } = await import('../hooks.server');
		expect(shouldProxyPath('/api/v1/auth/direct/session')).toBe(true);
		expect(shouldProxyPath('/auth/login-challenge')).toBe(true);
		expect(shouldProxyPath('/auth/consent')).toBe(true);
		expect(shouldProxyPath('/handoff/finalize')).toBe(true);
		expect(shouldProxyPath('/authorize')).toBe(true);
		expect(shouldProxyPath('/saml/idp/sso')).toBe(true);
		expect(shouldProxyPath('/logout')).toBe(true);
		expect(shouldProxyPath('/api/set-language')).toBe(false);
		expect(shouldProxyPath('/login')).toBe(false);
	});

	it('preserves Set-Cookie headers from proxied auth responses', async () => {
		const { buildProxyResponse } = await import('../hooks.server');
		const upstream = new Response(JSON.stringify({ ok: true }), {
			headers: {
				'Content-Type': 'application/json',
				'Set-Cookie': 'authrim_session=sess_123; Path=/; HttpOnly; Secure; SameSite=None'
			}
		});

		const response = buildProxyResponse(upstream);

		expect(response.headers.get('set-cookie')).toContain('authrim_session=sess_123');
		expect(await response.json()).toEqual({ ok: true });
	});

	it('uses PUBLIC_API_BASE_URL as the server-side API backend fallback', async () => {
		const { getConfiguredApiBackendUrl } = await import('../hooks.server');

		expect(
			getConfiguredApiBackendUrl({
				API_BACKEND_URL: '__DISABLED__',
				PUBLIC_API_BASE_URL: 'https://first.multi-tenant.authrim.com'
			})
		).toBe('https://first.multi-tenant.authrim.com');
	});

	it('sets original and forwarded host hints on proxied API requests', async () => {
		const { buildProxyHeaders } = await import('../hooks.server');
		const request = new Request('https://login.multi-tenant.authrim.com/api/auth/discovery', {
			headers: {
				'x-authrim-original-host': 'login.multi-tenant.authrim.com',
				cookie: 'authrim_remembered_tenant=tenant'
			}
		});
		const event = {
			request,
			getClientAddress: () => '192.0.2.10'
		};

		const headers = buildProxyHeaders(
			event as never,
			{ PUBLIC_API_BASE_URL: 'https://first.multi-tenant.authrim.com' },
			'login.multi-tenant.authrim.com'
		);

		expect(headers.get('X-Authrim-Original-Host')).toBe('login.multi-tenant.authrim.com');
		expect(headers.get('X-Authrim-Forwarded-Host')).toBe('login.multi-tenant.authrim.com');
		expect(headers.get('X-Forwarded-Host')).toBe('login.multi-tenant.authrim.com');
		expect(headers.get('Cookie')).toContain('authrim_remembered_tenant');
	});

	it('adds Turnstile CSP origins only when Turnstile is enabled', async () => {
		const { buildContentSecurityPolicy } = await import('../hooks.server');

		const disabled = buildContentSecurityPolicy(undefined, null);
		const enabled = buildContentSecurityPolicy(undefined, 'turnstile');

		expect(disabled).not.toContain('https://challenges.cloudflare.com');
		expect(disabled).not.toContain('https://static.cloudflareinsights.com');
		expect(enabled).toContain(
			"script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com"
		);
		expect(enabled).toContain('https://static.cloudflareinsights.com');
		expect(enabled).toContain('frame-src https://challenges.cloudflare.com');
	});

	it('adds hCaptcha and reCAPTCHA CSP origins only for the selected provider', async () => {
		const { buildContentSecurityPolicy } = await import('../hooks.server');

		const hcaptcha = buildContentSecurityPolicy(undefined, 'hcaptcha');
		const recaptcha = buildContentSecurityPolicy(undefined, 'recaptcha');

		expect(hcaptcha).toContain('https://hcaptcha.com');
		expect(hcaptcha).toContain('https://*.hcaptcha.com');
		expect(hcaptcha).not.toContain('https://www.google.com');
		expect(recaptcha).toContain('https://www.google.com');
		expect(recaptcha).toContain('https://www.gstatic.com');
		expect(recaptcha).not.toContain('https://hcaptcha.com');
	});

	it('removes Turnstile CSP origins when the Turnstile plugin is disabled', async () => {
		const { buildContentSecurityPolicy, resolveHumanVerificationProviderForRequest } =
			await import('../hooks.server');
		const event = {
			request: new Request('https://login.example.com/login'),
			url: new URL('https://login.example.com/login'),
			cookies: { get: () => undefined },
			getClientAddress: () => '192.0.2.10'
		};
		const platformEnv = {
			AR_ROUTER: {
				fetch: vi.fn(async () =>
					Response.json({
						methods: {
							humanVerification: {
								enabled: false,
								provider: 'turnstile',
								siteKey: null
							}
						}
					})
				)
			}
		};

		const provider = await resolveHumanVerificationProviderForRequest(event as never, platformEnv);
		const csp = buildContentSecurityPolicy(platformEnv, provider);

		expect(provider).toBeNull();
		expect(csp).not.toContain('https://challenges.cloudflare.com');
		expect(csp).not.toContain('https://static.cloudflareinsights.com');
	});
});
