import { beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => vi.fn(async (): Promise<Response | null> => null));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: gate,
  refuseAdminFreshAuth: vi.fn(),
}));

import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '@authrim/ar-lib-core';
import { DEFAULT_AUDIT_PROFILE_ID, DEFAULT_RESIDENCY_PROFILE_ID } from '@authrim/ar-lib-core';
import { createSettingsCanonicalD1 } from './helpers/settings-canonical-d1';
import {
  adminRuntimeProfileDefaultsUpdateHandler,
  adminRuntimeProfileDeleteHandler,
  adminRuntimeProfileUpsertHandler,
} from '../runtime-profiles';

function createKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
    list: vi.fn(async (options?: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((key) => !options?.prefix || key.startsWith(options.prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: '',
    })),
  } as unknown as KVNamespace;
  return { kv, store };
}

const audit = (days: number, extra: Record<string, unknown> = {}) => ({
  label: 'Audit',
  version: 1,
  primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
  archive: null,
  sinks: [],
  retention: { eventLogRetentionDays: days, piiLogRetentionDays: days, ...extra },
});
const residency = (jurisdiction: string) => ({
  label: 'Residency',
  version: 1,
  locationHint: 'auto',
  jurisdiction,
});
const stored = (id: string, kind: string, body: Record<string, unknown>) => [
  `profile-registry:${kind}:${id}`,
  JSON.stringify({ id, kind, builtin: false, ...body }),
];

function setup(profiles: Array<[string, string]> = [], envExtra: Record<string, unknown> = {}) {
  const config = createKV(Object.fromEntries(profiles));
  const env = {
    DB: {} as D1Database,
    DB_ADMIN: createSettingsCanonicalD1(),
    AUTHRIM_CONFIG: config.kv,
    SETTINGS: createKV().kv,
    AUTHRIM_REGISTERED_SCHEMA_REFS: JSON.stringify(['binding:DB:core-d1']),
    AUDIT_QUEUE: { send: vi.fn(), sendBatch: vi.fn() },
    AUDIT_ARCHIVE: {} as R2Bucket,
    PROFILE_REGISTRY_BACKEND: 'kv',
    DEFAULT_AUDIT_PROFILE_ID,
    DEFAULT_RESIDENCY_PROFILE_ID,
    BASE_DOMAIN: 'auth.example.com',
    ...envExtra,
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as never as { set: (k: string, v: unknown) => void }).set('adminAuth', {
      userId: 'admin-1',
      actorId: 'admin-1',
      roles: ['ar_super_admin'],
      globalRoles: ['ar_super_admin'],
      tenantScope: ['*'],
      authMethod: 'session',
    });
    await next();
  });
  app.put('/defaults', adminRuntimeProfileDefaultsUpdateHandler);
  app.put('/:kind/:id', adminRuntimeProfileUpsertHandler);
  app.delete('/:kind/:id', adminRuntimeProfileDeleteHandler);
  const send = (path: string, method: string, body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env
    );
  return { send, store: config.store };
}

