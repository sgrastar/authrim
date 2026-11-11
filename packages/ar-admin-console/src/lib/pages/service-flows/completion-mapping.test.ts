import { describe, expect, it } from 'vitest';
import { completionOf, setCompletion } from './completion-mapping';
import type { AccountFlowState } from './flow-spec';

describe('where a person goes once the flow is done', () => {
	it('keeps the SAML RelayState exactly as entered, through a read-back and a save', () => {
		const values: AccountFlowState['values'] = {
			'login.after': 'saml_login',
			'login.samlSp': ' https://sp.example/metadata ',
			'login.samlRelayState': '  /start here  '
		};
		const completion = completionOf(values, 'login');
		expect(completion).toEqual({
			behavior: 'saml_login',
			saml_login_sp_entity_id: 'https://sp.example/metadata',
			saml_login_relay_state: '  /start here  '
		});
		const back: AccountFlowState['values'] = {};
		setCompletion(back, completion, 'login');
		expect(completionOf(back, 'login')).toEqual(completion);
	});

	it('leaves a sign-in to the tenant as none, and a sign-up never', () => {
		expect(completionOf({ 'login.after': 'tenant' }, 'login')).toBeNull();
		const back: AccountFlowState['values'] = {};
		setCompletion(back, null, 'login');
		expect(back['login.after']).toBe('tenant');
		expect(completionOf({}, 'reg')).toEqual({ behavior: 'account' });
	});
});
