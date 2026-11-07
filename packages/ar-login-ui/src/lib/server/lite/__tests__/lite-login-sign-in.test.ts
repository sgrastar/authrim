/**
 * The lite sign-in page's email code and guest sign-in (PR4b), authenticator app and passkey
 * (PR5a): the posts, their retries and double submits, and what the page view draws after each. The transaction store is a small
 * in-memory model of LiteTxnStore (versions, the operation lease, the recorded results).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { actions, load } from '../../../../routes/__lite/login/+page.server';

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

function event(init: { action?: string; form?: Record<string, string>; query?: string } = {}) {
	const search = init.query ?? '';
	const path = init.action
		? `/login?${search}${search ? '&' : ''}/${init.action}`
		: `/login${search ? `?${search}` : ''}`;
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

async function sha256Base64Url(value: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
	);
	return btoa(String.fromCharCode(...digest))
		.replace(/\+/gu, '-')
		.replace(/\//gu, '_')
		.replace(/=+$/u, '');
}

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

describe('send_code', () => {
	it('sends a code for the sign-in screen, keeps its PKCE verifier, and submits the choice', async () => {
		await expect(
			post(
				'send_code',
				{ email: 'person@example.com', human_verification_response: 'proof-1' },
				'challenge_x=1'
			)
		).rejects.toMatchObject({ status: 303, location: '/login?challenge_x=1' });

		const send = calls.find((call) => call.path === '/api/v1/auth/direct/email-code/send');
		expect(send?.headers.get('X-Authrim-Human-Verification-Action')).toBe('login');
		expect(send?.body).toMatchObject({
			client_id: 'login-ui',
			email: 'person@example.com',
			code_challenge_method: 'S256',
			channel: 'browser',
			human_verification_response: 'proof-1',
			runtime_interaction_id: 'int-1'
		});
		const code = store.txn.data.code as Record<string, unknown>;
		expect(code).toMatchObject({
			interactionId: 'int-1',
			choiceStepId: 'select',
			email: 'person@example.com',
			attemptId: 'attempt-1',
			maskedEmail: 'p***n@example.com'
		});
		expect(send?.body.code_challenge).toBe(await sha256Base64Url(String(code.verifier)));
		expect(submits()).toEqual(['mail_otp']);
		// The Flow waits for the code: its completion is not submitted.
		expect(store.txn.state).toBe('pending');
	});

	it('sends once when the same form is posted twice', async () => {
		const form = { email: 'person@example.com', human_verification_response: 'proof-1' };
		await expect(post('send_code', form)).rejects.toMatchObject({ status: 303 });
		currentStep = SELECT_STEP;
		await expect(post('send_code', form)).rejects.toMatchObject({ status: 303 });
		expect(paths().filter((path) => path.endsWith('/email-code/send'))).toHaveLength(1);
	});

	it('sends nothing while the same form is still being sent', async () => {
		store.operations.set(`send:${OP}`, { status: 'running', attempt: 1, startedAt: Date.now() });
		await expect(post('send_code', { email: 'person@example.com' })).rejects.toMatchObject({
			status: 303
		});
		expect(paths()).not.toContain('/api/v1/auth/direct/email-code/send');
	});

	it('refuses an address that is not one, before any call', async () => {
		const answer = await post('send_code', { email: 'not-an-address' });
		expect(answer).toMatchObject({ status: 400, data: { error: 'email_invalid' } });
		expect(paths()).not.toContain('/api/v1/auth/direct/email-code/send');
		expect(store.operations.size).toBe(0);
	});

	it('refuses a form without its operation nonce', async () => {
		const answer = await post('send_code', { email: 'person@example.com', op: 'short' });
		expect(answer).toMatchObject({ status: 400 });
		expect(paths()).not.toContain('/api/v1/auth/direct/email-code/send');
	});

	it('sends nothing when the step does not offer the email code', async () => {
		currentStep = COMPLETION;
		const answer = await post('send_code', { email: 'person@example.com' });
		expect(answer).toMatchObject({ status: 409, data: { restart: true } });
		expect(paths()).not.toContain('/api/v1/auth/direct/email-code/send');
	});

	it('says to wait when sending is limited, and keeps no code', async () => {
		routes['/api/v1/auth/direct/email-code/send'] = () =>
			json({ error: 'rate_limit_exceeded' }, 429);
		const answer = await post('send_code', { email: 'person@example.com' });
		expect(answer).toMatchObject({ status: 429, data: { error: 'busy' } });
		expect(store.txn.data.code).toBeUndefined();
		expect(store.operations.get(`send:${OP}`)).toMatchObject({ status: 'done' });
		expect(submits()).toEqual([]);
	});

	it('keeps the code that went out when the Flow fails after it, and finishes the choice later', async () => {
		const submit = routes['/api/v1/login/interactions/int-1/submit'];
		routes['/api/v1/login/interactions/int-1/submit'] = () => json({ error: 'server_error' }, 500);
		await expect(post('send_code', { email: 'person@example.com' })).rejects.toMatchObject({
			status: 303
		});
		expect(store.txn.data.code).toMatchObject({ attemptId: 'attempt-1', choiceStepId: 'select' });

		// The Flow is still on the choice: the page draws an entry of its own for the code.
		const page = (await view()) as {
			decision: { kind: string; fields: Array<{ blockType: string }> };
		};
		expect(page.decision.fields.map((field) => field.blockType)).toEqual(['code_input_widget']);

		// The check submits the choice, then the code step, then the completion.
		routes['/api/v1/login/interactions/int-1/submit'] = submit;
		calls = [];
		expect(await post('verify_code', { code: '123456' })).toEqual({ completed: true });
		expect(submits()).toEqual(['mail_otp', 'verified', 'completed']);
		expect(paths().filter((path) => path.endsWith('/email-code/send'))).toHaveLength(0);
	});

	it('keeps the code when the Flow call throws after the send', async () => {
		routes['/api/v1/login/interactions/int-1/submit'] = () => {
			throw new Error('network');
		};
		await expect(post('send_code', { email: 'person@example.com' })).rejects.toMatchObject({
			status: 303
		});
		expect(store.txn.data.code).toMatchObject({ attemptId: 'attempt-1' });
	});
});

describe('the code entry', () => {
	const pendingCode = (sentAt = Date.now()) => ({
		interactionId: 'int-1',
		choiceStepId: 'select',
		email: 'person@example.com',
		maskedEmail: 'p***n@example.com',
		attemptId: 'attempt-1',
		verifier: 'secret-verifier-value',
		sentAt
	});

	it('draws the step asking for the code, with a proof for the resend and no secret', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		const page = await view();
		expect(page).toMatchObject({
			page: 'step',
			decision: { kind: 'screen', title: 'Enter the code' },
			codeEntry: { maskedEmail: 'p***n@example.com' },
			pow: { challenge: 'a'.repeat(64) }
		});
		expect(JSON.stringify(page)).not.toContain('secret-verifier-value');
		expect(JSON.stringify(page)).not.toContain('person@example.com');
	});

	it('draws an entry of its own when the Flow has no step for the code', async () => {
		currentStep = COMPLETION;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		const page = (await view()) as {
			decision: { kind: string; fields: Array<{ blockType: string }> };
		};
		expect(page.decision.kind).toBe('screen');
		expect(page.decision.fields.map((field) => field.blockType)).toEqual(['code_input_widget']);
	});

	it('draws nothing to do on a step asking for a code no one sent', async () => {
		currentStep = CODE_STEP;
		const page = await view();
		expect(page).toMatchObject({ decision: { kind: 'unsupported', reasons: ['code_not_sent'] } });
	});

	it('checks the code, makes the session, and completes the Flow with it', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		const e = event({
			action: 'verify_code',
			form: { txn: 'txn-1', csrf: 'csrf-1', op: OP, code: '123 456' }
		});
		const answer = await (
			actions as Record<string, (e: RequestEvent) => Promise<unknown>>
		).verify_code(e);
		expect(answer).toEqual({ completed: true });
		expect(calls.find((c) => c.path.endsWith('/email-code/verify'))?.body).toMatchObject({
			attempt_id: 'attempt-1',
			code: '123456',
			code_verifier: 'secret-verifier-value'
		});
		expect(calls.find((c) => c.path === '/api/v1/auth/direct/session')?.body).toMatchObject({
			direct_auth_artifact: 'artifact-1',
			code_verifier: 'secret-verifier-value',
			defer_authorization_continuation: true
		});
		expect(submits()).toEqual(['verified', 'completed']);
		expect(store.txn.state).toBe('completed');
		expect(store.txn.data.code).toBeUndefined();
		expect(e.locals.liteRelay?.url).toBe('https://id.example/after');
		expect(e.cookies.set).toHaveBeenCalledWith('authrim_session', 's1', expect.anything());
	});

	it('says a wrong code is wrong, and keeps the code to try again', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		routes['/api/v1/auth/direct/email-code/verify'] = () => json({ error: 'invalid_code' }, 400);
		const answer = await post('verify_code', { code: '000000' });
		expect(answer).toMatchObject({ status: 400, data: { error: 'code_invalid' } });
		expect(store.txn.data.code).toMatchObject({ attemptId: 'attempt-1' });
		expect(paths()).not.toContain('/api/v1/auth/direct/session');
	});

	it('checks nothing for a code that is not six digits', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		const answer = await post('verify_code', { code: '12ab' });
		expect(answer).toMatchObject({ status: 400, data: { error: 'code_invalid' } });
		expect(paths()).not.toContain('/api/v1/auth/direct/email-code/verify');
	});

	it('finishes only what is left after the Flow failed once (no second check)', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		const submit = routes['/api/v1/login/interactions/int-1/submit'];
		routes['/api/v1/login/interactions/int-1/submit'] = () => json({ error: 'server_error' }, 500);
		expect(await post('verify_code', { code: '123456' })).toMatchObject({
			status: 409,
			data: { error: 'retry' }
		});
		expect(store.txn.data.signedIn).toMatchObject({
			method: 'mail_otp',
			choice: { stepId: 'select', handle: 'mail_otp' }
		});
		expect(store.txn.data.code).toBeUndefined();

		// The page offers Continue; it submits the choice once and goes on.
		expect(await view()).toMatchObject({ decision: { kind: 'continue' } });
		routes['/api/v1/login/interactions/int-1/submit'] = submit;
		calls = [];
		const e = event({ action: 'continue', form: { txn: 'txn-1', csrf: 'csrf-1' } });
		(e.cookies.get as unknown) = (name: string) =>
			name === 'authrim_session' ? 's1' : 'b'.repeat(43);
		const answer = await (
			actions as Record<string, (e: RequestEvent) => Promise<unknown>>
		).continue(e);
		expect(answer).toEqual({ completed: true });
		expect(submits()).toEqual(['verified', 'completed']);
		expect(paths()).not.toContain('/api/v1/auth/direct/email-code/verify');
	});

	it('checks once when the same code form is posted twice', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		store.operations.set(`verify:${OP}`, { status: 'done', attempt: 1, startedAt: 0, result: {} });
		await expect(post('verify_code', { code: '123456' })).rejects.toMatchObject({ status: 303 });
		expect(paths()).not.toContain('/api/v1/auth/direct/email-code/verify');
	});

	it('sends a new code only after a minute, with a new verifier and no Flow submit', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		expect(await post('resend', { human_verification_response: 'proof-2' })).toMatchObject({
			status: 429,
			data: { error: 'resend_wait' }
		});
		expect(paths()).not.toContain('/api/v1/auth/direct/email-code/send');

		store.set({ data: { ...store.txn.data, code: pendingCode(Date.now() - 61_000) } });
		routes['/api/v1/auth/direct/email-code/send'] = () =>
			json({ attempt_id: 'attempt-2', expires_in: 300, masked_email: 'p***n@example.com' });
		await expect(post('resend', { human_verification_response: 'proof-2' })).rejects.toMatchObject({
			status: 303
		});
		const send = calls.find((call) => call.path.endsWith('/email-code/send'));
		expect(send?.body).toMatchObject({
			email: 'person@example.com',
			human_verification_response: 'proof-2'
		});
		const code = store.txn.data.code as Record<string, unknown>;
		expect(code.attemptId).toBe('attempt-2');
		expect(code.verifier).not.toBe('secret-verifier-value');
		expect(send?.body.code_challenge).toBe(await sha256Base64Url(String(code.verifier)));
		expect(submits()).toEqual([]);
	});

	it('starts afresh for another address (the transaction is given up)', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		await expect(post('restart', {}, 'challenge_x=1')).rejects.toMatchObject({
			status: 303,
			location: '/login?challenge_x=1'
		});
		expect(store.txn.state).toBe('abandoned');
		expect(calls).toEqual([]);
	});

	it('still starts afresh once a sign-in is done (the new Flow sees its session)', async () => {
		store.set({
			state: 'verified',
			data: {
				...store.txn.data,
				signedIn: {
					interactionId: 'int-1',
					method: 'mail_otp',
					choice: { stepId: 'select', handle: 'mail_otp' }
				}
			}
		});
		await expect(post('restart')).rejects.toMatchObject({ status: 303 });
		expect(store.txn.state).toBe('abandoned');
	});

	it('passes the session on and answers a retry when the Flow call throws after the check', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		routes['/api/v1/login/interactions/int-1/submit'] = () => {
			throw new Error('network');
		};
		const e = event({
			action: 'verify_code',
			form: { txn: 'txn-1', csrf: 'csrf-1', op: OP, code: '123456' }
		});
		const answer = await (
			actions as Record<string, (e: RequestEvent) => Promise<unknown>>
		).verify_code(e);
		expect(answer).toMatchObject({ status: 409, data: { error: 'retry' } });
		expect(e.cookies.set).toHaveBeenCalledWith('authrim_session', 's1', expect.anything());
		expect(store.txn.data.signedIn).toMatchObject({ method: 'mail_otp' });
		expect(await view()).toMatchObject({ decision: { kind: 'continue' } });
	});

	it('neither draws the entry nor checks a code on a step the lite UI cannot go on with', async () => {
		currentStep = {
			...CODE_STEP,
			id: 'odd',
			component: 'screen',
			config: { screen: { fields: [{ block_type: 'signature_pad', field: 'c', label: 'C' }] } }
		};
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		expect(await view()).toMatchObject({ decision: { kind: 'unsupported' }, codeEntry: null });
		expect(await post('verify_code', { code: '123456' })).toMatchObject({ status: 409 });
		expect(paths()).not.toContain('/api/v1/auth/direct/email-code/verify');
	});
});

describe('what a failure leaves to finish', () => {
	const pendingCode = () => ({
		interactionId: 'int-1',
		choiceStepId: 'select',
		email: 'person@example.com',
		maskedEmail: 'p***n@example.com',
		attemptId: 'attempt-1',
		verifier: 'secret-verifier-value',
		sentAt: Date.now() - 120_000
	});
	const startCalls = () =>
		calls.filter((call) => call.path === '/api/v1/login/interactions/start').map((c) => c.body);

	it('starts no new Flow on a page view whose resume fails for a moment', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		routes['/api/v1/login/interactions/start'] = () => json({ error: 'server_error' }, 503);
		expect(await view()).toMatchObject({ page: 'error' });
		expect(startCalls()).toHaveLength(1);
		expect(startCalls()[0]).toMatchObject({ resume_interaction_id: 'int-1' });
		expect(store.txn.data.code).toMatchObject({ attemptId: 'attempt-1' });
	});

	it('keeps the request in the way back from a page view that could not resume', async () => {
		routes['/auth/login-challenge'] = () => json({ client: { client_id: 'client-1' } });
		routes['/api/v1/login/interactions/start'] = () => json({ error: 'server_error' }, 503);
		expect(await view('challenge_id=ch-1')).toMatchObject({
			page: 'error',
			backHref: '/login?challenge_id=ch-1'
		});
	});

	it('makes no session on Continue when the Flow has reached a step it cannot go on with', async () => {
		currentStep = {
			...CODE_STEP,
			id: 'odd',
			component: 'screen',
			config: { screen: { fields: [{ block_type: 'signature_pad', field: 'c', label: 'C' }] } }
		};
		store.set({
			state: 'verified',
			data: {
				...store.txn.data,
				checked: {
					interactionId: 'int-1',
					choiceStepId: 'select',
					artifact: 'artifact-1',
					verifier: 'v',
					expiresAt: Date.now() + 60_000,
					code: pendingCode(),
					tries: 0
				}
			}
		});
		expect(await post('continue')).toMatchObject({ status: 409 });
		expect(paths()).not.toContain('/api/v1/auth/direct/session');
	});

	it('answers a retry (not a restart) when a post cannot resume the Flow', async () => {
		routes['/api/v1/login/interactions/start'] = () => json({ error: 'server_error' }, 503);
		expect(await post('continue')).toMatchObject({ status: 409, data: { error: 'retry' } });
	});

	it('keeps the checked code when the session cannot be made, and makes it on Continue', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		const session = routes['/api/v1/auth/direct/session'];
		routes['/api/v1/auth/direct/session'] = () => json({ error: 'server_error' }, 500);
		expect(await post('verify_code', { code: '123456' })).toMatchObject({
			status: 409,
			data: { error: 'retry' }
		});
		expect(store.txn.data.code).toBeUndefined();
		expect(store.txn.data.checked).toMatchObject({ artifact: 'artifact-1' });
		expect(await view()).toMatchObject({ decision: { kind: 'continue' } });

		routes['/api/v1/auth/direct/session'] = session;
		calls = [];
		const answer = await post('continue', { op: 'p'.repeat(22) });
		expect(answer).toEqual({ completed: true });
		expect(paths()).not.toContain('/api/v1/auth/direct/email-code/verify');
		expect(calls.find((c) => c.path === '/api/v1/auth/direct/session')?.body).toMatchObject({
			direct_auth_artifact: 'artifact-1',
			code_verifier: 'secret-verifier-value'
		});
		expect(store.txn.data.checked).toBeUndefined();
	});

	it('never puts back a code over one checked while it was being sent again', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		routes['/api/v1/auth/direct/email-code/send'] = () => {
			// A concurrent check of the earlier code finishes while this one is out.
			const { code: _spent, ...rest } = store.txn.data;
			void _spent;
			store.set({
				state: 'verified',
				version: store.txn.version + 1,
				data: {
					...rest,
					checked: {
						interactionId: 'int-1',
						choiceStepId: 'select',
						artifact: 'artifact-1',
						verifier: 'v',
						expiresAt: Date.now() + 60_000
					}
				}
			});
			return json({ attempt_id: 'attempt-2', expires_in: 300, masked_email: 'p***n@example.com' });
		};
		expect(await post('resend', { human_verification_response: 'p' })).toMatchObject({
			status: 409,
			data: { error: 'retry' }
		});
		expect(store.txn.state).toBe('verified');
		expect(store.txn.data.code).toBeUndefined();
	});

	it('brings the code entry back when the session call spent the artifact', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		routes['/api/v1/auth/direct/session'] = () => json({ error: 'invalid_grant' }, 400);
		expect(await post('verify_code', { code: '123456' })).toMatchObject({
			status: 400,
			data: { error: 'code_invalid' }
		});
		expect(store.txn.data.checked).toBeUndefined();
		expect(store.txn.data.code).toMatchObject({ attemptId: 'attempt-1', sentAt: 0 });
		// A new code can be sent at once.
		expect(await view()).toMatchObject({ codeEntry: { resendWait: 0 } });
	});

	it('keeps the code entry when a resend fails for a moment', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		routes['/api/v1/auth/direct/email-code/send'] = () => json({ error: 'server_error' }, 503);
		expect(await post('resend', { human_verification_response: 'p' })).toMatchObject({
			status: 409,
			data: { error: 'retry' }
		});
		expect(store.txn.data.code).toMatchObject({ attemptId: 'attempt-1' });
	});

	it('submits nothing on an unsupported code step reached after the choice', async () => {
		// The send's choice submit failed: the Flow is still on the choice when the code is checked.
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		const odd = {
			...CODE_STEP,
			config: {
				screen: {
					fields: [
						{ block_type: 'code_input_widget', field: 'code', label: 'Code' },
						{ block_type: 'signature_pad', field: 'c', label: 'C' }
					]
				}
			}
		};
		const submit = routes['/api/v1/login/interactions/int-1/submit'];
		routes['/api/v1/login/interactions/int-1/submit'] = (body, init) => {
			if (body.selected_handle !== 'mail_otp') return submit(body, init);
			currentStep = odd;
			return json({ completed: false, step: odd, interaction: { current_step_id: 'code' } });
		};
		expect(await post('verify_code', { code: '123456' })).toMatchObject({ status: 409 });
		expect(submits()).toEqual(['mail_otp']);
		expect(store.txn.data.signedIn).toMatchObject({ method: 'mail_otp' });
	});

	it('spends the artifact once when two tabs post Continue together', async () => {
		const checked = {
			interactionId: 'int-1',
			choiceStepId: 'select',
			artifact: 'artifact-1',
			verifier: 'v',
			expiresAt: Date.now() + 60_000,
			code: pendingCode(),
			tries: 0
		};
		currentStep = CODE_STEP;
		store.set({ state: 'verified', data: { ...store.txn.data, checked } });
		// The other tab's session call is under way (named by the code and the try, not the form).
		store.operations.set('session:attempt-1:0', {
			status: 'running',
			attempt: 1,
			startedAt: Date.now()
		});
		await expect(post('continue', { op: 'q'.repeat(22) })).rejects.toMatchObject({ status: 303 });
		expect(paths()).not.toContain('/api/v1/auth/direct/session');
	});

	it('tries the session again as a new operation after a failed try', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		routes['/api/v1/auth/direct/session'] = () => json({ error: 'server_error' }, 500);
		await post('verify_code', { code: '123456' });
		expect(store.txn.data.checked).toMatchObject({ tries: 1 });
		expect(store.operations.get('session:attempt-1:0')).toMatchObject({ status: 'done' });
	});

	it('tries the session again when its call throws (its try is recorded as failed)', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		routes['/api/v1/auth/direct/session'] = () => {
			throw new Error('network');
		};
		expect(await post('verify_code', { code: '123456' })).toMatchObject({
			status: 409,
			data: { error: 'retry' }
		});
		expect(store.operations.get('session:attempt-1:0')).toMatchObject({
			status: 'done',
			result: { outcome: 'failed' }
		});
		expect(store.txn.data.checked).toMatchObject({ tries: 1 });
	});

	it("makes a finished try's change from its recorded outcome when it was not saved", async () => {
		const checked = {
			interactionId: 'int-1',
			choiceStepId: 'select',
			artifact: 'artifact-1',
			verifier: 'v',
			expiresAt: Date.now() + 60_000,
			code: pendingCode(),
			tries: 0
		};
		currentStep = CODE_STEP;
		store.set({ state: 'verified', data: { ...store.txn.data, checked } });
		store.operations.set('session:attempt-1:0', {
			status: 'done',
			attempt: 1,
			startedAt: 0,
			result: { outcome: 'signed_in' }
		});
		const e = event({ action: 'continue', form: { txn: 'txn-1', csrf: 'csrf-1' } });
		(e.cookies.get as unknown) = (name: string) =>
			name === 'authrim_session' ? 's1' : 'b'.repeat(43);
		const answer = await (
			actions as Record<string, (e: RequestEvent) => Promise<unknown>>
		).continue(e);
		expect(answer).toEqual({ completed: true });
		expect(paths()).not.toContain('/api/v1/auth/direct/session');
		expect(submits()).toEqual(['verified', 'completed']);
	});

	it('recovers a recorded sign-in even after the artifact has expired', async () => {
		currentStep = CODE_STEP;
		store.set({
			state: 'verified',
			data: {
				...store.txn.data,
				checked: {
					interactionId: 'int-1',
					choiceStepId: 'select',
					artifact: 'artifact-1',
					verifier: 'v',
					expiresAt: Date.now() - 1,
					code: pendingCode(),
					tries: 0
				}
			}
		});
		store.operations.set('session:attempt-1:0', {
			status: 'done',
			attempt: 1,
			startedAt: 0,
			result: { outcome: 'signed_in' }
		});
		const e = event({ action: 'continue', form: { txn: 'txn-1', csrf: 'csrf-1' } });
		(e.cookies.get as unknown) = (name: string) =>
			name === 'authrim_session' ? 's1' : 'b'.repeat(43);
		expect(
			await (actions as Record<string, (e: RequestEvent) => Promise<unknown>>).continue(e)
		).toEqual({ completed: true });
	});

	it('refuses a resend over a checked code, expired or not (only Continue settles it)', async () => {
		currentStep = CODE_STEP;
		const checked = {
			interactionId: 'int-1',
			choiceStepId: 'select',
			artifact: 'artifact-1',
			verifier: 'v',
			expiresAt: Date.now() - 1,
			code: pendingCode(),
			tries: 0
		};
		store.set({ state: 'verified', data: { ...store.txn.data, checked } });
		await expect(post('resend', { human_verification_response: 'p' })).rejects.toMatchObject({
			status: 303
		});
		expect(paths()).not.toContain('/api/v1/auth/direct/email-code/send');
		expect(store.txn.data.checked).toMatchObject({ artifact: 'artifact-1' });
	});

	it('goes where the session call says when the Flow names no destination', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		routes['/api/v1/auth/direct/session'] = () =>
			json({ ok: true, redirect_url: 'https://id.example/account' }, 200, {
				'Set-Cookie': 'authrim_session=s1; Path=/; HttpOnly; Secure; SameSite=Lax'
			});
		const submit = routes['/api/v1/login/interactions/int-1/submit'];
		routes['/api/v1/login/interactions/int-1/submit'] = (body, init) =>
			body.selected_handle === 'completed'
				? json({ completed: true, output: { action: 'complete' } })
				: submit(body, init);
		const e = event({
			action: 'verify_code',
			form: { txn: 'txn-1', csrf: 'csrf-1', op: OP, code: '123456' }
		});
		expect(
			await (actions as Record<string, (e: RequestEvent) => Promise<unknown>>).verify_code(e)
		).toEqual({ completed: true });
		expect(e.locals.liteRelay?.url).toBe('https://id.example/account');
	});

	it('never goes to a session destination off the public origin', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		routes['/api/v1/auth/direct/session'] = () =>
			json({ ok: true, redirect_url: 'https://evil.example/x' }, 200, {
				'Set-Cookie': 'authrim_session=s1; Path=/; HttpOnly; Secure; SameSite=Lax'
			});
		const submit = routes['/api/v1/login/interactions/int-1/submit'];
		routes['/api/v1/login/interactions/int-1/submit'] = (body, init) =>
			body.selected_handle === 'completed'
				? json({ completed: true, output: { action: 'complete' } })
				: submit(body, init);
		const e = event({
			action: 'verify_code',
			form: { txn: 'txn-1', csrf: 'csrf-1', op: OP, code: '123456' }
		});
		await (actions as Record<string, (e: RequestEvent) => Promise<unknown>>).verify_code(e);
		expect(e.locals.liteRelay?.url).toBe('https://id.example/');
	});

	it("offers a new code once the checked code's artifact has expired", async () => {
		currentStep = CODE_STEP;
		const { sentAt: _old, ...code } = pendingCode();
		void _old;
		store.set({
			state: 'verified',
			data: {
				...store.txn.data,
				checked: {
					interactionId: 'int-1',
					choiceStepId: 'select',
					artifact: 'artifact-1',
					verifier: 'v',
					expiresAt: Date.now() - 1,
					code: { ...code, sentAt: Date.now() },
					tries: 1
				}
			}
		});
		// Continue first (a finished try would be recovered); with none, the code entry comes back.
		expect(await view()).toMatchObject({ decision: { kind: 'continue' } });
		expect(await post('continue', { op: 'q'.repeat(22) })).toMatchObject({
			status: 400,
			data: { error: 'code_invalid' }
		});
		expect(paths()).not.toContain('/api/v1/auth/direct/session');
		expect(await view()).toMatchObject({
			decision: { kind: 'screen' },
			codeEntry: { resendWait: 0 }
		});
		routes['/api/v1/auth/direct/email-code/send'] = () =>
			json({ attempt_id: 'attempt-2', expires_in: 300, masked_email: 'p***n@example.com' });
		await expect(post('resend', { human_verification_response: 'p' })).rejects.toMatchObject({
			status: 303
		});
		expect(store.txn.data.checked).toBeUndefined();
		expect(store.txn.data.code).toMatchObject({ attemptId: 'attempt-2' });
	});

	it('keeps the code entry when the check fails for a moment', async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		routes['/api/v1/auth/direct/email-code/verify'] = () => json({ error: 'server_error' }, 503);
		expect(await post('verify_code', { code: '123456' })).toMatchObject({
			status: 409,
			data: { error: 'retry' }
		});
		expect(store.txn.data.code).toMatchObject({ attemptId: 'attempt-1' });
	});

	it('sends no new code from a step the lite UI cannot go on with', async () => {
		currentStep = {
			...CODE_STEP,
			id: 'odd',
			component: 'screen',
			config: { screen: { fields: [{ block_type: 'signature_pad', field: 'c', label: 'C' }] } }
		};
		store.set({ state: 'pending', data: { ...store.txn.data, code: pendingCode() } });
		expect(await post('resend', { human_verification_response: 'p' })).toMatchObject({
			status: 409
		});
		expect(paths()).not.toContain('/api/v1/auth/direct/email-code/send');
	});
});

describe('guest', () => {
	it('signs in as a guest for the authorization request, then submits the choice', async () => {
		store.set({ bound: { ...store.txn.bound, challengeId: 'ch-1', clientId: 'client-1' } });
		routes['/auth/login-challenge'] = () => json({ client: { client_id: 'client-1' } });
		const e = event({
			action: 'guest',
			form: { txn: 'txn-1', csrf: 'csrf-1', op: OP, human_verification_response: 'proof-g' }
		});
		const answer = await (actions as Record<string, (e: RequestEvent) => Promise<unknown>>).guest(
			e
		);
		expect(answer).toEqual({ completed: true });
		expect(calls.find((c) => c.path === '/api/auth/guest/login')?.body).toEqual({
			authorizationChallengeId: 'ch-1',
			human_verification_response: 'proof-g'
		});
		expect(submits()).toEqual(['guest', 'completed']);
		expect(store.txn.state).toBe('completed');
	});

	it("uses the Login UI's own client without an authorization request", async () => {
		await post('guest', { human_verification_response: 'proof-g' });
		expect(calls.find((c) => c.path === '/api/auth/guest/login')?.body).toEqual({
			clientId: 'login-ui',
			human_verification_response: 'proof-g'
		});
	});

	it('makes no guest when the tenant has guest sign-in off', async () => {
		const e = event({ action: 'guest', form: { txn: 'txn-1', csrf: 'csrf-1', op: OP } });
		e.locals.authenticationMethods = { methods: { emailCode: { enabled: true } } } as never;
		const answer = await (actions as Record<string, (e: RequestEvent) => Promise<unknown>>).guest(
			e
		);
		expect(answer).toMatchObject({ status: 409 });
		expect(paths()).not.toContain('/api/auth/guest/login');
	});

	it('makes one guest when the same form is posted twice', async () => {
		await post('guest');
		store.set({ state: 'pending', data: { flow: store.txn.data.flow } });
		currentStep = SELECT_STEP;
		await expect(post('guest')).rejects.toMatchObject({ status: 303 });
		expect(paths().filter((path) => path === '/api/auth/guest/login')).toHaveLength(1);
	});

	it('says what went wrong when the guest sign-in is refused, and records no sign-in', async () => {
		routes['/api/auth/guest/login'] = () =>
			json({ error: 'server_error' }, 500, {
				'Set-Cookie': 'authrim_guest_resume=r1; Path=/; HttpOnly; Secure; SameSite=Lax'
			});
		const e = event({ action: 'guest', form: { txn: 'txn-1', csrf: 'csrf-1', op: OP } });
		const answer = await (actions as Record<string, (e: RequestEvent) => Promise<unknown>>).guest(
			e
		);
		expect(answer).toMatchObject({ status: 409, data: { error: 'retry' } });
		expect(store.txn.data.signedIn).toBeUndefined();
		expect(submits()).toEqual([]);
		// Its resume cookie still reaches the browser: a retry makes the same guest.
		expect(e.cookies.set).toHaveBeenCalledWith('authrim_guest_resume', 'r1', expect.anything());
	});
});

describe('a post the page does not accept', () => {
	it('refuses another form token, before any call', async () => {
		const answer = await post('send_code', { csrf: 'other', email: 'person@example.com' });
		expect(answer).toMatchObject({ status: 403 });
		expect(calls).toEqual([]);
	});

	it('refuses a finished transaction', async () => {
		store.set({ state: 'completed' });
		expect(await post('verify_code', { code: '123456' })).toMatchObject({ status: 403 });
		expect(calls).toEqual([]);
	});
});

const METHOD_STEP = {
	id: 'methods',
	source_node_id: 'n-methods',
	component: 'authentication_method_selector',
	render: true,
	config: {
		screen: {
			display_name: 'Sign in',
			fields: [
				{ field: 'email', label: 'Email', required: true },
				{ block_type: 'auth_widget', field: 't', label: 'Authenticator', auth_method: 'totp' },
				{ block_type: 'auth_widget', field: 'p', label: 'Passkey', auth_method: 'passkey' }
			]
		}
	}
};

/** The steps the methods' handles lead to: a code step when the Flow has one, else the end. */
function methodRoutes() {
	const submit = routes['/api/v1/login/interactions/int-1/submit'];
	routes['/api/v1/login/interactions/int-1/submit'] = (body, init) => {
		if (body.selected_handle === 'totp' || body.selected_handle === 'passkey') {
			const next = withCodeStep && body.selected_handle === 'totp' ? CODE_STEP : COMPLETION;
			currentStep = next;
			return json({ completed: false, step: next, interaction: { current_step_id: next.id } });
		}
		return submit(body, init);
	};
	routes['/api/auth/totp/login/start'] = () => json({ challenge_id: 'totp-1', expires_in: 300 });
	routes['/api/auth/totp/login/verify'] = () =>
		json({ success: true, redirect_url: 'https://id.example/totp-after' }, 200, {
			'Set-Cookie': 'authrim_session=t1; Path=/; HttpOnly; Secure; SameSite=Lax'
		});
	routes['/api/v1/auth/direct/passkey/login/start'] = () =>
		json({
			challenge_id: 'pk-1',
			options: {
				challenge: 'c'.repeat(43),
				rpId: 'id.example',
				timeout: 60000,
				userVerification: 'required',
				allowCredentials: [],
				extensions: { anything: true }
			}
		});
	routes['/api/v1/auth/direct/passkey/login/finish'] = () =>
		json({ direct_auth_artifact: 'pk-artifact', expires_in: 60 });
}

