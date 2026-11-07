/**
 * The lite consent page (PR5c): the consent answer drawn, the decision built from it read again
 * (only the person's choices from the form), made once per form, and relayed: a GET relay, or a
 * POST relay (a denial with response_mode=form_post) whose CSP allows only its destination.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { actions, load } from '../../../../routes/__lite/consent/+page.server';
import { isLiteTxnTransitionAllowed } from '@authrim/ar-lib-core/types/login-ui-lite-txn';
import { liteConsentAllow, liteConsentShown, readLiteConsent } from '../consent';

type Handler = (body: Record<string, unknown>, init: RequestInit) => Response;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers }
	});

/** An in-memory LiteTxnStore: one transaction, its versions and operations. */
function fakeStore() {
	const LEASE = 60_000;
	let txn = {
		id: 'txn-1',
		bound: {
			tenantId: 'default',
			publicOrigin: 'https://id.example',
			purpose: 'login',
			clientId: null as string | null,
			challengeId: null as string | null,
			returnTo: null,
			policyRevision: 'rev-1',
			sessionId: null,
			userId: null
		},
		state: 'open',
		version: 1,
		csrfToken: 'csrf-1',
		data: {
			flow: { interactionId: 'int-1', contractHash: 'hash-1', signature: 'sig-1' }
		} as Record<string, unknown>,
		createdAt: 0,
		expiresAt: Number.MAX_SAFE_INTEGER
	};
	const operations = new Map<
		string,
		{ status: 'running' | 'done'; attempt: number; startedAt: number; result?: unknown }
	>();
	const view = () => structuredClone(txn);
	const finished = () => txn.state === 'completed' || txn.state === 'abandoned';
	function move(m: { expectedVersion: number; to: string; patch?: Record<string, unknown> }) {
		if (finished()) return 'finished';
		if (m.expectedVersion !== txn.version) return 'version_mismatch';
		// As the store: only the moves LITE_TXN_TRANSITIONS allows.
		if (!isLiteTxnTransitionAllowed(txn.state as never, m.to as never)) {
			return 'invalid_transition';
		}
		const data = { ...txn.data };
		for (const [key, value] of Object.entries(m.patch ?? {})) {
			if (value === null) delete data[key];
			else data[key] = structuredClone(value);
		}
		txn = { ...txn, data, state: m.to, version: txn.version + 1 };
		return null;
	}
	const binding = {
		create: vi.fn(async () => ({ ok: true, txn: view(), reused: true })),
		get: vi.fn(async () => ({ ok: true, txn: view() })),
		transition: vi.fn(async (call: Record<string, unknown>) => {
			const refused = move(call as never);
			return refused ? { ok: false, reason: refused } : { ok: true, txn: view() };
		}),
		beginOperation: vi.fn(async (call: { operationId: string }) => {
			const existing = operations.get(call.operationId);
			if (existing && (existing.status === 'done' || Date.now() - existing.startedAt < LEASE)) {
				return existing.status === 'done'
					? { ok: true, status: 'done', result: existing.result }
					: { ok: true, status: 'running' };
			}
			if (finished()) return { ok: false, reason: 'finished' };
			const attempt = (existing?.attempt ?? 0) + 1;
			operations.set(call.operationId, { status: 'running', attempt, startedAt: Date.now() });
			return { ok: true, status: 'started', attempt };
		}),
		completeOperation: vi.fn(
			async (call: {
				operationId: string;
				attempt: number;
				result: unknown;
				transition?: Record<string, unknown>;
			}) => {
				const operation = operations.get(call.operationId);
				if (!operation) return { ok: false, reason: 'not_found' };
				// As the store: an attempt another took over, before a finished one is read back.
				if (operation.attempt !== call.attempt) return { ok: false, reason: 'superseded' };
				if (operation.status === 'done') return { ok: true, txn: view() };
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
		operations,
		get txn() {
			return txn;
		},
		set(patch: Partial<typeof txn>) {
			txn = { ...txn, ...patch };
		}
	};
}

function event(init: { action?: string; form?: Record<string, string>; query?: string } = {}) {
	const search = init.query ?? '';
	const path = init.action
		? `/consent?${search}${search ? '&' : ''}/${init.action}`
		: `/consent${search ? `?${search}` : ''}`;
	const url = new URL(`https://id.example${path}`);
	const cookies = new Map<string, string>([
		['__Host-authrim_lite', 'b'.repeat(43)],
		...Object.entries(browserCookies)
	]);
	const body = init.form ? new URLSearchParams(init.form).toString() : undefined;
	return {
		url,
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
			authenticationMethods: { methods: tenantMethods },
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

let calls: Array<{ path: string; body: Record<string, unknown>; headers: Headers }>;
let routes: Record<string, Handler>;
let store: ReturnType<typeof fakeStore>;
let tenantMethods: Record<string, unknown>;
let browserCookies: Record<string, string>;

const CONSENT = {
	challenge_id: 'cc-1',
	client: { client_id: 'rp-1', client_name: 'Example App', is_trusted: false },
	scopes: [{ name: 'openid' }, { name: 'email' }],
	user: { id: 'u1', email: 'person@example.com' },
	organizations: [
		{ id: 'org-1', name: 'One', type: 'company', is_primary: true },
		{ id: 'org-2', name: 'Two', type: 'company', is_primary: false }
	],
	primary_org: { id: 'org-1', name: 'One', type: 'company', is_primary: true },
	roles: [],
	acting_as: null,
	target_org_id: null,
	features: { org_selector_enabled: true, acting_as_enabled: false, show_roles: false },
	consent_management_enabled: true,
	consent_items: [
		{
			statement_id: 'tos',
			title: 'Terms',
			version_id: 'v1',
			content_hash: 'h1',
			is_required: true,
			enforcement: 'block',
			checkbox_mode: 'required'
		},
		{
			statement_id: 'news',
			title: 'News',
			version_id: 'v2',
			content_hash: null,
			is_required: false,
			enforcement: 'none',
			checkbox_mode: 'optional'
		}
	]
};

let OP = 'o'.repeat(22);
/** Draws the page; its form's nonce is the one the posts below carry. */
const view = async () => {
	const page = await (load as unknown as (e: RequestEvent) => Promise<Record<string, unknown>>)(
		event({ query: 'challenge_id=cc-1' })
	);
	if (typeof page.op === 'string') OP = page.op;
	return page;
};
const post = (action: string, form: Record<string, string> = {}) => {
	const ev = event({
		action,
		form: { txn: 'txn-1', csrf: 'csrf-1', op: OP, ...form },
		query: 'challenge_id=cc-1'
	});
	return {
		ev,
		answer: (actions as Record<string, (e: RequestEvent) => Promise<unknown>>)[action](ev)
	};
};
/** The decisions sent (the consent answer is read with a GET, which has no body). */
const consentPosts = () =>
	calls.filter((call) => call.path === '/auth/consent' && 'challenge_id' in call.body);

beforeEach(() => {
	OP = 'o'.repeat(22);
	calls = [];
	store = fakeStore();
	store.set({ bound: { ...store.txn.bound, challengeId: 'cc-1' } });
	tenantMethods = {};
	browserCookies = { authrim_session: 's1' };
	routes = {
		'/auth/consent': (_body, init) =>
			init.method === 'POST'
				? json(
						{ redirect_url: 'https://id.example/authorize?_consent_confirmation_challenge=x' },
						200,
						{
							'Set-Cookie':
								'authrim_consent_confirmation=b1; Path=/authorize; HttpOnly; SameSite=Lax; Secure; Max-Age=120'
						}
					)
				: json(CONSENT)
	};
});

describe('readLiteConsent', () => {
	it('keeps only what the page draws, checked', () => {
		const view = readLiteConsent({
			...CONSENT,
			client: { ...CONSENT.client, client_uri: 'javascript:alert(1)', policy_uri: 'https://rp/p' }
		});
		expect(view).toMatchObject({
			challengeId: 'cc-1',
			clientName: 'Example App',
			clientUri: null,
			policyUri: 'https://rp/p',
			scopes: ['openid', 'email'],
			defaultOrgId: 'org-1'
		});
		expect(view?.items.map((item) => [item.statementId, item.blocks])).toEqual([
			['tos', true],
			['news', false]
		]);
	});

	it('draws no more items than a decision form can post (the form reader takes 32 fields)', () => {
		const items = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ ...CONSENT.consent_items[1], statement_id: `s${i}` }));
		expect(readLiteConsent({ ...CONSENT, consent_items: items(25) })?.items).toHaveLength(25);
		expect(readLiteConsent({ ...CONSENT, consent_items: items(26) })).toBeNull();
	});

	it('draws every scope Allow grants, or nothing (none left out unsaid)', () => {
		const scopes = (n: number, name = (i: number) => `scope.${i}`) =>
			Array.from({ length: n }, (_, i) => ({ name: name(i) }));
		expect(readLiteConsent({ ...CONSENT, scopes: scopes(26) })?.scopes).toHaveLength(26);
		expect(readLiteConsent({ ...CONSENT, scopes: scopes(101) })).toBeNull();
		expect(
			readLiteConsent({ ...CONSENT, scopes: scopes(1, () => 's'.repeat(256)) })?.scopes
		).toHaveLength(1);
		expect(readLiteConsent({ ...CONSENT, scopes: scopes(1, () => 's'.repeat(257)) })).toBeNull();
	});

	it("draws an item's texts in full, or not the consent at all", () => {
		const long = 'x'.repeat(4001);
		for (const key of ['description', 'processing_purpose', 'withdrawal_impact']) {
			expect(
				readLiteConsent({
					...CONSENT,
					consent_items: [{ ...CONSENT.consent_items[0], [key]: long }]
				})
			).toBeNull();
		}
	});

	it('draws the organizations and document links in full, or not the consent', () => {
		const orgs = Array.from({ length: 26 }, (_, i) => ({
			id: `org-${i}`,
			name: `Org ${i}`,
			type: 'company',
			is_primary: false
		}));
		expect(
			readLiteConsent({ ...CONSENT, organizations: orgs, target_org_id: 'org-25' })
		).toBeNull();
		expect(
			readLiteConsent({ ...CONSENT, organizations: orgs.slice(0, 2), target_org_id: 'org-9' })
		).toBeNull();
		expect(
			readLiteConsent({
				...CONSENT,
				consent_items: [
					{ ...CONSENT.consent_items[0], document_url: `https://d.example/${'a'.repeat(2049)}` }
				]
			})
		).toBeNull();
		expect(
			readLiteConsent({
				...CONSENT,
				consent_items: [{ ...CONSENT.consent_items[0], document_url: 'http://d.example/terms' }]
			})
		).toBeNull();
	});

	it('names the organization an Allow is for, chosen or not', () => {
		const fixed = readLiteConsent({
			...CONSENT,
			features: { ...CONSENT.features, org_selector_enabled: false }
		});
		expect(fixed?.organizations).toEqual([]);
		expect(fixed?.targetOrg).toEqual({ id: 'org-1', name: 'One' });
	});

	it('refuses an answer it cannot draw', () => {
		expect(readLiteConsent({ ...CONSENT, user: {} })).toBeNull();
		expect(readLiteConsent({ ...CONSENT, consent_items: [{ statement_id: 'x' }] })).toBeNull();
	});
});

describe('liteConsentAllow', () => {
	const view = liteConsentShown(readLiteConsent(CONSENT)!, 'op-1');

	it('refuses an Allow without a required item the person must accept', () => {
		expect(liteConsentAllow(view, new Map())).toEqual({ ok: false, reason: 'blocked' });
	});

	it('builds the SPA submission from the answer, taking only the choices from the form', () => {
		const allowed = liteConsentAllow(
			view,
			new Map([
				['item:tos', 'granted'],
				['org', 'org-2'],
				['item:unknown', 'granted']
			])
		);
		expect(allowed).toEqual({
			ok: true,
			body: {
				challenge_id: 'cc-1',
				approved: true,
				selected_org_id: 'org-2',
				consent_item_versions: {
					tos: { version_id: 'v1', content_hash: 'h1' },
					news: { version_id: 'v2', content_hash: null }
				},
				consent_item_decisions: { tos: 'granted', news: 'denied' }
			}
		});
		// An organization not offered is not taken: the default one is.
		const other = liteConsentAllow(
			view,
			new Map([
				['item:tos', 'granted'],
				['org', 'org-evil']
			])
		);
		expect(other.ok && other.body.selected_org_id).toBe('org-1');
	});
});

describe('the lite consent page', () => {
	it('draws the consent for its challenge, in a transaction of its own', async () => {
		const page = await view();
		expect(page).toMatchObject({
			page: 'consent',
			txnId: 'txn-1',
			csrfToken: 'csrf-1',
			consent: {
				clientName: 'Example App',
				scopes: ['Verify your identity', 'View your email address']
			}
		});
		expect(store.binding.create).toHaveBeenCalledWith(
			expect.objectContaining({ purpose: 'login', challengeId: 'cc-1' })
		);
	});

	it('allows once: posts the decision, passes its cookie on, relays to the continuation', async () => {
		await view();
		const { ev, answer } = post('allow', { 'item:tos': 'granted' });
		await expect(answer).resolves.toEqual({ decided: true });
		expect(consentPosts()).toHaveLength(1);
		expect(consentPosts()[0].headers.get('X-Authrim-Relay')).toBe('structured');
		expect(consentPosts()[0].headers.get('Origin')).toBe('https://id.example');
		expect((ev.locals as { liteRelay?: { url: string } }).liteRelay?.url).toBe(
			'https://id.example/authorize?_consent_confirmation_challenge=x'
		);
		expect(ev.cookies.set).toHaveBeenCalledWith(
			'authrim_consent_confirmation',
			'b1',
			expect.objectContaining({ path: '/authorize' })
		);
		expect(store.txn.state).toBe('completed');
		// The same form posted again (its answer lost) relays to the same place with the same
		// cookie, sending nothing; another form finds the consent decided.
		const again = post('allow', { 'item:tos': 'granted' });
		await expect(again.answer).resolves.toEqual({ decided: true });
		expect(consentPosts()).toHaveLength(1);
		expect(again.ev.cookies.set).toHaveBeenCalledWith(
			'authrim_consent_confirmation',
			'b1',
			expect.objectContaining({ path: '/authorize' })
		);
		await expect(
			post('allow', { 'item:tos': 'granted', op: 'p'.repeat(22) }).answer
		).resolves.toMatchObject({ status: 410 });
	});

	it('draws a scope named like an object property as its name', async () => {
		routes['/auth/consent'] = () => json({ ...CONSENT, scopes: [{ name: 'constructor' }] });
		const page = await view();
		expect((page.consent as { scopes: unknown[] }).scopes).toEqual(['constructor']);
	});

	it('does not send again from an attempt after a lapsed one (its outcome may be lost)', async () => {
		await view();
		store.operations.set(`consent:${OP}`, { status: 'running', attempt: 1, startedAt: 0 });
		await expect(post('allow', { 'item:tos': 'granted' }).answer).resolves.toMatchObject({
			status: 410
		});
		expect(consentPosts()).toHaveLength(0);
	});

	it('lets only the form a view drew decide (another tab drew the page again since)', async () => {
		await view();
		const first = OP;
		await view();
		await expect(post('allow', { 'item:tos': 'granted', op: first }).answer).resolves.toMatchObject(
			{ status: 409, data: { error: 'expired' } }
		);
		expect(consentPosts()).toHaveLength(0);
	});

	it('records the decision over a view another tab made while it was sent', async () => {
		await view();
		const decision = routes['/auth/consent'];
		routes['/auth/consent'] = (body, init) => {
			if (init.method === 'POST') store.set({ version: store.txn.version + 1 });
			return decision(body, init);
		};
		await expect(post('allow', { 'item:tos': 'granted' }).answer).resolves.toEqual({
			decided: true
		});
		expect(store.txn.state).toBe('completed');
		expect(store.txn.data.consentDone).toMatchObject({ op: OP });
		// Its answer lost, the same form relays again.
		await expect(post('allow', { 'item:tos': 'granted' }).answer).resolves.toEqual({
			decided: true
		});
		expect(consentPosts()).toHaveLength(1);
	});

	it('sends the versions the page showed, not a document updated since', async () => {
		await view();
		routes['/auth/consent'] = (_body, init) =>
			init.method === 'POST'
				? json({ redirect_url: 'https://id.example/authorize?x=1' })
				: json({
						...CONSENT,
						consent_items: [
							{ ...CONSENT.consent_items[0], version_id: 'v9' },
							CONSENT.consent_items[1]
						]
					});
		await post('allow', { 'item:tos': 'granted' }).answer;
		expect(consentPosts()[0].body).toMatchObject({
			consent_item_versions: { tos: { version_id: 'v1', content_hash: 'h1' } }
		});
	});

	it('sends nothing for an Allow without the required item', async () => {
		await view();
		await expect(post('allow').answer).resolves.toMatchObject({
			status: 400,
			data: { error: 'blocked' }
		});
		expect(consentPosts()).toHaveLength(0);
	});

	it('relays a denial with response_mode=form_post as a POST, its CSP allowing only that origin', async () => {
		await view();
		routes['/auth/consent'] = (_body, init) =>
			init.method === 'POST'
				? json({
						form_post: {
							action: 'https://rp.example/cb',
							fields: [
								['error', 'access_denied'],
								['state', 's']
							]
						}
					})
				: json(CONSENT);
		const { ev, answer } = post('deny');
		await expect(answer).resolves.toEqual({ decided: true });
		expect(consentPosts()[0].body).toEqual({ challenge_id: 'cc-1', approved: false });
		const locals = ev.locals as {
			liteRelayPost?: { action: string; fields: unknown };
			liteCsp?: { formAction?: string; scriptHashes?: string[] };
		};
		expect(locals.liteRelayPost).toMatchObject({
			action: 'https://rp.example/cb',
			fields: [
				['error', 'access_denied'],
				['state', 's']
			]
		});
		expect(locals.liteCsp?.formAction).toBe('https://rp.example');
		expect(locals.liteCsp?.scriptHashes).toHaveLength(1);
	});

	it('sends one form at a time: another form neither sends beside it nor undoes it', async () => {
		await view();
		const first = OP;
		const decision = routes['/auth/consent'];
		let posts = 0;
		routes['/auth/consent'] = (body, init) => {
			if (init.method !== 'POST') return decision(body, init);
			posts += 1;
			return decision(body, init);
		};
		// The first form's mark is on the transaction while it sends.
		store.set({ data: { ...store.txn.data, consentSending: first } });
		await view();
		await expect(post('allow', { 'item:tos': 'granted' }).answer).resolves.toMatchObject({
			status: 409,
			data: { error: 'retry' }
		});
		expect(posts).toBe(0);
		expect(store.txn.state).toBe('pending');
		expect(store.txn.data.consentSending).toBe(first);
	});

	it('gives up the transaction of a challenge it drew once the challenge expired', async () => {
		await view();
		routes['/auth/consent'] = () => json({ error: 'invalid_request' }, 400);
		await expect(view()).resolves.toMatchObject({ page: 'error' });
		expect(store.txn.state).toBe('abandoned');
	});

	it("leaves an expired challenge's transaction alone while a decision of it is sent", async () => {
		await view();
		store.set({ data: { ...store.txn.data, consentSending: 'other-form' } });
		routes['/auth/consent'] = () => json({ error: 'invalid_request' }, 400);
		await view();
		expect(store.txn.state).toBe('pending');
	});

	it('sends nothing for a form another view replaced between its check and its mark', async () => {
		await view();
		const first = OP;
		// The mark's first try meets a view another tab drew meanwhile (its own form).
		const transition = store.binding.transition.getMockImplementation()!;
		store.binding.transition.mockImplementationOnce(async (call: Record<string, unknown>) => {
			store.set({
				data: {
					...store.txn.data,
					consent: { ...(store.txn.data.consent as object), op: 'other' }
				},
				version: store.txn.version + 1
			});
			return transition(call);
		});
		await expect(post('allow', { 'item:tos': 'granted', op: first }).answer).resolves.toMatchObject(
			{ status: 409 }
		);
		expect(consentPosts()).toHaveLength(0);
	});

	it('takes its mark off after a failure, also when a view moved the transaction meanwhile', async () => {
		await view();
		const decision = routes['/auth/consent'];
		routes['/auth/consent'] = (body, init) => {
			if (init.method !== 'POST') return decision(body, init);
			return json({ error: 'temporarily_unavailable' }, 503);
		};
		const transition = store.binding.transition.getMockImplementation()!;
		let calls = 0;
		store.binding.transition.mockImplementation(async (call: Record<string, unknown>) => {
			calls += 1;
			// The mark goes on (1); a view moves the version just before it comes off (2).
			if (calls === 2) store.set({ version: store.txn.version + 1 });
			return transition(call);
		});
		await expect(post('allow', { 'item:tos': 'granted' }).answer).resolves.toMatchObject({
			status: 503
		});
		expect(store.txn.data.consentSending).toBeUndefined();
	});

	it('gives the transaction up after changed documents, also when a view moved it meanwhile', async () => {
		await view();
		routes['/auth/consent'] = (_body, init) =>
			init.method === 'POST'
				? json({ error: 'document_changed', error_details: { consent_challenge_id: 'cc-2' } }, 409)
				: json(CONSENT);
		const transition = store.binding.transition.getMockImplementation()!;
		let calls = 0;
		store.binding.transition.mockImplementation(async (call: Record<string, unknown>) => {
			calls += 1;
			// The mark goes on (1); a view moves the version just before the transaction is given up (2).
			if (calls === 2) store.set({ version: store.txn.version + 1 });
			return transition(call);
		});
		await expect(post('allow', { 'item:tos': 'granted' }).answer).rejects.toMatchObject({
			status: 303
		});
		expect(store.txn.state).toBe('abandoned');
	});

	it('makes no transaction for a challenge ar-auth does not know (nothing to give up)', async () => {
		routes['/auth/consent'] = () => json({ error: 'invalid_request' }, 500);
		await expect(view()).resolves.toMatchObject({ page: 'error' });
		expect(store.binding.create).not.toHaveBeenCalled();
	});

	it("gives the old challenge's transaction up when documents changed under a new one", async () => {
		await view();
		routes['/auth/consent'] = (_body, init) =>
			init.method === 'POST'
				? json({ error: 'document_changed', error_details: { consent_challenge_id: 'cc-2' } }, 409)
				: json(CONSENT);
		await expect(post('allow', { 'item:tos': 'granted' }).answer).rejects.toMatchObject({
			status: 303
		});
		expect(store.txn.state).toBe('abandoned');
	});

	it('draws the page again for changed documents (a new challenge)', async () => {
		await view();
		routes['/auth/consent'] = (_body, init) =>
			init.method === 'POST'
				? json({ error: 'document_changed', error_details: { consent_challenge_id: 'cc-2' } }, 409)
				: json(CONSENT);
		await expect(post('allow', { 'item:tos': 'granted' }).answer).rejects.toMatchObject({
			status: 303,
			location: '/consent?challenge_id=cc-2'
		});
	});

	it('refuses a post for another challenge than its transaction is for', async () => {
		await view();
		const ev = event({
			action: 'allow',
			form: { txn: 'txn-1', csrf: 'csrf-1', op: OP, 'item:tos': 'granted' },
			query: 'challenge_id=cc-other'
		});
		await expect(
			(actions as Record<string, (e: RequestEvent) => Promise<unknown>>).allow(ev)
		).resolves.toMatchObject({ status: 409 });
		expect(consentPosts()).toHaveLength(0);
	});

	it('refuses a post with another token', async () => {
		await view();
		await expect(
			post('allow', { csrf: 'csrf-x', 'item:tos': 'granted' }).answer
		).resolves.toMatchObject({
			status: 403
		});
		expect(consentPosts()).toHaveLength(0);
	});
});
