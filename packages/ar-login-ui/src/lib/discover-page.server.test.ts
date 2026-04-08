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

	it('switches to manual tenant input when email discovery returns manual_required', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
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
			)
			.mockResolvedValueOnce(
				jsonResponse({
					result: 'manual_required',
					methods: ['email_domain', 'tenant_code', 'tenant_slug'],
					allow_manual_tenant_entry: true
				})
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
			mode: 'tenant_code',
			result: 'manual_required'
		});
		expect(fetch).toHaveBeenNthCalledWith(1, '/api/auth/discovery', {
			headers: { 'x-authrim-original-host': 'login.example.com' }
		});
		expect(fetch).toHaveBeenNthCalledWith(
			2,
			'/api/auth/discovery',
			expect.objectContaining({
				method: 'POST',
				headers: expect.any(Headers)
			})
		);
		const requestHeaders = fetch.mock.calls[1]?.[1]?.headers as Headers;
		expect(requestHeaders.get('x-authrim-original-host')).toBe('login.example.com');
		expect(requestHeaders.get('content-type')).toBe('application/json');
	});

	it('redirects common-entry discovery success back to same-host /login', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
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
			location: '/login'
		});

		expect(cookies.set).toHaveBeenCalled();
	});

	it('redirects common-entry invitation discovery success back to same-host /signup', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
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
			location: '/signup?invite_token=invite-123&tenant=First+Tenant&email=user%40example.com'
		});
	});
});
