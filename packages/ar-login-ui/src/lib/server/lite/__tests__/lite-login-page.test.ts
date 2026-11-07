import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { actions, load } from '../../../../routes/__lite/login/+page.server';

type Call = { url: string; init: RequestInit };

let backendCalls: Call[];
let txnCalls: string[];
let order: string[];
let routes: Record<string, (init: RequestInit) => Response>;
let txnState: Record<string, unknown>;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const screenStep = {
	id: 'step-1',
	source_node_id: 'node-1',
	component: 'screen',
	render: true,
	config: {
		screen: {
			display_name: 'Sign in',
			fields: [
				{ field: 'email', label: 'Email', required: true },
				{ block_type: 'auth_widget', field: 'm', label: 'Send', auth_method: 'mail_otp' }
			]
		}
	}
};

const startAnswer = (step: unknown, hash = 'hash-1') => ({
	interaction: { id: 'int-1', state: 'active', current_step_id: (step as { id: string }).id },
	contract: { ui: { steps: [step] } },
	contract_hash: hash,
	signature: `sig-${hash}`
});

function txnView(overrides: Record<string, unknown> = {}) {
	return {
		id: 'txn-1',
		bound: {
			tenantId: 'default',
			publicOrigin: 'https://id.example',
			purpose: 'login',
			clientId: null,
			challengeId: null,
			returnTo: null,
			policyRevision: 'rev-1',
			sessionId: null,
			userId: null
		},
		state: 'open',
		version: 1,
		csrfToken: 'csrf-1',
		data: {},
		createdAt: 0,
		expiresAt: 1,
		...overrides
	};
}

function event(
	init: {
		path?: string;
		method?: string;
		body?: string;
		cookies?: Record<string, string>;
		edge?: Record<string, unknown>;
		methods?: Record<string, unknown>;
	} = {}
): RequestEvent {
	const url = new URL(`https://id.example${init.path ?? '/login'}`);
	const cookies = new Map(
		Object.entries(init.cookies ?? { '__Host-authrim_lite': 'b'.repeat(43) })
	);
	return {
		url,
		request: new Request(url, {
			method: init.method ?? 'GET',
			headers: init.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
			body: init.body
		}),
		cookies: {
			get: (name: string) => cookies.get(name),
			set: vi.fn((name: string, value: string) => cookies.set(name, value))
		},
		locals: {
			locale: 'en',
			authenticationMethods: init.methods ?? {
				methods: { emailCode: { enabled: true }, guest: { enabled: true } }
			},
			edge: init.edge ?? {
				source: 'router',
				originVerified: init.method === 'POST' ? true : null,
				clientIp: '203.0.113.1',
				publicOrigin: 'https://id.example'
			}
		},
		platform: {
			env: {
				AR_ROUTER: {
					fetch: vi.fn(async (url: string, requestInit: RequestInit) => {
						backendCalls.push({ url, init: requestInit });
						order.push(`backend:${new URL(url).pathname}`);
						const path = new URL(url).pathname;
						const handler = routes[path] ?? routes['*'];
						return handler ? handler(requestInit) : json({ error: 'not_found' }, 404);
					})
				},
				LITE_TXN: {
					create: vi.fn(async (call: Record<string, unknown>) => {
						txnCalls.push(`create:${String(call.purpose)}`);
						order.push('txn:create');
						return txnState.create ?? { ok: true, txn: txnView() };
					}),
					get: vi.fn(async () => txnState.get ?? { ok: true, txn: txnView() }),
					transition: vi.fn(async (call: Record<string, unknown>) => {
						txnCalls.push(`transition:${String(call.to)}`);
						return {
							ok: true,
							txn: txnView({ state: call.to, version: 2, data: call.patch ?? {} })
						};
					}),
					beginOperation: vi.fn(),
					completeOperation: vi.fn(),
					issueStartGrant: vi.fn()
				}
			}
		}
	} as unknown as RequestEvent;
}

beforeEach(() => {
	backendCalls = [];
	txnCalls = [];
	order = [];
	txnState = {};
	routes = {
		'/api/v1/login/interactions/start': () => json(startAnswer(screenStep)),
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
			})
	};
});

