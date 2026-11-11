import { describe, expect, it } from 'vitest';
import {
  backTargets,
  completedAtMs,
  type BackStep,
  type BackVisit,
} from '../runtime-back-navigation';

const steps = new Map<string, BackStep>(
  [
    { id: 'signup', component: 'registration', screenKey: 'registration' },
    { id: 'a', component: 'screen', screenKey: 'page_a' },
    { id: 'b', component: 'screen', screenKey: 'page_b' },
    { id: 'code', component: 'email_verification', screenKey: null },
    { id: 'c', component: 'screen', screenKey: 'page_c' },
    { id: 'blank', component: 'screen', screenKey: null },
  ].map((step) => [step.id, step])
);
const visit = (id: string, stepId: string, ms: number): BackVisit => ({
  id,
  step_id: stepId,
  selected_handle: 'submitted',
  created_at: Math.floor(ms / 1000),
  state_json: JSON.stringify({ completed_at_ms: ms }),
});
/** Where the Flow went from each visit (by its id), as a submit would resolve it. */
const leadsTo =
  (next: Record<string, string>) =>
  (from: BackVisit): string | null =>
    next[from.id] ?? null;

describe('going back to a screen', () => {
  it('reaches the screens behind, nearest first, each with the visits it undoes', () => {
    const targets = backTargets(
      steps.get('c'),
      [visit('v1', 'a', 1000), visit('v2', 'b', 2000)],
      steps,
      leadsTo({ v1: 'b', v2: 'c' })
    );
    expect(targets).toEqual([
      { screenKey: 'page_b', stepId: 'b', undoneVisitIds: ['v2'] },
      { screenKey: 'page_a', stepId: 'a', undoneVisitIds: ['v2', 'v1'] },
    ]);
  });

  it('stops at a step that is not a screen, whatever came before it', () => {
    const targets = backTargets(
      steps.get('c'),
      [visit('v0', 'signup', 500), visit('v1', 'a', 1000), visit('v2', 'code', 2000)],
      steps,
      leadsTo({ v0: 'a', v1: 'code', v2: 'c' })
    );
    expect(targets).toEqual([]);
    // Sign-up itself is never gone back to.
    expect(
      backTargets(steps.get('a'), [visit('v0', 'signup', 500)], steps, leadsTo({ v0: 'a' }))
    ).toEqual([]);
  });

  it('stops where a step was passed without a visit of its own (a condition went through)', () => {
    // a's submit went on to the code step, which was passed on its own and left no visit.
    expect(
      backTargets(steps.get('c'), [visit('v1', 'a', 1000)], steps, leadsTo({ v1: 'code' }))
    ).toEqual([]);
  });

  it('stops rather than guess when the times cannot tell the order of two visits', () => {
    // Both in the same millisecond: read a first, which does not lead to c, so nothing is offered.
    expect(
      backTargets(
        steps.get('c'),
        [visit('v1', 'a', 1000), visit('v2', 'b', 1000)],
        steps,
        leadsTo({ v1: 'b', v2: 'c' })
      )
    ).toEqual([]);
  });

  it('stops before visits completed at the same moment, even where they would lead on', () => {
    // b and c both lead where the next visit is, but their moment is shared: their order is not.
    expect(
      backTargets(
        steps.get('a'),
        [visit('v1', 'b', 1000), visit('v2', 'c', 2000), visit('v3', 'b', 2000)],
        steps,
        leadsTo({ v1: 'c', v2: 'b', v3: 'a' })
      )
    ).toEqual([]);
  });

  it('goes back from a screen only', () => {
    const anywhere = () => 'code';
    expect(backTargets(steps.get('code'), [visit('v1', 'a', 1000)], steps, anywhere)).toEqual([]);
    expect(backTargets(undefined, [visit('v1', 'a', 1000)], steps, anywhere)).toEqual([]);
  });

  it('offers a screen shown twice once, at its latest visit', () => {
    const targets = backTargets(
      steps.get('c'),
      [visit('v1', 'a', 1000), visit('v2', 'b', 2000), visit('v3', 'a', 3000)],
      steps,
      leadsTo({ v1: 'b', v2: 'a', v3: 'c' })
    );
    expect(targets.map((target) => [target.screenKey, target.undoneVisitIds])).toEqual([
      ['page_a', ['v3']],
      ['page_b', ['v3', 'v2']],
    ]);
  });

  it('passes a screen step with no screen, without offering it', () => {
    const targets = backTargets(
      steps.get('c'),
      [visit('v1', 'a', 1000), visit('v2', 'blank', 2000)],
      steps,
      leadsTo({ v1: 'blank', v2: 'c' })
    );
    expect(targets).toEqual([{ screenKey: 'page_a', stepId: 'a', undoneVisitIds: ['v2', 'v1'] }]);
  });

  it('stops at a step the Flow no longer has', () => {
    expect(
      backTargets(
        steps.get('c'),
        [visit('v1', 'a', 1000), visit('v2', 'gone', 2000)],
        steps,
        leadsTo({ v1: 'gone', v2: 'c' })
      )
    ).toEqual([]);
  });

  it('orders visits by the millisecond recorded, else by their second', () => {
    expect(completedAtMs(visit('v', 'a', 1234))).toBe(1234);
    expect(completedAtMs({ created_at: 7, state_json: null })).toBe(7000);
    expect(completedAtMs({ created_at: 7, state_json: '{not json' })).toBe(7000);
  });
});
