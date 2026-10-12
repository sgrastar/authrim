import { beforeEach, describe, expect, it, vi } from 'vitest';
import { load as loginLoad } from '../routes/login/+page.server';
import { actions as discoverActions, load as discoverLoad } from '../routes/discover/+page.server';
import { clearLoginDiscoveryConfigCacheForTests } from '../lib/login-discovery-config-cache';
import { resolveDiscoveryHiddenFields } from '../lib/discovery-ui';

// A SAML SP-initiated SSO sends a browser with no session to the Login UI. On a common-entry host
// the Login UI first asks for the tenant at /discover, and the SAML query must survive that trip.

const HOST = 'https://conformance.authrim.com';
const SAML_QUERY =
	'saml_request_id=ONELOGIN_123&saml_sp_entity_id=https%3A%2F%2Fsamlsp.com&return_to=saml_sso';
const SAML_LOGIN_URL = `${HOST}/login?${SAML_QUERY}`;
const FORCE_AUTHN_LOGIN_URL = `${SAML_LOGIN_URL}&force_authn=true`;

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

function discoveryConfig(overrides: Record<string, unknown> = {}, configOverrides = {}) {
	return {
		config: {
			tenant_id: 'default',
			mode: 'discovery_optional',
			discovery_methods: ['email_exact', 'tenant_code', 'tenant_slug'],
			selection_policy: 'select_if_multiple',
			allow_manual_tenant_entry: true,
			remember_last_tenant: true,
			redirect_default_login_to_discovery: true,
			require_common_discovery_before_login: true,
			redirect_tenant_discover_to_common_entry: true,
			...configOverrides
		},
		single_tenant_mode: false,
		is_common_entry_host: true,
		common_discover_url: `${HOST}/discover`,
		...overrides
	};
}

function loginEvent(url: string, fetch: ReturnType<typeof vi.fn>, cookies = createCookies()) {
	return { cookies, fetch, request: new Request(url), url: new URL(url) } as never;
}

async function loginRedirect(event: never): Promise<{ status: number; location: string }> {
	try {
		await loginLoad(event);
	} catch (error) {
		return error as { status: number; location: string };
	}
	throw new Error('expected a redirect');
}