const run = (e: RequestEvent) => (load as unknown as (e: RequestEvent) => Promise<unknown>)(e);

describe('a page view of the lite sign-in page', () => {
	it('makes the transaction first, then starts the Flow, and draws the screen with a proof', async () => {
		const e = event();
		const page = (await run(e)) as Record<string, unknown>;
		expect(order.slice(0, 2)).toEqual(['txn:create', 'backend:/api/v1/login/interactions/start']);
		expect(txnCalls).toContain('transition:pending');
		expect(page).toMatchObject({
			page: 'step',
			txnId: 'txn-1',
			decision: { kind: 'screen', title: 'Sign in' },
			pow: { challenge: 'a'.repeat(64) }
		});
		expect(e.locals.liteCsp?.scriptHashes?.[0]).toMatch(/^'sha256-/u);
	});

	it('never submits a step, even when the Flow is on one the SPA submits by itself', async () => {
		routes['/api/v1/login/interactions/start'] = () =>
			json(startAnswer({ id: 'c', source_node_id: 'n', component: 'completion', render: false }));
		const page = (await run(
			event({ cookies: { authrim_session: 's', '__Host-authrim_lite': 'b'.repeat(43) } })
		)) as {
			decision: unknown;
		};
		expect(page.decision).toEqual({ kind: 'continue' });
		expect(backendCalls.map((call) => new URL(call.url).pathname)).not.toContainEqual(
			expect.stringMatching(/\/submit$/u)
		);
	});

	it('sends the browser to the canonical issuer origin before anything else', async () => {
		txnState.create = {
			ok: false,
			reason: 'origin_not_canonical',
			canonicalOrigin: 'https://login.example.com'
		};
		await expect(run(event({ path: '/login?challenge_x=1' }))).rejects.toMatchObject({
			status: 303,
			location: 'https://login.example.com/login?challenge_x=1'
		});
		expect(backendCalls).toEqual([]);
	});

	it('starts nothing when the transaction budget is spent', async () => {
		txnState.create = { ok: false, reason: 'budget_exceeded' };
		const page = (await run(event())) as Record<string, unknown>;
		expect(page.page).toBe('error');
		expect(backendCalls).toEqual([]);
	});

	it('resumes the kept Flow, and starts again when it cannot be resumed', async () => {
		const kept = { flow: { interactionId: 'int-0', contractHash: 'h0', signature: 's0' } };
		txnState.create = { ok: true, txn: txnView({ data: kept, state: 'pending' }) };
		const bodies: unknown[] = [];
		routes['/api/v1/login/interactions/start'] = (init) => {
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			bodies.push(body);
			return body.resume_interaction_id
				? json({ error: 'interaction_expired' }, 409)
				: json(startAnswer(screenStep));
		};
		await run(event());
		expect(bodies[0]).toMatchObject({ resume_interaction_id: 'int-0' });
		expect(bodies[1]).toMatchObject({ flow_kind: 'login' });
	});

	it('says the request expired when its authorization challenge is gone', async () => {
		routes['/auth/login-challenge'] = () => json({ error: 'not_found' }, 404);
		const page = (await run(event({ path: '/login?challenge_id=ch-1' }))) as Record<
			string,
			unknown
		>;
		expect(page).toMatchObject({ page: 'error' });
		expect(txnCalls).toEqual([]);
	});

	it('stops before any side effect on a block it cannot draw', async () => {
		routes['/api/v1/login/interactions/start'] = () =>
			json(
				startAnswer({
					...screenStep,
					config: { screen: { fields: [{ block_type: 'consent_widget', field: 'c' }] } }
				})
			);
		const page = (await run(event())) as { decision: unknown };
		expect(page.decision).toEqual({ kind: 'unsupported', reasons: ['block:consent_widget'] });
		expect(backendCalls.map((call) => new URL(call.url).pathname)).toEqual([
			'/api/v1/login/interactions/start'
		]);
	});
});

const post = (path: string, body: string, cookies?: Record<string, string>) =>
	(actions.continue as unknown as (e: RequestEvent) => Promise<unknown>)(
		event({ path, method: 'POST', body, cookies })
	);

describe('the Continue post', () => {
	beforeEach(() => {
		txnState.get = {
			ok: true,
			txn: txnView({
				state: 'pending',
				data: { flow: { interactionId: 'int-1', contractHash: 'h', signature: 's' } }
			})
		};
	});

	it('refuses a post whose form token does not match its transaction', async () => {
		await expect(post('/login?/continue', 'txn=txn-1&csrf=wrong')).resolves.toMatchObject({
			status: 403
		});
		expect(backendCalls).toEqual([]);
	});

	it('completes an SSO sign-in with the session, and relays to the continuation', async () => {
		routes['/api/v1/login/interactions/start'] = () =>
			json(startAnswer({ id: 'c', source_node_id: 'n', component: 'completion', render: true }));
		routes['/api/v1/login/interactions/int-1/submit'] = () =>
			json({
				completed: true,
				output: {
					action: 'continue_protocol',
					redirect_url: '/authorize?_confirmation_challenge=x'
				}
			});
		// The action, then the page's load in the same request (as SvelteKit runs them).
		const e = event({
			path: '/login?/continue',
			method: 'POST',
			body: 'txn=txn-1&csrf=csrf-1',
			cookies: { authrim_session: 's', '__Host-authrim_lite': 'b'.repeat(43) }
		});
		await (actions.continue as unknown as (e: RequestEvent) => Promise<unknown>)(e);
		const callsBeforeLoad = backendCalls.length;
		const page = await run(e);
		expect(page).toMatchObject({
			page: 'relay',
			relay: { method: 'get', url: 'https://id.example/authorize?_confirmation_challenge=x' }
		});
		// The load started nothing: the Flow is done and its authorization request consumed.
		expect(backendCalls.length).toBe(callsBeforeLoad);
		const submit = backendCalls.find((call) => call.url.endsWith('/submit'));
		expect(new Headers(submit?.init.headers).get('origin')).toBe('https://id.example');
		expect(JSON.parse(String(submit?.init.body))).toMatchObject({ selected_handle: 'completed' });
		expect(txnCalls).toContain('transition:completed');
	});

	it('does not try to complete without a signed-in session', async () => {
		routes['/api/v1/login/interactions/start'] = () =>
			json(startAnswer({ id: 'c', source_node_id: 'n', component: 'completion', render: true }));
		await expect(post('/login?/continue', 'txn=txn-1&csrf=csrf-1')).resolves.toMatchObject({
			status: 401
		});
		expect(backendCalls.some((call) => call.url.endsWith('/submit'))).toBe(false);
	});

	it('goes back to the page when the Flow reaches a step to draw', async () => {
		routes['/api/v1/login/interactions/start'] = () =>
			json(
				startAnswer({ id: 'r', source_node_id: 'n', component: 'session_check', render: false })
			);
		routes['/api/v1/login/interactions/int-1/submit'] = () =>
			json({ completed: false, step: screenStep, interaction: { current_step_id: 'step-1' } });
		await expect(post('/login?/continue', 'txn=txn-1&csrf=csrf-1')).rejects.toMatchObject({
			status: 303
		});
	});
});

describe('round 1 review regressions', () => {
	it('leaves out the blocks of methods that are off, as the default screens list them all', async () => {
		routes['/api/v1/login/interactions/start'] = () =>
			json(
				startAnswer({
					...screenStep,
					config: {
						screen: {
							fields: [
								{ field: 'email', label: 'Email' },
								{ block_type: 'auth_widget', field: 'm', auth_method: 'mail_otp' },
								{ block_type: 'auth_widget', field: 'p', auth_method: 'passkey' },
								{ block_type: 'auth_widget', field: 'd', auth_method: 'directory_password' },
								{
									block_type: 'text',
									field: 't',
									label: 'passkey only',
									display_condition: { mode: 'feature_enabled', feature: 'passkey' }
								}
							]
						}
					}
				})
			);
		const page = (await run(event())) as { decision: { kind: string; fields: unknown[] } };
		expect(page.decision.kind).toBe('screen');
		expect(page.decision.fields).toHaveLength(2);
	});

	it('keeps the request the page continues across a Continue post', async () => {
		txnState.get = {
			ok: true,
			txn: txnView({
				state: 'pending',
				data: { flow: { interactionId: 'int-1', contractHash: 'h', signature: 's' } }
			})
		};
		routes['/api/v1/login/interactions/start'] = () =>
			json(
				startAnswer({ id: 'r', source_node_id: 'n', component: 'session_check', render: false })
			);
		routes['/api/v1/login/interactions/int-1/submit'] = () =>
			json({ completed: false, step: screenStep, interaction: { current_step_id: 'step-1' } });
		await expect(
			post('/login?challenge_id=ch-1&saml_request_id=sr&/continue', 'txn=txn-1&csrf=csrf-1')
		).rejects.toMatchObject({
			status: 303,
			location: '/login?challenge_id=ch-1&saml_request_id=sr'
		});
	});

	it('checks the posted transaction against the current policy, and keeps the resumed Flow', async () => {
		txnState.get = {
			ok: true,
			txn: txnView({
				state: 'pending',
				data: { flow: { interactionId: 'int-1', contractHash: 'h', signature: 's' } }
			})
		};
		routes['/api/v1/login/interactions/start'] = () =>
			json(
				startAnswer(
					{ id: 'r', source_node_id: 'n', component: 'session_check', render: false },
					'new'
				)
			);
		routes['/api/v1/login/interactions/int-1/submit'] = () =>
			json({ completed: false, step: screenStep, interaction: { current_step_id: 'step-1' } });
		const e = event({ path: '/login?/continue', method: 'POST', body: 'txn=txn-1&csrf=csrf-1' });
		await (actions.continue as unknown as (e: RequestEvent) => Promise<unknown>)(e).catch(
			() => null
		);
		const service = (
			e.platform as {
				env: { LITE_TXN: { get: ReturnType<typeof vi.fn>; transition: ReturnType<typeof vi.fn> } };
			}
		).env.LITE_TXN;
		expect(service.get.mock.calls[0]?.[0]).toMatchObject({ current: true });
		expect(service.transition.mock.calls[0]?.[0]).toMatchObject({
			patch: { flow: { contractHash: 'new', signature: 'sig-new' } }
		});
	});

	it('refuses a post under a changed policy before any backend call', async () => {
		txnState.get = { ok: false, reason: 'policy_changed' };
		await expect(post('/login?/continue', 'txn=txn-1&csrf=csrf-1')).resolves.toMatchObject({
			status: 403
		});
		expect(backendCalls).toEqual([]);
	});

	it('submits no step the lite UI does not drive, inside a post either', async () => {
		txnState.get = {
			ok: true,
			txn: txnView({
				state: 'pending',
				data: { flow: { interactionId: 'int-1', contractHash: 'h', signature: 's' } }
			})
		};
		routes['/api/v1/login/interactions/start'] = () =>
			json(startAnswer({ id: 'x', source_node_id: 'n', component: 'mystery', render: false }));
		await expect(post('/login?/continue', 'txn=txn-1&csrf=csrf-1')).resolves.toMatchObject({
			status: 409
		});
		expect(backendCalls.some((call) => call.url.endsWith('/submit'))).toBe(false);
	});

	it('finishes the transaction for good once the sign-in completed', async () => {
		txnState.get = {
			ok: true,
			txn: txnView({
				state: 'pending',
				data: { flow: { interactionId: 'int-1', contractHash: 'h', signature: 's' } }
			})
		};
		routes['/api/v1/login/interactions/start'] = () =>
			json(
				startAnswer({ id: 'c', source_node_id: 'n', component: 'completion', render: true }, 'h')
			);
		routes['/api/v1/login/interactions/int-1/submit'] = () =>
			json({ completed: true, output: { redirect_url: '/authorize?_confirmation_challenge=x' } });
		await post('/login?/continue', 'txn=txn-1&csrf=csrf-1', {
			authrim_session: 's',
			'__Host-authrim_lite': 'b'.repeat(43)
		});
		// One move to completed (never refused for the budget), with where it went.
		const moves = txnCalls.filter((call) => call.startsWith('transition:'));
		expect(moves[moves.length - 1]).toBe('transition:completed');
	});
});

describe('round 2 review regressions', () => {
	it('takes return_to=saml_sso as the SAML continuation, not a destination', async () => {
		const bodies: Array<Record<string, unknown>> = [];
		routes['/api/v1/login/interactions/start'] = (init) => {
			bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
			return json(startAnswer(screenStep));
		};
		const e = event({
			path: '/login?saml_request_id=sr-1&saml_sp_entity_id=https%3A%2F%2Fsp.example&return_to=saml_sso'
		});
		const page = (await run(e)) as Record<string, unknown>;
		expect(page.page).toBe('step');
		const service = (e.platform as { env: { LITE_TXN: { create: ReturnType<typeof vi.fn> } } }).env
			.LITE_TXN;
		expect(service.create.mock.calls[0]?.[0]).toMatchObject({ returnTo: null });
		expect(bodies[0]).toMatchObject({ return_to: 'saml_sso', saml_request_id: 'sr-1' });
	});

	it('hides the blocks of a hidden layout row up to the next row', async () => {
		routes['/api/v1/login/interactions/start'] = () =>
			json(
				startAnswer({
					...screenStep,
					config: {
						screen: {
							fields: [
								{ block_type: 'layout_row', field: 'r1', display_condition: { mode: 'hidden' } },
								{ block_type: 'consent_widget', field: 'c' },
								{ block_type: 'text', field: 't0', label: 'in the hidden row' },
								{
									block_type: 'layout_row',
									field: 'r2',
									display_condition: { mode: 'feature_enabled', feature: 'passkey' }
								},
								{ block_type: 'text', field: 't1', label: 'passkey row' },
								{ block_type: 'layout_row', field: 'r3' },
								{ field: 'email', label: 'Email' }
							]
						}
					}
				})
			);
		const page = (await run(event())) as {
			decision: { kind: string; fields: Array<{ field: string }> };
		};
		expect(page.decision.kind).toBe('screen');
		expect(page.decision.fields.map((field) => field.field)).toEqual(['email']);
	});
});

/** The default login screen as ar-management makes it (admin-screens.ts, `defaultAuthenticationFields`). */
const defaultLoginScreen = {
	display_name: 'Login',
	fields: [
		{ field: 'heading.login', label: 'Sign in', block_type: 'heading' },
		{
			field: 'auth.passkey',
			label: 'Sign in with a passkey',
			block_type: 'auth_widget',
			auth_method: 'passkey'
		},
		{
			field: 'divider.or',
			label: 'or',
			block_type: 'divider',
			display_condition: { mode: 'feature_enabled', feature: 'mail_otp' }
		},
		{
			field: 'auth.mail_otp',
			label: 'Send code',
			block_type: 'auth_widget',
			auth_method: 'mail_otp'
		},
		{ field: 'auth.totp', label: 'Authenticator', block_type: 'auth_widget', auth_method: 'totp' },
		{
			field: 'divider.other_accounts',
			label: '',
			block_type: 'divider',
			display_condition: { mode: 'feature_enabled', feature: 'external_idp' }
		},
		{
			field: 'auth.external_idp',
			label: '',
			block_type: 'auth_widget',
			auth_method: 'external_idp'
		},
		{
			field: 'divider.directory_password',
			label: '',
			block_type: 'divider',
			display_condition: { mode: 'feature_enabled', feature: 'directory_password' }
		},
		{
			field: 'auth.directory_password',
			label: '',
			block_type: 'auth_widget',
			auth_method: 'directory_password'
		},
		{ field: 'auth.guest', label: 'Continue as a guest', block_type: 'guest_login_widget' }
	]
};

describe('round 3 review regressions', () => {
	it('draws the default login screen with an email field for its email code button', async () => {
		routes['/api/v1/login/interactions/start'] = () =>
			json(startAnswer({ ...screenStep, config: { screen: defaultLoginScreen } }));
		const page = (await run(event())) as {
			decision: { kind: string; fields: Array<{ blockType: string; field: string }> };
		};
		expect(page.decision.kind).toBe('screen');
		expect(page.decision.fields.map((f) => `${f.blockType}:${f.field}`)).toEqual([
			'heading:heading.login',
			'divider:divider.or',
			'identity_field:email',
			'auth_widget:auth.mail_otp',
			'guest_login_widget:auth.guest'
		]);
	});

	it('keeps the relay of a finished sign-in when saving the transaction fails', async () => {
		txnState.get = {
			ok: true,
			txn: txnView({
				state: 'pending',
				data: { flow: { interactionId: 'int-1', contractHash: 'h', signature: 's' } }
			})
		};
		routes['/api/v1/login/interactions/start'] = () =>
			json(
				startAnswer({ id: 'c', source_node_id: 'n', component: 'completion', render: true }, 'h')
			);
		routes['/api/v1/login/interactions/int-1/submit'] = () =>
			json({ completed: true, output: { redirect_url: '/authorize?_confirmation_challenge=x' } });
		const e = event({
			path: '/login?/continue',
			method: 'POST',
			body: 'txn=txn-1&csrf=csrf-1',
			cookies: { authrim_session: 's', '__Host-authrim_lite': 'b'.repeat(43) }
		});
		const service = (e.platform as { env: { LITE_TXN: { transition: ReturnType<typeof vi.fn> } } })
			.env.LITE_TXN;
		service.transition.mockImplementation(async (call: Record<string, unknown>) => {
			if (call.to === 'completed') throw new Error('rpc failed');
			return { ok: true, txn: txnView({ state: call.to, version: 2, data: call.patch ?? {} }) };
		});
		await (actions.continue as unknown as (e: RequestEvent) => Promise<unknown>)(e);
		await expect(run(e)).resolves.toMatchObject({
			page: 'relay',
			relay: { url: 'https://id.example/authorize?_confirmation_challenge=x' }
		});
	});
});

describe('round 6 review regressions', () => {
	it('relays only to an http(s) destination without user info, else home', async () => {
		const { liteCompletionDestination } = await import('../completion');
		const bound = { publicOrigin: 'https://id.example', returnTo: null };
		for (const redirect of ['https://user@id.example/account', 'blob:https://id.example/1234']) {
			expect(liteCompletionDestination({ redirect_url: redirect }, bound)).toBe(
				'https://id.example/'
			);
			expect(liteCompletionDestination(null, { ...bound, returnTo: redirect })).toBe(
				'https://id.example/'
			);
		}
		expect(
			liteCompletionDestination({ redirect_url: '/authorize?_confirmation_challenge=x' }, bound)
		).toBe('https://id.example/authorize?_confirmation_challenge=x');
	});
});

describe('security review regressions', () => {
	it('draws no proof-guarded form without a challenge', async () => {
		routes['/api/auth/human-verification/pow-challenge'] = () => json({}, 404);
		const page = (await run(event())) as Record<string, unknown>;
		expect(page.page).toBe('error');
	});

	it('refuses a post for a finished transaction or another purpose', async () => {
		for (const txn of [
			txnView({
				state: 'completed',
				data: { flow: { interactionId: 'i', contractHash: 'h', signature: 's' } }
			}),
			txnView({
				state: 'abandoned',
				data: { flow: { interactionId: 'i', contractHash: 'h', signature: 's' } }
			}),
			txnView({
				state: 'pending',
				bound: { ...txnView().bound, purpose: 'signup' },
				data: { flow: { interactionId: 'i', contractHash: 'h', signature: 's' } }
			})
		]) {
			txnState.get = { ok: true, txn };
			await expect(post('/login?/continue', 'txn=txn-1&csrf=csrf-1')).resolves.toMatchObject({
				status: 403
			});
		}
		expect(backendCalls).toEqual([]);
	});
});
