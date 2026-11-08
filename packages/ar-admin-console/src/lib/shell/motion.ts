/** Shared timing for the navigation flips (kept in sync with the CSS in TopNav/SubNav). */
export const TOPNAV_FLIP_MS = 420;
export const TOPNAV_FLIP_STEP_MS = 55;
export const SUBNAV_STEP_MS = 40;
/** Old rows fall (240ms) and new rows rise (360ms) half a beat later. */
export const SUBNAV_RISE_DELAY_MS = 140;
export const SUBNAV_SETTLE_MS = 520;
/** How long the pointer rests on a header category before its menu drops (a pass does not). */
export const TOPNAV_MENU_OPEN_MS = 180;
/** Grace after the pointer leaves a tab or its menu, to cross the gap or move to the next tab. */
export const TOPNAV_MENU_CLOSE_MS = 240;

export function motionReduced(): boolean {
	return (
		typeof window !== 'undefined' &&
		window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
	);
}

/** Waits two frames so a freshly inserted element is painted before its transition starts. */
export function afterPaint(callback: () => void): void {
	requestAnimationFrame(() => requestAnimationFrame(callback));
}
