/**
 * The lite sign-in page's social sign-in (PR5b): `social_start` (the start grant, the Flow choice,
 * the relay to ar-bridge's start) and the lite `/callback` (the handoff finalized for this
 * browser's transaction, provisioning, errors). The transaction store is the in-memory model of
 * LiteTxnStore the sign-in tests use.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { actions, load } from '../../../../routes/__lite/login/+page.server';
import { load as callbackLoad } from '../../../../routes/__lite/callback/+page.server';

type Handler = (body: Record<string, unknown>, init: RequestInit) => Response;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers }
	});

const SELECT_STEP = {
	id: 'select',
	source_node_id: 'n-select',
	component: 'authentication_method_selector',
	render: true,
	config: {
		screen: {
			display_name: 'Sign in',
			fields: [
				{ field: 'email', label: 'Email', required: true },
				{ block_type: 'auth_widget', field: 'm', label: 'Send', auth_method: 'mail_otp' },
				{ block_type: 'guest_login_widget', field: 'g', label: 'Guest' }
			]
		}
	}
};
const CODE_STEP = {
	id: 'code',
	source_node_id: 'n-code',
	component: 'email_verification',
	render: true,
	config: {
		screen: {
			display_name: 'Enter the code',
			fields: [{ block_type: 'code_input_widget', field: 'code', label: 'Code' }]
		}
	}
};
const COMPLETION = { id: 'done', source_node_id: 'n-done', component: 'completion', render: true };

let calls: Array<{ path: string; body: Record<string, unknown>; headers: Headers }>;
let routes: Record<string, Handler>;
let currentStep: Record<string, unknown>;
let store: ReturnType<typeof fakeStore>;
let tenantMethods: Record<string, unknown>;
/** Whether the contract has a step of its own for the code (CODE_STEP). */
let withCodeStep: boolean;
/** Cookies the browser sends besides the lite binding (a session made by an earlier post). */
let browserCookies: Record<string, string>;

function startAnswer() {
	return {
		interaction: { id: 'int-1', state: 'active', current_step_id: currentStep.id },
		contract: {
			ui: {
				steps: [
					...new Set([SELECT_STEP, ...(withCodeStep ? [CODE_STEP] : []), COMPLETION, currentStep])
				]
			}
		},
		contract_hash: 'hash-1',
		signature: 'sig-1'
	};
}

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

