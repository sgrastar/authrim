import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXED_NOW_MS, fn, invoke, make, resetRecorder } from './control-rpc-harness';
import { RESULT, expectWired, type WiringRow } from './rpc-wiring-table';

export const API_CLIENTS = { d1: { marker: 'd1' }, workers: { marker: 'workers' } };

/** Fake clock, clean recorder and default API clients for every wiring test. */
export function useWiringEnvironment(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
    resetRecorder();
    fn('createControlApiClients').mockReturnValue(API_CLIENTS);
  });
  afterEach(() => vi.useRealTimers());
}

/** Authorization, delegation, secret-free and error-masking checks shared by every row. */
export function defineWiringSuite(title: string, rows: readonly WiringRow[]): void {
  const table = rows.map((row) => [row.rpc, row] as const);
  describe(`${title}: authorization`, () => {
    it.each(table)('%s rejects callers outside ar-management', async (_name, row) => {
      for (const props of [
        { caller: 'ar-plugin-runner' as const },
        { caller: 'ar-lib-core' as const },
        { audience: 'other' as never },
        { environmentId: '-bad' },
        { environmentId: 'x'.repeat(129) },
      ]) {
        await expect(invoke(make(props).control, row.rpc, row.input)).rejects.toThrow(
          'control_rpc_caller_unauthorized'
        );
      }
      expect(fn(row.call)).not.toHaveBeenCalled();
    });
  });

  describe(`${title}: delegation`, () => {
    it.each(table)('%s forwards exact arguments and returns the result', async (_name, row) => {
      row.setup?.();
      fn(row.call).mockResolvedValue(RESULT);
      const { control, env } = make();
      await expect(invoke(control, row.rpc, row.input)).resolves.toBe(RESULT);
      expectWired(row, env);
    });

    it.each(table.filter(([, row]) => !row.noSecretCheck))(
      '%s refuses a result that carries secret material',
      async (_name, row) => {
        row.setup?.();
        fn(row.call).mockResolvedValue({ private_key: 'material' });
        await expect(invoke(make().control, row.rpc, row.input)).rejects.toThrow(
          /^control_internal_error$/u
        );
      }
    );

    it.each(table)(
      '%s passes contract errors through and masks internal ones',
      async (_name, row) => {
        row.setup?.();
        fn(row.call).mockRejectedValueOnce(new Error('invalid_anything'));
        await expect(invoke(make().control, row.rpc, row.input)).rejects.toThrow(
          /^invalid_anything$/u
        );
        fn(row.call).mockRejectedValueOnce(new Error('SQLITE_ERROR: no such table'));
        await expect(invoke(make().control, row.rpc, row.input)).rejects.toThrow(
          /^control_internal_error$/u
        );
      }
    );
  });
}