describe('the authenticator app', () => {
	beforeEach(() => {
		currentStep = METHOD_STEP;
		tenantMethods = { totp: { enabled: true }, passkey: { enabled: true } };
		methodRoutes();
	});
	const pendingTotp = () => ({
		interactionId: 'int-1',
		choiceStepId: 'methods',
		challengeId: 'totp-1',
		expiresAt: Date.now() + 300_000
	});

	it('starts with the address and the proof, keeps the challenge, and chooses it when the Flow asks for the code itself', async () => {
		await expect(
			post('totp_start', { email: 'person@example.com', human_verification_response: 'proof-1' })
		).rejects.toMatchObject({ status: 303 });
		const start = calls.find((call) => call.path === '/api/auth/totp/login/start');
		expect(start?.body).toEqual({
			identifier: 'person@example.com',
			human_verification_response: 'proof-1'
		});
		expect(start?.headers.get('X-Authrim-Interaction-Id')).toBe('int-1');
		expect(store.txn.data.totp).toMatchObject({ challengeId: 'totp-1', choiceStepId: 'methods' });
		expect(submits()).toEqual(['totp']);
	});

	it('submits no choice at the start when the Flow has no step for the code, and draws an entry of its own', async () => {
		withCodeStep = false;
		await expect(post('totp_start', { email: 'person@example.com' })).rejects.toMatchObject({
			status: 303
		});
		expect(submits()).toEqual([]);
		const page = (await view()) as {
			decision: { fields: Array<{ blockType: string }> };
			codeEntry: unknown;
			pow: unknown;
		};
		expect(page.decision.fields.map((field) => field.blockType)).toEqual(['code_input_widget']);
		expect(page.codeEntry).toEqual({
			kind: 'totp',
			maskedEmail: null,
			resendWait: 0,
			challenge: 'totp-1',
			setup: null
		});
		expect(page.pow).toBeNull();
	});

	it('checks the code, passes the session on, then submits the choice and completes the Flow', async () => {
		withCodeStep = false;
		store.set({ state: 'pending', data: { ...store.txn.data, totp: pendingTotp() } });
		const e = event({
			action: 'totp_verify',
			form: { txn: 'txn-1', csrf: 'csrf-1', op: OP, challenge: 'totp-1', code: '1234 5678' }
		});
		const answer = await (
			actions as Record<string, (e: RequestEvent) => Promise<unknown>>
		).totp_verify(e);
		expect(answer).toEqual({ completed: true });
		expect(calls.find((call) => call.path === '/api/auth/totp/login/verify')?.body).toEqual({
			challenge_id: 'totp-1',
			code: '12345678',
			defer_authorization_continuation: true
		});
		expect(submits()).toEqual(['totp', 'completed']);
		expect(e.cookies.set).toHaveBeenCalledWith('authrim_session', 't1', expect.anything());
		expect(store.txn.state).toBe('completed');
		expect(store.txn.data.totp).toBeUndefined();
	});

	it("submits the Flow's own code step as checked once the choice went at the start", async () => {
		currentStep = CODE_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, totp: pendingTotp() } });
		expect(await post('totp_verify', { challenge: 'totp-1', code: '123456' })).toEqual({
			completed: true
		});
		expect(submits()).toEqual(['verified', 'completed']);
	});

	it('starts again after a wrong code (ar-auth spent the challenge)', async () => {
		withCodeStep = false;
		store.set({ state: 'pending', data: { ...store.txn.data, totp: pendingTotp() } });
		routes['/api/auth/totp/login/verify'] = () => json({ error: 'invalid_code' }, 400);
		const answer = await post('totp_verify', { challenge: 'totp-1', code: '000000' });
		expect(answer).toMatchObject({ status: 400, data: { error: 'totp_invalid' } });
		expect(store.txn.data.totp).toBeUndefined();
		expect(store.txn.data.signedIn).toBeUndefined();
		expect(submits()).toEqual([]);
	});

	it('checks nothing for a code of the wrong length', async () => {
		store.set({ state: 'pending', data: { ...store.txn.data, totp: pendingTotp() } });
		const answer = await post('totp_verify', { challenge: 'totp-1', code: '12345' });
		expect(answer).toMatchObject({ status: 400, data: { error: 'totp_invalid' } });
		expect(paths()).not.toContain('/api/auth/totp/login/verify');
	});

	it('starts nothing when the tenant has the authenticator app off', async () => {
		tenantMethods = { passkey: { enabled: true } };
		const answer = await post('totp_start', { email: 'person@example.com' });
		expect(answer).toMatchObject({ status: 409, data: { restart: true } });
		expect(paths()).not.toContain('/api/auth/totp/login/start');
	});

	it('sends no email code over an authenticator sign-in begun', async () => {
		currentStep = SELECT_STEP;
		tenantMethods = { emailCode: { enabled: true }, totp: { enabled: true } };
		store.set({ state: 'pending', data: { ...store.txn.data, totp: pendingTotp() } });
		await expect(post('send_code', { email: 'person@example.com' })).rejects.toMatchObject({
			status: 303
		});
		expect(paths()).not.toContain('/api/v1/auth/direct/email-code/send');
	});
});

