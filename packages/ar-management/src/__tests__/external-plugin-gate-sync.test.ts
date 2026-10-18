import { generateVersion, type Env } from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';
import {
  ExternalPluginGateConflictError,
  ExternalPluginGateUnavailableError,
  readSavedExternalPluginSetting,
  reconcileRunnerExternalGate,
  setRunnerExternalGate,
} from '../external-plugin-gate-sync';

function kv(documents: Record<string, unknown> = {}) {
  return {
    get: vi.fn(async (key: string) => (key in documents ? JSON.stringify(documents[key]) : null)),
  } as unknown as KVNamespace;
}

/** A DB_ADMIN holding (or not) the canonical plugin document of tenant-a; records its SQL. */
function adminDatabase(document: Record<string, unknown> | null, options: { fail?: boolean } = {}) {
  const sql: string[] = [];
  const statement = (text: string) => {
    sql.push(text);
    const handle = {
      first: async () => {
        if (options.fail) throw new Error('d1_down');
        return document === null
          ? null
          : {
              tenant_id: 'tenant-a',
              scope_type: 'tenant',
              scope_id: 'tenant-a',
              category: 'plugin',
              document_json: JSON.stringify(document),
              version: generateVersion(document),
            };
      },
      all: async () => ({ results: [] }),
      run: async () => ({ success: true, meta: { changes: 1 } }),
    };
    return { bind: () => handle, ...handle };
  };
  const session = { prepare: statement };
  return { db: { prepare: statement, withSession: () => session } as unknown as D1Database, sql };
}

const savedKey = 'settings:tenant:tenant-a:plugin';

describe('readSavedExternalPluginSetting', () => {
  it('reads KV and the environment when there is no admin database to hold a canonical document', async () => {
    const on = { SETTINGS: kv({ [savedKey]: { 'plugin.enabled': true } }) } as unknown as Env;
    const off = { SETTINGS: kv({ [savedKey]: { 'plugin.enabled': false } }) } as unknown as Env;
    const env = { SETTINGS: kv(), PLUGIN_ENABLED: 'true' } as unknown as Env;
    expect(await readSavedExternalPluginSetting(on, 'tenant-a')).toBe(true);
    expect(await readSavedExternalPluginSetting(off, 'tenant-a')).toBe(false);
    expect(await readSavedExternalPluginSetting(env, 'tenant-a')).toBe(true);
    expect(
      await readSavedExternalPluginSetting({ SETTINGS: kv() } as unknown as Env, 'tenant-a')
    ).toBe(false);
  });

  it('goes by the canonical document over a KV copy that is behind, in both directions', async () => {
    const stale = kv({ [savedKey]: { 'plugin.enabled': true } });
    const turnedOff = {
      SETTINGS: stale,
      DB_ADMIN: adminDatabase({ 'plugin.enabled': false }).db,
    } as unknown as Env;
    expect(await readSavedExternalPluginSetting(turnedOff, 'tenant-a')).toBe(false);

    const behind = kv({ [savedKey]: { 'plugin.enabled': false } });
    const turnedOn = {
      SETTINGS: behind,
      DB_ADMIN: adminDatabase({ 'plugin.enabled': true }).db,
    } as unknown as Env;
    expect(await readSavedExternalPluginSetting(turnedOn, 'tenant-a')).toBe(true);
  });

  it('writes nothing when it reads (it does not create the canonical document)', async () => {
    const { db, sql } = adminDatabase(null);
    const env = {
      SETTINGS: kv({ [savedKey]: { 'plugin.enabled': true } }),
      DB_ADMIN: db,
    } as unknown as Env;

    expect(await readSavedExternalPluginSetting(env, 'tenant-a')).toBe(true);

    expect(sql.length).toBeGreaterThan(0);
    expect(sql.every((text) => /^\s*SELECT/iu.test(text))).toBe(true);
  });

  it('cannot read: the admin database failing, or the KV failing, is never "on"', async () => {
    const d1Down = {
      SETTINGS: kv({ [savedKey]: { 'plugin.enabled': true } }),
      DB_ADMIN: adminDatabase({ 'plugin.enabled': true }, { fail: true }).db,
    } as unknown as Env;
    await expect(readSavedExternalPluginSetting(d1Down, 'tenant-a')).rejects.toBeInstanceOf(
      ExternalPluginGateUnavailableError
    );
    const kvDown = {
      SETTINGS: { get: vi.fn().mockRejectedValue(new Error('kv_down')) },
    } as unknown as Env;
    await expect(readSavedExternalPluginSetting(kvDown, 'tenant-a')).rejects.toBeInstanceOf(
      ExternalPluginGateUnavailableError
    );
  });
});

