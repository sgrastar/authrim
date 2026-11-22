/**
 * Platform → Administrators → Sign-in: the platform's view of how admins sign in. Not in
 * SETTINGS_PAGES: the setting has its home on the tenant's Administrators page (a tenant's own
 * list replaces the platform's); this page is where the platform's list, the default for every
 * tenant that sets none, is edited. Read and saved at the platform scope.
 */
import type { SettingsPageDef } from './placement';

export const PLATFORM_ADMIN_SIGN_IN: SettingsPageDef = {
	id: 'platform-admin-sign-in',
	nav: 'plat-admins/sign-in',
	title: 'nav.pa.signIn',
	description: 'set.section.adminSecondFactorPlatform.desc',
	sections: [
		{
			id: 'admin-second-factor-platform',
			title: 'set.section.adminSecondFactorPlatform',
			level: 'platform',
			settings: [{ key: 'security.admin_second_factor_allowed_kinds', depth: 'primary' }]
		}
	]
};
