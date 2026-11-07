/**
 * The lite re-authentication page (PR7a, route `/__lite/reauth`): no Flow; the methods the tenant
 * allows for re-authentication; a transaction bound by ar-auth to the challenge's user and session
 * (modelled here: made only for the browser's session `s-a`), and every post refused once the
 * browser has another session.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { actions, load } from '../../../../routes/__lite/reauth/+page.server';

type Handler = (body: Record<string, unknown>, init: RequestInit) => Response;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers }
	});

let calls: Array<{ path: string; body: Record<string, unknown>; headers: Headers }>;
let routes: Record<string, Handler>;
let store: ReturnType<typeof fakeStore>;
let tenantMethods: Record<string, unknown>;
let sessionCookie: string | null;
/** Whether the session `s-a` is still live at ar-auth (ended, it is read as none). */
let sessionLive: boolean;

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
			if (call.purpose !== 'reauth') return { ok: false, reason: 'unsupported_purpose' };
			if (call.sessionId !== 's-a') return { ok: false, reason: 'session_invalid' };
			if (!txn) {
				txn = {
					id: 'txn-1',
					bound: {
						tenantId: 'default',
						publicOrigin: 'https://id.example',
						purpose: 'reauth',
						clientId: (call.clientId as string | null) ?? null,
						challengeId: call.challengeId as string,
						returnTo: null,
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

const CHALLENGE = 'ch-reauth';
function event(init: { action?: string; form?: Record<string, string> } = {}) {
	const search = `challenge_id=${CHALLENGE}`;
	const url = new URL(
		`https://id.example/reauth?${search}${init.action ? `&/${init.action}` : ''}`
	);
	const cookies = new Map<string, string>([['__Host-authrim_lite', 'b'.repeat(43)]]);
	if (sessionCookie) cookies.set('authrim_session', sessionCookie);
	const body = init.form ? new URLSearchParams(init.form).toString() : undefined;
	return {
		url,
		route: { id: '/__lite/reauth' },
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
const post = (action: string, form: Record<string, string> = {}) =>
	(actions as Record<string, (e: RequestEvent) => Promise<unknown>>)[action](
		event({ action, form: { txn: 'txn-1', csrf: 'csrf-1', op: OP, ...form } })
	);
const view = () =>
	(load as unknown as (e: RequestEvent) => Promise<Record<string, unknown>>)(event());
const paths = () => calls.map((call) => call.path);
const done = (thrown: unknown) => thrown;

beforeEach(() => {
	calls = [];
	store = fakeStore();
	sessionCookie = 's-a';
	sessionLive = true;
	tenantMethods = {
		emailCode: { enabled: true, reauthEnabled: true },
		totp: { enabled: true, reauthEnabled: true },
		passkey: { enabled: true, reauthEnabled: true }
	};
	routes = {
		'/auth/login-challenge': () =>
			json({ challenge_id: CHALLENGE, client: { client_id: 'client-1', client_name: 'App' } }),
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
			json({ attempt_id: 'attempt-1', expires_in: 300, masked_email: 'u***@example.com' }),
		'/api/v1/auth/direct/email-code/verify': (body) =>
			body.code === '123456'
				? json({ direct_auth_artifact: 'artifact-1', expires_in: 60 })
				: json({ error: 'invalid_code' }, 400),
		'/api/v1/auth/direct/session': () =>
			json({ redirect_url: 'https://id.example/authorize?reauth_confirmed=1' }, 200, {
				'Set-Cookie': 'authrim_session=s-new; Path=/; HttpOnly; Secure; SameSite=Lax'
			})
	};
});

describe('the lite re-authentication page', () => {
	it("draws the tenant's re-authentication methods for the challenge's session", async () => {
		tenantMethods = {
			emailCode: { enabled: true, reauthEnabled: false },
			totp: { enabled: false, reauthEnabled: true },
			passkey: { enabled: true }
		};
		const page = await view();
		expect(store.binding.create).toHaveBeenCalledWith(
			expect.objectContaining({
				purpose: 'reauth',
				challengeId: CHALLENGE,
				clientId: 'client-1',
				sessionId: 's-a'
			})
		);
		expect(page).toMatchObject({
			page: 'reauth',
			clientName: 'App',
			methods: { emailCode: false, totp: true, passkey: true },
			code: null,
			totp: null,
			passkey: null
		});
		expect(page.pow).not.toBeNull();
	});

	it("draws an error, never a method, for a browser without the challenge user's session", async () => {
		sessionCookie = null;
		expect(await view()).toMatchObject({ page: 'error' });
		sessionCookie = 's-other';
		expect(await view()).toMatchObject({ page: 'error' });
		expect(paths()).not.toContain('/api/auth/human-verification/pow-challenge');
	});

	it('re-authenticates by email code: the address given, the request continued', async () => {
		await view();
		await post('reauth_send', {
			email: 'User@Example.com',
			human_verification_response: 'proof'
		}).catch(done);
		const send = calls.find((call) => call.path === '/api/v1/auth/direct/email-code/send');
		expect(send?.body).toMatchObject({
			email: 'user@example.com',
			authorization_challenge_id: CHALLENGE,
			human_verification_response: 'proof'
		});
		expect(send?.body).not.toHaveProperty('runtime_interaction_id');
		expect(send?.headers.has('X-Authrim-Human-Verification-Action')).toBe(false);
		const page = await view();
		expect(page).toMatchObject({ code: { maskedEmail: 'u***@example.com', attempt: 'attempt-1' } });
		expect(page.pow).toBeNull();

		// A wrong code is a try; the right one makes the session and relays to the continuation.
		await expect(
			post('reauth_verify', { attempt: 'attempt-1', check: '0', code: '000000' })
		).resolves.toMatchObject({ status: 400, data: { error: 'code_invalid' } });
		expect(store.txn.data.reauthCode).toMatchObject({ tries: 1, checks: 1 });
		// The same form posted again (a late double submit): the page, no second try.
		await expect(
			post('reauth_verify', { attempt: 'attempt-1', check: '0', code: '000000' })
		).rejects.toMatchObject({ status: 303 });
		expect(store.txn.data.reauthCode).toMatchObject({ tries: 1, checks: 1 });
		// A check ar-auth could not make: no try, and the next form checks the code again.
		const verify = routes['/api/v1/auth/direct/email-code/verify'];
		routes['/api/v1/auth/direct/email-code/verify'] = () => json({ error: 'unavailable' }, 503);
		await expect(
			post('reauth_verify', { attempt: 'attempt-1', check: '1', code: '123456' })
		).resolves.toMatchObject({ status: 409, data: { error: 'retry' } });
		expect(store.txn.data.reauthCode).toMatchObject({ tries: 1, checks: 2 });
		routes['/api/v1/auth/direct/email-code/verify'] = verify;
		expect(await view()).toMatchObject({ code: { check: '2' } });
		const answer = await post('reauth_verify', {
			attempt: 'attempt-1',
			check: '2',
			code: '123456',
			op: 'p'.repeat(22)
		});
		expect(answer).toEqual({ completed: true });
		const session = calls.find((call) => call.path === '/api/v1/auth/direct/session');
		expect(session?.body).toMatchObject({
			direct_auth_artifact: 'artifact-1',
			authorization_challenge_id: CHALLENGE,
			defer_authorization_continuation: false
		});
		expect(store.txn.state).toBe('completed');
		expect(store.txn.data.completedTo).toBe('https://id.example/authorize?reauth_confirmed=1');
	});

	it('re-authenticates with an authenticator: the challenge only, never an identifier', async () => {
		routes['/api/auth/totp/login/start'] = () => json({ challenge_id: 'totp-1', expires_in: 300 });
		routes['/api/auth/totp/login/verify'] = (body) =>
			body.code === '123456'
				? json({ success: true, redirect_url: 'https://id.example/authorize?reauth_confirmed=1' })
				: json({ error: 'invalid_code' }, 400);
		await view();
		await post('reauth_totp_start', { human_verification_response: 'proof' }).catch(done);
		const start = calls.find((call) => call.path === '/api/auth/totp/login/start');
		expect(start?.body).toEqual({
			authorization_challenge_id: CHALLENGE,
			human_verification_response: 'proof'
		});
		expect(await view()).toMatchObject({ totp: { challenge: 'totp-1' } });
		// A wrong code spends the challenge: a new start is the way on.
		await expect(
			post('reauth_totp_verify', { challenge: 'totp-1', code: '000000' })
		).resolves.toMatchObject({ status: 400, data: { error: 'totp_invalid' } });
		expect(store.txn.data.reauthTotp).toBeUndefined();
		routes['/api/auth/totp/login/start'] = () => json({ challenge_id: 'totp-2', expires_in: 300 });
		await post('reauth_totp_start', {
			human_verification_response: 'proof2',
			op: 'q'.repeat(22)
		}).catch(done);
		const answer = await post('reauth_totp_verify', {
			challenge: 'totp-2',
			code: '123456',
			op: 'r'.repeat(22)
		});
		expect(answer).toEqual({ completed: true });
		const verify = calls.filter((call) => call.path === '/api/auth/totp/login/verify').at(-1);
		expect(verify?.body).toMatchObject({
			authorization_challenge_id: CHALLENGE,
			defer_authorization_continuation: false
		});
	});

	it('re-authenticates with a passkey: its ceremony, then the session', async () => {
		routes['/api/v1/auth/direct/passkey/login/start'] = () =>
			json({
				challenge_id: 'pk-1',
				options: {
					challenge: 'c'.repeat(43),
					rpId: 'id.example',
					timeout: 60000,
					userVerification: 'required',
					allowCredentials: []
				}
			});
		routes['/api/v1/auth/direct/passkey/login/finish'] = () =>
			json({ direct_auth_artifact: 'artifact-pk', expires_in: 60 });
		await view();
		await post('reauth_passkey_start', { human_verification_response: 'proof' }).catch(done);
		const start = calls.find((call) => call.path === '/api/v1/auth/direct/passkey/login/start');
		expect(start?.body).toMatchObject({ authorization_challenge_id: CHALLENGE });
		expect(start?.headers.has('X-Authrim-Interaction-Id')).toBe(false);
		const page = (await view()) as { passkey: { challenge: string } };
		expect(page.passkey.challenge).toBe('pk-1');
		const credential = JSON.stringify({
			id: 'Y3JlZA',
			rawId: 'Y3JlZA',
			type: 'public-key',
			response: { authenticatorData: 'YQ', clientDataJSON: 'e30', signature: 'c2ln' }
		});
		const answer = await post('reauth_passkey_finish', {
			challenge: 'pk-1',
			credential,
			op: 'f'.repeat(22)
		});
		expect(answer).toEqual({ completed: true });
		expect(store.txn.state).toBe('completed');
	});

	it('takes an expired start away with the next one (never drawn or given up over it)', async () => {
		routes['/api/auth/totp/login/start'] = () => json({ challenge_id: 'totp-1', expires_in: 300 });
		routes['/api/v1/auth/direct/passkey/login/start'] = () =>
			json({
				challenge_id: 'pk-2',
				options: {
					challenge: 'c'.repeat(43),
					rpId: 'id.example',
					timeout: 60000,
					userVerification: 'required',
					allowCredentials: []
				}
			});
		await view();
		await post('reauth_totp_start', { human_verification_response: 'p' }).catch(done);
		store.set({
			data: {
				...store.txn.data,
				reauthTotp: { ...(store.txn.data.reauthTotp as object), expiresAt: Date.now() - 1 }
			}
		});
		await post('reauth_passkey_start', {
			human_verification_response: 'p2',
			op: 'k'.repeat(22)
		}).catch(done);
		expect(store.txn.data.reauthTotp).toBeUndefined();
		expect(await view()).toMatchObject({ underway: 'pk-2' });
		// The expired authenticator's form gives up nothing; the passkey's own gives it up.
		await post('reauth_back', { target: 'totp-1' }).catch(done);
		expect(store.txn.data.reauthPasskey).toMatchObject({ challengeId: 'pk-2' });
		await post('reauth_back', { target: 'pk-2' }).catch(done);
		expect(store.txn.data.reauthPasskey).toBeUndefined();
	});

	it('acts on nothing once the browser has another session (a sign-in in another tab)', async () => {
		await view();
		sessionCookie = 's-b';
		await expect(
			post('reauth_send', { email: 'user@example.com', human_verification_response: 'p' })
		).resolves.toMatchObject({ status: 409, data: { error: 'session_changed' } });
		sessionCookie = null;
		await expect(post('reauth_totp_start', {})).resolves.toMatchObject({
			status: 409,
			data: { error: 'session_changed' }
		});
		// The same session, ended at ar-auth meanwhile (signed out elsewhere, expired).
		sessionCookie = 's-a';
		sessionLive = false;
		await expect(post('reauth_totp_start', {})).resolves.toMatchObject({
			status: 409,
			data: { error: 'session_changed' }
		});
		expect(paths()).not.toContain('/api/v1/auth/direct/email-code/send');
		expect(paths()).not.toContain('/api/auth/totp/login/start');
	});

	it('starts no method the tenant has off for re-authentication, nor one over another', async () => {
		tenantMethods = { emailCode: { enabled: true, reauthEnabled: false } };
		await view();
		await expect(
			post('reauth_send', { email: 'user@example.com', human_verification_response: 'p' })
		).resolves.toMatchObject({ status: 409, data: { restart: true } });
		expect(paths()).not.toContain('/api/v1/auth/direct/email-code/send');

		tenantMethods = { emailCode: { enabled: true }, totp: { enabled: true } };
		await post('reauth_send', {
			email: 'user@example.com',
			human_verification_response: 'p'
		}).catch(done);
		await expect(post('reauth_totp_start', { op: 't'.repeat(22) })).rejects.toMatchObject({
			status: 303
		});
		expect(paths()).not.toContain('/api/auth/totp/login/start');
		// Another way: only what the form was drawn for (an older page's form gives up nothing).
		await post('reauth_back', { target: 'attempt-old' }).catch(done);
		expect(store.txn.data.reauthCode).toMatchObject({ attemptId: 'attempt-1' });
		await post('reauth_back', { target: 'attempt-1' }).catch(done);
		expect(store.txn.data.reauthCode).toBeUndefined();
	});
});
