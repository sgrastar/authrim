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
					redirect_default_login_to_discovery: true
				},
				single_tenant_mode: true,
				is_common_entry_host: false
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
					redirect_default_login_to_discovery: false
				},
				single_tenant_mode: false,
				is_common_entry_host: true
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
					redirect_default_login_to_discovery: false
				},
				single_tenant_mode: false,
				is_common_entry_host: true
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
					redirect_default_login_to_discovery: true
				},
				single_tenant_mode: false,
				is_common_entry_host: true
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
					redirect_default_login_to_discovery: true
				},
				single_tenant_mode: false,
				is_common_entry_host: false
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
					redirect_default_login_to_discovery: true
				},
				single_tenant_mode: true,
				is_common_entry_host: false
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
					redirect_default_login_to_discovery: true
				},
				single_tenant_mode: false,
				is_common_entry_host: true
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
