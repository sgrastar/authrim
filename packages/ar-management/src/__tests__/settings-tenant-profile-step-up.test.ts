import { beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => vi.fn(async (): Promise<Response | null> => null));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: gate,
  refuseAdminFreshAuth: vi.fn(),
}));

import { Hono } from 'hono';
import { openCoreStore } from './helpers/core-schema-sqlite';
import { createSettingsCanonicalD1 } from './helpers/settings-canonical-d1';
import { DISABLED_MARKER, type Env } from '@authrim/ar-lib-core';
import {
  gateStepUpSettingsPatch,
  verifyProfileSwitch,
} from '../routes/settings-v2/step-up-settings';
import type { ProfileSwitchGuard } from '../profile-switch-verify';
import { createInfrastructureSettingsManager } from '../runtime-profiles';

const profiles: Record<string, Record<string, unknown>> = {
  'profile-registry:residency:res-none': {
    id: 'res-none',
    kind: 'residency',
    label: 'None',
    builtin: false,
    locationHint: 'auto',
    jurisdiction: 'none',
  },
  'profile-registry:residency:res-none-2': {
    id: 'res-none-2',
    kind: 'residency',
    label: 'None 2',
    builtin: false,
    locationHint: 'auto',
    jurisdiction: 'none',
  },
  'profile-registry:residency:res-eu': {
    id: 'res-eu',
    kind: 'residency',
    label: 'EU',
    builtin: false,
    locationHint: 'weur',
    jurisdiction: 'eu',
  },
  'profile-registry:audit:aud-90': auditProfile('aud-90', 90),
  'profile-registry:audit:aud-30': auditProfile('aud-30', 30),
  'profile-registry:audit:aud-400': auditProfile('aud-400', 400),
  'profile-registry:audit:aud-sink-short': {
    ...auditProfile('aud-sink-short', 30),
    sinks: [{ type: 'http', url: 'https://logs.example.com/in', method: 'POST', format: 'json' }],
  },
  'profile-registry:audit:aud-sink': {
    ...auditProfile('aud-sink', 400),
    sinks: [{ type: 'http', url: 'https://logs.example.com/in', method: 'POST', format: 'json' }],
  },
};

function auditProfile(id: string, days: number) {
  return {
    id,
    kind: 'audit',
    label: id,
    builtin: false,
    primary: null,
    archive: null,
    sinks: [],
    retention: { eventLogRetentionDays: days, piiLogRetentionDays: days },
  };
}

const core = openCoreStore();
const env = {
  // Profiles compared for a switch are read the way a write reads them (core D1, else KV).
  DB: core.adapter,
  // The environment default is read from the canonical document (and projected to SETTINGS).
  DB_ADMIN: createSettingsCanonicalD1(),
  SETTINGS: { get: async () => null, put: async () => undefined },
  AUTHRIM_CONFIG: {
    get: async (key: string) => (profiles[key] ? JSON.stringify(profiles[key]) : null),
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
  },
  PROFILE_REGISTRY_BACKEND: 'kv',
  DEFAULT_RESIDENCY_PROFILE_ID: 'res-none',
  DEFAULT_AUDIT_PROFILE_ID: 'aud-90',
} as unknown as Env;

/** A manager whose dry run turns `before` into `after`. */
function manager(before: Record<string, unknown>, after: Record<string, unknown>) {
  return {
    patch: vi.fn(async () => ({ candidate: { before, after } })),
    getAll: vi.fn(async () => ({ inherited: { values: {} } })),
  };
}

async function run(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  body: Record<string, unknown>,
  refuse = false,
  guard?: ProfileSwitchGuard
) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/x', async (c) => {
    const refused = await gateStepUpSettingsPatch({
      c: c as never,
      manager: manager(before, after) as never,
      category: 'tenant',
      scope: { type: 'tenant', id: 'tenant-a' },
      targetTenantId: 'tenant-a',
      body: { ifMatch: '1', ...body },
      actor: 'admin-1',
      refuse,
      guard,
    });
    return refused ?? c.json({ saved: true });
  });
  const response = await app.request('/x', { method: 'POST' }, env);
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