describe('the passkey', () => {
	beforeEach(() => {
		currentStep = METHOD_STEP;
		tenantMethods = { totp: { enabled: true }, passkey: { enabled: true } };
		methodRoutes();
	});
	const pendingPasskey = () => ({
		interactionId: 'int-1',
		choiceStepId: 'methods',
		challengeId: 'pk-1',
		verifier: 'secret-passkey-verifier',
		options: {
			challenge: 'c'.repeat(43),
			rpId: 'id.example',
			timeout: 60000,
			userVerification: 'required',
			allowCredentials: []
		},
		expiresAt: Date.now() + 60_000
	});
	const credential = JSON.stringify({
		id: 'cred-1',
		rawId: 'cred-1',
		type: 'public-key',
		response: { authenticatorData: 'YXV0aA', clientDataJSON: 'Y2RqCg', signature: 'c2ln' },
		authenticatorAttachment: 'platform',
		injected: '<script>'
	});

	it('gets the challenge with the proof and a PKCE challenge, keeps it, and submits nothing yet', async () => {
		await expect(
			post('passkey_start', { human_verification_response: 'proof-1' }, 'challenge_id=ch-1')
		).rejects.toMatchObject({ status: 303 });
		const start = calls.find((call) => call.path === '/api/v1/auth/direct/passkey/login/start');
		expect(start?.headers.get('X-Authrim-Interaction-Id')).toBe('int-1');
		const kept = store.txn.data.passkey as Record<string, unknown>;
		expect(kept).toMatchObject({ challengeId: 'pk-1', choiceStepId: 'methods' });
		// Only the fields the ceremony reads are kept.
		expect(kept.options).not.toHaveProperty('extensions');
		expect(start?.body).toMatchObject({
			client_id: 'login-ui',
			code_challenge: await sha256Base64Url(String(kept.verifier)),
			code_challenge_method: 'S256',
			channel: 'browser',
			human_verification_response: 'proof-1'
		});
		expect(submits()).toEqual([]);
	});

	it('draws the ceremony with its options and script, and no secret or proof', async () => {
		store.set({ state: 'pending', data: { ...store.txn.data, passkey: pendingPasskey() } });
		const e = event();
		const page = await (load as unknown as (e: RequestEvent) => Promise<Record<string, unknown>>)(
			e
		);
		expect(page).toMatchObject({ passkey: { options: { rpId: 'id.example' } }, pow: null });
		expect(JSON.stringify(page)).not.toContain('secret-passkey-verifier');
		expect(e.locals.liteCsp?.scriptHashes).toHaveLength(1);
	});

	it('checks the assertion, makes the session from its artifact, then submits the choice', async () => {
		store.set({ state: 'pending', data: { ...store.txn.data, passkey: pendingPasskey() } });
		expect(await post('passkey_finish', { challenge: 'pk-1', credential })).toEqual({
			completed: true
		});
		const finish = calls.find((call) => call.path === '/api/v1/auth/direct/passkey/login/finish');
		expect(finish?.body).toMatchObject({
			challenge_id: 'pk-1',
			code_verifier: 'secret-passkey-verifier',
			channel: 'browser'
		});
		// Re-made from the checked fields: nothing else the page sent goes on.
		expect(finish?.body.credential).not.toHaveProperty('injected');
		expect(calls.find((call) => call.path === '/api/v1/auth/direct/session')?.body).toMatchObject({
			direct_auth_artifact: 'pk-artifact',
			code_verifier: 'secret-passkey-verifier'
		});
		expect(submits()).toEqual(['passkey', 'completed']);
		expect(store.txn.state).toBe('completed');
	});

	it('sends no assertion that does not read, and keeps the challenge for another try', async () => {
		store.set({ state: 'pending', data: { ...store.txn.data, passkey: pendingPasskey() } });
		const answer = await post('passkey_finish', { challenge: 'pk-1', credential: '{"id":"x"}' });
		expect(answer).toMatchObject({ status: 400, data: { error: 'passkey_failed' } });
		expect(paths()).not.toContain('/api/v1/auth/direct/passkey/login/finish');
		expect(store.txn.data.passkey).toMatchObject({ challengeId: 'pk-1' });
	});

	it('starts again when the assertion is refused (ar-auth spent the challenge)', async () => {
		store.set({ state: 'pending', data: { ...store.txn.data, passkey: pendingPasskey() } });
		routes['/api/v1/auth/direct/passkey/login/finish'] = () =>
			json({ error: 'passkey_failed' }, 400);
		const answer = await post('passkey_finish', { challenge: 'pk-1', credential });
		expect(answer).toMatchObject({ status: 400, data: { error: 'passkey_failed' } });
		expect(store.txn.data.passkey).toBeUndefined();
		expect(paths()).not.toContain('/api/v1/auth/direct/session');
	});

	it('starts again, with no code put back, when the session call spent the artifact', async () => {
		store.set({ state: 'pending', data: { ...store.txn.data, passkey: pendingPasskey() } });
		routes['/api/v1/auth/direct/session'] = () => json({ error: 'invalid_grant' }, 400);
		const answer = await post('passkey_finish', { challenge: 'pk-1', credential });
		expect(answer).toMatchObject({ status: 400, data: { error: 'passkey_failed' } });
		expect(store.txn.data.checked).toBeUndefined();
		expect(store.txn.data.code).toBeUndefined();
		const page = (await view()) as { decision: { kind: string }; passkey: unknown };
		expect(page.decision.kind).toBe('screen');
		expect(page.passkey).toBeNull();
	});

	it('keeps nothing from a start whose options do not read', async () => {
		routes['/api/v1/auth/direct/passkey/login/start'] = () =>
			json({ challenge_id: 'pk-1', options: { challenge: 'not base64url!', rpId: 'id.example' } });
		const answer = await post('passkey_start', {});
		expect(answer).toMatchObject({ status: 400, data: { error: 'passkey_failed' } });
		expect(store.txn.data.passkey).toBeUndefined();
	});
});

