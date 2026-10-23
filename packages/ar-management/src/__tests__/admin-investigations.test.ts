import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { parse as parseYaml } from 'yaml';
import type { AdminAuthContext, DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  loadInvestigationSubjectHmacKeysFromEnv,
  recordSignInAttemptFailure,
  SIGN_IN_ATTEMPT_METHODS,
  SIGN_IN_ATTEMPT_REASON_CODES,
} from '@authrim/ar-lib-core';

/**
 * The status-only investigation read (GET /api/admin/investigations/subjects/:handle/status) on
 * the real Core schema. Every way to the PII store is a tripwire: the PII binding, the functions
 * that resolve PII adapters or PII destinations, and any statement naming a PII table.
 */
const tripwire = vi.hoisted(() => ({
  touched: [] as string[],
  routedCore: null as unknown,
  routeError: null as Error | null,
  tenantStores: [] as unknown[],
}));

function piiTouched(what: string): never {
  tripwire.touched.push(what);
  throw new Error(`pii_store_touched:${what}`);
}

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const touch = (what: string) => () => piiTouched(what);
  return {
    ...actual,
    createPIIContextFromHono: vi.fn(touch('createPIIContextFromHono')),
    createPIIContextFromAuthContext: vi.fn(touch('createPIIContextFromAuthContext')),
    resolveAccountDataContext: vi.fn(touch('resolveAccountDataContext')),
    resolveAccountDataContextFromHono: vi.fn(touch('resolveAccountDataContextFromHono')),
    resolveAccountDataContextByIdentifier: vi.fn(touch('resolveAccountDataContextByIdentifier')),
    resolveCustomClaimRuntimeSourcesFromHono: vi.fn(touch('custom claim sources')),
    resolveCustomClaimRuntimeSourcesFromEnv: vi.fn(touch('custom claim sources')),
    resolveAccountCoreDataContext: vi.fn(async () => {
      if (tripwire.routeError) throw tripwire.routeError;
      if (!tripwire.routedCore) throw new Error('account_data_route_not_found');
      return { coreDb: tripwire.routedCore };
    }),
    resolveTenantAssignedDatabaseSourcesFromRegistry: vi.fn(
      async (_env: unknown, input: { role: string }) => {
        if (input.role !== 'tenant_core') piiTouched(`registry:${input.role}`);
        return tripwire.tenantStores.map((source, index) => ({
          bindingRef: `DB_USERS_${index}`,
          source,
        }));
      }
    ),
  };
});

const audit = vi.hoisted(() => vi.fn());
vi.mock('../admin-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../admin-shared')>()),
  scheduleAdminAuditLog: audit,
}));

import { registerDeclaredAdminRouteAccessMiddleware } from '../admin-route-access';
import { adminInvestigationSubjectStatusHandler } from '../admin-investigations';
import type { SubjectStatus } from '../investigation-subject-status';
import { openCoreStore } from './helpers/core-schema-sqlite';
import type { SQLiteDatabase } from './test-sqlite';

const TENANT = 'tenant-a';
const USER = 'user-1';
const NOW_SECONDS = Math.floor(Date.now() / 1000);
const NOW_MS = NOW_SECONDS * 1000;
const WINDOWS_HELLO = '08987058-cadc-4b81-b6e1-30de50dcbe96';
const KEYRING = JSON.stringify({ current: 1, keys: { '1': 'k'.repeat(43) } });

/** A live Flow interaction of `tenantId`, and failed attempts recorded with it the real way. */
async function seedAttempts(
  store: Store,
  attempts: Array<{
    userId?: string;
    tenantId?: string;
    method: 'passkey' | 'totp' | 'email_code';
    reasonCode: 'invalid_code' | 'credential_not_found' | 'verification_failed';
    at: number;
  }>
) {
  const keys = loadInvestigationSubjectHmacKeysFromEnv({
    INVESTIGATION_SUBJECT_HMAC_KEYRING: KEYRING,
  });
  for (const [index, attempt] of attempts.entries()) {
    const tenantId = attempt.tenantId ?? TENANT;
    const interactionId = `int-${index}`;
    store.db
      .prepare(
        `INSERT INTO flow_interactions (id, tenant_id, flow_id, flow_version_id, client_id, state,
           current_node_id, contract_hash, signature, expires_at, created_at, updated_at)
         VALUES (?, ?, 'flow-default-login-no-consent', 'flow-version-default-login-no-consent-v1',
           'login-ui', 'active', 'authentication', 'contract', 'sig', ?, ?, ?)`
      )
      .run(interactionId, tenantId, NOW_SECONDS + 600, NOW_SECONDS, NOW_SECONDS);
    await recordSignInAttemptFailure(
      store.adapter,
      keys,
      {
        tenantId,
        interactionId,
        method: attempt.method,
        reasonCode: attempt.reasonCode,
        userId: attempt.userId ?? null,
      },
      attempt.at
    );
  }
}

const PII_TABLES =
  /\b(identity_sensitive_values|users_pii|linked_identities|user_anonymization_map|audit_log_pii|subject_identifiers|tombstones)\b/i;

