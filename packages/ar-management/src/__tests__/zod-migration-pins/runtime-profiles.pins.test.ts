/**
 * zod 3 -> 4 migration pins for runtime-profiles.ts.
 *
 * Uses the REAL `createErrorResponse` (no mock): the HTTP body of a validation failure here is
 * the masked `{ error, error_description, error_code }` object. The audit/residency body schemas
 * only expose pass/fail through the handler, so accepted bodies are pinned through the persisted
 * `profile` echoed in the 201 response (this pins `.default([])`, unknown-key stripping inside
 * union members, `.strict()`, `.nullable().optional()`, `z.record`, `.superRefine`, `.refine`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '@authrim/ar-lib-core';
import {
  DEFAULT_AUDIT_PROFILE_ID,
  DEFAULT_RESIDENCY_PROFILE_ID,
  TENANT_RUNTIME_REGISTRY_EMERGENCY_PURGE_CONFIRMATION,
} from '@authrim/ar-lib-core';
import { createSettingsCanonicalD1 } from '../helpers/settings-canonical-d1';

vi.mock('../../admin-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../admin-shared')>();
  return { ...actual, writeAdminAuditLog: vi.fn() };
});

import {
  adminRuntimeProfileDefaultsUpdateHandler,
  adminRuntimeProfileListHandler,
  adminRuntimeProfileUpsertHandler,
  adminTenantRuntimeRegistryEmergencyPurgeHandler,
} from '../../runtime-profiles';

function createMockKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (options?: { prefix?: string }) => ({
      keys: Array.from(store.keys())
        .filter((key) => !options?.prefix || key.startsWith(options.prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: '',
    })),
  } as unknown as KVNamespace;
}

function createApp() {
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
  app.get('/api/admin/runtime-profiles', adminRuntimeProfileListHandler);
  app.put('/api/admin/runtime-profiles/defaults', adminRuntimeProfileDefaultsUpdateHandler);
  app.put('/api/admin/runtime-profiles/:kind/:id', adminRuntimeProfileUpsertHandler);
  app.post(
    '/api/admin/tenants/:id/runtime-registry/emergency-purge',
    adminTenantRuntimeRegistryEmergencyPurgeHandler as never
  );
  return app;
}

function createEnv(): Env {
  return {
    DB: {} as D1Database,
    DB_ADMIN: createSettingsCanonicalD1(),
    AUTHRIM_CONFIG: createMockKV(),
    SETTINGS: createMockKV(),
    TENANT_RUNTIME_REGISTRY: createMockKV(),
    AUDIT_QUEUE: { send: vi.fn(), sendBatch: vi.fn() },
    AUDIT_ARCHIVE: {} as R2Bucket,
    DIAGNOSTIC_LOGS: {} as R2Bucket,
    PROFILE_REGISTRY_BACKEND: 'kv',
    DEFAULT_AUDIT_PROFILE_ID,
    DEFAULT_RESIDENCY_PROFILE_ID,
    BASE_DOMAIN: 'auth.example.com',
  } as unknown as Env;
}

const INVALID_VALUE_BODY = {
  error: 'invalid_request',
  error_description: 'The provided value is invalid.',
  error_code: 'AR130003',
};

async function send(method: string, path: string, body?: unknown, rawBody?: string) {
  const response = await createApp().request(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    },
    createEnv()
  );
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

const putAudit = (body: unknown, id = 'pin-audit') =>
  send('PUT', `/api/admin/runtime-profiles/audit/${id}`, body);
const putResidency = (body: unknown, id = 'pin-residency') =>
  send('PUT', `/api/admin/runtime-profiles/residency/${id}`, body);

const REJECTED = { status: 400, body: INVALID_VALUE_BODY };

describe('zod pins: runtime profile audit body (PUT /runtime-profiles/audit/:id)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('non-object / malformed bodies are rejected with the masked invalid-value body', async () => {
    expect(await putAudit(null)).toEqual(REJECTED);
    expect(await putAudit([])).toEqual(REJECTED);
    expect(await putAudit('x')).toEqual(REJECTED);
    expect(await send('PUT', '/api/admin/runtime-profiles/audit/x', undefined, '{oops')).toEqual(
      REJECTED
    );
    expect(await putAudit({})).toEqual(REJECTED);
  });

  it('applies .default([]) to sinks and keeps absent optionals absent', async () => {
    const result = await putAudit({
      label: 'Minimal',
      primary: { type: 'd1', bindingRef: 'DB_ADMIN' },
    });
    expect(result.status).toBe(201);
    expect(result.body.profile).toEqual({
      kind: 'audit',
      label: 'Minimal',
      primary: { type: 'd1', bindingRef: 'DB_ADMIN' },
      sinks: [],
      id: 'pin-audit',
      builtin: false,
    });
  });

  it('strips unknown keys inside (non-strict) union members and objects, keeps nullable/optional', async () => {
    const result = await putAudit({
      label: 'Strip',
      description: 'desc',
      version: 3,
      metadata: { nested: { a: 1 }, list: [1, 2] },
      primary: { type: 'postgres', connectionRef: 'PG', dataset: 'audit', stray: 1 },
      archive: { type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'audit/', stray: 2 },
      sinks: [
        { type: 'logpush', destinationRef: 'lp', dataset: 'ds', stray: 3 },
        { type: 'firehose', streamRef: 'fh', stray: 4 },
        {
          type: 'http',
          url: 'https://example.com/audit',
          urlRef: 'U',
          authTokenRef: 'T',
          method: 'POST',
          headers: { a: 'b' },
          format: 'json',
          stray: 5,
        },
      ],
      archiveFailureMode: 'gate_cleanup',
      sinkFailureMode: 'retry_until_ttl',
      retention: {
        eventLogRetentionDays: 30,
        piiLogRetentionDays: null,
        archiveBeforeDelete: true,
      },
      backpressure: {
        mode: 'event_class',
        allowTenantOverride: true,
        eventCategoryOverrides: { auth: 'fail_closed', token: 'inherit' },
      },
    });
    expect(result.status).toBe(201);
    expect(result.body.profile).toEqual({
      kind: 'audit',
      label: 'Strip',
      description: 'desc',
      version: 3,
      metadata: { nested: { a: 1 }, list: [1, 2] },
      primary: { type: 'postgres', connectionRef: 'PG', dataset: 'audit' },
      archive: { type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'audit/' },
      sinks: [
        { type: 'logpush', destinationRef: 'lp', dataset: 'ds' },
        { type: 'firehose', streamRef: 'fh' },
        {
          type: 'http',
          url: 'https://example.com/audit',
          urlRef: 'U',
          authTokenRef: 'T',
          method: 'POST',
          headers: { a: 'b' },
          format: 'json',
        },
      ],
      archiveFailureMode: 'gate_cleanup',
      sinkFailureMode: 'retry_until_ttl',
      retention: {
        eventLogRetentionDays: 30,
        piiLogRetentionDays: null,
        archiveBeforeDelete: true,
      },
      backpressure: {
        mode: 'event_class',
        allowTenantOverride: true,
        eventCategoryOverrides: { auth: 'fail_closed', token: 'inherit' },
      },
      id: 'pin-audit',
      builtin: false,
    });
  });

  it('odd-but-accepted: database primary without bindingRef/connectionRef (no superRefine on primary)', async () => {
    const result = await putAudit({ label: 'Odd', primary: { type: 'd1' } });
    expect(result.status).toBe(201);
    expect((result.body.profile as { primary: unknown }).primary).toEqual({ type: 'd1' });
  });

  it('odd-but-accepted: archive null / primary null with other delivery targets', async () => {
    const result = await putAudit({
      label: 'Nulls',
      primary: null,
      archive: null,
      sinks: [{ type: 'firehose', streamRef: 'fh' }],
    });
    expect(result.status).toBe(201);
    expect(result.body.profile).toEqual({
      kind: 'audit',
      label: 'Nulls',
      primary: null,
      archive: null,
      sinks: [{ type: 'firehose', streamRef: 'fh' }],
      id: 'pin-audit',
      builtin: false,
    });
  });

  const valid = { label: 'L', primary: { type: 'd1', bindingRef: 'DB_ADMIN' } };

  it.each([
    ['label missing', { primary: valid.primary }],
    ['label empty', { ...valid, label: '' }],
    ['label wrong type', { ...valid, label: 1 }],
    ['primary missing (nullable but not optional)', { label: 'L' }],
    ['primary wrong type enum', { label: 'L', primary: { type: 'sqlite' } }],
    ['primary r2 not allowed', { label: 'L', primary: { type: 'r2', bucketRef: 'B' } }],
    ['primary empty bindingRef', { label: 'L', primary: { type: 'd1', bindingRef: '' } }],
    ['description empty', { ...valid, description: '' }],
    ['version zero', { ...valid, version: 0 }],
    ['version negative', { ...valid, version: -1 }],
    ['version float', { ...valid, version: 1.5 }],
    ['version string', { ...valid, version: '1' }],
    ['version null', { ...valid, version: null }],
    ['metadata array', { ...valid, metadata: [] }],
    ['metadata null', { ...valid, metadata: null }],
    ['metadata string', { ...valid, metadata: 'x' }],
    ['unknown top-level key (strict)', { ...valid, extra: true }],
    ['archive http not allowed', { ...valid, archive: { type: 'http', url: 'https://e.com' } }],
    ['archive r2 missing bucketRef', { ...valid, archive: { type: 'r2' } }],
    ['sinks not array', { ...valid, sinks: {} }],
    ['sinks null', { ...valid, sinks: null }],
    ['sink unknown type', { ...valid, sinks: [{ type: 'kafka' }] }],
    ['sink d1 not allowed as sink', { ...valid, sinks: [{ type: 'd1', bindingRef: 'B' }] }],
    ['sink logpush missing destinationRef', { ...valid, sinks: [{ type: 'logpush' }] }],
    ['sink http without url/urlRef (superRefine)', { ...valid, sinks: [{ type: 'http' }] }],
    [
      'sink http http:// url (refine)',
      { ...valid, sinks: [{ type: 'http', url: 'http://e.com/a' }] },
    ],
    ['sink http ftp url (refine)', { ...valid, sinks: [{ type: 'http', url: 'ftp://e.com/a' }] }],
    ['sink http not a URL', { ...valid, sinks: [{ type: 'http', url: 'not a url' }] }],
    ['sink http method GET', { ...valid, sinks: [{ type: 'http', urlRef: 'U', method: 'GET' }] }],
    ['sink http format xml', { ...valid, sinks: [{ type: 'http', urlRef: 'U', format: 'xml' }] }],
    [
      'sink http headers non-string value',
      { ...valid, sinks: [{ type: 'http', urlRef: 'U', headers: { a: 1 } }] },
    ],
    ['sink http headers array', { ...valid, sinks: [{ type: 'http', urlRef: 'U', headers: [] }] }],
    ['archiveFailureMode invalid', { ...valid, archiveFailureMode: 'sometimes' }],
    ['sinkFailureMode invalid', { ...valid, sinkFailureMode: 'best_effort_only' }],
    ['retention unknown key (strict)', { ...valid, retention: { foo: 1 } }],
    ['retention zero days', { ...valid, retention: { eventLogRetentionDays: 0 } }],
    ['retention float days', { ...valid, retention: { primaryDays: 1.5 } }],
    [
      'retention archiveBeforeDelete string',
      { ...valid, retention: { archiveBeforeDelete: 'yes' } },
    ],
    ['retention null object', { ...valid, retention: null }],
    ['backpressure missing mode', { ...valid, backpressure: {} }],
    ['backpressure bad mode', { ...valid, backpressure: { mode: 'drop' } }],
    [
      'backpressure unknown key (strict)',
      { ...valid, backpressure: { mode: 'event_class', x: 1 } },
    ],
    [
      'backpressure override bad enum',
      {
        ...valid,
        backpressure: { mode: 'event_class', eventCategoryOverrides: { auth: 'maybe' } },
      },
    ],
  ])('rejects: %s', async (_name, body) => {
    expect(await putAudit(body)).toEqual(REJECTED);
  });

  it('accepts: http sink variants that pass superRefine/refine', async () => {
    const accepted = async (sink: Record<string, unknown>) =>
      (await putAudit({ ...valid, sinks: [sink] })).status;
    expect(await accepted({ type: 'http', urlRef: 'U' })).toBe(201);
    expect(await accepted({ type: 'http', url: 'https://e.com' })).toBe(201);
    expect(await accepted({ type: 'http', url: 'https://e.com:8443/a?b=c#d' })).toBe(201);
    expect(await accepted({ type: 'http', url: 'HTTPS://e.com' })).toBe(400);
    expect(await accepted({ type: 'http', url: ' https://e.com' })).toBe(400);
    expect(await accepted({ type: 'http', url: '' })).toBe(400);
    expect(await accepted({ type: 'http', url: '', urlRef: 'U' })).toBe(400);
    expect(await accepted({ type: 'http', urlRef: '' })).toBe(400);
    expect(await accepted({ type: 'http', headers: {}, urlRef: 'U' })).toBe(201);
  });

  it('operational constraints (non-zod) run after zod: pins current ordering', async () => {
    const result = await putAudit({ label: 'None', primary: null });
    expect(result).toEqual({ status: 400, body: INVALID_VALUE_BODY });
    expect(
      (await putAudit({ label: 'R', primary: null, archive: { type: 'r2', bucketRef: 'B' } }))
        .status
    ).toBe(201);
  });
});

describe('zod pins: runtime profile residency body (PUT /runtime-profiles/residency/:id)', () => {
  it('accepted shape echoes parsed profile (strips nothing: strict) and defaults nothing', async () => {
    const result = await putResidency({
      label: 'EU',
      description: 'd',
      version: 2,
      metadata: { k: 'v' },
      locationHint: 'weur',
      jurisdiction: 'eu',
      allowedRegions: ['fra', 'ams'],
    });
    expect(result.status).toBe(201);
    expect(result.body.profile).toEqual({
      kind: 'residency',
      label: 'EU',
      description: 'd',
      version: 2,
      metadata: { k: 'v' },
      locationHint: 'weur',
      jurisdiction: 'eu',
      allowedRegions: ['fra', 'ams'],
      id: 'pin-residency',
      builtin: false,
    });
  });

  const valid = { label: 'R', locationHint: 'auto', jurisdiction: 'none' };

  it('minimal body is accepted', async () => {
    const result = await putResidency(valid);
    expect(result.status).toBe(201);
    expect(result.body.profile).toEqual({
      kind: 'residency',
      label: 'R',
      locationHint: 'auto',
      jurisdiction: 'none',
      id: 'pin-residency',
      builtin: false,
    });
  });

  it.each([
    ['null body', null],
    ['array body', []],
    ['empty', {}],
    ['label missing', { locationHint: 'auto', jurisdiction: 'none' }],
    ['label empty', { ...valid, label: '' }],
    ['locationHint invalid', { ...valid, locationHint: 'mars' }],
    ['locationHint missing', { label: 'R', jurisdiction: 'none' }],
    ['jurisdiction invalid', { ...valid, jurisdiction: 'cn' }],
    ['unknown key (strict)', { ...valid, extra: 1 }],
    ['allowedRegions not array', { ...valid, allowedRegions: 'fra' }],
    ['allowedRegions empty entry', { ...valid, allowedRegions: [''] }],
    ['allowedRegions non-string entry', { ...valid, allowedRegions: [1] }],
    ['version 0', { ...valid, version: 0 }],
    ['metadata array', { ...valid, metadata: [] }],
  ])('rejects: %s', async (_name, body) => {
    expect(await putResidency(body)).toEqual(REJECTED);
  });

  it('accepts empty allowedRegions array and every enum member', async () => {
    expect((await putResidency({ ...valid, allowedRegions: [] })).status).toBe(201);
    for (const locationHint of ['auto', 'wnam', 'enam', 'weur', 'eeur', 'apac', 'oc']) {
      expect((await putResidency({ ...valid, locationHint })).status).toBe(201);
    }
    for (const jurisdiction of ['none', 'eu', 'jp', 'us']) {
      expect((await putResidency({ ...valid, jurisdiction })).status).toBe(201);
    }
  });
});

describe('zod pins: runtime profile list query (z.enum + transform)', () => {
  const list = (query: string) => send('GET', `/api/admin/runtime-profiles${query}`);

  it('rejects unknown kind / include_builtins values', async () => {
    expect(await list('?kind=bogus')).toEqual(REJECTED);
    expect(await list('?kind=')).toEqual(REJECTED);
    expect(await list('?include_builtins=maybe')).toEqual(REJECTED);
    expect(await list('?include_builtins=TRUE')).toEqual(REJECTED);
    expect(await list('?include_builtins=')).toEqual(REJECTED);
  });

  it('include_builtins transform: absent and "true" include builtins, "false" excludes', async () => {
    const ids = async (query: string) => {
      const result = await list(query);
      expect(result.status).toBe(200);
      const profiles = result.body.profiles as Record<string, Array<{ id: string }>>;
      return Object.fromEntries(
        Object.entries(profiles).map(([kind, entries]) => [kind, entries.map((e) => e.id).sort()])
      );
    };
    const withBuiltins = await ids('');
    expect(Object.keys(withBuiltins)).toEqual(['audit', 'residency']);
    expect(withBuiltins.audit.length).toBeGreaterThan(0);
    expect(await ids('?include_builtins=true')).toEqual(withBuiltins);
    expect(await ids('?include_builtins=false')).toEqual({ audit: [], residency: [] });
    expect(await ids('?kind=audit&include_builtins=false')).toEqual({ audit: [] });
    expect(Object.keys(await ids('?kind=residency'))).toEqual(['residency']);
  });

  it('unknown query params are ignored; duplicate params use the first value', async () => {
    expect((await list('?unknown=1')).status).toBe(200);
    expect(Object.keys((await list('?kind=audit&kind=residency')).body.profiles as object)).toEqual(
      ['audit']
    );
    expect((await list('?kind=bogus&kind=audit')).status).toBe(400);
  });
});

describe('zod pins: runtime profile defaults update body (strict + refine)', () => {
  const put = (body: unknown, raw?: string) =>
    send('PUT', '/api/admin/runtime-profiles/defaults', body, raw);

  it.each([
    ['null', null],
    ['array', []],
    ['string', 'x'],
    ['empty object (refine: at least one id)', {}],
    ['unknown key only (strict)', { other: 'x' }],
    ['valid id plus unknown key (strict)', { auditProfileId: 'a', other: 'x' }],
    ['empty auditProfileId', { auditProfileId: '' }],
    ['non-string residencyProfileId', { residencyProfileId: 5 }],
    ['null auditProfileId', { auditProfileId: null }],
  ])('rejects: %s', async (_name, body) => {
    expect(await put(body)).toEqual(REJECTED);
  });

  it('malformed JSON is treated as null body and rejected the same way', async () => {
    expect(await put(undefined, '{oops')).toEqual(REJECTED);
  });

  it('accepted bodies reach profile lookup (unknown id -> 404, known builtin -> 200)', async () => {
    const missing = await put({ residencyProfileId: 'does-not-exist' });
    expect(missing.status).toBe(404);
    const ok = await put({ residencyProfileId: 'builtin:residency:eu' });
    expect(ok.status).toBe(200);
    expect(ok.body.updated).toEqual(['infra.default_residency_profile_id']);
  });
});

describe('zod pins: tenant runtime registry emergency purge body (strict)', () => {
  const purge = (body: unknown, raw?: string) =>
    send('POST', '/api/admin/tenants/acme/runtime-registry/emergency-purge', body, raw);
  const good = {
    breakGlassConfirmation: TENANT_RUNTIME_REGISTRY_EMERGENCY_PURGE_CONFIRMATION,
    reason: 'because',
  };

  it.each([
    ['null', null],
    ['array', []],
    ['empty', {}],
    ['missing reason', { breakGlassConfirmation: good.breakGlassConfirmation }],
    ['missing confirmation', { reason: 'x' }],
    ['empty reason', { ...good, reason: '' }],
    ['empty confirmation', { ...good, breakGlassConfirmation: '' }],
    ['empty deploymentTarget', { ...good, deploymentTarget: '' }],
    ['numeric reason', { ...good, reason: 1 }],
    ['unknown key (strict)', { ...good, force: true }],
  ])('rejects: %s', async (_name, body) => {
    expect(await purge(body)).toEqual(REJECTED);
  });

  it('malformed JSON is treated as null body', async () => {
    expect(await purge(undefined, '{oops')).toEqual(REJECTED);
  });

  it('schema-valid body with wrong confirmation is rejected by the handler (same masked body)', async () => {
    expect(await purge({ ...good, breakGlassConfirmation: 'PURGE' })).toEqual(REJECTED);
  });

  it('schema-valid body proceeds to purge (200)', async () => {
    const result = await purge({ ...good, deploymentTarget: 'edge-a' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      purged: true,
      tenant_id: 'acme',
      deployment_target: 'edge-a',
      snapshot_key: 'tenant:acme:runtime-registry:snapshot:tenant:edge-a',
      generation_key: 'tenant:acme:runtime-registry:generation:tenant:edge-a',
      purged_at: expect.any(String) as unknown,
    });
  });
});
