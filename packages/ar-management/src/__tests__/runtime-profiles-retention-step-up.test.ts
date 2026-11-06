import { beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => vi.fn(async (): Promise<Response | null> => null));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: gate,
  refuseAdminFreshAuth: vi.fn(),
}));

import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { DEFAULT_AUDIT_PROFILE_ID, DEFAULT_RESIDENCY_PROFILE_ID } from '@authrim/ar-lib-core';
import { createSettingsCanonicalD1 } from './helpers/settings-canonical-d1';
import { openCoreStore } from './helpers/core-schema-sqlite';
import {
  resolveTenantAuditProfileFromEnv,
  resolveTenantAuditRetentionFromEnv,
  resolveTenantRuntimeProfilesFromEnv,
} from '@authrim/ar-lib-core';
import {
  createInfrastructureSettingsManager,
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
  const core = openCoreStore();
  const env = {
    DB: core.adapter,
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
  return { send, store: config.store, core, kv: config.kv, env };
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
        // The resulting delivery is bound by digest.
        delivery_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
        target_sha256: expect.any(Array) as unknown,
        archive_failure_mode: null,
        sink_failure_mode: null,
        backpressure: null,
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
    // The built-in default archives to R2 and this profile does not: another delivery, so the
    // switch is gated as a destination update (with the resulting retention bound too).
    expect(gate).toHaveBeenLastCalledWith(expect.anything(), {
      operation: 'webhook.destination.update',
      alsoCovers: ['audit.retention.shorten'],
      targetTenantId: expect.any(String) as unknown,
      targetIds: ['aud-short'],
      params: {
        scope: 'environment_default',
        audit_profile_id: 'aud-short',
        retention: { eventLogRetentionDays: 7, piiLogRetentionDays: 7 },
        delivery_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
        target_sha256: expect.any(Array) as unknown,
        archive_failure_mode: null,
        sink_failure_mode: null,
        backpressure: null,
      },
    });
  });

  it('gates a default switch away from a profile that cannot be found (unknown retention)', async () => {
    const { send } = setup([stored('aud-long', 'audit', audit(400))] as never, {
      DEFAULT_AUDIT_PROFILE_ID: 'aud-deleted',
    });
    gate.mockResolvedValueOnce(refusal());
    expect((await send('/defaults', 'PUT', { auditProfileId: 'aud-long' })).status).toBe(403);
    // The missing profile is compared as the built-in one: delivery differs (no archive here),
    // and the unknown retention counts as a shortening, so one receipt covers both.
    expect(gate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'webhook.destination.update',
        alsoCovers: ['audit.retention.shorten'],
      })
    );
  });

  it('a switch from a missing default to a profile delivering like the built-in one needs only retention', async () => {
    const { send } = setup(
      [
        stored('aud-same', 'audit', {
          ...audit(400),
          archive: { type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'logs/v1' },
          archiveFailureMode: 'gate_cleanup',
          sinkFailureMode: 'best_effort',
          backpressure: { mode: 'event_class', allowTenantOverride: true },
        }),
      ] as never,
      { DEFAULT_AUDIT_PROFILE_ID: 'aud-deleted' }
    );
    expect((await send('/defaults', 'PUT', { auditProfileId: 'aud-same' })).status).toBe(200);
    expect(gate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'audit.retention.shorten' })
    );
    expect((gate.mock.calls as unknown as unknown[][])[0][1]).not.toHaveProperty('alsoCovers');
  });

  it('does not gate a default switch to a longer-retention profile with the same delivery', async () => {
    const [key, value] = stored('aud-long', 'audit', {
      ...audit(400),
      // Delivers exactly where the built-in default does.
      archive: { type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'logs/v1' },
      archiveFailureMode: 'gate_cleanup',
      sinkFailureMode: 'best_effort',
      backpressure: { mode: 'event_class', allowTenantOverride: true },
    });
    const { send } = setup([[key, value]]);
    expect((await send('/defaults', 'PUT', { auditProfileId: 'aud-long' })).status).toBe(200);
    expect(gate).not.toHaveBeenCalled();
  });

  it('gates a default switch to a longer-retention profile that delivers elsewhere', async () => {
    const { send } = setup([stored('aud-long', 'audit', audit(400))] as never);
    expect((await send('/defaults', 'PUT', { auditProfileId: 'aud-long' })).status).toBe(200);
    expect(gate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'webhook.destination.update' })
    );
  });

  it("gates a change of a profile's sinks even though retention is not shorter", async () => {
    const sink = (url: string) => ({
      sinks: [{ type: 'http', url, method: 'POST', format: 'json' }],
    });
    const { send } = setup([
      stored('aud-1', 'audit', { ...audit(90), ...sink('https://logs.example.com/a') }),
    ] as never);
    gate.mockResolvedValueOnce(refusal());
    const refused = await send('/audit/aud-1', 'PUT', {
      ...audit(90),
      ...sink('https://evil.example.com/a'),
    });
    expect(refused.status).toBe(403);
    expect(gate).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'webhook.destination.update',
        params: expect.objectContaining({
          delivery_sha256: expect.any(String) as unknown,
        }) as unknown,
      })
    );
    // The same sinks, longer retention: no receipt needed.
    gate.mockClear();
    expect(
      (
        await send('/audit/aud-1', 'PUT', {
          ...audit(180),
          ...sink('https://logs.example.com/a'),
        })
      ).status
    ).toBe(200);
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

