import { expect, waitFor } from 'storybook/test';

/**
 * Waits until the toasts on screen have finished moving: each one fully opaque with no animation
 * running or about to run, and the ones closing gone. A story's accessibility check runs when its
 * play ends, and a toast still flying in (or out) has its text blended with the background.
 *
 * It looks at the state, not at the animations found at one moment: a Svelte transition first runs
 * a placeholder animation and only creates the fly when that one ends. Only a toast's own
 * animations count; its timer bar runs until it closes.
 */
export async function waitForSettledToasts(count?: number): Promise<void> {
	// A new toast gets its starting styles and first animation a microtask after it is inserted:
	// until then it looks settled. One frame later every transition has started.
	await new Promise((resolve) => requestAnimationFrame(resolve));
	await waitFor(() => {
		const boxes = [...document.querySelectorAll<HTMLElement>('.toaster .toast')];
		if (count !== undefined) expect(boxes).toHaveLength(count);
		for (const box of boxes) {
			expect(getComputedStyle(box).opacity).toBe('1');
			expect(
				box
					.getAnimations()
					.filter((animation) => animation.pending || animation.playState === 'running')
			).toHaveLength(0);
		}
	});
}
