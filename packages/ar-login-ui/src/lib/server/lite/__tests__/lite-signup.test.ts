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
		// Its code is sent again as the sign-up (ar-auth keeps its profile): the entry posts a proof.
		const entry = await view(`invite_token=${INVITE}`);
		expect(entry.codeEntry).toMatchObject({ kind: 'mail_otp' });
		expect(entry.pow).not.toBeNull();
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
		expect((await view(`invite_token=${INVITE}`)).codeEntry).toMatchObject({ kind: 'mail_otp' });
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

	it("sends a sign-up's code again, with a profile, where the email code only signs up", async () => {
		// ar-auth takes a resend of the same sign-up (client, channel, challenge, interaction) as
		// that sign-up, with the profile it kept (#766): no sign-in switch is needed.
		await view();
		await post('send_code', {
			email: 'new@example.com',
			company: 'Acme',
			human_verification_response: 'p'
		}).catch((thrown: unknown) => thrown);
		const page = await view();
		expect(page.codeEntry).toMatchObject({ kind: 'mail_otp' });
		expect(page.pow).not.toBeNull();
		const code = store.txn.data.code as Record<string, unknown>;
		store.set({ data: { ...store.txn.data, code: { ...code, sentAt: 0 } } });
		routes['/api/v1/auth/direct/email-code/send'] = () =>
			json({ attempt_id: 'attempt-2', expires_in: 300, masked_email: 'n***@example.com' });
		await post('resend', { human_verification_response: 'p2' }).catch((thrown: unknown) => thrown);
		expect(sends()).toHaveLength(2);
		expect(sends()[1].body).toMatchObject({
			email: 'new@example.com',
			runtime_interaction_id: sends()[0].body.runtime_interaction_id,
			human_verification_response: 'p2'
		});
		expect(sends()[1].headers.get('X-Authrim-Human-Verification-Action')).toBe('signup');
		expect(store.txn.data.code).toMatchObject({ attemptId: 'attempt-2' });
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

	it('signs up with a passkey: registers it with the profile, then makes the session', async () => {
		currentStep = {
			...SIGNUP_STEP,
			config: {
				screen: {
					fields: [
						{ field: 'email', label: 'Email', required: true },
						{ field: 'company', label: 'Company' },
						{ block_type: 'auth_widget', field: 'p', label: 'Passkey', auth_method: 'passkey' }
					]
				}
			}
		};
		tenantMethods = { passkey: { enabled: true, signupEnabled: true } };
		const creation = {
			rp: { id: 'id.example', name: 'Authrim' },
			user: { id: 'dXNlci0x', name: 'new@example.com', displayName: 'new' },
			challenge: 'Y2hhbGxlbmdl',
			pubKeyCredParams: [
				{ type: 'public-key', alg: -7 },
				{ type: 'public-key', alg: -257 }
			],
			timeout: 60000,
			excludeCredentials: [],
			authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
			attestation: 'none'
		};
		routes['/api/v1/auth/direct/passkey/signup/start'] = () =>
			json({ challenge_id: 'pk-1', options: creation });
		routes['/api/v1/auth/direct/passkey/signup/finish'] = () =>
			json({ direct_auth_artifact: 'artifact-pk', expires_in: 60 });
		routes['/api/v1/login/interactions/int-1/submit'] = (body) =>
			body.selected_handle === 'passkey'
				? json({ completed: true, output: { redirect_url: 'https://id.example/after' } })
				: json({ error: 'invalid_handle' }, 400);
		await view();
		await post('passkey_start', {
			email: 'new@example.com',
			company: 'Acme',
			human_verification_response: 'p'
		}).catch((thrown: unknown) => thrown);
		const start = calls.find((call) => call.path === '/api/v1/auth/direct/passkey/signup/start');
		expect(start?.body).toMatchObject({
			email: 'new@example.com',
			display_name: 'new',
			custom_fields: { company: 'Acme' },
			code_challenge_method: 'S256',
			human_verification_response: 'p'
		});
		// The ceremony registers (creation options), never signs in.
		const page = (await view()) as { passkey: { registration: unknown; options: unknown } };
		expect(page.passkey.options).toBeNull();
		expect(page.passkey.registration).toMatchObject({ rp: { id: 'id.example' } });
		const registration = {
			id: 'Y3JlZA',
			rawId: 'Y3JlZA',
			type: 'public-key',
			response: { clientDataJSON: 'e30', attestationObject: 'o2Nm', transports: ['internal'] }
		};
		await post('passkey_finish', {
			challenge: 'pk-1',
			credential: JSON.stringify(registration)
		}).catch((thrown: unknown) => thrown);
		const finish = calls.find((call) => call.path === '/api/v1/auth/direct/passkey/signup/finish');
		expect(finish?.body).toMatchObject({
			challenge_id: 'pk-1',
			credential: { id: 'Y3JlZA', response: { attestationObject: 'o2Nm' } }
		});
		expect(calls.some((call) => call.path === '/api/v1/auth/direct/session')).toBe(true);
		expect(
			calls.filter((call) => call.path.endsWith('/submit')).map((call) => call.body.selected_handle)
		).toEqual(['passkey']);
	});

	it('signs up with an authenticator: shows its secret, activates it, shows its backup codes once', async () => {
		currentStep = {
			...SIGNUP_STEP,
			config: {
				screen: {
					fields: [
						{ field: 'email', label: 'Email', required: true },
						{ block_type: 'auth_widget', field: 't', label: 'App', auth_method: 'totp' }
					]
				}
			}
		};
		withCodeStep = false;
		tenantMethods = { totp: { enabled: true, signupEnabled: true } };
		routes['/api/auth/totp/signup/options'] = () =>
			json(
				{
					challenge_id: 'totp-s1',
					expires_in: 600,
					secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
					otpauth_uri: 'otpauth://totp/Authrim:new%40example.com?secret=JBSWY3DPEHPK3PXP'
				},
				201
			);
		routes['/api/auth/totp/signup/activate'] = () =>
			json({ success: true, backup_codes: ['ABCD-EFGH-JKLM', 'NPQR-STUV-WXYZ'] }, 200, {
				'Set-Cookie': 'authrim_session=t1; Path=/; HttpOnly; Secure; SameSite=Lax'
			});
		routes['/api/v1/login/interactions/int-1/submit'] = (body) =>
			body.selected_handle === 'totp'
				? json({ completed: true, output: { redirect_url: 'https://id.example/after' } })
				: json({ error: 'invalid_handle' }, 400);
		await view();
		await post('totp_start', {
			email: 'new@example.com',
			human_verification_response: 'p'
		}).catch((thrown: unknown) => thrown);
		const options = calls.find((call) => call.path === '/api/auth/totp/signup/options');
		expect(options?.body).toMatchObject({ email: 'new@example.com', name: 'new' });
		const entry = (await view()) as {
			codeEntry: { kind: string; setup: { secret: string; uri: string; qr: string | null } };
		};
		expect(entry.codeEntry.kind).toBe('totp');
		expect(entry.codeEntry.setup.secret).toBe('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
		expect(entry.codeEntry.setup.qr).toMatch(/^data:image\/svg\+xml;base64,/u);
		// A wrong code first: ar-auth keeps a sign-up's challenge, so the secret is kept to try again.
		let activations = 0;
		const activate = routes['/api/auth/totp/signup/activate'];
		routes['/api/auth/totp/signup/activate'] = (body, init) =>
			++activations === 1 ? json({ error: 'invalid_code' }, 400) : activate(body, init);
		await expect(
			post('totp_verify', { challenge: 'totp-s1', code: '000000' })
		).resolves.toMatchObject({
			status: 400,
			data: { error: 'totp_invalid' }
		});
		expect(store.txn.data.totp).toMatchObject({ signup: { tries: 1 } });
		const answer = await post('totp_verify', { challenge: 'totp-s1', code: '123456' });
		expect(answer).toEqual({
			backupCodes: ['ABCD-EFGH-JKLM', 'NPQR-STUV-WXYZ'],
			backupCodesTitle: 'Backup codes'
		});
		// Shown once: nothing kept of them; the Continue goes on with the Flow.
		expect(JSON.stringify(store.txn.data)).not.toContain('ABCD-EFGH-JKLM');
		browserCookies = { authrim_session: 't1' };
		await post('continue').catch((thrown: unknown) => thrown);
		expect(
			calls.filter((call) => call.path.endsWith('/submit')).map((call) => call.body.selected_handle)
		).toEqual(['totp']);
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
			totp: { enabled: true, signupEnabled: false }
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

	it('proves the invited address first for a passkey or authenticator sign-up', async () => {
		currentStep = {
			...SIGNUP_STEP,
			config: {
				screen: {
					fields: [
						{ field: 'email', label: 'Email', required: true },
						{ block_type: 'auth_widget', field: 't', label: 'App', auth_method: 'totp' }
					]
				}
			}
		};
		withCodeStep = false;
		tenantMethods = { totp: { enabled: true } };
		routes['/api/v1/invitations/email-verification/send'] = () =>
			json({
				verification_id: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
				expires_in: 600,
				masked_email: 'i***@example.com'
			});
		routes['/api/v1/invitations/email-verification/verify'] = (body) =>
			body.code === '123456'
				? json({ invitation_email_proof: 'p'.repeat(43), expires_in: 600 })
				: json({ error: 'invalid_code' }, 400);
		routes['/api/auth/totp/signup/options'] = () =>
			json(
				{
					challenge_id: 'totp-s1',
					expires_in: 600,
					secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
					otpauth_uri: 'otpauth://totp/Authrim:invited?secret=JBSWY3DPEHPK3PXP'
				},
				201
			);
		const q = `invite_token=${INVITE}`;
		await view(q);
		// No guest sign-up from the sign-up page.
		await expect(post('guest', { human_verification_response: 'p' }, q)).resolves.toMatchObject({
			status: 409
		});
		// A send that fails (a limit): the next try (another form) is a send of its own, at once.
		vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
		const send = routes['/api/v1/invitations/email-verification/send'];
		routes['/api/v1/invitations/email-verification/send'] = () => json({ error: 'busy' }, 429);
		await expect(
			post(
				'totp_start',
				{ email: 'invited@example.com', human_verification_response: 'p', op: 'f'.repeat(22) },
				q
			)
		).resolves.toMatchObject({ status: 429 });
		expect((store.txn.data.invite as { proofSendAt?: unknown }).proofSendAt).toBeNull();
		// A send whose operation could not begin takes nothing (the next try sends at once).
		store.binding.beginOperation.mockResolvedValueOnce({ ok: false, reason: 'budget_exceeded' });
		await expect(
			post(
				'totp_start',
				{ email: 'invited@example.com', human_verification_response: 'p', op: 'b'.repeat(22) },
				q
			)
		).resolves.toMatchObject({ status: 429 });
		expect((store.txn.data.invite as { proofSendAt?: unknown }).proofSendAt).toBeNull();
		// A take the store could not answer: nothing sent, and a try once the lease is out sends.
		calls = [];
		const transition = store.binding.transition.getMockImplementation()!;
		store.binding.transition.mockImplementationOnce(async () => {
			throw new Error('unreachable');
		});
		await expect(
			post(
				'totp_start',
				{ email: 'invited@example.com', human_verification_response: 'p', op: 'u'.repeat(22) },
				q
			)
		).resolves.toMatchObject({ status: 409, data: { error: 'retry' } });
		// Nor a take refused for a policy not read (no move either).
		store.binding.transition.mockImplementationOnce(async () => ({
			ok: false,
			reason: 'policy_unknown'
		}));
		vi.setSystemTime(Date.now() + 61_000);
		await expect(
			post(
				'totp_start',
				{ email: 'invited@example.com', human_verification_response: 'p', op: 'v'.repeat(22) },
				q
			)
		).resolves.toMatchObject({ status: 409, data: { error: 'retry' } });
		store.binding.transition.mockImplementation(transition);
		expect(calls.some((call) => call.path === '/api/v1/invitations/email-verification/send')).toBe(
			false
		);
		vi.setSystemTime(Date.now() + 61_000);
		calls = [];
		// The sign-up is held: the code goes to the invited address (with the sign-up's proof). A post
		// made while it is being sent (another tab, another form) sends none of its own.
		let during: unknown;
		routes['/api/v1/invitations/email-verification/send'] = (body, init) => {
			routes['/api/v1/invitations/email-verification/send'] = send;
			during = post(
				'totp_start',
				{ email: 'invited@example.com', human_verification_response: 'p', op: 'd'.repeat(22) },
				q
			).catch((thrown: unknown) => thrown);
			return send(body, init);
		};
		await post(
			'totp_start',
			{ email: 'invited@example.com', human_verification_response: 'p' },
			q
		).catch((thrown: unknown) => thrown);
		await expect(during).resolves.toMatchObject({ status: 303 });
		const sent = calls.find((call) => call.path === '/api/v1/invitations/email-verification/send');
		expect(sent?.body).toEqual({ token: INVITE, human_verification_response: 'p' });
		expect(
			calls.filter((call) => call.path === '/api/v1/invitations/email-verification/send')
		).toHaveLength(1);
		expect(store.txn.data.invite).toMatchObject({
			proofPending: { verificationId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f', tries: 0 },
			proofSendAt: null
		});
		// The button again within the minute (another form): the code already sent is the one asked
		// for; a minute later, a new one goes out.
		const sends = () =>
			calls.filter((call) => call.path === '/api/v1/invitations/email-verification/send');
		await post(
			'totp_start',
			{ email: 'invited@example.com', human_verification_response: 'p', op: 'q'.repeat(22) },
			q
		).catch((thrown: unknown) => thrown);
		expect(sends()).toHaveLength(1);
		const invite = store.txn.data.invite as { proofPending: Record<string, unknown> };
		store.set({
			data: {
				...store.txn.data,
				invite: { ...invite, proofPending: { ...invite.proofPending, sentAt: Date.now() - 61_000 } }
			}
		});
		vi.setSystemTime(Date.now() + 61_000);
		await post(
			'totp_start',
			{ email: 'invited@example.com', human_verification_response: 'p', op: 'r'.repeat(22) },
			q
		).catch((thrown: unknown) => thrown);
		expect(sends()).toHaveLength(2);
		vi.useRealTimers();
		expect(calls.some((call) => call.path === '/api/auth/totp/signup/options')).toBe(false);
		// Its entry posts no proof of work: none is asked for (drawn even when none can be issued).
		const powRoute = routes['/api/auth/human-verification/pow-challenge'];
		routes['/api/auth/human-verification/pow-challenge'] = () => json({ error: 'busy' }, 429);
		const entry = await view(q);
		expect(entry.inviteProof).toEqual({
			maskedEmail: 'i***@example.com',
			verification: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f'
		});
		const verification = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
		// A sign-in another tab began meanwhile (an email code sent): its page comes first.
		const held = store.txn.data;
		store.set({
			data: {
				...held,
				code: {
					interactionId: 'int-1',
					choiceStepId: 'signup',
					email: 'invited@example.com',
					maskedEmail: 'i***@example.com',
					attemptId: 'attempt-x',
					verifier: 'v'.repeat(43),
					sentAt: Date.now()
				}
			}
		});
		// (That code's entry posts its resend's proof.)
		routes['/api/auth/human-verification/pow-challenge'] = powRoute;
		expect((await view(q)).inviteProof).toBeNull();
		routes['/api/auth/human-verification/pow-challenge'] = () => json({ error: 'busy' }, 429);
		store.set({ data: held });
		// A new code being sent (another post took the send): no check of the old one meanwhile.
		store.set({
			data: { ...held, invite: { ...(held.invite as object), proofSendAt: Date.now() } }
		});
		await expect(
			post(
				'invite_proof_verify',
				{ code: '123456', verification: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' },
				q
			)
		).rejects.toMatchObject({ status: 303 });
		store.set({ data: held });
		// A form drawn for another code is not checked against this one.
		await expect(
			post('invite_proof_verify', { code: '123456', verification: 'another' }, q)
		).rejects.toMatchObject({ status: 303 });
		expect(
			calls.some((call) => call.path === '/api/v1/invitations/email-verification/verify')
		).toBe(false);
		expect(entry.pow).toBeNull();
		routes['/api/auth/human-verification/pow-challenge'] = () =>
			json({
				challenge: {
					algorithm: 'SHA-256',
					challenge: 'a'.repeat(64),
					maxnumber: 100,
					salt: 's',
					signature: 'g'
				},
				policy_revision: 'rev-1'
			});
		await expect(
			post('invite_proof_verify', { code: '000000', verification }, q)
		).resolves.toMatchObject({
			status: 400,
			data: { error: 'code_invalid' }
		});
		// Checks ar-auth could not make (unavailable, or a limit) are no tries: the right code still
		// passes.
		const verify = routes['/api/v1/invitations/email-verification/verify'];
		routes['/api/v1/invitations/email-verification/verify'] = () =>
			json({ error: 'server_error' }, 500);
		for (let i = 0; i < 4; i++) {
			await expect(
				post('invite_proof_verify', { code: '123456', verification }, q)
			).resolves.toMatchObject({ status: 409, data: { error: 'retry' } });
		}
		routes['/api/v1/invitations/email-verification/verify'] = () =>
			json({ error: 'rate_limit_exceeded' }, 429);
		await expect(
			post('invite_proof_verify', { code: '123456', verification }, q)
		).resolves.toMatchObject({ status: 429, data: { error: 'busy' } });
		expect(store.txn.data.invite).toMatchObject({ proofPending: { tries: 1, checks: 6 } });
		routes['/api/v1/invitations/email-verification/verify'] = verify;
		await post('invite_proof_verify', { code: '123456', verification }, q).catch(
			(thrown: unknown) => thrown
		);
		expect((await view(q)).inviteProof).toBeNull();
		// Proved: the sign-up starts with the proof.
		await post(
			'totp_start',
			{ email: 'invited@example.com', human_verification_response: 'p2' },
			q
		).catch((thrown: unknown) => thrown);
		const options = calls.find((call) => call.path === '/api/auth/totp/signup/options');
		expect(options?.body).toMatchObject({
			invite_token: INVITE,
			invitation_email_proof: 'p'.repeat(43)
		});
	});

	it('points an address that has an account (an unfinished sign-up) to the sign-in page', async () => {
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
		tenantMethods = { passkey: { enabled: true } };
		routes['/api/v1/auth/direct/passkey/signup/start'] = () => json({ error: 'conflict' }, 409);
		await view();
		await expect(
			post('passkey_start', { email: 'taken@example.com', human_verification_response: 'p' })
		).resolves.toMatchObject({ status: 409, data: { error: 'account_exists' } });
		// Nothing is held: the page can sign in, or sign up another address.
		expect(store.txn.data.passkey).toBeUndefined();
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

	it('signs up with an external provider: its grant is made for the sign-up', async () => {
		currentStep = {
			...SIGNUP_STEP,
			config: {
				screen: {
					fields: [
						{ block_type: 'auth_widget', field: 's', label: 'Social', auth_method: 'external_idp' }
					]
				}
			}
		};
		tenantMethods = {
			external: {
				enabled: true,
				providers: [{ id: 'google', name: 'Google', enabled: true, signupEnabled: true }]
			}
		};
		store.binding.issueStartGrant.mockResolvedValue({ ok: true, grantId: 'grant-1' });
		routes['/api/v1/login/interactions/int-1/submit'] = () =>
			json({ completed: false, step: COMPLETION, interaction: { current_step_id: 'done' } });
		const page = (await view(`invite_token=${INVITE}`)) as { providers: unknown[] };
		expect(page.providers).toEqual([{ id: 'google', label: 'Continue with Google' }]);
		await post(
			'social_start',
			{ provider: 'google', human_verification_response: 'p' },
			`invite_token=${INVITE}`
		).catch((thrown: unknown) => thrown);
		expect(store.binding.issueStartGrant).toHaveBeenCalledTimes(1);
		expect(store.txn.data.social).toMatchObject({ provider: 'google', grantId: 'grant-1' });
	});

	it('lists the providers by their sign-up switch (a lite start is gated by its purpose)', async () => {
		currentStep = {
			...SIGNUP_STEP,
			config: {
				screen: {
					fields: [
						{ block_type: 'auth_widget', field: 's', label: 'Social', auth_method: 'external_idp' }
					]
				}
			}
		};
		tenantMethods = {
			external: {
				enabled: true,
				providers: [
					{ id: 'both', name: 'Both', enabled: true, loginEnabled: true, signupEnabled: true },
					{ id: 'signs-up', name: 'Up', enabled: true, loginEnabled: false, signupEnabled: true },
					{ id: 'signs-in', name: 'In', enabled: true, loginEnabled: true, signupEnabled: false }
				]
			}
		};
		const page = (await view()) as { providers: Array<{ id: string }> };
		expect(page.providers.map((provider) => provider.id)).toEqual(['both', 'signs-up']);
		await expect(
			post('social_start', { provider: 'signs-in', human_verification_response: 'p' })
		).resolves.toMatchObject({ status: 409 });
		expect(store.binding.issueStartGrant).not.toHaveBeenCalled();
	});

	it('offers and starts a provider that only signs up (none that signs in besides)', async () => {
		currentStep = {
			...SIGNUP_STEP,
			config: {
				screen: {
					fields: [
						{ block_type: 'auth_widget', field: 's', label: 'Social', auth_method: 'external_idp' }
					]
				}
			}
		};
		tenantMethods = {
			external: {
				enabled: true,
				providers: [
					{ id: 'signs-up', name: 'Up', enabled: true, loginEnabled: false, signupEnabled: true }
				]
			}
		};
		const page = (await view()) as {
			providers: Array<{ id: string }>;
			available: { external?: boolean };
			decision: { fields: Array<{ blockType: string }> };
		};
		expect(page.providers.map((provider) => provider.id)).toEqual(['signs-up']);
		expect(page.decision.fields.map((field) => field.blockType)).toContain('auth_widget');
		store.binding.issueStartGrant.mockResolvedValue({ ok: true, grantId: 'grant-1' });
		await post('social_start', { provider: 'signs-up', human_verification_response: 'p' }).catch(
			(thrown: unknown) => thrown
		);
		expect(store.binding.issueStartGrant).toHaveBeenCalledWith(
			expect.objectContaining({ provider: 'signs-up' })
		);
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

	describe('a sign-up whose account is still being made (a 202)', () => {
		const TOKEN = 'T'.repeat(43);
		const provisioning = (extra: Record<string, unknown> = {}) =>
			json(
				{
					status: 'provisioning',
					provisioning_token: TOKEN,
					status_endpoint: '/api/v1/auth/account-provisioning/status',
					retry_after_ms: 500,
					expires_in: 300,
					...extra
				},
				202
			);
		const held = () => store.txn.data.provisioning as { id: string } | undefined;
		const statuses = () =>
			calls.filter((call) => call.path === '/api/v1/auth/account-provisioning/status');

		it('holds an email-code send and sends it again, as it was, once the account exists', async () => {
			currentStep = SIGNUP_STEP;
			routes['/api/v1/auth/direct/email-code/send'] = () => provisioning();
			await view();
			await post('send_code', {
				email: 'new@example.com',
				name: 'Kai',
				company: 'Acme',
				human_verification_response: 'p'
			}).catch((thrown: unknown) => thrown);
			// Held: no code, and the page draws the hold's Continue (with a proof).
			expect(store.txn.data.code).toBeUndefined();
			const id = held()?.id;
			expect(id).toEqual(expect.any(String));
			const page = (await view()) as Record<string, unknown>;
			expect(page.provisioning).toEqual({ id });
			expect(page.pow).not.toBeNull();
			const first = sends()[0];

			// Nothing else starts over the hold (an older form, another address): the page again.
			await expect(
				post('send_code', {
					email: 'other@example.com',
					company: 'Acme',
					human_verification_response: 'p',
					op: 'x'.repeat(22)
				})
			).rejects.toMatchObject({ status: 303 });
			expect(sends()).toHaveLength(1);
			expect(held()?.id).toBe(id);

			// A Continue drawn for another hold: the page again, nothing checked.
			await expect(
				post('provisioning_continue', { provisioning: 'other', human_verification_response: 'p2' })
			).rejects.toMatchObject({ status: 303 });
			expect(statuses()).toHaveLength(0);

			// Still being made: the page says to wait, nothing sent again.
			routes['/api/v1/auth/account-provisioning/status'] = () =>
				json({ status: 'pending', retry_after_ms: 500 });
			// However often (no operation begun: the transaction's budget is not spent on waiting).
			const begun = store.binding.beginOperation.mock.calls.length;
			for (let i = 0; i < 40; i++) {
				await expect(
					post('provisioning_continue', { provisioning: id!, human_verification_response: 'p2' })
				).resolves.toMatchObject({ status: 409, data: { error: 'provisioning_wait' } });
			}
			expect(store.binding.beginOperation.mock.calls.length).toBe(begun);
			expect(statuses()[0].body).toEqual({ provisioning_token: TOKEN });
			expect(sends()).toHaveLength(1);

			// Made: the same send again (its PKCE, profile and header), with the new proof.
			routes['/api/v1/auth/account-provisioning/status'] = () => json({ status: 'ready' });
			routes['/api/v1/auth/direct/email-code/send'] = () =>
				json({ attempt_id: 'attempt-2', expires_in: 300, masked_email: 'n***@example.com' });
			await post('provisioning_continue', {
				provisioning: id!,
				human_verification_response: 'p2',
				op: 'c'.repeat(22)
			}).catch((thrown: unknown) => thrown);
			const again = sends()[1];
			expect(again.body).toMatchObject({
				email: 'new@example.com',
				code_challenge: first.body.code_challenge,
				display_name: 'Kai',
				custom_fields: { company: 'Acme' },
				human_verification_response: 'p2'
			});
			expect(again.headers.get('X-Authrim-Human-Verification-Action')).toBe('signup');
			// The code is kept (with the first send's verifier), and the hold is given up.
			expect(store.txn.data.code).toMatchObject({ attemptId: 'attempt-2' });
			expect(held()).toBeUndefined();
			expect(((await view()) as Record<string, unknown>).codeEntry).toMatchObject({
				kind: 'mail_otp'
			});
		});

		it('moves a send made again that failed on, and gives up a hold that failed', async () => {
			currentStep = SIGNUP_STEP;
			routes['/api/v1/auth/direct/email-code/send'] = () => provisioning();
			await view();
			await post('send_code', {
				email: 'new@example.com',
				company: 'Acme',
				human_verification_response: 'p'
			}).catch((thrown: unknown) => thrown);
			const id = held()!.id;
			routes['/api/v1/auth/account-provisioning/status'] = () => json({ status: 'ready' });
			// The send made again fails (a limit): the next Continue is a try of its own.
			routes['/api/v1/auth/direct/email-code/send'] = () => json({ error: 'busy' }, 429);
			await expect(
				post('provisioning_continue', { provisioning: id, human_verification_response: 'p2' })
			).resolves.toMatchObject({ status: 429 });
			expect(store.txn.data.provisioning).toMatchObject({ id, tries: 1 });
			routes['/api/v1/auth/direct/email-code/send'] = () =>
				json({ attempt_id: 'attempt-3', expires_in: 300, masked_email: null });
			await post('provisioning_continue', {
				provisioning: id,
				human_verification_response: 'p3'
			}).catch((thrown: unknown) => thrown);
			expect(store.txn.data.code).toMatchObject({ attemptId: 'attempt-3' });
		});

		it('makes a try whose change was not saved from its result (a send made once)', async () => {
			currentStep = SIGNUP_STEP;
			routes['/api/v1/auth/direct/email-code/send'] = () => provisioning();
			await view();
			await post('send_code', {
				email: 'new@example.com',
				company: 'Acme',
				human_verification_response: 'p'
			}).catch((thrown: unknown) => thrown);
			const id = held()!.id;
			routes['/api/v1/auth/account-provisioning/status'] = () => json({ status: 'ready' });
			routes['/api/v1/auth/direct/email-code/send'] = () =>
				json({ attempt_id: 'attempt-9', expires_in: 300, masked_email: 'n***@example.com' });
			// The result is recorded, its change refused (another post moved the transaction), and the
			// change made again fails (the store unreachable).
			const complete = store.binding.completeOperation.getMockImplementation()!;
			store.binding.completeOperation.mockImplementationOnce(async (call) => {
				await complete({ ...call, transition: undefined });
				return { ok: false, reason: 'version_mismatch' };
			});
			const transition = store.binding.transition.getMockImplementation()!;
			store.binding.transition.mockImplementation(async (call: Record<string, unknown>) => {
				if ((call.patch as Record<string, unknown> | undefined)?.code) {
					throw new Error('unreachable');
				}
				return transition(call);
			});
			await expect(
				post('provisioning_continue', { provisioning: id, human_verification_response: 'p2' })
			).resolves.toMatchObject({ status: 409, data: { error: 'retry' } });
			// The account's state is not asked again (unavailable now): the try marked is taken up.
			routes['/api/v1/auth/account-provisioning/status'] = () =>
				json({ error: 'unavailable' }, 503);
			store.binding.transition.mockImplementation(transition);
			expect(store.txn.data.code).toBeUndefined();
			expect(held()?.id).toBe(id);
			// The next Continue makes it from the result, even once the hold has expired (the code it
			// sent lasts longer): the code kept, nothing sent again.
			store.set({
				data: {
					...store.txn.data,
					provisioning: { ...(store.txn.data.provisioning as object), expiresAt: Date.now() - 1 }
				}
			});
			await post('provisioning_continue', {
				provisioning: id,
				human_verification_response: 'p3',
				op: 'r'.repeat(22)
			}).catch((thrown: unknown) => thrown);
			expect(sends()).toHaveLength(2);
			expect(store.txn.data.code).toMatchObject({ attemptId: 'attempt-9' });
			expect(held()).toBeUndefined();
		});

		it('gives up a hold whose account failed', async () => {
			currentStep = SIGNUP_STEP;
			routes['/api/v1/auth/direct/email-code/send'] = () => provisioning();
			await view();
			await post('send_code', {
				email: 'other@example.com',
				company: 'Acme',
				human_verification_response: 'p'
			}).catch((thrown: unknown) => thrown);
			const next = held()!.id;
			routes['/api/v1/auth/account-provisioning/status'] = () => json({ status: 'failed' }, 409);
			await expect(
				post('provisioning_continue', { provisioning: next, human_verification_response: 'p4' })
			).resolves.toMatchObject({ status: 409, data: { error: 'provisioning_failed' } });
			expect(held()).toBeUndefined();
		});

		it('holds a passkey start and starts it again as the account it made', async () => {
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
			tenantMethods = { passkey: { enabled: true, signupEnabled: true } };
			routes['/api/v1/auth/direct/passkey/signup/start'] = () =>
				provisioning({ resume_user_id: 'user-first' });
			await view();
			await post('passkey_start', {
				email: 'new@example.com',
				human_verification_response: 'p'
			}).catch((thrown: unknown) => thrown);
			const id = held()!.id;
			expect(store.txn.data.passkey).toBeUndefined();
			routes['/api/v1/auth/account-provisioning/status'] = () => json({ status: 'ready' });
			routes['/api/v1/auth/direct/passkey/signup/start'] = () =>
				json({
					challenge_id: 'pk-2',
					options: {
						rp: { id: 'id.example', name: 'Authrim' },
						user: { id: 'dXNlci0x', name: 'new@example.com', displayName: 'new' },
						challenge: 'Y2hhbGxlbmdl',
						pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
						timeout: 60000,
						excludeCredentials: [],
						authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
						attestation: 'none'
					}
				});
			await post('provisioning_continue', {
				provisioning: id,
				human_verification_response: 'p2'
			}).catch((thrown: unknown) => thrown);
			const starts = calls.filter(
				(call) => call.path === '/api/v1/auth/direct/passkey/signup/start'
			);
			expect(starts[1].body).toMatchObject({
				email: 'new@example.com',
				provisioning_token: TOKEN,
				resume_user_id: 'user-first',
				human_verification_response: 'p2'
			});
			expect(store.txn.data.passkey).toMatchObject({ challengeId: 'pk-2' });
			expect(held()).toBeUndefined();
		});

		it('refuses a passkey sign-up whose profile the hold could not keep, before any account', async () => {
			currentStep = {
				...SIGNUP_STEP,
				config: {
					screen: {
						fields: [
							{ field: 'email', label: 'Email', required: true },
							{ field: 'company', label: 'Company' },
							{ block_type: 'auth_widget', field: 'p', label: 'Passkey', auth_method: 'passkey' }
						]
					}
				}
			};
			tenantMethods = { passkey: { enabled: true, signupEnabled: true } };
			await view();
			await expect(
				post('passkey_start', {
					email: 'new@example.com',
					company: 'x'.repeat(3000),
					human_verification_response: 'p'
				})
			).resolves.toMatchObject({ status: 400, data: { error: 'answer_invalid' } });
			expect(calls.some((call) => call.path === '/api/v1/auth/direct/passkey/signup/start')).toBe(
				false
			);
		});

		it("gives a passkey hold up when the address's account is no longer the sign-up's", async () => {
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
			tenantMethods = { passkey: { enabled: true, signupEnabled: true } };
			routes['/api/v1/auth/direct/passkey/signup/start'] = () =>
				provisioning({ resume_user_id: 'user-first' });
			await view();
			await post('passkey_start', {
				email: 'new@example.com',
				human_verification_response: 'p'
			}).catch((thrown: unknown) => thrown);
			const id = held()!.id;
			routes['/api/v1/auth/account-provisioning/status'] = () => json({ status: 'ready' });
			routes['/api/v1/auth/direct/passkey/signup/start'] = () => json({ error: 'conflict' }, 409);
			await expect(
				post('provisioning_continue', { provisioning: id, human_verification_response: 'p2' })
			).resolves.toMatchObject({ status: 409, data: { error: 'account_exists' } });
			expect(held()).toBeUndefined();
			expect(((await view()) as Record<string, unknown>).provisioning).toBeNull();
		});
	});
});
