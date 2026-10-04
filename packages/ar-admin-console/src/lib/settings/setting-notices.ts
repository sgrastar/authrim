/**
 * Notices about the consequences of a choice, shown above the section that holds the setting,
 * from the values on screen (before they are saved), so the admin sees them while choosing:
 * - 'warning': the choice takes the tenant outside a specification it otherwise meets (the
 *   specification keeps working; one of its requirements is no longer met);
 * - 'info': the choice stays within the specifications but some apps may no longer work.
 */
import type { SettingsPageDef } from './placement';
import { fieldOf, type Values } from './settings-model';

export type SettingNoticeId = 'idTokenAlgorithm' | 'fapi';

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
