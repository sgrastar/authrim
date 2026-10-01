/**
 * What to do when the admin tries to leave a page with unsaved changes.
 * - `allow`: nothing is lost (no changes, or a jump within the same page).
 * - `native`: the page itself would unload (closing the tab, reloading, another site); only
 *   the browser's own dialog can ask then.
 * - `ask`: a move inside the console; stop it and ask in the console's own dialog.
 */
export type LeaveDecision = 'allow' | 'native' | 'ask';

export interface LeaveAttempt {
	/** The page is about to unload (SvelteKit `willUnload`). */
	willUnload: boolean;
	from: { url: URL } | null;
	to: { url: URL } | null;
}

export function leaveDecision(attempt: LeaveAttempt, dirty: boolean): LeaveDecision {
	if (!dirty) return 'allow';
	if (attempt.willUnload) return 'native';
	const to = attempt.to?.url;
	if (!to) return 'allow';
	const from = attempt.from?.url;
	// Only the #fragment changes: the admin stays on the page, nothing is lost.
	if (from && from.pathname === to.pathname && from.search === to.search) return 'allow';
	return 'ask';
}