const refusal = () =>
  new Response(JSON.stringify({ error: 'step_up_required' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });

describe('audit profile retention needs step-up', () => {
  beforeEach(() => {
    gate.mockReset();
    gate.mockResolvedValue(null);
  });

  it('gates a shorter retention, leaves the profile unchanged when refused', async () => {
    const { send, store } = setup([stored('aud-1', 'audit', audit(90))] as never);
    gate.mockResolvedValueOnce(refusal());
    expect((await send('/audit/aud-1', 'PUT', audit(30))).status).toBe(403);
    expect(
      (
        JSON.parse(store.get('profile-registry:audit:aud-1') ?? '{}') as {
          retention: { eventLogRetentionDays: number };
        }
      ).retention.eventLogRetentionDays
    ).toBe(90);

    expect((await send('/audit/aud-1', 'PUT', audit(30))).status).toBe(200);
    expect(gate).toHaveBeenLastCalledWith(expect.anything(), {
      operation: 'audit.retention.shorten',
      targetTenantId: expect.any(String) as unknown,
      targetIds: ['aud-1'],
      params: {
        scope: 'audit_profile',
        profile_id: 'aud-1',
        retention: { eventLogRetentionDays: 30, piiLogRetentionDays: 30 },
        has_primary: true,
      },
    });
  });

  it('does not gate a longer retention or an unrelated edit, nor an invalid body', async () => {
    const { send } = setup([stored('aud-1', 'audit', audit(90))] as never);
    expect((await send('/audit/aud-1', 'PUT', audit(180))).status).toBe(200);
    expect((await send('/audit/aud-1', 'PUT', { ...audit(180), label: 'Renamed' })).status).toBe(
      200
    );
    expect((await send('/audit/aud-1', 'PUT', { ...audit(1), bogus: true })).status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });

  it('gates dropping archive-before-delete', async () => {
    const { send } = setup([
      stored('aud-1', 'audit', audit(90, { archiveBeforeDelete: true })),
    ] as never);
    expect((await send('/audit/aud-1', 'PUT', audit(90))).status).toBe(200);
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('gates pointing the environment default at a shorter-retention audit profile', async () => {
    const { send } = setup([stored('aud-short', 'audit', audit(7))] as never);
    gate.mockResolvedValueOnce(refusal());
    expect((await send('/defaults', 'PUT', { auditProfileId: 'aud-short' })).status).toBe(403);
    expect((await send('/defaults', 'PUT', { auditProfileId: 'aud-short' })).status).toBe(200);
    expect(gate).toHaveBeenLastCalledWith(expect.anything(), {
      operation: 'audit.retention.shorten',
      targetTenantId: expect.any(String) as unknown,
      targetIds: ['aud-short'],
      params: {
        scope: 'environment_default',
        audit_profile_id: 'aud-short',
        retention: { eventLogRetentionDays: 7, piiLogRetentionDays: 7 },
      },
    });
  });

  it('gates a default switch away from a profile that cannot be found (unknown retention)', async () => {
    const { send } = setup([stored('aud-long', 'audit', audit(400))] as never, {
      DEFAULT_AUDIT_PROFILE_ID: 'aud-deleted',
    });
    gate.mockResolvedValueOnce(refusal());
    expect((await send('/defaults', 'PUT', { auditProfileId: 'aud-long' })).status).toBe(403);
    expect(gate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'audit.retention.shorten' })
    );
  });

  it('does not gate a default switch to a longer-retention audit profile', async () => {
    const { send } = setup([stored('aud-long', 'audit', audit(400))] as never);
    expect((await send('/defaults', 'PUT', { auditProfileId: 'aud-long' })).status).toBe(200);
    expect(gate).not.toHaveBeenCalled();
  });

  it('refuses one default change that needs both jurisdiction and retention step-ups', async () => {
    const { send } = setup([
      stored('aud-short', 'audit', audit(7)),
      stored('res-eu', 'residency', residency('eu')),
    ] as never);
    const response = await send('/defaults', 'PUT', {
      auditProfileId: 'aud-short',
      residencyProfileId: 'res-eu',
    });
    expect(response.status).toBe(400);
    expect(gate).not.toHaveBeenCalled();
  });
});

describe('deleting and recreating a profile needs step-up', () => {
  beforeEach(() => {
    gate.mockReset();
    gate.mockResolvedValue(null);
  });

  it('gates deleting a residency profile as a jurisdiction update; refused keeps it', async () => {
    const { send, store } = setup([stored('res-1', 'residency', residency('none'))] as never);
    gate.mockResolvedValueOnce(refusal());
    expect((await send('/residency/res-1', 'DELETE')).status).toBe(403);
    expect(store.has('profile-registry:residency:res-1')).toBe(true);

    expect((await send('/residency/res-1', 'DELETE')).status).toBe(200);
    expect(store.has('profile-registry:residency:res-1')).toBe(false);
    expect(gate).toHaveBeenLastCalledWith(expect.anything(), {
      operation: 'tenant.jurisdiction.update',
      targetTenantId: expect.any(String) as unknown,
      targetIds: ['res-1'],
      params: { scope: 'residency_profile_delete', profile_id: 'res-1' },
    });
  });

  it('gates deleting an audit profile as a retention shortening', async () => {
    const { send } = setup([stored('aud-1', 'audit', audit(90))] as never);
    expect((await send('/audit/aud-1', 'DELETE')).status).toBe(200);
    expect(gate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'audit.retention.shorten', targetIds: ['aud-1'] })
    );
  });

  it('does not spend a receipt on a missing or built-in profile', async () => {
    const { send } = setup();
    await send('/residency/missing', 'DELETE');
    expect((await send(`/residency/${DEFAULT_RESIDENCY_PROFILE_ID}`, 'DELETE')).status).toBe(409);
    expect(gate).not.toHaveBeenCalled();
  });

  it('gates creating a profile under an id the environment default points at', async () => {
    const { send } = setup([], { DEFAULT_RESIDENCY_PROFILE_ID: 'res-ref' });
    gate.mockResolvedValueOnce(refusal());
    expect((await send('/residency/res-ref', 'PUT', residency('eu'))).status).toBe(403);
    expect(gate).toHaveBeenLastCalledWith(expect.anything(), {
      operation: 'tenant.jurisdiction.update',
      targetTenantId: expect.any(String) as unknown,
      targetIds: ['res-ref'],
      params: {
        scope: 'residency_profile',
        profile_id: 'res-ref',
        from_jurisdiction: null,
        to_jurisdiction: 'eu',
      },
    });
    expect((await send('/residency/res-ref', 'PUT', residency('eu'))).status).toBe(201);
  });

  it('gates creating any profile (another tenant may already name the id)', async () => {
    const { send } = setup();
    gate.mockResolvedValue(refusal());
    expect((await send('/residency/fresh', 'PUT', residency('eu'))).status).toBe(403);
    expect((await send('/audit/fresh', 'PUT', audit(1))).status).toBe(403);
    expect(gate).toHaveBeenCalledTimes(2);
  });

  it('refuses a built-in profile before the gate', async () => {
    const { send } = setup();
    expect((await send('/audit/builtin:default', 'PUT', audit(1))).status).toBe(409);
    expect(gate).not.toHaveBeenCalled();
  });
});
