/**
 * Recording test doubles shared by the `*.mutation.test.ts` files. Each mocked class or function
 * appends `{ call, args }` to `log` and answers with the scripted `outcomes` entry (an Error is
 * thrown, a function is invoked with the arguments, anything else is returned as is).
 */
export interface LoggedCall {
  call: string;
  args: unknown[];
}

export const log: LoggedCall[] = [];
export const outcomes = new Map<string, unknown>();

export function resetKit(): void {
  log.length = 0;
  outcomes.clear();
}

function answer(key: string, args: unknown[]): unknown {
  log.push({ call: key, args });
  const outcome = outcomes.get(key);
  if (outcome instanceof Error) throw outcome;
  if (typeof outcome === 'function') return (outcome as (...input: unknown[]) => unknown)(...args);
  return outcomes.has(key) ? outcome : `${key}:result`;
}

export function mockFn(key: string): (...args: unknown[]) => unknown {
  return (...args: unknown[]) => answer(key, args);
}

export function mockClass(
  name: string,
  methods: readonly string[]
): new (...args: never[]) => object {
  class Recorded {
    constructor(...args: unknown[]) {
      log.push({ call: `${name}.new`, args });
    }
  }
  for (const method of methods) {
    Object.defineProperty(Recorded.prototype, method, {
      value: async function recorded(...args: unknown[]) {
        return answer(`${name}.${method}`, args);
      },
    });
  }
  return Recorded;
}

export function callsTo(call: string): unknown[][] {
  return log.filter((entry) => entry.call === call).map((entry) => entry.args);
}

export function must<T>(value: T | null | undefined, label = 'value'): T {
  if (value === null || value === undefined) throw new Error(`missing ${label}`);
  return value;
}

/** A rejection whose reason is not an Error, as a misbehaving binding might produce. */
export function rejectOpaque(reason: unknown): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point is a non-Error reason
  return Promise.reject(reason);
}