const refusal = () =>
  new Response(JSON.stringify({ error: 'step_up_required' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });

describe('tenant profile switching needs step-up', () => {
  beforeEach(() => {
    gate.mockReset();
    gate.mockResolvedValue(null);
  });

  it('gates a residency switch to another jurisdiction as tenant.jurisdiction.update', async () => {
    const result = await run(
      {},
      { 'tenant.residency_profile_id': 'res-eu' },
      { set: { 'tenant.residency_profile_id': 'res-eu' } }
    );
    expect(result).toEqual({ status: 200, body: { saved: true } });
    expect(gate).toHaveBeenCalledWith(expect.anything(), {
      operation: 'tenant.jurisdiction.update',
      targetTenantId: 'tenant-a',
      params: {
        category: 'tenant',
        residency_profile_id: 'res-eu',
        from_jurisdiction: 'none',
        to_jurisdiction: 'eu',
      },
    });
  });

  it('refuses with the gate response, and clearing back to the default counts as a switch', async () => {
    gate.mockResolvedValueOnce(refusal());
    const result = await run(
      { 'tenant.residency_profile_id': 'res-eu' },
      {},
      { clear: ['tenant.residency_profile_id'] }
    );
    expect(result.status).toBe(403);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate.mock.calls[0]).toEqual([
      expect.anything(),
      expect.objectContaining({
        params: expect.objectContaining({
          from_jurisdiction: 'eu',
          to_jurisdiction: 'none',
        }) as unknown,
      }),
    ]);
  });

  it('disabling a tenant profile id is judged on the document that is left', async () => {
    const result = await run(
      { 'tenant.residency_profile_id': 'res-eu' },
      { 'tenant.residency_profile_id': DISABLED_MARKER },
      { disable: ['tenant.residency_profile_id'] }
    );
    expect(result.status).toBe(200);
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('does not gate a residency switch that keeps the jurisdiction, or no change at all', async () => {
    await run(
      {},
      { 'tenant.residency_profile_id': 'res-none-2' },
      { set: { 'tenant.residency_profile_id': 'res-none-2' } }
    );
    await run(
      { 'tenant.residency_profile_id': 'res-eu' },
      { 'tenant.residency_profile_id': 'res-eu' },
      { set: { 'tenant.residency_profile_id': 'res-eu' } }
    );
    expect(gate).not.toHaveBeenCalled();
  });

  it('gates a switch to a shorter-retention audit profile as audit.retention.shorten', async () => {
    const result = await run(
      {},
      { 'tenant.audit_profile_id': 'aud-30' },
      { set: { 'tenant.audit_profile_id': 'aud-30' } }
    );
    expect(result.status).toBe(200);
    expect(gate).toHaveBeenCalledWith(expect.anything(), {
      operation: 'audit.retention.shorten',
      targetTenantId: 'tenant-a',
      params: {
        category: 'tenant',
        audit_profile_id: 'aud-30',
        retention: { eventLogRetentionDays: 30, piiLogRetentionDays: 30 },
        delivery_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
        target_sha256: expect.any(Array) as unknown,
        archive_failure_mode: null,
        sink_failure_mode: null,
        backpressure: null,
      },
    });
  });

  it('gates a switch to a longer-retention profile that sends logs elsewhere', async () => {
    const result = await run(
      {},
      { 'tenant.audit_profile_id': 'aud-sink' },
      { set: { 'tenant.audit_profile_id': 'aud-sink' } }
    );
    expect(result.status).toBe(200);
    expect(gate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'webhook.destination.update',
        params: expect.objectContaining({
          audit_profile_id: 'aud-sink',
          delivery_sha256: expect.any(String) as unknown,
        }) as unknown,
      })
    );
  });

  it('does not gate a switch to a longer-retention audit profile', async () => {
    await run(
      {},
      { 'tenant.audit_profile_id': 'aud-400' },
      { set: { 'tenant.audit_profile_id': 'aud-400' } }
    );
    expect(gate).not.toHaveBeenCalled();
  });

  it('refuses one PATCH that needs both operations, without asking the gate', async () => {
    const result = await run(
      {},
      { 'tenant.residency_profile_id': 'res-eu', 'tenant.audit_profile_id': 'aud-30' },
      { set: { 'tenant.residency_profile_id': 'res-eu', 'tenant.audit_profile_id': 'aud-30' } }
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: 'step_up_separate_operations' });
    expect(gate).not.toHaveBeenCalled();
  });

  it('bulk apply refuses a profile switch instead of asking for a receipt', async () => {
    const result = await run(
      {},
      { 'tenant.residency_profile_id': 'res-eu' },
      { set: { 'tenant.residency_profile_id': 'res-eu' } },
      true
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: 'step_up_not_in_bulk',
      operation: 'tenant.jurisdiction.update',
    });
    expect(gate).not.toHaveBeenCalled();
  });
});

