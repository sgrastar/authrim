/**
 * Non-blocking warnings of a tenant backup restore preview: platform profiles that the backup's
 * Flows name and the target environment lacks or is deleting. They arrive as unresolved,
 * non-required prerequisites of a profile kind; the screen lists them without gating approval.
 */
export interface RestorePreviewPrerequisite {
	id: string;
	kind: string;
	status: 'resolved' | 'unresolved';
	required: boolean;
}

/** The most warnings a preview keeps (PLATFORM_PROFILE_WARNING_LIMIT in ar-lib-core). */
export const RESTORE_PROFILE_WARNING_LIMIT = 32;

export interface RestorePlatformProfileWarning {
	kind: 'method' | 'session';
	id: string;
}

export function restorePlatformProfileWarnings(
	prerequisites: readonly RestorePreviewPrerequisite[]
): RestorePlatformProfileWarning[] {
	return prerequisites.flatMap((entry): RestorePlatformProfileWarning[] => {
		if (entry.required || entry.status !== 'unresolved') return [];
		if (entry.kind === 'platform_method_profile')
			return [{ kind: 'method' as const, id: entry.id }];
		if (entry.kind === 'platform_session_profile')
			return [{ kind: 'session' as const, id: entry.id }];
		return [];
	});
}

/** The check of those profiles stopped at one of its limits: the list may miss some. */
export function restorePlatformProfileCheckIncomplete(
	prerequisites: readonly RestorePreviewPrerequisite[]
): boolean {
	return prerequisites.some(
		(entry) => entry.kind === 'platform_profile_check' && entry.status === 'unresolved'
	);
}
