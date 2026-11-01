// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	totpStart: vi.fn(),
	totpVerify: vi.fn(),
	emailSend: vi.fn(),
	emailVerify: vi.fn(),
	flowStart: vi.fn(),
	flowSubmit: vi.fn(),
	evpChallenge: vi.fn()
}));

vi.mock('$app/state', () => ({
	page: { url: new URL('https://tenant.example.test/login'), params: {}, data: {} }
}));
vi.mock('$lib/api/flow-runtime', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/flow-runtime')>();
	return {
		...actual,
		flowRuntimeAPI: {
			start: mocks.flowStart,
			submit: mocks.flowSubmit,
			createEmailVerificationChallenge: mocks.evpChallenge
		}
	};
});
vi.mock('$lib/api/client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/client')>();
	return {
		...actual,
		totpAPI: { ...actual.totpAPI, startLogin: mocks.totpStart, verifyLogin: mocks.totpVerify },
		emailCodeAPI: { ...actual.emailCodeAPI, send: mocks.emailSend, verify: mocks.emailVerify }
	};
});

import { blocks, screenOf } from '$lib/storybook/fixtures';
import Harness from '$lib/testing/LoginPageHarness.svelte';

function methodsResponse(emailCode = false) {
	return {
		methods: {
			passkey: { enabled: true, loginEnabled: true, capabilities: [] },
			emailCode: { enabled: emailCode, loginEnabled: emailCode, digits: 6, steps: [] },
			totp: { enabled: true, loginEnabled: true, digits: 6, steps: [] },
			directoryPassword: { enabled: false, label: 'Organization ID', steps: [] },
			humanVerification: {
				enabled: false,
				provider: 'none',
				siteKey: null,
				loginEnabled: false,
				signupEnabled: false,
				reauthEnabled: false,
				failurePolicy: 'fail_closed',
				widget: { actionPrefix: 'authrim', theme: 'auto', size: 'flexible', mode: 'managed' }
			},
			external: { enabled: false, providers: [] }
		},
		ui: {
			theme: 'default',
			branding: { logoUrl: null, brandName: 'Authrim' },
			supportedLocales: ['en', 'ja'],
			selfService: { accountPageEnabled: true, accountPagePath: '/account' }
		},
		meta: { cacheTTL: 180, revision: 'test' }
	};
}

function flowWith(screen: unknown) {
	return {
		schema_version: 'authrim.login_ui.contract.v1',
		interaction: { id: 'interaction_1', state: 'active', current_step_id: 'auth' },
		contract: {
			flow_kind: 'login',
			ui: {
				steps: [
					{
						id: 'auth',
						source_node_id: 'node_auth',
						component: 'authentication_method_selector',
						render: true,
						config: { screen }
					}
				]
			}
		},
		contract_hash: 'hash',
		signature: 'sig',
		expires_in: 600,
		resumed: false
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	window.matchMedia ??= ((query: string) => ({
		matches: false,
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		onchange: null,
		dispatchEvent: () => false
	})) as typeof window.matchMedia;
	mocks.totpStart.mockResolvedValue({ data: { challenge_id: 'totp-challenge' }, error: null });
	mocks.totpVerify.mockResolvedValue({ data: null, error: { error: 'invalid_code' } });
	mocks.emailSend.mockResolvedValue({ data: {}, error: null });
	mocks.emailVerify.mockResolvedValue({ data: null, error: { error: 'invalid_code' } });
	mocks.flowSubmit.mockResolvedValue({ data: null, error: null });
	mocks.evpChallenge.mockResolvedValue({ data: null });
});

describe('the login page, passkey + authenticator app screen (real DOM)', () => {
	it('starts the authenticator app and then Enter in the code field verifies it, never sending an email code', async () => {
		const screen = screenOf(
			[blocks.heading('Sign in'), blocks.passkey(), blocks.totp()],
			{},
			'login'
		);
		mocks.flowStart.mockResolvedValue({ data: flowWith(screen), error: null });
		const user = userEvent.setup();
		const { container, findByRole, getByRole } = render(Harness, {
			props: { data: { authenticationMethods: methodsResponse() } }
		});

		const email = (await waitFor(() => {
			const input = container.querySelector('input[type="email"]');
			expect(input).not.toBeNull();
			return input;
		})) as HTMLInputElement;
		await user.type(email, 'user@example.com');
		await user.click(await findByRole('button', { name: /authenticator/i }));
		await waitFor(() => expect(mocks.totpStart).toHaveBeenCalled());

		const pin = await waitFor(() => {
			const input = container.querySelector('.pin-code-input__native');
			expect(input).not.toBeNull();
			return input as HTMLInputElement;
		});
		await user.click(pin);
		await user.keyboard('123456');
		await user.keyboard('{Enter}');

		await waitFor(() => expect(mocks.totpVerify).toHaveBeenCalled());
		expect(mocks.emailSend).not.toHaveBeenCalled();
		void getByRole;
	});
});

