/**
 * Platform → Administrators → Sign-in: the platform's view of how admins sign in. Not in
 * SETTINGS_PAGES: its settings have their home on the tenant's Administrators page (a tenant's own
 * second-factor list replaces the platform's; the sign-in methods are the platform's part of that
 * page); this page is where the platform edits them. Read and saved at the platform scope.
 */
import type { SettingsPageDef } from './placement';

export const PLATFORM_ADMIN_SIGN_IN: SettingsPageDef = {
	id: 'platform-admin-sign-in',
	nav: 'plat-admins/sign-in',
	title: 'nav.pa.signIn',
	description: 'set.section.adminSecondFactorPlatform.desc',
	sections: [
		{
			id: 'admin-sign-in-methods',
			title: 'set.section.adminSignInMethods',
			description: 'set.section.adminSignInMethods.desc',
			level: 'platform',
			settings: [{ key: 'security.admin_sign_in_methods', depth: 'primary' }]
		},
		{
			id: 'admin-second-factor-platform',
			title: 'set.section.adminSecondFactorPlatform',
			level: 'platform',
			settings: [{ key: 'security.admin_second_factor_allowed_kinds', depth: 'primary' }]
		}
	]
};