describe('/login on a common-entry host keeps the SAML context through /discover', () => {
	beforeEach(() => {
		clearLoginDiscoveryConfigCacheForTests();
	});

	it('passes the full SAML login URL to /discover as return_to', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(discoveryConfig()));

		const redirect = await loginRedirect(loginEvent(SAML_LOGIN_URL, fetch));

		expect(redirect.status).toBe(303);
		const target = new URL(redirect.location, HOST);
		expect(target.pathname).toBe('/discover');
		expect(target.searchParams.get('return_to')).toBe(SAML_LOGIN_URL);
		expect(target.searchParams.get('expected_tenant_id')).toBe('default');
	});

	it('keeps force_authn in the return_to', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(discoveryConfig()));

		const redirect = await loginRedirect(loginEvent(FORCE_AUTHN_LOGIN_URL, fetch));

		const returnTo = new URL(redirect.location, HOST).searchParams.get('return_to');
		expect(returnTo).toBe(FORCE_AUTHN_LOGIN_URL);
		expect(new URL(returnTo as string).searchParams.get('force_authn')).toBe('true');
	});

	it('treats return_to=saml_sso alone as a protocol context', async () => {
		const url = `${HOST}/login?return_to=saml_sso`;
		const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(discoveryConfig()));

		const redirect = await loginRedirect(loginEvent(url, fetch));

		expect(new URL(redirect.location, HOST).searchParams.get('return_to')).toBe(url);
	});

	it('uses the public host of a proxied Login UI in return_to', async () => {
		const proxied = `https://ar-login-ui.pages.dev/login?${SAML_QUERY}`;
		const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(discoveryConfig()));
		const event = {
			cookies: createCookies(),
			fetch,
			request: new Request(proxied, {
				headers: { 'x-authrim-original-host': 'conformance.authrim.com' }
			}),
			url: new URL(proxied)
		} as never;

		const redirect = await loginRedirect(event);

		expect(new URL(redirect.location, HOST).searchParams.get('return_to')).toBe(SAML_LOGIN_URL);
	});

	it('expects the tenant named by tenant_hint when the SAML request belongs to another tenant', async () => {
		const url = `${SAML_LOGIN_URL}&tenant_hint=acme`;
		const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(discoveryConfig()));

		const redirect = await loginRedirect(loginEvent(url, fetch));

		const target = new URL(redirect.location, HOST);
		expect(target.searchParams.get('expected_tenant_id')).toBe('acme');
		expect(target.searchParams.get('return_to')).toBe(url);
	});

	it.each(['', 'ACME', 'acme/../x', '-acme', 'acme-', 'a b', 'a'.repeat(64)])(
		'ignores a malformed tenant_hint (%j) and falls back to the host tenant',
		async (hint) => {
			const url = `${SAML_LOGIN_URL}&tenant_hint=${encodeURIComponent(hint)}`;
			const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(discoveryConfig()));

			const redirect = await loginRedirect(loginEvent(url, fetch));

			expect(new URL(redirect.location, HOST).searchParams.get('expected_tenant_id')).toBe(
				'default'
			);
		}
	);

	it('uses tenant_hint for expected_tenant_id when an invalid grant sends the SAML login back to discovery', async () => {
		const url = `${SAML_LOGIN_URL}&tenant_hint=acme&discovery_grant=expired`;
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryConfig()))
			.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400));

		const redirect = await loginRedirect(loginEvent(url, fetch));

		const target = new URL(redirect.location);
		expect(target.pathname).toBe('/discover');
		expect(target.searchParams.get('expected_tenant_id')).toBe('acme');
		expect(target.searchParams.get('return_to')).toBe(`${SAML_LOGIN_URL}&tenant_hint=acme`);
	});

	it.each([
		['no tenant_hint', ''],
		['a malformed tenant_hint', '&tenant_hint=ACME%2F..']
	])('keeps the configured tenant for the invalid-grant recovery with %s', async (_name, hint) => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryConfig()))
			.mockResolvedValueOnce(jsonResponse({ valid: false }));

		const redirect = await loginRedirect(
			loginEvent(`${SAML_LOGIN_URL}${hint}&discovery_grant=bad`, fetch)
		);

		expect(new URL(redirect.location).searchParams.get('expected_tenant_id')).toBe('default');
	});

	it('does not apply tenant_hint to the invalid-grant recovery of a plain /login', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryConfig()))
			.mockResolvedValueOnce(jsonResponse({ valid: false }));

		const redirect = await loginRedirect(
			loginEvent(`${HOST}/login?tenant_hint=acme&discovery_grant=bad`, fetch)
		);

		expect(new URL(redirect.location).searchParams.get('expected_tenant_id')).toBe('default');
	});

	it('keeps the host tenant, not tenant_hint, when a tenant host requires common discovery', async () => {
		const url = `https://acme.authrim.com/login?${SAML_QUERY}&tenant_hint=acme`;
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse(discoveryConfig({ is_common_entry_host: false }, { tenant_id: 'other' }))
			);

		const redirect = await loginRedirect(loginEvent(url, fetch));

		expect(new URL(redirect.location).searchParams.get('expected_tenant_id')).toBe('other');
	});

	it('leaves a plain /login redirect to /discover unchanged', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(discoveryConfig()));

		const redirect = await loginRedirect(loginEvent(`${HOST}/login`, fetch));

		expect(redirect.location).toBe('/discover');
	});

	it('does not redirect a plain /login with only unrelated query to carry it', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(discoveryConfig()));

		const redirect = await loginRedirect(loginEvent(`${HOST}/login?login_hint=a%40b.c`, fetch));

		expect(redirect.location).toBe('/discover');
	});

	it('does not loop: the grant-stripped SAML login URL passes once after a verified grant', async () => {
		// 1. The grant arrives on the SAML login URL and is verified.
		const grantFetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryConfig()))
			.mockResolvedValueOnce(
				jsonResponse({ valid: true, tenant_id: 'default', target_url: SAML_LOGIN_URL })
			);
		const cookies = createCookies();
		const redirect = await loginRedirect(
			loginEvent(`${SAML_LOGIN_URL}&discovery_grant=g`, grantFetch, cookies)
		);
		expect(redirect.location).toBe(SAML_LOGIN_URL);
		expect(cookies.set).toHaveBeenCalledWith(
			'authrim_discovery_grant_verified',
			SAML_LOGIN_URL,
			expect.objectContaining({ path: '/login', httpOnly: true })
		);

		// 2. The redirected request carries no grant, but the common-entry host lets it through.
		const nextFetch = vi.fn().mockResolvedValueOnce(jsonResponse(discoveryConfig()));
		const result = await loginLoad(loginEvent(SAML_LOGIN_URL, nextFetch, cookies));
		expect(result).toEqual({});
		expect(cookies.delete).toHaveBeenCalledWith('authrim_discovery_grant_verified', {
			path: '/login'
		});

		// 3. The pass is single-use: a repeat visit goes back to discovery with the context.
		const repeatFetch = vi.fn().mockResolvedValueOnce(jsonResponse(discoveryConfig()));
		const again = await loginRedirect(loginEvent(SAML_LOGIN_URL, repeatFetch, cookies));
		expect(new URL(again.location, HOST).searchParams.get('return_to')).toBe(SAML_LOGIN_URL);
	});

	it('does not accept a verified-grant cookie issued for a different SAML request', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(discoveryConfig()));
		const cookies = createCookies({
			authrim_discovery_grant_verified: `${HOST}/login?saml_request_id=OTHER&return_to=saml_sso`
		});

		const redirect = await loginRedirect(loginEvent(SAML_LOGIN_URL, fetch, cookies));

		expect(new URL(redirect.location, HOST).pathname).toBe('/discover');
	});
});