/**
 * Strings the person chose or that identify them, all of which Core holds: none may come back.
 */
const IDENTIFYING = [
  'Taro Yamada', // account and subject display labels
  'taro@corp.example', // contact point display label
  'corp.example', // email domain
  "Taro's iPhone", // passkey device name
  'Taro work phone', // TOTP label
  "Taro's Pixel", // device secret name
  'idp-subject-1234', // external subject at the IdP
  'sid-5678', // external session ID
  'binding-subject-hash', // provider subject key hash
  'CASE-TARO-1', // legal hold case reference
  'hold-reason-free-text', // legal hold reason code
  '$argon2id$secret', // password hash
  'credential-id-abc', // passkey credential ID
  'public-key-xyz', // passkey public key
  'device-secret-hash', // device secret hash
  'installation-xyz', // device installation ID
  'lost phone reported by Taro', // device revoke reason
  '203.0.113.7', // an IP address
  'Mozilla/5.0', // a user agent
];

type Store = { db: SQLiteDatabase; adapter: DatabaseAdapter };

/** The Core adapter, refusing any statement that names a PII table; records every statement. */
function guarded(adapter: DatabaseAdapter, statements: string[]): DatabaseAdapter {
  const check = (sql: string) => {
    statements.push(sql);
    if (PII_TABLES.test(sql)) piiTouched(`sql:${sql.match(PII_TABLES)?.[0]}`);
  };
  return {
    ...adapter,
    query: async (sql: string, params?: unknown[]) => (check(sql), adapter.query(sql, params)),
    queryOne: async (sql: string, params?: unknown[]) => (
      check(sql),
      adapter.queryOne(sql, params)
    ),
    execute: async (sql: string, params?: unknown[]) => (check(sql), adapter.execute(sql, params)),
  } as DatabaseAdapter;
}

function seedSubject(store: Store, options: { lifecycle?: string } = {}) {
  const run = (sql: string, ...params: unknown[]) =>
    store.db.prepare(sql).run(...(params as never[]));
  const lifecycle = options.lifecycle ?? 'locked';
  // The legacy user rows the session and device foreign keys name. The legacy table holds the
  // address too: it must not be read either.
  run(`INSERT INTO users_core (id, created_at, updated_at) VALUES (?, 1, 1)`, USER);
  run(
    `INSERT INTO users (id, email, created_at, updated_at) VALUES (?, 'taro@corp.example', 1, 1)`,
    USER
  );
  run(
    `INSERT INTO identity_subjects (id, tenant_id, subject_type, lifecycle_state, display_label,
       primary_account_id, created_at, updated_at)
     VALUES ('subject-1', ?, 'person', 'active', 'Taro Yamada', 'account-1', ?, ?)`,
    TENANT,
    NOW_SECONDS - 86_400,
    NOW_SECONDS
  );
  run(
    `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state, legacy_user_id,
       primary_subject_id, display_label, metadata_json, created_at, updated_at)
     VALUES ('account-1', ?, 'user', ?, ?, 'subject-1', 'Taro Yamada', ?, ?, ?)`,
    TENANT,
    lifecycle,
    USER,
    JSON.stringify({
      status: lifecycle,
      locked_at: NOW_MS - 60_000,
      locked_until: NOW_MS + 3_600_000,
      last_login_at: NOW_MS - 120_000,
      password_hash: '$argon2id$secret',
      external_id: 'Taro Yamada',
    }),
    NOW_SECONDS - 86_400,
    NOW_SECONDS
  );
  run(
    `INSERT INTO contact_points (id, tenant_id, subject_id, account_id, contact_type,
       normalized_hash, value_storage_ref, display_label, is_primary, verification_state,
       created_at, updated_at)
     VALUES ('contact-1', ?, 'subject-1', 'account-1', 'email', 'canonical-sensitive:x:email',
       'canonical-sensitive:x:email', 'taro@corp.example', 1, 'verified', ?, ?)`,
    TENANT,
    NOW_SECONDS,
    NOW_SECONDS
  );
  run(
    `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports,
       device_name, created_at, last_used_at, tenant_id, aaguid, rp_id)
     VALUES ('passkey-1', ?, 'credential-id-abc', 'public-key-xyz', 3,
       '["internal","hybrid","Taro''s iPhone"]', 'Taro''s iPhone', ?, ?, ?, ?, 'auth.example.com')`,
    USER,
    NOW_SECONDS - 3_600,
    NOW_SECONDS - 600,
    TENANT,
    WINDOWS_HELLO.toUpperCase()
  );
  run(
    `INSERT INTO totp_credentials (id, tenant_id, user_id, secret_encrypted, label, status,
       created_at, activated_at, last_used_at)
     VALUES ('totp-1', ?, ?, 'encrypted', 'Taro work phone', 'active', ?, ?, ?)`,
    TENANT,
    USER,
    NOW_SECONDS - 7_200,
    NOW_SECONDS - 7_100,
    NOW_SECONDS - 900
  );
  run(
    `INSERT INTO sessions (id, user_id, expires_at, created_at, external_provider_id,
       external_provider_sub, tenant_id, external_provider_sid)
     VALUES ('session-live', ?, ?, ?, 'google', 'idp-subject-1234', ?, 'sid-5678'),
            ('session-old', ?, ?, ?, NULL, NULL, ?, NULL)`,
    USER,
    NOW_SECONDS + 3_600,
    NOW_SECONDS - 300,
    TENANT,
    USER,
    NOW_SECONDS - 60,
    NOW_SECONDS - 86_000,
    TENANT
  );
  run(
    `INSERT INTO device_secrets (id, tenant_id, user_id, session_id, secret_hash, device_name,
       device_platform, installation_id, created_at, updated_at, expires_at, last_used_at,
       use_count, revoked_at, revoke_reason, is_active)
     VALUES ('device-1', ?, ?, 'session-live', 'device-secret-hash', 'Taro''s Pixel', 'android',
       'installation-xyz', ?, ?, ?, ?, 4, NULL, NULL, 1),
            ('device-2', ?, ?, 'session-old', 'device-secret-hash-2', 'Taro''s Pixel',
       'Taro''s Pixel', 'installation-xyz', ?, ?, ?, NULL, 0, ?, 'lost phone reported by Taro', 0)`,
    TENANT,
    USER,
    NOW_MS - 3_000,
    NOW_MS,
    NOW_MS + 86_400_000,
    NOW_MS - 1_000,
    TENANT,
    USER,
    NOW_MS - 9_000,
    NOW_MS,
    NOW_MS + 86_400_000,
    NOW_MS - 5_000
  );
  run(
    `INSERT INTO legal_holds (id, tenant_id, subject_type, subject_id, state, reason_code,
       case_reference, created_by, created_at, updated_at)
     VALUES ('hold-1', ?, 'account', 'account-1', 'active', 'hold-reason-free-text', 'CASE-TARO-1',
       'admin-1', ?, ?)`,
    TENANT,
    NOW_MS,
    NOW_MS
  );
  run(
    `INSERT INTO identity_bindings (id, tenant_id, subject_id, account_id, protocol, source_id,
       provider_subject_key_hash, binding_kind, lifecycle_state, metadata_json, created_at,
       updated_at, last_seen_at)
     VALUES ('binding-1', ?, 'subject-1', 'account-1', 'oidc', 'google', 'binding-subject-hash',
       'external_subject', 'active', '{"email":"taro@corp.example"}', ?, ?, ?)`,
    TENANT,
    NOW_SECONDS - 5_000,
    NOW_SECONDS,
    NOW_SECONDS - 100
  );
}

