/**
 * What pages tell the guide. A page that finishes something a guide step waits for (a save that
 * succeeded, a choice that was made) calls `guideSignal`; when no guide is running, nothing
 * happens. Kept apart from the guide itself so that pages do not load it.
 *
 * To add a signal: name it here, call `guideSignal` where it happens, and use it in a step's
 * `advance: { signal }` in `checklist.ts`.
 *
 * Facts are what a page knows about the environment that a step's wording may depend on (for
 * example that an authenticator app can be registered here). A page reports one with
 * `setGuideFact` while it holds and takes it back when it stops holding; a step's `variants` in
 * `checklist.ts` read them.
 */
export type GuideSignal =
	| 'theme.preset-chosen'
	| 'theme.saved'
	| 'theme.applied'
	| 'schema.saved'
	| 'screen.saved'
	| 'second-factor.added';

/** What a page can tell the guide about the environment. */
export type GuideFact = 'second-factor.totp' | 'second-factor.blocked';

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

const facts = new Set<GuideFact>();
const factListeners = new Set<() => void>();

/** A page reports that a fact holds (or no longer does). A change is passed on to the guide. */
export function setGuideFact(fact: GuideFact, holds: boolean): void {
	if (facts.has(fact) === holds) return;
	if (holds) facts.add(fact);
	else facts.delete(fact);
	for (const listener of [...factListeners]) listener();
}

export function guideFact(fact: GuideFact): boolean {
	return facts.has(fact);
}

/** The guide listens while the console is open. Returns how to stop. */
export function onGuideFactChange(listener: () => void): () => void {
	factListeners.add(listener);
	return () => factListeners.delete(listener);
}
