/**
 * Going back to a screen of the Flow from a link on the current one (a screen part `link` whose
 * `link_action` is `back`). Only back, and only across screens: from a `screen` step, to a `screen` step the
 * person has already passed in this interaction, with nothing but `screen` steps passed since. A
 * step that did something (signed the person in or up, checked an address, asked consent) is never
 * passed again this way, and nothing is skipped: the steps after the screen gone back to are
 * shown again, by submitting it.
 */

/** The step component a person can go back to, and from. */
export const BACK_NAVIGABLE_COMPONENT = 'screen';

/** How many of the latest completed visits are looked back through. */
export const BACK_LOOKBACK = 50;

/** A completed visit of a step (a row of `flow_interaction_steps`). */
export interface BackVisit {
  id: string;
  step_id: string;
  /** The way out the visit was completed by (its submit's handle). */
  selected_handle?: string | null;
  created_at: number;
  state_json: string | null;
}

/** A step of the Flow, as far as going back needs it. */
export interface BackStep {
  id: string;
  component: string;
  /** The key of the screen it shows, when it shows one. */
  screenKey: string | null;
}

/** A screen the person can go back to: its step, and the visits undone by going back there. */
export interface BackTarget {
  screenKey: string;
  stepId: string;
  /** The completed visits no longer behind the person once back (the target's own included). */
  undoneVisitIds: string[];
}

/** When a visit was completed, to the millisecond where it was recorded. */
export function completedAtMs(visit: Pick<BackVisit, 'created_at' | 'state_json'>): number {
  try {
    const state = visit.state_json ? (JSON.parse(visit.state_json) as unknown) : null;
    const ms =
      state && typeof state === 'object'
        ? (state as Record<string, unknown>).completed_at_ms
        : null;
    if (typeof ms === 'number' && Number.isFinite(ms)) return ms;
  } catch {
    // A state that does not read is ordered by its second.
  }
  return Number(visit.created_at) * 1000;
}

/**
 * The screens the person can go back to from `current`, nearest first, each once (its latest
 * visit). Empty unless the current step is a screen.
 *
 * `nextStepIdOf` is the step the Flow goes to from a visit, by the way out it took: each visit must
 * lead straight to the one after it (and the latest to the current step). A step passed without a
 * visit of its own (a condition the submit went through) breaks that, and so does an order of
 * visits the times cannot tell: the way back stops there rather than guess.
 */
export function backTargets(
  current: BackStep | undefined,
  visits: readonly BackVisit[],
  steps: ReadonlyMap<string, BackStep>,
  nextStepIdOf: (visit: BackVisit) => string | null
): BackTarget[] {
  if (!current || current.component !== BACK_NAVIGABLE_COMPONENT) return [];
  const latestFirst = [...visits].sort((a, b) => completedAtMs(b) - completedAtMs(a));
  const targets: BackTarget[] = [];
  const undone: string[] = [];
  let after = current.id;
  for (const [index, visit] of latestFirst.entries()) {
    // Two visits completed at the same moment cannot be told apart in order: stop before either.
    const at = completedAtMs(visit);
    const neighbours = [latestFirst[index - 1], latestFirst[index + 1]];
    if (neighbours.some((other) => other && completedAtMs(other) === at)) break;
    const step = steps.get(visit.step_id);
    // Anything but a screen stops the way back.
    if (!step || step.component !== BACK_NAVIGABLE_COMPONENT) break;
    // Something between it and the step after it, or visits out of order: stop.
    if (nextStepIdOf(visit) !== after) break;
    after = step.id;
    undone.push(visit.id);
    if (step.screenKey && !targets.some((target) => target.screenKey === step.screenKey)) {
      targets.push({ screenKey: step.screenKey, stepId: step.id, undoneVisitIds: [...undone] });
    }
  }
  return targets;
}
