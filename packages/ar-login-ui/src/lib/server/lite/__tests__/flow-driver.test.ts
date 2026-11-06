import { describe, expect, it, vi } from 'vitest';
import type { FlowRuntimeStep } from '#lib/api/flow-runtime.js';
import {
	decideLiteStep,
	readFlowStartAnswer,
	safeLinkHref,
	readKeptFlow,
	resumeLiteFlow,
	startLiteLoginFlow
} from '../flow-driver';
import { createLiteBackendClient } from '../backend-client';

const step = (overrides: Partial<FlowRuntimeStep> & Record<string, unknown>): FlowRuntimeStep =>
	({ id: 's1', source_node_id: 'n1', component: 'screen', render: true, ...overrides }) as never;

const startAnswer = (current: FlowRuntimeStep) => ({
	interaction: { id: 'int-1', state: 'active', current_step_id: current.id },
	contract: { ui: { steps: [current] } },
	contract_hash: 'hash-1',
	signature: 'sig-1'
});

function pageLoadBackend(respond: (url: string, init: RequestInit) => Response) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const backend = createLiteBackendClient({
		fetcher: {
			fetch: vi.fn(async (url: string, init: RequestInit) => {
				calls.push({ url, init });
				return respond(url, init);
			})
		},
		publicOrigin: 'https://id.example',
		backendBaseUrl: 'https://backend.internal/',
		cookieHeader: null,
		clientIp: '203.0.113.1',
		originVerified: false,
		mode: 'page_load'
	});
	return { backend, calls };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('the lite Flow driver on a page view', () => {
	it('starts a sign-in Flow for the client of the authorization request, with the public origin', async () => {
		const current = step({ id: 's1' });
		const { backend, calls } = pageLoadBackend(() => json(startAnswer(current)));
		const started = await startLiteLoginFlow(
			backend,
			{
				clientId: 'client-1',
				authorizationChallengeId: 'ch-1',
				samlRequestId: null,
				samlSpEntityId: null,
				returnTo: null
			},
			'ja'
		);
		expect(started).toMatchObject({
			ok: true,
			view: { state: { interactionId: 'int-1', contractHash: 'hash-1', signature: 'sig-1' } }
		});
		expect(calls[0]?.url).toBe('https://id.example/api/v1/login/interactions/start');
		expect(new Headers(calls[0]?.init.headers).get('origin')).toBe('https://id.example');
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			flow_kind: 'login',
			locale: 'ja',
			authorization_challenge_id: 'ch-1',
			target_type: 'oidc_client',
			target_id: 'client-1',
			client_id: 'client-1'
		});
	});

	it('resumes a kept Flow and takes the new hash and signature', async () => {
		const current = step({ id: 's2' });
		const { backend, calls } = pageLoadBackend(() =>
			json({ ...startAnswer(current), contract_hash: 'hash-2', signature: 'sig-2' })
		);
		const resumed = await resumeLiteFlow(
			backend,
			{ interactionId: 'int-1', contractHash: 'hash-1', signature: 'sig-1' },
			'en'
		);
		expect(resumed).toMatchObject({
			ok: true,
			view: { state: { contractHash: 'hash-2', signature: 'sig-2' }, step: { id: 's2' } }
		});
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			resume_interaction_id: 'int-1',
			contract_hash: 'hash-1',
			signature: 'sig-1',
			locale: 'en'
		});
	});

	it('answers a refused start with its error, and a malformed one as flow_malformed', async () => {
		const refused = pageLoadBackend(() => json({ error: 'authorization_request_expired' }, 400));
		await expect(
			startLiteLoginFlow(
				refused.backend,
				{
					clientId: null,
					authorizationChallengeId: 'ch',
					samlRequestId: null,
					samlSpEntityId: null,
					returnTo: null
				},
				'en'
			)
		).resolves.toEqual({ ok: false, error: 'authorization_request_expired', status: 400 });
		const malformed = pageLoadBackend(() => json({ interaction: {} }));
		await expect(
			resumeLiteFlow(
				malformed.backend,
				{ interactionId: 'i', contractHash: 'h', signature: 's' },
				'en'
			)
		).resolves.toEqual({ ok: false, error: 'flow_malformed', status: 502 });
	});

	it('never submits a step from a page view', async () => {
		const { backend } = pageLoadBackend(() => json({}));
		await expect(
			backend.request('/api/v1/login/interactions/int-1/submit', { json: { step_id: 's1' } })
		).rejects.toThrow('lite_backend_not_allowed_on_page_load');
	});
});

