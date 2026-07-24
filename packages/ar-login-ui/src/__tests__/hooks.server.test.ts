import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

function createAuthenticationMethodsResponse(
	provider: 'turnstile' | 'hcaptcha' | 'recaptcha' = 'turnstile',
	enabled = true,
	emailCodeUsage: {
		enabled?: boolean;
		loginEnabled?: boolean;
		signupEnabled?: boolean;
	} = {}
) {
	return {
		methods: {
			emailCode: {
				enabled: emailCodeUsage.enabled ?? false,
				loginEnabled: emailCodeUsage.loginEnabled ?? false,
				signupEnabled: emailCodeUsage.signupEnabled ?? false,
				steps: ['email']
			},
			humanVerification: {
				enabled,
				provider,
				siteKey: enabled ? 'site-key' : null
			}
		},
		meta: {
			cacheTTL: 60,
			revision: 'test'
		}
	};
}

const VALID_ORIGIN_TRIAL_TOKEN = 'A'.repeat(128);

async function runAuthPageRequest(options: {
	pathname: string;
	method?: 'GET' | 'HEAD' | 'POST';
	emailCodeUsage?: {
		enabled?: boolean;
		loginEnabled?: boolean;
		signupEnabled?: boolean;
	};
	platformEnv?: Record<string, unknown>;
	requestHeaders?: Record<string, string>;
	responseContentType?: string;
}) {
	const { emailVerificationOriginTrialHandle } = await import('../hooks.server');
	const url = new URL(options.pathname, 'https://login.example.com');
	const request = new Request(url, {
		method: options.method ?? 'GET',
		headers: options.requestHeaders
	});
	const locals: App.Locals = {
		authenticationMethods: createAuthenticationMethodsResponse(
			'turnstile',
			true,
			options.emailCodeUsage
		) as never
	};
	const event = {
		request,
		url,
		locals,
		platform: { env: options.platformEnv },
		cookies: {
			get: () => undefined,
			set: vi.fn()
		},
		getClientAddress: () => '192.0.2.10'
	};
	let enabledDuringResolve: boolean | undefined;
	const response = await emailVerificationOriginTrialHandle({
		event: event as never,
		resolve: async (resolvedEvent) => {
			enabledDuringResolve = resolvedEvent.locals.emailVerificationProtocolEnabled;
			return new Response(options.method === 'HEAD' ? null : '<!doctype html>', {
				headers: {
					'Content-Type': options.responseContentType ?? 'text/html; charset=utf-8'
				}
			});
		}
	});

	return { response, locals, enabledDuringResolve };
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

	it('applies the detected browser locale to the initial document language', async () => {
		const { localeHandle } = await import('../hooks.server');
		const url = new URL('https://login.example.com/login');
		const event = {
			request: new Request(url, { headers: { 'Accept-Language': 'zh-Hant-TW,ja;q=0.8' } }),
			url,
			locals: {
				authenticationMethods: {
					ui: {
						theme: 'dark',
						variant: 'navy',
						pageTemplate: { backgroundColor: '#112233' }
					}
				}
			},
			cookies: { get: () => undefined }
		};
		let renderedHtml = '';

		await localeHandle({
			event: event as never,
			resolve: async (_event, options) => {
				const transformedHtml = await options?.transformPageChunk?.({
					html: '<html lang="__AUTHRIM_DOCUMENT_LANGUAGE__" style="background: __AUTHRIM_INITIAL_BACKGROUND__; color-scheme: __AUTHRIM_INITIAL_COLOR_SCHEME__"></html>',
					done: true
				});
				renderedHtml = transformedHtml ?? '';
				return new Response(renderedHtml, { headers: { 'Content-Type': 'text/html' } });
			}
		});

		expect(event.locals).toMatchObject({ locale: 'zh-TW' });
		expect(renderedHtml).toContain('<html lang="zh-TW"');
		expect(renderedHtml).toContain('background: #112233; color-scheme: dark');
		expect(renderedHtml).not.toContain('__AUTHRIM_INITIAL_');
	});

	it('honors Accept-Language quality values and ignores excluded languages', async () => {
		const { localeHandle } = await import('../hooks.server');
		const url = new URL('https://login.example.com/login');
		const event = {
			request: new Request(url, {
				headers: { 'Accept-Language': 'en;q=0, fr;q=0.4, de-DE;q=0.9' }
			}),
			url,
			locals: {},
			cookies: { get: () => undefined }
		};

		await localeHandle({
			event: event as never,
			resolve: async () => new Response('ok')
		});

		expect(event.locals).toMatchObject({ locale: 'de' });
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
		const fetch = vi.fn(async (_input: Request | string, _init?: RequestInit) =>
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
		const [input, init] = fetch.mock.calls[0];
		expect(input).toBe('https://second.test.authrim.com/api/auth/authentication-methods');
		expect(new Headers(init?.headers).get('x-authrim-forwarded-host')).toBe(
			'second.test.authrim.com'
		);
	});

	it('fetches the Login UI theme before rendering an auth page', async () => {
		const { fetchAuthenticationMethodsForPageRequest, shouldPrefetchLoginUITheme } =
			await import('../hooks.server');
		const fetch = vi.fn(async (_input: Request | string, _init?: RequestInit) =>
			Response.json(createAuthenticationMethodsResponse('turnstile'))
		);
		const event = {
			request: new Request('https://login.example.com/login?tenant_host=second.test.authrim.com'),
			url: new URL('https://login.example.com/login?tenant_host=second.test.authrim.com'),
			cookies: { get: () => undefined },
			getClientAddress: () => '192.0.2.10'
		};

		const result = await fetchAuthenticationMethodsForPageRequest(event as never, {
			PUBLIC_API_BASE_URL: 'https://first.test.authrim.com',
			AR_ROUTER: { fetch }
		});

		expect(result?.meta.revision).toBe('test');
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0][0]).toBe(
			'https://second.test.authrim.com/api/auth/authentication-methods'
		);
		expect(shouldPrefetchLoginUITheme('/login')).toBe(true);
		expect(shouldPrefetchLoginUITheme('/discover')).toBe(false);
	});

	it('bootstraps the configured theme for plain login and signup documents', async () => {
		const { resolveInitialLoginUIAppearance, shouldBootstrapLoginUITheme } =
			await import('../hooks.server');

		expect(shouldBootstrapLoginUITheme('/login')).toBe(true);
		expect(shouldBootstrapLoginUITheme('/signup')).toBe(true);
		expect(shouldBootstrapLoginUITheme('/discover')).toBe(false);
		expect(
			resolveInitialLoginUIAppearance({
				ui: {
					theme: 'dark',
					variant: 'navy',
					pageTemplate: { backgroundColor: '#112233' }
				}
			} as never)
		).toEqual({ background: '#112233', colorScheme: 'dark' });
		expect(resolveInitialLoginUIAppearance(null)).toEqual({
			background: '#eeeae3',
			colorScheme: 'light'
		});
	});

	it('skips server-side theme bootstrap for same-origin plain /login', async () => {
		const { shouldBootstrapLoginUIThemeForRequest } = await import('../hooks.server');
		const url = new URL('https://first.test.authrim.com/login');
		const event = {
			request: new Request(url),
			url,
			platform: {
				env: {
					PUBLIC_API_BASE_URL: 'https://first.test.authrim.com',
					PUBLIC_AUTHRIM_ISSUER: 'https://first.test.authrim.com'
				}
			},
			cookies: { get: () => undefined }
		};

		expect(
			shouldBootstrapLoginUIThemeForRequest(event as never, {
				PUBLIC_API_BASE_URL: 'https://first.test.authrim.com',
				PUBLIC_AUTHRIM_ISSUER: 'https://first.test.authrim.com'
			})
		).toBe(false);
	});

	it('keeps server-side theme bootstrap for protocol login and signup documents', async () => {
		const { shouldBootstrapLoginUIThemeForRequest } = await import('../hooks.server');
		const loginUrl = new URL('https://first.test.authrim.com/login?challenge_id=challenge-1');
		const signupUrl = new URL('https://first.test.authrim.com/signup');
		const platformEnv = {
			PUBLIC_API_BASE_URL: 'https://first.test.authrim.com',
			PUBLIC_AUTHRIM_ISSUER: 'https://first.test.authrim.com'
		};

		expect(
			shouldBootstrapLoginUIThemeForRequest(
				{
					request: new Request(loginUrl),
					url: loginUrl,
					platform: { env: platformEnv },
					cookies: { get: () => undefined }
				} as never,
				platformEnv
			)
		).toBe(true);
		expect(
			shouldBootstrapLoginUIThemeForRequest(
				{
					request: new Request(signupUrl),
					url: signupUrl,
					platform: { env: platformEnv },
					cookies: { get: () => undefined }
				} as never,
				platformEnv
			)
		).toBe(true);
	});

	it('keeps plain /login theme bootstrap when an Origin-Trial token is configured', async () => {
		const { shouldBootstrapLoginUIThemeForRequest } = await import('../hooks.server');
		const url = new URL('https://first.test.authrim.com/login');
		const event = {
			request: new Request(url),
			url,
			platform: {
				env: {
					PUBLIC_API_BASE_URL: 'https://first.test.authrim.com',
					EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKEN: VALID_ORIGIN_TRIAL_TOKEN
				}
			},
			cookies: { get: () => undefined }
		};

		expect(
			shouldBootstrapLoginUIThemeForRequest(event as never, {
				PUBLIC_API_BASE_URL: 'https://first.test.authrim.com',
				EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKEN: VALID_ORIGIN_TRIAL_TOKEN
			})
		).toBe(true);
	});

	it('resolves the challenge client before fetching an overridden Login UI theme', async () => {
		const {
			fetchAuthenticationMethodsForPageRequest,
			fetchLoginChallengeThemeTargetForPageRequest
		} = await import('../hooks.server');
		const fetch = vi.fn(async (input: Request | string, _init?: RequestInit) =>
			String(input).includes('/auth/login-challenge')
				? Response.json({ client: { client_id: 'client-123' } })
				: Response.json(createAuthenticationMethodsResponse('turnstile'))
		);
		const event = {
			request: new Request(
				'https://login.example.com/login?tenant_host=second.test.authrim.com&challenge_id=challenge-1'
			),
			url: new URL(
				'https://login.example.com/login?tenant_host=second.test.authrim.com&challenge_id=challenge-1'
			),
			cookies: { get: () => undefined },
			getClientAddress: () => '192.0.2.10'
		};
		const platformEnv = {
			PUBLIC_API_BASE_URL: 'https://first.test.authrim.com',
			AR_ROUTER: { fetch }
		};

		const target = await fetchLoginChallengeThemeTargetForPageRequest(event as never, platformEnv);
		await fetchAuthenticationMethodsForPageRequest(event as never, platformEnv, target?.clientId);

		expect(target).toEqual({ challengeId: 'challenge-1', valid: true, clientId: 'client-123' });
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[1][0]).toBe(
			'https://second.test.authrim.com/api/auth/authentication-methods?client_id=client-123'
		);
	});

	it('accepts DCR-generated client identifiers up to the shared 256-character limit', async () => {
		const { fetchLoginChallengeThemeTargetForPageRequest } = await import('../hooks.server');
		const clientId = `client_${'a'.repeat(128)}`;
		const fetch = vi.fn(async () => Response.json({ client: { client_id: clientId } }));
		const event = {
			request: new Request(
				'https://login.example.com/login?tenant_host=second.test.authrim.com&challenge_id=challenge-dcr'
			),
			url: new URL(
				'https://login.example.com/login?tenant_host=second.test.authrim.com&challenge_id=challenge-dcr'
			),
			cookies: { get: () => undefined },
			getClientAddress: () => '192.0.2.10'
		};

		const target = await fetchLoginChallengeThemeTargetForPageRequest(event as never, {
			PUBLIC_API_BASE_URL: 'https://first.test.authrim.com',
			AR_ROUTER: { fetch }
		});

		expect(target).toEqual({ challengeId: 'challenge-dcr', valid: true, clientId });
	});

	it('rejects challenge client identifiers above the shared 256-character limit', async () => {
		const { fetchLoginChallengeThemeTargetForPageRequest } = await import('../hooks.server');
		const fetch = vi.fn(async () =>
			Response.json({ client: { client_id: `client_${'a'.repeat(250)}` } })
		);
		const event = {
			request: new Request(
				'https://login.example.com/login?tenant_host=second.test.authrim.com&challenge_id=challenge-too-long'
			),
			url: new URL(
				'https://login.example.com/login?tenant_host=second.test.authrim.com&challenge_id=challenge-too-long'
			),
			cookies: { get: () => undefined },
			getClientAddress: () => '192.0.2.10'
		};

		const target = await fetchLoginChallengeThemeTargetForPageRequest(event as never, {
			PUBLIC_API_BASE_URL: 'https://first.test.authrim.com',
			AR_ROUTER: { fetch }
		});

		expect(target).toEqual({
			challengeId: 'challenge-too-long',
			valid: false,
			clientId: null
		});
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

	it.each([
		{
			label: 'GET /login with an exact origin token',
			pathname: '/login',
			method: 'GET' as const,
			emailCodeUsage: { enabled: true, loginEnabled: true },
			tokenMapKey: 'https://login.example.com'
		},
		{
			label: 'HEAD /signup with an exact origin token',
			pathname: '/signup',
			method: 'HEAD' as const,
			emailCodeUsage: { enabled: true, signupEnabled: true },
			tokenMapKey: 'https://login.example.com'
		}
	])(
		'adds Origin-Trial and enables the protocol for $label',
		async ({ pathname, method, emailCodeUsage, tokenMapKey }) => {
			const result = await runAuthPageRequest({
				pathname,
				method,
				emailCodeUsage,
				platformEnv: {
					EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKENS: JSON.stringify({
						[tokenMapKey]: `  ${VALID_ORIGIN_TRIAL_TOKEN}  `
					})
				}
			});

			expect(result.response.headers.get('Origin-Trial')).toBe(VALID_ORIGIN_TRIAL_TOKEN);
			expect(result.enabledDuringResolve).toBe(true);
			expect(result.locals.emailVerificationProtocolEnabled).toBe(true);
		}
	);

	it('uses the single-origin fallback token when no token map is configured', async () => {
		const result = await runAuthPageRequest({
			pathname: '/login',
			emailCodeUsage: { enabled: true, loginEnabled: true },
			platformEnv: {
				EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKEN: VALID_ORIGIN_TRIAL_TOKEN
			}
		});

		expect(result.response.headers.get('Origin-Trial')).toBe(VALID_ORIGIN_TRIAL_TOKEN);
		expect(result.enabledDuringResolve).toBe(true);
	});

	it('matches a router-proxied page against its exact original browser origin', async () => {
		const result = await runAuthPageRequest({
			pathname: '/login',
			emailCodeUsage: { enabled: true, loginEnabled: true },
			requestHeaders: {
				'x-authrim-original-host': 'tenant.example.com'
			},
			platformEnv: {
				EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKENS: JSON.stringify({
					'https://tenant.example.com': VALID_ORIGIN_TRIAL_TOKEN
				})
			}
		});

		expect(result.response.headers.get('Origin-Trial')).toBe(VALID_ORIGIN_TRIAL_TOKEN);
		expect(result.enabledDuringResolve).toBe(true);
	});

	it('does not enable the protocol when Mail OTP is disabled for the page usage', async () => {
		const result = await runAuthPageRequest({
			pathname: '/login',
			emailCodeUsage: { enabled: true, loginEnabled: false, signupEnabled: true },
			platformEnv: {
				EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKENS: JSON.stringify({
					'https://login.example.com': VALID_ORIGIN_TRIAL_TOKEN
				})
			}
		});

		expect(result.response.headers.get('Origin-Trial')).toBeNull();
		expect(result.enabledDuringResolve).toBe(false);
		expect(result.locals.emailVerificationProtocolEnabled).toBe(false);
	});

	it('does not use a map token or fallback token for the wrong origin', async () => {
		const result = await runAuthPageRequest({
			pathname: '/login',
			emailCodeUsage: { enabled: true, loginEnabled: true },
			platformEnv: {
				EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKENS: JSON.stringify({
					'https://other.example.com': VALID_ORIGIN_TRIAL_TOKEN
				}),
				EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKEN: VALID_ORIGIN_TRIAL_TOKEN
			}
		});

		expect(result.response.headers.get('Origin-Trial')).toBeNull();
		expect(result.enabledDuringResolve).toBe(false);
	});

	it('rejects an invalid origin trial token without writing a response header', async () => {
		const result = await runAuthPageRequest({
			pathname: '/signup',
			emailCodeUsage: { enabled: true, signupEnabled: true },
			platformEnv: {
				EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKENS: JSON.stringify({
					'https://login.example.com': `${VALID_ORIGIN_TRIAL_TOKEN}\r\nInjected: value`
				})
			}
		});

		expect(result.response.headers.get('Origin-Trial')).toBeNull();
		expect(result.enabledDuringResolve).toBe(false);
	});

	it('does not enable the protocol on unrelated paths', async () => {
		const result = await runAuthPageRequest({
			pathname: '/reauth',
			emailCodeUsage: { enabled: true, loginEnabled: true, signupEnabled: true },
			platformEnv: {
				EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKEN: VALID_ORIGIN_TRIAL_TOKEN
			}
		});

		expect(result.response.headers.get('Origin-Trial')).toBeNull();
		expect(result.enabledDuringResolve).toBe(false);
	});

	it('does not attach Origin-Trial to a non-document response', async () => {
		const result = await runAuthPageRequest({
			pathname: '/login',
			emailCodeUsage: { enabled: true, loginEnabled: true },
			platformEnv: {
				EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKEN: VALID_ORIGIN_TRIAL_TOKEN
			},
			responseContentType: 'application/json'
		});

		expect(result.response.headers.get('Origin-Trial')).toBeNull();
		expect(result.enabledDuringResolve).toBe(true);
	});

	it('exposes the hook decision through root layout data', async () => {
		const { load } = await import('../routes/+layout.server');
		const data = await load({
			cookies: { get: () => undefined },
			route: { id: '/login' },
			locals: {
				emailVerificationProtocolEnabled: true,
				authenticationMethods: null
			}
		} as never);

		expect(data).toMatchObject({
			emailVerificationProtocolEnabled: true,
			authenticationMethods: null
		});
	});
});