function event(
	init: { action?: string; form?: Record<string, string>; query?: string; page?: string } = {}
) {
	const search = init.query ?? '';
	const page = init.page ?? '/login';
	const path = init.action
		? `${page}?${search}${search ? '&' : ''}/${init.action}`
		: `${page}${search ? `?${search}` : ''}`;
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

const OP = 'o'.repeat(22);
const post = (action: string, form: Record<string, string> = {}, query?: string) =>
	(actions as Record<string, (e: RequestEvent) => Promise<unknown>>)[action](
		event({ action, form: { txn: 'txn-1', csrf: 'csrf-1', op: OP, ...form }, query })
	);
const view = (query?: string) =>
	(load as unknown as (e: RequestEvent) => Promise<Record<string, unknown>>)(event({ query }));
const paths = () => calls.map((call) => call.path);
const submits = () =>
	calls.filter((call) => call.path.endsWith('/submit')).map((call) => call.body.selected_handle);

beforeEach(() => {
	calls = [];
	currentStep = SELECT_STEP;
	store = fakeStore();
	tenantMethods = { emailCode: { enabled: true }, guest: { enabled: true } };
	withCodeStep = true;
	browserCookies = {};
	routes = {
		'/api/v1/login/interactions/start': () => json(startAnswer()),
		'/api/auth/human-verification/pow-challenge': () =>
			json({
				challenge: {
					algorithm: 'SHA-256',
					challenge: 'a'.repeat(64),
					maxnumber: 100,
					salt: 's',
					signature: 'g'
				},
				policy_revision: 'rev-1'
			}),
		'/api/v1/auth/direct/email-code/send': () =>
			json({ attempt_id: 'attempt-1', expires_in: 300, masked_email: 'p***n@example.com' }),
		'/api/v1/auth/direct/email-code/verify': () =>
			json({ direct_auth_artifact: 'artifact-1', expires_in: 60, is_new_user: false }),
		'/api/v1/auth/direct/session': () =>
			json({ ok: true }, 200, {
				'Set-Cookie': 'authrim_session=s1; Path=/; HttpOnly; Secure; SameSite=Lax'
			}),
		'/api/auth/guest/login': () =>
			json({ success: true }, 200, {
				'Set-Cookie': 'authrim_session=g1; Path=/; HttpOnly; Secure; SameSite=Lax'
			}),
		'/api/v1/login/interactions/int-1/submit': (body) => {
			if (body.selected_handle === 'mail_otp') {
				currentStep = CODE_STEP;
				return json({
					completed: false,
					step: CODE_STEP,
					interaction: { current_step_id: 'code' }
				});
			}
			if (body.selected_handle === 'verified' || body.selected_handle === 'guest') {
				currentStep = COMPLETION;
				return json({
					completed: false,
					step: COMPLETION,
					interaction: { current_step_id: 'done' }
				});
			}
			if (body.selected_handle === 'completed') {
				return json({ completed: true, output: { redirect_url: 'https://id.example/after' } });
			}
			return json({ error: 'invalid_handle' }, 400);
		}
	};
});

const SOCIAL_STEP = {
	id: 'social',
	source_node_id: 'n-social',
	component: 'authentication_method_selector',
	render: true,
	config: {
		screen: {
			display_name: 'Sign in',
			fields: [
				{ block_type: 'auth_widget', field: 's', label: 'Social', auth_method: 'external_idp' }
			]
		}
	}
};
/** As the authentication methods answer gives it (its `id` is the slug, when there is one). */
const GOOGLE = {
	id: 'provider-google',
	name: 'Google',
	startMode: 'oauth_redirect',
	enabled: true
};
const HANDOFF = '0123abcd-0123-4abc-8def-0123456789ab';

const callbackView = (query: string) =>
	(callbackLoad as unknown as (e: RequestEvent) => Promise<Record<string, unknown>>)(
		event({ page: '/callback', query })
	);
const grantCalls = () => store.binding.issueStartGrant.mock.calls.map((call) => call[0]);

function socialSetup() {
	currentStep = SOCIAL_STEP;
	tenantMethods = { external: { enabled: true, providers: [GOOGLE] } };
	store.binding.issueStartGrant.mockResolvedValue({ ok: true, grantId: 'grant-1' });
	routes['/api/v1/login/interactions/int-1/submit'] = (body) => {
		if (body.selected_handle === 'provider-google') {
			currentStep = COMPLETION;
			return json({ completed: false, step: COMPLETION, interaction: { current_step_id: 'done' } });
		}
		if (body.selected_handle === 'completed') {
			return json({ completed: true, output: { redirect_url: 'https://id.example/after' } });
		}
		return json({ error: 'invalid_handle' }, 400);
	};
	routes['/handoff/finalize'] = () =>
		json({ ok: true, redirect_url: 'https://id.example/home' }, 200, {
			'Set-Cookie': 'authrim_session=x1; Path=/; HttpOnly; Secure; SameSite=Lax'
		});
}

async function started() {
	const answer = await post(
		'social_start',
		{ provider: 'provider-google', human_verification_response: 'proof-1' },
		'flow=1'
	);
	return answer;
}

describe('the social sign-in page', () => {
	beforeEach(socialSetup);

	it('draws a button per provider of the part, with the proof of work', async () => {
		const page = await view();
		expect(page.decision).toMatchObject({ kind: 'screen' });
		expect(page.providers).toEqual([{ id: 'provider-google', label: 'Continue with Google' }]);
		expect(page.pow).not.toBeNull();
	});

	it('draws a SAML IdP as a button too', async () => {
		tenantMethods = {
			external: {
				enabled: true,
				providers: [GOOGLE, { id: 'saml:idp-1', name: 'Corp', startMode: 'saml_sp', enabled: true }]
			}
		};
		const page = await view();
		expect(page.decision).toMatchObject({ kind: 'screen' });
		expect(page.providers).toEqual([
			{ id: 'provider-google', label: 'Continue with Google' },
			{ id: 'saml:idp-1', label: 'Continue with Corp' }
		]);
	});
});

describe('social_start', () => {
	beforeEach(socialSetup);

	it('gets a grant with the proof first, submits the choice, and relays to the Bridge start', async () => {
		const ev = event({
			action: 'social_start',
			form: {
				txn: 'txn-1',
				csrf: 'csrf-1',
				op: OP,
				provider: 'provider-google',
				human_verification_response: 'proof-1'
			},
			query: 'flow=1'
		});
		await expect(
			(actions as Record<string, (e: RequestEvent) => Promise<unknown>>).social_start(ev)
		).resolves.toEqual({ started: true });
		expect(grantCalls()).toEqual([
			expect.objectContaining({
				txnId: 'txn-1',
				provider: 'provider-google',
				humanVerificationResponse: 'proof-1',
				clientId: 'login-ui',
				interactionId: 'int-1'
			})
		]);
		expect(submits()).toEqual(['provider-google']);
		expect(store.binding.issueStartGrant.mock.invocationCallOrder[0]).toBeLessThan(
			store.binding.completeOperation.mock.invocationCallOrder[0]
		);
		expect(store.txn.data.social).toMatchObject({
			interactionId: 'int-1',
			choiceStepId: 'social',
			provider: 'provider-google',
			grantId: 'grant-1',
			handoff: null,
			search: '?flow=1'
		});
		expect(store.txn.state).toBe('pending');
		const relay = (ev.locals as { liteRelay?: { url: string } }).liteRelay;
		expect(relay?.url).toBe(
			'https://id.example/api/external/provider-google/start?lite_txn=txn-1&lite_grant=grant-1'
		);
	});

	it('relays to the start all the same when another submit of the step took it', async () => {
		routes['/api/v1/login/interactions/int-1/submit'] = () =>
			json({ error: 'step_conflict', error_code: 'AR_FLOW_STEP_CONFLICT' }, 409);
		const ev = event({
			action: 'social_start',
			form: {
				txn: 'txn-1',
				csrf: 'csrf-1',
				op: OP,
				provider: 'provider-google',
				human_verification_response: 'proof-1'
			},
			query: 'flow=1'
		});
		await expect(
			(actions as Record<string, (e: RequestEvent) => Promise<unknown>>).social_start(ev)
		).resolves.toEqual({ started: true });
		expect((ev.locals as { liteRelay?: { url: string } }).liteRelay?.url).toBe(
			'https://id.example/api/external/provider-google/start?lite_txn=txn-1&lite_grant=grant-1'
		);
	});

	it('leaves the Flow where it was when the proof does not verify', async () => {
		store.binding.issueStartGrant.mockResolvedValue({
			ok: false,
			reason: 'human_verification_failed'
		});
		await expect(started()).resolves.toMatchObject({ status: 400, data: { error: 'retry' } });
		expect(submits()).toEqual([]);
		expect(store.txn.data.social).toBeUndefined();
	});

	it("starts a SAML IdP at ar-saml's SP start, its grant naming the IdP", async () => {
		tenantMethods = {
			external: {
				enabled: true,
				providers: [{ id: 'saml:idp-1', name: 'Corp', startMode: 'saml_sp', enabled: true }]
			}
		};
		routes['/api/v1/login/interactions/int-1/submit'] = () =>
			json({ completed: false, step: COMPLETION, interaction: { current_step_id: 'done' } });
		const ev = event({
			action: 'social_start',
			form: {
				txn: 'txn-1',
				csrf: 'csrf-1',
				op: OP,
				provider: 'saml:idp-1',
				human_verification_response: 'proof-1'
			}
		});
		await expect(
			(actions as Record<string, (e: RequestEvent) => Promise<unknown>>).social_start(ev)
		).resolves.toEqual({ started: true });
		expect(grantCalls()[0]).toMatchObject({ provider: 'saml:idp-1' });
		expect((ev.locals as { liteRelay?: { url: string } }).liteRelay?.url).toBe(
			'https://id.example/saml/sp/login?idp=idp-1&lite_txn=txn-1&lite_grant=grant-1'
		);
	});

	it('refuses a provider the part does not offer, asking for no grant', async () => {
		await expect(
			post('social_start', { provider: 'provider-other', human_verification_response: 'p' })
		).resolves.toMatchObject({ status: 409, data: { restart: true } });
		expect(grantCalls()).toEqual([]);
	});

	it('starts nothing over a code already sent', async () => {
		store.set({
			data: {
				...store.txn.data,
				code: {
					interactionId: 'int-1',
					choiceStepId: 'select',
					email: 'p@example.com',
					attemptId: 'a',
					verifier: 'v',
					sentAt: Date.now()
				}
			}
		});
		await expect(started()).rejects.toMatchObject({ status: 303 });
		expect(grantCalls()).toEqual([]);
	});

	it('sends the same form posted again to the start of the grant it got, asking for no other', async () => {
		await started();
		await expect(started()).resolves.toEqual({ started: true });
		expect(grantCalls()).toHaveLength(1);
		expect(submits()).toEqual(['provider-google']);
	});

	it('sends the same form posted again to its grant once the Flow went on to a step with consent', async () => {
		const CONSENT_NEXT = {
			id: 'consent',
			source_node_id: 'n-consent',
			component: 'consent_policy',
			render: true,
			config: {
				screen: {
					display_name: 'Consent',
					fields: [{ block_type: 'consent_widget', field: 'c', label: 'Consent' }]
				}
			},
			content: {
				consent_policy: {
					id: 'policy-1',
					items: [
						{
							statement_id: 'tos',
							title: 'Terms',
							version: '1',
							is_required: true,
							content_mode: 'checkbox',
							checkbox_mode: 'required'
						}
					]
				}
			}
		};
		routes['/api/v1/login/interactions/int-1/submit'] = (body) => {
			if (body.selected_handle !== 'provider-google') return json({ error: 'invalid_handle' }, 400);
			currentStep = CONSENT_NEXT;
			return json({
				completed: false,
				step: CONSENT_NEXT,
				interaction: { current_step_id: 'consent' }
			});
		};
		await started();
		// The relay did not get through: the same form, now over the step asking for consent.
		await expect(started()).resolves.toEqual({ started: true });
		expect(grantCalls()).toHaveLength(1);
	});

	it('never replaces a start another tab made meanwhile', async () => {
		const other = {
			interactionId: 'int-1',
			choiceStepId: 'social',
			provider: 'provider-google',
			grantId: 'grant-other',
			handoff: null,
			search: '',
			startedAt: Date.now()
		};
		store.binding.issueStartGrant.mockImplementation(async () => {
			// Another tab's start is saved while this one asks for its grant.
			store.set({ data: { ...store.txn.data, social: other }, version: store.txn.version + 1 });
			return { ok: true, grantId: 'grant-1' };
		});
		await expect(started()).resolves.toMatchObject({ status: 409, data: { error: 'retry' } });
		expect(store.txn.data.social).toEqual(other);
		expect(submits()).toEqual([]);
	});

	it('starts no other provider over a start made from another form (another tab)', async () => {
		await started();
		await expect(
			post(
				'social_start',
				{ provider: 'provider-google', human_verification_response: 'proof-2', op: 'p'.repeat(22) },
				'flow=1'
			)
		).rejects.toMatchObject({ status: 303 });
		expect(grantCalls()).toHaveLength(1);
		expect(store.txn.data.social).toMatchObject({ grantId: 'grant-1' });
	});

	it('never replaces the start of a Flow another tab began meanwhile', async () => {
		const newer = {
			interactionId: 'int-2',
			choiceStepId: 'social',
			provider: 'provider-google',
			grantId: 'grant-2',
			handoff: null,
			search: '',
			startedAt: Date.now()
		};
		store.binding.issueStartGrant.mockImplementation(async () => {
			store.set({
				data: {
					...store.txn.data,
					flow: { interactionId: 'int-2', contractHash: 'hash-2', signature: 'sig-2' },
					social: newer
				},
				version: store.txn.version + 1
			});
			return { ok: true, grantId: 'grant-1' };
		});
		await expect(started()).resolves.toMatchObject({ status: 409, data: { error: 'retry' } });
		expect(store.txn.data.social).toEqual(newer);
	});

	it('does not follow, on a resend, a start that lost to another tab', async () => {
		const other = {
			interactionId: 'int-1',
			choiceStepId: 'social',
			provider: 'provider-google',
			grantId: 'grant-other',
			handoff: null,
			search: '',
			startedAt: Date.now()
		};
		store.binding.issueStartGrant.mockImplementation(async () => {
			store.set({ data: { ...store.txn.data, social: other }, version: store.txn.version + 1 });
			return { ok: true, grantId: 'grant-1' };
		});
		await started();
		await expect(started()).rejects.toMatchObject({ status: 303 });
	});

	it('makes no start whose page query is too long to go back to', async () => {
		await expect(
			post(
				'social_start',
				{ provider: 'provider-google', human_verification_response: 'p' },
				`return_to=${'a'.repeat(2100)}`
			)
		).resolves.toMatchObject({ status: 409, data: { restart: true } });
		expect(grantCalls()).toEqual([]);
	});

	it('draws a Start again over a start not finished, rather than the buttons', async () => {
		await started();
		currentStep = SOCIAL_STEP;
		const page = await view('flow=1');
		expect(page.decision).toEqual({ kind: 'unsupported', reasons: ['social_started'] });
		expect(page.socialStarted).toBe(true);
	});

	it('relays to the completion when the choice finds the session already accepted', async () => {
		routes['/api/v1/login/interactions/int-1/submit'] = () =>
			json({ completed: true, output: { redirect_url: 'https://id.example/after' } });
		await expect(started()).resolves.toEqual({ completed: true });
		expect(store.txn.state).toBe('completed');
	});
});

describe('the lite callback', () => {
	beforeEach(socialSetup);

	it('finalizes the handoff for the UI client, records the sign-in, then passes the session on', async () => {
		await started();
		const ev = event({
			page: '/callback',
			query: `lite_txn=txn-1&lite_grant=grant-1&handoff_token=${HANDOFF}&state=st-1`
		});
		await expect(
			(callbackLoad as unknown as (e: RequestEvent) => Promise<unknown>)(ev)
		).rejects.toMatchObject({ status: 303, location: '/login?flow=1' });
		const finalize = calls.find((call) => call.path === '/handoff/finalize');
		expect(finalize?.body).toEqual({
			handoff_token: HANDOFF,
			state: 'st-1',
			client_id: 'login-ui'
		});
		expect(finalize?.headers.get('Origin')).toBe('https://id.example');
		// The start stays until the sign-in page's Continue takes the sign-in on.
		expect(store.txn.data.social).toMatchObject({ provider: 'provider-google' });
		expect(store.txn.data.signedIn).toMatchObject({
			interactionId: 'int-1',
			method: 'social',
			choice: { stepId: 'social', handle: 'provider-google' },
			redirectUrl: 'https://id.example/home'
		});
		expect(store.txn.state).toBe('verified');
		expect(ev.cookies.set).toHaveBeenCalledWith(
			'authrim_session',
			'x1',
			expect.objectContaining({ path: '/' })
		);
	});

	it('finalizes an ar-saml handoff too (32 bytes in hex)', async () => {
		await started();
		const samlHandoff = 'ab'.repeat(32);
		await expect(
			callbackView(`lite_txn=txn-1&lite_grant=grant-1&handoff_token=${samlHandoff}&state=st-1`)
		).rejects.toMatchObject({ status: 303 });
		expect(calls.find((call) => call.path === '/handoff/finalize')?.body).toMatchObject({
			handoff_token: samlHandoff
		});
	});

	it("brings a sign-up's external sign-in back to the sign-up page", async () => {
		await started();
		// The transaction a sign-up page made (its start is the same).
		store.set({ bound: { ...store.txn.bound, purpose: 'signup' } });
		await expect(
			callbackView(`lite_txn=txn-1&lite_grant=grant-1&handoff_token=${HANDOFF}&state=st-1`)
		).rejects.toMatchObject({ status: 303, location: expect.stringMatching(/^\/signup/u) });
		const page = await callbackView('lite_txn=txn-1&lite_grant=grant-1&error=access_denied');
		expect(page).toMatchObject({ page: 'error', backHref: expect.stringMatching(/^\/signup/u) });
	});

	it('finalizes a handoff once: a reload reads how it went', async () => {
		await started();
		const q = `lite_txn=txn-1&lite_grant=grant-1&handoff_token=${HANDOFF}&state=st-1`;
		await expect(callbackView(q)).rejects.toMatchObject({ status: 303 });
		await expect(callbackView(q)).rejects.toMatchObject({ status: 303 });
		expect(calls.filter((call) => call.path === '/handoff/finalize')).toHaveLength(1);
	});

	it('records the sign-in after a concurrent change of the transaction, then passes the session on', async () => {
		await started();
		const finalize = routes['/handoff/finalize'];
		routes['/handoff/finalize'] = (body, init) => {
			store.set({ version: store.txn.version + 1 });
			return finalize(body, init);
		};
		const ev = event({
			page: '/callback',
			query: `lite_txn=txn-1&lite_grant=grant-1&handoff_token=${HANDOFF}&state=st-1`
		});
		await expect(
			(callbackLoad as unknown as (e: RequestEvent) => Promise<unknown>)(ev)
		).rejects.toMatchObject({ status: 303 });
		expect(store.txn.data.signedIn).toMatchObject({ method: 'social' });
		expect(ev.cookies.set).toHaveBeenCalledWith('authrim_session', 'x1', expect.anything());
	});

	it('passes no session on when another start replaced this one during the finalize', async () => {
		await started();
		const finalize = routes['/handoff/finalize'];
		routes['/handoff/finalize'] = (body, init) => {
			store.set({
				data: {
					...store.txn.data,
					social: { ...(store.txn.data.social as Record<string, unknown>), grantId: 'grant-2' }
				},
				version: store.txn.version + 1
			});
			return finalize(body, init);
		};
		const ev = event({
			page: '/callback',
			query: `lite_txn=txn-1&lite_grant=grant-1&handoff_token=${HANDOFF}&state=st-1`
		});
		const page = await (callbackLoad as unknown as (e: RequestEvent) => Promise<unknown>)(ev);
		expect(page).toMatchObject({ page: 'error', restart: null });
		expect(store.txn.data.signedIn).toBeUndefined();
		expect(ev.cookies.set).not.toHaveBeenCalledWith(
			'authrim_session',
			expect.anything(),
			expect.anything()
		);
	});

	it('still finishes a start older than ar-bridge keeps its state (an account being made)', async () => {
		await started();
		store.set({
			data: {
				...store.txn.data,
				social: {
					...(store.txn.data.social as Record<string, unknown>),
					startedAt: Date.now() - 11 * 60_000
				}
			}
		});
		await expect(
			callbackView(`lite_txn=txn-1&lite_grant=grant-1&handoff_token=${HANDOFF}&state=st-1`)
		).rejects.toMatchObject({ status: 303 });
	});

	it('undoes nothing for an error that comes after the start was finished', async () => {
		await started();
		await expect(
			callbackView(`lite_txn=txn-1&lite_grant=grant-1&handoff_token=${HANDOFF}&state=st-1`)
		).rejects.toMatchObject({ status: 303 });
		const page = await callbackView('lite_txn=txn-1&lite_grant=grant-1&error=access_denied');
		expect(page).toMatchObject({ page: 'error', restart: null });
		expect(store.txn.data.social).toMatchObject({ handoff: HANDOFF });
		expect(store.txn.data.signedIn).toMatchObject({ method: 'social' });
	});

	it('offers no Start again when the finalize failed and another post changed the transaction', async () => {
		await started();
		routes['/handoff/finalize'] = () => {
			store.set({ version: store.txn.version + 1 });
			return json({ error: 'invalid_state' }, 400);
		};
		const page = await callbackView(
			`lite_txn=txn-1&lite_grant=grant-1&handoff_token=${HANDOFF}&state=st-1`
		);
		expect(page).toMatchObject({ page: 'error', restart: null });
	});

	it('finalizes nothing for the start of a Flow the transaction has since replaced', async () => {
		await started();
		store.set({
			data: {
				...store.txn.data,
				flow: { interactionId: 'int-2', contractHash: 'hash-2', signature: 'sig-2' }
			}
		});
		const page = await callbackView(
			`lite_txn=txn-1&lite_grant=grant-1&handoff_token=${HANDOFF}&state=st-1`
		);
		expect(page).toMatchObject({ page: 'error', restart: null });
		expect(paths()).not.toContain('/handoff/finalize');
	});

	it('passes a guest session on only once its sign-in is recorded (not over a social one)', async () => {
		currentStep = SELECT_STEP;
		tenantMethods = { emailCode: { enabled: true }, guest: { enabled: true } };
		routes['/api/auth/guest/login'] = () => {
			// A social sign-in is recorded while the guest call is out.
			store.set({
				data: {
					...store.txn.data,
					signedIn: {
						interactionId: 'int-1',
						method: 'social',
						choice: { stepId: 'social', handle: 'provider-google' },
						redirectUrl: null
					}
				},
				version: store.txn.version + 1
			});
			return json({ success: true }, 200, {
				'Set-Cookie': 'authrim_session=g1; Path=/; HttpOnly; Secure; SameSite=Lax'
			});
		};
		const ev = event({
			action: 'guest',
			form: { txn: 'txn-1', csrf: 'csrf-1', op: OP, human_verification_response: 'p' }
		});
		await expect(
			(actions as Record<string, (e: RequestEvent) => Promise<unknown>>).guest(ev)
		).resolves.toMatchObject({ status: 409 });
		expect(ev.cookies.set).not.toHaveBeenCalledWith('authrim_session', 'g1', expect.anything());
		expect(store.txn.data.signedIn).toMatchObject({ method: 'social' });
	});

	it('finalizes nothing for the return of another start (another grant)', async () => {
		await started();
		const page = await callbackView(
			`lite_txn=txn-1&lite_grant=grant-other&handoff_token=${HANDOFF}&state=st-1`
		);
		expect(page).toMatchObject({ page: 'error' });
		expect(paths()).not.toContain('/handoff/finalize');
	});

	it('takes no second handoff for a start already finished with one', async () => {
		await started();
		await expect(
			callbackView(`lite_txn=txn-1&lite_grant=grant-1&handoff_token=${HANDOFF}&state=st-1`)
		).rejects.toMatchObject({ status: 303 });
		const other = '0123abcd-0123-4abc-8def-0123456789ff';
		const page = await callbackView(
			`lite_txn=txn-1&lite_grant=grant-1&handoff_token=${other}&state=st-2`
		);
		expect(page).toMatchObject({ page: 'error' });
		expect(calls.filter((call) => call.path === '/handoff/finalize')).toHaveLength(1);
		expect(store.txn.data.social).toMatchObject({ handoff: HANDOFF });
	});

	it('finalizes nothing for a transaction that started no social sign-in', async () => {
		const page = await callbackView(
			`lite_txn=txn-1&lite_grant=grant-1&handoff_token=${HANDOFF}&state=st-1`
		);
		expect(page).toMatchObject({ page: 'error', backHref: '/login' });
		expect(paths()).not.toContain('/handoff/finalize');
	});

	it('finalizes nothing for a transaction not this browser’s', async () => {
		await started();
		store.binding.get.mockResolvedValueOnce({ ok: false, reason: 'binding_mismatch' } as never);
		const page = await callbackView(
			`lite_txn=txn-1&lite_grant=grant-1&handoff_token=${HANDOFF}&state=st-1`
		);
		expect(page).toMatchObject({ page: 'error' });
		expect(paths()).not.toContain('/handoff/finalize');
	});

	it('records nothing and passes no session on when the finalize fails', async () => {
		await started();
		routes['/handoff/finalize'] = () => json({ error: 'invalid_state' }, 400);
		const ev = event({
			page: '/callback',
			query: `lite_txn=txn-1&lite_grant=grant-1&handoff_token=${HANDOFF}&state=st-1`
		});
		const page = await (callbackLoad as unknown as (e: RequestEvent) => Promise<unknown>)(ev);
		expect(page).toMatchObject({ page: 'error', backHref: '/login?flow=1' });
		expect(store.txn.data.signedIn).toBeUndefined();
		expect(store.txn.data.social).toBeUndefined();
		expect(ev.cookies.set).not.toHaveBeenCalledWith(
			'authrim_session',
			expect.anything(),
			expect.anything()
		);
	});

	it('clears the start on an error from the Bridge, saying what happened', async () => {
		await started();
		const page = await callbackView('lite_txn=txn-1&lite_grant=grant-1&error=access_denied');
		// Start again: the Flow went on to wait for this sign-in, a plain link back would find it.
		expect(page).toMatchObject({
			page: 'error',
			backHref: '/login?flow=1',
			restart: { action: '/login?flow=1&/restart', txnId: 'txn-1', csrfToken: 'csrf-1' }
		});
		expect(store.txn.data.social).toBeUndefined();
	});

	it('waits for an account still being made, then follows the resume of the same origin only', async () => {
		await started();
		routes['/api/external/provisioning/status'] = () =>
			json({ status: 'pending', retry_after_ms: 1500 }, 202);
		const q =
			'lite_txn=txn-1&lite_grant=grant-1&provisioning_token=tok&provisioning_tenant=default&state=st';
		await expect(callbackView(q)).resolves.toMatchObject({ page: 'wait', refreshSeconds: 3 });
		routes['/api/external/provisioning/status'] = () =>
			json({
				status: 'ready',
				resume_url: '/auth/external/provisioning/resume?token=tok&tenant=default'
			});
		await expect(callbackView(q)).resolves.toMatchObject({
			page: 'relay',
			relay: {
				method: 'get',
				url: 'https://id.example/auth/external/provisioning/resume?token=tok&tenant=default'
			}
		});
		routes['/api/external/provisioning/status'] = () =>
			json({
				status: 'ready',
				resume_url: 'https://evil.example/auth/external/provisioning/resume'
			});
		await expect(callbackView(q)).resolves.toMatchObject({ page: 'error' });
	});

	it('records no social sign-in over another sign-in made meanwhile', async () => {
		await started();
		store.set({
			data: {
				...store.txn.data,
				signedIn: {
					interactionId: 'int-1',
					method: 'guest',
					choice: { stepId: 'select', handle: 'guest' },
					redirectUrl: null
				}
			}
		});
		const page = await callbackView(
			`lite_txn=txn-1&lite_grant=grant-1&handoff_token=${HANDOFF}&state=st-1`
		);
		expect(page).toMatchObject({ page: 'error' });
		expect(paths()).not.toContain('/handoff/finalize');
	});

	it('goes on with the Flow from the sign-in page’s Continue (the choice already submitted)', async () => {
		await started();
		await expect(
			callbackView(`lite_txn=txn-1&lite_grant=grant-1&handoff_token=${HANDOFF}&state=st-1`)
		).rejects.toMatchObject({ status: 303 });
		browserCookies = { authrim_session: 'x1' };
		const page = await view('flow=1');
		expect(page.decision).toEqual({ kind: 'continue' });
		await expect(post('continue', {}, 'flow=1')).resolves.toEqual({ completed: true });
		// The choice went before the provider; Continue submits the completion only.
		expect(submits()).toEqual(['provider-google', 'completed']);
		expect(store.txn.data.social).toBeUndefined();
		expect(store.txn.state).toBe('completed');
	});
});