describe('decideLiteStep', () => {
	it('offers a Continue form for a step the SPA submits on its own', () => {
		expect(decideLiteStep(step({ component: 'completion' }))).toEqual({ kind: 'continue' });
		expect(decideLiteStep(step({ component: 'session_check', render: false }))).toEqual({
			kind: 'continue'
		});
		expect(decideLiteStep(step({ component: 'account_action' }))).toEqual({ kind: 'continue' });
	});

	it('draws the fields of a screen, skipping hidden ones', () => {
		const decided = decideLiteStep(
			step({
				config: {
					screen: {
						display_name: 'Sign in',
						fields: [
							{ block_type: 'heading', field: 'h', label: 'Welcome' },
							{ field: 'email', label: 'Email', required: true },
							{
								block_type: 'auth_widget',
								field: 'm',
								label: 'Send code',
								auth_method: 'mail_otp'
							},
							{ block_type: 'text', field: 't', label: 'x', display_condition: { mode: 'hidden' } }
						]
					}
				}
			})
		);
		expect(decided).toMatchObject({
			kind: 'screen',
			title: 'Sign in',
			fields: [
				{ blockType: 'heading', label: 'Welcome' },
				{ blockType: 'identity_field', field: 'email', required: true },
				{ blockType: 'auth_widget', authMethod: 'mail_otp' }
			]
		});
	});

	it('stops, with the reasons, on anything the lite UI cannot draw or drive', () => {
		expect(
			decideLiteStep(
				step({
					config: {
						screen: {
							fields: [
								{ block_type: 'captcha_widget', field: 'c' },
								{ block_type: 'auth_widget', field: 'p', auth_method: 'directory_password' }
							]
						}
					}
				})
			)
		).toEqual({
			kind: 'unsupported',
			reasons: ['block:captcha_widget', 'method:directory_password']
		});
		expect(decideLiteStep(step({ component: 'mystery' as never }))).toEqual({
			kind: 'unsupported',
			reasons: ['component:mystery']
		});
		expect(decideLiteStep(step({ component: 'authentication_method_selector' }))).toEqual({
			kind: 'unsupported',
			reasons: ['screen_missing:authentication_method_selector']
		});
		expect(decideLiteStep(null)).toEqual({ kind: 'unsupported', reasons: ['step_missing'] });
	});
});

describe('a yes/no field', () => {
	it("keeps an identity field's boolean value type, and only an identity field's", () => {
		const decision = decideLiteStep(
			step({
				config: {
					screen: {
						fields: [
							{ field: 'newsletter', label: 'News', required: false, value_type: 'boolean' },
							{ block_type: 'text', field: 't', label: '', text: 'x', value_type: 'boolean' }
						]
					}
				}
			})
		);
		expect(decision.kind === 'screen' && decision.fields.map((f) => f.valueType)).toEqual([
			'boolean',
			null
		]);
	});

	it('still refuses the checkbox and choice parts (their answers have nowhere to go yet)', () => {
		const decision = decideLiteStep(
			step({
				config: {
					screen: { fields: [{ block_type: 'checkbox', field: 'c', label: 'C', required: true }] }
				}
			})
		);
		expect(decision).toEqual({ kind: 'unsupported', reasons: ['block:checkbox'] });
	});
});

describe('the kept Flow', () => {
	it('reads back only a complete one', () => {
		expect(
			readKeptFlow({ flow: { interactionId: 'i', contractHash: 'h', signature: 's' } })
		).toEqual({ interactionId: 'i', contractHash: 'h', signature: 's' });
		expect(readKeptFlow({ flow: { interactionId: 'i' } })).toBeNull();
		expect(readKeptFlow({})).toBeNull();
	});

	it('finds the current step in the contract', () => {
		const view = readFlowStartAnswer(startAnswer(step({ id: 'x' })));
		expect(view?.step?.id).toBe('x');
	});
});

describe('a page narrower than the lite UI', () => {
	it('stops on a block or method that page does not do yet', () => {
		const screen = step({
			config: {
				screen: {
					fields: [
						{ block_type: 'consent_widget', field: 'c' },
						{ block_type: 'auth_widget', field: 'p', auth_method: 'passkey' },
						{ block_type: 'auth_widget', field: 'm', auth_method: 'mail_otp' }
					]
				}
			}
		});
		expect(
			decideLiteStep(screen, {
				blocks: new Set(['auth_widget']),
				methods: new Set(['mail_otp'])
			})
		).toEqual({ kind: 'unsupported', reasons: ['block:consent_widget', 'method:passkey'] });
	});
});

describe('safeLinkHref', () => {
	it('keeps an anchor, a local path and an https URL, and nothing else', () => {
		expect(safeLinkHref('#help')).toBe('#help');
		expect(safeLinkHref('/signup?x=1')).toBe('/signup?x=1');
		expect(safeLinkHref('https://help.example/a')).toBe('https://help.example/a');
		for (const bad of [
			'javascript:alert(1)',
			'data:text/html,x',
			'http://help.example/',
			'//evil.example/',
			'/\\evil.example/',
			'https://user:pass@help.example/',
			'#1bad',
			'/a\nb',
			42,
			''
		]) {
			expect(safeLinkHref(bad)).toBeNull();
		}
	});
});
