import { beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => vi.fn(async (): Promise<Response | null> => null));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: gate,
  refuseAdminFreshAuth: vi.fn(),
}));

import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  addRoutingRule,
  deleteRoutingRule,
  getRoutingRules,
  updateRoutingRules,
} from '../routes/settings/audit-storage';
import { createSettingsCanonicalD1 } from './helpers/settings-canonical-d1';

const LEGACY_KEY = 'audit_routing_rules';
const PROJECTION_KEY = 'settings:platform:audit-routing';
const rule = (overrides: Record<string, unknown> = {}) => ({
  name: 'tenant-retention',
  priority: 10,
  enabled: true,
  conditions: { tenantId: 'tenant-a' },
  retention: { eventLogRetentionDays: 30 },
  ...overrides,
});

function createKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
  } as unknown as KVNamespace;
  return { kv, store };
}

/** `initial` is stored the way it was before the rules became a settings document. */
function setup(initial: unknown[] = []) {
  const legacy = createKV(initial.length ? { [LEGACY_KEY]: JSON.stringify(initial) } : {});
  const settings = createKV();
  const app = new Hono<{ Bindings: Env }>();
  app.put('/rules', updateRoutingRules);
  app.post('/rules', addRoutingRule);
  app.delete('/rules/:name', deleteRoutingRule);
  app.get('/rules', async (c) => c.json(await getRoutingRules(c)));
  const adminDb = createSettingsCanonicalD1();
  const env = {
    AUTHRIM_CONFIG: legacy.kv,
    SETTINGS: settings.kv,
    DB_ADMIN: adminDb,
  } as unknown as Env;
  /** Nothing was written: no canonical document, nothing projected to the settings KV. */
  const expectNothingWritten = async () => {
    const row = await adminDb
      .prepare('SELECT COUNT(*) AS n FROM platform_settings_documents')
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
    expect(settings.kv.put).not.toHaveBeenCalled();
    expect(settings.store.size).toBe(0);
  };
  const call = (path: string, method: string, body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env
    );
  /** The rules runtime reads (the projection of the settings document). */
  const projected = () => {
    const text = settings.store.get(PROJECTION_KEY);
    return text
      ? ((JSON.parse(text) as Record<string, unknown>)['audit-routing.rules'] as unknown[])
      : undefined;
  };
  return { call, projected, legacy: legacy.store, expectNothingWritten };
}

