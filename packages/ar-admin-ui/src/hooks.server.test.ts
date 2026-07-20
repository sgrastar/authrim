import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	apiProxy,
	buildProxyHeaders,
	clearBffAdminAccessTokenCacheForTests,
	securityHeaders
} from './hooks.server';

function getSetCookies(headers: Headers): string[] {
	const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
	return withGetSetCookie.getSetCookie?.() ?? [headers.get('set-cookie')].filter(Boolean);
}

function base64FromArrayBuffer(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

async function generateEs256PrivateKeyPem(): Promise<string> {
	const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign',
		'verify'
	]);
	const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
	const base64 = base64FromArrayBuffer(pkcs8).replace(/(.{64})/g, '$1\n');
	return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

async function createBffEnv() {
	return {
		ADMIN_UI_BFF_CLIENT_ID: 'admin-ui-bff',
		ADMIN_UI_BFF_KEY_ID: 'bff-key-1',
		ADMIN_UI_BFF_PRIVATE_KEY_PEM: await generateEs256PrivateKeyPem()
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	clearBffAdminAccessTokenCacheForTests();
});

describe('buildProxyHeaders', () => {
	it('forwards safe Admin headers to the backend proxy target', () => {
		const event = {
			url: new URL('https://mt-ar-admin-ui.pages.dev/api/admin/stats'),
			request: new Request('https://mt-ar-admin-ui.pages.dev/api/admin/stats', {
				headers: {
					Host: 'mt-ar-admin-ui.pages.dev',
					Origin: 'https://mt-ar-admin-ui.pages.dev',
					Referer: 'https://mt-ar-admin-ui.pages.dev/api/admin/stats',
					'X-Session-Id': 'session-123',
					'X-Request-Id': 'req-browser-1',
					'X-Tenant-Id': 'first',
					Authorization: 'Bearer browser-token',
					'X-Forwarded-Host': 'attacker.example',
					Cookie: 'theme=dark; authrim_admin_session=session-123; analytics_id=abc'
				}
			}),
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof buildProxyHeaders>[0];

		const headers = buildProxyHeaders(
			event,
			'multi-tenant.authrim.com',
			'https://api.authrim.example'
		);

		expect(headers.get('X-Tenant-Id')).toBe('first');
		expect(headers.get('X-Session-Id')).toBeNull();
		expect(headers.get('Authorization')).toBeNull();
		expect(headers.get('Origin')).toBe('https://api.authrim.example');
		expect(headers.get('Referer')).toBe('https://api.authrim.example/api/admin/stats');
		expect(headers.get('X-Authrim-Forwarded-Origin')).toBe('https://mt-ar-admin-ui.pages.dev');
		expect(headers.get('X-Request-Id')).toBe('req-browser-1');
		expect(headers.get('X-Forwarded-Host')).toBe('multi-tenant.authrim.com');
		expect(headers.get('X-Authrim-Admin-UI-Api-Mode')).toBe('cross-site-proxy-bff');
		expect(headers.get('Cookie')).toBe('authrim_admin_session=session-123');
	});
});

describe('securityHeaders', () => {
	it('marks HTML shell responses as non-cacheable', async () => {
		const resolve = vi.fn(
			async () =>
				new Response('<!doctype html><html><body>Admin</body></html>', {
					headers: { 'content-type': 'text/html; charset=utf-8' }
				})
		);
		const event = {
			url: new URL('https://mt-ar-admin-ui.pages.dev/admin/login'),
			request: new Request('https://mt-ar-admin-ui.pages.dev/admin/login', {
				method: 'GET'
			}),
			platform: { env: {} },
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof securityHeaders>[0]['event'];

		const response = await securityHeaders({ event, resolve });

		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(response.headers.get('Pragma')).toBe('no-cache');
		expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
	});
});

describe('apiProxy', () => {
	it('serves the explicit Admin UI dev mock only on loopback origins', async () => {
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL('http://localhost:5173/api/admin/me/session'),
			request: new Request('http://localhost:5173/api/admin/me/session', {
				method: 'GET'
			}),
			platform: {
				env: {
					AUTHRIM_ADMIN_UI_DEV_MOCK: 'true'
				}
			},
			getClientAddress: () => '127.0.0.1'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const response = await apiProxy({ event, resolve });

		expect(response.status).toBe(200);
		expect(response.headers.get('X-Authrim-Dev-Mock')).toBe('admin-ui');
		expect(await response.json()).toMatchObject({
			active: true,
			user_id: 'dev-admin',
			tenant_id: 'dev-tenant',
			is_platform_admin: true
		});
		expect(resolve).not.toHaveBeenCalled();
	});

	it('does not serve the Admin UI dev mock on non-loopback origins', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL('https://mt-ar-admin-ui.pages.dev/api/admin/me/session'),
			request: new Request('https://mt-ar-admin-ui.pages.dev/api/admin/me/session', {
				method: 'GET'
			}),
			platform: {
				env: {
					AUTHRIM_ADMIN_UI_DEV_MOCK: 'true'
				}
			},
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const response = await apiProxy({ event, resolve });

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: 'proxy_not_configured' });
		expect(resolve).not.toHaveBeenCalled();
	});

	it('does not serve the Admin UI dev mock when NODE_ENV is production', async () => {
		const previousNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'production';
		try {
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const resolve = vi.fn(async () => new Response('resolved'));
			const event = {
				url: new URL('http://localhost:5173/api/admin/me/session'),
				request: new Request('http://localhost:5173/api/admin/me/session', {
					method: 'GET'
				}),
				platform: {
					env: {
						AUTHRIM_ADMIN_UI_DEV_MOCK: 'true'
					}
				},
				getClientAddress: () => '127.0.0.1'
			} as unknown as Parameters<typeof apiProxy>[0]['event'];

			const response = await apiProxy({ event, resolve });

			expect(response.status).toBe(500);
			expect(await response.json()).toMatchObject({ error: 'proxy_not_configured' });
			expect(resolve).not.toHaveBeenCalled();
		} finally {
			process.env.NODE_ENV = previousNodeEnv;
		}
	});

	it('fails closed for Admin API proxy requests without Service Binding or local opt-in', async () => {
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL('https://mt-ar-admin-ui.pages.dev/api/admin/stats'),
			request: new Request('https://mt-ar-admin-ui.pages.dev/api/admin/stats', {
				method: 'GET'
			}),
			platform: {
				env: {
					API_BACKEND_URL: 'https://api.authrim.example'
				}
			},
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const response = await apiProxy({ event, resolve });

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: 'proxy_not_configured' });
		expect(consoleWarn).toHaveBeenCalledWith(
			'Admin UI BFF security event',
			expect.objectContaining({
				event: 'authrim_admin_ui_bff_security',
				event_type: 'proxy_not_configured',
				result: 'rejected',
				status: 500
			})
		);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('does not enable local proxy opt-in for non-loopback backend URLs', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL('https://mt-ar-admin-ui.pages.dev/api/admin/stats'),
			request: new Request('https://mt-ar-admin-ui.pages.dev/api/admin/stats', {
				method: 'GET'
			}),
			platform: {
				env: {
					AUTHRIM_ALLOW_LOCAL_ADMIN_PROXY: 'true',
					API_BACKEND_URL: 'https://api.authrim.example'
				}
			},
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const response = await apiProxy({ event, resolve });

		expect(response.status).toBe(500);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('allows explicit local proxy opt-in only to loopback backend URLs', async () => {
		const fetch = vi.fn(async (_url: string | URL | Request) => new Response('local'));
		vi.stubGlobal('fetch', fetch);
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL('http://localhost:5173/api/admin/stats'),
			request: new Request('http://localhost:5173/api/admin/stats', {
				method: 'GET'
			}),
			platform: {
				env: {
					AUTHRIM_ALLOW_LOCAL_ADMIN_PROXY: 'true',
					API_BACKEND_URL: 'http://127.0.0.1:8786'
				}
			},
			getClientAddress: () => '127.0.0.1'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const response = await apiProxy({ event, resolve });

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('local');
		expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:8786/api/admin/stats');
		expect(resolve).not.toHaveBeenCalled();
	});

	it('uses Admin UI BFF machine token for fixed HTTPS upstream proxying', async () => {
		const bffEnv = await createBffEnv();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						access_token: 'bff-machine-access-token',
						token_type: 'Bearer',
						expires_in: 600
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				)
			)
			.mockResolvedValueOnce(new Response('proxied'));
		vi.stubGlobal('fetch', fetch);
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL('https://mt-ar-admin-ui.pages.dev/api/admin/stats'),
			request: new Request('https://mt-ar-admin-ui.pages.dev/api/admin/stats', {
				method: 'GET',
				headers: {
					Authorization: 'Bearer browser-supplied-token',
					Cookie: 'authrim_admin_session=session-123',
					'X-Tenant-Id': 'first'
				}
			}),
			platform: {
				env: {
					API_BACKEND_URL: 'https://api.authrim.example',
					...bffEnv
				}
			},
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const response = await apiProxy({ event, resolve });

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('proxied');
		const tokenRequest = fetch.mock.calls[0][0] as Request;
		expect(tokenRequest.url).toBe('https://api.authrim.example/token');
		expect(tokenRequest.headers.get('X-Tenant-Id')).toBe('first');
		const tokenBody = new URLSearchParams(await tokenRequest.clone().text());
		expect(tokenBody.get('grant_type')).toBe('client_credentials');
		expect(tokenBody.get('client_id')).toBe('admin-ui-bff');
		expect(tokenBody.get('audience')).toBe('authrim:admin-api');
		expect(tokenBody.get('scope')).toBe('admin-ui:proxy');
		expect(tokenBody.get('client_assertion_type')).toBe(
			'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
		);

		const proxiedRequestUrl = fetch.mock.calls[1][0] as string;
		const proxiedRequestInit = fetch.mock.calls[1][1] as RequestInit;
		const proxiedHeaders = proxiedRequestInit.headers as Headers;
		expect(proxiedRequestUrl).toBe('https://api.authrim.example/api/admin/stats');
		expect(proxiedHeaders.get('Authorization')).toBe('Bearer bff-machine-access-token');
		expect(proxiedHeaders.get('X-Authrim-Admin-UI-Api-Mode')).toBe('cross-site-proxy-bff');
		expect(proxiedHeaders.get('Cookie')).toBe('authrim_admin_session=session-123');
		expect(resolve).not.toHaveBeenCalled();
	});

	it('does not require a BFF machine token for Admin passkey bootstrap options', async () => {
		const bffEnv = await createBffEnv();
		const fetch = vi.fn().mockResolvedValueOnce(new Response('options'));
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL('https://mt-ar-admin-ui.pages.dev/api/admin/auth/passkey/options'),
			request: new Request('https://mt-ar-admin-ui.pages.dev/api/admin/auth/passkey/options', {
				method: 'POST',
				headers: {
					Origin: 'https://mt-ar-admin-ui.pages.dev',
					'Content-Type': 'application/json'
				},
				body: '{}'
			}),
			platform: {
				env: {
					AR_ROUTER: { fetch },
					PUBLIC_AUTHRIM_ISSUER: 'https://api.authrim.example',
					...bffEnv
				}
			},
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const response = await apiProxy({ event, resolve });
		const proxiedRequest = fetch.mock.calls[0][0] as Request;

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('options');
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(proxiedRequest.url).toBe('https://api.authrim.example/api/admin/auth/passkey/options');
		expect(proxiedRequest.headers.get('Authorization')).toBeNull();
		expect(proxiedRequest.headers.get('X-Authrim-Admin-UI-Api-Mode')).toBe('cross-site-proxy-bff');
		expect(proxiedRequest.headers.get('X-Authrim-Forwarded-Origin')).toBe(
			'https://mt-ar-admin-ui.pages.dev'
		);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('does not require a BFF machine token for Admin invitation enrollment', async () => {
		const bffEnv = await createBffEnv();
		const fetch = vi.fn().mockResolvedValueOnce(new Response('redeemed'));
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL('https://mt-ar-admin-ui.pages.dev/api/admin/invitations/redeem'),
			request: new Request('https://mt-ar-admin-ui.pages.dev/api/admin/invitations/redeem', {
				method: 'POST',
				headers: {
					Origin: 'https://mt-ar-admin-ui.pages.dev',
					'Content-Type': 'application/json'
				},
				body: '{}'
			}),
			platform: {
				env: {
					AR_ROUTER: { fetch },
					PUBLIC_AUTHRIM_ISSUER: 'https://api.authrim.example',
					...bffEnv
				}
			},
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const response = await apiProxy({ event, resolve });
		const proxiedRequest = fetch.mock.calls[0][0] as Request;

		expect(response.status).toBe(200);
		expect(proxiedRequest.url).toBe('https://api.authrim.example/api/admin/invitations/redeem');
		expect(proxiedRequest.headers.get('Authorization')).toBeNull();
		expect(proxiedRequest.headers.get('X-Authrim-Forwarded-Origin')).toBe(
			'https://mt-ar-admin-ui.pages.dev'
		);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('reuses cached BFF machine tokens for protected Admin API requests', async () => {
		const bffEnv = await createBffEnv();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						access_token: 'cached-bff-token',
						token_type: 'Bearer',
						expires_in: 600
					}),
					{ headers: { 'content-type': 'application/json' } }
				)
			)
			.mockResolvedValue(new Response('proxied'));
		const resolve = vi.fn(async () => new Response('resolved'));
		const env = {
			AR_ROUTER: { fetch },
			PUBLIC_AUTHRIM_ISSUER: 'https://api.authrim.example',
			...bffEnv
		};
		const createEvent = (path: string) =>
			({
				url: new URL(`https://mt-ar-admin-ui.pages.dev${path}`),
				request: new Request(`https://mt-ar-admin-ui.pages.dev${path}`, {
					method: 'GET',
					headers: {
						Cookie: 'authrim_admin_session=session-123',
						'X-Tenant-Id': 'first'
					}
				}),
				platform: { env },
				getClientAddress: () => '203.0.113.10'
			}) as unknown as Parameters<typeof apiProxy>[0]['event'];

		await apiProxy({ event: createEvent('/api/admin/stats'), resolve });
		await apiProxy({ event: createEvent('/api/admin/me/session'), resolve });

		expect(fetch).toHaveBeenCalledTimes(3);
		expect((fetch.mock.calls[0][0] as Request).url).toBe('https://api.authrim.example/token');
		expect((fetch.mock.calls[1][0] as Request).headers.get('Authorization')).toBe(
			'Bearer cached-bff-token'
		);
		expect((fetch.mock.calls[2][0] as Request).headers.get('Authorization')).toBe(
			'Bearer cached-bff-token'
		);
	});

	it('does not share a pending BFF machine token request across proxy requests', async () => {
		const bffEnv = await createBffEnv();
		let tokenRequestCount = 0;
		let markFirstTokenStarted: (() => void) | undefined;
		let markSecondTokenStarted: (() => void) | undefined;
		let resolveFirstToken: ((response: Response) => void) | undefined;
		const firstTokenStarted = new Promise<void>((resolve) => {
			markFirstTokenStarted = resolve;
		});
		const secondTokenStarted = new Promise<void>((resolve) => {
			markSecondTokenStarted = resolve;
		});
		const fetch = vi.fn((request: Request) => {
			if (request.url === 'https://api.authrim.example/token') {
				tokenRequestCount += 1;
				if (tokenRequestCount === 1) {
					markFirstTokenStarted?.();
					return new Promise<Response>((resolve) => {
						resolveFirstToken = resolve;
					});
				}

				markSecondTokenStarted?.();
				return Promise.resolve(
					new Response(
						JSON.stringify({
							access_token: 'second-bff-token',
							token_type: 'Bearer',
							expires_in: 600
						}),
						{ headers: { 'content-type': 'application/json' } }
					)
				);
			}

			return Promise.resolve(new Response(request.headers.get('Authorization') ?? 'missing token'));
		});
		const resolve = vi.fn(async () => new Response('resolved'));
		const env = {
			AR_ROUTER: { fetch },
			PUBLIC_AUTHRIM_ISSUER: 'https://api.authrim.example',
			...bffEnv
		};
		const createEvent = (path: string) =>
			({
				url: new URL(`https://mt-ar-admin-ui.pages.dev${path}`),
				request: new Request(`https://mt-ar-admin-ui.pages.dev${path}`, {
					method: 'GET',
					headers: {
						Cookie: 'authrim_admin_session=session-123',
						'X-Tenant-Id': 'first'
					}
				}),
				platform: { env },
				getClientAddress: () => '203.0.113.10'
			}) as unknown as Parameters<typeof apiProxy>[0]['event'];

		const firstResponsePromise = apiProxy({
			event: createEvent('/api/admin/stats'),
			resolve
		});
		await firstTokenStarted;

		const secondResponsePromise = apiProxy({
			event: createEvent('/api/admin/me/session'),
			resolve
		});
		let secondTokenTimeout: ReturnType<typeof setTimeout> | undefined;
		const observedSecondTokenRequest = await Promise.race([
			secondTokenStarted.then(() => true),
			new Promise<false>((resolveTimeout) => {
				secondTokenTimeout = setTimeout(() => resolveTimeout(false), 1000);
			})
		]);
		if (secondTokenTimeout) clearTimeout(secondTokenTimeout);
		if (!observedSecondTokenRequest) {
			resolveFirstToken?.(
				new Response(
					JSON.stringify({
						access_token: 'first-bff-token',
						token_type: 'Bearer',
						expires_in: 600
					}),
					{ headers: { 'content-type': 'application/json' } }
				)
			);
			await Promise.allSettled([firstResponsePromise, secondResponsePromise]);
		}

		expect(observedSecondTokenRequest).toBe(true);
		const secondResponse = await secondResponsePromise;
		resolveFirstToken?.(
			new Response(
				JSON.stringify({
					access_token: 'first-bff-token',
					token_type: 'Bearer',
					expires_in: 600
				}),
				{ headers: { 'content-type': 'application/json' } }
			)
		);
		await firstResponsePromise;

		expect(tokenRequestCount).toBe(2);
		expect(await secondResponse.text()).toBe('Bearer second-bff-token');
		expect(resolve).not.toHaveBeenCalled();
	});

	it('rejects state-changing Admin API proxy requests with a foreign Origin', async () => {
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetch = vi.fn();
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL('https://mt-ar-admin-ui.pages.dev/api/admin/stats'),
			request: new Request('https://mt-ar-admin-ui.pages.dev/api/admin/stats', {
				method: 'POST',
				headers: {
					Origin: 'https://attacker.example',
					'Content-Type': 'application/json'
				},
				body: '{}'
			}),
			platform: {
				env: {
					AR_ROUTER: { fetch },
					PUBLIC_AUTHRIM_ISSUER: 'https://api.authrim.example'
				}
			},
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const response = await apiProxy({ event, resolve });

		expect(response.status).toBe(403);
		expect(consoleWarn).toHaveBeenCalledWith(
			'Admin UI BFF security event',
			expect.objectContaining({
				event_type: 'csrf_rejected',
				origin: 'https://attacker.example',
				result: 'rejected',
				status: 403
			})
		);
		expect(fetch).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
	});

	it('rejects state-changing Admin API proxy requests without Origin or Referer', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetch = vi.fn();
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL('https://mt-ar-admin-ui.pages.dev/api/admin/stats'),
			request: new Request('https://mt-ar-admin-ui.pages.dev/api/admin/stats', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: '{}'
			}),
			platform: {
				env: {
					AR_ROUTER: { fetch },
					PUBLIC_AUTHRIM_ISSUER: 'https://api.authrim.example'
				}
			},
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const response = await apiProxy({ event, resolve });

		expect(response.status).toBe(403);
		expect(fetch).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
	});

	it('rewrites validated browser Origin for upstream CSRF checks', async () => {
		const bffEnv = await createBffEnv();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						access_token: 'bff-machine-access-token',
						token_type: 'Bearer'
					}),
					{ headers: { 'content-type': 'application/json' } }
				)
			)
			.mockResolvedValueOnce(new Response('proxied'));
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL('https://mt-ar-admin-ui.pages.dev/api/admin/settings'),
			request: new Request('https://mt-ar-admin-ui.pages.dev/api/admin/settings', {
				method: 'POST',
				headers: {
					Origin: 'https://mt-ar-admin-ui.pages.dev',
					Referer: 'https://mt-ar-admin-ui.pages.dev/api/admin/settings',
					'Content-Type': 'application/json'
				},
				body: '{}'
			}),
			platform: {
				env: {
					AR_ROUTER: { fetch },
					PUBLIC_AUTHRIM_ISSUER: 'https://api.authrim.example',
					...bffEnv
				}
			},
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const response = await apiProxy({ event, resolve });
		const proxiedRequest = fetch.mock.calls[1][0] as Request;

		expect(response.status).toBe(200);
		expect(proxiedRequest.headers.get('Origin')).toBe('https://api.authrim.example');
		expect(proxiedRequest.headers.get('X-Authrim-Forwarded-Origin')).toBe(
			'https://mt-ar-admin-ui.pages.dev'
		);
		expect(proxiedRequest.headers.get('Referer')).toBe(
			'https://api.authrim.example/api/admin/settings'
		);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('does not proxy non-Admin API paths', async () => {
		const fetch = vi.fn();
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL('https://mt-ar-admin-ui.pages.dev/api/token'),
			request: new Request('https://mt-ar-admin-ui.pages.dev/api/token', {
				method: 'GET'
			}),
			platform: {
				env: {
					AR_ROUTER: { fetch },
					PUBLIC_AUTHRIM_ISSUER: 'https://api.authrim.example'
				}
			},
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const response = await apiProxy({ event, resolve });

		expect(await response.text()).toBe('resolved');
		expect(fetch).not.toHaveBeenCalled();
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it('proxies public asset paths without Admin API BFF mode headers', async () => {
		const fetch = vi.fn(async (_request: Request) => new Response('asset'));
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL(
				'https://mt-ar-admin-ui.pages.dev/api/assets/first/login-ui/background/image.webp'
			),
			request: new Request(
				'https://mt-ar-admin-ui.pages.dev/api/assets/first/login-ui/background/image.webp',
				{
					method: 'GET'
				}
			),
			platform: {
				env: {
					AR_ROUTER: { fetch },
					PUBLIC_AUTHRIM_ISSUER: 'https://api.authrim.example'
				}
			},
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const response = await apiProxy({ event, resolve });
		const proxiedRequest = fetch.mock.calls[0][0] as Request;

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('asset');
		expect(proxiedRequest.url).toBe(
			'https://api.authrim.example/api/assets/first/login-ui/background/image.webp'
		);
		expect(proxiedRequest.headers.get('X-Authrim-Admin-UI-Api-Mode')).toBeNull();
		expect(proxiedRequest.headers.get('Authorization')).toBeNull();
		expect(resolve).not.toHaveBeenCalled();
	});

	it('rejects unsupported Admin API proxy methods', async () => {
		const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetch = vi.fn();
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL('https://mt-ar-admin-ui.pages.dev/api/admin/stats'),
			request: {
				method: 'TRACE',
				headers: new Headers()
			} as Request,
			platform: {
				env: {
					AR_ROUTER: { fetch },
					PUBLIC_AUTHRIM_ISSUER: 'https://api.authrim.example'
				}
			},
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const response = await apiProxy({ event, resolve });

		expect(response.status).toBe(405);
		expect(response.headers.get('Allow')).toBe('GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
		expect(consoleWarn).toHaveBeenCalledWith(
			'Admin UI BFF security event',
			expect.objectContaining({
				event_type: 'method_rejected',
				result: 'rejected',
				status: 405
			})
		);
		expect(fetch).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
	});

	it('fails closed when Service Binding proxy lacks the Admin API public issuer', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetch = vi.fn();
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL('https://mt-ar-admin-ui.pages.dev/api/admin/stats'),
			request: new Request('https://mt-ar-admin-ui.pages.dev/api/admin/stats', {
				method: 'GET'
			}),
			platform: {
				env: {
					AR_ROUTER: { fetch }
				}
			},
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const response = await apiProxy({ event, resolve });

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: 'proxy_not_configured' });
		expect(fetch).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
	});

	it('proxies allowed Admin API requests through the service binding', async () => {
		const bffEnv = await createBffEnv();
		const upstreamHeaders = new Headers();
		upstreamHeaders.append(
			'Set-Cookie',
			'authrim_admin_session=session-123; Domain=api.authrim.example; Path=/; HttpOnly; Secure; SameSite=Lax'
		);
		upstreamHeaders.append(
			'Set-Cookie',
			'admin_csrf=csrf-123; Domain=api.authrim.example; Path=/; Secure; SameSite=Lax'
		);
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						access_token: 'bff-machine-access-token',
						token_type: 'Bearer'
					}),
					{ headers: { 'content-type': 'application/json' } }
				)
			)
			.mockResolvedValueOnce(
				new Response('proxied', {
					status: 201,
					headers: upstreamHeaders
				})
			);
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL('https://mt-ar-admin-ui.pages.dev/api/admin/stats?range=24h'),
			request: new Request('https://mt-ar-admin-ui.pages.dev/api/admin/stats?range=24h', {
				method: 'GET',
				headers: {
					'X-Request-Id': 'req-admin-1',
					'X-Tenant-Id': 'first'
				}
			}),
			platform: {
				env: {
					AR_ROUTER: { fetch },
					PUBLIC_AUTHRIM_ISSUER: 'https://api.authrim.example',
					...bffEnv
				}
			},
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const response = await apiProxy({ event, resolve });
		const tokenRequest = fetch.mock.calls[0][0] as Request;
		const proxiedRequest = fetch.mock.calls[1][0] as Request;

		expect(response.status).toBe(201);
		expect(await response.text()).toBe('proxied');
		expect(tokenRequest.url).toBe('https://api.authrim.example/token');
		expect(tokenRequest.headers.get('X-Tenant-Id')).toBe('first');
		expect(proxiedRequest.url).toBe('https://api.authrim.example/api/admin/stats?range=24h');
		expect(proxiedRequest.headers.get('X-Request-Id')).toBe('req-admin-1');
		expect(proxiedRequest.headers.get('X-Tenant-Id')).toBe('first');
		expect(proxiedRequest.headers.get('Authorization')).toBe('Bearer bff-machine-access-token');
		expect(getSetCookies(response.headers)).toEqual([
			'authrim_admin_session=session-123; Path=/; HttpOnly; Secure; SameSite=Lax',
			'admin_csrf=csrf-123; Path=/; Secure; SameSite=Lax'
		]);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('returns a gateway timeout when the service binding does not respond', async () => {
		const bffEnv = await createBffEnv();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const fetch = vi.fn(async (_request: Request) => {
			throw Object.assign(new Error('Timeout'), { name: 'AbortError' });
		});
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL('https://mt-ar-admin-ui.pages.dev/api/admin/stats'),
			request: new Request('https://mt-ar-admin-ui.pages.dev/api/admin/stats', {
				method: 'GET'
			}),
			platform: {
				env: {
					AR_ROUTER: { fetch },
					PUBLIC_AUTHRIM_ISSUER: 'https://api.authrim.example',
					...bffEnv
				}
			},
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const responsePromise = apiProxy({ event, resolve });
		const response = await responsePromise;

		expect(response.status).toBe(504);
		expect(await response.json()).toMatchObject({ error: 'gateway_timeout' });
		expect(consoleError).toHaveBeenCalledWith(
			'Admin UI BFF security event',
			expect.objectContaining({
				event_type: 'upstream_request_failed',
				error_type: 'AbortError',
				result: 'failed',
				status: 504
			})
		);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('rejects oversized multibyte bodies by byte length before proxying', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetch = vi.fn();
		const resolve = vi.fn(async () => new Response('resolved'));
		const event = {
			url: new URL('https://mt-ar-admin-ui.pages.dev/api/admin/import'),
			request: new Request('https://mt-ar-admin-ui.pages.dev/api/admin/import', {
				method: 'POST',
				headers: {
					Origin: 'https://mt-ar-admin-ui.pages.dev',
					'Content-Type': 'text/plain'
				},
				body: 'あ'.repeat(4 * 1024 * 1024)
			}),
			platform: {
				env: {
					AR_ROUTER: { fetch },
					PUBLIC_AUTHRIM_ISSUER: 'https://api.authrim.example'
				}
			},
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof apiProxy>[0]['event'];

		const response = await apiProxy({ event, resolve });

		expect(response.status).toBe(413);
		expect(fetch).not.toHaveBeenCalled();
		expect(resolve).not.toHaveBeenCalled();
	});
});
