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
			// The next page of the activity: its cursor passed on, nothing else.
			calls = [];
			await view('/account?activity_cursor=next_1');
			expect(calls.find((call) => call.path === '/api/account/operations')).toBeDefined();
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
			routes['/api/account/sessions/s-z'] = (_body, init) =>
				init.method === 'DELETE' ? json({ ok: true, session: { id: 's-z' } }) : json({}, 405);
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
			// This browser's own: signed out (the transaction given up first), then home.
			await expect(post('session_revoke', { session: 's-a' })).rejects.toMatchObject({
				status: 303,
				location: '/'
			});
			expect(calls.some((call) => call.path === '/api/v1/auth/direct/logout')).toBe(true);
			expect(store.txn.state).toBe('abandoned');
		});
	});
});