describe('profile writes are conditional on the stored profile (D1 is the source)', () => {
  beforeEach(() => {
    gate.mockReset();
    gate.mockResolvedValue(null);
  });

  const row = (core: ReturnType<typeof setup>['core'], kind: string, id: string) =>
    (
      core.db
        .prepare('SELECT payload_json FROM profile_registry WHERE kind = ? AND id = ?')
        .get(kind, id) as { payload_json: string } | undefined
    )?.payload_json;
  const days = (payload: string | undefined) =>
    (JSON.parse(payload ?? '{}') as { retention?: { eventLogRetentionDays: number } }).retention
      ?.eventLogRetentionDays;

  it('adopts a profile that exists only in KV into D1 the first time it is written', async () => {
    const [key, value] = stored('aud-1', 'audit', audit(90));
    const { send, store, core } = setup([[key, value]]);
    expect(row(core, 'audit', 'aud-1')).toBeUndefined();
    expect((await send('/audit/aud-1', 'PUT', audit(180))).status).toBe(200);
    expect(days(row(core, 'audit', 'aud-1'))).toBe(180);
    // KV is the projection of the D1 row, byte for byte.
    expect(store.get(key)).toBe(row(core, 'audit', 'aud-1'));
  });

  it('refuses an update when the profile changed during the step-up, and writes nothing', async () => {
    const { send, store, core } = setup([stored('aud-1', 'audit', audit(90))] as never);
    // First write adopts the profile into D1.
    expect((await send('/audit/aud-1', 'PUT', audit(400))).status).toBe(200);
    const concurrent = JSON.stringify({
      ...JSON.parse(row(core, 'audit', 'aud-1') ?? '{}'),
      label: 'X',
    });
    gate.mockImplementationOnce(async () => {
      core.db
        .prepare('UPDATE profile_registry SET payload_json = ? WHERE id = ?')
        .run(concurrent, 'aud-1');
      return null;
    });
    const res = await send('/audit/aud-1', 'PUT', audit(30));
    expect(res.status).toBe(409);
    expect(row(core, 'audit', 'aud-1')).toBe(concurrent);
    // The projection was not advanced by the refused write.
    expect(days(store.get('profile-registry:audit:aud-1'))).toBe(400);
  });

  it('refuses a create when the profile was created during the step-up', async () => {
    const { send, core } = setup();
    gate.mockImplementationOnce(async () => {
      core.db
        .prepare('INSERT INTO profile_registry (id, kind, payload_json) VALUES (?, ?, ?)')
        .run(
          'res-new',
          'residency',
          JSON.stringify({ id: 'res-new', kind: 'residency', ...residency('none') })
        );
      return null;
    });
    expect((await send('/residency/res-new', 'PUT', residency('eu'))).status).toBe(409);
    expect(JSON.parse(row(core, 'residency', 'res-new') ?? '{}')).toMatchObject({
      jurisdiction: 'none',
    });
  });

  it('refuses a delete when the profile changed during the step-up', async () => {
    const { send, core } = setup([stored('res-1', 'residency', residency('none'))] as never);
    gate.mockImplementationOnce(async () => {
      // The profile exists only in KV; another request writes it to D1 meanwhile.
      core.db
        .prepare('INSERT INTO profile_registry (id, kind, payload_json) VALUES (?, ?, ?)')
        .run(
          'res-1',
          'residency',
          JSON.stringify({ id: 'res-1', kind: 'residency', ...residency('eu') })
        );
      return null;
    });
    expect((await send('/residency/res-1', 'DELETE')).status).toBe(409);
    expect(JSON.parse(row(core, 'residency', 'res-1') ?? '{}')).toMatchObject({
      jurisdiction: 'eu',
    });
  });

  it('writes D1 over a KV copy that disagrees: the first request repairs it and is refused', async () => {
    const { send, store, core } = setup([stored('aud-1', 'audit', audit(90))] as never);
    expect((await send('/audit/aud-1', 'PUT', audit(400))).status).toBe(200);
    store.set(
      'profile-registry:audit:aud-1',
      JSON.stringify({ id: 'aud-1', kind: 'audit', ...audit(1) })
    );
    gate.mockClear();
    expect((await send('/audit/aud-1', 'PUT', audit(30))).status).toBe(409);
    // Repaired from D1, and no receipt was spent on the refused request.
    expect(days(store.get('profile-registry:audit:aud-1'))).toBe(400);
    expect(gate).not.toHaveBeenCalled();
    expect((await send('/audit/aud-1', 'PUT', audit(30))).status).toBe(200);
    expect(days(row(core, 'audit', 'aud-1'))).toBe(30);
  });
});

