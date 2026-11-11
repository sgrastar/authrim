import { describe, expect, it } from 'vitest';
import { initialState } from './account-flow-model';
import {
	applyLoginFlowSpec,
	buildLoginFlowEditor,
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
			completion: null
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
			}
		});
		const back = loginStateOf(readLoginFlowEditor(buildLoginFlowEditor(spec))!, {
			name: 'Partner sign-in',
			scope: 'default-ui'
		});
		expect(loginSpecOf(back)).toEqual(spec);
		expect(back.values['login.name']).toBe('Partner sign-in');
	});

	it('keeps “the tenant’s own” destination as none', () => {
		const back = loginStateOf(
			{ profileRef: 'default', sessionProfileRef: 'default', completion: null },
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
});
