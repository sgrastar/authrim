// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ emailSend: vi.fn(), flowStart: vi.fn() }));

vi.mock('$app/state', () => ({
	page: { url: new URL('https://tenant.example.test/login'), params: {}, data: {} }
}));
vi.mock('#lib/api/flow-runtime.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/api/flow-runtime.js')>();
	return {
		...actual,
		flowRuntimeAPI: {
			start: mocks.flowStart,
			submit: vi.fn(),
			createEmailVerificationChallenge: vi.fn().mockResolvedValue({ data: null })
		}
	};
});
vi.mock('#lib/api/client.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/api/client.js')>();
	return { ...actual, emailCodeAPI: { ...actual.emailCodeAPI, send: mocks.emailSend } };
});

import { blocks, screenOf } from '#lib/storybook/fixtures.js';
import Harness from '#lib/testing/LoginPageHarness.svelte';

const methods = {
	methods: {
		passkey: { enabled: false, loginEnabled: false, capabilities: [] },
		emailCode: { enabled: true, loginEnabled: true, digits: 6, steps: [] },
		totp: { enabled: false, loginEnabled: false, digits: 6, steps: [] },
		directoryPassword: { enabled: false, label: 'Organization ID', steps: [] },
		humanVerification: {
			enabled: true,
			provider: 'turnstile',
			siteKey: 'site-key',
			loginEnabled: true,
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
		supportedLocales: ['en'],
		selfService: { accountPageEnabled: true, accountPagePath: '/account' }
	},
	meta: { cacheTTL: 180, revision: 'test' }
};

const screen = screenOf(
	[blocks.heading('Sign in'), blocks.security('initial'), blocks.mailOtp()],
	{},
	'login'
);
const flow = {
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

/** The callbacks the (stand-in) Turnstile widget was rendered with: one per widget. */
const widgets: Array<(token: string) => void> = [];
/** How many times the widget was asked to solve again (its token used up). */
const resets = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	widgets.length = 0;
	resets.mockClear();
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
	(window as unknown as { turnstile: unknown }).turnstile = {
		ready: (callback: () => void) => callback(),
		render: (_container: HTMLElement, options: { callback: (token: string) => void }) => {
			widgets.push(options.callback);
			return `widget-${widgets.length}`;
		},
		remove: () => undefined,
		reset: resets,
		execute: () => undefined
	};
	mocks.flowStart.mockResolvedValue({ data: flow, error: null });
	mocks.emailSend.mockResolvedValue({
		data: null,
		error: {
			error: 'account_not_found',
			error_description: 'No account',
			error_details: { sign_up_available: true }
		}
	});
});

describe('the login page, an address with no account (real DOM)', () => {
	it('says so, keeps the address, offers Sign up, and asks for a fresh verification for the next send', async () => {
		const user = userEvent.setup();
		const { container, findByRole, findByText, getByRole } = render(Harness, {
			props: { data: { authenticationMethods: methods } }
		});
		const email = (await waitFor(() => {
			const input = container.querySelector('input[type="email"]');
			expect(input).not.toBeNull();
			return input;
		})) as HTMLInputElement;
		await user.type(email, 'nobody@example.com');

		// The verification is solved first; the code is asked for with that token.
		await waitFor(() => expect(widgets).toHaveLength(1));
		widgets[0]('token-1');
		await user.click(await findByRole('button', { name: /send code/iu }));
		await waitFor(() => expect(mocks.emailSend).toHaveBeenCalledTimes(1));
		expect(mocks.emailSend.mock.calls[0][0]).toMatchObject({
			email: 'nobody@example.com',
			human_verification_response: 'token-1'
		});

		// The message, the Sign up link, the address kept, no code entry.
		expect(await findByText(/No account uses this address/iu)).toBeTruthy();
		expect(getByRole('link', { name: /^sign up$/iu }).getAttribute('href')).toBe('/signup');
		expect(email.value).toBe('nobody@example.com');

		// The used token is gone: the widget solves again, and another send never reuses the old token.
		await waitFor(() => expect(resets).toHaveBeenCalled());
		await user.click(getByRole('button', { name: /send code/iu }));
		expect(mocks.emailSend).toHaveBeenCalledTimes(1);
		widgets[0]('token-2');
		await user.click(getByRole('button', { name: /send code/iu }));
		await waitFor(() => expect(mocks.emailSend).toHaveBeenCalledTimes(2));
		expect(mocks.emailSend.mock.calls[1][0]).toMatchObject({
			human_verification_response: 'token-2'
		});
	});
});
