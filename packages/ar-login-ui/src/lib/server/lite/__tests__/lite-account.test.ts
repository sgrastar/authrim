/**
 * The lite account page (PR7b, routes `/__lite/account` and `/__lite/account/[...path]`): a
 * transaction bound by ar-auth to the browser's session (modelled here: made only for `s-a`), the
 * tenant's placements composed as the SPA composes them, and signing out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { actions, load } from '../../../../routes/__lite/account/+page.server';

type Handler = (body: Record<string, unknown>, init: RequestInit) => Response;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers }
	});

let calls: Array<{ path: string; body: Record<string, unknown>; headers: Headers }>;
let routes: Record<string, Handler>;
let store: ReturnType<typeof fakeStore>;
let sessionCookie: string | null;
let sessionLive: boolean;
let accountPageEnabled: boolean;
let methods: Record<string, unknown>;

/** An in-memory LiteTxnStore of one transaction; made only for the session `s-a` (as ar-auth). */
function fakeStore() {
	let txn: {
		id: string;
		bound: Record<string, unknown> & { sessionId: string | null; challengeId: string | null };
		state: string;
		version: number;
		csrfToken: string;
		data: Record<string, unknown>;
		createdAt: number;
		expiresAt: number;
	} | null = null;
	const operations = new Map<
		string,
		{ status: 'running' | 'done'; attempt: number; result?: unknown }
	>();
	const view = () => structuredClone(txn!);
	function move(m: { expectedVersion: number; to: string; patch?: Record<string, unknown> }) {
		if (!txn) return 'not_found';
		if (txn.state === 'completed' || txn.state === 'abandoned') return 'finished';
		if (m.expectedVersion !== txn.version) return 'version_mismatch';
		const data = { ...txn.data };
		for (const [key, value] of Object.entries(m.patch ?? {})) {
			if (value === null) delete data[key];
			else data[key] = structuredClone(value);
		}
		txn = { ...txn, data, state: m.to, version: txn.version + 1 };
		return null;
	}
	const binding = {
		create: vi.fn(async (call: Record<string, unknown>) => {
			if (call.purpose !== 'account') return { ok: false, reason: 'unsupported_purpose' };
			if (call.sessionId !== 's-a') return { ok: false, reason: 'session_invalid' };
			if (!txn) {
				txn = {
					id: 'txn-1',
					bound: {
						tenantId: 'default',
						publicOrigin: 'https://id.example',
						purpose: 'account',
						clientId: (call.clientId as string | null) ?? null,
						challengeId: null,
						returnTo: (call.returnTo as string | null) ?? null,
						policyRevision: 'rev-1',
						sessionId: 's-a',
						userId: 'user-a'
					},
					state: 'open',
					version: 1,
					csrfToken: 'csrf-1',
					data: {},
					createdAt: 0,
					expiresAt: Number.MAX_SAFE_INTEGER
				};
			}
			return { ok: true, txn: view(), reused: false };
		}),
		// As ar-auth: a transaction bound to a session is read only with that session, live.
		get: vi.fn(async (call: { sessionId?: string | null }) => {
			if (!txn) return { ok: false, reason: 'not_found' };
			if (txn.bound.sessionId && (call.sessionId !== txn.bound.sessionId || !sessionLive)) {
				return { ok: false, reason: 'session_invalid' };
			}
			return { ok: true, txn: view() };
		}),
		transition: vi.fn(async (call: Record<string, unknown>) => {
			const refused = move(call as never);
			return refused ? { ok: false, reason: refused } : { ok: true, txn: view() };
		}),
		beginOperation: vi.fn(async (call: { operationId: string }) => {
			const existing = operations.get(call.operationId);
			if (existing) {
				return existing.status === 'done'
					? { ok: true, status: 'done', result: existing.result }
					: { ok: true, status: 'running' };
			}
			operations.set(call.operationId, { status: 'running', attempt: 1 });
			return { ok: true, status: 'started', attempt: 1 };
		}),
		completeOperation: vi.fn(
			async (call: {
				operationId: string;
				result: unknown;
				transition?: Record<string, unknown>;
			}) => {
				const operation = operations.get(call.operationId);
				if (!operation) return { ok: false, reason: 'not_found' };
				operations.set(call.operationId, { ...operation, status: 'done', result: call.result });
				if (!call.transition) return { ok: true, txn: view() };
				const refused = move(call.transition as never);
				return refused ? { ok: false, reason: refused } : { ok: true, txn: view() };
			}
		),
		issueStartGrant: vi.fn()
	};
	return {
		binding,
		get txn() {
			return txn!;
		},
		set(patch: Record<string, unknown>) {
			txn = { ...txn!, ...patch } as typeof txn;
		}
	};
}

