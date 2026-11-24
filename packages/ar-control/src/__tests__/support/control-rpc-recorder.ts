import { vi, type Mock } from 'vitest';

export type RecordedMock = Mock<(...args: unknown[]) => unknown>;

/** Fixed clock used by every wiring test: 2023-11-14T22:13:20.123Z. */
export const FIXED_NOW_MS = 1_700_000_000_123;
export const FIXED_NOW_S = 1_700_000_000;

export interface Construction {
  readonly name: string;
  readonly args: readonly unknown[];
  readonly instance: unknown;
}

const fns = new Map<string, RecordedMock>();
export const constructions: Construction[] = [];

/** The mock behind `Class.method`; shared between the module mock and the test. */
export function fn(key: string): RecordedMock {
  let found = fns.get(key);
  if (!found) {
    found = vi.fn<(...args: unknown[]) => unknown>();
    fns.set(key, found);
  }
  return found;
}

export function resetRecorder(): void {
  for (const mock of fns.values()) mock.mockReset();
  constructions.length = 0;
}

/**
 * A class whose every instance method forwards to `fn('<name>.<method>')`, recording constructor
 * arguments. Static members are registered the same way under `<name>.<static>`.
 */
export function recordedClass(name: string, statics: readonly string[] = []): unknown {
  class Recorded {
    constructor(...args: unknown[]) {
      const instance = new Proxy(this, {
        get: (_target, property) =>
          typeof property === 'string' ? fn(`${name}.${property}`) : undefined,
      });
      constructions.push({ name, args, instance });
      return instance;
    }
  }
  for (const method of statics) {
    Object.defineProperty(Recorded, method, {
      value: (...args: unknown[]) => fn(`${name}.${method}`)(...args),
    });
  }
  return Recorded;
}

/** Replace named classes of a module with recording doubles, keeping every other export real. */
export function partial(
  original: object,
  classes: Readonly<Record<string, readonly string[]>>
): Record<string, unknown> {
  const replaced: Record<string, unknown> = { ...original };
  for (const [name, statics] of Object.entries(classes))
    replaced[name] = recordedClass(name, statics);
  return replaced;
}

export function constructionsOf(name: string): Construction[] {
  return constructions.filter((entry) => entry.name === name);
}

export function must<T>(value: T | null | undefined, label = 'value'): T {
  if (value === null || value === undefined) throw new Error(`missing ${label}`);
  return value;
}

/** Calls the `now` closure that production code passes to a collaborator constructor. */
export function clockArg(args: readonly unknown[], index: number): number {
  const clock = args[index];
  if (typeof clock !== 'function') throw new Error(`argument ${index} is not a clock`);
  return (clock as () => number)();
}
