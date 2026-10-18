import type { Env } from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';
import { processScheduledDirectoryJobs } from '../directory-scheduled';
import { SWEEP_LIMIT, sweepExternalPluginGates } from '../external-plugin-gate-sweep';

interface GateState {
  allowed: boolean;
  generation: number;
}

/**
 * A runner with the gates of some tenants and the tenants that have an enabled external
 * installation, listing candidates the way the real one does (open gates, and enabled external
 * installations without an open gate), by tenant id after a cursor.
 */
function runner(
  gates: Record<string, GateState>,
  installed: readonly string[] = [],
  options: { failFor?: string[]; failList?: boolean } = {}
) {
  const get = vi.fn(async (input: { tenantId: string }) => ({
    tenantId: input.tenantId,
    ...(gates[input.tenantId] ?? { allowed: false, generation: 0 }),
  }));
  const set = vi.fn(
    async (input: { tenantId: string; allowed: boolean; ifGeneration?: number }) => {
      if (options.failFor?.includes(input.tenantId)) throw new Error('plugin_sync_internal_error');
      const gate = (gates[input.tenantId] ??= { allowed: false, generation: 0 });
      if (input.allowed) {
        if (input.ifGeneration !== gate.generation) {
          throw new Error('plugin_dynamic_external_gate_generation_conflict');
        }
        if (!gate.allowed) {
          gate.allowed = true;
          gate.generation += 1;
        }
      } else {
        gate.allowed = false;
        gate.generation += 1;
      }
      return { tenantId: input.tenantId, ...gate };
    }
  );
  const list = vi.fn(async (input: { limit?: number; after?: string | null }) => {
    if (options.failList) throw new Error('plugin_sync_internal_error');
    const ids = new Set<string>(
      Object.entries(gates)
        .filter(([, gate]) => gate.allowed)
        .map(([id]) => id)
    );
    for (const id of installed) if (!gates[id]?.allowed) ids.add(id);
    return [...ids]
      .sort()
      .filter((id) => id > (input.after ?? ''))
      .slice(0, input.limit ?? 50)
      .map((id) => ({ tenantId: id, ...(gates[id] ?? { allowed: false, generation: 0 }) }));
  });
  return { get, set, list, gates };
}

function environment(
  service: ReturnType<typeof runner>,
  settings: Record<string, boolean> = {},
  vars: Record<string, string> = {}
) {
  const store = new Map<string, string>();
  for (const [tenant, enabled] of Object.entries(settings)) {
    store.set(`settings:tenant:${tenant}:plugin`, JSON.stringify({ 'plugin.enabled': enabled }));
  }
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  return {
    env: {
      SETTINGS: kv,
      PLUGIN_RUNNER: {
        getTenantExternalGate: service.get,
        setTenantExternalGate: service.set,
        listTenantExternalGateCandidates: service.list,
      },
      ...vars,
    } as unknown as Env,
    store,
  };
}

const logger = () => ({ info: vi.fn(), warn: vi.fn() });