describe('a default switch is verified after it is saved', () => {
  beforeEach(() => {
    gate.mockReset();
    gate.mockResolvedValue(null);
  });

  const plain = (days: number) => ({
    ...audit(days),
    archive: { type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'logs/v1' },
    archiveFailureMode: 'gate_cleanup',
    sinkFailureMode: 'best_effort',
    backpressure: { mode: 'event_class', allowTenantOverride: true },
  });

  it('puts the default back when the profile switched away from was lengthened meanwhile', async () => {
    // 30 days -> 60 days, same delivery: not gated. Meanwhile the current profile is lengthened to
    // 365 days (also ungated), which would make this a 365 -> 60 switch without a receipt.
    const f = setup(
      [stored('aud-a', 'audit', plain(30)), stored('aud-b', 'audit', plain(60))] as never,
      { DEFAULT_AUDIT_PROFILE_ID: 'aud-a' }
    );
    const original = f.kv.get as unknown as (key: string) => Promise<string | null>;
    let changed = false;
    (f.kv as unknown as { get: typeof original }).get = async (key: string) => {
      const value = await original(key);
      if (key === 'profile-registry:audit:aud-a' && !changed) {
        changed = true;
        f.core.db
          .prepare('INSERT INTO profile_registry (id, kind, payload_json) VALUES (?, ?, ?)')
          .run(
            'aud-a',
            'audit',
            JSON.stringify({ id: 'aud-a', kind: 'audit', builtin: false, ...plain(365) })
          );
      }
      return value;
    };
    const response = await f.send('/defaults', 'PUT', { auditProfileId: 'aud-b' });
    expect(response.status).toBe(409);
    expect(gate).not.toHaveBeenCalled();
    const manager = createInfrastructureSettingsManager(f.env, { strict: true });
    const doc = await manager.getAll('infrastructure', { type: 'platform' });
    expect(doc.values['infra.default_audit_profile_id']).toBe('aud-a');
    // The own value was cleared again, not left set to what the environment already says.
    expect(doc.sources['infra.default_audit_profile_id']).not.toBe('kv');
  });

  it('keeps the switch when nothing changed', async () => {
    const f = setup(
      [stored('aud-a', 'audit', plain(30)), stored('aud-b', 'audit', plain(60))] as never,
      { DEFAULT_AUDIT_PROFILE_ID: 'aud-a' }
    );
    expect((await f.send('/defaults', 'PUT', { auditProfileId: 'aud-b' })).status).toBe(200);
    const doc = await createInfrastructureSettingsManager(f.env, { strict: true }).getAll(
      'infrastructure',
      { type: 'platform' }
    );
    expect(doc.values['infra.default_audit_profile_id']).toBe('aud-b');
  });

  it('gates weakening a delivery guarantee as a destination change, binding the modes', async () => {
    const f = setup([stored('aud-1', 'audit', plain(90))] as never);
    gate.mockResolvedValueOnce(refusal());
    const refused = await f.send('/audit/aud-1', 'PUT', {
      ...plain(90),
      archiveFailureMode: 'best_effort',
    });
    expect(refused.status).toBe(403);
    expect(gate).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'webhook.destination.update',
        params: expect.objectContaining({
          archive_failure_mode: 'best_effort',
          sink_failure_mode: 'best_effort',
        }) as unknown,
      })
    );
    gate.mockClear();
    const sinks = await f.send('/audit/aud-1', 'PUT', {
      ...plain(90),
      sinkFailureMode: 'retry_until_ttl',
    });
    expect(sinks.status).toBe(200);
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('gates switching the default to a profile with weaker delivery guarantees', async () => {
    const f = setup(
      [
        stored('aud-a', 'audit', plain(90)),
        stored('aud-weak', 'audit', { ...plain(90), archiveFailureMode: 'best_effort' }),
      ] as never,
      { DEFAULT_AUDIT_PROFILE_ID: 'aud-a' }
    );
    expect((await f.send('/defaults', 'PUT', { auditProfileId: 'aud-weak' })).status).toBe(200);
    expect(gate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'webhook.destination.update' })
    );
  });
});

