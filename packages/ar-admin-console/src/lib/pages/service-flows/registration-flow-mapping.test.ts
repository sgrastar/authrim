import { describe, expect, it } from 'vitest';
import {
	buildRegistrationFlowEditor,
	readRegistrationFlowEditor
} from '@authrim/ar-lib-core/types/registration-flow-graph';
import { aboutState, isReady, titleKey } from './account-flow-model';
import {
	domainsOf,
	isConsoleShaped,
	registrationSpecOf,
	registrationStateOf
} from './registration-flow-mapping';

describe('the sign-up flow saved as a Flow', () => {
	it('saves what the console sets and reads it back the same', () => {
		const state = aboutState('registration', 'Members sign-up', 'default-ui');
		Object.assign(state.values, {
			'reg.methodProfile': 'members',
			'reg.screen': 'registration_custom',
			[titleKey('reg-screen')]: 'Your details',
			'reg.duplicate': 'reject',
			'reg.policy': 'domain',
			'reg.domains': 'example.com, @Corp.example.co.jp',
			'reg.denied': 'reason',
			'reg.emailCheck': 'later',
			'reg.extraWhen': ['no-email', 'low-trust'],
			'reg.expiry': '10m',
			'reg.after': 'saml_login',
			'reg.samlSp': 'https://lms.example.edu/shibboleth',
			'reg.samlRelayState': '/start',
			'reg.extraScreen:1': 'welcome_survey',
			'reg.extraScreen:1>social': 'complete',
			'reg.extraScreen:1>skipped': 'extra-screen:2',
			'reg.extraScreen:2': 'more',
			[titleKey('reg-extra-screen:2')]: 'Last step'
		});
		state.added = ['extra-screen:1', 'extra-screen:2'];

		const spec = registrationSpecOf(state);
		expect(spec.policy).toMatchObject({
			duplicate: 'reject',
			eligibility: 'domain',
			allowed_domains: ['example.com', 'corp.example.co.jp'],
			external_email_check: ['no_email', 'low_trust'],
			code_ttl_seconds: 600,
			completion: {
				behavior: 'saml_login',
				saml_login_sp_entity_id: 'https://lms.example.edu/shibboleth',
				saml_login_relay_state: '/start'
			}
		});
		// Through the graph, as it is saved and read again.
		const read = readRegistrationFlowEditor(buildRegistrationFlowEditor(spec));
		expect(read).toEqual(spec);
		const back = registrationStateOf(read!, { name: 'Members sign-up', scope: 'default-ui' });
		expect(back.added).toEqual(state.added);
		expect(back.values).toMatchObject({
			...state.values,
			'reg.domains': 'example.com, corp.example.co.jp'
		});
		expect(isReady('registration', back)).toBe(true);
	});

	it('reads the domains as typed, however separated', () => {
		expect(domainsOf(' a.example,b.example  @C.example ')).toEqual([
			'a.example',
			'b.example',
			'c.example'
		]);
	});

	it('saves back only a graph it can rebuild as it is', () => {
		const state = aboutState('registration', 'Sign-up', 'default-ui');
		const editor = buildRegistrationFlowEditor(registrationSpecOf(state));
		expect(isConsoleShaped(editor)).toBe(true);
		// The same step ids, a config changed in the Flow editor: shown, not saved.
		const changed = structuredClone(editor);
		changed.nodes[changed.nodes.length - 2].config = { ui_kind: 'account', extra: true };
		expect(isConsoleShaped(changed)).toBe(false);
		// The sign-up every tenant was first given, as seeded; not once changed in the Flow editor.
		const seeded = {
			nodes: [
				{ id: 'request', type: 'entry', config: { ui_kind: 'start' } },
				{
					id: 'registration-method',
					type: 'registration',
					config: {
						ui_kind: 'registration',
						authentication_profile_ref: 'default',
						screen_ref: 'registration',
						outputs: [
							{ id: 'mail_otp', label: 'Email OTP' },
							{ id: 'totp', label: 'Authenticator app' },
							{ id: 'passkey', label: 'Passkey' },
							{ id: 'facebook', label: 'Facebook' }
						]
					}
				},
				{ id: 'account-create', type: 'account_action', config: { ui_kind: 'account' } },
				{ id: 'output', type: 'complete', config: { ui_kind: 'end' } }
			],
			edges: [
				{ source: 'request', source_handle: 'next', target: 'registration-method' },
				...['mail_otp', 'totp', 'passkey', 'facebook'].map((handle) => ({
					source: 'registration-method',
					source_handle: handle,
					target: 'account-create'
				})),
				{ source: 'account-create', source_handle: 'completed', target: 'output' }
			]
		};
		expect(isConsoleShaped(seeded)).toBe(true);
		const edited = structuredClone(seeded);
		(edited.nodes[2].config as Record<string, unknown>).screen_ref = 'profile_completion';
		expect(isConsoleShaped(edited)).toBe(false);
	});
});
