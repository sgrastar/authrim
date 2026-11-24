/**
 * The rules of the guide that need no browser: which page a step is on, which step to show after
 * the person moved, and what a signal or the Next button leads to.
 */
import type { ChecklistItem, GuideStep } from './checklist';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';
import type { GuideFact, GuideSignal } from './signals';

const segments = (path: string) => path.split('/').filter(Boolean);

/** Whether `pathname` is the page `pattern` names; `*` is exactly one segment. */
export function matchesPath(pattern: string, pathname: string): boolean {
	const want = segments(pattern);
	const have = segments(pathname);
	return (
		want.length === have.length && want.every((part, index) => part === '*' || part === have[index])
	);
}

/** A path with no `*`: one the guide can go to by itself. */
export const isConcretePath = (pattern: string) => !pattern.includes('*');

/**
 * The step to show on `pathname`, for a guide that is at `index`: that step when it is on this
 * page; otherwise the nearest later one that is (the person did what moves on, or skipped
 * ahead); otherwise the nearest earlier one (they went back). None: the guide waits, hidden,
 * until the person returns to one of its pages.
 */
export function locateStep(
	steps: readonly GuideStep[],
	index: number,
	pathname: string
): number | null {
	if (index < 0 || index >= steps.length) return null;
	const on = (step: GuideStep) => matchesPath(step.path, pathname);
	if (on(steps[index])) return index;
	for (let later = index + 1; later < steps.length; later++) if (on(steps[later])) return later;
	for (let earlier = index - 1; earlier >= 0; earlier--) if (on(steps[earlier])) return earlier;
	return null;
}

export type Move = { kind: 'finish' } | { kind: 'step'; index: number };

/** Where moving on from step `index` leads. */
export function moveOn(item: ChecklistItem, index: number): Move {
	const last = index >= item.steps.length - 1;
	return last || item.steps[index]?.completes
		? { kind: 'finish' }
		: { kind: 'step', index: index + 1 };
}

/**
 * Where a signal leads: on from the step that waits for it, the current one or a later one (a
 * person who saves before the guide asks them to has still saved). None when no step from here
 * on waits for it.
 */
export function moveOnSignal(item: ChecklistItem, index: number, signal: GuideSignal): Move | null {
	for (let at = Math.max(index, 0); at < item.steps.length; at++) {
		const advance = item.steps[at].advance;
		if (typeof advance === 'object' && advance.signal === signal) return moveOn(item, at);
	}
	return null;
}

/** Whether Back can be offered: the step before is on the same page. */
export function canGoBack(steps: readonly GuideStep[], index: number, pathname: string): boolean {
	return index > 0 && matchesPath(steps[index - 1].path, pathname);
}

/**
 * What a step says in this environment: its own body and action, or the first variant whose fact
 * holds in their place (a variant without an action keeps the step's).
 */
export function wordingOf(
	step: GuideStep,
	holds: (fact: GuideFact) => boolean
): { body: MessageKey; action?: MessageKey } {
	const variant = step.variants?.find((candidate) => holds(candidate.when));
	return { body: variant?.body ?? step.body, action: variant?.action ?? step.action };
}

/** Whether the step waits for the person instead of offering Next. */
export const waitsForPerson = (step: GuideStep) =>
	step.advance !== undefined && step.advance !== 'next';

/** Text as HTML text: the popover takes HTML, the messages are plain text. */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
