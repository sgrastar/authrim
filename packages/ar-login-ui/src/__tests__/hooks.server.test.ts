import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/public', () => ({ env: {} }));

function createAuthenticationMethodsResponse(
	provider: 'turnstile' | 'hcaptcha' | 'recaptcha' = 'turnstile',
	enabled = true
) {
	return {
		methods: {
			humanVerification: {
				enabled,
				provider,
				siteKey: enabled ? 'site-key' : null
			}
		},
		meta: {
			cacheTTL: 180,
			revision: 'test'
		}
	};
}

describe('Login UI proxy hooks', () => {
	beforeEach(async () => {
		const { clearAuthenticationMethodsServerCache } =
			await import('$lib/server/authentication-methods-cache');
		clearAuthenticationMethodsServerCache();
		vi.clearAllMocks();
	});

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
		expect(headers.get('Host')).toBe('login.multi-tenant.authrim.com');
		expect(headers.get('Cookie')).toContain('authrim_remembered_tenant');
	});

	it('rewrites same-origin browser Origin and Referer to the forwarded tenant origin', async () => {
		const { buildProxyHeaders } = await import('../hooks.server');
		const request = new Request('https://login.example.com/api/v1/auth/direct/session', {
			headers: {
				origin: 'https://login.example.com',
				referer: 'https://login.example.com/login?challenge_id=challenge-1'
			}
		});
		const event = {
			request,
			url: new URL(request.url),
			getClientAddress: () => '192.0.2.10'
		};

		const headers = buildProxyHeaders(event as never, undefined, 'first.test.authrim.com');

		expect(headers.get('Origin')).toBe('https://first.test.authrim.com');
		expect(headers.get('X-Authrim-Browser-Origin')).toBe('https://login.example.com');
		expect(headers.get('Referer')).toBe(
			'https://first.test.authrim.com/login?challenge_id=challenge-1'
		);
	});

	it('preserves cross-site browser Origin on proxied API requests', async () => {
		const { buildProxyHeaders } = await import('../hooks.server');
		const request = new Request('https://login.example.com/api/v1/auth/direct/session', {
			headers: {
				origin: 'https://evil.example.com',
				referer: 'https://evil.example.com/form'
			}
		});
		const event = {
			request,
			url: new URL(request.url),
			getClientAddress: () => '192.0.2.10'
		};

		const headers = buildProxyHeaders(event as never, undefined, 'first.test.authrim.com');

		expect(headers.get('Origin')).toBe('https://evil.example.com');
		expect(headers.get('X-Authrim-Browser-Origin')).toBeNull();
		expect(headers.get('Referer')).toBe('https://evil.example.com/form');
	});

	it('redirects direct Account Page requests on the Login UI host to the public API origin', async () => {
		const { getAccountPageCanonicalRedirectUrl } =
			await import('$lib/server/account-canonical-url');
		const request = new Request('https://login.example.com/account/security?tab=passkeys');
		const event = {
			request,
			url: new URL(request.url)
		};

		expect(
			getAccountPageCanonicalRedirectUrl(event as never, {
				PUBLIC_AUTHRIM_ISSUER: 'https://first.example.com'
			})
		).toBe('https://first.example.com/account/security?tab=passkeys');
	});

	it('uses the request Host header when the runtime URL has already been normalized', async () => {
		const { getAccountPageCanonicalRedirectUrl } =
			await import('$lib/server/account-canonical-url');
		const request = new Request('https://first.example.com/account/security', {
			headers: {
				host: 'login.example.com'
			}
		});
		const event = {
			request,
			url: new URL(request.url)
		};

		expect(
			getAccountPageCanonicalRedirectUrl(event as never, {
				PUBLIC_AUTHRIM_ISSUER: 'https://first.example.com'
			})
		).toBe('https://first.example.com/account/security');
	});

	it('keeps router-proxied Account Page requests on their original tenant host', async () => {
		const { getAccountPageCanonicalRedirectUrl } =
			await import('$lib/server/account-canonical-url');
		const request = new Request('https://phase9-ar-login-ui.example.workers.dev/account/security', {
			headers: {
				'x-authrim-original-host': 'second.example.com'
			}
		});
		const event = {
			request,
			url: new URL(request.url)
		};

		expect(
			getAccountPageCanonicalRedirectUrl(event as never, {
				PUBLIC_AUTHRIM_ISSUER: 'https://first.example.com'
			})
		).toBeNull();
	});

	it('redirects direct Account Page requests even when the original host header repeats the request host', async () => {
		const { getAccountPageCanonicalRedirectUrl } =
			await import('$lib/server/account-canonical-url');
		const request = new Request('https://login.example.com/account/security', {
			headers: {
				'x-authrim-original-host': 'login.example.com'
			}
		});
		const event = {
			request,
			url: new URL(request.url)
		};

		expect(
			getAccountPageCanonicalRedirectUrl(event as never, {
				PUBLIC_AUTHRIM_ISSUER: 'https://first.example.com'
			})
		).toBe('https://first.example.com/account/security');
	});

	it('keeps Account Page requests already on the public API origin', async () => {
		const { getAccountPageCanonicalRedirectUrl } =
			await import('$lib/server/account-canonical-url');
		const request = new Request('https://first.example.com/account');
		const event = {
			request,
			url: new URL(request.url)
		};

		expect(
			getAccountPageCanonicalRedirectUrl(event as never, {
				PUBLIC_AUTHRIM_ISSUER: 'https://first.example.com'
			})
		).toBeNull();
	});

	it('uses tenant_host query parameter before the configured API base host', async () => {
		const { getForwardedHost } = await import('../hooks.server');
		const event = {
			request: new Request('https://login.example.com/login?tenant_host=second.test.authrim.com'),
			url: new URL('https://login.example.com/login?tenant_host=second.test.authrim.com'),
			cookies: { get: () => undefined }
		};

		expect(
			getForwardedHost(event as never, {
				PUBLIC_API_BASE_URL: 'https://first.test.authrim.com'
			})
		).toBe('second.test.authrim.com');
	});

	it('uses the short-lived login tenant cookie for proxied auth requests', async () => {
		const { getForwardedHost } = await import('../hooks.server');
		const { LOGIN_TENANT_HOST_COOKIE } = await import('$lib/discovery-session');
		const event = {
			request: new Request('https://login.example.com/api/auth/authentication-methods'),
			url: new URL('https://login.example.com/api/auth/authentication-methods'),
			cookies: {
				get: (name: string) =>
					name === LOGIN_TENANT_HOST_COOKIE ? 'second.test.authrim.com' : undefined
			}
		};

		expect(
			getForwardedHost(event as never, {
				PUBLIC_API_BASE_URL: 'https://first.test.authrim.com'
			})
		).toBe('second.test.authrim.com');
	});

	it('uses the login tenant cookie before a router-provided Login UI original host', async () => {
		const { getForwardedHost } = await import('../hooks.server');
		const { LOGIN_TENANT_HOST_COOKIE } = await import('$lib/discovery-session');
		const event = {
			request: new Request('https://login.example.com/api/auth/authentication-methods', {
				headers: { 'x-authrim-original-host': 'login.example.com' }
			}),
			url: new URL('https://login.example.com/api/auth/authentication-methods'),
			cookies: {
				get: (name: string) =>
					name === LOGIN_TENANT_HOST_COOKIE ? 'second.test.authrim.com' : undefined
			}
		};

		expect(
			getForwardedHost(event as never, {
				PUBLIC_API_BASE_URL: 'https://first.test.authrim.com'
			})
		).toBe('second.test.authrim.com');
	});

	it('targets the forwarded tenant host when using the router service binding', async () => {
		const { resolveHumanVerificationProviderForRequest } = await import('../hooks.server');
		const fetch = vi.fn(async (_request: Request) =>
			Response.json(createAuthenticationMethodsResponse('turnstile'))
		);
		const event = {
			request: new Request('https://login.example.com/login?tenant_host=second.test.authrim.com'),
			url: new URL('https://login.example.com/login?tenant_host=second.test.authrim.com'),
			cookies: { get: () => undefined },
			getClientAddress: () => '192.0.2.10'
		};

		const provider = await resolveHumanVerificationProviderForRequest(event as never, {
			PUBLIC_API_BASE_URL: 'https://first.test.authrim.com',
			AR_ROUTER: { fetch }
		});

		expect(provider).toBe('turnstile');
		expect(fetch).toHaveBeenCalledTimes(1);
		const request = fetch.mock.calls[0][0];
		expect(request.url).toBe('https://second.test.authrim.com/api/auth/authentication-methods');
		expect(request.headers.get('x-authrim-forwarded-host')).toBe('second.test.authrim.com');
	});

	it('does not share a never-settling authentication methods loader across requests', async () => {
		const { getCachedAuthenticationMethods } =
			await import('$lib/server/authentication-methods-cache');
		let callCount = 0;
		let resolveFirstLoaderStarted: (() => void) | undefined;
		let resolveFirstLoader:
			| ((value: Awaited<ReturnType<typeof getCachedAuthenticationMethods>>) => void)
			| undefined;
		const firstLoaderStarted = new Promise<void>((resolve) => {
			resolveFirstLoaderStarted = resolve;
		});
		const loader = vi.fn(() => {
			callCount += 1;
			if (callCount === 1) {
				resolveFirstLoaderStarted?.();
				return new Promise<Awaited<ReturnType<typeof getCachedAuthenticationMethods>>>(
					(resolve) => {
						resolveFirstLoader = resolve;
					}
				);
			}

			return Promise.resolve(createAuthenticationMethodsResponse('turnstile') as never);
		});

		const first = getCachedAuthenticationMethods('tenant-a', loader);
		await firstLoaderStarted;

		const second = getCachedAuthenticationMethods('tenant-a', loader);
		const secondResult = await Promise.race([
			second,
			new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50))
		]);

		resolveFirstLoader?.(createAuthenticationMethodsResponse('hcaptcha') as never);
		await first;

		if (secondResult === 'timeout') {
			await second;
			throw new Error('second request waited on the first pending authentication methods loader');
		}

		expect(secondResult?.methods.humanVerification.provider).toBe('turnstile');
		expect(loader).toHaveBeenCalledTimes(2);
	});

	it('does not use the login tenant cookie for common discovery config requests', async () => {
		const { getForwardedHost } = await import('../hooks.server');
		const { LOGIN_TENANT_HOST_COOKIE } = await import('$lib/discovery-session');
		const event = {
			request: new Request('https://login.example.com/api/auth/discovery'),
			url: new URL('https://login.example.com/api/auth/discovery'),
			cookies: {
				get: (name: string) =>
					name === LOGIN_TENANT_HOST_COOKIE ? 'second.test.authrim.com' : undefined
			}
		};

		expect(
			getForwardedHost(event as never, {
				PUBLIC_API_BASE_URL: 'https://first.test.authrim.com'
			})
		).toBe('login.example.com');
	});

	it('adds Turnstile CSP origins only when Turnstile is enabled', async () => {
		const { buildContentSecurityPolicy } = await import('../hooks.server');

		const disabled = buildContentSecurityPolicy(undefined, null);
		const enabled = buildContentSecurityPolicy(undefined, 'turnstile');

		expect(disabled).not.toContain('https://challenges.cloudflare.com');
		expect(disabled).toContain('https://static.cloudflareinsights.com');
		expect(enabled).toContain(
			"script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://challenges.cloudflare.com"
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

	it('can build an auth-shell CSP that allows all supported CAPTCHA providers', async () => {
		const { buildContentSecurityPolicy } = await import('../hooks.server');

		const csp = buildContentSecurityPolicy(undefined, 'all');

		expect(csp).toContain('https://challenges.cloudflare.com');
		expect(csp).toContain('https://hcaptcha.com');
		expect(csp).toContain('https://*.hcaptcha.com');
		expect(csp).toContain('https://www.google.com');
		expect(csp).toContain('https://www.gstatic.com');
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
		expect(csp).toContain('https://static.cloudflareinsights.com');
	});

	it('caches the CSP human verification lookup per forwarded tenant host', async () => {
		const { resolveHumanVerificationProviderForRequest } = await import('../hooks.server');
		const event = {
			request: new Request('https://login.example.com/login', {
				headers: {
					'x-authrim-original-host': 'tenant.example.com'
				}
			}),
			url: new URL('https://login.example.com/login'),
			cookies: { get: () => undefined },
			getClientAddress: () => '192.0.2.10'
		};
		const fetch = vi.fn(async () =>
			Response.json(createAuthenticationMethodsResponse('turnstile'))
		);
		const platformEnv = {
			PUBLIC_API_BASE_URL: 'https://api.example.com',
			AR_ROUTER: { fetch }
		};

		const first = await resolveHumanVerificationProviderForRequest(event as never, platformEnv);
		const second = await resolveHumanVerificationProviderForRequest(event as never, platformEnv);

		expect(first).toBe('turnstile');
		expect(second).toBe('turnstile');
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('does not share cached CSP human verification lookups across tenant hosts', async () => {
		const { resolveHumanVerificationProviderForRequest } = await import('../hooks.server');
		const platformEnv = {
			PUBLIC_API_BASE_URL: 'https://api.example.com',
			AR_ROUTER: {
				fetch: vi
					.fn()
					.mockResolvedValueOnce(Response.json(createAuthenticationMethodsResponse('turnstile')))
					.mockResolvedValueOnce(Response.json(createAuthenticationMethodsResponse('hcaptcha')))
			}
		};
		const firstEvent = {
			request: new Request('https://login.example.com/login', {
				headers: { 'x-authrim-original-host': 'first.example.com' }
			}),
			url: new URL('https://login.example.com/login'),
			cookies: { get: () => undefined },
			getClientAddress: () => '192.0.2.10'
		};
		const secondEvent = {
			request: new Request('https://login.example.com/login', {
				headers: { 'x-authrim-original-host': 'second.example.com' }
			}),
			url: new URL('https://login.example.com/login'),
			cookies: { get: () => undefined },
			getClientAddress: () => '192.0.2.10'
		};

		const first = await resolveHumanVerificationProviderForRequest(
			firstEvent as never,
			platformEnv
		);
		const second = await resolveHumanVerificationProviderForRequest(
			secondEvent as never,
			platformEnv
		);

		expect(first).toBe('turnstile');
		expect(second).toBe('hcaptcha');
		expect(platformEnv.AR_ROUTER.fetch).toHaveBeenCalledTimes(2);
	});

	it('does not share pending CSP human verification lookups across concurrent requests', async () => {
		const { resolveHumanVerificationProviderForRequest } = await import('../hooks.server');
		const event = {
			request: new Request('https://login.example.com/login', {
				headers: {
					'x-authrim-original-host': 'tenant.example.com'
				}
			}),
			url: new URL('https://login.example.com/login'),
			cookies: { get: () => undefined },
			getClientAddress: () => '192.0.2.10'
		};
		const fetch = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					setTimeout(
						() => resolve(Response.json(createAuthenticationMethodsResponse('recaptcha'))),
						1
					);
				})
		);
		const platformEnv = {
			PUBLIC_API_BASE_URL: 'https://api.example.com',
			AR_ROUTER: { fetch }
		};

		const [first, second] = await Promise.all([
			resolveHumanVerificationProviderForRequest(event as never, platformEnv),
			resolveHumanVerificationProviderForRequest(event as never, platformEnv)
		]);

		expect(first).toBe('recaptcha');
		expect(second).toBe('recaptcha');
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