function permissionsFor(kind: 'status' | 'users' | 'none'): string[] {
  if (kind === 'status') return [ADMIN_PERMISSIONS.USERS_STATUS_READ];
  if (kind === 'users') return [ADMIN_PERMISSIONS.USERS_READ];
  return [ADMIN_PERMISSIONS.CLIENTS_READ];
}

function harness(input: {
  permissions: string[];
  core: DatabaseAdapter;
  route?: Record<string, unknown>;
  /** The investigation keyring the Worker holds (none: null). */
  keyring?: string | null;
}) {
  const keyring = input.keyring === undefined ? KEYRING : input.keyring;
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    const set = (c as unknown as { set(key: string, value: unknown): void }).set.bind(c);
    set('adminAuth', {
      userId: 'operator-1',
      authMethod: 'session',
      actorType: 'human',
      tenantId: TENANT,
      roles: [],
      permissions: input.permissions,
      hierarchyLevel: 0,
      mfaVerified: true,
    } satisfies Partial<AdminAuthContext>);
    set('tenantId', TENANT);
    set('tenantMetadataContext', {
      tenantId: TENANT,
      coreDb: input.core,
      route: input.route ?? {},
    });
    await next();
  });
  registerDeclaredAdminRouteAccessMiddleware(app);
  app.get(
    '/api/admin/investigations/subjects/:handle/status',
    adminInvestigationSubjectStatusHandler
  );
  const env = new Proxy({} as Env, {
    get: (_target, key) =>
      key === 'INVESTIGATION_SUBJECT_HMAC_KEYRING'
        ? (keyring ?? undefined)
        : typeof key === 'string' && /PII/.test(key)
          ? piiTouched(`env.${key}`)
          : undefined,
  });
  return (handle: string) =>
    app.request(
      `/api/admin/investigations/subjects/${encodeURIComponent(handle)}/status`,
      { headers: { 'X-Tenant-Id': TENANT } },
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as never
    );
}

