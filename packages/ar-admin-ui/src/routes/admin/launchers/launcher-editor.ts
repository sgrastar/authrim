import type { LauncherApplicationType, LauncherLaunchType } from '$lib/api/admin-launchers';

export function defaultLaunchTypeForApplication(
	applicationType: LauncherApplicationType
): LauncherLaunchType {
	return applicationType === 'saml_sp' ? 'saml_sp_initiated' : 'bookmark';
}