describe('one sign-in at a time across tabs', () => {
	beforeEach(() => {
		currentStep = METHOD_STEP;
		tenantMethods = {
			emailCode: { enabled: true },
			totp: { enabled: true },
			passkey: { enabled: true },
			guest: { enabled: true }
		};
		methodRoutes();
	});
	const pendingPasskey = {
		interactionId: 'int-1',
		choiceStepId: 'methods',
		challengeId: 'pk-1',
		verifier: 'secret-passkey-verifier',
		options: {
			challenge: 'c'.repeat(43),
			rpId: 'id.example',
			timeout: 60000,
			userVerification: 'required',
			allowCredentials: []
		},
		expiresAt: Date.now() + 60_000
	};
	const credential = JSON.stringify({
		id: 'cred-1',
		rawId: 'cred-1',
		type: 'public-key',
		response: { authenticatorData: 'YXV0aA', clientDataJSON: 'Y2RqCg', signature: 'c2ln' }
	});

	it('sends a code from the email-code half of the email-code-or-authenticator part', async () => {
		currentStep = {
			...METHOD_STEP,
			config: {
				screen: {
					display_name: 'Sign in',
					fields: [{ block_type: 'auth_widget', field: 'c', auth_method: 'mail_otp_totp' }]
				}
			}
		};
		await expect(post('send_code', { email: 'person@example.com' })).rejects.toMatchObject({
			status: 303
		});
		expect(paths()).toContain('/api/v1/auth/direct/email-code/send');
	});

	it('checks a passkey challenge once, whatever form posts it (another tab waits)', async () => {
		store.set({ state: 'pending', data: { ...store.txn.data, passkey: pendingPasskey } });
		store.operations.set('verify:passkey:pk-1', {
			status: 'running',
			attempt: 1,
			startedAt: Date.now()
		});
		await expect(
			post('passkey_finish', { challenge: 'pk-1', credential, op: 'x'.repeat(22) })
		).rejects.toMatchObject({
			status: 303
		});
		expect(paths()).not.toContain('/api/v1/auth/direct/passkey/login/finish');
		expect(store.txn.data.passkey).toMatchObject({ challengeId: 'pk-1' });
	});

	it('checks an authenticator challenge once, and makes its recorded sign-in when it was not saved', async () => {
		withCodeStep = false;
		// The first check's session cookie: the browser has it.
		browserCookies = { authrim_session: 't1' };
		store.set({
			state: 'pending',
			data: {
				...store.txn.data,
				totp: {
					interactionId: 'int-1',
					choiceStepId: 'methods',
					challengeId: 'totp-1',
					expiresAt: Date.now() + 60_000
				}
			}
		});
		store.operations.set('verify:totp:totp-1', {
			status: 'done',
			attempt: 1,
			startedAt: Date.now(),
			result: {
				signedIn: {
					interactionId: 'int-1',
					method: 'totp',
					choice: { stepId: 'methods', handle: 'totp' },
					redirectUrl: null
				}
			}
		});
		expect(await post('totp_verify', { challenge: 'totp-1', code: '123456' })).toEqual({
			completed: true
		});
		expect(paths()).not.toContain('/api/auth/totp/login/verify');
		expect(submits()).toEqual(['totp', 'completed']);
	});

	it("makes a passkey check's recorded artifact into the session when it was not saved", async () => {
		store.set({ state: 'pending', data: { ...store.txn.data, passkey: pendingPasskey } });
		store.operations.set('verify:passkey:pk-1', {
			status: 'done',
			attempt: 1,
			startedAt: Date.now(),
			result: {
				checked: {
					interactionId: 'int-1',
					method: 'passkey',
					choiceStepId: 'methods',
					artifact: 'pk-artifact',
					verifier: 'secret-passkey-verifier',
					expiresAt: Date.now() + 60_000,
					attemptKey: 'pk-1',
					code: null,
					tries: 0
				}
			}
		});
		expect(await post('passkey_finish', { challenge: 'pk-1', credential })).toEqual({
			completed: true
		});
		expect(paths()).not.toContain('/api/v1/auth/direct/passkey/login/finish');
		expect(calls.find((call) => call.path === '/api/v1/auth/direct/session')?.body).toMatchObject({
			direct_auth_artifact: 'pk-artifact'
		});
		expect(submits()).toEqual(['passkey', 'completed']);
	});

	it('records no passkey check next to an email code sent meanwhile (its challenge expired)', async () => {
		store.set({ state: 'pending', data: { ...store.txn.data, passkey: pendingPasskey } });
		routes['/api/v1/auth/direct/passkey/login/finish'] = () => {
			// Another tab sends a code while this check is out.
			store.set({
				data: {
					...store.txn.data,
					code: {
						interactionId: 'int-1',
						choiceStepId: 'methods',
						email: 'person@example.com',
						maskedEmail: null,
						attemptId: 'attempt-9',
						verifier: 'v',
						sentAt: Date.now()
					}
				},
				version: store.txn.version + 1
			});
			return json({ direct_auth_artifact: 'pk-artifact', expires_in: 60 });
		};
		const answer = await post('passkey_finish', { challenge: 'pk-1', credential });
		expect(answer).toMatchObject({ status: 409 });
		expect(store.txn.data.checked).toBeUndefined();
		expect(store.txn.data.code).toMatchObject({ attemptId: 'attempt-9' });
		expect(paths()).not.toContain('/api/v1/auth/direct/session');
	});

	it("keeps a passkey challenge for ar-auth's five minutes, whatever the ceremony's timeout", async () => {
		await expect(post('passkey_start', {})).rejects.toMatchObject({ status: 303 });
		const kept = store.txn.data.passkey as { expiresAt: number };
		expect(kept.expiresAt - Date.now()).toBeGreaterThan(290_000);
	});

	it('makes no guest over a passkey sign-in begun (an old form from another tab)', async () => {
		currentStep = SELECT_STEP;
		store.set({ state: 'pending', data: { ...store.txn.data, passkey: pendingPasskey } });
		await expect(post('guest', {})).rejects.toMatchObject({ status: 303 });
		expect(paths()).not.toContain('/api/auth/guest/login');
		expect(store.txn.data.passkey).toMatchObject({ challengeId: 'pk-1' });
	});
});

