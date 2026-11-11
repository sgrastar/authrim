/**
 * Where a person goes once a sign-up or sign-in is done, as the console holds it (`reg.after`,
 * `login.after` and the fields that go with them) and as a Flow keeps it (ar-lib-core
 * `RegistrationCompletion`). Both ways. A sign-in may leave it to the tenant (`tenant`: null).
 */
import type { RegistrationCompletion } from '@authrim/ar-lib-core/types/registration-policy';
import type { AccountFlowState, AccountValue } from './flow-spec';

type Values = AccountFlowState['values'];

function text(value: AccountValue | undefined): string {
	return typeof value === 'string' ? value.trim() : '';
}

/** The completion the fields of `prefix` set; null for `tenant` (the tenant's own). */
export function completionOf(
	values: Values,
	prefix: 'reg' | 'login'
): RegistrationCompletion | null {
	const field = (name: string) => text(values[`${prefix}.${name}`]);
	const behavior = field('after');
	const raw = values[`${prefix}.samlRelayState`];
	const relayState = typeof raw === 'string' ? raw : '';
	switch (behavior) {
		case 'tenant':
			return null;
		case 'home':
			return { behavior: 'home' };
		case 'custom_url':
			return { behavior, redirect_url: field('redirectUrl') };
		case 'app_login':
			return {
				behavior,
				app_login_client_id: field('appClient'),
				app_login_redirect_uri: field('appRedirectUri'),
				app_login_scope: field('appScope') || 'openid profile email',
				...(field('appReturnTo') ? { app_login_final_return_to: field('appReturnTo') } : {})
			};
		case 'saml_login':
			return {
				behavior,
				saml_login_sp_entity_id: field('samlSp'),
				// The RelayState goes to the SP as it was entered, spaces and all.
				...(relayState ? { saml_login_relay_state: relayState } : {})
			};
		case 'service_site':
			return { behavior, service_site_path: field('servicePath') };
		default:
			return { behavior: 'account' };
	}
}

/** The fields of `prefix` set from a completion (null: `tenant`). */
export function setCompletion(
	values: Values,
	completion: RegistrationCompletion | null,
	prefix: 'reg' | 'login'
): void {
	if (!completion) {
		values[`${prefix}.after`] = 'tenant';
		return;
	}
	values[`${prefix}.after`] = completion.behavior;
	const set = (name: string, value: string | undefined) => {
		if (value) values[`${prefix}.${name}`] = value;
	};
	set('redirectUrl', completion.redirect_url);
	set('appClient', completion.app_login_client_id);
	set('appRedirectUri', completion.app_login_redirect_uri);
	set('appScope', completion.app_login_scope);
	set('appReturnTo', completion.app_login_final_return_to);
	set('samlSp', completion.saml_login_sp_entity_id);
	set('samlRelayState', completion.saml_login_relay_state);
	set('servicePath', completion.service_site_path);
}
