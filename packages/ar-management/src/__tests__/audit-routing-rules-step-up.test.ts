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
  updateRoutingRules,
} from '../routes/settings/audit-storage';

const KEY = 'audit_routing_rules';
const rule = (overrides: Record<string, unknown> = {}) => ({
  name: 'tenant-retention',
  priority: 10,
  enabled: true,
  conditions: { tenantId: 'tenant-a' },
  retention: { eventLogRetentionDays: 30 },
  ...overrides,
});

function setup(initial: unknown[] = []) {
  const store = new Map<string, string>(initial.length ? [[KEY, JSON.stringify(initial)]] : []);
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
  } as unknown as KVNamespace;
  const app = new Hono<{ Bindings: Env }>();
  app.put('/rules', updateRoutingRules);
  app.post('/rules', addRoutingRule);
  app.delete('/rules/:name', deleteRoutingRule);
  const env = { AUTHRIM_CONFIG: kv } as unknown as Env;
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
  return { call, put: kv.put as ReturnType<typeof vi.fn> };
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
    const { call, put } = setup();
    gate.mockResolvedValueOnce(refusal());
    const response = await call('/rules', 'POST', rule());
    expect(response.status).toBe(403);
    expect(put).not.toHaveBeenCalled();
  });

  it('adds a rule when the gate lets it through, with the rule in the descriptor', async () => {
    const { call, put } = setup();
    expect((await call('/rules', 'POST', rule())).status).toBe(200);
    expect(put).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledWith(expect.anything(), {
      operation: 'audit.retention.shorten',
      targetTenantId: expect.any(String) as unknown,
      params: { kind: 'audit_storage.routing_rules', action: 'add', rule: rule() },
    });
  });

  it('does not call the gate for an invalid or duplicate rule', async () => {
    const { call } = setup([rule()]);
    expect((await call('/rules', 'POST', rule({ priority: 'x' }))).status).toBe(400);
    expect((await call('/rules', 'POST', rule())).status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });

  it('refuses replacing the rules without step-up and keeps the old ones', async () => {
    const { call, put } = setup([rule()]);
    gate.mockResolvedValueOnce(refusal());
    const response = await call('/rules', 'PUT', {
      rules: [rule({ retention: { eventLogRetentionDays: 1 } })],
    });
    expect(response.status).toBe(403);
    expect(put).not.toHaveBeenCalled();
  });

  it('replaces the rules when allowed; an identical set and an invalid body skip the gate', async () => {
    const { call, put } = setup([rule()]);
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
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('gates deleting a rule, and not a missing one', async () => {
    const { call, put } = setup([rule()]);
    expect((await call('/rules/missing', 'DELETE')).status).toBe(404);
    expect(gate).not.toHaveBeenCalled();

    gate.mockResolvedValueOnce(refusal());
    expect((await call('/rules/tenant-retention', 'DELETE')).status).toBe(403);
    expect(put).not.toHaveBeenCalled();

    expect((await call('/rules/tenant-retention', 'DELETE')).status).toBe(200);
    expect(gate).toHaveBeenLastCalledWith(expect.anything(), {
      operation: 'audit.retention.shorten',
      targetTenantId: expect.any(String) as unknown,
      params: { kind: 'audit_storage.routing_rules', action: 'delete', name: 'tenant-retention' },
    });
  });
});