function discoverEvent(url: string, fetch: ReturnType<typeof vi.fn>) {
	return { fetch, cookies: createCookies(), request: new Request(url), url: new URL(url) } as never;
}

function resolveEvent(
	fields: Record<string, string>,
	fetch: ReturnType<typeof vi.fn>,
	url = `${HOST}/discover?/resolve`
) {
	return {
		fetch,
		cookies: createCookies(),
		request: new Request(url, { method: 'POST', body: new URLSearchParams(fields) }),
		url: new URL(url)
	} as never;
}

const CARRIED = { expected_tenant_id: 'default', return_to: FORCE_AUTHN_LOGIN_URL };

const defaultCandidate = {
	tenant_id: 'default',
	tenant_code: 'default',
	display_name: 'Default',
	logo_url: null,
	login_url: `${HOST}/login`,
	source: 'email_exact'
};

function grantRequestBody(fetch: ReturnType<typeof vi.fn>) {
	const call = fetch.mock.calls.find(([path]) => path === '/api/auth/discovery/grant');
	return JSON.parse(String((call?.[1] as RequestInit).body));
}

describe('/discover keeps return_to through every step', () => {
	it('renders the discover page with the carried return_to and expected_tenant_id', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(discoveryConfig()));
		const url = `${HOST}/discover?expected_tenant_id=default&return_to=${encodeURIComponent(FORCE_AUTHN_LOGIN_URL)}`;

		const data = (await discoverLoad(discoverEvent(url, fetch))) as Record<string, unknown>;

		expect(data.returnTo).toBe(FORCE_AUTHN_LOGIN_URL);
		expect(data.expectedTenantId).toBe('default');
	});

	it('returns to the SAML login URL with a grant after a tenant code is resolved', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryConfig()))
			.mockResolvedValueOnce(jsonResponse({ result: 'resolved', candidate: defaultCandidate }))
			.mockResolvedValueOnce(
				jsonResponse({ grant: 'g', login_url: `${FORCE_AUTHN_LOGIN_URL}&discovery_grant=g` })
			);

		await expect(
			discoverActions.resolve(
				resolveEvent({ mode: 'tenant_code', value: 'default', ...CARRIED }, fetch)
			)
		).rejects.toMatchObject({
			status: 303,
			location: `${FORCE_AUTHN_LOGIN_URL}&discovery_grant=g`
		});
		expect(grantRequestBody(fetch)).toMatchObject({
			tenant_id: 'default',
			expected_tenant_id: 'default',
			return_to: FORCE_AUTHN_LOGIN_URL
		});
	});

	it('hands return_to to the grant after the email code is verified', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryConfig()))
			.mockResolvedValueOnce(jsonResponse({ result: 'resolved', candidate: defaultCandidate }))
			.mockResolvedValueOnce(
				jsonResponse({ grant: 'g', login_url: `${FORCE_AUTHN_LOGIN_URL}&discovery_grant=g` })
			);

		await expect(
			discoverActions.resolve(
				resolveEvent(
					{
						mode: 'email',
						value: 'user@example.com',
						email_challenge_id: 'c1',
						email_code: '123456',
						...CARRIED
					},
					fetch
				)
			)
		).rejects.toMatchObject({ status: 303 });
		expect(grantRequestBody(fetch)).toMatchObject({
			return_to: FORCE_AUTHN_LOGIN_URL,
			expected_tenant_id: 'default',
			login_hint: 'user@example.com'
		});
	});

	it('returns the carried context from the email-code-sent step so the code form can repost it', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryConfig()))
			.mockResolvedValueOnce(
				jsonResponse({ challenge_id: 'c1', expires_in: 600, status: 'code_sent' }, 202)
			);

		const result = await discoverActions.resolve(
			resolveEvent({ mode: 'email', value: 'user@example.com', ...CARRIED }, fetch)
		);

		expect(result).toMatchObject({
			result: 'email_code_sent',
			returnTo: FORCE_AUTHN_LOGIN_URL,
			expectedTenantId: 'default'
		});
	});

	it('returns the carried context after a wrong email code so the form can be shown again', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryConfig()))
			.mockResolvedValueOnce(jsonResponse({ error: 'invalid_request' }, 400));

		const result = await discoverActions.resolve(
			resolveEvent(
				{
					mode: 'email',
					value: 'user@example.com',
					email_challenge_id: 'c1',
					email_code: '123456',
					...CARRIED
				},
				fetch
			)
		);

		expect(result).toMatchObject({
			status: 400,
			data: expect.objectContaining({
				errorCode: 'invalid_or_expired_code',
				returnTo: FORCE_AUTHN_LOGIN_URL,
				expectedTenantId: 'default'
			})
		});
	});

	it('returns the carried context when the value is missing', async () => {
		const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(discoveryConfig()));

		const result = await discoverActions.resolve(
			resolveEvent({ mode: 'tenant_code', value: '', ...CARRIED }, fetch)
		);

		expect(result).toMatchObject({
			status: 400,
			data: expect.objectContaining({ returnTo: FORCE_AUTHN_LOGIN_URL })
		});
	});

	it('returns the carried context when the tenant is not found', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryConfig()))
			.mockResolvedValueOnce(jsonResponse({ result: 'not_found', code: 'tenant_code_not_found' }));

		const result = await discoverActions.resolve(
			resolveEvent({ mode: 'tenant_code', value: 'nope', ...CARRIED }, fetch)
		);

		expect(result).toMatchObject({
			status: 404,
			data: expect.objectContaining({ returnTo: FORCE_AUTHN_LOGIN_URL })
		});
	});

	it('returns the carried context when discovery fails', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryConfig()))
			.mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 500));

		const result = await discoverActions.resolve(
			resolveEvent({ mode: 'tenant_code', value: 'x', ...CARRIED }, fetch)
		);

		expect(result).toMatchObject({
			status: 500,
			data: expect.objectContaining({ returnTo: FORCE_AUTHN_LOGIN_URL })
		});
	});

	it('returns the carried context with the candidate list when several tenants match', async () => {
		const other = { ...defaultCandidate, tenant_id: 'second', tenant_code: 'second' };
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryConfig()))
			.mockResolvedValueOnce(
				jsonResponse({ result: 'multiple', candidates: [defaultCandidate, other] })
			);

		const result = await discoverActions.resolve(
			resolveEvent({ mode: 'tenant_slug', value: 'x', ...CARRIED }, fetch)
		);

		expect(result).toMatchObject({
			result: 'multiple',
			returnTo: FORCE_AUTHN_LOGIN_URL,
			expectedTenantId: 'default'
		});
	});

	it('returns the carried context with a single candidate under always_select', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse(discoveryConfig({}, { selection_policy: 'always_select' }))
			)
			.mockResolvedValueOnce(jsonResponse({ result: 'resolved', candidate: defaultCandidate }));

		const result = await discoverActions.resolve(
			resolveEvent({ mode: 'tenant_code', value: 'default', ...CARRIED }, fetch)
		);

		expect(result).toMatchObject({
			result: 'multiple',
			returnTo: FORCE_AUTHN_LOGIN_URL,
			expectedTenantId: 'default'
		});
	});

	it('returns the carried context when manual entry is required', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryConfig()))
			.mockResolvedValueOnce(
				jsonResponse({
					result: 'manual_required',
					methods: ['tenant_code'],
					allow_manual_tenant_entry: true
				})
			);

		const result = await discoverActions.resolve(
			resolveEvent({ mode: 'tenant_slug', value: 'x', ...CARRIED }, fetch)
		);

		expect(result).toMatchObject({
			result: 'manual_required',
			returnTo: FORCE_AUTHN_LOGIN_URL
		});
	});

	it('returns the carried context when email discovery is disabled', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse(discoveryConfig({}, { discovery_methods: ['tenant_code'] }))
			);

		const result = await discoverActions.resolve(
			resolveEvent({ mode: 'email', value: 'a@b.c', ...CARRIED }, fetch)
		);

		expect(result).toMatchObject({
			status: 403,
			data: expect.objectContaining({ returnTo: FORCE_AUTHN_LOGIN_URL })
		});
	});

	it('auto-skips a single-tenant chooser with the SAML return_to in the grant', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse(
					discoveryConfig(
						{ single_active_tenant_candidate: defaultCandidate },
						{ skip_discovery_if_only_one_tenant: true }
					)
				)
			)
			.mockResolvedValueOnce(
				jsonResponse({ grant: 'g', login_url: `${FORCE_AUTHN_LOGIN_URL}&discovery_grant=g` })
			);
		const url = `${HOST}/discover?expected_tenant_id=default&return_to=${encodeURIComponent(FORCE_AUTHN_LOGIN_URL)}`;

		await expect(discoverLoad(discoverEvent(url, fetch))).rejects.toMatchObject({
			status: 303,
			location: `${FORCE_AUTHN_LOGIN_URL}&discovery_grant=g`
		});
		expect(grantRequestBody(fetch)).toMatchObject({ return_to: FORCE_AUTHN_LOGIN_URL });
	});

	it('skips the chooser in tenant_only mode with the SAML return_to in the grant', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(discoveryConfig({}, { mode: 'tenant_only' })))
			.mockResolvedValueOnce(
				jsonResponse({ grant: 'g', login_url: `${FORCE_AUTHN_LOGIN_URL}&discovery_grant=g` })
			);
		const url = `${HOST}/discover?expected_tenant_id=default&return_to=${encodeURIComponent(FORCE_AUTHN_LOGIN_URL)}`;

		await expect(discoverLoad(discoverEvent(url, fetch))).rejects.toMatchObject({
			status: 303,
			location: `${FORCE_AUTHN_LOGIN_URL}&discovery_grant=g`
		});
		expect(grantRequestBody(fetch)).toMatchObject({
			tenant_id: 'default',
			return_to: FORCE_AUTHN_LOGIN_URL
		});
	});
});

describe('resolveDiscoveryHiddenFields', () => {
	const data = {
		inviteToken: null,
		expectedTenantId: 'default',
		returnTo: FORCE_AUTHN_LOGIN_URL,
		loginHint: null
	};

	it('uses the page query when no form result exists', () => {
		expect(resolveDiscoveryHiddenFields(data, undefined)).toMatchObject({
			expectedTenantId: 'default',
			returnTo: FORCE_AUTHN_LOGIN_URL
		});
	});

	it('keeps the context the action returned when the re-rendered page has lost its query', () => {
		const lost = { inviteToken: null, expectedTenantId: null, returnTo: null, loginHint: null };
		expect(
			resolveDiscoveryHiddenFields(lost, {
				expectedTenantId: 'default',
				returnTo: FORCE_AUTHN_LOGIN_URL,
				emailChallengeId: 'c1',
				loginHint: 'user@example.com'
			})
		).toEqual({
			inviteToken: null,
			expectedTenantId: 'default',
			returnTo: FORCE_AUTHN_LOGIN_URL,
			loginHint: 'user@example.com',
			emailChallengeId: 'c1'
		});
	});
});
