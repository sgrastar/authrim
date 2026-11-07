/**
 * The lite sign-up page (PR6a): the step page for a sign-up (route `/__lite/signup`), its
 * registration Flow, a sign-up by email code with the profile its screen stores, and an
 * invitation. The transaction store is the sign-in tests' model.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { actions, load } from '../../../../routes/__lite/signup/+page.server';

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

let calls: Array<{
	path: string;
	search?: string;
	body: Record<string, unknown>;
	headers: Headers;
}>;
let routes: Record<string, Handler>;
let currentStep: Record<string, unknown>;
let store: ReturnType<typeof fakeStore>;
let tenantMethods: Record<string, unknown>;
/** Whether the contract has a step of its own for the code (CODE_STEP). */
let withCodeStep: boolean;
/** Cookies the browser sends besides the lite binding (a session made by an earlier post). */
let browserCookies: Record<string, string>;
/** The page's route (the sign-up page, unless a test says). */
let routeId: string;

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
	let made = false;
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
		// The first call makes the transaction (its purpose, its data); later ones reuse it.
		create: vi.fn(async (call: { purpose: string; data?: Record<string, unknown> }) => {
			const fresh = !made;
			if (fresh) {
				made = true;
				txn = {
					...txn,
					bound: { ...txn.bound, purpose: call.purpose },
					data: { ...txn.data, ...(call.data ?? {}) }
				};
			}
			return { ok: true, txn: view(), reused: !fresh };
		}),
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
		route: { id: routeId },
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
							search: parsed.search,
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
beforeEach(() => {
	calls = [];
	currentStep = SELECT_STEP;
	store = fakeStore();
	tenantMethods = { emailCode: { enabled: true }, guest: { enabled: true } };
	withCodeStep = true;
	browserCookies = {};
	routeId = '/__lite/signup';
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

/** A sign-up screen: the address, a name, a profile part, one kept off the profile, the code. */
const SIGNUP_STEP = {
	id: 'signup',
	source_node_id: 'n-signup',
	component: 'registration_method_selector',
	render: true,
	config: {
		screen: {
			display_name: 'Create your account',
			fields: [
				{ field: 'email', label: 'Email', required: true },
				{ field: 'name', label: 'Name' },
				{ field: 'company', label: 'Company', required: true },
				{ field: 'referral', label: 'How did you hear?', store_to_profile: false },
				{ block_type: 'checkbox', field: 'newsletter', label: 'News' },
				{ block_type: 'auth_widget', field: 'm', label: 'Send', auth_method: 'mail_otp' }
			]
		}
	}
};
const INVITE = 'a'.repeat(64);
const sends = () => calls.filter((call) => call.path === '/api/v1/auth/direct/email-code/send');

describe('the sign-up page', () => {
	beforeEach(() => {
		currentStep = SIGNUP_STEP;
		tenantMethods = { emailCode: { enabled: true, loginEnabled: false, signupEnabled: true } };
		routes['/api/v1/invitations/validate'] = () =>
			json({
				valid: true,
				tenant_id: 'default',
				tenant_name: 'Acme',
				invited_email: 'invited@example.com',
				email_verification_required: true
			});
	});

	it('starts a registration Flow for a sign-up transaction, with a sign-up proof', async () => {
		// A transaction with no Flow yet: the page starts one.
		store.set({ data: {} });
		const page = await view();
		expect(page.decision).toMatchObject({ kind: 'screen' });
		const start = calls.find((call) => call.path === '/api/v1/login/interactions/start');
		expect(start?.body.flow_kind).toBe('registration');
		expect(store.binding.create.mock.calls[0][0]).toMatchObject({ purpose: 'signup' });
		expect(store.txn.bound.purpose).toBe('signup');
		expect(page.pow).not.toBeNull();
		const proof = calls.find((call) =>
			call.path.startsWith('/api/auth/human-verification/pow-challenge')
		);
		expect(proof?.search).toBe('?action=signup');
	});

	it('sends the code as a sign-up, with the profile the screen stores and nothing else', async () => {
		await view();
		await post('send_code', {
			email: 'new@example.com',
			name: 'Kai Doe',
			company: 'Acme',
			referral: 'a friend',
			human_verification_response: 'p'
		}).catch((thrown: unknown) => thrown);
		const [send] = sends();
		expect(send.headers.get('X-Authrim-Human-Verification-Action')).toBe('signup');
		expect(send.body).toMatchObject({
			email: 'new@example.com',
			display_name: 'Kai Doe',
			custom_fields: { company: 'Acme', newsletter: 'false' }
		});
		// Kept off the profile, and the fixed attributes: never custom fields.
		expect(send.body.custom_fields).not.toHaveProperty('referral');
		expect(send.body.custom_fields).not.toHaveProperty('email');
		expect(send.body.custom_fields).not.toHaveProperty('name');
		expect(send.body).not.toHaveProperty('invite_token');
	});

	it('sends nothing while a required part is not answered', async () => {
		await view();
		const answer = (await post('send_code', {
			email: 'new@example.com',
			human_verification_response: 'p',
			'step-key': 'int-1:signup'
		})) as { status: number; data: Record<string, unknown> };
		expect(answer.status).toBe(400);
		expect(answer.data).toMatchObject({
			error: 'answer_required',
			answersEcho: { stepKey: 'int-1:signup', answers: { email: 'new@example.com' } }
		});
		expect(sends()).toEqual([]);
	});

	it('names the account from the address when the screen asks no name', async () => {
		await view();
		await post('send_code', {
			email: 'new@example.com',
			company: 'Acme',
			human_verification_response: 'p'
		}).catch((thrown: unknown) => thrown);
		expect(sends()[0].body.display_name).toBe('new');
	});

	it('takes an invitation: checked first, kept, offered and sent with the code and its resend', async () => {
		// The email code signs in too (a code sent again goes to the account the first one made).
		tenantMethods = { emailCode: { enabled: true, loginEnabled: true, signupEnabled: true } };
		const page = await view(`invite_token=${INVITE}`);
		expect(page.invitedEmail).toBe('invited@example.com');
		expect(page.invitation).toContain('Acme');
		expect(store.txn.data.invite).toMatchObject({ token: INVITE, tenantId: 'default' });
		await post(
			'send_code',
			{
				email: 'invited@example.com',
				company: 'Acme',
				newsletter: 'true',
				human_verification_response: 'p'
			},
			`invite_token=${INVITE}`
		).catch((thrown: unknown) => thrown);
		expect(sends()[0].body).toMatchObject({
			invite_token: INVITE,
			custom_fields: { company: 'Acme', newsletter: 'true' }
		});
		// A profile is kept with the first code only (ar-auth): such a sign-up is not sent again,
		// and its code entry needs no proof (drawn even when none can be issued).
		routes['/api/auth/human-verification/pow-challenge'] = () => json({ error: 'busy' }, 429);
		const entry = await view(`invite_token=${INVITE}`);
		expect(entry.codeEntry).toMatchObject({ resendable: false });
		expect(entry.pow).toBeNull();
	});

	it('sends a code again as a sign-up, with the invitation, when it has no profile', async () => {
		tenantMethods = { emailCode: { enabled: true, loginEnabled: true, signupEnabled: true } };
		currentStep = {
			...SIGNUP_STEP,
			config: {
				screen: {
					fields: [
						{ field: 'email', label: 'Email', required: true },
						{ field: 'name', label: 'Name' },
						{ block_type: 'auth_widget', field: 'm', label: 'Send', auth_method: 'mail_otp' }
					]
				}
			}
		};
		await view(`invite_token=${INVITE}`);
		await post(
			'send_code',
			{ email: 'invited@example.com', name: 'Kai', human_verification_response: 'p' },
			`invite_token=${INVITE}`
		).catch((thrown: unknown) => thrown);
		expect((await view(`invite_token=${INVITE}`)).codeEntry).toMatchObject({ resendable: true });
		const code = store.txn.data.code as Record<string, unknown>;
		store.set({ data: { ...store.txn.data, code: { ...code, sentAt: 0 } } });
		await post('resend', { human_verification_response: 'p' }, `invite_token=${INVITE}`).catch(
			(thrown: unknown) => thrown
		);
		const resent = sends()[1];
		expect(resent.headers.get('X-Authrim-Human-Verification-Action')).toBe('signup');
		expect(resent.body).toMatchObject({
			invite_token: INVITE,
			display_name: 'Kai',
			custom_fields: {}
		});
	});

	it('sends no code again where ar-auth would not (the email code signs up only)', async () => {
		await view();
		await post('send_code', {
			email: 'new@example.com',
			company: 'Acme',
			human_verification_response: 'p'
		}).catch((thrown: unknown) => thrown);
		const page = await view();
		expect(page.codeEntry).toMatchObject({ kind: 'mail_otp', resendable: false });
		const code = store.txn.data.code as Record<string, unknown>;
		store.set({ data: { ...store.txn.data, code: { ...code, sentAt: 0 } } });
		await expect(post('resend', { human_verification_response: 'p' })).resolves.toMatchObject({
			status: 409
		});
		expect(sends()).toHaveLength(1);
		expect(store.txn.data.code).toMatchObject({ attemptId: code.attemptId });
	});

	it('stops at an invitation it cannot take: unknown, malformed, or of another tenant', async () => {
		routes['/api/v1/invitations/validate'] = () => json({ error: 'not_found' }, 404);
		expect(await view(`invite_token=${INVITE}`)).toMatchObject({ page: 'error' });
		expect(await view('invite_token=short')).toMatchObject({ page: 'error' });
		expect(await view('invite_token=')).toMatchObject({ page: 'error' });
		expect(await view(`invite_token=${'a'.repeat(3000)}`)).toMatchObject({ page: 'error' });
		routes['/api/v1/invitations/validate'] = () =>
			json({ valid: true, tenant_id: 'other', tenant_name: 'Other', invited_email: null });
		expect(await view(`invite_token=${INVITE}`)).toMatchObject({ page: 'error' });
		expect(calls.some((call) => call.path === '/api/v1/login/interactions/start')).toBe(false);
	});

	it('does not draw a sign-up by passkey yet, and leaves out the authenticator half', async () => {
		currentStep = {
			...SIGNUP_STEP,
			config: {
				screen: {
					fields: [
						{ field: 'email', label: 'Email', required: true },
						{ block_type: 'auth_widget', field: 'p', label: 'Passkey', auth_method: 'passkey' }
					]
				}
			}
		};
		tenantMethods = { emailCode: { enabled: true }, passkey: { enabled: true } };
		expect((await view()).decision).toEqual({ kind: 'unsupported', reasons: ['method:passkey'] });
		currentStep = {
			...SIGNUP_STEP,
			config: {
				screen: {
					fields: [
						{ field: 'email', label: 'Email', required: true },
						{ block_type: 'auth_widget', field: 'x', label: 'Code', auth_method: 'mail_otp_totp' }
					]
				}
			}
		};
		tenantMethods = { emailCode: { enabled: true }, totp: { enabled: true } };
		expect((await view()).available).toEqual({ mailOtp: true, totp: false });
	});

	it('reads the methods by their sign-up switch: none left, no screen to go on from', async () => {
		tenantMethods = { emailCode: { enabled: true, loginEnabled: true, signupEnabled: false } };
		expect((await view()).decision).toEqual({ kind: 'unsupported', reasons: ['no_method'] });
		// An email-or-authenticator part is its email half alone on a sign-up.
		currentStep = {
			...SIGNUP_STEP,
			config: {
				screen: {
					fields: [
						{ field: 'email', label: 'Email', required: true },
						{ block_type: 'auth_widget', field: 'x', label: 'Code', auth_method: 'mail_otp_totp' }
					]
				}
			}
		};
		tenantMethods = {
			emailCode: { enabled: true, signupEnabled: false },
			totp: { enabled: true, signupEnabled: true }
		};
		expect((await view()).decision).toEqual({ kind: 'unsupported', reasons: ['no_method'] });
	});

	it('checks an invitation once: the use its code reserved does not stop the page', async () => {
		await view(`invite_token=${INVITE}`);
		await post(
			'send_code',
			{ email: 'invited@example.com', company: 'Acme', human_verification_response: 'p' },
			`invite_token=${INVITE}`
		).catch((thrown: unknown) => thrown);
		// The last use is reserved now: a new check would find none left.
		routes['/api/v1/invitations/validate'] = () => json({ error: 'not_found' }, 404);
		const page = await view(`invite_token=${INVITE}`);
		expect(page.page).toBe('step');
		expect(page.codeEntry).toMatchObject({ kind: 'mail_otp' });
	});

	it('sends no answer for a part the page did not draw', async () => {
		currentStep = {
			...SIGNUP_STEP,
			config: {
				screen: {
					fields: [
						...SIGNUP_STEP.config.screen.fields.filter((field) => field.field !== 'newsletter'),
						{
							block_type: 'checkbox',
							field: 'beta',
							label: 'Beta',
							required: true,
							display_condition: { mode: 'feature_enabled', feature: 'passkey' }
						}
					]
				}
			}
		};
		await view();
		await post('send_code', {
			email: 'new@example.com',
			company: 'Acme',
			human_verification_response: 'p'
		}).catch((thrown: unknown) => thrown);
		expect(sends()[0].body.custom_fields).toEqual({ company: 'Acme' });
	});

	it('starts no sign-in of another kind from the sign-up page, whatever its form posts', async () => {
		currentStep = {
			...SIGNUP_STEP,
			config: {
				screen: {
					fields: [
						{ field: 'email', label: 'Email', required: true },
						{ block_type: 'auth_widget', field: 'x', label: 'Code', auth_method: 'mail_otp_totp' }
					]
				}
			}
		};
		tenantMethods = { emailCode: { enabled: true }, totp: { enabled: true } };
		await view();
		await expect(
			post('totp_start', { email: 'new@example.com', human_verification_response: 'p' })
		).resolves.toMatchObject({ status: 409 });
		await expect(
			post('passkey_start', { human_verification_response: 'p' })
		).resolves.toMatchObject({ status: 409 });
		await expect(post('guest', { human_verification_response: 'p' })).resolves.toMatchObject({
			status: 409
		});
		expect(calls.some((call) => call.path.startsWith('/api/auth/totp'))).toBe(false);
		expect(calls.some((call) => call.path.includes('/passkey/'))).toBe(false);
		expect(calls.some((call) => call.path === '/api/auth/guest/login')).toBe(false);
	});

	it('does not draw two parts posted under one name', async () => {
		currentStep = {
			...SIGNUP_STEP,
			config: {
				screen: {
					fields: [
						...SIGNUP_STEP.config.screen.fields,
						{ block_type: 'select', field: 'company', label: 'Again', options: [{ value: 'x' }] }
					]
				}
			}
		};
		expect((await view()).decision).toEqual({ kind: 'unsupported', reasons: ['field_name'] });
	});

	it('leaves out an external part whose providers do not sign up', async () => {
		currentStep = {
			...SIGNUP_STEP,
			config: {
				screen: {
					fields: [
						...SIGNUP_STEP.config.screen.fields,
						{ block_type: 'auth_widget', field: 's', label: 'Social', auth_method: 'external_idp' }
					]
				}
			}
		};
		tenantMethods = {
			emailCode: { enabled: true, signupEnabled: true },
			external: {
				enabled: true,
				providers: [
					{ id: 'google', name: 'Google', enabled: true, loginEnabled: true, signupEnabled: false }
				]
			}
		};
		const page = (await view()) as {
			decision: { kind: string; fields: Array<{ authMethod: string | null }> };
		};
		expect(page.decision.kind).toBe('screen');
		expect(page.decision.fields.some((field) => field.authMethod === 'external_idp')).toBe(false);
	});

	it('takes no post for a transaction made for another page', async () => {
		routeId = '/__lite/login';
		await view();
		routeId = '/__lite/signup';
		await expect(
			post('send_code', {
				email: 'new@example.com',
				company: 'Acme',
				human_verification_response: 'p'
			})
		).resolves.toMatchObject({ status: 403 });
		expect(sends()).toEqual([]);
	});
});