describe('when the environment defaults cannot be read', () => {
  it('refuses the save instead of comparing against the built-in default', async () => {
    gate.mockReset();
    const failingSettings = {
      get: async () => {
        throw new Error('kv unavailable');
      },
      list: async () => {
        throw new Error('kv unavailable');
      },
    };
    const app = new Hono<{ Bindings: Env }>();
    app.post('/x', async (c) => {
      const refused = await gateStepUpSettingsPatch({
        c: c as never,
        manager: manager(
          { 'tenant.residency_profile_id': 'res-eu' },
          { 'tenant.residency_profile_id': 'res-none' }
        ) as never,
        category: 'tenant',
        scope: { type: 'tenant', id: 'tenant-a' },
        targetTenantId: 'tenant-a',
        body: { ifMatch: '1', set: { 'tenant.residency_profile_id': 'res-none' } },
        actor: 'admin-1',
      });
      return refused ?? c.json({ saved: true });
    });
    app.onError((_error, c) => c.json({ error: 'server_error' }, 500));
    const response = await app.request(
      '/x',
      { method: 'POST' },
      {
        ...env,
        SETTINGS: failingSettings,
      }
    );
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty('saved');
  });
});

describe('a profile switch is verified after it is saved', () => {
  beforeEach(() => {
    gate.mockReset();
    gate.mockResolvedValue(null);
  });

  const committed = {
    version: 'sha256:0123456789abcdef',
    applied: ['tenant.audit_profile_id'],
    cleared: [],
    disabled: [],
  };
  const verify = (guard: ProfileSwitchGuard, mgr: ReturnType<typeof manager>) =>
    verifyProfileSwitch({
      env,
      manager: mgr as never,
      category: 'tenant',
      scope: { type: 'tenant', id: 'tenant-a' },
      guard,
      result: committed,
      actor: 'admin-1',
    });

  it('records the profiles compared and the document before the change', async () => {
    const guard: ProfileSwitchGuard = { compared: [] };
    await run(
      { 'tenant.audit_profile_id': 'aud-90' },
      { 'tenant.audit_profile_id': 'aud-400' },
      { set: { 'tenant.audit_profile_id': 'aud-400' } },
      false,
      guard
    );
    expect(guard.compared.map((item) => item.id).sort()).toEqual(['aud-400', 'aud-90']);
    expect(guard.before).toEqual({ 'tenant.audit_profile_id': 'aud-90' });
  });

  it('keeps the switch when the compared profiles are as they were', async () => {
    const mgr = manager({}, {});
    const guard: ProfileSwitchGuard = {
      compared: [{ kind: 'audit', id: 'aud-90', token: null }],
      before: {},
    };
    expect(await verify(guard, mgr)).toBe(true);
    expect(mgr.patch).not.toHaveBeenCalled();
  });

  it('puts the switch back, against the version it saved, when a compared profile changed', async () => {
    const mgr = manager({}, {});
    const guard: ProfileSwitchGuard = {
      compared: [{ kind: 'audit', id: 'aud-90', token: null }],
      before: { 'tenant.audit_profile_id': 'aud-90' },
    };
    // Another request lengthened aud-90 after the decision.
    core.db
      .prepare('INSERT INTO profile_registry (id, kind, payload_json) VALUES (?, ?, ?)')
      .run('aud-90', 'audit', JSON.stringify(profiles['profile-registry:audit:aud-90']));
    expect(await verify(guard, mgr)).toBe(false);
    expect(mgr.patch).toHaveBeenCalledWith(
      'tenant',
      { type: 'tenant', id: 'tenant-a' },
      { ifMatch: committed.version, set: { 'tenant.audit_profile_id': 'aud-90' }, clear: [] },
      'admin-1',
      { skipDependencyCheck: true }
    );
    core.db.prepare("DELETE FROM profile_registry WHERE id = 'aud-90'").run();
  });

  it('clears a key that had no value of its own before', async () => {
    const mgr = manager({}, {});
    const guard: ProfileSwitchGuard = {
      compared: [{ kind: 'audit', id: 'aud-x', token: 'gone' }],
      before: {},
    };
    expect(await verify(guard, mgr)).toBe(false);
    expect(mgr.patch).toHaveBeenCalledWith(
      'tenant',
      expect.anything(),
      { ifMatch: committed.version, set: {}, clear: ['tenant.audit_profile_id'] },
      'admin-1',
      { skipDependencyCheck: true }
    );
  });
});

describe('compound switches carry both operations', () => {
  beforeEach(() => {
    gate.mockReset();
    gate.mockResolvedValue(null);
  });

  it('a switch that changes delivery and shortens retention gates one receipt covering both', async () => {
    await run(
      {},
      { 'tenant.audit_profile_id': 'aud-sink-short' },
      { set: { 'tenant.audit_profile_id': 'aud-sink-short' } }
    );
    expect(gate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'webhook.destination.update',
        alsoCovers: ['audit.retention.shorten'],
      })
    );
  });

  it('a delivery-only or retention-only switch carries no extra operation', async () => {
    await run(
      {},
      { 'tenant.audit_profile_id': 'aud-sink' },
      { set: { 'tenant.audit_profile_id': 'aud-sink' } }
    );
    await run(
      {},
      { 'tenant.audit_profile_id': 'aud-30' },
      { set: { 'tenant.audit_profile_id': 'aud-30' } }
    );
    for (const call of gate.mock.calls as unknown as Array<[unknown, Record<string, unknown>]>) {
      expect(call[1]).not.toHaveProperty('alsoCovers');
    }
  });
});

