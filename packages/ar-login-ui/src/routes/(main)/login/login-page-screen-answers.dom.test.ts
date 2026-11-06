// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	flowStart: vi.fn(),
	flowSubmit: vi.fn(),
	evpChallenge: vi.fn()
}));

vi.mock('$app/state', () => ({
	page: { url: new URL('https://tenant.example.test/login'), params: {}, data: {} }
}));
vi.mock('#lib/api/flow-runtime.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/api/flow-runtime.js')>();
	return {
		...actual,
		flowRuntimeAPI: {
			start: mocks.flowStart,
			submit: mocks.flowSubmit,
			createEmailVerificationChallenge: mocks.evpChallenge
		}
	};
});

import { blocks, screenOf } from '#lib/storybook/fixtures.js';
import Harness from '#lib/testing/LoginPageHarness.svelte';

const methods = {
	methods: {
		passkey: { enabled: true, loginEnabled: true, capabilities: [] },
		emailCode: { enabled: false, loginEnabled: false, digits: 6, steps: [] },
		totp: { enabled: false, loginEnabled: false, digits: 6, steps: [] },
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
		supportedLocales: ['en'],
		selfService: { accountPageEnabled: true, accountPagePath: '/account' }
	},
	meta: { cacheTTL: 180, revision: 'test' }
};

const answerScreen = screenOf(
	[
		blocks.heading('About you'),
		{ ...blocks.name('given_name', 'Given name'), required: true },
		blocks.tick('newsletter', 'Send me news')
	],
	{},
	'profile_completion'
);

function screenStep(id: string) {
	return {
		id,
		source_node_id: `node_${id}`,
		component: 'screen',
		render: true,
		config: { screen: answerScreen }
	};
}

function flowAt(stepId: string) {
	return {
		schema_version: 'authrim.login_ui.contract.v1',
		interaction: { id: 'interaction_1', state: 'active', current_step_id: stepId },
		contract: { flow_kind: 'login', ui: { steps: [screenStep('first'), screenStep('second')] } },
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
	mocks.evpChallenge.mockResolvedValue({ data: null });
});

describe('the login page, a screen step to answer (real DOM)', () => {
	it('submits what was entered, and the next step starts empty', async () => {
		mocks.flowStart.mockResolvedValue({ data: flowAt('first'), error: null });
		mocks.flowSubmit.mockResolvedValueOnce({
			data: {
				interaction: { id: 'interaction_1', state: 'active', current_step_id: 'second' },
				step: screenStep('second'),
				completed: false,
				output: null
			},
			error: null
		});
		mocks.flowSubmit.mockResolvedValue({ data: null, error: null });
		const user = userEvent.setup();
		const { findByRole, getByRole } = render(Harness, {
			props: { data: { authenticationMethods: methods } }
		});

		await user.type(await findByRole('textbox', { name: /Given name/u }), 'Ada');
		await user.click(getByRole('checkbox', { name: /Send me news/u }));
		await user.click(getByRole('button', { name: /continue/iu }));
		await waitFor(() => expect(mocks.flowSubmit).toHaveBeenCalledTimes(1));
		expect(mocks.flowSubmit.mock.calls[0][1]).toMatchObject({
			step_id: 'first',
			selected_handle: 'submitted',
			input: { fields: { given_name: 'Ada', newsletter: true } }
		});

		// The same parts on the next step: nothing entered there yet, nothing carried over.
		await waitFor(() =>
			expect((getByRole('textbox', { name: /Given name/u }) as HTMLInputElement).value).toBe('')
		);
		expect((getByRole('checkbox', { name: /Send me news/u }) as HTMLInputElement).checked).toBe(
			false
		);
		await user.click(getByRole('button', { name: /continue/iu }));
		await waitFor(() => expect(mocks.flowSubmit).toHaveBeenCalledTimes(2));
		expect(mocks.flowSubmit.mock.calls[1][1]).toMatchObject({
			step_id: 'second',
			input: { fields: { given_name: null, newsletter: null } }
		});
	});
});
