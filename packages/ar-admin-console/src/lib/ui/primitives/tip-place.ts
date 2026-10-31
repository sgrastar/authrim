/**
 * Places a top-layer bubble (a popover) next to what it explains: beside it on the reading
 * side, centred on it; with no room there (at the screen edge), below it — or above it near
 * the bottom — so it never covers the thing it explains. Always kept on screen.
 */
export function placeBeside(trigger: Element, bubble: HTMLElement, gap = 8) {
	const at = trigger.getBoundingClientRect();
	const size = bubble.getBoundingClientRect();
	const rtl = getComputedStyle(trigger).direction === 'rtl';
	const after = rtl ? at.left - size.width - gap : at.right + gap;
	const fits = (left: number) => left >= gap && left + size.width <= innerWidth - gap;
	const clampX = (left: number) => Math.min(Math.max(gap, left), innerWidth - size.width - gap);
	let left: number;
	let top: number;
	if (fits(after)) {
		left = after;
		top = at.top + at.height / 2 - size.height / 2;
	} else {
		left = clampX(rtl ? at.left - size.width + at.width : at.left);
		const below = at.bottom + gap;
		top = below + size.height <= innerHeight - gap ? below : at.top - gap - size.height;
	}
	top = Math.min(Math.max(gap, top), innerHeight - size.height - gap);
	bubble.style.left = `${clampX(left)}px`;
	bubble.style.top = `${top}px`;
}
