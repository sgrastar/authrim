import { describe, expect, it, vi } from 'vitest';
import { actions, load } from '../routes/discover/+page.server';

// The conformance shape: the host is a tenant's own host (is_common_entry_host is false) and the
// common discovery URL is a /discover on that same host. The POST a discover form makes goes to
// `/discover?/resolve`, whose query differs from the common discovery URL.

const HOST = 'https://tenant.example.test';
const SAML_LOGIN_URL = `${HOST}/login?saml_request_id=ONELOGIN_1&saml_sp_entity_id=https%3A%2F%2Fsp.example&return_to=saml_sso&force_authn=true`;
const CARRIED = { expected_tenant_id: 'default', return_to: SAML_LOGIN_URL };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function createCookies() {
	const store = new Map<string, string>();
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

function tenantHostConfig() {
	return {
		config: {
			tenant_id: 'default',
			mode: 'discovery_optional',
			discovery_methods: ['email_exact', 'tenant_code'],
			selection_policy: 'select_if_multiple',
			allow_manual_tenant_entry: true,
			remember_last_tenant: true,
			redirect_default_login_to_discovery: true,
			require_common_discovery_before_login: true,
			redirect_tenant_discover_to_common_entry: false
		},
		single_tenant_mode: false,
		is_common_entry_host: false,
		common_discover_url: `${HOST}/discover`
	};
}

const candidate = {
	tenant_id: 'default',
	tenant_code: 'default',
	display_name: 'Default',
	logo_url: null,
	login_url: `${HOST}/login`,
	source: 'email_exact'
};

function post(
	fields: Record<string, string>,
	fetch: ReturnType<typeof vi.fn>,
	options: { url?: string; originalHost?: string } = {}
) {
	const url = options.url ?? `${HOST}/discover?/resolve`;
	return {
		fetch,
		cookies: createCookies(),
		request: new Request(url, {
			method: 'POST',
			body: new URLSearchParams(fields),
			headers: options.originalHost ? { 'x-authrim-original-host': options.originalHost } : {}
		}),
		url: new URL(url)
	} as never;
}

function grantBody(fetch: ReturnType<typeof vi.fn>) {
	const call = fetch.mock.calls.find(([path]) => path === '/api/auth/discovery/grant');
	return JSON.parse(String((call?.[1] as RequestInit).body));
}

const VARIANTS = [
	{ name: 'direct tenant host', url: `${HOST}/discover?/resolve`, originalHost: undefined },
	{
		name: 'Login UI behind the tenant host',
		url: 'https://ar-login-ui.example.workers.dev/discover?/resolve',
		originalHost: 'tenant.example.test'
	}
];

describe.each(VARIANTS)('POST /discover?/resolve on a tenant host ($name)', (variant) => {
	const opts = { url: variant.url, originalHost: variant.originalHost };

	it('sends the email code instead of redirecting to /login, keeping the SAML context', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(tenantHostConfig()))
			.mockResolvedValueOnce(
				jsonResponse({ challenge_id: 'c1', expires_in: 600, status: 'code_sent' }, 202)
			);

		const result = await actions.resolve(
			post({ mode: 'email', value: 'user@example.com', ...CARRIED }, fetch, opts)
		);

		expect(result).toMatchObject({
			result: 'email_code_sent',
			emailChallengeId: 'c1',
			returnTo: SAML_LOGIN_URL,
			expectedTenantId: 'default'
		});
	});

	it('issues the grant with return_to and expected_tenant_id after the email code is verified', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(tenantHostConfig()))
			.mockResolvedValueOnce(jsonResponse({ result: 'resolved', candidate }))
			.mockResolvedValueOnce(
				jsonResponse({ grant: 'g', login_url: `${SAML_LOGIN_URL}&discovery_grant=g` })
			);

		await expect(
			actions.resolve(
				post(
					{
						mode: 'email',
						value: 'user@example.com',
						email_challenge_id: 'c1',
						email_code: '123456',
						...CARRIED
					},
					fetch,
					opts
				)
			)
		).rejects.toMatchObject({ status: 303, location: `${SAML_LOGIN_URL}&discovery_grant=g` });
		expect(grantBody(fetch)).toMatchObject({
			tenant_id: 'default',
			expected_tenant_id: 'default',
			return_to: SAML_LOGIN_URL,
			login_hint: 'user@example.com'
		});
	});

	it('shows the form again with the SAML context after a wrong email code', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(tenantHostConfig()))
			.mockResolvedValueOnce(jsonResponse({ error: 'invalid_request' }, 400));

		const result = await actions.resolve(
			post(
				{
					mode: 'email',
					value: 'user@example.com',
					email_challenge_id: 'c1',
					email_code: '123456',
					...CARRIED
				},
				fetch,
				opts
			)
		);

		expect(result).toMatchObject({
			status: 400,
			data: expect.objectContaining({
				errorCode: 'invalid_or_expired_code',
				returnTo: SAML_LOGIN_URL,
				expectedTenantId: 'default'
			})
		});
	});

	it('issues the grant for a tenant code too', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(tenantHostConfig()))
			.mockResolvedValueOnce(jsonResponse({ result: 'resolved', candidate }))
			.mockResolvedValueOnce(
				jsonResponse({ grant: 'g', login_url: `${SAML_LOGIN_URL}&discovery_grant=g` })
			);

		await expect(
			actions.resolve(post({ mode: 'tenant_code', value: 'default', ...CARRIED }, fetch, opts))
		).rejects.toMatchObject({ status: 303, location: `${SAML_LOGIN_URL}&discovery_grant=g` });
		expect(grantBody(fetch)).toMatchObject({ return_to: SAML_LOGIN_URL });
	});
});

describe('which /discover is the common discovery URL', () => {
	async function resolveLocation(url: string, originalHost?: string) {
		const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(tenantHostConfig()));
		try {
			await actions.resolve(
				post({ mode: 'tenant_code', value: 'x', ...CARRIED }, fetch, { url, originalHost })
			);
		} catch (error) {
			return (error as { location: string }).location;
		}
		return null;
	}

	it('does not treat another host as the common entry', async () => {
		expect(await resolveLocation('https://other.example.test/discover?/resolve')).toBe('/login');
	});

	it('does not treat another path as the common entry', async () => {
		expect(await resolveLocation(`${HOST}/other?/resolve`)).toBe('/login');
		expect(await resolveLocation(`${HOST}/discover/extra?/resolve`)).toBe('/login');
		expect(await resolveLocation(`${HOST}/login?/resolve`)).toBe('/login');
	});

	it('does not treat another public host as the common entry when the Login UI is proxied', async () => {
		expect(
			await resolveLocation(
				'https://ar-login-ui.example.workers.dev/discover?/resolve',
				'other.example.test'
			)
		).toBe('/login');
	});

	it('still renders the page for a GET with extra query parameters on the common discovery URL', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(tenantHostConfig()));
		const url = `${HOST}/discover?lang=ja&expected_tenant_id=default&return_to=${encodeURIComponent(SAML_LOGIN_URL)}`;

		const data = (await load({
			fetch,
			cookies: createCookies(),
			request: new Request(url),
			url: new URL(url)
		} as never)) as Record<string, unknown>;

		expect(data.returnTo).toBe(SAML_LOGIN_URL);
	});

	it('keeps redirecting a tenant-host GET on another path to /login', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(tenantHostConfig()));
		const url = `${HOST}/discover/extra`;
		await expect(
			load({
				fetch,
				cookies: createCookies(),
				request: new Request(url),
				url: new URL(url)
			} as never)
		).rejects.toMatchObject({ status: 303, location: '/login' });
	});
});
