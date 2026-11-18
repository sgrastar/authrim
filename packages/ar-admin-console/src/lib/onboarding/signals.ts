/**
 * What pages tell the guide. A page that finishes something a guide step waits for (a save that
 * succeeded, a choice that was made) calls `guideSignal`; when no guide is running, nothing
 * happens. Kept apart from the guide itself so that pages do not load it.
 *
 * To add a signal: name it here, call `guideSignal` where it happens, and use it in a step's
 * `advance: { signal }` in `checklist.ts`.
 */
export type GuideSignal = 'theme.preset-chosen' | 'theme.saved' | 'schema.saved' | 'screen.saved';

type Listener = (signal: GuideSignal) => void;

const listeners = new Set<Listener>();

export function guideSignal(signal: GuideSignal): void {
	for (const listener of [...listeners]) listener(signal);
}

/** The guide listens while the console is open. Returns how to stop. */
export function onGuideSignal(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
