import { describe, expect, it } from 'vitest';
import { en } from '#lib/i18n/messages/en.js';
import { ja } from '#lib/i18n/messages/ja.js';
import {
	aboutPart,
	generalParts,
	aboutState,
	accountWizardSteps,
	ALL_FLOW_IDS,
	canProceedAccount,
	flowName,
	emptyFlowState,
	type FlowId,
	FLOWS,
	isReady,
	PARTS,
	partsOf,
	partState,
	sampleState,
	shownFields,
	stillToDo,
	summaryRows,
	visibleGroups,
	initialState,
	stepOrder,
	groupDef,
	partDef
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
			keys.add(part.label);
			if (part.lead) keys.add(part.lead);
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
		// Every flow that is defined, offered or not.
		const used = (Object.keys(FLOWS) as FlowId[]).flatMap((flow) => [
			aboutPart(flow),
			...generalParts(flow),
			...partsOf(flow)
		]);
		expect(new Set(used).size).toBe(used.length);
		expect(used.sort()).toEqual(Object.keys(PARTS).sort());
	});

	it('keep the sign-up settings that apply to the whole flow out of its steps', () => {
		expect(generalParts('registration')).toEqual(['reg-general', 'reg-verification']);
		for (const part of generalParts('registration'))
			expect(partsOf('registration')).not.toContain(part);
		// The steps left: sign-in methods, the screen (more screens and consent can be
		// added), and what happens after sign-up at the end.
		expect(FLOWS.registration.groups.map((group) => group.id)).toEqual([
			'identity',
			'screen',
			'extra-screen',
			'consent',
			'complete'
		]);
		// After completion: where to go, and the details of the choice.
		expect(PARTS['reg-result'].fields[0]).toMatchObject({
			key: 'reg.sessionProfile',
			initial: 'default'
		});
		expect(PARTS['reg-result'].fields[1]).toMatchObject({ key: 'reg.after', initial: 'account' });
		expect(PARTS['reg-result'].fields[1].options().map((option) => option.value)).toEqual([
			'account',
			'home',
			'custom_url',
			'app_login',
			'saml_login',
			'service_site'
		]);
		expect(PARTS['reg-general'].fields.map((field) => field.key)).toEqual([
			'reg.duplicate',
			'reg.policy',
			'reg.domains',
			'reg.denied'
		]);
		// How a sign-in is checked applies to the whole sign-in flow.
		expect(generalParts('login')).toEqual(['login-validation']);
		// Unset, they hold the flow back like any required setting, and are listed after the name.
		const open = stillToDo('registration', emptyFlowState()).map((part) => part.id);
		expect(open.slice(0, 3)).toEqual(['reg-about', 'reg-general', 'reg-verification']);
	});

	it('start a new sign-up with its flow-wide settings, profile and built-in screen chosen', () => {
		const state = initialState('registration');
		// The flow-wide settings start with the safer choices, and what sign-up does today.
		expect(state.values).toEqual({
			'reg.duplicate': 'mail',
			'reg.policy': 'open',
			'reg.denied': 'generic',
			'reg.emailCheck': 'before',
			'reg.extraWhen': ['no-email', 'unverified'],
			'reg.expiry': '5m',
			'reg.after': 'account',
			'reg.appScope': 'openid profile email',
			'reg.methodProfile': 'default',
			'reg.sessionProfile': 'default',
			'reg.screen': 'registration'
		});
		for (const part of generalParts('registration'))
			expect(partState(part, 'registration', state)).toBe('done');
		expect(partState('reg-methods', 'registration', state)).toBe('done');
		expect(partState('reg-screen', 'registration', state)).toBe('done');
		expect(PARTS['reg-screen'].fields[0]).toMatchObject({
			kind: 'screen',
			screenKinds: ['registration']
		});
		// A flow made from the list or the wizard starts the same way.
		expect(aboutState('registration', 'Sign-up', 'default-ui').values['reg.methodProfile']).toBe(
			'default'
		);
		// A sign-in starts with the tenant's default sign-in method profile.
		expect(initialState('login').values).toEqual({
			'login.methodProfile': 'default',
			'login.sessionProfile': 'default',
			'login.after': 'tenant',
			'login.appScope': 'openid profile email',
			// The safe answers until set: the same reply for everyone, and staying on the page.
			'login.unregistered': 'generic',
			'login.onCancel': 'stay'
		});
	});

	it('start a sign-up ready to use, with nothing but a name and a place given', () => {
		// What the console sets up for a new tenant: it can sign people up at once.
		const state = aboutState('registration', 'Standard sign-up', 'default-ui');
		expect(stillToDo('registration', state).filter((part) => part.state === 'required')).toEqual(
			[]
		);
		expect(isReady('registration', state)).toBe(true);
	});

	it('add more screens as steps of their own, each with its screen', () => {
		const state = sampleState('registration');
		expect(stepOrder('registration', state)).toEqual([
			'identity',
			'screen',
			'extra-screen:1',
			'consent',
			'complete'
		]);
		// Added twice: two steps, the next one offered after them.
		state.added = ['extra-screen:1', 'extra-screen:2'];
		expect(visibleGroups('registration', state).map((group) => group.id)).toContain(
			'extra-screen:2'
		);
		expect(stepOrder('registration', state).slice(2, 5)).toEqual([
			'extra-screen:1',
			'extra-screen:2',
			'extra-screen:3'
		]);
		expect(groupDef('registration', 'extra-screen:2')?.parts).toEqual(['reg-extra-screen:2']);
		expect(partDef('reg-extra-screen:2').fields[0]).toMatchObject({
			key: 'reg.extraScreen:2',
			kind: 'screen',
			screenKinds: ['registration', 'custom']
		});
		// Optional: an unset one does not hold the flow back, and each is set on its own.
		expect(partState('reg-extra-screen:1', 'registration', state)).toBe('todo');
		expect(isReady('registration', state)).toBe(true);
		state.values['reg.extraScreen:1'] = 'welcome_survey';
		expect(partState('reg-extra-screen:1', 'registration', state)).toBe('done');
		expect(partState('reg-extra-screen:2', 'registration', state)).toBe('todo');
		// No more than five.
		state.added = [1, 2, 3, 4, 5].map((n) => `extra-screen:${n}`);
		expect(stepOrder('registration', state).filter((id) => id.startsWith('extra'))).toHaveLength(5);
	});

	it('ask for the details of where to go after completion, by the choice', () => {
		const state = initialState('registration');
		const keys = () =>
			shownFields('reg-result', state)
				.map((field) => field.key)
				.filter((key) => key !== 'reg.sessionProfile');
		expect(keys()).toEqual(['reg.after']);
		state.values['reg.after'] = 'home';
		expect(keys()).toEqual(['reg.after']);
		state.values['reg.after'] = 'custom_url';
		expect(keys()).toEqual(['reg.after', 'reg.redirectUrl']);
		expect(partState('reg-result', 'registration', state)).toBe('required');
		state.values['reg.after'] = 'app_login';
		expect(keys()).toEqual([
			'reg.after',
			'reg.appClient',
			'reg.appRedirectUri',
			'reg.appScope',
			'reg.appReturnTo'
		]);
		state.values['reg.after'] = 'saml_login';
		expect(keys()).toEqual(['reg.after', 'reg.samlSp', 'reg.samlRelayState']);
		expect(partState('reg-result', 'registration', state)).toBe('required');
		state.values['reg.samlSp'] = 'https://lms.example.edu/shibboleth';
		expect(partState('reg-result', 'registration', state)).toBe('done');
		state.values['reg.after'] = 'service_site';
		expect(keys()).toEqual(['reg.after', 'reg.servicePath']);
	});

	it('start with nothing set: no setting is done and nothing is chosen for the person', () => {
		for (const flow of ALL_FLOW_IDS) {
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
		for (const flow of ALL_FLOW_IDS) {
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
		expect(open.length).toBe(before + 1);
		expect(open.find((part) => part.id === 'reg-statements')?.state).toBe('todo');
		// An optional step left unset does not stop the flow from being ready.
		const ready = sampleState('registration');
		ready.added = ['consent'];
		expect(isReady('registration', ready)).toBe(true);
	});

	it('sign in with a method profile, the default one from the start, and no step-up step', () => {
		const state = initialState('login');
		expect(shownFields('login-methods', state).map((field) => field.key)).toEqual([
			'login.methodProfile'
		]);
		expect(partState('login-methods', 'login', state)).toBe('done');
		expect(FLOWS.login.groups.map((group) => group.id)).toEqual([
			'authenticate',
			'consent',
			'finish'
		]);
		// Consent is an optional step with the same list setting as sign-up's.
		expect(FLOWS.login.groups[1]).toMatchObject({ optional: true, parts: ['login-statements'] });
		expect(PARTS['login-statements'].fields[0]).toMatchObject({ kind: 'consent-statements' });
		expect(PARTS['reg-statements'].fields[0]).toMatchObject({ kind: 'consent-statements' });
		expect(PARTS).not.toHaveProperty('reg-policy');
	});

	it('leave a field unset in a sample when it is not shown, so choosing it later starts empty', () => {
		const state = sampleState('registration');
		expect(state.values['reg.after']).toBe('account');
		expect(state.values['reg.redirectUrl']).toBeUndefined();
		state.values['reg.after'] = 'custom_url';
		expect(partState('reg-result', 'registration', state)).toBe('required');
	});

	it('ask how long a check stays valid only when an address is checked', () => {
		const state = emptyFlowState();
		state.values['reg.emailCheck'] = 'none';
		expect(shownFields('reg-verification', state).map((field) => field.key)).not.toContain(
			'reg.expiry'
		);
		state.values['reg.emailCheck'] = 'before';
		expect(shownFields('reg-verification', state).map((field) => field.key)).toContain(
			'reg.expiry'
		);
	});

	it('sign in with a session profile, and leave where to go to the tenant unless set', () => {
		const state = initialState('login');
		expect(state.values['login.sessionProfile']).toBe('default');
		expect(state.values['login.after']).toBe('tenant');
		expect(partState('login-session', 'login', state)).toBe('done');
		expect(partState('login-result', 'login', state)).toBe('done');
		expect(FLOWS.login.groups.find((group) => group.id === 'finish')?.parts).toEqual([
			'login-session',
			'login-result'
		]);
		// Its choices: what an unknown address is told, and what stopping does; failures are shown.
		expect(PARTS['login-validation'].fields.map((field) => field.key)).toEqual([
			'login.unregistered',
			'login.onCancel'
		]);
		expect(PARTS['login-validation'].info).toBe('failed-sign-ins');
	});

	it('summarise a choice by its text, and say so when a field has no value', () => {
		const state = emptyFlowState();
		state.values['login.after'] = 'custom_url';
		const rows = summaryRows('login', state);
		expect(rows.find((row) => row.label === en['af.field.reg.after'])?.value).toBe(
			en['af.after.custom_url']
		);
		expect(rows.find((row) => row.label === en['af.field.reg.redirectUrl'])?.value).toBe(
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

	it('verify sign-ups through another provider by email too, with the one expiry', () => {
		const state = sampleState('registration');
		state.values['reg.emailCheck'] = 'none';
		delete state.values['reg.expiry'];
		// Not checking the address, and no extra check: nothing more is asked.
		expect(partState('reg-verification', 'registration', state)).toBe('done');
		// The extra check is optional, but once chosen it needs the expiry of the email.
		state.values['reg.extraWhen'] = ['no-email', 'low-trust'];
		expect(shownFields('reg-verification', state).map((field) => field.key)).toEqual([
			'reg.emailCheck',
			'reg.extraWhen',
			'reg.expiry'
		]);
		expect(partState('reg-verification', 'registration', state)).toBe('required');
		state.values['reg.expiry'] = '15m';
		expect(isReady('registration', state)).toBe(true);
		// There is no separate optional step for it any more, and no SMS.
		expect(FLOWS.registration.groups.map((group) => group.id)).not.toContain('extra-check');
		expect(PARTS['reg-extra-check']).toBeUndefined();
	});

	it('has the sync flows beside sign-up and sign-in, each with its own name and other system', () => {
		// SCIM sent is defined but not offered yet.
		expect(ALL_FLOW_IDS).toEqual(['registration', 'login', 'scim-in', 'csv']);
		expect(Object.keys(FLOWS)).toContain('scim-out');
		for (const flow of ['scim-in', 'scim-out', 'csv'] as const) {
			const state = emptyFlowState();
			// Asked first: a name and the system on the other side, not "where it is used".
			expect(partsOf(flow)).not.toContain(aboutPart(flow));
			expect(PARTS[aboutPart(flow)].fields.map((field) => field.kind)).toEqual(['text', 'text']);
			expect(canProceedAccount('account-about', flow, state)).toBe(false);
			state.values[`${aboutPart(flow).split('-')[0]}.name`] = 'A sync';
			state.values[`${aboutPart(flow).split('-')[0]}.partner`] = 'Somewhere';
			expect(canProceedAccount('account-about', flow, state)).toBe(true);
		}
	});

	it('needs a mapping for SCIM received from the start, and adds it with the + elsewhere', () => {
		const mapping = (flow: 'scim-in' | 'scim-out' | 'csv') =>
			FLOWS[flow].groups.find((group) => group.id === 'mapping')!;
		expect(mapping('scim-in').optional).toBeUndefined();
		expect(partState('sin-mapping', 'scim-in', emptyFlowState())).toBe('required');
		expect(mapping('scim-out').optional).toBe(true);
		expect(mapping('csv').optional).toBe(true);
		expect(partState('csv-mapping', 'csv', emptyFlowState())).toBe('todo');
	});

	it('can be run from the overview for CSV and SCIM sent, not for SCIM received', () => {
		expect(FLOWS.csv.run).toBe('csv');
		expect(FLOWS['scim-out'].run).toBe('scim-out');
		expect(FLOWS['scim-in'].run).toBeUndefined();
	});

	it('are ready once the required settings of a sync flow are chosen', () => {
		for (const flow of ['scim-in', 'scim-out', 'csv'] as const) {
			expect(isReady(flow, emptyFlowState())).toBe(false);
			expect(isReady(flow, sampleState(flow))).toBe(true);
		}
	});

	it('steps the wizard through the name of a sync flow like any other', () => {
		expect(accountWizardSteps('csv').map((step) => step.id)).toEqual([
			'where',
			'kind',
			'account-about'
		]);
	});

	it('asks which roles or groups to send when the scope is narrowed', () => {
		const state = sampleState('scim-out');
		expect(state.values['sout.scope']).toBe('all');
		expect(shownFields('sout-scope', state).map((field) => field.key)).toEqual([
			'sout.scope',
			'sout.removed'
		]);
		state.values['sout.scope'] = 'byRole';
		// Narrowed but not said to what: the flow is not ready.
		expect(partState('sout-scope', 'scim-out', state)).toBe('required');
		expect(isReady('scim-out', state)).toBe(false);
		state.values['sout.roles'] = ['admin'];
		expect(partState('sout-scope', 'scim-out', state)).toBe('done');
		state.values['sout.scope'] = 'byGroup';
		expect(partState('sout-scope', 'scim-out', state)).toBe('required');
	});
});
