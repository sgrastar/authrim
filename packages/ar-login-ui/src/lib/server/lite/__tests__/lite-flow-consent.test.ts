/**
 * A Flow step's consent on the lite sign-in page (PR5d): drawn in full through its screen's
 * consent part, accepted before anything is started, and submitted with the step (a sign-in's
 * choice, or the consent step's Continue). The transaction store is the sign-in tests' model.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { actions, load } from '../../../../routes/__lite/login/+page.server';
import { liteConsentDigest, readLiteFlowConsent, type LiteFlowConsent } from '../flow-consent';

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
		event({
			action,
			form: {
				txn: 'txn-1',
				csrf: 'csrf-1',
				op: OP,
				// A Continue names the step its page was drawn on (the one the Flow is on).
				...(action === 'step_continue' ? { 'step-key': `int-1:${String(currentStep.id)}` } : {}),
				...form
			},
			query
		})
	);
const view = (query?: string) =>
	(load as unknown as (e: RequestEvent) => Promise<Record<string, unknown>>)(event({ query }));
const paths = () => calls.map((call) => call.path);
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

const POLICY = {
	id: 'policy-1',
	display_name: 'Login consent',
	description: null,
	language: 'en',
	default_language: 'en',
	items: [
		{
			statement_id: 'tos',
			slug: 'tos',
			category: 'terms',
			title: 'Terms <script>x</script>',
			description: 'Read <a href="https://d.example/t">them</a>',
			document_url: 'https://d.example/terms',
			inline_content: null,
			version: '1',
			version_id: 'v1',
			is_required: true,
			content_mode: 'checkbox',
			checkbox_mode: 'required',
			checkbox_default_checked: false,
			display_order: 1
		},
		{
			statement_id: 'share',
			slug: 'share',
			category: 'data',
			title: 'Sharing',
			description: '',
			document_url: null,
			inline_content: null,
			version: '1',
			version_id: 'v2',
			is_required: false,
			content_mode: 'radio',
			options: [
				{ id: 'o1', value: 'once', label: 'Once', description: '' },
				{ id: 'o2', value: 'always', label: 'Always', description: '' }
			],
			checkbox_mode: 'optional',
			checkbox_default_checked: false,
			display_order: 2
		}
	]
};
const WIDGET = { block_type: 'consent_widget', field: 'consent.policy', label: 'Consent' };
const CONSENT_STEP = {
	id: 'consent',
	source_node_id: 'n-consent',
	component: 'consent_policy',
	render: true,
	config: { screen: { display_name: 'Consent', fields: [WIDGET] } },
	content: {
		consent_policy: POLICY,
		destination_field_consent: {
			profile_id: 'p',
			profile_version_id: 'pv',
			destination_type: 'oidc',
			fields: [{ key: 'email', label: 'Email', required: true }]
		}
	}
};
const SIGN_IN_WITH_CONSENT = {
	...SELECT_STEP,
	id: 'select-consent',
	config: {
		screen: {
			display_name: 'Sign in',
			fields: [...SELECT_STEP.config.screen.fields, WIDGET]
		}
	},
	content: { consent_policy: POLICY }
};
/** The digest a page drawing the step's consent puts in its form. */
const keyOf = (step: unknown) =>
	liteConsentDigest(readLiteFlowConsent(step as never) as LiteFlowConsent, 'int-1');
const submitted = () =>
	calls
		.filter((call) => call.path.endsWith('/submit'))
		.map((call) => ({ handle: call.body.selected_handle, input: call.body.input }));