describe('compound changes carry both operations in the descriptor', () => {
  beforeEach(() => {
    gate.mockReset();
    gate.mockResolvedValue(null);
  });

  const withSink = (days: number, url: string) => ({
    ...audit(days),
    sinks: [{ type: 'http', url, method: 'POST', format: 'json' }],
  });

  it('a profile PUT that changes delivery and shortens retention', async () => {
    const { send } = setup([
      stored('aud-1', 'audit', withSink(90, 'https://logs.example.com/a')),
    ] as never);
    expect(
      (await send('/audit/aud-1', 'PUT', withSink(30, 'https://logs.example.com/b'))).status
    ).toBe(200);
    expect(gate).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'webhook.destination.update',
        alsoCovers: ['audit.retention.shorten'],
      })
    );
  });

  it('a profile PUT that changes only delivery, or only retention, carries nothing extra', async () => {
    const { send } = setup([
      stored('aud-1', 'audit', withSink(90, 'https://logs.example.com/a')),
    ] as never);
    await send('/audit/aud-1', 'PUT', withSink(90, 'https://logs.example.com/b'));
    await send('/audit/aud-1', 'PUT', withSink(30, 'https://logs.example.com/b'));
    for (const call of gate.mock.calls as unknown as Array<[unknown, Record<string, unknown>]>) {
      expect(call[1]).not.toHaveProperty('alsoCovers');
    }
  });

  it('a default switch that changes delivery and shortens retention', async () => {
    const { send } = setup([stored('aud-short', 'audit', audit(7))] as never);
    expect((await send('/defaults', 'PUT', { auditProfileId: 'aud-short' })).status).toBe(200);
    expect(gate).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'webhook.destination.update',
        alsoCovers: ['audit.retention.shorten'],
      })
    );
  });
});

