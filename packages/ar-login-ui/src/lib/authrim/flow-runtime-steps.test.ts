import { describe, expect, it } from 'vitest';
import type { FlowRuntimeStep } from '#lib/api/flow-runtime.js';
import {
	runtimeAutoSubmitHandle,
	runtimeStepIsEmailCheckWithoutScreen,
	shouldRenderRuntimeStep
} from './flow-runtime-steps';

function step(partial: Record<string, unknown>): FlowRuntimeStep {
	return { config: {}, content: {}, render: true, ...partial } as unknown as FlowRuntimeStep;
}

const screen = { fields: [{ block_type: 'heading' }] };

// The sign-up a new tenant is given (the default registration spec's graph, as the runtime
// serves it): the method step carries its screen; the email check has none.
const seededSignUp = [
	step({ id: 'request:step', component: 'interaction_context', render: false }),
	step({
		id: 'registration:step',
		component: 'registration_method_selector',
		config: { output_handles: ['mail_otp', 'passkey'], screen }
	}),
	step({ id: 'email-check:step', component: 'email_verification' }),
	step({ id: 'account-create:step', component: 'account_action', render: false }),
	step({ id: 'output:step', component: 'completion' })
];

// The initial tenant's sign-up (from the baseline migration): no email check.
const baselineSignUp = [
	step({ id: 'request:step', component: 'interaction_context', render: false }),
	step({
		id: 'registration-method:step',
		component: 'registration_method_selector',
		config: { outputs: [{ id: 'passkey' }], output_handles: ['mail_otp', 'passkey'], screen }
	}),
	step({ id: 'account-create:step', component: 'account_action', render: false }),
	step({ id: 'output:step', component: 'completion' })
];

// The seeded sign-in: the method step with its screen, no email check.
const seededSignIn = [
	step({ id: 'request:step', component: 'interaction_context', render: false }),
	step({
		id: 'authentication:step',
		component: 'authentication_method_selector',
		config: { output_handles: ['passkey', 'mail_otp'], screen }
	}),
	step({ id: 'output:step', component: 'completion' })
];

describe('which Flow steps a page draws', () => {
	it('draws the method step through its screen, for the seeded and the baseline sign-up', () => {
		expect(shouldRenderRuntimeStep(seededSignUp[1])).toBe(true);
		expect(shouldRenderRuntimeStep(baselineSignUp[1])).toBe(true);
		expect(shouldRenderRuntimeStep(seededSignIn[1])).toBe(true);
	});

	it('draws nothing for a method step without a screen', () => {
		expect(
			shouldRenderRuntimeStep(step({ component: 'registration_method_selector', config: {} }))
		).toBe(false);
	});

	it('does not draw the email check of the seeded sign-up (no screen, nothing to continue with)', () => {
		const emailCheck = seededSignUp[2];
		expect(runtimeStepIsEmailCheckWithoutScreen(emailCheck)).toBe(true);
		expect(shouldRenderRuntimeStep(emailCheck)).toBe(false);
		// It is a step the person must pass, so the page never submits it on its own either.
		expect(runtimeAutoSubmitHandle(emailCheck)).toBeNull();
	});

	it('draws an email check that has a screen of its own', () => {
		const withScreen = step({
			component: 'email_verification',
			config: { screen: { fields: [{ block_type: 'code_input_widget' }] } }
		});
		expect(runtimeStepIsEmailCheckWithoutScreen(withScreen)).toBe(false);
		expect(shouldRenderRuntimeStep(withScreen)).toBe(true);
	});

	it('still draws consent, more screens and completions', () => {
		expect(shouldRenderRuntimeStep(step({ component: 'consent_policy' }))).toBe(true);
		expect(shouldRenderRuntimeStep(step({ component: 'screen', config: { screen } }))).toBe(true);
		expect(shouldRenderRuntimeStep(seededSignUp[4])).toBe(true);
	});

	it('draws no email check in any of the contracts', () => {
		for (const steps of [seededSignUp, baselineSignUp, seededSignIn]) {
			const drawn = steps
				.filter((candidate) => candidate.render && shouldRenderRuntimeStep(candidate))
				.map((candidate) => candidate.component);
			expect(drawn[0]).toMatch(/_method_selector$/u);
			expect(drawn).not.toContain('email_verification');
		}
	});
});
