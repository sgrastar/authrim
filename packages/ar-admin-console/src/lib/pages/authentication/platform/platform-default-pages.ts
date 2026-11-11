/**
 * The platform's Default and the profile switches, as settings pages read and saved at the
 * platform scope (SettingsPage). Not in SETTINGS_PAGES: these settings have their home on the
 * tenant pages (and the switches in the settings draft); this is the platform's view of them,
 * beside its profiles.
 */
import { AUTHENTICATION_METHODS_DEFAULT_LAYER_KEYS } from '@authrim/ar-lib-core/types/settings/authentication-methods';
import type { PlatformProfileKind } from '#lib/api/platform-profiles.js';
import type { PlacedSetting, SettingsPageDef } from '#lib/settings/placement.js';
import {
	SESSION_LENGTH_KEYS,
	SESSION_METHOD_LENGTH_KEYS,
	SESSION_SWITCH_KEYS
} from '../session-profile-fields';

const METHOD_USE = /\.(signup|login|reauth|account_link)_enabled$/;

const methodSettings: PlacedSetting[] = AUTHENTICATION_METHODS_DEFAULT_LAYER_KEYS.map((key) => ({
	key,
	// The per-use switches are what most admins set; the rest (guest, presets) under Advanced.
	depth:
		METHOD_USE.test(key) && !key.startsWith('authentication-methods.guest.')
			? 'primary'
			: 'advanced'
}));

const sessionSettings: PlacedSetting[] = [
	...SESSION_LENGTH_KEYS.map((key) => ({ key, depth: 'primary' as const })),
	...SESSION_SWITCH_KEYS.map((key) => ({ key, depth: 'primary' as const })),
	...SESSION_METHOD_LENGTH_KEYS.map((key) => ({ key, depth: 'advanced' as const }))
];

const switches = (kind: PlatformProfileKind): PlacedSetting[] => [
	{ key: `profiles.${kind}.tenant_change_allowed`, depth: 'primary' },
	{ key: `profiles.${kind}.tenant_create_allowed`, depth: 'primary' },
	{ key: `profiles.${kind}.default_locked`, depth: 'primary' }
];

export const PLATFORM_DEFAULT_PAGES: Readonly<Record<PlatformProfileKind, SettingsPageDef>> = {
	method: {
		id: 'platform-default-methods',
		nav: 'authentication/methods',
		title: 'pp.title.method',
		description: 'pp.desc.method',
		sections: [
			{
				id: 'platform-default',
				title: 'pp.default.method',
				description: 'pp.default.method.desc',
				level: 'platform',
				settings: methodSettings
			},
			{
				id: 'platform-switches',
				title: 'pp.switches',
				description: 'pp.switches.desc',
				level: 'platform',
				settings: switches('method')
			}
		]
	},
	session: {
		id: 'platform-default-sessions',
		nav: 'authentication/session-profiles',
		title: 'pp.title.session',
		description: 'pp.desc.session',
		sections: [
			{
				id: 'platform-default',
				title: 'pp.default.session',
				description: 'pp.default.method.desc',
				level: 'platform',
				settings: sessionSettings
			},
			{
				id: 'platform-switches',
				title: 'pp.switches',
				description: 'pp.switches.desc',
				level: 'platform',
				settings: switches('session')
			}
		]
	}
};
