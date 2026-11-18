/**
 * Whether the Admin API is refusing changes because the environment is being updated.
 *
 * Nothing can be asked: the release status API is for platform admins only. So the console goes
 * by what it is told: a change refused for this reason (see `isReleasePause`) turns the notice
 * on, and the next change that is taken turns it off. Left alone it goes away by itself after a
 * while, so a console nobody touches does not keep saying "paused" long after the update.
 */
export const RELEASE_PAUSE_HOLD_MS = 60_000;

let active = $state(false);
let timer: ReturnType<typeof setTimeout> | null = null;

function stopTimer(): void {
	if (timer !== null) clearTimeout(timer);
	timer = null;
}

export const releasePause = {
	/** True from a refused change until a change is taken, or the hold time is over. */
	get active(): boolean {
		return active;
	},
	/** A change was just refused because of the update. */
	report(): void {
		stopTimer();
		active = true;
		timer = setTimeout(() => {
			timer = null;
			active = false;
		}, RELEASE_PAUSE_HOLD_MS);
	},
	/** A change was just taken: the update is over. */
	clear(): void {
		stopTimer();
		active = false;
	}
};