describe('status-only investigation read', () => {
  let store: Store;
  let statements: string[];
  let core: DatabaseAdapter;

  beforeEach(() => {
    tripwire.touched = [];
    tripwire.routedCore = null;
    tripwire.routeError = null;
    tripwire.tenantStores = [];
    audit.mockReset();
    store = openCoreStore(TENANT);
    seedSubject(store);
    statements = [];
    core = guarded(store.adapter, statements);
  });

  it('returns the account status from Core alone, without identifying strings', async () => {
    const response = await harness({ permissions: permissionsFor('users'), core })(`user:${USER}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    const body = JSON.parse(text) as SubjectStatus;

    expect(body).toMatchObject({
      subject: { entry_point: 'user_id' },
      source: 'core',
      account: {
        registration_state: 'registered',
        is_guest: false,
        lifecycle_state: 'locked',
        status: 'locked',
        locked_at: NOW_MS - 60_000,
        locked_until: NOW_MS + 3_600_000,
        last_login_at: NOW_MS - 120_000,
      },
      legal_hold: { active: true },
      credentials: {
        password: { configured: true },
        email: { registered: true, verified: true },
        passkeys: [
          {
            provider_name: 'Windows Hello',
            transports: ['internal', 'hybrid'],
            created_at: (NOW_SECONDS - 3_600) * 1000,
            last_used_at: (NOW_SECONDS - 600) * 1000,
          },
        ],
        totp: [{ status: 'active', last_used_at: (NOW_SECONDS - 900) * 1000 }],
      },
      devices: { available: true, total: 2, active: 1 },
    });
    expect(body.devices.items.map((device) => device.platform)).toEqual(['android', 'other']);
    expect(Object.keys(body.credentials.passkeys[0]).sort()).toEqual(
      ['created_at', 'last_used_at', 'provider_name', 'transports'].sort()
    );

    for (const value of IDENTIFYING) expect(text).not.toContain(value);
    expect(text).not.toContain('account-1');
    expect(text).not.toContain('subject-1');
    expect(tripwire.touched).toEqual([]);
    expect(statements.length).toBeGreaterThan(0);
  });

  it('reports the parts Core does not record as not recorded, never as none', async () => {
    const notRecorded = { available: false, reason: 'not_recorded_in_core' };
    // Legacy rows in Core's sessions table and an identity binding are there, and still are not
    // the record: sessions live in the session store, links in the PII store.
    const withRows = await (
      await harness({ permissions: permissionsFor('users'), core })(`user:${USER}`)
    ).json<Record<string, unknown>>();
    expect(withRows.sessions).toEqual(notRecorded);
    expect(withRows.linked_providers).toEqual(notRecorded);

    store.db.prepare('DELETE FROM sessions').run();
    store.db.prepare('DELETE FROM identity_bindings').run();
    store.db.prepare('DELETE FROM device_secrets').run();
    const without = await (
      await harness({ permissions: permissionsFor('users'), core })(`user:${USER}`)
    ).json<Record<string, unknown>>();
    expect(without.sessions).toEqual(notRecorded);
    expect(without.linked_providers).toEqual(notRecorded);
    // Devices are recorded in Core: none there is none.
    expect(without.devices).toEqual({ available: true, total: 0, active: 0, items: [] });
    expect(statements.some((sql) => /\bsessions\b|identity_bindings/.test(sql))).toBe(false);
  });

  it('tells a registered email apart from a verified one, reading neither address', async () => {
    store.db
      .prepare(`UPDATE contact_points SET verification_state = 'unverified' WHERE id = 'contact-1'`)
      .run();
    const unverified = await (
      await harness({ permissions: permissionsFor('users'), core })(`user:${USER}`)
    ).json<{ credentials: { email: unknown } }>();
    expect(unverified.credentials.email).toEqual({ registered: true, verified: false });

    store.db.prepare(`DELETE FROM contact_points`).run();
    const none = await (
      await harness({ permissions: permissionsFor('users'), core })(`user:${USER}`)
    ).json<{ credentials: { email: unknown } }>();
    expect(none.credentials.email).toEqual({ registered: false, verified: false });
  });

  it('records who read which subject through which entry point, and nothing typed in', async () => {
    await harness({ permissions: permissionsFor('users'), core })(`user:${USER}`);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]?.slice(1)).toEqual([
      'investigation.subject_status.read',
      USER,
      'success',
      { entry_point: 'user_id' },
    ]);
  });

  it('lets a status-only caller through the route gate but not through the user-ID entry point', async () => {
    const response = await harness({ permissions: permissionsFor('status'), core })(`user:${USER}`);
    expect(response.status).toBe(403);
    // Refused before anything was read: the caller learns nothing about the user.
    expect(statements).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
    expect(tripwire.touched).toEqual([]);
  });

  it('refuses a caller with neither permission at the route gate', async () => {
    const response = await harness({ permissions: permissionsFor('none'), core })(`user:${USER}`);
    expect(response.status).toBe(403);
    expect(statements).toEqual([]);
  });

  it.each([
    'user-1',
    'user:',
    'user: user-1',
    'user:user-1\n',
    'user:user\u00001',
    'user:taro@corp.example',
    'user:Taro Yamada',
    'inv:abc',
    `user:${'x'.repeat(600)}`,
  ])(
    'answers a handle of no known form (%j) as not found, without reading or recording it',
    async (handle) => {
      const response = await harness({ permissions: permissionsFor('users'), core })(handle);
      expect(response.status).toBe(404);
      expect(statements).toEqual([]);
      // What the operator typed (an email address, a name) never reaches the audit log.
      expect(audit).not.toHaveBeenCalled();
    }
  );

  it('records a read that fails part-way, without the error text', async () => {
    const failing = {
      ...core,
      query: async (sql: string, params?: unknown[]) => {
        if (/FROM passkeys/.test(sql)) throw new Error('D1_ERROR: taro@corp.example');
        return core.query(sql, params);
      },
    } as DatabaseAdapter;
    const output: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '));
      })
    );
    let response: Response;
    try {
      response = await harness({ permissions: permissionsFor('users'), core: failing })(
        `user:${USER}`
      );
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('corp.example');
    // The failure is logged, but by its type only: the error text may quote what it was given.
    expect(output.join('\n')).toContain('Subject status read failed');
    expect(output.join('\n')).not.toContain('corp.example');
    expect(audit.mock.calls.map((call: unknown[]) => call.slice(1))).toEqual([
      [
        'investigation.subject_status.read',
        USER,
        'failure',
        { entry_point: 'user_id', reason: 'read_failed' },
      ],
    ]);
  });

  it('answers an unknown user as not found and records the failed read', async () => {
    const response = await harness({ permissions: permissionsFor('users'), core })('user:nobody');
    expect(response.status).toBe(404);
    expect(audit.mock.calls[0]?.slice(1)).toEqual([
      'investigation.subject_status.read',
      'nobody',
      'failure',
      { entry_point: 'user_id', reason: 'not_found' },
    ]);
    expect(tripwire.touched).toEqual([]);
  });

  it.each(['admin', 'service_account'])(
    'does not answer for a %s account: only end users are investigated here',
    async (accountType) => {
      store.db
        .prepare(`UPDATE identity_accounts SET account_type = ? WHERE id = 'account-1'`)
        .run(accountType);
      const response = await harness({ permissions: permissionsFor('users'), core })(
        `user:${USER}`
      );
      expect(response.status).toBe(404);
      expect(audit.mock.calls[0]?.slice(3)).toEqual([
        'failure',
        { entry_point: 'user_id', reason: 'not_found' },
      ]);
    }
  );

  it('returns stored states only from closed sets, never stored text', async () => {
    store.db
      .prepare(
        `UPDATE identity_accounts
            SET metadata_json = json_set(metadata_json, '$.status', 'locked by Taro Yamada')
          WHERE id = 'account-1'`
      )
      .run();
    const text = await (
      await harness({ permissions: permissionsFor('users'), core })(`user:${USER}`)
    ).text();
    const body = JSON.parse(text) as SubjectStatus;
    expect(body.account.status).toBe('other');
    expect(body.account.lifecycle_state).toBe('locked');
    expect(text).not.toContain('Taro Yamada');
  });

  it("lists the account's recent failed attempts, newest first, and no one else's", async () => {
    await seedAttempts(store, [
      { userId: USER, method: 'totp', reasonCode: 'invalid_code', at: NOW_SECONDS - 60 },
      { userId: USER, method: 'passkey', reasonCode: 'verification_failed', at: NOW_SECONDS - 10 },
      // Before the account was known, another account's, another tenant's: not this account's.
      { method: 'passkey', reasonCode: 'credential_not_found', at: NOW_SECONDS - 5 },
      { userId: 'user-2', method: 'totp', reasonCode: 'invalid_code', at: NOW_SECONDS - 4 },
      {
        userId: USER,
        tenantId: 'tenant-b',
        method: 'totp',
        reasonCode: 'invalid_code',
        at: NOW_SECONDS - 3,
      },
    ]);
    const text = await (
      await harness({ permissions: permissionsFor('users'), core })(`user:${USER}`)
    ).text();
    expect((JSON.parse(text) as { recent_attempts: unknown }).recent_attempts).toEqual({
      available: true,
      coverage: 'flow_interactions',
      total: 2,
      truncated: false,
      summary: [
        {
          method: 'passkey',
          reason_code: 'verification_failed',
          count: 1,
          first_at: (NOW_SECONDS - 10) * 1000,
          last_at: (NOW_SECONDS - 10) * 1000,
        },
        {
          method: 'totp',
          reason_code: 'invalid_code',
          count: 1,
          first_at: (NOW_SECONDS - 60) * 1000,
          last_at: (NOW_SECONDS - 60) * 1000,
        },
      ],
      items: [
        {
          created_at: (NOW_SECONDS - 10) * 1000,
          method: 'passkey',
          result: 'failure',
          reason_code: 'verification_failed',
        },
        {
          created_at: (NOW_SECONDS - 60) * 1000,
          method: 'totp',
          result: 'failure',
          reason_code: 'invalid_code',
        },
      ],
    });
    // A row of another tenant is never listed, even one carrying this tenant's hash.
    store.db
      .prepare(
        `UPDATE flow_audit_events SET subject_hash = (
            SELECT subject_hash FROM flow_audit_events
             WHERE tenant_id = ? AND subject_hash IS NOT NULL LIMIT 1)
          WHERE tenant_id = 'tenant-b'`
      )
      .run(TENANT);
    const again = await (
      await harness({ permissions: permissionsFor('users'), core })(`user:${USER}`)
    ).json<{ recent_attempts: { items: unknown[] } }>();
    expect(again.recent_attempts.items).toHaveLength(2);
    // Neither the hash nor the inquiry number is the operator's to see here.
    expect(text).not.toMatch(/isub:|inquiry/u);
    expect(tripwire.touched).toEqual([]);
  });

  it('reports attempts as unavailable without the investigation keyring, not as none', async () => {
    await seedAttempts(store, [
      { userId: USER, method: 'totp', reasonCode: 'invalid_code', at: NOW_SECONDS },
    ]);
    for (const keyring of [null, '{"current":1}']) {
      const body = await (
        await harness({ permissions: permissionsFor('users'), core, keyring })(`user:${USER}`)
      ).json<Record<string, unknown>>();
      expect(body.recent_attempts).toEqual({ available: false, reason: 'key_unavailable' });
    }
  });

  it('returns recorded methods, reasons and nodes only from their closed sets', async () => {
    await seedAttempts(store, [
      { userId: USER, method: 'totp', reasonCode: 'invalid_code', at: NOW_SECONDS },
    ]);
    store.db
      .prepare(
        `UPDATE flow_audit_events
            SET method = 'password', reason_code = 'denied for Taro Yamada', node_id = 'Taro-Yamada'
          WHERE event_type = 'flow.sign_in_attempt.failed'`
      )
      .run();
    const text = await (
      await harness({ permissions: permissionsFor('users'), core })(`user:${USER}`)
    ).text();
    expect(
      (JSON.parse(text) as { recent_attempts: { items: unknown[] } }).recent_attempts.items[0]
    ).toEqual({
      created_at: NOW_SECONDS * 1000,
      method: 'other',
      result: 'failure',
      reason_code: 'other',
    });
    // A Flow node is named by the Flow's author, so it is never returned, whatever it looks like.
    expect(text).not.toMatch(/Taro/u);
  });

  it('keeps a burst of attempts from hiding older ones: counts and a summary of all', async () => {
    // One older failure, then a burst of another kind (say, someone trying codes on purpose).
    await seedAttempts(store, [
      { userId: USER, method: 'passkey', reasonCode: 'verification_failed', at: NOW_SECONDS - 900 },
      ...Array.from({ length: 25 }, (_, index) => ({
        userId: USER,
        method: 'totp' as const,
        reasonCode: 'invalid_code' as const,
        at: NOW_SECONDS - 100 + index,
      })),
    ]);
    const body = await (
      await harness({ permissions: permissionsFor('users'), core })(`user:${USER}`)
    ).json<{
      recent_attempts: {
        total: number;
        truncated: boolean;
        summary: Array<{ method: string; reason_code: string; count: number }>;
        items: Array<{ reason_code: string }>;
      };
    }>();
    const attempts = body.recent_attempts;
    expect(attempts.items).toHaveLength(20);
    expect(attempts.items.every((item) => item.reason_code === 'invalid_code')).toBe(true);
    expect(attempts.total).toBe(26);
    expect(attempts.truncated).toBe(true);
    expect(
      attempts.summary.map(({ method, reason_code, count }) => [method, reason_code, count])
    ).toEqual([
      ['totp', 'invalid_code', 25],
      ['passkey', 'verification_failed', 1],
    ]);
  });

  it('counts every failure however many distinct stored values there are', async () => {
    await seedAttempts(store, [
      { userId: USER, method: 'passkey', reasonCode: 'verification_failed', at: NOW_SECONDS - 900 },
      ...Array.from({ length: 205 }, (_, index) => ({
        userId: USER,
        method: 'totp' as const,
        reasonCode: 'invalid_code' as const,
        at: NOW_SECONDS - 300 + index,
      })),
    ]);
    // Every later record carries a different value outside the vocabulary.
    store.db
      .prepare(
        `UPDATE flow_audit_events SET reason_code = 'unknown-' || rowid
          WHERE event_type = 'flow.sign_in_attempt.failed' AND method = 'totp'`
      )
      .run();
    const body = await (
      await harness({ permissions: permissionsFor('users'), core })(`user:${USER}`)
    ).json<{
      recent_attempts: {
        total: number;
        summary: Array<{ method: string; reason_code: string; count: number }>;
      };
    }>();
    expect(body.recent_attempts.total).toBe(206);
    expect(
      body.recent_attempts.summary.map(({ method, reason_code, count }) => [
        method,
        reason_code,
        count,
      ])
    ).toEqual([
      ['totp', 'other', 205],
      ['passkey', 'verification_failed', 1],
    ]);
  });

  it('adds stored values outside the vocabulary up under other in the summary', async () => {
    await seedAttempts(store, [
      { userId: USER, method: 'totp', reasonCode: 'invalid_code', at: NOW_SECONDS - 2 },
      { userId: USER, method: 'totp', reasonCode: 'invalid_code', at: NOW_SECONDS - 1 },
    ]);
    store.db
      .prepare(
        `UPDATE flow_audit_events SET reason_code = 'denied for Taro ' || rowid
          WHERE event_type = 'flow.sign_in_attempt.failed'`
      )
      .run();
    const text = await (
      await harness({ permissions: permissionsFor('users'), core })(`user:${USER}`)
    ).text();
    const attempts = (
      JSON.parse(text) as {
        recent_attempts: { summary: Array<{ reason_code: string; count: number }> };
      }
    ).recent_attempts;
    expect(attempts.summary).toMatchObject([{ reason_code: 'other', count: 2 }]);
    expect(text).not.toMatch(/Taro/u);
  });

  it('marks a guest account and its deletion date', async () => {
    store.db
      .prepare(`UPDATE identity_accounts SET registration_state = 'guest' WHERE id = 'account-1'`)
      .run();
    store.db
      .prepare(
        `INSERT INTO guest_account_lifecycle (tenant_id, user_id, client_id, phase, created_at,
           deletion_due_at, policy_version, updated_at)
         VALUES (?, ?, 'client-1', 'active', ?, ?, 'v1', ?)`
      )
      .run(TENANT, USER, NOW_MS, NOW_MS + 86_400_000, NOW_MS);
    const body = await (
      await harness({ permissions: permissionsFor('users'), core })(`user:${USER}`)
    ).json<{ account: Record<string, unknown> }>();
    expect(body.account).toMatchObject({
      registration_state: 'guest',
      is_guest: true,
      guest_deletion_due_at: NOW_MS + 86_400_000,
    });
  });

  describe('routed account storage', () => {
    const route = { allocationScope: 'shared_pool' };
    let metadataStatements: string[];
    let metadata: DatabaseAdapter;

    beforeEach(() => {
      metadataStatements = [];
      metadata = guarded(openCoreStore(TENANT).adapter, metadataStatements);
    });

    it("reads attempts from the tenant's Flow database, the status from the account's", async () => {
      tripwire.routedCore = core;
      const flow = openCoreStore(TENANT);
      await seedAttempts(flow, [
        { userId: USER, method: 'email_code', reasonCode: 'invalid_code', at: NOW_SECONDS },
      ]);
      const body = await (
        await harness({ permissions: permissionsFor('users'), core: flow.adapter, route })(
          `user:${USER}`
        )
      ).json<{ account: { status: string }; recent_attempts: { items: unknown[] } }>();
      expect(body.account.status).toBe('locked');
      expect(body.recent_attempts.items).toHaveLength(1);
    });

    it("reads an active account's own Core database through its Core route only", async () => {
      tripwire.routedCore = core;
      const response = await harness({
        permissions: permissionsFor('users'),
        core: metadata,
        route,
      })(`user:${USER}`);
      expect(response.status).toBe(200);
      // The tenant's database is read for the attempts recorded with Flow interactions only.
      expect(metadataStatements).toHaveLength(2);
      for (const sql of metadataStatements) expect(sql).toMatch(/FROM flow_audit_events/u);
      expect(tripwire.touched).toEqual([]);
    });

    it('finds a locked account (no active route) among the tenant Core databases', async () => {
      tripwire.routeError = new Error('lookup_destination_revalidation_failed', {
        cause: 'account_inactive',
      });
      const other = guarded(openCoreStore(TENANT).adapter, []);
      tripwire.tenantStores = [other, core];
      const response = await harness({
        permissions: permissionsFor('users'),
        core: metadata,
        route,
      })(`user:${USER}`);
      expect(response.status).toBe(200);
      expect((await response.json<{ account: { status: string } }>()).account.status).toBe(
        'locked'
      );
      expect(tripwire.touched).toEqual([]);
    });

    it('answers an account with no route as not found', async () => {
      const response = await harness({
        permissions: permissionsFor('users'),
        core: metadata,
        route,
      })(`user:${USER}`);
      expect(response.status).toBe(404);
      expect(tripwire.touched).toEqual([]);
    });
  });
});

type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  items?: Schema;
  oneOf?: Schema[];
};

/**
 * Whether `value` has the shape `schema` documents: every required key, no key it does not list,
 * enums kept. Returns the paths that differ.
 */
function shapeErrors(
  schemas: Record<string, Schema>,
  schema: Schema,
  value: unknown,
  path = '$'
): string[] {
  const errors: string[] = [];
  const resolved = schema.$ref ? (schemas[schema.$ref.split('/').pop() ?? ''] ?? {}) : schema;
  if (resolved.oneOf) {
    const matching = resolved.oneOf.filter(
      (variant) => shapeErrors(schemas, variant, value, path).length === 0
    );
    return matching.length === 1 ? [] : [`${path}: matches ${matching.length} variants`];
  }
  const typeOf = (item: unknown) =>
    item === null
      ? 'null'
      : Array.isArray(item)
        ? 'array'
        : Number.isInteger(item)
          ? 'integer'
          : typeof item;
  const types = [resolved.type ?? (resolved.properties ? 'object' : [])].flat();
  const actual = typeOf(value);
  if (
    types.length > 0 &&
    !types.includes(actual) &&
    !(actual === 'integer' && types.includes('number'))
  ) {
    return [`${path}: ${actual} is not ${types.join('|')}`];
  }
  if (resolved.enum && !resolved.enum.includes(value)) errors.push(`${path}: ${String(value)}`);
  if (resolved.properties && actual === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of resolved.required ?? []) if (!(key in record)) errors.push(`${path}.${key}`);
    for (const [key, child] of Object.entries(record)) {
      const childSchema = resolved.properties[key];
      if (!childSchema) {
        if (resolved.additionalProperties === false) errors.push(`${path}.${key} (undocumented)`);
        continue;
      }
      errors.push(...shapeErrors(schemas, childSchema, child, `${path}.${key}`));
    }
  }
  if (resolved.items && Array.isArray(value)) {
    value.forEach((item, index) =>
      errors.push(...shapeErrors(schemas, resolved.items!, item, `${path}[${index}]`))
    );
  }
  return errors;
}

describe('status-only investigation contract', () => {
  it('answers exactly the documented shape', async () => {
    const spec = parseYaml(
      readFileSync(new URL('../../openapi/admin.openapi.yaml', import.meta.url), 'utf8')
    ) as { components: { schemas: Record<string, Schema> } };
    const schemas = spec.components.schemas;
    const store = openCoreStore(TENANT);
    seedSubject(store);
    await seedAttempts(store, [
      { userId: USER, method: 'passkey', reasonCode: 'verification_failed', at: NOW_SECONDS },
    ]);
    const response = await harness({ permissions: permissionsFor('users'), core: store.adapter })(
      `user:${USER}`
    );
    expect(response.status).toBe(200);
    const body = await response.json<SubjectStatus & { recent_attempts: unknown }>();
    const status = schemas.InvestigationSubjectStatus ?? {};
    expect(shapeErrors(schemas, status, body)).toEqual([]);

    // The check itself: a wrong type, an unknown value or an undocumented key is caught.
    // Each change is written as JSON the API could send, whatever the TypeScript type says.
    const broken = (path: string[], value: unknown) => {
      const copy = structuredClone(body) as unknown as Record<string, unknown>;
      let target = copy;
      for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
      target[path[path.length - 1]] = value;
      return shapeErrors(schemas, status, copy);
    };
    expect(broken(['sessions'], null)).not.toEqual([]);
    expect(broken(['sessions'], { available: true, total: 0 })).not.toEqual([]);
    expect(broken(['credentials', 'passkeys'], {})).not.toEqual([]);
    expect(broken(['devices', 'total'], '2')).not.toEqual([]);
    expect(broken(['account', 'locked_at'], 'yesterday')).not.toEqual([]);
    expect(broken(['credentials', 'passkeys', '0', 'device_name'], 'x')).not.toEqual([]);
    expect(body.recent_attempts).toMatchObject({ available: true, items: [expect.anything()] });
    expect(broken(['recent_attempts', 'items', '0', 'reason_code'], 'boom')).not.toEqual([]);
    expect(broken(['recent_attempts'], { available: true, items: [] })).not.toEqual([]);
  });

  it('documents exactly the recorded vocabulary of methods and reasons, and other', () => {
    const spec = parseYaml(
      readFileSync(new URL('../../openapi/admin.openapi.yaml', import.meta.url), 'utf8')
    ) as { components: { schemas: Record<string, Schema> } };
    const recorded = spec.components.schemas.InvestigationRecentSignInAttempts?.oneOf?.[0];
    const item = recorded?.properties?.items?.items?.properties;
    expect(item?.reason_code?.enum).toEqual([...SIGN_IN_ATTEMPT_REASON_CODES, 'other']);
    expect(item?.method?.enum).toEqual([...SIGN_IN_ATTEMPT_METHODS, 'other']);
  });
});

describe('status-only investigation modules', () => {
  // The status path is given Core adapters only: the modules on it name no way to the PII store.
  const FORBIDDEN =
    /createPIIContext|PIIContext|piiAdapter|PiiAdapter|piiDb|DB_PII|CanonicalSensitiveValueResolver|CanonicalRuntimeUserProjection|RuntimeUserStore|resolveAccountDataContext\b|resolveAccountDataContextFromHono|identity_sensitive_values|linked_identities|user_anonymization_map|users_pii|device_name|display_label|\blabel\b|ip_address|user_agent|external_provider_sub|provider_subject_key_hash|case_reference|revoke_reason/;

  it.each(['../investigation-subject-status.ts', '../admin-investigations.ts'])(
    '%s names no PII store and selects no identifying column',
    (path) => {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8')
        // Comments describe what is left out; only code counts.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(source).not.toMatch(FORBIDDEN);
    }
  );
});
