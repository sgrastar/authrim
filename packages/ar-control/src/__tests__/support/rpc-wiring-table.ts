import { expect } from 'vitest';
import { clockArg, constructionsOf, fn, must } from './control-rpc-harness';
import type { ControlEnv } from '../../types';

/** One RPC whose body is "authorize, build a collaborator, forward the input". */
export interface WiringRow {
  readonly rpc: string;
  readonly input?: unknown;
  /** `Class.method` recorded by the harness. */
  readonly call: string;
  /** Expected arguments of `call`. */
  readonly args: readonly unknown[];
  /** Classes constructed with the control database as first argument (and clock as `clockAt`). */
  readonly dbClasses?: readonly string[];
  /** Index of the clock argument in the constructor of `clockClass`. */
  readonly clock?: { readonly cls: string; readonly index: number };
  /** Further recorded calls that must also have happened, with exact arguments. */
  readonly also?: readonly { readonly call: string; readonly args: readonly unknown[] }[];
  /** True when the collaborator clock is in milliseconds rather than seconds. */
  readonly clockMs?: boolean;
  /** Runs before the RPC is invoked (e.g. to stub a static factory). */
  readonly setup?: () => void;
  /** True when the body does not run the secret-free assertion on its result. */
  readonly noSecretCheck?: boolean;
  /** Authorization tier; defaults to management-only. */
  readonly tier?: 'management';
}

export const RESULT = Object.freeze({ ok: 'result-sentinel' });

export function expectWired(row: WiringRow, env: ControlEnv): void {
  expect(fn(row.call)).toHaveBeenCalledTimes(1);
  expect(fn(row.call).mock.calls[0]).toEqual([...row.args]);
  for (const extra of row.also ?? []) {
    expect(fn(extra.call)).toHaveBeenCalledTimes(1);
    expect(fn(extra.call).mock.calls[0]).toEqual([...extra.args]);
    for (const construction of constructionsOf(extra.call.split('.')[0] ?? '')) {
      expect(construction.args[0]).toBe(env);
      expect((construction.args[1] as () => number)()).toBe(1_700_000_000);
    }
  }
  for (const cls of row.dbClasses ?? []) {
    const built = constructionsOf(cls);
    expect(built.length, `${cls} constructed`).toBeGreaterThanOrEqual(1);
    expect(must(built[0]).args[0]).toBe(env.CONTROL_DB);
    for (const construction of built) {
      for (const argument of construction.args) {
        if (typeof argument === 'function') {
          expect((argument as () => number)()).toBe(
            row.clockMs ? 1_700_000_000_123 : 1_700_000_000
          );
        }
      }
    }
  }
  if (row.clock) {
    expect(clockArg(must(constructionsOf(row.clock.cls)[0]).args, row.clock.index)).toBe(
      1_700_000_000
    );
  }
}