describe('a switch from the environment default depends on the default document', () => {
  beforeEach(() => {
    gate.mockReset();
    gate.mockResolvedValue(null);
  });

  const committed = {
    version: 'sha256:0123456789abcdef',
    applied: ['tenant.audit_profile_id'],
    cleared: [],
    disabled: [],
  };

  it('records the default document version when a side of the switch is the default', async () => {
    const guard: ProfileSwitchGuard = { compared: [] };
    // The tenant sets no id of its own before: it inherits the environment default.
    await run(
      {},
      { 'tenant.audit_profile_id': 'aud-400' },
      { set: { 'tenant.audit_profile_id': 'aud-400' } },
      false,
      guard
    );
    expect(guard.infrastructureVersion).toMatch(/^sha256:/);

    const own: ProfileSwitchGuard = { compared: [] };
    await run(
      { 'tenant.audit_profile_id': 'aud-90' },
      { 'tenant.audit_profile_id': 'aud-400' },
      { set: { 'tenant.audit_profile_id': 'aud-400' } },
      false,
      own
    );
    expect(own.infrastructureVersion).toBeUndefined();
  });

  it('puts the switch back when the default changed before it committed', async () => {
    const guard: ProfileSwitchGuard = { compared: [] };
    await run(
      {},
      { 'tenant.audit_profile_id': 'aud-400' },
      { set: { 'tenant.audit_profile_id': 'aud-400' } },
      false,
      guard
    );
    guard.before = {};
    const mgr = manager({}, {});
    const verify = () =>
      verifyProfileSwitch({
        env,
        manager: mgr as never,
        category: 'tenant',
        scope: { type: 'tenant', id: 'tenant-a' },
        guard,
        result: committed,
        actor: 'admin-1',
      });
    expect(await verify()).toBe(true);
    expect(mgr.patch).not.toHaveBeenCalled();

    // Meanwhile the environment default is pointed at a 365-day profile.
    const infrastructure = createInfrastructureSettingsManager(env);
    const current = await infrastructure.getAll('infrastructure', { type: 'platform' });
    await infrastructure.patch(
      'infrastructure',
      { type: 'platform' },
      { ifMatch: current.version, set: { 'infra.default_audit_profile_id': 'aud-400' } },
      'test'
    );
    // Restore, so later tests in this file see the default the environment says.
    const restore = async () => {
      const latest = await infrastructure.getAll('infrastructure', { type: 'platform' });
      await infrastructure.patch(
        'infrastructure',
        { type: 'platform' },
        { ifMatch: latest.version, clear: ['infra.default_audit_profile_id'] },
        'test'
      );
    };
    try {
      expect(await verify()).toBe(false);
      expect(mgr.patch).toHaveBeenCalledWith(
        'tenant',
        { type: 'tenant', id: 'tenant-a' },
        { ifMatch: committed.version, set: {}, clear: ['tenant.audit_profile_id'] },
        'admin-1',
        { skipDependencyCheck: true }
      );
    } finally {
      await restore();
    }
  });
});

describe('inherited ids and unregistered ids', () => {
  beforeEach(() => {
    gate.mockReset();
    gate.mockResolvedValue(null);
  });

  it('setting the id the tenant already inherits still depends on the default document', async () => {
    const guard: ProfileSwitchGuard = { compared: [] };
    // Default aud-90, no id of its own: the PATCH names aud-90 explicitly (same effective id).
    await run(
      {},
      { 'tenant.audit_profile_id': 'aud-90' },
      { set: { 'tenant.audit_profile_id': 'aud-90' } },
      false,
      guard
    );
    expect(gate).not.toHaveBeenCalled();
    expect(guard.infrastructureVersion).toMatch(/^sha256:/);

    // An unrelated PATCH records nothing.
    const none: ProfileSwitchGuard = { compared: [] };
    await run({}, {}, { set: { 'tenant.something_else': 1 } }, false, none);
    expect(none.infrastructureVersion).toBeUndefined();
  });

  it('compares an unregistered id as the built-in profile', async () => {
    // From a profile with an external sink to an id nobody registered: logs go to the built-in
    // delivery, so the external sink stops; the unknown retention counts too.
    await run(
      { 'tenant.audit_profile_id': 'aud-sink' },
      { 'tenant.audit_profile_id': 'aud-missing' },
      { set: { 'tenant.audit_profile_id': 'aud-missing' } }
    );
    expect(gate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'webhook.destination.update',
        alsoCovers: ['audit.retention.shorten'],
      })
    );
  });
});