describe.each([
	[
		'passkey + email code + authenticator app widgets',
		true,
		false,
		[blocks.passkey(), blocks.mailOtp(), blocks.totp()]
	],
	['a combined mail/authenticator widget', true, false, [blocks.passkey(), blocks.mailOtpTotp()]],
	[
		'email code with email verification (submit button)',
		true,
		true,
		[blocks.passkey(), blocks.mailOtp(), blocks.totp()]
	]
])('the same with %s', (_name, emailCode, evp, widgets) => {
	it('Enter in the code field verifies the authenticator app code only', async () => {
		const screen = screenOf([blocks.heading('Sign in'), ...widgets], {}, 'login');
		mocks.flowStart.mockResolvedValue({ data: flowWith(screen), error: null });
		const user = userEvent.setup();
		const { container, findAllByRole } = render(Harness, {
			props: {
				data: {
					authenticationMethods: methodsResponse(emailCode),
					emailVerificationProtocolEnabled: evp
				}
			}
		});
		const email = (await waitFor(() => {
			const input = container.querySelector('input[type="email"]');
			expect(input).not.toBeNull();
			return input;
		})) as HTMLInputElement;
		await user.type(email, 'user@example.com');
		const buttons = await findAllByRole('button', { name: /authenticator/i });
		await user.click(buttons[0]);
		await waitFor(() => expect(mocks.totpStart).toHaveBeenCalled());
		const pin = await waitFor(() => {
			const input = container.querySelector('.pin-code-input__native');
			expect(input).not.toBeNull();
			return input as HTMLInputElement;
		});
		await user.click(pin);
		await user.keyboard('123456');
		await user.keyboard('{Enter}');
		await waitFor(() => expect(mocks.totpVerify).toHaveBeenCalled());
		expect(mocks.emailSend).not.toHaveBeenCalled();
	});
});

describe.each([
	['email code off', false, false],
	['email code on', true, false],
	['email code on with email verification', true, true]
])('a Flow with a step of its own for the code (%s)', (_name, emailCode, evp) => {
	it('Enter in the runtime code field verifies the authenticator app code only', async () => {
		const selection = screenOf(
			[blocks.heading('Sign in'), blocks.passkey(), blocks.totp()],
			{},
			'login'
		);
		const codeScreen = screenOf(
			[blocks.heading('Enter your code'), blocks.codeInput()],
			{},
			'login'
		);
		const flow = flowWith(selection);
		const codeStep = {
			id: 'code',
			source_node_id: 'node_code',
			component: 'screen',
			render: true,
			config: { screen: codeScreen }
		};
		flow.contract.ui.steps.push(codeStep as never);
		mocks.flowStart.mockResolvedValue({ data: flow, error: null });
		mocks.flowSubmit.mockResolvedValue({
			data: {
				interaction: { id: 'interaction_1', state: 'active', current_step_id: 'code' },
				step: codeStep,
				completed: false
			},
			error: null
		});
		const user = userEvent.setup();
		const { container, findAllByRole } = render(Harness, {
			props: {
				data: {
					authenticationMethods: methodsResponse(emailCode),
					emailVerificationProtocolEnabled: evp
				}
			}
		});
		const email = (await waitFor(() => {
			const input = container.querySelector('input[type="email"]');
			expect(input).not.toBeNull();
			return input;
		})) as HTMLInputElement;
		await user.type(email, 'user@example.com');
		const buttons = await findAllByRole('button', { name: /authenticator/i });
		await user.click(buttons[0]);
		await waitFor(() => expect(mocks.totpStart).toHaveBeenCalled());
		const pin = await waitFor(() => {
			const input = container.querySelector('.pin-code-input__native');
			expect(input).not.toBeNull();
			return input as HTMLInputElement;
		});
		await user.click(pin);
		await user.keyboard('123456');
		await user.keyboard('{Enter}');
		await waitFor(() => expect(mocks.totpVerify).toHaveBeenCalled());
		expect(mocks.emailSend).not.toHaveBeenCalled();
		expect(mocks.totpVerify).toHaveBeenCalled();
	});
});

