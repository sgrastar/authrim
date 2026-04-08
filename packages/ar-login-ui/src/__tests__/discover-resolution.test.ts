import { describe, expect, it, vi } from 'vitest';
import { actions } from '../routes/discover/+page.server';

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

describe('discover resolution', () => {
	it('redirects common-entry discovery success to the resolved tenant login URL', async () => {
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
			location: 'https://first.multi-tenant.authrim.com/login'
		});

		expect(cookies.set).toHaveBeenCalled();
	});

	it('redirects common-entry discovery success to the resolved tenant login URL even when selection_policy is always_select', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					config: {
						tenant_id: 'default',
						mode: 'discovery_optional',
						discovery_methods: ['email_domain', 'tenant_code', 'tenant_slug'],
						selection_policy: 'always_select',
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

		await expect(
			actions.resolve({
				cookies: createCookies(),
				fetch,
				request: new Request('https://multi-tenant.authrim.com/discover?/resolve', {
					method: 'POST',
					body: new URLSearchParams({
						mode: 'tenant_code',
						value: 'first'
					})
				}),
				url: new URL('https://multi-tenant.authrim.com/discover?/resolve')
			} as never)
		).rejects.toMatchObject({
			status: 303,
			location: 'https://first.multi-tenant.authrim.com/login'
		});
	});

	it('redirects common-entry invitation discovery success to the resolved tenant signup URL', async () => {
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
			location:
				'https://first.multi-tenant.authrim.com/signup?invite_token=invite-123&tenant=First+Tenant&email=user%40example.com'
		});
	});
});