describe('an authenticator or passkey start that expired', () => {
	beforeEach(() => {
		currentStep = METHOD_STEP;
		withCodeStep = false;
		tenantMethods = { totp: { enabled: true }, passkey: { enabled: true } };
		methodRoutes();
	});
	const lapsedTotp = {
		interactionId: 'int-1',
		choiceStepId: 'methods',
		challengeId: 'totp-1',
		expiresAt: Date.now() - 1
	};

	it('draws a Continue that posts to its check, which clears it without a code', async () => {
		store.set({ state: 'pending', data: { ...store.txn.data, totp: lapsedTotp } });
		const page = await view();
		expect(page).toMatchObject({ decision: { kind: 'continue' }, continueAction: 'totp_verify' });
		const answer = await post('totp_verify', { challenge: 'totp-1' });
		expect(answer).toMatchObject({ status: 400, data: { error: 'totp_invalid' } });
		expect(store.txn.data.totp).toBeUndefined();
		expect(paths()).not.toContain('/api/auth/totp/login/verify');
	});

	it("recovers a passkey check made before it expired, from the Continue's post", async () => {
		store.set({
			state: 'pending',
			data: {
				...store.txn.data,
				passkey: {
					interactionId: 'int-1',
					choiceStepId: 'methods',
					challengeId: 'pk-1',
					verifier: 'v',
					options: {
						challenge: 'c'.repeat(43),
						rpId: 'id.example',
						timeout: 60000,
						userVerification: 'required',
						allowCredentials: []
					},
					expiresAt: Date.now() - 1
				}
			}
		});
		store.operations.set('verify:passkey:pk-1', {
			status: 'done',
			attempt: 1,
			startedAt: Date.now(),
			result: {
				checked: {
					interactionId: 'int-1',
					method: 'passkey',
					choiceStepId: 'methods',
					artifact: 'pk-artifact',
					verifier: 'v',
					expiresAt: Date.now() + 60_000,
					attemptKey: 'pk-1',
					code: null,
					tries: 0
				}
			}
		});
		expect(await view()).toMatchObject({ continueAction: 'passkey_finish' });
		expect(await post('passkey_finish', { challenge: 'pk-1' })).toEqual({ completed: true });
		expect(submits()).toEqual(['passkey', 'completed']);
	});

	it('is never replaced by another start or a guest (a check of it may still be out)', async () => {
		tenantMethods = {
			totp: { enabled: true },
			passkey: { enabled: true },
			guest: { enabled: true }
		};
		store.set({ state: 'pending', data: { ...store.txn.data, totp: lapsedTotp } });
		await expect(post('passkey_start', {})).rejects.toMatchObject({ status: 303 });
		currentStep = SELECT_STEP;
		await expect(post('guest', {})).rejects.toMatchObject({ status: 303 });
		expect(paths()).not.toContain('/api/v1/auth/direct/passkey/login/start');
		expect(paths()).not.toContain('/api/auth/guest/login');
		expect(store.txn.data.totp).toMatchObject({ challengeId: 'totp-1' });
	});

	it('waits for a check of it still out, rather than clearing it', async () => {
		store.set({ state: 'pending', data: { ...store.txn.data, totp: lapsedTotp } });
		store.operations.set('verify:totp:totp-1', {
			status: 'running',
			attempt: 1,
			startedAt: Date.now()
		});
		await expect(post('totp_verify', { challenge: 'totp-1' })).rejects.toMatchObject({
			status: 303
		});
		expect(store.txn.data.totp).toMatchObject({ challengeId: 'totp-1' });
	});

	it("records an authenticator sign-in within the store's result limit (a long destination left out)", async () => {
		store.set({
			state: 'pending',
			data: { ...store.txn.data, totp: { ...lapsedTotp, expiresAt: Date.now() + 60_000 } }
		});
		const long = `https://id.example/after?state=${'x'.repeat(1200)}`;
		routes['/api/auth/totp/login/verify'] = () =>
			json({ success: true, redirect_url: long }, 200, {
				'Set-Cookie': 'authrim_session=t1; Path=/; HttpOnly; Secure; SameSite=Lax'
			});
		await post('totp_verify', { challenge: 'totp-1', code: '123456' });
		const recorded = store.operations.get('verify:totp:totp-1')?.result;
		expect(JSON.stringify(recorded).length).toBeLessThan(1024);
		expect(recorded).toMatchObject({ signedIn: { method: 'totp', redirectUrl: null } });
	});
});

