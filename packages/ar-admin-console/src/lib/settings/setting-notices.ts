/**
 * Notices about the consequences of a choice, shown above the section that holds the setting,
 * from the values on screen (before they are saved), so the admin sees them while choosing:
 * - 'warning': the choice takes the tenant outside a specification it otherwise meets (the
 *   specification keeps working; one of its requirements is no longer met);
 * - 'info': the choice stays within the specifications but some apps may no longer work.
 */
import type { SettingsPageDef } from './placement';
import { fieldOf, type Values } from './settings-model';

export type SettingNoticeId =
	| 'idTokenAlgorithm'
	| 'fapi'
	| 'exchangeCeilings'
	| 'samlDisabled'
	| 'samlPostBinding';

export interface SettingNotice {
	id: SettingNoticeId;
	tone: 'warning' | 'info';
}

interface NoticeRule extends SettingNotice {
	/** The settings the notice is about: shown with the section that holds one of them. */
	keys: readonly string[];
	applies(value: (key: string) => unknown): boolean;
}

const NOTICE_RULES: readonly NoticeRule[] = [
	{
		// OpenID Connect Discovery 1.0 §3: id_token_signing_alg_values_supported must include
		// RS256. Apps that may not choose, with a tenant algorithm other than RS256, drop it.
		id: 'idTokenAlgorithm',
		tone: 'warning',
		keys: ['oauth.id_token_signing_alg', 'oauth.id_token_signing_alg_client_override'],
		applies: (value) =>
			value('oauth.id_token_signing_alg_client_override') === false &&
			value('oauth.id_token_signing_alg') !== undefined &&
			value('oauth.id_token_signing_alg') !== 'RS256'
	},
	{
		// FAPI 2.0 narrows what OpenID Connect allows (PAR required, sender-constrained tokens,
		// stricter client authentication): within the specifications, but apps that do not
		// support FAPI may stop working.
		id: 'fapi',
		tone: 'info',
		keys: ['security.fapi_enabled'],
		applies: (value) => value('security.fapi_enabled') === true
	},
	{
		// Token exchange is on, but the tenant's delegation ceiling is off: an app's
		// delegation_mode defaults to delegation, so those apps are refused (unauthorized_client).
		id: 'exchangeCeilings',
		tone: 'info',
		keys: ['tokens.exchange_enabled', 'tokens.exchange_delegation_enabled'],
		applies: (value) =>
			value('tokens.exchange_enabled') === true &&
			value('tokens.exchange_delegation_enabled') === false
	},
	{
		// SAML off: the SAML endpoints and metadata refuse every request, so apps that sign in
		// through Authrim over SAML, and sign-in through external SAML identity providers, stop
		// working. The registered providers are kept.
		id: 'samlDisabled',
		tone: 'info',
		keys: ['federation.saml_enabled'],
		applies: (value) => value('federation.saml_enabled') === false
	},
	{
		// A new identity provider that is signed in through HTTP-POST gets an unsigned request;
		// HTTP-Redirect carries a signed one.
		id: 'samlPostBinding',
		tone: 'info',
		keys: ['federation.saml_sso_binding'],
		applies: (value) => value('federation.saml_sso_binding') === 'HTTP-POST'
	}
];

/** The notices for a section: about one of its settings, and holding for the values on screen. */
export function sectionNotices(
	section: SettingsPageDef['sections'][number],
	values: Values
): SettingNotice[] {
	const onSection = new Set(section.settings.map((setting) => setting.key));
	const value = (key: string) => values[fieldOf(key)]?.v;
	return NOTICE_RULES.filter(
		(rule) => rule.keys.some((key) => onSection.has(key)) && rule.applies(value)
	).map(({ id, tone }) => ({ id, tone }));
}
