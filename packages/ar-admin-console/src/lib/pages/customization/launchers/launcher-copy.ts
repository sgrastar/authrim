import type {
	ApplicationLauncher,
	LauncherAttributeOperator,
	LauncherLaunchType,
	LauncherVisibility,
	LauncherVisibilityMode
} from '#lib/api/launchers.js';
import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';

/** What a launch type is called. */
export const launchTypeLabel = (type: LauncherLaunchType): string =>
	t(`ln.launch.${type}` as MessageKey);

/** What a launch type does, in a sentence. */
export function launchTypeHelp(type: LauncherLaunchType): string {
	const help: Record<LauncherLaunchType, MessageKey> = {
		bookmark: 'ln.launch.bookmarkHelp',
		oidc_third_party_initiated: 'ln.launch.thirdPartyHelp',
		saml_sp_initiated: 'ln.launch.spHelp',
		saml_idp_initiated: 'ln.launch.idpHelp'
	};
	return t(help[type]);
}

export const audienceLabel = (mode: LauncherVisibilityMode): string =>
	t(`ln.audience.${mode}` as MessageKey);

export const operatorLabel = (operator: LauncherAttributeOperator): string =>
	t(`ln.operator.${operator}` as MessageKey);

/** Who sees a launcher, in a few words ("Users: 3"). */
export function audienceSummary(visibility: LauncherVisibility): string {
	switch (visibility.mode) {
		case 'users':
			return t('ln.audience.usersCount', { n: visibility.user_ids.length });
		case 'groups':
			return t('ln.audience.groupsCount', { n: visibility.group_ids.length });
		case 'attributes':
			return t('ln.audience.rulesCount', { n: visibility.attribute_rules.length });
		default:
			return t('ln.audience.everyone');
	}
}

/** How a launcher opens: what kind of application, then the launch type (a link: its host). */
export function opensSummary(launcher: ApplicationLauncher): {
	title: string;
	description: string;
} {
	if (launcher.application_type === 'standalone') {
		let host = '';
		try {
			host = launcher.launch_url ? new URL(launcher.launch_url).host : '';
		} catch {
			host = '';
		}
		return { title: t('ln.app.standalone'), description: host };
	}
	return {
		title: t(`ln.app.${launcher.application_type}` as MessageKey),
		description: launchTypeLabel(launcher.launch_type)
	};
}