describe('the reconciliation of the gates for external plugin code', () => {
  it('closes an open gate whose tenant turned the setting off', async () => {
    const service = runner({ 'tenant-a': { allowed: true, generation: 3 } });
    const { env } = environment(service, { 'tenant-a': false });
    const log = logger();

    await expect(sweepExternalPluginGates(env, log)).resolves.toMatchObject({
      examined: 1,
      closed: 1,
      opened: 0,
    });

    expect(service.gates['tenant-a']).toMatchObject({ allowed: false });
    expect(log.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ closed: 1 })
    );
  });

  it('closes an open gate when PLUGIN_ENABLED was changed to false and the tenant set nothing', async () => {
    // Deployed with PLUGIN_ENABLED=true (the gate was opened from it), redeployed with false.
    const service = runner({ 'tenant-a': { allowed: true, generation: 1 } });
    const { env } = environment(service, {}, { PLUGIN_ENABLED: 'false' });

    await sweepExternalPluginGates(env, logger());

    expect(service.gates['tenant-a']).toMatchObject({ allowed: false });
  });

  it('keeps open the gate of a tenant that still allows it, with no runner call but the listing', async () => {
    const service = runner({ 'tenant-a': { allowed: true, generation: 1 } });
    const { env } = environment(service, { 'tenant-a': true });
    const log = logger();

    await expect(sweepExternalPluginGates(env, log)).resolves.toMatchObject({
      examined: 1,
      opened: 0,
      closed: 0,
    });

    expect(service.get).not.toHaveBeenCalled();
    expect(service.set).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('opens the gate of an allowed tenant that has an enabled external installation and no gate row', async () => {
    const service = runner({}, ['tenant-a']);
    const { env } = environment(service, { 'tenant-a': true });

    await expect(sweepExternalPluginGates(env, logger())).resolves.toMatchObject({ opened: 1 });

    expect(service.set).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      allowed: true,
      ifGeneration: 0,
    });
    expect(service.gates['tenant-a']).toMatchObject({ allowed: true });
  });

  it('opens it for a tenant that inherits PLUGIN_ENABLED=true too', async () => {
    const service = runner({}, ['tenant-a']);
    const { env } = environment(service, {}, { PLUGIN_ENABLED: 'true' });

    await sweepExternalPluginGates(env, logger());

    expect(service.gates['tenant-a']).toMatchObject({ allowed: true });
  });

  it('leaves a missing or closed gate alone when the tenant does not allow it (closed already is the safe state)', async () => {
    const service = runner({ 'tenant-b': { allowed: false, generation: 4 } }, [
      'tenant-a',
      'tenant-b',
    ]);
    const { env } = environment(service, { 'tenant-a': false });
    const log = logger();

    await expect(sweepExternalPluginGates(env, log)).resolves.toMatchObject({
      examined: 2,
      opened: 0,
      closed: 0,
      failed: 0,
    });

    expect(service.set).not.toHaveBeenCalled();
    expect(service.gates['tenant-b']).toEqual({ allowed: false, generation: 4 });
    expect(log.info).not.toHaveBeenCalled();
  });

  it('does not write a gate that turned out closed already, when the listing was behind', async () => {
    // The listing said open; by the time the tenant is looked at, the gate is closed and the
    // setting is off. A close there would only advance the generation for nothing.
    const service = runner({ 'tenant-a': { allowed: false, generation: 6 } });
    service.list.mockResolvedValueOnce([{ tenantId: 'tenant-a', allowed: true, generation: 5 }]);
    const { env } = environment(service, { 'tenant-a': false });

    await expect(sweepExternalPluginGates(env, logger())).resolves.toMatchObject({
      examined: 1,
      closed: 0,
    });

    expect(service.get).toHaveBeenCalledTimes(1);
    expect(service.set).not.toHaveBeenCalled();
    expect(service.gates['tenant-a']).toEqual({ allowed: false, generation: 6 });
  });

  it('asks the runner for the list only, and logs nothing, when there is nothing to reconcile', async () => {
    const service = runner({});
    const { env } = environment(service);
    const log = logger();

    await expect(sweepExternalPluginGates(env, log)).resolves.toEqual({
      examined: 0,
      opened: 0,
      closed: 0,
      failed: 0,
    });

    expect(service.list).toHaveBeenCalledTimes(1);
    expect(service.get).not.toHaveBeenCalled();
    expect(service.set).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does nothing without a plugin runner (or one that cannot list)', async () => {
    await expect(sweepExternalPluginGates({} as Env, logger())).resolves.toBeNull();
    await expect(
      sweepExternalPluginGates({ PLUGIN_RUNNER: {} } as unknown as Env, logger())
    ).resolves.toBeNull();
  });

  it('takes a bounded page per run and carries the rest to the next runs, then starts over', async () => {
    const gates: Record<string, GateState> = {};
    const names = Array.from(
      { length: SWEEP_LIMIT * 2 + 5 },
      (_v, i) => `tenant-${String(i).padStart(3, '0')}`
    );
    for (const name of names) gates[name] = { allowed: true, generation: 1 };
    const service = runner(gates);
    // Every tenant but the last of each page still allows it; the three on the third page do not.
    const settings = Object.fromEntries(names.map((n, i) => [n, i < SWEEP_LIMIT * 2]));
    const { env, store } = environment(service, settings);

    const first = await sweepExternalPluginGates(env, logger());
    expect(first?.examined).toBe(SWEEP_LIMIT);
    expect(store.get('plugins:external-gate-sweep:cursor')).toBe(names[SWEEP_LIMIT - 1]);

    const second = await sweepExternalPluginGates(env, logger());
    expect(second?.examined).toBe(SWEEP_LIMIT);
    expect(service.list).toHaveBeenLastCalledWith({
      limit: SWEEP_LIMIT,
      after: names[SWEEP_LIMIT - 1],
    });

    const third = await sweepExternalPluginGates(env, logger());
    expect(third).toMatchObject({ examined: 5, closed: 5 });
    expect(store.has('plugins:external-gate-sweep:cursor')).toBe(false);
    expect(Object.values(service.gates).filter((gate) => gate.allowed)).toHaveLength(
      SWEEP_LIMIT * 2
    );
  });

  it('goes on with the other tenants when one cannot be reconciled, and says so', async () => {
    const service = runner(
      {
        'tenant-a': { allowed: true, generation: 1 },
        'tenant-b': { allowed: true, generation: 1 },
      },
      [],
      { failFor: ['tenant-a'] }
    );
    const { env } = environment(service, { 'tenant-a': false, 'tenant-b': false });
    const log = logger();

    await expect(sweepExternalPluginGates(env, log)).resolves.toMatchObject({
      examined: 2,
      closed: 1,
      failed: 1,
    });

    expect(service.gates['tenant-a'].allowed).toBe(true);
    expect(service.gates['tenant-b'].allowed).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('leaves a tenant whose setting cannot be read as it is, and retries it next pass', async () => {
    const service = runner({ 'tenant-a': { allowed: true, generation: 1 } });
    const { env } = environment(service, { 'tenant-a': false });
    (env.SETTINGS as unknown as { get: ReturnType<typeof vi.fn> }).get.mockImplementation(
      async (key: string) => {
        if (key.startsWith('settings:')) throw new Error('kv_down');
        return null;
      }
    );

    await expect(sweepExternalPluginGates(env, logger())).resolves.toMatchObject({ failed: 1 });
    expect(service.gates['tenant-a'].allowed).toBe(true);
  });

  it('throws when the listing fails, for the scheduler to log and retry', async () => {
    const service = runner({}, [], { failList: true });
    const { env } = environment(service);
    await expect(sweepExternalPluginGates(env, logger())).rejects.toThrow();
  });
});

describe('the scheduled run', () => {
  it('reconciles the gates even when the directory jobs cannot run, and survives a failure of the reconciliation', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = runner({ 'tenant-a': { allowed: true, generation: 1 } });
    const { env } = environment(service, { 'tenant-a': false });

    // No LOOKUP_DB: the directory jobs are skipped, the reconciliation still runs.
    await expect(processScheduledDirectoryJobs(env, log)).resolves.toMatchObject({ skipped: true });
    expect(service.gates['tenant-a'].allowed).toBe(false);

    // The runner failing does not stop the rest of the run, only logs.
    const broken = runner({}, [], { failList: true });
    const { env: brokenEnv } = environment(broken);
    await expect(processScheduledDirectoryJobs(brokenEnv, log)).resolves.toMatchObject({
      skipped: true,
    });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('reconciliation failed'));
  });
});