describe('a consent step', () => {
	beforeEach(() => {
		currentStep = CONSENT_STEP;
		routes['/api/v1/login/interactions/int-1/submit'] = (body) =>
			body.selected_handle === 'accepted'
				? json({ completed: true, output: { redirect_url: 'https://id.example/after' } })
				: json({ error: 'invalid_handle' }, 400);
	});

	it('draws its items and fields in full, sanitized, with a Continue of its own', async () => {
		const page = await view();
		expect(page.decision).toMatchObject({ kind: 'screen' });
		expect(page.stepContinue).toBe(true);
		const consent = page.consent as {
			items: Array<{
				id: string;
				title: string;
				descriptionHtml: string;
				display: string;
				link: string | null;
				frame: string | null;
			}>;
			fields: unknown[];
		};
		expect(consent.items.map((item) => item.id)).toEqual(['tos', 'share']);
		// A link of the words stays a link (its attribute escaped, as the SPA's sanitizer does).
		expect(consent.items[0].descriptionHtml).toContain(
			'<a href="https:&#x2F;&#x2F;d.example&#x2F;t"'
		);
		// A document kept elsewhere is a link to it; nothing is framed.
		expect(consent.items[0]).toMatchObject({
			display: 'external',
			link: 'https://d.example/terms',
			frame: null
		});
		expect(consent.fields).toEqual([{ key: 'email', label: 'Email', required: true }]);
	});

	it('submits nothing until the required item and field are accepted', async () => {
		await expect(
			post('step_continue', {
				'consent-key': await keyOf(CONSENT_STEP),
				'consent-field:email': 'granted'
			})
		).resolves.toMatchObject({
			status: 400,
			data: { error: 'consent_required' }
		});
		expect(submitted()).toEqual([]);
	});

	it('submits `accepted` with the decisions, taking only what the step offers from the form', async () => {
		await expect(
			post('step_continue', {
				'consent-key': await keyOf(CONSENT_STEP),
				'consent:tos': 'granted',
				'consent-value:share': 'never-offered',
				'consent-field:email': 'granted',
				'consent:unknown': 'granted'
			})
		).resolves.toEqual({ completed: true });
		expect(submitted()).toEqual([
			{
				handle: 'accepted',
				input: {
					consent_item_decisions: { tos: 'granted', share: 'denied' },
					consent_item_selected_values: { share: '' },
					destination_field_decisions: { email: true }
				}
			}
		]);
	});

	it('puts the digest of what it draws in the form', async () => {
		const page = await view();
		expect(page.consentKey).toBe(await keyOf(CONSENT_STEP));
	});

	it('takes no decision from a form drawn with other terms: the page is drawn again', async () => {
		const drawn = await keyOf(CONSENT_STEP);
		// The terms were updated after the form was drawn (a new version of the same statement).
		currentStep = {
			...CONSENT_STEP,
			content: {
				...CONSENT_STEP.content,
				consent_policy: {
					...POLICY,
					items: [{ ...POLICY.items[0], version: '2', version_id: 'v1-2' }, POLICY.items[1]]
				}
			}
		};
		expect(await keyOf(currentStep)).not.toBe(drawn);
		await expect(
			post('step_continue', {
				'consent-key': drawn,
				'consent:tos': 'granted',
				'consent-field:email': 'granted'
			})
		).rejects.toMatchObject({ status: 303 });
		expect(submitted()).toEqual([]);
	});

	it('decides a shown item as the SPA does: granted without a checkbox or when checked by default', async () => {
		const shown = (id: string, extra: Record<string, unknown>) => ({
			...POLICY.items[0],
			statement_id: id,
			is_required: false,
			content_mode: 'display_only',
			checkbox_mode: 'optional',
			checkbox_default_checked: false,
			...extra
		});
		currentStep = {
			...CONSENT_STEP,
			content: {
				consent_policy: {
					...POLICY,
					items: [
						shown('plain', {}),
						shown('preset', { checkbox_default_checked: true }),
						shown('none', { content_mode: 'checkbox', checkbox_mode: 'none' })
					]
				}
			}
		};
		await expect(
			post('step_continue', {
				'consent-key': await keyOf(currentStep),
				'consent:plain': 'granted'
			})
		).resolves.toEqual({ completed: true });
		expect(submitted()[0].input).toMatchObject({
			consent_item_decisions: { plain: 'denied', preset: 'granted', none: 'granted' }
		});
	});

	it('does not draw a consent part twice, or a form with more fields than a post may carry', async () => {
		currentStep = {
			...CONSENT_STEP,
			config: { screen: { display_name: 'Consent', fields: [WIDGET, { ...WIDGET, field: 'c2' }] } }
		};
		expect((await view()).decision).toEqual({
			kind: 'unsupported',
			reasons: ['consent_drawn_twice']
		});
		const entries = Array.from({ length: 10 }, (_, index) => ({
			field: `entry${index}`,
			label: `Entry ${index}`
		}));
		const items = Array.from({ length: 18 }, (_, index) => ({
			...POLICY.items[0],
			statement_id: `item${index}`
		}));
		// A sign-in screen (its entries are the sign-in's), with its consent.
		currentStep = {
			...SIGN_IN_WITH_CONSENT,
			config: {
				screen: {
					display_name: 'Sign in',
					fields: [...SELECT_STEP.config.screen.fields, ...entries, WIDGET]
				}
			},
			content: { consent_policy: { ...POLICY, items } }
		};
		expect((await view()).decision).toEqual({
			kind: 'unsupported',
			reasons: ['too_many_fields']
		});
	});

	it('keys what it drew in full: a default changed, words changed, another interaction', async () => {
		const drawn = readLiteFlowConsent(CONSENT_STEP as never) as LiteFlowConsent;
		const withPolicy = (item: Record<string, unknown>) =>
			readLiteFlowConsent({
				...CONSENT_STEP,
				content: {
					...CONSENT_STEP.content,
					consent_policy: { ...POLICY, items: [{ ...POLICY.items[0], ...item }, POLICY.items[1]] }
				}
			} as never) as LiteFlowConsent;
		const digest = await liteConsentDigest(drawn, 'int-1');
		for (const changed of [
			withPolicy({ checkbox_default_checked: true }),
			withPolicy({ title: 'Other terms' })
		]) {
			expect(await liteConsentDigest(changed, 'int-1')).not.toBe(digest);
		}
		expect(await liteConsentDigest(drawn, 'int-2')).not.toBe(digest);
	});

	it('does not draw an option whose words are too long, or a decision too large to keep', async () => {
		const radio = POLICY.items[1] as (typeof POLICY.items)[1] & {
			options: Array<Record<string, string>>;
		};
		const withItems = (items: unknown[]) =>
			readLiteFlowConsent({
				...CONSENT_STEP,
				content: { consent_policy: { ...POLICY, items } }
			} as never);
		expect(
			withItems([{ ...radio, options: [{ ...radio.options[0], description: 'x'.repeat(8001) }] }])
		).toBe('unsupported');
		const large = Array.from({ length: 8 }, (_, index) => ({
			...radio,
			statement_id: `share${index}`,
			options: [{ ...radio.options[0], value: 'v'.repeat(256) }]
		}));
		expect(withItems(large)).toBe('unsupported');
		expect(withItems(large.slice(0, 2))).not.toBe('unsupported');
	});

	it('submits the answers of a screen with its consent, as the SPA does (input.fields)', async () => {
		currentStep = {
			...CONSENT_STEP,
			component: 'screen',
			config: {
				screen: {
					display_name: 'About you',
					fields: [
						{ field: 'nickname', label: 'Nickname', required: true },
						{
							block_type: 'select',
							field: 'plan',
							label: 'Plan',
							options: [{ value: 'free' }, { value: 'pro', label: 'Pro' }]
						},
						{ block_type: 'checkbox', field: 'news', label: 'News' },
						WIDGET
					]
				}
			}
		};
		routes['/api/v1/login/interactions/int-1/submit'] = (body) =>
			body.selected_handle === 'submitted'
				? json({ completed: true, output: { redirect_url: 'https://id.example/after' } })
				: json({ error: 'invalid_handle' }, 400);
		const page = await view();
		console.log('DBG', JSON.stringify(page.decision));
		expect(page.stepContinue).toBe(true);
		const consent = {
			'consent-key': await keyOf(currentStep),
			'consent:tos': 'granted',
			'consent-field:email': 'granted'
		};
		// The required answer missing: nothing is submitted, what was entered comes back.
		const refused = (await post('step_continue', { ...consent, plan: 'pro' })) as {
			status: number;
			data: Record<string, unknown>;
		};
		expect(refused.status).toBe(400);
		expect(refused.data).toMatchObject({
			error: 'answer_required',
			answersEcho: { stepKey: 'int-1:consent', answers: { plan: 'pro' } }
		});
		expect(submitted()).toEqual([]);
		await expect(
			post('step_continue', { ...consent, nickname: 'Kai', plan: 'pro', news: 'true' })
		).resolves.toEqual({ completed: true });
		expect(submitted()[0].input).toMatchObject({
			consent_item_decisions: { tos: 'granted' },
			fields: { nickname: 'Kai', plan: 'pro', news: true }
		});
	});

	it('submits a box the person left unticked as false', async () => {
		currentStep = {
			...CONSENT_STEP,
			component: 'screen',
			config: {
				screen: {
					display_name: 'About you',
					fields: [{ block_type: 'checkbox', field: 'news', label: 'News' }]
				}
			},
			content: {}
		};
		routes['/api/v1/login/interactions/int-1/submit'] = () =>
			json({ completed: true, output: { redirect_url: 'https://id.example/after' } });
		await expect(post('step_continue')).resolves.toEqual({ completed: true });
		expect(submitted()[0].input).toEqual({ fields: { news: false } });
	});

	it('goes on from a screen to answer between a code sign-in and its code step', async () => {
		currentStep = SELECT_STEP;
		const ABOUT = {
			...CONSENT_STEP,
			id: 'about',
			component: 'screen',
			config: {
				screen: {
					display_name: 'About you',
					fields: [{ field: 'nickname', label: 'Nickname', required: true }]
				}
			},
			content: {}
		};
		const choose = routes['/api/v1/login/interactions/int-1/submit'];
		routes['/api/v1/login/interactions/int-1/submit'] = (body, init) => {
			if (body.selected_handle === 'mail_otp') {
				currentStep = ABOUT;
				return json({ completed: false, step: ABOUT, interaction: { current_step_id: 'about' } });
			}
			if (body.selected_handle === 'submitted') {
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
			return choose(body, init);
		};
		await post('send_code', {
			email: 'person@example.com',
			human_verification_response: 'p'
		}).catch((thrown: unknown) => thrown);
		await post('verify_code', { code: '123456' }).catch((thrown: unknown) => thrown);
		// Signed in: the screen is drawn with its own Continue, the sign-in still recorded.
		const page = await view();
		expect(page.decision).toMatchObject({ kind: 'screen' });
		expect(page.stepContinue).toBe(true);
		browserCookies = { authrim_session: 's1' };
		await post('step_continue', { nickname: 'Kai' }).catch((thrown: unknown) => thrown);
		expect(submitted().map((call) => call.handle)).toEqual([
			'mail_otp',
			'submitted',
			'verified',
			'completed'
		]);
	});

	it('keeps a code sign-in recorded across a screen of words before its code step', async () => {
		currentStep = SELECT_STEP;
		const WORDS = {
			...CONSENT_STEP,
			id: 'words',
			component: 'screen',
			config: {
				screen: {
					display_name: 'Welcome',
					fields: [{ block_type: 'text', field: 't', text: 'Hi' }]
				}
			},
			content: {}
		};
		const choose = routes['/api/v1/login/interactions/int-1/submit'];
		routes['/api/v1/login/interactions/int-1/submit'] = (body, init) => {
			if (body.selected_handle === 'mail_otp') {
				currentStep = WORDS;
				return json({ completed: false, step: WORDS, interaction: { current_step_id: 'words' } });
			}
			if (body.selected_handle === 'submitted') {
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
			return choose(body, init);
		};
		await post('send_code', {
			email: 'person@example.com',
			human_verification_response: 'p'
		}).catch((thrown: unknown) => thrown);
		await post('verify_code', { code: '123456' }).catch((thrown: unknown) => thrown);
		expect((await view()).stepContinue).toBe(true);
		browserCookies = { authrim_session: 's1' };
		await post('step_continue').catch((thrown: unknown) => thrown);
		expect(submitted().map((call) => call.handle)).toEqual([
			'mail_otp',
			'submitted',
			'verified',
			'completed'
		]);
	});

	it('takes no Continue drawn on another step: the page is drawn again', async () => {
		currentStep = { ...CONSENT_STEP, component: 'screen', content: {} };
		await expect(post('step_continue', { 'step-key': 'int-1:earlier' })).rejects.toMatchObject({
			status: 303
		});
		expect(submitted()).toEqual([]);
	});

	it('reads no answer for a part it did not draw, whatever the form holds under its name', async () => {
		currentStep = {
			...CONSENT_STEP,
			component: 'screen',
			config: {
				screen: {
					display_name: 'About you',
					fields: [
						{ field: 'nickname', label: 'Nickname' },
						{
							field: 'hidden_one',
							label: 'Hidden',
							display_condition: { mode: 'feature_enabled', feature: 'passkey' }
						}
					]
				}
			},
			content: {}
		};
		routes['/api/v1/login/interactions/int-1/submit'] = () =>
			json({ completed: true, output: { redirect_url: 'https://id.example/after' } });
		await post('step_continue', { nickname: 'Kai', hidden_one: 'smuggled' }).catch(
			(thrown: unknown) => thrown
		);
		expect(submitted()[0].input).toEqual({ fields: { nickname: 'Kai', hidden_one: null } });
	});

	it('submits the form of a Continue once, posted twice', async () => {
		currentStep = { ...CONSENT_STEP, component: 'screen', content: {} };
		routes['/api/v1/login/interactions/int-1/submit'] = () => json({ error: 'server_error' }, 500);
		await post('step_continue').catch((thrown: unknown) => thrown);
		await post('step_continue').catch((thrown: unknown) => thrown);
		expect(submitted()).toHaveLength(1);
	});

	it('does not draw a part posted under a name the form posts of its own', async () => {
		currentStep = {
			...CONSENT_STEP,
			component: 'screen',
			config: { screen: { display_name: 'About you', fields: [{ field: 'code', label: 'Code' }] } },
			content: {}
		};
		expect((await view()).decision).toEqual({ kind: 'unsupported', reasons: ['field_name'] });
	});

	it('bounds a decision by its bytes, not its characters', async () => {
		const radio = POLICY.items[1] as (typeof POLICY.items)[1] & {
			options: Array<Record<string, string>>;
		};
		const items = Array.from({ length: 6 }, (_, index) => ({
			...radio,
			statement_id: `${index}`.padStart(36, 's'),
			options: [
				{ ...radio.options[0], value: 'a'.repeat(128) },
				{ ...radio.options[1], value: 'あ'.repeat(128) }
			]
		}));
		expect(
			readLiteFlowConsent({
				...CONSENT_STEP,
				content: { consent_policy: { ...POLICY, items } }
			} as never)
		).toBe('unsupported');
	});

	it('holds an item to `is_required` only, as the Flow runtime does', async () => {
		currentStep = {
			...CONSENT_STEP,
			content: {
				consent_policy: {
					...POLICY,
					items: [{ ...POLICY.items[0], is_required: false, checkbox_mode: 'required' }]
				}
			}
		};
		await expect(
			post('step_continue', { 'consent-key': await keyOf(currentStep) })
		).resolves.toEqual({ completed: true });
		expect(submitted()[0].input).toMatchObject({ consent_item_decisions: { tos: 'denied' } });
	});

	it('keys the words of its consent part too', async () => {
		const reworded = {
			...CONSENT_STEP,
			config: { screen: { display_name: 'Consent', fields: [{ ...WIDGET, text: 'New words' }] } }
		};
		expect(await keyOf(reworded)).not.toBe(await keyOf(CONSENT_STEP));
	});

	it('gives a failed post its consent choices back, for its page to draw them as made', async () => {
		routes['/api/v1/login/interactions/int-1/submit'] = () => json({ error: 'server_error' }, 500);
		const key = await keyOf(CONSENT_STEP);
		const answer = (await post('step_continue', {
			'consent-key': key,
			'consent:tos': 'granted',
			'consent-field:email': 'granted'
		})) as { status: number; data: Record<string, unknown> };
		expect(answer.status).toBe(409);
		expect(answer.data.consentEcho).toEqual({
			key,
			choices: { 'consent:tos': 'granted', 'consent-field:email': 'granted' }
		});
	});

	it('goes on from a screen with a consent part and no terms, as the SPA does', async () => {
		currentStep = {
			...CONSENT_STEP,
			component: 'screen',
			content: {}
		};
		routes['/api/v1/login/interactions/int-1/submit'] = (body) =>
			body.selected_handle === 'submitted'
				? json({ completed: true, output: { redirect_url: 'https://id.example/after' } })
				: json({ error: 'invalid_handle' }, 400);
		const page = await view();
		console.log('DBG', JSON.stringify(page.decision));
		expect(page.stepContinue).toBe(true);
		expect(page.consent).toBeNull();
		await expect(post('step_continue')).resolves.toEqual({ completed: true });
		expect(submitted()).toEqual([{ handle: 'submitted', input: { fields: {} } }]);
	});

	it('does not draw a consent its screen has no part for', async () => {
		currentStep = { ...CONSENT_STEP, config: { screen: { display_name: 'Consent', fields: [] } } };
		const page = await view();
		expect(page.decision).toEqual({ kind: 'unsupported', reasons: ['consent_not_drawn'] });
	});

	it('does not draw a consent item it cannot draw in full', async () => {
		currentStep = {
			...CONSENT_STEP,
			content: {
				consent_policy: {
					...POLICY,
					items: [{ ...POLICY.items[0], document_url: 'http://d.example/terms' }]
				}
			}
		};
		const page = await view();
		expect(page.decision).toEqual({ kind: 'unsupported', reasons: ['consent_unsupported'] });
	});
});

describe('a sign-in screen with consent', () => {
	beforeEach(() => {
		currentStep = SIGN_IN_WITH_CONSENT;
	});

	it('sends no code until the required consent is accepted', async () => {
		await expect(
			post('send_code', {
				email: 'person@example.com',
				human_verification_response: 'p',
				'consent-key': await keyOf(SIGN_IN_WITH_CONSENT)
			})
		).resolves.toMatchObject({ status: 400, data: { error: 'consent_required' } });
		expect(paths()).not.toContain('/api/v1/auth/direct/email-code/send');
	});

	it('sends the code, keeping the consent for the choice, which carries it', async () => {
		await expect(
			post('send_code', {
				email: 'person@example.com',
				human_verification_response: 'p',
				'consent-key': await keyOf(SIGN_IN_WITH_CONSENT),
				'consent:tos': 'granted',
				'consent-value:share': 'always'
			})
		).rejects.toMatchObject({ status: 303 });
		expect(paths()).toContain('/api/v1/auth/direct/email-code/send');
		const decisions = {
			consent_item_decisions: { tos: 'granted', share: 'selected' },
			consent_item_selected_values: { share: 'always' },
			destination_field_decisions: {}
		};
		expect(submitted()).toEqual([{ handle: 'mail_otp', input: decisions }]);
		expect(store.txn.data.flowConsent).toEqual({
			interactionId: 'int-1',
			steps: { 'select-consent': { digest: await keyOf(SIGN_IN_WITH_CONSENT), input: decisions } }
		});
	});

	it('takes the consent of the step asking for the code with the code, and submits it with that step', async () => {
		const CODE_WITH_CONSENT = {
			...CODE_STEP,
			config: {
				screen: { ...CODE_STEP.config.screen, fields: [...CODE_STEP.config.screen.fields, WIDGET] }
			},
			content: { consent_policy: { ...POLICY, items: [POLICY.items[0]] } }
		};
		// The contract's code step is this one (not CODE_STEP).
		withCodeStep = false;
		const choose = routes['/api/v1/login/interactions/int-1/submit'];
		routes['/api/v1/login/interactions/int-1/submit'] = (body, init) => {
			if (body.selected_handle !== 'mail_otp') return choose(body, init);
			currentStep = CODE_WITH_CONSENT;
			return json({
				completed: false,
				step: CODE_WITH_CONSENT,
				interaction: { current_step_id: 'code' }
			});
		};
		await expect(
			post('send_code', {
				email: 'person@example.com',
				human_verification_response: 'p',
				'consent-key': await keyOf(SIGN_IN_WITH_CONSENT),
				'consent:tos': 'granted'
			})
		).rejects.toMatchObject({ status: 303 });
		// Its required item, not accepted: the code is not spent.
		await expect(
			post('verify_code', { code: '123456', 'consent-key': await keyOf(CODE_WITH_CONSENT) })
		).resolves.toMatchObject({ status: 400, data: { error: 'consent_required' } });
		expect(paths()).not.toContain('/api/v1/auth/direct/email-code/verify');
		await post('verify_code', {
			code: '123456',
			'consent-key': await keyOf(CODE_WITH_CONSENT),
			'consent:tos': 'granted'
		}).catch((thrown: unknown) => thrown);
		expect(paths()).toContain('/api/v1/auth/direct/email-code/verify');
		const verified = submitted().find((call) => call.handle === 'verified');
		expect(verified?.input).toEqual({
			consent_item_decisions: { tos: 'granted' },
			consent_item_selected_values: {},
			destination_field_decisions: {}
		});
		// Both steps' decisions are kept, each for its own terms.
		expect(Object.keys((store.txn.data.flowConsent as { steps: object }).steps)).toEqual([
			'select-consent',
			'code'
		]);
	});

	it('asks for the terms anew with the Continue when they changed after they were accepted', async () => {
		const choose = routes['/api/v1/login/interactions/int-1/submit'];
		let refuse = true;
		routes['/api/v1/login/interactions/int-1/submit'] = (body, init) =>
			refuse ? json({ error: 'server_error' }, 500) : choose(body, init);
		// Signed in as a guest, the choice still to be submitted (the Flow failed for a moment).
		await post('guest', {
			human_verification_response: 'p',
			'consent-key': await keyOf(SIGN_IN_WITH_CONSENT),
			'consent:tos': 'granted'
		}).catch((thrown: unknown) => thrown);
		expect(paths()).toContain('/api/auth/guest/login');
		// The terms are updated meanwhile: the kept decision was taken for others.
		const UPDATED = {
			...SIGN_IN_WITH_CONSENT,
			content: {
				consent_policy: {
					...POLICY,
					items: [{ ...POLICY.items[0], version: '2', version_id: 'v1-2' }, POLICY.items[1]]
				}
			}
		};
		currentStep = UPDATED;
		refuse = false;
		const page = await view();
		expect(page.decision).toEqual({ kind: 'continue' });
		expect(page.consent).not.toBeNull();
		expect(page.consentKey).toBe(await keyOf(UPDATED));
		// With the words its screen draws them with.
		expect(page.consentWords).toEqual({ label: 'Consent', text: null });
		calls = [];
		// A Continue without them submits nothing for the new terms.
		await post('continue').catch((thrown: unknown) => thrown);
		expect(submitted()).toEqual([]);
		await post('continue', {
			'consent-key': await keyOf(UPDATED),
			'consent:tos': 'granted'
		}).catch((thrown: unknown) => thrown);
		expect(submitted()[0]).toMatchObject({
			handle: 'guest',
			input: { consent_item_decisions: { tos: 'granted', share: 'denied' } }
		});
	});

	it('checks a code on the entry the page makes up, which draws no consent', async () => {
		// No step of its own for the code: the Flow waits at its completion.
		withCodeStep = false;
		const choose = routes['/api/v1/login/interactions/int-1/submit'];
		routes['/api/v1/login/interactions/int-1/submit'] = (body, init) => {
			if (body.selected_handle !== 'mail_otp') return choose(body, init);
			currentStep = COMPLETION;
			return json({ completed: false, step: COMPLETION, interaction: { current_step_id: 'done' } });
		};
		await post('send_code', {
			email: 'person@example.com',
			human_verification_response: 'p',
			'consent-key': await keyOf(SIGN_IN_WITH_CONSENT),
			'consent:tos': 'granted'
		}).catch((thrown: unknown) => thrown);
		const page = await view();
		expect((page.decision as { fields: Array<{ blockType: string }> }).fields).toEqual([
			expect.objectContaining({ blockType: 'code_input_widget' })
		]);
		await post('verify_code', { code: '123456' }).catch((thrown: unknown) => thrown);
		expect(paths()).toContain('/api/v1/auth/direct/email-code/verify');
	});

	it('draws the terms with the decision kept for them, not the defaults', async () => {
		// A sign-in begun with an item unticked, since failed (a wrong authenticator code, say).
		const input = {
			consent_item_decisions: { tos: 'granted', share: 'selected' },
			consent_item_selected_values: { share: 'once' },
			destination_field_decisions: {}
		};
		store.set({
			data: {
				...store.txn.data,
				flowConsent: {
					interactionId: 'int-1',
					steps: { 'select-consent': { digest: await keyOf(SIGN_IN_WITH_CONSENT), input } }
				}
			}
		});
		const page = await view();
		expect(page.consentKept).toEqual({ 'consent:tos': 'granted', 'consent-value:share': 'once' });
		// Kept for other terms: the defaults.
		currentStep = {
			...SIGN_IN_WITH_CONSENT,
			content: { consent_policy: { ...POLICY, items: [{ ...POLICY.items[0], version: '2' }] } }
		};
		expect((await view()).consentKept).toBeNull();
	});

	it('answers the same form posted again with its consent choices, not a page with the defaults', async () => {
		routes['/api/v1/auth/direct/email-code/send'] = () => json({ error: 'server_error' }, 500);
		const form = {
			email: 'person@example.com',
			human_verification_response: 'p',
			'consent-key': await keyOf(SIGN_IN_WITH_CONSENT),
			'consent:tos': 'granted'
		};
		await post('send_code', form);
		// The same form again (Back, then send): its operation is done.
		const again = (await post('send_code', form)) as { data: Record<string, unknown> };
		expect(again.data.consentEcho).toEqual({
			key: form['consent-key'],
			choices: { 'consent:tos': 'granted' }
		});
	});

	it('keeps the choices sent with a code sent again, to draw them for the same terms', async () => {
		withCodeStep = false;
		const optional = {
			...POLICY.items[0],
			statement_id: 'news',
			is_required: false,
			checkbox_mode: 'optional',
			checkbox_default_checked: true
		};
		const CODE_WITH_CONSENT = {
			...CODE_STEP,
			config: {
				screen: { ...CODE_STEP.config.screen, fields: [...CODE_STEP.config.screen.fields, WIDGET] }
			},
			content: { consent_policy: { ...POLICY, items: [optional] } }
		};
		const choose = routes['/api/v1/login/interactions/int-1/submit'];
		routes['/api/v1/login/interactions/int-1/submit'] = (body, init) => {
			if (body.selected_handle !== 'mail_otp') return choose(body, init);
			currentStep = CODE_WITH_CONSENT;
			return json({
				completed: false,
				step: CODE_WITH_CONSENT,
				interaction: { current_step_id: 'code' }
			});
		};
		await post('send_code', {
			email: 'person@example.com',
			human_verification_response: 'p',
			'consent-key': await keyOf(SIGN_IN_WITH_CONSENT),
			'consent:tos': 'granted'
		}).catch((thrown: unknown) => thrown);
		// A minute later, the code sent again with the item unticked.
		const code = store.txn.data.code as Record<string, unknown>;
		store.set({ data: { ...store.txn.data, code: { ...code, sentAt: 0 } } });
		await expect(
			post(
				'resend',
				{ human_verification_response: 'p', 'consent-key': await keyOf(CODE_WITH_CONSENT) },
				undefined
			)
		).rejects.toMatchObject({ status: 303 });
		expect((await view()).consentKept).toEqual({});
	});

	it('keys the screen words in every language', async () => {
		const localized = (text: string) => ({
			...CONSENT_STEP,
			config: {
				screen: {
					display_name: 'Consent',
					fields: [WIDGET],
					localizations: { en: { fields: { 'consent.policy': { text } } } }
				}
			}
		});
		expect(await keyOf(localized('One'))).not.toBe(await keyOf(localized('Two')));
	});

	it('draws the page with the choices of a post that ends with nothing to do (posted again)', async () => {
		const key = await keyOf(SIGN_IN_WITH_CONSENT);
		// An authenticator check with no challenge left (the first post cleared it): the page again.
		const answer = (await post('totp_verify', {
			code: '123456',
			challenge: 'gone',
			'consent-key': key
		})) as { status: number; data: Record<string, unknown> };
		expect(answer.status).toBe(409);
		expect(answer.data.consentEcho).toEqual({ key, choices: {} });
		// Without consent choices, the page is drawn by a GET as before.
		await expect(post('totp_verify', { code: '123456', challenge: 'gone' })).rejects.toMatchObject({
			status: 303
		});
	});

	it('goes on through a consent step between a code sign-in and the code step', async () => {
		// Choice → consent → code → completion: the code is checked while the Flow is on the consent.
		currentStep = SELECT_STEP;
		const choose = routes['/api/v1/login/interactions/int-1/submit'];
		routes['/api/v1/login/interactions/int-1/submit'] = (body, init) => {
			if (body.selected_handle === 'mail_otp') {
				currentStep = CONSENT_STEP;
				return json({
					completed: false,
					step: CONSENT_STEP,
					interaction: { current_step_id: 'consent' }
				});
			}
			if (body.selected_handle === 'accepted') {
				currentStep = CODE_STEP;
				return json({
					completed: false,
					step: CODE_STEP,
					interaction: { current_step_id: 'code' }
				});
			}
			return choose(body, init);
		};
		await post('send_code', {
			email: 'person@example.com',
			human_verification_response: 'p'
		}).catch((thrown: unknown) => thrown);
		await post('verify_code', { code: '123456' }).catch((thrown: unknown) => thrown);
		// Signed in; the consent is asked for with a Continue, the sign-in still recorded.
		const page = await view();
		expect(page.decision).toEqual({ kind: 'continue' });
		expect(page.consent).not.toBeNull();
		// The browser has the session the code made.
		browserCookies = { authrim_session: 's1' };
		await post('continue', {
			'consent-key': await keyOf(CONSENT_STEP),
			'consent:tos': 'granted',
			'consent-field:email': 'granted'
		}).catch((thrown: unknown) => thrown);
		expect(submitted().map((call) => call.handle)).toEqual([
			'mail_otp',
			'accepted',
			'verified',
			'completed'
		]);
	});

	it('draws the kept decision with a Continue, and submits what the Continue shows', async () => {
		const choose = routes['/api/v1/login/interactions/int-1/submit'];
		let refuse = true;
		routes['/api/v1/login/interactions/int-1/submit'] = (body, init) =>
			refuse ? json({ error: 'server_error' }, 500) : choose(body, init);
		await post('guest', {
			human_verification_response: 'p',
			'consent-key': await keyOf(SIGN_IN_WITH_CONSENT),
			'consent:tos': 'granted',
			'consent-value:share': 'always'
		}).catch((thrown: unknown) => thrown);
		refuse = false;
		const page = await view();
		expect(page.decision).toEqual({ kind: 'continue' });
		expect(page.consentKept).toEqual({ 'consent:tos': 'granted', 'consent-value:share': 'always' });
		calls = [];
		await post('continue', {
			'consent-key': await keyOf(SIGN_IN_WITH_CONSENT),
			'consent:tos': 'granted',
			'consent-value:share': 'once'
		}).catch((thrown: unknown) => thrown);
		expect(submitted()[0]).toMatchObject({
			handle: 'guest',
			input: { consent_item_selected_values: { share: 'once' } }
		});
	});

	it('keeps the sign-in recorded across more consent steps than one post takes', async () => {
		const empty = (index: number) => ({
			...CONSENT_STEP,
			id: `empty${index}`,
			content: { consent_policy: { ...POLICY, items: [] } }
		});
		const chain: Array<Record<string, unknown>> = [
			...Array.from({ length: 5 }, (_, index) => empty(index)),
			CONSENT_STEP,
			CODE_STEP
		];
		currentStep = SELECT_STEP;
		const choose = routes['/api/v1/login/interactions/int-1/submit'];
		const goTo = (step: Record<string, unknown>) => {
			currentStep = step;
			return json({ completed: false, step, interaction: { current_step_id: step.id } });
		};
		routes['/api/v1/login/interactions/int-1/submit'] = (body, init) => {
			if (body.selected_handle === 'mail_otp') return goTo(chain[0]);
			if (body.selected_handle === 'accepted') {
				return goTo(chain[chain.findIndex((step) => step.id === currentStep.id) + 1]);
			}
			return choose(body, init);
		};
		withCodeStep = true;
		await post('send_code', {
			email: 'person@example.com',
			human_verification_response: 'p'
		}).catch((thrown: unknown) => thrown);
		await post('verify_code', { code: '123456' }).catch((thrown: unknown) => thrown);
		browserCookies = { authrim_session: 's1' };
		// The rest of the empty steps, then the consent asked for with a Continue.
		await post('continue').catch((thrown: unknown) => thrown);
		expect(currentStep.id).toBe('consent');
		await post('continue', {
			'consent-key': await keyOf(CONSENT_STEP),
			'consent:tos': 'granted',
			'consent-field:email': 'granted'
		}).catch((thrown: unknown) => thrown);
		expect(
			submitted()
				.map((call) => call.handle)
				.slice(-3)
		).toEqual(['accepted', 'verified', 'completed']);
	});

	it('submits a completion that asks for consent with the decision its Continue takes', async () => {
		withCodeStep = false;
		currentStep = SELECT_STEP;
		const WAITING = {
			...COMPLETION,
			id: 'waiting',
			content: { consent_policy: { ...POLICY, items: [POLICY.items[0]] } }
		};
		const choose = routes['/api/v1/login/interactions/int-1/submit'];
		routes['/api/v1/login/interactions/int-1/submit'] = (body, init) => {
			if (body.selected_handle !== 'mail_otp') return choose(body, init);
			currentStep = WAITING;
			return json({ completed: false, step: WAITING, interaction: { current_step_id: 'waiting' } });
		};
		await post('send_code', {
			email: 'person@example.com',
			human_verification_response: 'p'
		}).catch((thrown: unknown) => thrown);
		await post('verify_code', { code: '123456' }).catch((thrown: unknown) => thrown);
		// Never submitted without its decision.
		expect(submitted().map((call) => call.handle)).toEqual(['mail_otp']);
		const page = await view();
		expect(page.decision).toEqual({ kind: 'continue' });
		expect(page.consent).not.toBeNull();
		browserCookies = { authrim_session: 's1' };
		await post('continue', {
			'consent-key': await keyOf(WAITING),
			'consent:tos': 'granted'
		}).catch((thrown: unknown) => thrown);
		expect(submitted().at(-1)).toEqual({
			handle: 'completed',
			input: {
				consent_item_decisions: { tos: 'granted' },
				consent_item_selected_values: {},
				destination_field_decisions: {}
			}
		});
	});

	it('does not draw a step the Flow is advanced through with a consent it cannot draw', async () => {
		currentStep = {
			...COMPLETION,
			id: 'waiting',
			content: {
				consent_policy: {
					...POLICY,
					items: Array.from({ length: 21 }, (_, index) => ({
						...POLICY.items[0],
						statement_id: `item${index}`
					}))
				}
			}
		};
		expect((await view()).decision).toEqual({
			kind: 'unsupported',
			reasons: ['consent_unsupported']
		});
	});

	it('keeps no decision for a post that started nothing', async () => {
		routes['/api/auth/guest/login'] = () => json({ error: 'server_error' }, 500);
		await post('guest', {
			human_verification_response: 'p',
			'consent-key': await keyOf(SIGN_IN_WITH_CONSENT),
			'consent:tos': 'granted'
		}).catch((thrown: unknown) => thrown);
		expect(paths()).toContain('/api/auth/guest/login');
		expect(store.txn.data.flowConsent).toBeUndefined();
	});

	it('starts no guest sign-in without the required consent', async () => {
		await expect(
			post('guest', {
				human_verification_response: 'p',
				'consent-key': await keyOf(SIGN_IN_WITH_CONSENT)
			})
		).resolves.toMatchObject({
			status: 400,
			data: { error: 'consent_required' }
		});
		expect(paths()).not.toContain('/api/auth/guest/login');
	});
});

/** A screen's link part that goes back to the screen before (`link_action: back`): `back`. */
describe('a link back to a screen', () => {
	const SECOND_SCREEN = {
		id: 'second',
		source_node_id: 'n-second',
		component: 'screen',
		render: true,
		config: {
			screen: {
				screen_key: 'step_two',
				display_name: 'A little more',
				fields: [
					{ field: 'note', label: 'Note', block_type: 'identity_field', required: true },
					{ field: 'link.back', label: 'Back', block_type: 'link', link_action: 'back' },
					{
						field: 'link.social',
						label: 'Use a social account',
						block_type: 'link',
						link_action: 'exit',
						link_exit: 'social'
					}
				]
			}
		}
	};
	let backScreens: string[];
	beforeEach(() => {
		currentStep = SECOND_SCREEN;
		backScreens = ['step_one'];
		routes['/api/v1/login/interactions/start'] = () =>
			json({ ...startAnswer(), back_screens: backScreens });
		routes['/api/v1/login/interactions/int-1/back'] = () =>
			json({ completed: false, step: SELECT_STEP, back_screens: [] });
	});
	const back = (form: Record<string, string> = {}) =>
		post('back', { 'step-key': 'int-1:second', 'back-screen': 'step_one', ...form });
	const backCalls = () => calls.filter((call) => call.path.endsWith('/back'));

	it('draws the link with the screens the Flow can go back to', async () => {
		const page = await view();
		expect(page.backScreens).toEqual(['step_one']);
		const fields = (page.decision as { fields: Array<Record<string, unknown>> }).fields;
		expect(fields.filter((field) => field.blockType === 'link')).toMatchObject([
			{ linkAction: 'back', linkExit: null, href: null, linkButton: false },
			{ linkAction: 'exit', linkExit: 'social', href: null }
		]);
	});

	it('goes back through the backend from the screen it was drawn on, then draws the page', async () => {
		await expect(back()).rejects.toMatchObject({ status: 303 });
		expect(backCalls()).toHaveLength(1);
		expect(backCalls()[0].body).toEqual({
			step_id: 'second',
			node_id: 'n-second',
			contract_hash: 'hash-1',
			signature: 'sig-1',
			target_screen: 'step_one'
		});
		// Going back is not a submit: the screen's answers are not sent anywhere.
		expect(submitted()).toEqual([]);
	});

	it('takes a form only from the visit of the screen it was drawn on', async () => {
		// The screen shown again (gone back to and on): another visit, and an earlier tab's form.
		routes['/api/v1/login/interactions/start'] = () => {
			const answer = startAnswer();
			return json({
				...answer,
				interaction: { ...answer.interaction, current_visit_id: 'visit-2' },
				back_screens: backScreens
			});
		};
		expect((await view()).stepKey).toBe('int-1:second:visit-2');
		await expect(back()).rejects.toMatchObject({ status: 303 });
		expect(backCalls()).toEqual([]);
		await expect(back({ 'step-key': 'int-1:second:visit-2' })).rejects.toMatchObject({
			status: 303
		});
		expect(backCalls()).toHaveLength(1);
		// The backend checks the visit too, under its claim (another tab may have moved on since).
		expect(backCalls()[0].body.visit_id).toBe('visit-2');
	});

	it('leaves by an exit of the screen drawn, its answers not taken', async () => {
		routes['/api/v1/login/interactions/int-1/submit'] = () =>
			json({ completed: true, output: { redirect_url: 'https://id.example/after' } });
		// The required note left empty: an exit is not the screen's Continue.
		await expect(
			post('step_exit', { 'step-key': 'int-1:second', 'exit-handle': 'social' })
		).resolves.toEqual({ completed: true });
		expect(submitted()).toEqual([{ handle: 'social', input: {} }]);
	});

	it('leaves by no exit the screen does not offer, nor from an older page', async () => {
		await expect(
			post('step_exit', { 'step-key': 'int-1:second', 'exit-handle': 'admin' })
		).rejects.toMatchObject({ status: 303 });
		await expect(
			post('step_exit', { 'step-key': 'int-1:select', 'exit-handle': 'social' })
		).rejects.toMatchObject({ status: 303 });
		expect(submitted()).toEqual([]);
	});

	it('does not ask the backend for a screen it cannot go back to, or from an older page', async () => {
		backScreens = [];
		await expect(back()).rejects.toMatchObject({ status: 303 });
		backScreens = ['step_one'];
		await expect(back({ 'back-screen': 'step_three' })).rejects.toMatchObject({ status: 303 });
		await expect(back({ 'step-key': 'int-1:select' })).rejects.toMatchObject({ status: 303 });
		expect(backCalls()).toEqual([]);
	});
});
