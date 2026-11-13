import { describe, expect, it } from 'vitest';
import type { FlowRuntimeStep } from '#lib/api/flow-runtime.js';
import {
	hasInteractiveAccountActionUi,
	runtimeAutoSubmitHandle,
	runtimeCodeSuccessHandle,
	runtimeContinuationString,
	runtimeSamlContinuationPath,
	runtimeStepAsksOnlyForEmailCode,
	runtimeStepWaitsForSignIn
} from '../flow-runtime-steps.js';

const step = (overrides: Partial<FlowRuntimeStep>): FlowRuntimeStep =>
	({ id: 'step', component: 'screen', ...overrides }) as FlowRuntimeStep;

describe('runtimeAutoSubmitHandle', () => {
	it('submits a completion step as completed', () => {
		expect(runtimeAutoSubmitHandle(step({ component: 'completion' }))).toBe('completed');
	});

	it('submits an account action that asks nothing as completed', () => {
		expect(runtimeAutoSubmitHandle(step({ component: 'account_action' }))).toBe('completed');
	});

	it.each([{ interaction_ui: true }, { render_ui: true }, { screen_ref: 'profile' }])(
		'stops at an account action that asks the person something (%o)',
		(config) => {
			const accountAction = step({ component: 'account_action', config });
			expect(hasInteractiveAccountActionUi(accountAction)).toBe(true);
			expect(runtimeAutoSubmitHandle(accountAction)).toBeNull();
		}
	);

	it('submits a step the Flow does not render without a handle', () => {
		expect(runtimeAutoSubmitHandle(step({ render: false }))).toBeUndefined();
	});

	it('stops at a step the person must see', () => {
		expect(runtimeAutoSubmitHandle(step({ component: 'screen' }))).toBeNull();
	});
});

describe('runtimeContinuationString', () => {
	it('reads only string values', () => {
		expect(runtimeContinuationString({ protocol: 'saml' }, 'protocol')).toBe('saml');
		expect(runtimeContinuationString({ protocol: 1 }, 'protocol')).toBe('');
		expect(runtimeContinuationString(undefined, 'protocol')).toBe('');
	});
});

describe('runtimeSamlContinuationPath', () => {
	it('builds the IdP SSO path from the continuation', () => {
		expect(
			runtimeSamlContinuationPath(
				{ protocol: 'saml', saml_request_id: 'req 1', saml_sp_entity_id: 'https://sp/x' },
				{}
			)
		).toBe(
			'/saml/idp/sso?saml_request_id=req+1&saml_sp_entity_id=https%3A%2F%2Fsp%2Fx&return_to=saml_sso'
		);
	});

	it('accepts saml_sp_id and falls back to the page query', () => {
		expect(
			runtimeSamlContinuationPath(
				{ protocol: 'saml', saml_sp_id: 'sp-1' },
				{ samlRequestId: 'req-2', samlSpEntityId: 'ignored' }
			)
		).toBe('/saml/idp/sso?saml_request_id=req-2&saml_sp_entity_id=sp-1&return_to=saml_sso');
	});

	it('is null when the continuation is not SAML or a value is missing', () => {
		expect(runtimeSamlContinuationPath({ protocol: 'direct' }, { samlRequestId: 'r' })).toBeNull();
		expect(runtimeSamlContinuationPath({ protocol: 'saml' }, { samlRequestId: 'r' })).toBeNull();
		expect(runtimeSamlContinuationPath(undefined, {})).toBeNull();
	});
});

describe('runtimeStepWaitsForSignIn', () => {
	it.each(['completion', 'condition'] as const)('waits at a %s for the sign-in', (component) => {
		expect(runtimeStepWaitsForSignIn(step({ component, render: false }))).toBe(true);
	});

	it.each(['screen', 'email_verification', 'consent_policy'] as const)(
		'does not wait at a %s',
		(component) => {
			expect(runtimeStepWaitsForSignIn(step({ component }))).toBe(false);
		}
	);
});

describe('runtimeCodeSuccessHandle', () => {
	const codeScreen = { fields: [{ block_type: 'code_input_widget' }] };

	it('submits an email verification as verified', () => {
		expect(runtimeCodeSuccessHandle(step({ component: 'email_verification' }))).toBe('verified');
	});

	it.each([{ config: { screen: codeScreen } }, { content: { screen: codeScreen } }])(
		'submits a screen asking for the code as submitted (%o)',
		(parts) => {
			expect(runtimeCodeSuccessHandle(step({ component: 'screen', ...parts }))).toBe('submitted');
		}
	);

	it('leaves any other step alone', () => {
		expect(runtimeCodeSuccessHandle(step({ component: 'screen', config: {} }))).toBeNull();
		expect(runtimeCodeSuccessHandle(step({ component: 'completion' }))).toBeNull();
	});
});

describe('runtimeStepAsksOnlyForEmailCode', () => {
	const screenOf = (fields: unknown[], content: Record<string, unknown> = {}) =>
		step({ component: 'screen', config: { screen: { fields } }, content });

	it.each([
		[[{ block_type: 'code_input_widget' }]],
		[[{ block_type: 'code_input_widget', code_input_mode: 'auto' }, { block_type: 'text' }]]
	])('is true for a screen asking for the emailed code alone (%j)', (fields) => {
		expect(runtimeStepAsksOnlyForEmailCode(screenOf(fields))).toBe(true);
	});

	it.each([
		['an authenticator code', [{ block_type: 'code_input_widget', code_input_mode: 'totp' }]],
		[
			'an authenticator code by its method',
			[{ block_type: 'code_input_widget', auth_method: 'totp' }]
		],
		[
			'a part with no type (an identity field)',
			[{ block_type: 'code_input_widget' }, { field: 'name', required: true }]
		],
		[
			'another answer',
			[{ block_type: 'code_input_widget' }, { block_type: 'checkbox', required: true }]
		],
		['another sign-in', [{ block_type: 'code_input_widget' }, { block_type: 'auth_widget' }]],
		['no code input', [{ block_type: 'text' }]]
	])('is false for a screen with %s', (_label, fields) => {
		expect(runtimeStepAsksOnlyForEmailCode(screenOf(fields))).toBe(false);
	});

	it('is false for a screen that asks for consent', () => {
		expect(
			runtimeStepAsksOnlyForEmailCode(
				screenOf([{ block_type: 'code_input_widget' }], { consent_policy: { id: 'p', items: [] } })
			)
		).toBe(false);
	});
});
