/** Typed access to what a mock was called with, so tests need no `any`. */
export interface CallSource {
  mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
}

export function callArg(source: CallSource, call: number, index: number): unknown {
  const args = source.mock.calls[call];
  if (!args) throw new Error(`the mock was not called ${call + 1} time(s)`);
  return args[index];
}

export function rec(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('expected an object');
  return value as Record<string, unknown>;
}

export function argRec(source: CallSource, call = 0, index = 0): Record<string, unknown> {
  return rec(callArg(source, call, index));
}

/** Every first argument the mock was called with, as records (for logger-style mocks). */
export function entriesOf(source: CallSource): Array<Record<string, unknown>> {
  return source.mock.calls.map((args) => rec(args[0]));
}