function runnerWith(
  setTenantExternalGate: unknown,
  getTenantExternalGate: unknown = vi.fn(async (input: { tenantId: string }) => ({
    tenantId: input.tenantId,
    allowed: false,
    generation: 0,
  }))
) {
  return { PLUGIN_RUNNER: { setTenantExternalGate, getTenantExternalGate } } as unknown as Env;
}

describe('setRunnerExternalGate', () => {
  it('writes the gate and returns the runner answer; an open names the generation it read', async () => {
    const set = vi.fn(async (input: { tenantId: string; allowed: boolean }) => ({
      tenantId: input.tenantId,
      allowed: input.allowed,
      generation: 4,
    }));

    await expect(
      setRunnerExternalGate(runnerWith(set), 'tenant-a', true, { ifGeneration: 3 })
    ).resolves.toEqual({ tenantId: 'tenant-a', allowed: true, generation: 4 });
    expect(set).toHaveBeenCalledWith({ tenantId: 'tenant-a', allowed: true, ifGeneration: 3 });

    await setRunnerExternalGate(runnerWith(set), 'tenant-a', false);
    expect(set).toHaveBeenLastCalledWith({ tenantId: 'tenant-a', allowed: false });
  });

  it('never opens without the generation read, and never sends one with a close', async () => {
    const set = vi.fn();
    await expect(setRunnerExternalGate(runnerWith(set), 'tenant-a', true)).rejects.toBeInstanceOf(
      ExternalPluginGateUnavailableError
    );
    expect(set).not.toHaveBeenCalled();
  });

  it('reports a refused (stale) open as a conflict, which is also "unavailable"', async () => {
    const set = vi
      .fn()
      .mockRejectedValue(new Error('plugin_dynamic_external_gate_generation_conflict'));
    const error = await setRunnerExternalGate(runnerWith(set), 'tenant-a', true, {
      ifGeneration: 0,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalPluginGateConflictError);
    expect(error).toBeInstanceOf(ExternalPluginGateUnavailableError);
  });

  it('has nothing to gate without a plugin runner, unless one is required', async () => {
    await expect(setRunnerExternalGate({} as Env, 'tenant-a', false)).resolves.toBeNull();
    await expect(
      setRunnerExternalGate({} as Env, 'tenant-a', true, { requireRunner: true, ifGeneration: 0 })
    ).rejects.toBeInstanceOf(ExternalPluginGateUnavailableError);
  });

  it.each([
    ['a runner without the method', runnerWith(undefined)],
    ['a runner that fails', runnerWith(vi.fn().mockRejectedValue(new Error('boom')))],
    [
      'a runner that answers for another tenant',
      runnerWith(vi.fn(async () => ({ tenantId: 'other', allowed: true, generation: 1 }))),
    ],
    [
      'a runner that answers with another state',
      runnerWith(
        vi.fn(async (input: { tenantId: string; allowed: boolean }) => ({
          tenantId: input.tenantId,
          allowed: !input.allowed,
          generation: 1,
        }))
      ),
    ],
  ])('refuses to go on with %s (closing included)', async (_, env) => {
    await expect(
      setRunnerExternalGate(env, 'tenant-a', true, { ifGeneration: 0 })
    ).rejects.toBeInstanceOf(ExternalPluginGateUnavailableError);
    await expect(setRunnerExternalGate(env, 'tenant-a', false)).rejects.toBeInstanceOf(
      ExternalPluginGateUnavailableError
    );
  });
});

describe('reconcileRunnerExternalGate', () => {
  const grant = (allowed: boolean) => ({ 'plugin.enabled': allowed });
  const withSaved = (saved: boolean) => ({
    SETTINGS: kv({ [savedKey]: grant(saved) }),
  });

  it('reads the gate before the saved setting, then opens only from that generation', async () => {
    const order: string[] = [];
    const get = vi.fn(async (input: { tenantId: string }) => {
      order.push('get');
      return { tenantId: input.tenantId, allowed: false, generation: 5 };
    });
    const set = vi.fn(async (input: { tenantId: string; allowed: boolean }) => {
      order.push(`set:${input.allowed}`);
      return { tenantId: input.tenantId, allowed: input.allowed, generation: 6 };
    });
    const saved = kv({ [savedKey]: grant(true) });
    (saved.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
      order.push('saved');
      return key === savedKey ? JSON.stringify(grant(true)) : null;
    });
    const env = { ...runnerWith(set, get), SETTINGS: saved } as unknown as Env;

    await expect(reconcileRunnerExternalGate(env, 'tenant-a')).resolves.toBe(true);

    expect(order[0]).toBe('get');
    expect(order.indexOf('saved')).toBeLessThan(order.indexOf('set:true'));
    expect(set).toHaveBeenCalledWith({ tenantId: 'tenant-a', allowed: true, ifGeneration: 5 });
  });

  it('puts the gate where the saved setting is, not where the KV copy says', async () => {
    const set = vi.fn(async (input: { tenantId: string; allowed: boolean }) => ({
      tenantId: input.tenantId,
      allowed: input.allowed,
      generation: 1,
    }));
    const env = {
      ...runnerWith(set),
      SETTINGS: kv({ [savedKey]: grant(true) }),
      DB_ADMIN: adminDatabase({ 'plugin.enabled': false }).db,
    } as unknown as Env;

    await expect(reconcileRunnerExternalGate(env, 'tenant-a')).resolves.toBe(false);

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ tenantId: 'tenant-a', allowed: false });
  });

  it('closes the gate on a saved "off" even when it is closed already (the close counts)', async () => {
    const set = vi.fn(async (input: { tenantId: string; allowed: boolean }) => ({
      tenantId: input.tenantId,
      allowed: input.allowed,
      generation: 9,
    }));
    const env = { ...runnerWith(set), ...withSaved(false) } as unknown as Env;

    await expect(reconcileRunnerExternalGate(env, 'tenant-a')).resolves.toBe(false);
    expect(set).toHaveBeenCalledWith({ tenantId: 'tenant-a', allowed: false });
  });

  it('writes nothing when the gate is open and the setting is on', async () => {
    const set = vi.fn();
    const get = vi.fn(async (input: { tenantId: string }) => ({
      tenantId: input.tenantId,
      allowed: true,
      generation: 2,
    }));
    const env = { ...runnerWith(set, get), ...withSaved(true) } as unknown as Env;

    await expect(reconcileRunnerExternalGate(env, 'tenant-a')).resolves.toBe(true);
    expect(set).not.toHaveBeenCalled();
  });

  it('decides again from the start when the open is refused, and gives up after a few tries', async () => {
    const get = vi.fn(async (input: { tenantId: string }) => ({
      tenantId: input.tenantId,
      allowed: false,
      generation: 1,
    }));
    const set = vi
      .fn()
      .mockRejectedValue(new Error('plugin_dynamic_external_gate_generation_conflict'));
    const env = { ...runnerWith(set, get), ...withSaved(true) } as unknown as Env;

    await expect(reconcileRunnerExternalGate(env, 'tenant-a')).rejects.toBeInstanceOf(
      ExternalPluginGateUnavailableError
    );
    expect(get).toHaveBeenCalledTimes(3);
    expect(set).toHaveBeenCalledTimes(3);
  });

  it('leaves the gate alone when the saved setting cannot be read', async () => {
    const set = vi.fn();
    const env = {
      ...runnerWith(set),
      SETTINGS: { get: vi.fn().mockRejectedValue(new Error('kv_down')) },
    } as unknown as Env;

    await expect(reconcileRunnerExternalGate(env, 'tenant-a')).rejects.toBeInstanceOf(
      ExternalPluginGateUnavailableError
    );
    expect(set).not.toHaveBeenCalled();
  });
});
