import { describe, expect, it } from 'vitest';
import type { FlowRuntimeStep } from '#lib/api/flow-runtime.js';
import {
	hasInteractiveAccountActionUi,
	runtimeAutoSubmitHandle,
	runtimeContinuationString,
	runtimeSamlContinuationPath
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