const refusal = () =>
  new Response(JSON.stringify({ error: 'step_up_required' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });

describe('audit retention routing rules need step-up', () => {
  beforeEach(() => {
    gate.mockReset();
    gate.mockResolvedValue(null);
  });

  it('refuses adding a rule without step-up and writes nothing', async () => {
    const { call, projected } = setup();
    gate.mockResolvedValueOnce(refusal());
    const response = await call('/rules', 'POST', rule());
    expect(response.status).toBe(403);
    expect(projected() ?? []).toEqual([]);
  });

  it('adds a rule when the gate lets it through, with the rule in the descriptor', async () => {
    const { call, projected } = setup();
    expect((await call('/rules', 'POST', rule())).status).toBe(200);
    expect(projected()).toEqual([rule()]);
    expect(gate).toHaveBeenCalledWith(expect.anything(), {
      operation: 'audit.retention.shorten',
      targetTenantId: expect.any(String) as unknown,
      params: {
        kind: 'audit_storage.routing_rules',
        action: 'add',
        rule: rule(),
        // The whole resulting set and the version it was derived from are bound.
        resulting_rules_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
        judged_version: expect.stringMatching(/^sha256:/) as unknown,
      },
    });
  });

  it('does not call the gate for an invalid or duplicate rule', async () => {
    const { call } = setup([rule()]);
    expect((await call('/rules', 'POST', rule({ priority: 'x' }))).status).toBe(400);
    expect((await call('/rules', 'POST', rule())).status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });

  it('refuses replacing the rules without step-up and keeps the old ones', async () => {
    const { call, expectNothingWritten } = setup([rule()]);
    gate.mockResolvedValueOnce(refusal());
    const response = await call('/rules', 'PUT', {
      rules: [rule({ retention: { eventLogRetentionDays: 1 } })],
    });
    expect(response.status).toBe(403);
    // First use after an upgrade: a refused request does not even create the document.
    await expectNothingWritten();
  });

  it('replaces the rules when allowed; an identical set and an invalid body skip the gate', async () => {
    const { call, projected } = setup([rule()]);
    expect((await call('/rules', 'PUT', { rules: [rule()] })).status).toBe(200);
    expect((await call('/rules', 'PUT', { rules: 'nope' })).status).toBe(400);
    expect(gate).not.toHaveBeenCalled();

    expect(
      (await call('/rules', 'PUT', { rules: [rule({ retention: { eventLogRetentionDays: 7 } })] }))
        .status
    ).toBe(200);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'audit.retention.shorten',
        params: expect.objectContaining({ action: 'replace' }) as unknown,
      })
    );
    expect(projected()).toEqual([rule({ retention: { eventLogRetentionDays: 7 } })]);
  });

  it('gates deleting a rule, and not a missing one', async () => {
    const { call, projected, expectNothingWritten } = setup([rule()]);
    expect((await call('/rules/missing', 'DELETE')).status).toBe(404);
    expect(gate).not.toHaveBeenCalled();

    gate.mockResolvedValueOnce(refusal());
    expect((await call('/rules/tenant-retention', 'DELETE')).status).toBe(403);
    await expectNothingWritten();

    expect((await call('/rules/tenant-retention', 'DELETE')).status).toBe(200);
    expect(projected()).toEqual([]);
    expect(gate).toHaveBeenLastCalledWith(expect.anything(), {
      operation: 'audit.retention.shorten',
      targetTenantId: expect.any(String) as unknown,
      params: {
        kind: 'audit_storage.routing_rules',
        action: 'delete',
        name: 'tenant-retention',
        resulting_rules_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
        judged_version: expect.stringMatching(/^sha256:/) as unknown,
      },
    });
  });

  it('adopts the rules kept before the settings document, and leaves them alone', async () => {
    const { call, projected, legacy } = setup([rule()]);
    // First read creates the document from the legacy value; nothing is lost.
    expect((await call('/rules', 'POST', rule({ name: 'second', priority: 20 }))).status).toBe(200);
    expect(projected()).toEqual([rule(), rule({ name: 'second', priority: 20 })]);
    expect(JSON.parse(legacy.get(LEGACY_KEY) ?? '[]')).toEqual([rule()]);
  });

  it('refuses a change made after another one was saved, and writes nothing', async () => {
    const { call, projected } = setup([rule()]);
    // While this request waits for its step-up, another request saves a rule.
    gate.mockImplementationOnce(async () => {
      expect((await call('/rules', 'POST', rule({ name: 'other', priority: 5 }))).status).toBe(200);
      return null;
    });
    const response = await call('/rules', 'PUT', {
      rules: [rule({ retention: { eventLogRetentionDays: 1 } })],
    });
    expect(response.status).toBe(409);
    expect(projected()).toEqual([rule({ name: 'other', priority: 5 }), rule()]);
  });

  it('binds the resulting rule set and the judged version, so a receipt does not carry over', async () => {
    const bound = async (initial: unknown[]) => {
      gate.mockClear();
      const { call } = setup(initial);
      await call('/rules', 'POST', rule({ name: 'added', priority: 20 }));
      const params = (
        gate.mock.calls[0] as unknown as [unknown, { params: Record<string, string> }]
      )[1].params;
      return { sha: params.resulting_rules_sha256, version: params.judged_version };
    };
    const onA = await bound([rule()]);
    const onSame = await bound([rule()]);
    const onOther = await bound([rule({ name: 'someone-elses', priority: 5 })]);
    // The same change on the same set binds the same values; on a changed set, different ones.
    expect(onSame).toEqual(onA);
    expect(onOther.sha).not.toBe(onA.sha);
    expect(onOther.version).not.toBe(onA.version);
  });

  it('refuses a rule set too large to be stored before the gate', async () => {
    const { call, projected } = setup();
    const rules = Array.from({ length: 4600 }, (_, index) =>
      rule({ name: `${String(index).padStart(5, '0')}-${'x'.repeat(240)}`, priority: index })
    );
    const response = await call('/rules', 'PUT', { rules });
    expect(response.status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
    expect(projected()).toBeUndefined();
  });
});