describe('a code step after steps not drawn', () => {
	const HIDDEN = {
		id: 'hidden',
		source_node_id: 'n-hidden',
		component: 'condition',
		render: false
	};

	it('takes the hidden steps after an authenticator check and submits the code step as checked', async () => {
		currentStep = METHOD_STEP;
		tenantMethods = { totp: { enabled: true } };
		methodRoutes();
		let hiddenFails = true;
		routes['/api/v1/login/interactions/int-1/submit'] = (body) => {
			if (body.selected_handle === 'totp') {
				currentStep = HIDDEN;
				return json({ completed: false, step: HIDDEN, interaction: { current_step_id: 'hidden' } });
			}
			if (body.step_id === 'hidden') {
				if (hiddenFails) return json({ error: 'server_error' }, 500);
				currentStep = CODE_STEP;
				return json({
					completed: false,
					step: CODE_STEP,
					interaction: { current_step_id: 'code' }
				});
			}
			if (body.selected_handle === 'verified') {
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
		};
		// The choice goes, the hidden step fails once: the Flow waits on it, the code is still asked.
		await expect(post('totp_start', { email: 'person@example.com' })).rejects.toMatchObject({
			status: 303
		});
		expect(await view()).toMatchObject({ codeEntry: { kind: 'totp' } });

		hiddenFails = false;
		calls = [];
		expect(await post('totp_verify', { challenge: 'totp-1', code: '123456' })).toEqual({
			completed: true
		});
		expect(
			calls.filter((call) => call.path.endsWith('/submit')).map((call) => call.body.step_id)
		).toEqual(['hidden', 'code', 'done']);
		expect(submits().slice(1)).toEqual(['verified', 'completed']);
	});
});

describe('recordableUrl', () => {
	it("measures a destination as the store does (its JSON's UTF-8 bytes)", async () => {
		const { recordableUrl } = await import('../login-actions');
		expect(recordableUrl('/after')).toBe('/after');
		expect(recordableUrl(`/${'あ'.repeat(200)}`)).toBeNull();
		expect(recordableUrl(`/${'a'.repeat(400)}`)).toBe(`/${'a'.repeat(400)}`);
		expect(recordableUrl(null)).toBeNull();
	});
});

describe('a check whose lease ran out', () => {
	beforeEach(() => {
		currentStep = METHOD_STEP;
		withCodeStep = false;
		tenantMethods = { totp: { enabled: true } };
		methodRoutes();
	});

	it('passes on no session from an authenticator answer that came after another attempt took over', async () => {
		store.set({
			state: 'pending',
			data: {
				...store.txn.data,
				totp: {
					interactionId: 'int-1',
					choiceStepId: 'methods',
					challengeId: 'totp-1',
					expiresAt: Date.now() + 60_000
				}
			}
		});
		routes['/api/auth/totp/login/verify'] = () => {
			// While this answer is late, another post takes the check over (a new attempt).
			const op = store.operations.get('verify:totp:totp-1');
			if (op) store.operations.set('verify:totp:totp-1', { ...op, attempt: op.attempt + 1 });
			return json({ success: true, redirect_url: null }, 200, {
				'Set-Cookie': 'authrim_session=late; Path=/; HttpOnly; Secure; SameSite=Lax'
			});
		};
		const e = event({
			action: 'totp_verify',
			form: { txn: 'txn-1', csrf: 'csrf-1', op: OP, challenge: 'totp-1', code: '123456' }
		});
		const answer = await (
			actions as Record<string, (e: RequestEvent) => Promise<unknown>>
		).totp_verify(e);
		expect(answer).toMatchObject({ status: 409, data: { error: 'retry' } });
		expect(e.cookies.set).not.toHaveBeenCalledWith('authrim_session', 'late', expect.anything());
		expect(store.txn.data.signedIn).toBeUndefined();
	});
});

describe('a session try whose lease ran out', () => {
	it('passes on no session from an answer that came after another attempt took over', async () => {
		currentStep = CODE_STEP;
		store.set({
			state: 'verified',
			data: {
				...store.txn.data,
				checked: {
					interactionId: 'int-1',
					method: 'mail_otp',
					choiceStepId: 'select',
					artifact: 'artifact-1',
					verifier: 'v',
					expiresAt: Date.now() + 60_000,
					attemptKey: 'attempt-1',
					code: {
						interactionId: 'int-1',
						choiceStepId: 'select',
						email: 'person@example.com',
						maskedEmail: null,
						attemptId: 'attempt-1',
						verifier: 'v',
						sentAt: 0
					},
					tries: 0
				}
			}
		});
		routes['/api/v1/auth/direct/session'] = () => {
			const op = store.operations.get('session:attempt-1:0');
			if (op) store.operations.set('session:attempt-1:0', { ...op, attempt: op.attempt + 1 });
			return json({ ok: true }, 200, {
				'Set-Cookie': 'authrim_session=late; Path=/; HttpOnly; Secure; SameSite=Lax'
			});
		};
		const e = event({ action: 'continue', form: { txn: 'txn-1', csrf: 'csrf-1', op: OP } });
		const answer = await (
			actions as Record<string, (e: RequestEvent) => Promise<unknown>>
		).continue(e);
		expect(answer).toMatchObject({ status: 409, data: { error: 'retry' } });
		expect(e.cookies.set).not.toHaveBeenCalledWith('authrim_session', 'late', expect.anything());
	});
});

describe('a form drawn for another challenge, and a result not recorded', () => {
	beforeEach(() => {
		currentStep = METHOD_STEP;
		withCodeStep = false;
		tenantMethods = { totp: { enabled: true }, passkey: { enabled: true } };
		methodRoutes();
	});
	const pendingTotp = {
		interactionId: 'int-1',
		choiceStepId: 'methods',
		challengeId: 'totp-2',
		expiresAt: Date.now() + 60_000
	};

	it('checks no authenticator code from a page drawn for an older challenge', async () => {
		store.set({ state: 'pending', data: { ...store.txn.data, totp: pendingTotp } });
		await expect(
			post('totp_verify', { challenge: 'totp-1', code: '123456' })
		).rejects.toMatchObject({ status: 303 });
		expect(paths()).not.toContain('/api/auth/totp/login/verify');
		expect(store.txn.data.totp).toMatchObject({ challengeId: 'totp-2' });
	});

	it('sends no passkey assertion signed for an older challenge', async () => {
		store.set({
			state: 'pending',
			data: {
				...store.txn.data,
				passkey: {
					interactionId: 'int-1',
					choiceStepId: 'methods',
					challengeId: 'pk-2',
					verifier: 'v',
					options: {
						challenge: 'c'.repeat(43),
						rpId: 'id.example',
						timeout: 60000,
						userVerification: 'required',
						allowCredentials: []
					},
					expiresAt: Date.now() + 60_000
				}
			}
		});
		await expect(
			post('passkey_finish', { challenge: 'pk-1', credential: '{}' })
		).rejects.toMatchObject({ status: 303 });
		expect(paths()).not.toContain('/api/v1/auth/direct/passkey/login/finish');
	});

	it('passes on no session when the check could not be recorded', async () => {
		store.set({ state: 'pending', data: { ...store.txn.data, totp: pendingTotp } });
		store.binding.completeOperation.mockRejectedValueOnce(new Error('store unreachable'));
		const e = event({
			action: 'totp_verify',
			form: { txn: 'txn-1', csrf: 'csrf-1', op: OP, challenge: 'totp-2', code: '123456' }
		});
		const answer = await (
			actions as Record<string, (e: RequestEvent) => Promise<unknown>>
		).totp_verify(e);
		expect(answer).toMatchObject({ status: 409, data: { error: 'retry' } });
		expect(e.cookies.set).not.toHaveBeenCalledWith('authrim_session', 't1', expect.anything());
	});

	it('passes on no session when the check throws after its answer set one', async () => {
		store.set({ state: 'pending', data: { ...store.txn.data, totp: pendingTotp } });
		store.binding.completeOperation.mockImplementationOnce(async () => {
			throw new Error('unexpected');
		});
		routes['/api/auth/totp/login/verify'] = () =>
			new Response('not json', {
				status: 200,
				headers: { 'Set-Cookie': 'authrim_session=t1; Path=/; HttpOnly; Secure; SameSite=Lax' }
			});
		const e = event({
			action: 'totp_verify',
			form: { txn: 'txn-1', csrf: 'csrf-1', op: OP, challenge: 'totp-2', code: '123456' }
		});
		await (actions as Record<string, (e: RequestEvent) => Promise<unknown>>).totp_verify(e);
		expect(e.cookies.set).not.toHaveBeenCalledWith('authrim_session', 't1', expect.anything());
	});
});

describe('a long credential ID', () => {
	it("takes a security key's longest credential ID (1,023 bytes) in the options and the assertion", async () => {
		const { readLitePasskeyCredential, readLitePasskeyOptions } = await import('../totp-passkey');
		const id = 'A'.repeat(1364);
		expect(
			readLitePasskeyOptions({
				challenge: 'c'.repeat(43),
				rpId: 'id.example',
				allowCredentials: [{ id }]
			})?.allowCredentials
		).toEqual([{ id, transports: [] }]);
		const credential = readLitePasskeyCredential(
			JSON.stringify({
				id,
				rawId: id,
				type: 'public-key',
				response: { authenticatorData: 'YQ', clientDataJSON: 'Yg', signature: 'Yw' }
			})
		);
		expect(credential?.id).toBe(id);
	});
});