describe('the emailed code screen (real DOM)', () => {
	it('Enter in the code field verifies the emailed code and does not send another', async () => {
		const screen = screenOf(
			[blocks.heading('Sign in'), blocks.passkey(), blocks.mailOtp(), blocks.codeInput()],
			{},
			'login'
		);
		const flow = flowWith(screen);
		mocks.flowStart.mockResolvedValue({ data: flow, error: null });
		mocks.flowSubmit.mockResolvedValue({
			data: { interaction: flow.interaction, step: flow.contract.ui.steps[0], completed: false },
			error: null
		});
		const user = userEvent.setup();
		const { container, findByRole } = render(Harness, {
			props: { data: { authenticationMethods: methodsResponse(true) } }
		});
		const email = (await waitFor(() => {
			const input = container.querySelector('input[type="email"]');
			expect(input).not.toBeNull();
			return input;
		})) as HTMLInputElement;
		await user.type(email, 'user@example.com');
		await user.click(await findByRole('button', { name: /email/i }));
		await waitFor(() => expect(mocks.emailSend).toHaveBeenCalledTimes(1));
		const pin = await waitFor(() => {
			const input = container.querySelector('.pin-code-input__native');
			expect(input).not.toBeNull();
			return input as HTMLInputElement;
		});
		await user.click(pin);
		await user.keyboard('123456');
		await user.keyboard('{Enter}');

		await waitFor(() => expect(mocks.emailVerify).toHaveBeenCalledTimes(1));
		expect(mocks.emailSend).toHaveBeenCalledTimes(1);
	});
});

describe('with email verification, the email code button is a submit button (real DOM)', () => {
	it('Enter in the authenticator-app code field still verifies the code, not the form default button', async () => {
		const screen = screenOf(
			[blocks.heading('Sign in'), blocks.passkey(), blocks.mailOtp(), blocks.totp()],
			{},
			'login'
		);
		mocks.flowStart.mockResolvedValue({ data: flowWith(screen), error: null });
		mocks.evpChallenge.mockResolvedValue({
			data: {
				available: true,
				challenge_id: 'challenge_1',
				nonce: 'nonce_1',
				interaction_id: 'interaction_1',
				step_id: 'auth'
			}
		});
		const user = userEvent.setup();
		const { container, findAllByRole } = render(Harness, {
			props: {
				data: {
					authenticationMethods: methodsResponse(true),
					emailVerificationProtocolEnabled: true
				}
			}
		});
		const email = (await waitFor(() => {
			const input = container.querySelector('input[type="email"]');
			expect(input).not.toBeNull();
			return input;
		})) as HTMLInputElement;
		// The email code button really is the form's submit button here.
		await waitFor(() =>
			expect(container.querySelector('form button[type="submit"]')).not.toBeNull()
		);
		await user.type(email, 'user@example.com');
		await user.click((await findAllByRole('button', { name: /authenticator/i }))[0]);
		await waitFor(() => expect(mocks.totpStart).toHaveBeenCalled());
		const pin = await waitFor(() => {
			const input = container.querySelector('.pin-code-input__native');
			expect(input).not.toBeNull();
			return input as HTMLInputElement;
		});
		await user.click(pin);
		await user.keyboard('123456');
		await user.keyboard('{Enter}');

		await waitFor(() => expect(mocks.totpVerify).toHaveBeenCalled());
		expect(mocks.emailSend).not.toHaveBeenCalled();
	});
});

describe('a runtime screen without authentication widgets beside the classic sign-in (real DOM)', () => {
	async function mountWithClassicLayout(emailCode: boolean, totp: boolean) {
		const screen = screenOf([blocks.heading('Welcome')], {}, 'login');
		const flow = flowWith(screen);
		flow.contract.ui.steps[0].component = 'screen' as never;
		mocks.flowStart.mockResolvedValue({ data: flow, error: null });
		const methods = methodsResponse(emailCode);
		methods.methods.totp = { ...methods.methods.totp, enabled: totp, loginEnabled: totp };
		const result = render(Harness, { props: { data: { authenticationMethods: methods } } });
		const email = (await waitFor(() => {
			const input = result.container.querySelector('input[type="email"]');
			expect(input).not.toBeNull();
			return input;
		})) as HTMLInputElement;
		return { ...result, email };
	}

	it('Enter in the classic email field sends the email code when that is the only method', async () => {
		const user = userEvent.setup();
		const { email } = await mountWithClassicLayout(true, false);
		await user.type(email, 'user@example.com');
		await user.keyboard('{Enter}');
		await waitFor(() => expect(mocks.emailSend).toHaveBeenCalled());
		expect(mocks.totpStart).not.toHaveBeenCalled();
	});

	it('Enter in the classic email field does nothing when both methods are offered', async () => {
		const user = userEvent.setup();
		const { email } = await mountWithClassicLayout(true, true);
		await user.type(email, 'user@example.com');
		await user.keyboard('{Enter}');
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(mocks.emailSend).not.toHaveBeenCalled();
		expect(mocks.totpStart).not.toHaveBeenCalled();
	});
});
