export interface CompleteProfileLifecycleOptions {
	getLifecycleState: () => string | null;
	saveDraft: () => Promise<boolean>;
	reviewDraft: () => Promise<boolean>;
	activateVersion: () => Promise<boolean>;
}

export async function completeProfileLifecycle({
	getLifecycleState,
	saveDraft,
	reviewDraft,
	activateVersion
}: CompleteProfileLifecycleOptions): Promise<boolean> {
	let lifecycleState = getLifecycleState();
	if (lifecycleState !== 'draft' && lifecycleState !== 'reviewed' && !(await saveDraft())) {
		return false;
	}

	lifecycleState = getLifecycleState();
	if (lifecycleState === 'draft' && !(await reviewDraft())) return false;

	lifecycleState = getLifecycleState();
	if (lifecycleState === 'reviewed') return activateVersion();

	return lifecycleState === 'active';
}
