import { describe, expect, it } from 'vitest';
import { initialState } from './account-flow-model';
import {
	applyLoginFlowSpec,
	buildLoginFlowEditor,
	canSetSignInConsent,
	loginSpecFitsForm,
	loginSpecOf,
	loginStateOf,
	readLoginFlowEditor
} from './login-flow-mapping';
import { SEEDED_LOGIN_EDITOR } from './seeded-login-flow.fixture';

describe('the sign-in flow saved as a Flow', () => {
	it('starts from the tenant’s methods, session and destination', () => {
		expect(loginSpecOf(initialState('login'))).toEqual({
			profileRef: 'default',
			sessionProfileRef: 'default',
			completion: null,
			unregistered: 'generic',
			onCancel: 'stay',
			consents: []
		});
	});

	it('saves what the console sets and reads it back the same', () => {
		const state = initialState('login');
		state.values['login.methodProfile'] = 'amp_1';
		state.values['login.sessionProfile'] = 'sp_1';
		state.values['login.after'] = 'app_login';
		state.values['login.appClient'] = 'client-1';
		state.values['login.appRedirectUri'] = 'https://app.example/cb';
		const spec = loginSpecOf(state);
		expect(spec).toEqual({
			profileRef: 'amp_1',
			sessionProfileRef: 'sp_1',
			completion: {
				behavior: 'app_login',
				app_login_client_id: 'client-1',
				app_login_redirect_uri: 'https://app.example/cb',
				app_login_scope: 'openid profile email'
			},
			unregistered: 'generic',
			onCancel: 'stay',
			consents: []
		});
		const back = loginStateOf(readLoginFlowEditor(buildLoginFlowEditor(spec))!, {
			name: 'Partner sign-in',
			scope: 'default-ui'
		});
		expect(loginSpecOf(back)).toEqual(spec);
		expect(back.values['login.name']).toBe('Partner sign-in');
	});

	it('saves the sign-in options and reads them back', () => {
		const state = initialState('login');
		expect(state.values['login.unregistered']).toBe('generic');
		expect(state.values['login.onCancel']).toBe('stay');
		state.values['login.unregistered'] = 'guide';
		state.values['login.onCancel'] = 'error';
		const spec = loginSpecOf(state);
		expect(spec).toMatchObject({ unregistered: 'guide', onCancel: 'error' });
		const back = loginStateOf(readLoginFlowEditor(buildLoginFlowEditor(spec))!, {
			name: 'x',
			scope: 'default-ui'
		});
		expect(back.values['login.unregistered']).toBe('guide');
		expect(back.values['login.onCancel']).toBe('error');
	});

	it('keeps “the tenant’s own” destination as none', () => {
		const back = loginStateOf(
			{
				profileRef: 'default',
				sessionProfileRef: 'default',
				completion: null,
				unregistered: 'generic',
				onCancel: 'stay',
				consents: []
			},
			{ name: 'x', scope: 'default-ui' }
		);
		expect(back.values['login.after']).toBe('tenant');
	});

	it('sets the standard sign-in every tenant is given, keeping its branches', () => {
		const spec = readLoginFlowEditor(SEEDED_LOGIN_EDITOR);
		expect(spec).not.toBeNull();
		const state = loginStateOf(spec!, { name: 'Sign-in', scope: 'default-ui' });
		state.values['login.sessionProfile'] = 'sp_short';
		const saved = applyLoginFlowSpec(SEEDED_LOGIN_EDITOR, loginSpecOf(state));
		expect(saved).not.toBeNull();
		expect(saved!.edges).toEqual(SEEDED_LOGIN_EDITOR.edges);
		expect(saved!.nodes.map((node) => node.id)).toEqual(
			SEEDED_LOGIN_EDITOR.nodes.map((node) => node.id)
		);
		const authentication = saved!.nodes.find((node) => node.id === 'authentication')!;
		expect(authentication.config).toMatchObject({
			session_profile_ref: 'sp_short',
			screen_ref: 'login',
			outputs: SEEDED_LOGIN_EDITOR.nodes[2].config.outputs
		});
		expect(readLoginFlowEditor(saved)?.sessionProfileRef).toBe('sp_short');
	});

	it('does not set a graph without exactly one authentication step', () => {
		expect(readLoginFlowEditor({ nodes: [], edges: [] })).toBeNull();
		const twice = structuredClone(SEEDED_LOGIN_EDITOR);
		twice.nodes.push({ ...structuredClone(twice.nodes[2]), id: 'authentication-2' });
		expect(readLoginFlowEditor(twice)).toBeNull();
	});

	it('saves the statements asked before sign-in completes and reads them back in order', () => {
		const state = loginStateOf(readLoginFlowEditor(SEEDED_LOGIN_EDITOR)!, {
			name: 'Sign-in',
			scope: 'default-ui'
		});
		expect(state.added).not.toContain('consent');
		expect(loginSpecOf(state).consents).toEqual([]);
		state.added.push('consent');
		state.values['login.statements'] = ['stmt_terms:required', 'stmt_privacy:optional'];
		const spec = loginSpecOf(state);
		expect(spec.consents).toEqual([
			{
				statements: [
					{ statement_id: 'stmt_terms', required: true },
					{ statement_id: 'stmt_privacy', required: false }
				]
			}
		]);
		expect(canSetSignInConsent(SEEDED_LOGIN_EDITOR)).toBe(true);
		const saved = applyLoginFlowSpec(SEEDED_LOGIN_EDITOR, spec);
		expect(saved).not.toBeNull();
		const back = loginStateOf(readLoginFlowEditor(saved)!, { name: 'x', scope: 'default-ui' });
		expect(back.added).toContain('consent');
		expect(back.values['login.statements']).toEqual([
			'stmt_terms:required',
			'stmt_privacy:optional'
		]);
		// Taken away again: the step goes and nothing is asked.
		back.added = back.added.filter((id) => id !== 'consent');
		const without = applyLoginFlowSpec(saved, loginSpecOf(back));
		expect(readLoginFlowEditor(without)?.consents).toEqual([]);
	});

	it('cannot ask consent in a Flow with no completion an edge leads to', () => {
		const flow = structuredClone(SEEDED_LOGIN_EDITOR);
		flow.nodes = flow.nodes.filter((node) => node.type !== 'complete');
		flow.edges = flow.edges.filter((edge) => flow.nodes.some((node) => node.id === edge.target));
		expect(canSetSignInConsent(flow)).toBe(false);
		const state = loginStateOf(readLoginFlowEditor(flow)!, { name: 'x', scope: 'default-ui' });
		// Without consent the other settings still save.
		expect(applyLoginFlowSpec(flow, loginSpecOf(state))).not.toBeNull();
		state.added.push('consent');
		state.values['login.statements'] = ['stmt_terms:required'];
		expect(applyLoginFlowSpec(flow, loginSpecOf(state))).toBeNull();
	});
});

describe('a sign-in the form cannot hold', () => {
	it('is shown, not saved: more than one consent step, or one shown to some people', () => {
		const base = readLoginFlowEditor(SEEDED_LOGIN_EDITOR)!;
		const terms = [{ statement_id: 'stmt_terms', required: true }];
		expect(loginSpecFitsForm({ ...base, consents: [{ statements: terms }] })).toBe(true);
		expect(
			loginSpecFitsForm({ ...base, consents: [{ statements: terms }, { statements: terms }] })
		).toBe(false);
		expect(
			loginSpecFitsForm({
				...base,
				consents: [{ statements: terms, when: [{ type: 'locale', value: 'ja' }] }]
			})
		).toBe(false);
	});
});
