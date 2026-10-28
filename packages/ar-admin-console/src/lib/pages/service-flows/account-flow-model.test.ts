import { describe, expect, it } from 'vitest';
import { en } from '$lib/i18n/messages/en';
import { ja } from '$lib/i18n/messages/ja';
import {
	aboutPart,
	aboutState,
	accountWizardSteps,
	ACCOUNT_FLOW_IDS,
	canProceedAccount,
	flowName,
	emptyFlowState,
	FLOWS,
	isReady,
	PARTS,
	partsOf,
	partState,
	sampleState,
	shownFields,
	stillToDo,
	summaryRows,
	visibleGroups
} from './account-flow-model';

describe('account flows', () => {
	it('only use messages the catalogs have', () => {
		const keys = new Set<string>();
		for (const flow of Object.values(FLOWS)) {
			keys.add(flow.title).add(flow.subtitle).add(flow.summary);
			keys.add(flow.start.title).add(flow.start.detail).add(flow.end.title).add(flow.end.detail);
			for (const group of flow.groups) keys.add(group.label);
		}
		for (const part of Object.values(PARTS)) {
			keys.add(part.label).add(part.lead);
			if (part.note) keys.add(part.note);
			for (const field of part.fields) {
				keys.add(field.label);
				if (field.hint) keys.add(field.hint);
			}
		}
		for (const key of keys) expect(ja, key).toHaveProperty([key]);
	});

	it('give every choice a text, and every part to exactly one place (the flow itself or a step)', () => {
		for (const part of Object.values(PARTS)) {
			for (const field of part.fields)
				for (const option of field.options()) expect(option.label, field.key).not.toMatch(/^af\./);
		}
		const used = ACCOUNT_FLOW_IDS.flatMap((flow) => [aboutPart(flow), ...partsOf(flow)]);
		expect(new Set(used).size).toBe(used.length);
		expect(used.sort()).toEqual(Object.keys(PARTS).sort());
	});

	it('start with nothing set: no setting is done and nothing is chosen for the person', () => {
		for (const flow of ACCOUNT_FLOW_IDS) {
			const state = emptyFlowState();
			expect(isReady(flow, state)).toBe(false);
			for (const part of visibleGroups(flow, state).flatMap((group) => group.parts))
				expect(partState(part, flow, state)).toBe('required');
			// Every value is said to be unset, none is filled in.
			expect(summaryRows(flow, state).every((row) => row.value === en['sf.value.notSet'])).toBe(
				true
			);
		}
	});

	it('are ready once every required setting is chosen, without the optional steps', () => {
		for (const flow of ACCOUNT_FLOW_IDS) {
			const state = sampleState(flow);
			expect(isReady(flow, state)).toBe(true);
			expect(stillToDo(flow, state)).toEqual([]);
			expect(visibleGroups(flow, state).some((group) => group.optional)).toBe(false);
		}
	});

	it('keep an optional step out of the way until it is added, and then only ask it, not require it', () => {
		const state = emptyFlowState();
		const before = stillToDo('registration', state).length;
		state.added = ['consent'];
		const open = stillToDo('registration', state);
		expect(open.length).toBe(before + 2);
		expect(open.find((part) => part.id === 'reg-statements')?.state).toBe('todo');
		// An optional step left unset does not stop the flow from being ready.
		const ready = sampleState('registration');
		ready.added = ['consent'];
		expect(isReady('registration', ready)).toBe(true);
	});

	it('ask for a provider only when an external one is chosen as a method', () => {
		const state = emptyFlowState();
		state.values['login.methods'] = ['passkey'];
		expect(shownFields('login-methods', state).map((field) => field.key)).toEqual([
			'login.methods'
		]);
		expect(partState('login-methods', 'login', state)).toBe('done');
		state.values['login.methods'] = ['passkey', 'external'];
		expect(partState('login-methods', 'login', state)).toBe('required');
		state.values['login.provider'] = 'acme';
		expect(partState('login-methods', 'login', state)).toBe('done');
	});

	it('leave a field unset in a sample when it is not shown, so choosing it later starts empty', () => {
		const state = sampleState('login');
		expect(state.values['login.methods']).toEqual(['passkey']);
		expect(state.values['login.provider']).toBeUndefined();
		state.values['login.methods'] = ['passkey', 'external'];
		expect(partState('login-methods', 'login', state)).toBe('required');
	});

	it('ask how long a check stays valid only when the address is checked', () => {
		const state = emptyFlowState();
		state.values['reg.emailCheck'] = 'none';
		expect(shownFields('reg-verification', state).map((field) => field.key)).toEqual([
			'reg.emailCheck'
		]);
		state.values['reg.emailCheck'] = 'before';
		expect(shownFields('reg-verification', state).map((field) => field.key)).toContain(
			'reg.expiry'
		);
	});

	it('summarise a choice by its text, and say so when a field has no value', () => {
		const state = emptyFlowState();
		state.values['login.methods'] = ['passkey', 'otp'];
		const rows = summaryRows('login', state);
		expect(rows.find((row) => row.label === en['af.field.methods'])?.value).toBe(
			`${en['af.method.passkey']}, ${en['af.method.otp']}`
		);
		expect(rows.find((row) => row.label === en['af.field.login.lifetime'])?.value).toBe(
			en['sf.value.notSet']
		);
	});

	it('ask for a name and a place first', () => {
		const state = emptyFlowState();
		expect(canProceedAccount('account-about', 'login', state)).toBe(false);
		state.values['login.name'] = 'Partner portal sign-in';
		expect(canProceedAccount('account-about', 'login', state)).toBe(false);
		state.values['login.scope'] = 'other-ui';
		expect(canProceedAccount('account-about', 'login', state)).toBe(true);
		// A name of spaces is no name.
		state.values['login.name'] = '   ';
		expect(canProceedAccount('account-about', 'login', state)).toBe(false);
	});

	it('go by their name, and by what kind of flow they are until they have one', () => {
		expect(flowName('registration', emptyFlowState())).toBe(en['af.flow.registration.title']);
		expect(flowName('login', aboutState('login', 'Standard sign-in', 'default-ui'))).toBe(
			'Standard sign-in'
		);
	});

	it('add the name step to the wizard once the kind is chosen', () => {
		expect(accountWizardSteps('').map((step) => step.id)).toEqual(['where', 'kind']);
		expect(accountWizardSteps('registration').map((step) => step.id)).toEqual([
			'where',
			'kind',
			'account-about'
		]);
	});

	it('can add an extra check to sign-up, and it stays optional', () => {
		const state = sampleState('registration');
		expect(visibleGroups('registration', state).some((group) => group.id === 'extra-check')).toBe(
			false
		);
		state.added = ['extra-check'];
		expect(partState('reg-extra-check', 'registration', state)).toBe('todo');
		expect(isReady('registration', state)).toBe(true);
		state.values['reg.extraWhen'] = ['no-email', 'low-trust'];
		state.values['reg.extraMethod'] = 'email-code';
		state.values['reg.extraExpiry'] = '10m';
		expect(partState('reg-extra-check', 'registration', state)).toBe('done');
		// Sign-in has no such step.
		expect(partsOf('login')).not.toContain('reg-extra-check');
	});
});
