import { describe, expect, it, vi } from 'vitest';
import { actions as rootActions, load as rootLoad } from '../routes/+page.server';
import { actions as loginActions, load as loginLoad } from '../routes/login/+page.server';
import { load as discoverLoad } from '../routes/discover/+page.server';
import { load as signupLoad } from '../routes/signup/+page.server';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

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

describe('common-entry routing', () => {
	it('does not redirect the root page for single-tenant deployments', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(
			jsonResponse({
				config: {
					tenant_id: 'default',
					mode: 'tenant_only',
					discovery_methods: ['tenant_slug'],
					selection_policy: 'select_if_multiple',
					allow_manual_tenant_entry: false,
					remember_last_tenant: true,
					redirect_default_login_to_discovery: true,
					require_common_discovery_before_login: true,
					redirect_tenant_discover_to_common_entry: true
				},
				single_tenant_mode: true,
				is_common_entry_host: false,
				common_discover_url: null
			})
		);

		const result = await rootLoad({
			cookies: createCookies(),
			fetch,
			request: new Request('https://login.example.com/'),
			url: new URL('https://login.example.com/')
		} as never);

		expect(result).toEqual({});
	});

	it('redirects the common-entry root page to /discover', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(
			jsonResponse({
				config: {
					tenant_id: 'default',
					mode: 'discovery_optional',
					discovery_methods: ['email_domain', 'tenant_code', 'tenant_slug'],
					selection_policy: 'select_if_multiple',
					allow_manual_tenant_entry: true,
					remember_last_tenant: true,
					redirect_default_login_to_discovery: false,
					require_common_discovery_before_login: true,
					redirect_tenant_discover_to_common_entry: true
				},
				single_tenant_mode: false,
				is_common_entry_host: true,
				common_discover_url: 'https://multi-tenant.authrim.com/discover'
			})
		);

		await expect(
			rootLoad({
				cookies: createCookies(),
				fetch,
				request: new Request('https://multi-tenant.authrim.com/'),
				url: new URL('https://multi-tenant.authrim.com/')
			} as never)
		).rejects.toMatchObject({
			status: 303,
			location: '/discover'
		});
	});

	it('redirects misplaced root resolve actions to /discover', async () => {
		await expect(rootActions.resolve({} as never)).rejects.toMatchObject({
			status: 303,
			location: '/discover'
		});
	});

	it('redirects the common-entry login page to /discover even when default-login redirect is disabled', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(
			jsonResponse({
				config: {
					tenant_id: 'default',
					mode: 'discovery_optional',
					discovery_methods: ['email_domain', 'tenant_code', 'tenant_slug'],
					selection_policy: 'select_if_multiple',
					allow_manual_tenant_entry: true,
					remember_last_tenant: true,
					redirect_default_login_to_discovery: false,
					require_common_discovery_before_login: true,
					redirect_tenant_discover_to_common_entry: true
				},
				single_tenant_mode: false,
				is_common_entry_host: true,
				common_discover_url: 'https://multi-tenant.authrim.com/discover'
			})
		);

		await expect(
			loginLoad({
				cookies: createCookies(),
				fetch,
				request: new Request('https://multi-tenant.authrim.com/login'),
				url: new URL('https://multi-tenant.authrim.com/login')
			} as never)
		).rejects.toMatchObject({
			status: 303,
			location: '/discover'
		});
	});

	it('redirects misplaced login resolve actions to /discover', async () => {
		await expect(loginActions.resolve({} as never)).rejects.toMatchObject({
			status: 303,
			location: '/discover'
		});
	});

	it('redirects tenant-host /login to the shared discover screen when common discovery is required', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(
			jsonResponse({
				config: {
					tenant_id: 'first',
					mode: 'discovery_optional',
					discovery_methods: ['email_domain', 'tenant_code', 'tenant_slug'],
					selection_policy: 'select_if_multiple',
					allow_manual_tenant_entry: true,
					remember_last_tenant: true,
					redirect_default_login_to_discovery: true,
					require_common_discovery_before_login: true,
					redirect_tenant_discover_to_common_entry: true
				},
				single_tenant_mode: false,
				is_common_entry_host: false,
				common_discover_url: 'https://multi-tenant.authrim.com/discover'
			})
		);

		await expect(
			loginLoad({
				cookies: createCookies(),
				fetch,
				request: new Request('https://first.multi-tenant.authrim.com/login'),
				url: new URL('https://first.multi-tenant.authrim.com/login')
			} as never)
		).rejects.toMatchObject({
			status: 303,
			location:
				'https://multi-tenant.authrim.com/discover?expected_tenant_id=first&return_to=https%3A%2F%2Ffirst.multi-tenant.authrim.com%2Flogin'
		});
	});

	it('accepts a valid discovery grant on tenant-host /login and strips it from the URL', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					config: {
						tenant_id: 'first',
						mode: 'discovery_optional',
						discovery_methods: ['email_domain', 'tenant_code', 'tenant_slug'],
						selection_policy: 'select_if_multiple',
						allow_manual_tenant_entry: true,
						remember_last_tenant: true,
						redirect_default_login_to_discovery: true,
						require_common_discovery_before_login: true,
					redirect_tenant_discover_to_common_entry: true
					},
					single_tenant_mode: false,
					is_common_entry_host: false,
					common_discover_url: 'https://multi-tenant.authrim.com/discover'
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({
					valid: true,
					tenant_id: 'first',
					target_url: 'https://first.multi-tenant.authrim.com/login'
				})
			);

		const cookies = createCookies();
		await expect(
			loginLoad({
				cookies,
				fetch,
				request: new Request(
					'https://first.multi-tenant.authrim.com/login?discovery_grant=test-grant'
				),
				url: new URL('https://first.multi-tenant.authrim.com/login?discovery_grant=test-grant')
			} as never)
		).rejects.toMatchObject({
			status: 303,
			location: 'https://first.multi-tenant.authrim.com/login'
		});
		expect(cookies.set).toHaveBeenCalledWith(
			'authrim_discovery_grant_verified',
			'https://first.multi-tenant.authrim.com/login',
			expect.objectContaining({ path: '/login', httpOnly: true, maxAge: 300 })
		);
	});

	it('verifies a discovery grant against the original proxied tenant login URL', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					config: {
						tenant_id: 'first',
						mode: 'discovery_optional',
						discovery_methods: ['email_domain', 'tenant_code', 'tenant_slug'],
						selection_policy: 'select_if_multiple',
						allow_manual_tenant_entry: true,
						remember_last_tenant: true,
						redirect_default_login_to_discovery: true,
						require_common_discovery_before_login: true,
					redirect_tenant_discover_to_common_entry: true
					},
					single_tenant_mode: false,
					is_common_entry_host: false,
					common_discover_url: 'https://multi-tenant.authrim.com/discover'
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({
					valid: true,
					tenant_id: 'first',
					target_url:
						'https://first.multi-tenant.authrim.com/login?login_hint=user%40example.com'
				})
			);

		const cookies = createCookies();
		await expect(
			loginLoad({
				cookies,
				fetch,
				request: new Request(
					'https://mt-ar-login-ui.pages.dev/login?login_hint=user%40example.com&discovery_grant=test-grant',
					{
						headers: { 'x-authrim-original-host': 'first.multi-tenant.authrim.com' }
					}
				),
				url: new URL(
					'https://mt-ar-login-ui.pages.dev/login?login_hint=user%40example.com&discovery_grant=test-grant'
				)
			} as never)
		).rejects.toMatchObject({
			status: 303,
			location: 'https://first.multi-tenant.authrim.com/login?login_hint=user%40example.com'
		});

		const verifyBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
		expect(verifyBody.current_url).toBe(
			'https://first.multi-tenant.authrim.com/login?login_hint=user%40example.com'
		);
		expect(cookies.set).toHaveBeenCalledWith(
			'authrim_discovery_grant_verified',
			'https://first.multi-tenant.authrim.com/login?login_hint=user%40example.com',
			expect.objectContaining({ path: '/login', httpOnly: true, maxAge: 300 })
		);
	});

	it('allows the grant-stripped login URL once after a valid discovery grant', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(
			jsonResponse({
				config: {
					tenant_id: 'first',
					mode: 'discovery_optional',
					discovery_methods: ['email_domain', 'tenant_code', 'tenant_slug'],
					selection_policy: 'select_if_multiple',
					allow_manual_tenant_entry: true,
					remember_last_tenant: true,
					redirect_default_login_to_discovery: true,
					require_common_discovery_before_login: true,
					redirect_tenant_discover_to_common_entry: true
				},
				single_tenant_mode: false,
				is_common_entry_host: false,
				common_discover_url: 'https://multi-tenant.authrim.com/discover'
			})
		);
		const cookies = createCookies({
			authrim_discovery_grant_verified:
				'https://first.multi-tenant.authrim.com/login?login_hint=user%40example.com'
		});

		const result = await loginLoad({
			cookies,
			fetch,
			request: new Request(
				'https://mt-ar-login-ui.pages.dev/login?login_hint=user%40example.com',
				{
					headers: { 'x-authrim-original-host': 'first.multi-tenant.authrim.com' }
				}
			),
			url: new URL('https://mt-ar-login-ui.pages.dev/login?login_hint=user%40example.com')
		} as never);

		expect(result).toEqual({});
		expect(cookies.delete).toHaveBeenCalledWith('authrim_discovery_grant_verified', {
			path: '/login'
		});
	});

	it('redirects the common-entry signup page to /discover', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(
			jsonResponse({
				config: {
					tenant_id: 'default',
					mode: 'discovery_optional',
					discovery_methods: ['email_domain', 'tenant_code', 'tenant_slug'],
					selection_policy: 'select_if_multiple',
					allow_manual_tenant_entry: true,
					remember_last_tenant: true,
					redirect_default_login_to_discovery: true,
					require_common_discovery_before_login: true,
					redirect_tenant_discover_to_common_entry: true
				},
				single_tenant_mode: false,
				is_common_entry_host: true,
				common_discover_url: 'https://multi-tenant.authrim.com/discover'
			})
		);

		await expect(
			signupLoad({
				cookies: createCookies(),
				fetch,
				request: new Request('https://multi-tenant.authrim.com/signup'),
				url: new URL('https://multi-tenant.authrim.com/signup')
			} as never)
		).rejects.toMatchObject({
			status: 303,
			location: '/discover'
		});
	});

	it('does not redirect naked-domain issuer login pages away from /login', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(
			jsonResponse({
				config: {
					tenant_id: 'default',
					mode: 'discovery_optional',
					discovery_methods: ['email_domain', 'tenant_code', 'tenant_slug'],
					selection_policy: 'select_if_multiple',
					allow_manual_tenant_entry: true,
					remember_last_tenant: true,
					redirect_default_login_to_discovery: true,
					require_common_discovery_before_login: false,
					redirect_tenant_discover_to_common_entry: true
				},
				single_tenant_mode: false,
				is_common_entry_host: false,
				common_discover_url: 'https://multi-tenant.authrim.com/discover'
			})
		);

		const result = await loginLoad({
			cookies: createCookies(),
			fetch,
			request: new Request('https://auth.example.com/login'),
			url: new URL('https://auth.example.com/login')
		} as never);

		expect(result).toEqual({});
	});

	it('does not redirect single-tenant signup pages', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(
			jsonResponse({
				config: {
					tenant_id: 'default',
					mode: 'tenant_only',
					discovery_methods: ['tenant_slug'],
					selection_policy: 'select_if_multiple',
					allow_manual_tenant_entry: false,
					remember_last_tenant: true,
					redirect_default_login_to_discovery: true,
					require_common_discovery_before_login: true,
					redirect_tenant_discover_to_common_entry: true
				},
				single_tenant_mode: true,
				is_common_entry_host: false,
				common_discover_url: null
			})
		);

		const result = await signupLoad({
			cookies: createCookies(),
			fetch,
			request: new Request('https://login.example.com/signup'),
			url: new URL('https://login.example.com/signup')
		} as never);

		expect(result).toEqual({});
	});

	it('keeps /discover reachable on the common-entry host when tenant discovery is disabled', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(
			jsonResponse({
				config: {
					tenant_id: 'default',
					mode: 'tenant_only',
					discovery_methods: ['tenant_code', 'tenant_slug'],
					selection_policy: 'select_if_multiple',
					allow_manual_tenant_entry: true,
					remember_last_tenant: true,
					redirect_default_login_to_discovery: true,
					require_common_discovery_before_login: true,
					redirect_tenant_discover_to_common_entry: true
				},
				single_tenant_mode: false,
				is_common_entry_host: true,
				common_discover_url: 'https://multi-tenant.authrim.com/discover'
			})
		);

		const result = await discoverLoad({
			fetch,
			cookies: createCookies(),
			request: new Request('https://multi-tenant.authrim.com/discover'),
			url: new URL('https://multi-tenant.authrim.com/discover')
		} as never);

		expect(result).toMatchObject({
			inviteErrorCode: null,
			config: {
				is_common_entry_host: true,
				config: {
					mode: 'tenant_only'
				}
			}
		});
	});
});
