/**
 * The sign-in flow as the console holds it (`AccountFlowState`) and the sign-in spec it is saved
 * as (ar-lib-core `LoginFlowSpec`). Both ways, so what is saved reads back the same. A sign-in
 * Flow is set here when it has one authentication step (`readLoginFlowEditor`); saving changes
 * only that step's settings and keeps the rest of the graph (`applyLoginFlowSpec`).
 */
import {
	applyLoginFlowSpec,
	buildLoginFlowEditor,
	canSetSignInConsent,
	readLoginFlowEditor,
	type LoginFlowSpec
} from '@authrim/ar-lib-core/types/login-flow-graph';
import { initialState } from './account-flow-model';
import { MAX_FLOW_CONSENT_STEPS } from '@authrim/ar-lib-core/types/flow-step-condition';
import { consentStepsOf, setConsentSteps } from './consent-field-model';
import { valueOfWhen } from './step-condition-model';
import { completionOf, setCompletion } from './completion-mapping';
import type { AccountFlowState, AccountValue } from './flow-spec';

function text(value: AccountValue | undefined): string {
	return typeof value === 'string' ? value.trim() : '';
}

/** The spec a sign-in flow is saved as. */
export function loginSpecOf(state: AccountFlowState): LoginFlowSpec {
	const values = state.values;
	return {
		profileRef: text(values['login.methodProfile']) || 'default',
		sessionProfileRef: text(values['login.sessionProfile']) || 'default',
		completion: completionOf(values, 'login'),
		unregistered: values['login.unregistered'] === 'guide' ? 'guide' : 'generic',
		onCancel: values['login.onCancel'] === 'error' ? 'error' : 'stay',
		consents: consentStepsOf(state, 'login')
	};
}

/**
 * Whether the console's form can hold everything a spec sets: its consent steps, each shown to
 * everyone or on conditions the form can show. Anything more is shown, not saved (saving would
 * drop it).
 */
export function loginSpecFitsForm(spec: LoginFlowSpec): boolean {
	return (
		spec.consents.length <= MAX_FLOW_CONSENT_STEPS &&
		spec.consents.every((step) => valueOfWhen(step.when) !== null)
	);
}

/** The console's sign-in flow, read from a saved spec (its name and place given apart). */
export function loginStateOf(
	spec: LoginFlowSpec,
	about: { name: string; scope: string }
): AccountFlowState {
	const state = initialState('login');
	const values = state.values;
	values['login.name'] = about.name;
	values['login.scope'] = about.scope;
	values['login.methodProfile'] = spec.profileRef;
	values['login.sessionProfile'] = spec.sessionProfileRef;
	values['login.unregistered'] = spec.unregistered;
	values['login.onCancel'] = spec.onCancel;
	setCompletion(values, spec.completion, 'login');
	setConsentSteps(state, 'login', spec.consents);
	return state;
}

export { applyLoginFlowSpec, buildLoginFlowEditor, canSetSignInConsent, readLoginFlowEditor };
