import { describe, expect, it, vi } from 'vitest';
import { actions, load } from '../routes/discover/+page.server';

function createCookies(initial: Record<string, string> = {}) {
	const store = new Map<string, string>(Object.entries(initial));
	return {
		get: vi.fn((key: string) => store.get(key)),
		set: vi.fn((key: string, value: string) => {
			store.set(key, value);
		}),
		delete: vi.fn((key: string) => {
			store.delete(key);
		})
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

describe('/discover page server', () => {
	it('redirects tenant-specific discover pages back to /login', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(
			jsonResponse({
				config: {
					tenant_id: 'first',
					mode: 'discovery_optional',
					discovery_methods: ['email_exact', 'tenant_code', 'tenant_slug'],
					selection_policy: 'select_if_multiple',
					allow_manual_tenant_entry: true,
					remember_last_tenant: true,
					redirect_default_login_to_discovery: true,
					require_common_discovery_before_login: true
				},
				single_tenant_mode: false,
				is_common_entry_host: false,
				common_discover_url: 'https://multi-tenant.authrim.com/discover'
			})
		);

		await expect(
			load({
				fetch,
				cookies: createCookies(),
				request: new Request('https://first.multi-tenant.authrim.com/discover'),
				url: new URL('https://first.multi-tenant.authrim.com/discover')
			} as never)
		).rejects.toMatchObject({
			status: 303,
			location: '/login'
		});

		expect(fetch).toHaveBeenCalledWith('/api/auth/discovery', {
			headers: { 'x-authrim-original-host': 'first.multi-tenant.authrim.com' }
		});
	});

	it('starts OTP verification before resolving exact email membership', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					config: {
						tenant_id: 'default',
						mode: 'discovery_optional',
						discovery_methods: ['email_exact', 'tenant_code', 'tenant_slug'],
						selection_policy: 'select_if_multiple',
						allow_manual_tenant_entry: true,
						remember_last_tenant: true,
						redirect_default_login_to_discovery: true,
						require_common_discovery_before_login: true
					},
					single_tenant_mode: false,
					is_common_entry_host: true,
					common_discover_url: 'https://multi-tenant.authrim.com/discover'
				})
			)
			.mockResolvedValueOnce(
				jsonResponse(
					{
						challenge_id: 'discovery-42-00000000-0000-4000-8000-000000000001',
						expires_in: 600,
						status: 'code_sent'
					},
					202
				)
			);

		const cookies = createCookies();
		const request = new Request('https://login.example.com/discover?/resolve', {
			method: 'POST',
			body: new URLSearchParams({
				mode: 'email',
				value: 'user@example.com'
			})
		});

		const result = await actions.resolve({
			fetch,
			cookies,
			request,
			url: new URL('https://login.example.com/discover?/resolve')
		} as never);

		expect(result).toMatchObject({
			mode: 'email',
			result: 'email_code_sent',
			emailChallengeId: 'discovery-42-00000000-0000-4000-8000-000000000001'
		});
		expect(fetch).toHaveBeenNthCalledWith(1, '/api/auth/discovery', {
			headers: { 'x-authrim-original-host': 'login.example.com' }
		});
		expect(fetch).toHaveBeenNthCalledWith(
			2,
			'/api/auth/discovery/email/start',
			expect.objectContaining({
				method: 'POST',
				headers: expect.any(Headers)
			})
		);
		const requestHeaders = fetch.mock.calls[1]?.[1]?.headers as Headers;
		expect(requestHeaders.get('x-authrim-original-host')).toBe('login.example.com');
		expect(requestHeaders.get('content-type')).toBe('application/json');
	});

	it('redirects common-entry discovery success to tenant login_url', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					config: {
						tenant_id: 'default',
						mode: 'discovery_optional',
						discovery_methods: ['email_exact', 'tenant_code', 'tenant_slug'],
						selection_policy: 'select_if_multiple',
						allow_manual_tenant_entry: true,
						remember_last_tenant: true,
						redirect_default_login_to_discovery: true,
						require_common_discovery_before_login: true
					},
					single_tenant_mode: false,
					is_common_entry_host: true,
					common_discover_url: 'https://multi-tenant.authrim.com/discover'
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({
					result: 'resolved',
					candidate: {
						tenant_id: 'first',
						tenant_code: 'first',
						display_name: 'First Tenant',
						login_url: 'https://first.multi-tenant.authrim.com/login',
						source: 'tenant_code'
					}
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({
					grant: 'grant-token',
					login_url: 'https://first.multi-tenant.authrim.com/login?discovery_grant=grant-token'
				})
			);

		const cookies = createCookies();
		const request = new Request('https://multi-tenant.authrim.com/discover?/resolve', {
			method: 'POST',
			body: new URLSearchParams({
				mode: 'tenant_code',
				value: 'first'
			})
		});

		await expect(
			actions.resolve({
				cookies,
				fetch,
				request,
				url: new URL('https://multi-tenant.authrim.com/discover?/resolve')
			} as never)
		).rejects.toMatchObject({
			status: 303,
			location: 'https://first.multi-tenant.authrim.com/login?discovery_grant=grant-token'
		});

		expect(cookies.set).toHaveBeenCalled();
		const grantRequest = fetch.mock.calls[2]?.[1];
		expect(grantRequest?.method).toBe('POST');
	});

	it('auto-skips the shared discover screen when exactly one active tenant exists', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					config: {
						tenant_id: 'default',
						mode: 'discovery_optional',
						discovery_methods: ['email_exact', 'tenant_code', 'tenant_slug'],
						selection_policy: 'select_if_multiple',
						allow_manual_tenant_entry: true,
						remember_last_tenant: true,
						redirect_default_login_to_discovery: true,
						require_common_discovery_before_login: true,
						skip_discovery_if_only_one_tenant: true
					},
					single_tenant_mode: false,
					is_common_entry_host: true,
					common_discover_url: 'https://multi-tenant.authrim.com/discover',
					single_active_tenant_candidate: {
						tenant_id: 'first',
						tenant_code: 'first',
						display_name: 'First Tenant',
						login_url: 'https://first.multi-tenant.authrim.com/login',
						source: 'tenant_slug'
					}
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({
					grant: 'grant-token',
					login_url: 'https://first.multi-tenant.authrim.com/login?discovery_grant=grant-token'
				})
			);

		await expect(
			load({
				fetch,
				cookies: createCookies(),
				request: new Request(
					'https://multi-tenant.authrim.com/discover?expected_tenant_id=first&return_to=https%3A%2F%2Ffirst.multi-tenant.authrim.com%2Flogin'
				),
				url: new URL(
					'https://multi-tenant.authrim.com/discover?expected_tenant_id=first&return_to=https%3A%2F%2Ffirst.multi-tenant.authrim.com%2Flogin'
				)
			} as never)
		).rejects.toMatchObject({
			status: 303,
			location: 'https://first.multi-tenant.authrim.com/login?discovery_grant=grant-token'
		});
	});

	it('passes the discovered email as login_hint when redirecting to tenant login', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					config: {
						tenant_id: 'default',
						mode: 'discovery_optional',
						discovery_methods: ['email_exact', 'tenant_code', 'tenant_slug'],
						selection_policy: 'select_if_multiple',
						allow_manual_tenant_entry: true,
						remember_last_tenant: true,
						redirect_default_login_to_discovery: true,
						require_common_discovery_before_login: true
					},
					single_tenant_mode: false,
					is_common_entry_host: true,
					common_discover_url: 'https://multi-tenant.authrim.com/discover'
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({
					result: 'resolved',
					candidate: {
						tenant_id: 'first',
						tenant_code: 'first',
						display_name: 'First Tenant',
						login_url: 'https://first.multi-tenant.authrim.com/login',
						source: 'email_exact'
					}
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({
					grant: 'grant-token',
					login_url:
						'https://first.multi-tenant.authrim.com/login?login_hint=user%40example.com&discovery_grant=grant-token'
				})
			);

		await expect(
			actions.resolve({
				cookies: createCookies(),
				fetch,
				request: new Request('https://multi-tenant.authrim.com/discover?/resolve', {
					method: 'POST',
					body: new URLSearchParams({
						mode: 'email',
						value: 'user@example.com',
						email_challenge_id: 'discovery-42-00000000-0000-4000-8000-000000000001',
						email_code: '123456'
					})
				}),
				url: new URL('https://multi-tenant.authrim.com/discover?/resolve')
			} as never)
		).rejects.toMatchObject({
			status: 303,
			location:
				'https://first.multi-tenant.authrim.com/login?login_hint=user%40example.com&discovery_grant=grant-token'
		});

		const grantRequest = fetch.mock.calls[2]?.[1];
		expect(grantRequest?.body).toContain('"login_hint":"user@example.com"');
	});

	it('redirects common-entry invitation discovery success to tenant signup url', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					config: {
						tenant_id: 'default',
						mode: 'discovery_optional',
						discovery_methods: ['email_exact', 'tenant_code', 'tenant_slug'],
						selection_policy: 'select_if_multiple',
						allow_manual_tenant_entry: true,
						remember_last_tenant: true,
						redirect_default_login_to_discovery: true,
						require_common_discovery_before_login: true
					},
					single_tenant_mode: false,
					is_common_entry_host: true,
					common_discover_url: 'https://multi-tenant.authrim.com/discover'
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({
					result: 'resolved',
					invited_email: 'user@example.com',
					candidate: {
						tenant_id: 'first',
						tenant_code: 'first',
						display_name: 'First Tenant',
						login_url: 'https://first.multi-tenant.authrim.com/login',
						source: 'invitation'
					}
				})
			);

		const request = new Request('https://multi-tenant.authrim.com/discover?/resolve', {
			method: 'POST',
			body: new URLSearchParams({
				mode: 'tenant_code',
				value: 'first',
				invite_token: 'invite-123'
			})
		});

		await expect(
			actions.resolve({
				cookies: createCookies(),
				fetch,
				request,
				url: new URL('https://multi-tenant.authrim.com/discover?/resolve')
			} as never)
		).rejects.toMatchObject({
			status: 303,
			location:
				'https://first.multi-tenant.authrim.com/signup?invite_token=invite-123&tenant=First+Tenant&email=user%40example.com'
		});
	});
});
