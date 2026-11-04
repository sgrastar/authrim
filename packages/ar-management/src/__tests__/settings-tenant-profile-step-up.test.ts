import { beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => vi.fn(async (): Promise<Response | null> => null));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: gate,
  refuseAdminFreshAuth: vi.fn(),
}));

import { Hono } from 'hono';
import { DISABLED_MARKER, type Env } from '@authrim/ar-lib-core';
import { gateStepUpSettingsPatch } from '../routes/settings-v2/step-up-settings';

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

const env = {
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
  refuse = false
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
      },
    });
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
