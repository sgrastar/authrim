/**
 * A setting opened from a step far down the flow shows on the right, but the page is still
 * scrolled to that step: the panel's top is under the fixed header. Bring the page back up so the
 * panel (and the page header above it) is in view. Does nothing when the panel's top is already
 * visible, so a short flow does not jump.
 *
 * The fixed bars are measured, not assumed, so it holds in every theme and width.
 */
export function revealPanel(panel: HTMLElement | null): void {
	if (!panel || typeof window === 'undefined') return;
	const top = panel.getBoundingClientRect().top;
	// The header bar and the category bar both stay at the top; on a phone only the header bar is
	// left (the categories are in the drawer). A bar that scrolled away has a negative bottom.
	const fixedBottom = Math.max(
		0,
		...['.topbar', '.topnav'].map(
			(selector) => document.querySelector(selector)?.getBoundingClientRect().bottom ?? 0
		)
	);
	if (top >= fixedBottom) return;
	const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
	window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
}
