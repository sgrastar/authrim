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
	it('redirects tenant host discovery to /login when host_policy is common_entry_only', async () => {
		const fetch = vi.fn(async () =>
			jsonResponse({
				config: {
					tenant_id: 'acme',
					mode: 'discovery_optional',
					discovery_methods: ['email_domain', 'tenant_code', 'tenant_slug', 'app_hint'],
					selection_policy: 'select_if_multiple',
					allow_manual_tenant_entry: true,
					remember_last_tenant: true,
					redirect_default_login_to_discovery: true,
					host_policy: 'common_entry_only'
				},
				single_tenant_mode: false,
				is_common_entry_host: false
			})
		);

		await expect(
			load({
				fetch,
				cookies: createCookies(),
				url: new URL('https://acme.auth.example.com/discover')
			} as never)
		).rejects.toMatchObject({ status: 303, location: '/login' });
	});

	it('allows tenant host discovery when host_policy is all_hosts', async () => {
		const fetch = vi.fn(async () =>
			jsonResponse({
				config: {
					tenant_id: 'acme',
					mode: 'discovery_optional',
					discovery_methods: ['email_domain', 'tenant_code', 'tenant_slug'],
					selection_policy: 'select_if_multiple',
					allow_manual_tenant_entry: true,
					remember_last_tenant: true,
					redirect_default_login_to_discovery: true,
					host_policy: 'all_hosts'
				},
				single_tenant_mode: false,
				is_common_entry_host: false
			})
		);

		const result = await load({
			fetch,
			cookies: createCookies(),
			url: new URL('https://acme.auth.example.com/discover')
		} as never);

		expect(result).toBeDefined();
		expect(result?.config.config.host_policy).toBe('all_hosts');
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
						redirect_default_login_to_discovery: true,
						host_policy: 'common_entry_only'
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
			request
		} as never);

		expect(result).toMatchObject({
			mode: 'tenant_code',
			result: 'manual_required'
		});
	});
});