describe('delivery of profiles that are missing, deleted or created', () => {
  beforeEach(() => {
    gate.mockReset();
    gate.mockResolvedValue(null);
  });

  const builtinLike = (days: number) => ({
    ...audit(days),
    archive: { type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'logs/v1' },
    archiveFailureMode: 'gate_cleanup',
    sinkFailureMode: 'best_effort',
    backpressure: { mode: 'event_class', allowTenantOverride: true },
  });
  const sink = {
    sinks: [{ type: 'http', url: 'https://logs.example.com/a', method: 'POST', format: 'json' }],
  };

  it('deleting a profile with an external sink also covers the destination operation, and binds it', async () => {
    const { send } = setup([stored('aud-1', 'audit', { ...audit(90), ...sink })] as never);
    expect((await send('/audit/aud-1', 'DELETE')).status).toBe(200);
    expect(gate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'audit.retention.shorten',
        alsoCovers: ['webhook.destination.update'],
        params: expect.objectContaining({
          scope: 'audit_profile_delete',
          delivery_sha256: expect.any(String) as unknown,
        }) as unknown,
      })
    );
  });

  it('deleting a profile that delivers like the built-in one needs no destination operation', async () => {
    const { send } = setup([stored('aud-1', 'audit', builtinLike(90))] as never);
    expect((await send('/audit/aud-1', 'DELETE')).status).toBe(200);
    expect((gate.mock.calls as unknown as unknown[][])[0][1]).not.toHaveProperty('alsoCovers');
  });

  it('creating a profile with another primary store is a delivery change, even without sinks', async () => {
    const { send } = setup();
    const otherPrimary = {
      ...builtinLike(90),
      primary: { type: 'postgres', connectionRef: 'PG', dataset: 'event_log' },
    };
    expect((await send('/audit/fresh', 'PUT', otherPrimary)).status).toBe(201);
    expect(gate).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        operation: 'webhook.destination.update',
        alsoCovers: ['audit.retention.shorten'],
      })
    );
    gate.mockClear();
    // Delivering exactly like the built-in profile it stands in for: only the create gate.
    expect((await send('/audit/fresh2', 'PUT', builtinLike(90))).status).toBe(201);
    expect(gate).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'audit.retention.shorten' })
    );
    expect((gate.mock.calls as unknown as unknown[][])[0][1]).not.toHaveProperty('alsoCovers');
  });
});

describe('residency changes do not change the audit profile that applies', () => {
  beforeEach(() => {
    gate.mockReset();
    gate.mockResolvedValue(null);
  });

  const tenantAudit = {
    ...audit(400),
    sinks: [{ type: 'http', url: 'https://logs.example.com/a', method: 'POST', format: 'json' }],
  };

  function tenantSetup() {
    return setup([
      stored('aud-tenant', 'audit', tenantAudit),
      stored('res-used', 'residency', residency('eu')),
      [
        'settings:tenant:tenant-a:tenant',
        JSON.stringify({
          'tenant.audit_profile_id': 'aud-tenant',
          'tenant.residency_profile_id': 'res-used',
        }),
      ],
    ] as never);
  }

  const audited = async (f: ReturnType<typeof tenantSetup>) => ({
    profile: await resolveTenantAuditProfileFromEnv(f.env, 'tenant-a'),
    retention: (await resolveTenantAuditRetentionFromEnv(f.env, 'tenant-a')).event.days,
  });

  it('deleting a residency profile that is in use leaves the tenant audit delivery and retention', async () => {
    const f = tenantSetup();
    const before = await audited(f);
    expect(before.retention).toBe(400);
    expect((await f.send('/residency/res-used', 'DELETE')).status).toBe(200);
    // Residency can no longer be resolved for the tenant...
    await expect(resolveTenantRuntimeProfilesFromEnv(f.env, 'tenant-a')).rejects.toThrow(
      'residency_profile_not_found'
    );
    // ...and the audit profile, its sink and its retention are exactly as they were.
    const after = await audited(f);
    expect(after.profile).toEqual(before.profile);
    expect(after.profile.sinks).toHaveLength(1);
    expect(after.retention).toBe(400);
  });

  it('a tenant pointed at an unregistered residency profile keeps its audit profile', async () => {
    const f = tenantSetup();
    f.store.set(
      'settings:tenant:tenant-a:tenant',
      JSON.stringify({
        'tenant.audit_profile_id': 'aud-tenant',
        'tenant.residency_profile_id': 'res-nobody-registered',
      })
    );
    await expect(resolveTenantRuntimeProfilesFromEnv(f.env, 'tenant-a')).rejects.toThrow(
      'residency_profile_not_found'
    );
    const after = await audited(f);
    expect(after.profile.id).toBe('aud-tenant');
    expect(after.profile.sinks).toHaveLength(1);
    expect(after.retention).toBe(400);
  });
});