function event(init: { action?: string; form?: Record<string, string>; path?: string } = {}) {
	const url = new URL(
		`https://id.example${init.path ?? '/account'}${init.action ? `?/${init.action}` : ''}`
	);
	const cookies = new Map<string, string>([['__Host-authrim_lite', 'b'.repeat(43)]]);
	if (sessionCookie) cookies.set('authrim_session', sessionCookie);
	const body = init.form ? new URLSearchParams(init.form).toString() : undefined;
	return {
		url,
		route: { id: '/__lite/account' },
		request: new Request(url, {
			method: init.form ? 'POST' : 'GET',
			headers: body ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
			body
		}),
		cookies: {
			get: (name: string) => cookies.get(name),
			set: vi.fn((name: string, value: string) => cookies.set(name, value))
		},
		locals: {
			locale: 'en',
			authenticationMethods: {
				methods,
				ui: {
					selfService: { accountPageEnabled, accountPagePath: '/account' },
					defaultLocale: 'en'
				}
			},
			edge: {
				source: 'router',
				originVerified: init.form ? true : null,
				clientIp: '203.0.113.1',
				publicOrigin: 'https://id.example'
			}
		},
		platform: {
			env: {
				AR_ROUTER: {
					fetch: vi.fn(async (target: string, requestInit: RequestInit) => {
						const parsed = new URL(target);
						const requestBody = requestInit.body
							? (JSON.parse(String(requestInit.body)) as Record<string, unknown>)
							: {};
						calls.push({
							path: parsed.pathname,
							body: requestBody,
							headers: new Headers(requestInit.headers)
						});
						const handler = routes[parsed.pathname];
						return handler ? handler(requestBody, requestInit) : json({ error: 'not_found' }, 404);
					})
				},
				LITE_TXN: store.binding
			}
		}
	} as unknown as RequestEvent;
}

const OP = 'o'.repeat(22);
const post = (action: string, form: Record<string, string> = {}) =>
	(actions as Record<string, (e: RequestEvent) => Promise<unknown>>)[action](
		event({ action, form: { txn: 'txn-1', csrf: 'csrf-1', op: OP, ...form } })
	);
const view = (path?: string) =>
	(load as unknown as (e: RequestEvent) => Promise<Record<string, unknown>>)(event({ path }));

const profile = (registration = 'registered', amr: string[] = ['pwd']) =>
	json({
		profile: { user_id: 'user-a', registration_state: registration, email: 'a@example.com' },
		session: { id: 's-a', amr }
	});

beforeEach(() => {
	calls = [];
	store = fakeStore();
	sessionCookie = 's-a';
	sessionLive = true;
	accountPageEnabled = true;
	methods = { passkey: { enabled: false }, totp: { enabled: true }, external: { enabled: false } };
	routes = {
		'/api/account/capabilities': () =>
			json({
				account_page: {
					definition: {
						title: 'My account',
						screens: [
							{ id: 'overview', screen_key: 'account_overview' },
							{ id: 'profile', screen_key: 'account_profile', width: 'half' },
							{ id: 'passkeys', screen_key: 'account_passkeys', condition: 'passkey_enabled' },
							{ id: 'sessions', screen_key: 'account_sessions', condition: 'multiple_sessions' },
							{ id: 'members', screen_key: 'account_custom', show_for_guests: false }
						]
					},
					screens: [
						{
							screen_key: 'account_overview',
							fields: [
								{
									block_type: 'heading',
									field: 'heading.account_overview',
									label: 'Manage',
									order: 10
								},
								{ block_type: 'link', field: 'l', label: 'Passkeys', href: '#passkeys', order: 20 },
								{ block_type: 'link', field: 'l2', label: 'Profile', href: '#profile', order: 30 }
							]
						},
						{
							screen_key: 'account_profile',
							fields: [
								{
									block_type: 'account_profile_widget',
									field: 'account.profile',
									label: 'User profile'
								}
							]
						},
						{
							screen_key: 'account_passkeys',
							fields: [
								{
									block_type: 'account_passkey_widget',
									field: 'account.passkeys',
									label: 'Passkeys'
								}
							]
						},
						{
							screen_key: 'account_sessions',
							fields: [
								{
									block_type: 'account_session_widget',
									field: 'account.sessions',
									label: 'Sessions'
								}
							]
						},
						{
							screen_key: 'account_custom',
							fields: [{ block_type: 'text', field: 't', label: '', text: 'Members only' }]
						}
					]
				}
			}),
		'/api/account/profile': () => profile(),
		'/api/account/sessions': () => json({ sessions: [{ id: 's-a' }] }),
		'/api/v1/auth/direct/logout': () =>
			json({ success: true }, 200, { 'Set-Cookie': 'authrim_session=; Path=/; Max-Age=0' })
	};
});

