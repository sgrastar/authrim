import { beforeEach, describe, expect, it, vi } from 'vitest';
import { load as loginLoad } from '../routes/(main)/login/+page.server';
import { load as discoverLoad } from '../routes/(main)/discover/+page.server';
import { clearLoginDiscoveryConfigCacheForTests } from '../lib/login-discovery-config-cache';
import { clearAuthenticationMethodsServerCache } from '../lib/server/authentication-methods-cache';

const COMMON = 'https://login.example.com/discover';
const TENANT_LOGIN = 'https://t1.example.com/login';

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
}

function cookies() {
	const store = new Map<string, string>();
	return {
		get: vi.fn((key: string) => store.get(key)),
		set: vi.fn((key: string, value: string) => void store.set(key, value)),
		delete: vi.fn((key: string) => void store.delete(key))
	};
}

function discoveryAnswer(overrides: {
	mode: 'tenant_only' | 'discovery_optional';
	is_common_entry_host?: boolean;
}) {
	return {
		config: {
			tenant_id: 't1',
			mode: overrides.mode,
			discovery_methods: ['tenant_code', 'tenant_slug'],
			selection_policy: 'select_if_multiple',
			allow_manual_tenant_entry: true,
			remember_last_tenant: true,
			redirect_default_login_to_discovery: true,
			require_common_discovery_before_login: true,
			skip_discovery_if_only_one_tenant: false,
			redirect_tenant_discover_to_common_entry: true
		},
		single_tenant_mode: false,
		is_common_entry_host: overrides.is_common_entry_host ?? false,
		common_discover_url: COMMON
	};
}

function event(url: string, fetch: unknown) {
	return { cookies: cookies(), fetch, request: new Request(url), url: new URL(url) } as never;
}

describe('tenant_only entry on tenant hosts', () => {
	beforeEach(() => {
		clearLoginDiscoveryConfigCacheForTests();
		clearAuthenticationMethodsServerCache();
	});

	it('renders the tenant login directly (no redirect, no grant lookup) for a tenant without an override', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryAnswer({ mode: 'tenant_only' })));
		const result = await loginLoad(event(TENANT_LOGIN, fetch));
		expect(result).toEqual({});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('keeps sending the tenant login to the common discovery when the mode is discovery_optional', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryAnswer({ mode: 'discovery_optional' })));
		await expect(loginLoad(event(TENANT_LOGIN, fetch))).rejects.toMatchObject({
			status: 303,
			location: `${COMMON}?expected_tenant_id=t1&return_to=${encodeURIComponent(TENANT_LOGIN)}`
		});
	});

	it('drops an invalid grant and renders the login instead of going back to the common entry', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryAnswer({ mode: 'tenant_only' })))
			.mockResolvedValueOnce(new Response('{}', { status: 400 }));
		const result = await loginLoad(event(`${TENANT_LOGIN}?discovery_grant=stale`, fetch));
		expect(result).toEqual({});
	});

	it('still sends an invalid grant back to the common entry when discovery is on', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryAnswer({ mode: 'discovery_optional' })))
			.mockResolvedValueOnce(new Response('{}', { status: 400 }));
		await expect(
			loginLoad(event(`${TENANT_LOGIN}?discovery_grant=stale`, fetch))
		).rejects.toMatchObject({ status: 303, location: expect.stringContaining(COMMON) });
	});

	it('renders a protocol entry (SAML context) on the tenant host directly', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryAnswer({ mode: 'tenant_only' })));
		const result = await loginLoad(event(`${TENANT_LOGIN}?saml_request_id=abc`, fetch));
		expect(result).toEqual({});
	});

	it('leaves the common entry host alone: /login still goes to /discover', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse(discoveryAnswer({ mode: 'tenant_only', is_common_entry_host: true }))
			);
		await expect(loginLoad(event('https://login.example.com/login', fetch))).rejects.toMatchObject({
			status: 303,
			location: '/discover'
		});
	});

	it('sends a tenant host /discover to its own /login, not to the common entry', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryAnswer({ mode: 'tenant_only' })));
		await expect(
			discoverLoad(event('https://t1.example.com/discover', fetch))
		).rejects.toMatchObject({ status: 303, location: '/login' });
	});

	it('keeps a tenant host /discover going to the common entry when discovery is on', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryAnswer({ mode: 'discovery_optional' })));
		await expect(
			discoverLoad(event('https://t1.example.com/discover', fetch))
		).rejects.toMatchObject({ status: 303, location: COMMON });
	});
});