describe('the lite account page', () => {
	it("draws the tenant's placements in order, as their conditions and the person allow", async () => {
		const page = (await view()) as {
			page: string;
			placements: Array<{ id: string; blocks: Array<Record<string, unknown>> }>;
			text: { title: string };
		};
		expect(page.page).toBe('account');
		expect(page.text.title).toBe('My account');
		expect(store.binding.create).toHaveBeenCalledWith(
			expect.objectContaining({ purpose: 'account', sessionId: 's-a' })
		);
		// One per session, whatever the page's path or query (no return target kept).
		expect(store.binding.create.mock.calls[0][0]).not.toHaveProperty('returnTo');
		// Passkeys off; one session only: those placements are not drawn.
		expect(page.placements.map((placement) => placement.id)).toEqual([
			'overview',
			'profile',
			'members'
		]);
		// A link to a placement not drawn is left out; the overview's heading has no subtitle.
		expect(page.placements[0].blocks).toEqual([
			{ kind: 'heading', label: 'Manage', text: null, column: null },
			{ kind: 'link', label: 'Profile', href: '#profile', column: null }
		]);
		expect(page.placements[1].blocks).toEqual([
			{ kind: 'widget', widget: 'account_profile_widget', title: 'Profile', column: null }
		]);
	});

	it("titles the page with the theme's account title in the page's locale", async () => {
		const e = event();
		(
			e.locals as unknown as { authenticationMethods: { ui: Record<string, unknown> } }
		).authenticationMethods.ui.appearance = {
			textLocalizations: { en: { accountTitle: 'Your space' } }
		};
		const page = (await (load as unknown as (e: RequestEvent) => Promise<Record<string, unknown>>)(
			e
		)) as { text: { title: string } };
		expect(page.text.title).toBe('Your space');
	});

	it('keeps the members-only placements from a guest', async () => {
		routes['/api/account/profile'] = () => profile('guest', ['anon']);
		const page = (await view()) as { placements: Array<{ id: string }> };
		expect(page.placements.map((placement) => placement.id)).toEqual(['overview', 'profile']);
	});

	it('sends a browser without a session to sign in, back here once signed in', async () => {
		sessionCookie = null;
		await expect(view('/account/security')).rejects.toMatchObject({
			status: 303,
			location: '/login?return_to=%2Faccount%2Fsecurity'
		});
		// A session ar-auth does not take (ended, another tenant's): the same.
		sessionCookie = 's-other';
		await expect(view()).rejects.toMatchObject({
			status: 303,
			location: '/login?return_to=%2Faccount'
		});
		// One ar-management does not take: the same.
		sessionCookie = 's-a';
		routes['/api/account/profile'] = () => json({ error: 'unauthorized' }, 401);
		await expect(view()).rejects.toMatchObject({ status: 303 });
	});

	it("sends a tenant's visitor home when it offers no account page", async () => {
		accountPageEnabled = false;
		await expect(view()).rejects.toMatchObject({ status: 303, location: '/' });
		expect(store.binding.create).not.toHaveBeenCalled();
	});

	it('signs out (a guest asked first) and acts on nothing for another session', async () => {
		let stateAtLogout: string | null = null;
		const logout = routes['/api/v1/auth/direct/logout'];
		routes['/api/v1/auth/direct/logout'] = (body, init) => {
			stateAtLogout = store.txn.state;
			return logout(body, init);
		};
		await view();
		await expect(post('sign_out')).rejects.toMatchObject({ status: 303, location: '/' });
		expect(calls.some((call) => call.path === '/api/v1/auth/direct/logout')).toBe(true);
		// Given up before the session ended (it no longer counts as live).
		expect(stateAtLogout).toBe('abandoned');

		store = fakeStore();
		calls = [];
		routes['/api/account/profile'] = () => profile('guest', ['anon']);
		await view();
		await expect(post('sign_out')).resolves.toMatchObject({
			status: 409,
			data: { confirmGuestSignOut: true }
		});
		expect(calls.some((call) => call.path === '/api/v1/auth/direct/logout')).toBe(false);
		await expect(post('sign_out', { confirm: 'guest' })).rejects.toMatchObject({ status: 303 });

		// A profile that cannot be read: whether this is a guest is not known, so no sign-out.
		store = fakeStore();
		calls = [];
		routes['/api/account/profile'] = () => profile();
		await view();
		routes['/api/account/profile'] = () => json({ error: 'server_error' }, 503);
		await expect(post('sign_out')).resolves.toMatchObject({
			status: 503,
			data: { error: 'action_failed' }
		});
		expect(calls.some((call) => call.path === '/api/v1/auth/direct/logout')).toBe(false);
		routes['/api/account/profile'] = () => profile();

		store = fakeStore();
		calls = [];
		await view();
		sessionCookie = 's-b';
		await expect(post('sign_out')).resolves.toMatchObject({
			status: 409,
			data: { error: 'session_changed' }
		});
		expect(calls.some((call) => call.path === '/api/v1/auth/direct/logout')).toBe(false);
	});

	describe('the profile, sessions, devices, consents and activity widgets', () => {
		const withWidgets = () => {
			routes['/api/account/capabilities'] = () =>
				json({
					account_page: {
						definition: {
							screens: [
								{ id: 'profile', screen_key: 'p' },
								{ id: 'sessions', screen_key: 's' },
								{ id: 'devices', screen_key: 'd' },
								{ id: 'consents', screen_key: 'c' },
								{ id: 'activity', screen_key: 'a' }
							]
						},
						screens: [
							{
								screen_key: 'p',
								fields: [{ block_type: 'account_profile_widget', field: 'account.profile' }]
							},
							{
								screen_key: 's',
								fields: [{ block_type: 'account_session_widget', field: 'account.sessions' }]
							},
							{
								screen_key: 'd',
								fields: [{ block_type: 'account_device_list_widget', field: 'account.devices' }]
							},
							{
								screen_key: 'c',
								fields: [{ block_type: 'account_consent_widget', field: 'account.consents' }]
							},
							{
								screen_key: 'a',
								fields: [{ block_type: 'account_activity_widget', field: 'account.activity' }]
							}
						]
					}
				});
			routes['/api/account/sessions'] = () =>
				json({
					sessions: [
						{ id: 's-a', current: true },
						{ id: 's-z', current: false }
					]
				});
			routes['/api/account/devices'] = () =>
				json({ devices: [{ id: 'd1', display_name: 'Laptop' }] });
			routes['/api/account/consents'] = () =>
				json({
					consents: [{ kind: 'oauth_client', clientId: 'c1', scopes: ['openid'], grantedAt: 1 }]
				});
			routes['/api/account/operations'] = () =>
				json({
					operations: [{ id: 'o1', action: 'account.session.revoked', created_at: 1 }],
					pagination: { has_more: true, next_cursor: 'next_1' }
				});
		};

		it('draws each widget with its data, read only for the widgets drawn', async () => {
			withWidgets();
			const page = (await view()) as {
				widgets: Record<string, unknown> & { activity: { nextCursor: string } };
			};
			expect(page.widgets.profile).toEqual({
				name: null,
				email: 'a@example.com',
				emailVerified: false
			});
			expect(page.widgets.sessions).toHaveLength(2);
			expect(page.widgets.devices).toEqual([expect.objectContaining({ title: 'Laptop' })]);
			expect(page.widgets.consents).toHaveLength(1);
			expect(page.widgets.activity.nextCursor).toBe('next_1');
			// The consents in the page's language, not only the browser's.
			expect(
				calls.find((call) => call.path === '/api/account/consents')?.headers.get('Accept-Language')
			).toBe('en');
			// The next page of the activity: its cursor passed on, the page's own query kept (never a
			// form action's key).
			calls = [];
			const next = (await view('/account?lang=ja&/profile_save&activity_cursor=old')) as {
				search: string;
				widgets: { activityNextHref: string };
			};
			expect(calls.find((call) => call.path === '/api/account/operations')).toBeDefined();
			expect(next.search).toBe('?lang=ja&activity_cursor=old');
			expect(next.widgets.activityNextHref).toBe('/account?lang=ja&activity_cursor=next_1');
		});

		it('says the activity is incomplete when the log cannot be read whole', async () => {
			withWidgets();
			routes['/api/account/operations'] = () =>
				json({ error: 'log_query_incomplete', complete: false }, 503);
			const page = (await view()) as {
				widgets: { activityIncomplete: boolean; activity: unknown };
			};
			expect(page.widgets).toMatchObject({ activityIncomplete: true, activity: null });
		});

		it('saves the name, and signs out a session (this one: the browser too)', async () => {
			withWidgets();
			routes['/api/account/profile'] = (body, init) =>
				init.method === 'PATCH' ? json({ profile: { name: body.name } }) : profile();
			for (const id of ['s-z', 's-a']) {
				routes[`/api/account/sessions/${id}`] = (_body, init) =>
					init.method === 'DELETE' ? json({ ok: true, session: { id } }) : json({}, 405);
			}
			await view();
			await expect(post('profile_save', { name: '  Kai  ' })).resolves.toEqual({
				notice: 'saved',
				widget: 'profile'
			});
			expect(
				calls.find((call) => call.path === '/api/account/profile' && call.body.name)?.body
			).toEqual({
				name: 'Kai'
			});
			await expect(post('profile_save', { name: 'x'.repeat(101) })).resolves.toMatchObject({
				status: 400
			});
			await expect(post('session_revoke', { session: 's-z' })).resolves.toEqual({
				notice: 'revoked',
				widget: 'sessions'
			});
			await expect(post('session_revoke', { session: 'a/b' })).resolves.toMatchObject({
				status: 400
			});
			// This browser's own: the transaction given up first, then revoked as any (its record
			// kept), then signed out, home.
			await expect(post('session_revoke', { session: 's-a' })).rejects.toMatchObject({
				status: 303,
				location: '/'
			});
			const revoked = calls.findIndex((call) => call.path === '/api/account/sessions/s-a');
			const loggedOut = calls.findIndex((call) => call.path === '/api/v1/auth/direct/logout');
			expect(revoked).toBeGreaterThanOrEqual(0);
			expect(loggedOut).toBeGreaterThan(revoked);
			expect(store.txn.state).toBe('abandoned');
		});
	});

	describe('passkeys, and the step-up a change of them asks for', () => {
		const passkeyPage = () => {
			methods = {
				passkey: { enabled: true },
				emailCode: { enabled: true, reauthEnabled: true },
				totp: { enabled: true },
				external: { enabled: false }
			};
			routes['/api/account/capabilities'] = () =>
				json({
					account_page: {
						definition: {
							screens: [{ id: 'passkeys', screen_key: 'k', condition: 'passkey_enabled' }]
						},
						screens: [
							{
								screen_key: 'k',
								fields: [{ block_type: 'account_passkey_widget', field: 'account.passkeys' }]
							}
						]
					}
				});
			routes['/api/account/profile'] = () =>
				json({
					profile: {
						user_id: 'user-a',
						registration_state: 'registered',
						email: 'a@example.com',
						email_verified: true
					},
					session: { id: 's-a', amr: ['pwd'] }
				});
			routes['/api/account/passkeys'] = () =>
				json({ passkeys: [{ id: 'pk1', provider: { name: 'iCloud Keychain' }, created_at: 1 }] });
			routes['/api/account/totp'] = () => json({ credentials: [{ id: 't1', status: 'active' }] });
		};
		type Page = {
			widgets: { passkeys: Array<{ id: string; name: string }>; passkeyCreate: unknown };
			stepUp: null | {
				at: string;
				methods: Record<string, boolean>;
				email: { maskedEmail: string } | null;
			};
		};

		it('holds a removal the API asks a step-up for, and makes it once the code is checked', async () => {
			passkeyPage();
			let deletes = 0;
			let recent = false;
			routes['/api/account/passkeys/pk1'] = (_body, init) => {
				if (init.method !== 'DELETE') return json({}, 405);
				deletes++;
				return recent
					? json({ ok: true, passkey: { id: 'pk1', deleted: true } })
					: json({ error: 'reauth_required', reauth_required: true }, 403);
			};
			// As ar-management: a challenge is spent on its check, a wrong code included.
			const spent = new Set<string>();
			let sends = 0;
			routes['/api/account/reauth/email-code/send'] = () => {
				sends++;
				return json({
					challenge_id: `rc-${sends}`,
					expires_in: 300,
					masked_email: 'a***@example.com'
				});
			};
			routes['/api/account/reauth/email-code/complete'] = (body) => {
				const id = String(body.challenge_id);
				if (spent.has(id)) return json({ error: 'invalid_code' }, 400);
				spent.add(id);
				if (body.code !== '123456') return json({ error: 'invalid_code' }, 400);
				recent = true;
				return json({ ok: true, reauth: {} });
			};
			const page = (await view()) as Page;
			expect(page.widgets.passkeys).toEqual([
				expect.objectContaining({ id: 'pk1', name: 'iCloud Keychain' })
			]);
			expect(page.stepUp).toBeNull();
			await expect(post('passkey_delete', { passkey: 'pk1' })).resolves.toMatchObject({
				status: 403,
				data: { stepUp: true, widget: 'passkeys' }
			});
			const held = (await view()) as Page;
			// The methods on for re-authentication: a passkey, the verified address, an authenticator.
			expect(held.stepUp?.methods).toEqual({ passkey: true, email: true, totp: true });
			const at = held.stepUp!.at;
			// A form of another step-up (an older page) does nothing.
			await expect(post('stepup_email_send', { step_up: '1' })).resolves.toMatchObject({
				status: 409,
				data: { error: 'step_up_gone' }
			});
			await expect(post('stepup_email_send', { step_up: at })).resolves.toMatchObject({
				notice: 'step_up_code_sent'
			});
			expect(((await view()) as Page).stepUp?.email).toEqual({
				maskedEmail: 'a***@example.com',
				challenge: 'rc-1'
			});
			await expect(
				post('stepup_email_verify', { step_up: at, challenge: 'rc-1', code: '000000' })
			).resolves.toMatchObject({
				status: 400,
				data: { error: 'code_invalid' }
			});
			// That code is spent: the methods are offered again, the removal still held.
			expect(((await view()) as Page).stepUp).toMatchObject({ email: null, at });
			// A send another post took within the minute (a double submit): no second code.
			const before = sends;
			store.set({
				data: {
					...store.txn.data,
					accountStepUp: { ...(store.txn.data.accountStepUp as object), sendingAt: Date.now() }
				}
			});
			await expect(post('stepup_email_send', { step_up: at })).resolves.toMatchObject({
				notice: 'step_up_code_sending'
			});
			expect(sends).toBe(before);
			store.set({
				data: {
					...store.txn.data,
					accountStepUp: { ...(store.txn.data.accountStepUp as object), sendingAt: null }
				}
			});
			await expect(post('stepup_email_send', { step_up: at })).resolves.toMatchObject({
				notice: 'step_up_code_sent'
			});
			// Proven: the held removal is made (once), the step-up given up.
			// A form of the code spent (an older page) checks nothing against the new one.
			await expect(
				post('stepup_email_verify', { step_up: at, challenge: 'rc-1', code: '123456' })
			).resolves.toMatchObject({ status: 409, data: { error: 'step_up_gone' } });
			// A check another post took (a double submit): not made twice.
			const current = (store.txn.data.accountStepUp as { email: { challengeId: string } }).email
				.challengeId;
			store.set({
				data: {
					...store.txn.data,
					accountStepUp: { ...(store.txn.data.accountStepUp as object), checkingAt: Date.now() }
				}
			});
			await expect(
				post('stepup_email_verify', { step_up: at, challenge: current, code: '123456' })
			).resolves.toMatchObject({ notice: 'step_up_checking' });
			store.set({
				data: {
					...store.txn.data,
					accountStepUp: { ...(store.txn.data.accountStepUp as object), checkingAt: null }
				}
			});
			await expect(
				post('stepup_email_verify', { step_up: at, challenge: current, code: '123456' })
			).resolves.toEqual({
				notice: 'passkey_deleted',
				widget: 'passkeys'
			});
			expect(deletes).toBe(2);
			expect(store.txn.data.accountStepUp).toBeUndefined();
			expect(((await view()) as Page).stepUp).toBeNull();
		});

		it("switches to another way (the change still held), and takes an account's every passkey", async () => {
			passkeyPage();
			routes['/api/account/passkeys/pk1'] = () =>
				json({ error: 'reauth_required', reauth_required: true }, 403);
			// An account's every passkey listed (more than a sign-in's sixteen), kept whole.
			let listed = 40;
			routes['/api/account/reauth/passkey/options'] = () =>
				json({
					challenge_id: 'rp-1',
					options: {
						challenge: 'c'.repeat(43),
						rpId: 'id.example',
						userVerification: 'required',
						allowCredentials: Array.from({ length: listed }, (_, i) => ({
							id: `${'k'.repeat(90)}${i}`,
							type: 'public-key'
						}))
					}
				});
			await view();
			await post('passkey_delete', { passkey: 'pk1' });
			const at = ((await view()) as Page).stepUp!.at;
			await expect(post('stepup_passkey_start', { step_up: at })).resolves.toMatchObject({
				notice: 'step_up_ceremony'
			});
			const ceremony = (await view()) as {
				stepUp: { passkey: { options: { allowCredentials: unknown[] } } };
			};
			expect(ceremony.stepUp.passkey.options.allowCredentials).toHaveLength(40);
			await expect(post('stepup_switch', { step_up: at })).resolves.toMatchObject({
				notice: 'step_up_switched'
			});
			const switched = (await view()) as Page & { stepUp: { passkey: unknown } };
			expect(switched.stepUp).toMatchObject({ at, passkey: null, email: null });
			// So many that the transaction has no room for them: the passkey is a way it cannot take.
			listed = 200;
			await expect(post('stepup_passkey_start', { step_up: at })).resolves.toMatchObject({
				status: 409,
				data: { error: 'passkey_too_many' }
			});
			// A method chosen already: nothing else started over it (another way has its button).
			routes['/api/account/reauth/email-code/send'] = () =>
				json({ challenge_id: 'rc-1', expires_in: 300, masked_email: 'a***@example.com' });
			await post('stepup_email_send', { step_up: at });
			await expect(post('stepup_email_send', { step_up: at })).resolves.toMatchObject({
				notice: 'step_up_underway'
			});
			await expect(post('stepup_passkey_start', { step_up: at })).resolves.toMatchObject({
				notice: 'step_up_underway'
			});
		});

		it('offers the authenticator only with an active one, and gives a held change up', async () => {
			passkeyPage();
			routes['/api/account/totp'] = () => json({ credentials: [{ id: 't1', status: 'pending' }] });
			routes['/api/account/passkeys/pk1'] = () =>
				json({ error: 'reauth_required', reauth_required: true }, 403);
			await view();
			await post('passkey_delete', { passkey: 'pk1' });
			const held = (await view()) as Page;
			expect(held.stepUp?.methods.totp).toBe(false);
			await expect(post('stepup_cancel', { step_up: held.stepUp!.at })).resolves.toMatchObject({
				notice: 'step_up_cancelled'
			});
			expect(store.txn.data.accountStepUp).toBeUndefined();
		});

		it('adds a passkey through its ceremony, and keeps the last way to sign in', async () => {
			passkeyPage();
			routes['/api/account/passkeys/options'] = (body) =>
				json({
					challenge_id: 'pc-1',
					options: {
						rp: { id: 'id.example', name: 'Authrim' },
						user: { id: 'dXNlci0x', name: 'a@example.com', displayName: 'a' },
						challenge: 'Y2hhbGxlbmdl',
						pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
						timeout: 60000,
						excludeCredentials: [],
						authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
						attestation: 'none',
						name: body.device_name
					}
				});
			let completed: Record<string, unknown> | null = null;
			routes['/api/account/passkeys/complete'] = (body) => {
				completed = body;
				return json({ ok: true, passkey: { id: 'pk2' } });
			};
			routes['/api/account/passkeys/pk1'] = () =>
				json({ error: 'remaining_login_method_required' }, 409);
			await view();
			await expect(post('passkey_add', { device_name: 'Laptop' })).resolves.toEqual({
				notice: 'passkey_ceremony',
				widget: 'passkeys'
			});
			const ceremony = (await view()) as { widgets: { passkeyCreate: { challenge: string } } };
			expect(ceremony.widgets.passkeyCreate.challenge).toBe('pc-1');
			const registration = JSON.stringify({
				id: 'Y3JlZA',
				rawId: 'Y3JlZA',
				type: 'public-key',
				response: { clientDataJSON: 'e30', attestationObject: 'o2Nm', transports: ['internal'] }
			});
			await expect(
				post('passkey_add_finish', { challenge: 'pc-1', credential: registration })
			).resolves.toEqual({ notice: 'passkey_added', widget: 'passkeys' });
			expect(completed).toMatchObject({ challenge_id: 'pc-1', device_name: 'Laptop' });
			expect(store.txn.data.accountPasskeyCreate).toBeUndefined();
			await expect(post('passkey_delete', { passkey: 'pk1' })).resolves.toMatchObject({
				status: 409,
				data: { error: 'remaining_method' }
			});
		});

		it("registers next to an account's every passkey (an exclude list too large left out)", async () => {
			passkeyPage();
			let excluded = 40;
			routes['/api/account/passkeys/options'] = () =>
				json({
					challenge_id: 'pc-1',
					options: {
						rp: { id: 'id.example', name: 'Authrim' },
						user: { id: 'dXNlci0x', name: 'a@example.com', displayName: 'a' },
						challenge: 'Y2hhbGxlbmdl',
						pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
						timeout: 60000,
						excludeCredentials: Array.from({ length: excluded }, (_, i) => ({
							id: `${'k'.repeat(90)}${i}`,
							type: 'public-key'
						})),
						authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
						attestation: 'none'
					}
				});
			await view();
			await post('passkey_add', { device_name: '' });
			const kept = (await view()) as {
				widgets: { passkeyCreate: { registration: { excludeCredentials: unknown[] } } };
			};
			expect(kept.widgets.passkeyCreate.registration.excludeCredentials).toHaveLength(40);
			store = fakeStore();
			excluded = 200;
			await view();
			await post('passkey_add', { device_name: '', op: 'z'.repeat(22) });
			const dropped = (await view()) as typeof kept;
			expect(dropped.widgets.passkeyCreate.registration.excludeCredentials).toEqual([]);
		});

		it('draws one ceremony at a time (a step-up gives a passkey being added up)', async () => {
			passkeyPage();
			routes['/api/account/passkeys/options'] = () =>
				json({
					challenge_id: 'pc-1',
					options: {
						rp: { id: 'id.example', name: 'Authrim' },
						user: { id: 'dXNlci0x', name: 'a@example.com', displayName: 'a' },
						challenge: 'Y2hhbGxlbmdl',
						pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
						timeout: 60000,
						excludeCredentials: [],
						authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
						attestation: 'none'
					}
				});
			routes['/api/account/passkeys/pk1'] = () =>
				json({ error: 'reauth_required', reauth_required: true }, 403);
			await view();
			await post('passkey_add', { device_name: '' });
			expect(store.txn.data.accountPasskeyCreate).toBeDefined();
			await post('passkey_delete', { passkey: 'pk1' });
			expect(store.txn.data.accountPasskeyCreate).toBeUndefined();
			const page = (await view()) as { widgets: { passkeyCreate: unknown }; stepUp: unknown };
			expect(page.stepUp).not.toBeNull();
			expect(page.widgets.passkeyCreate).toBeNull();
		});
	});
});
