import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { createAuditLog } from '../audit-log';
import {
  ANONYMIZED_USER_ID_CACHE_MAX_ENTRIES,
  ANONYMIZED_USER_ID_CACHE_TTL_MS,
  anonymizedUserIdCacheSize,
  cacheAnonymizedUserId,
  clearAnonymizedUserIdCache,
  getCachedAnonymizedUserId,
} from '../../services/audit/anonymized-user-id-cache';
import { sanitizeEventDetails } from '../../services/audit/utils';
import { DEFAULT_PII_CONFIG } from '../../services/audit/types';
import { AnonymizationService } from '../../services/audit/anonymization';

const accountRoutes = vi.hoisted(() => ({
  pii: new Map<string, unknown>(),
}));

vi.mock('../../services/runtime-data-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/runtime-data-context')>()),
  // The account route resolves the user's PII store (tested with the resolver); an unknown ID
  // names no account.
  resolveAccountPiiSourceForAudit: vi.fn(async (_env: Env, input: { accountId: string }) => {
    const piiDb = accountRoutes.pii.get(input.accountId);
    if (!piiDb) throw new Error('account_data_route_not_found');
    return piiDb;
  }),
}));

/** The adapter surface the audit service needs to treat the SQLite handle as an adapter. */
function asAdapter(base: DatabaseAdapter): DatabaseAdapter {
  return Object.assign(base, {
    transaction: () => Promise.reject(new Error('unused')),
    isHealthy: async () => true,
    getType: () => 'd1',
    close: async () => {},
  });
}

/** A PII store whose every call waits for `release()`, counting the calls it receives. */
function gatedPiiStore() {
  const { db, adapter: base } = sqliteAdapter('pii');
  const store = asAdapter(base);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const calls: string[] = [];
  const wrap =
    <K extends 'query' | 'queryOne' | 'execute'>(method: K) =>
    async (...args: Parameters<DatabaseAdapter[K]>) => {
      calls.push(String(args[0]));
      await gate;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (store[method] as any)(...args);
    };
  const adapter = asAdapter({
    query: wrap('query'),
    queryOne: wrap('queryOne'),
    execute: wrap('execute'),
    batch: (statements: Parameters<DatabaseAdapter['batch']>[0]) => store.batch(statements),
  } as unknown as DatabaseAdapter);
  return { db, adapter, calls, release: () => open() };
}

function setup() {
  const core = sqliteAdapter('core');
  const coreAdapter = asAdapter(core.adapter);
  // The tenant default PII binding: a routed user's mapping must not land here.
  const defaultPii = sqliteAdapter('pii');
  const routedPii = gatedPiiStore();
  accountRoutes.pii.set('user-1', routedPii.adapter);
  accountRoutes.pii.set('user-gone', routedPii.adapter);
  const env = { DB: coreAdapter, DB_PII: asAdapter(defaultPii.adapter) } as unknown as Env;
  const pending: Promise<unknown>[] = [];
  const waitUntil = (promise: Promise<unknown>) => {
    pending.push(promise);
  };
  const afterResponse = async () => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };
  const row = (id: string) =>
    core.db
      .prepare(
        `SELECT result, anonymized_user_id, client_id, session_id, details_json
           FROM event_log WHERE id = ?`
      )
      .get(id) as
      | {
          result: string;
          anonymized_user_id: string | null;
          client_id: string | null;
          session_id: string | null;
          details_json: string | null;
        }
      | undefined;
  const mapping = (db: typeof core.db, userId: string) =>
    (
      db
        .prepare(
          'SELECT anonymized_user_id FROM user_anonymization_map WHERE tenant_id = ? AND user_id = ?'
        )
        .get('default', userId) as { anonymized_user_id: string } | undefined
    )?.anonymized_user_id;
  return { env, routedPii, defaultPii, waitUntil, afterResponse, row, mapping };
}

async function sessionRef(sessionId: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`authrim:event_log:session\u0000${sessionId}`)
  );
  return `sid_${Buffer.from(digest).toString('hex')}`;
}

/** An event-dispatcher sign-in: the user is in the event data, the actor is 'system'. */
const signIn = (id: string, userId = 'user-1') => ({
  id,
  tenantId: 'default',
  userId: 'system',
  action: 'auth.passkey.succeeded',
  resource: 'auth',
  resourceId: 'passkey-auth',
  ipAddress: 'system',
  userAgent: 'event-dispatcher',
  severity: 'info' as const,
  metadata: JSON.stringify({
    userId,
    method: 'passkey',
    clientId: 'passkey-auth',
    sessionId: 'sess-secret-cookie-value',
  }),
});

beforeEach(() => {
  clearAnonymizedUserIdCache();
  accountRoutes.pii.clear();
});
afterEach(() => vi.useRealTimers());

describe('event_log mirror: anonymized_user_id', () => {
  it('records a sign-in under the user, read from the PII store after the response', async () => {
    const { env, routedPii, defaultPii, waitUntil, afterResponse, row, mapping } = setup();

    const started = performance.now();
    await createAuditLog(env, signIn('evt_sign_in'), { waitUntil });
    const requestPathMs = performance.now() - started;

    // The request returned while the PII store still held every call: the event is written,
    // without the ID yet.
    expect(requestPathMs).toBeLessThan(250);
    expect(routedPii.calls.length).toBeLessThanOrEqual(1);
    expect(row('evt_sign_in')).toMatchObject({ anonymized_user_id: null });

    routedPii.release();
    await afterResponse();

    const anonymizedUserId = mapping(routedPii.db, 'user-1');
    expect(anonymizedUserId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(mapping(defaultPii.db, 'user-1')).toBeUndefined();
    expect(row('evt_sign_in')).toMatchObject({
      result: 'success',
      anonymized_user_id: anonymizedUserId,
      client_id: 'passkey-auth',
      session_id: await sessionRef('sess-secret-cookie-value'),
    });
    const details = row('evt_sign_in')!.details_json!;
    expect(details).not.toContain('user-1');
    expect(details).not.toContain('sess-secret-cookie-value');
    expect(JSON.parse(details)).toMatchObject({ method: 'passkey', source: 'legacy_audit_log' });
  });

  it('does not wait for the PII store without a waitUntil either', async () => {
    const { env, routedPii, row } = setup();
    // The store never answers during this test: an awaited call would hang it.
    await createAuditLog(env, signIn('evt_no_wait_until'));
    expect(row('evt_no_wait_until')).toMatchObject({ anonymized_user_id: null });
    routedPii.release();
  });

  it('uses a cached ID inline without touching the PII store', async () => {
    const { env, routedPii, waitUntil, afterResponse, row } = setup();
    routedPii.release();
    await createAuditLog(env, signIn('evt_first'), { waitUntil });
    await afterResponse();
    const callsAfterFirst = routedPii.calls.length;

    await createAuditLog(env, signIn('evt_second'), { waitUntil });

    // Written before the response, with the same ID, and no PII call made.
    expect(row('evt_second')?.anonymized_user_id).toBe(row('evt_first')?.anonymized_user_id);
    expect(routedPii.calls.length).toBe(callsAfterFirst);
    await afterResponse();
    expect(routedPii.calls.length).toBe(callsAfterFirst);
  });

  it('names an admin action on a user by the user, without the raw user ID', async () => {
    const { env, routedPii, waitUntil, afterResponse, row, mapping } = setup();

    const started = performance.now();
    await createAuditLog(
      env,
      {
        id: 'evt_user_update',
        tenantId: 'default',
        userId: 'admin-7',
        action: 'user.update',
        resource: 'user',
        resourceId: 'user-1',
        ipAddress: '203.0.113.9',
        userAgent: 'admin',
        severity: 'info',
        metadata: JSON.stringify({ fields: ['name'] }),
      },
      { waitUntil }
    );
    expect(performance.now() - started).toBeLessThan(250);

    // A fail-closed event: written before the response, without the ID and the raw user ID.
    expect(row('evt_user_update')).toMatchObject({ anonymized_user_id: null });
    expect(row('evt_user_update')!.details_json).not.toContain('user-1');

    routedPii.release();
    await afterResponse();
    expect(row('evt_user_update')?.anonymized_user_id).toBe(mapping(routedPii.db, 'user-1'));
  });

  it('adds no user to an event that names none (a failure before the user is known)', async () => {
    const { env, routedPii, waitUntil, afterResponse, row } = setup();
    await createAuditLog(
      env,
      {
        ...signIn('evt_passkey_failed'),
        action: 'auth.passkey.failed',
        metadata: JSON.stringify({ method: 'passkey', errorCode: 'credential_not_found' }),
      },
      { waitUntil }
    );
    routedPii.release();
    await afterResponse();

    expect(row('evt_passkey_failed')).toMatchObject({
      result: 'failure',
      anonymized_user_id: null,
    });
    expect(routedPii.calls).toEqual([]);
  });

  it('does not create a mapping for a deleted or anonymized user', async () => {
    const { env, routedPii, waitUntil, afterResponse, row, mapping } = setup();
    routedPii.db
      .prepare(
        `INSERT INTO users_pii_tombstone (id, tenant_id, deleted_at, retention_until)
         VALUES ('user-gone', 'default', 1, 9999999999999)`
      )
      .run();
    routedPii.release();

    await createAuditLog(env, signIn('evt_after_erasure', 'user-gone'), { waitUntil });
    await afterResponse();

    expect(mapping(routedPii.db, 'user-gone')).toBeUndefined();
    expect(row('evt_after_erasure')).toMatchObject({ anonymized_user_id: null });
    expect(getCachedAnonymizedUserId('default', 'user-gone')).toBeUndefined();
  });

  it('keeps an existing mapping of an erased user without creating another', async () => {
    const { env, routedPii, waitUntil, afterResponse, row } = setup();
    routedPii.db
      .prepare(
        `INSERT INTO user_anonymization_map (id, tenant_id, user_id, anonymized_user_id, created_at)
         VALUES ('m1', 'default', 'user-gone', 'anon-before-erasure', 1)`
      )
      .run();
    routedPii.db
      .prepare(
        `INSERT INTO users_pii_tombstone (id, tenant_id, deleted_at, retention_until)
         VALUES ('user-gone', 'default', 2, 9999999999999)`
      )
      .run();
    routedPii.release();

    await createAuditLog(env, signIn('evt_erased_known', 'user-gone'), { waitUntil });
    await afterResponse();

    expect(row('evt_erased_known')?.anonymized_user_id).toBe('anon-before-erasure');
  });

  it('records the event without a user when the ID names no account or the store fails', async () => {
    const { env, routedPii, waitUntil, afterResponse, row } = setup();
    routedPii.release();
    await createAuditLog(env, signIn('evt_no_account', 'admin-console-user'), { waitUntil });

    const failing = asAdapter({
      query: () => Promise.reject(new Error('pii_store_down')),
      queryOne: () => Promise.reject(new Error('pii_store_down')),
      execute: () => Promise.reject(new Error('pii_store_down')),
      batch: () => Promise.reject(new Error('pii_store_down')),
    } as unknown as DatabaseAdapter);
    accountRoutes.pii.set('user-down', failing);
    await createAuditLog(env, signIn('evt_store_down', 'user-down'), { waitUntil });
    await afterResponse();

    expect(row('evt_no_account')).toMatchObject({ result: 'success', anonymized_user_id: null });
    expect(row('evt_store_down')).toMatchObject({ result: 'success', anonymized_user_id: null });
  });

  it('keeps the user.anonymized hash and does not treat it as a user', async () => {
    const { env, routedPii, waitUntil, afterResponse, row } = setup();
    routedPii.release();
    const hash = 'a'.repeat(64);
    await createAuditLog(
      env,
      {
        id: 'evt_anonymized',
        tenantId: 'default',
        userId: 'admin-7',
        action: 'user.anonymized',
        resource: 'user',
        resourceId: hash,
        ipAddress: '203.0.113.9',
        userAgent: 'admin',
        severity: 'info',
        metadata: JSON.stringify({ reason_code: 'user_request' }),
      },
      { waitUntil }
    );
    await afterResponse();

    expect(JSON.parse(row('evt_anonymized')!.details_json!)).toMatchObject({ resourceId: hash });
    expect(routedPii.calls).toEqual([]);
  });
});

describe('event_log mirror: no raw user or session IDs in details', () => {
  it('keeps a session resource only as its digest', async () => {
    const { env, routedPii, waitUntil, afterResponse, row } = setup();
    routedPii.release();
    await createAuditLog(
      env,
      {
        id: 'evt_user_login',
        tenantId: 'default',
        userId: 'user-1',
        action: 'user.login',
        resource: 'session',
        resourceId: 'sess-secret-cookie-value',
        ipAddress: '203.0.113.9',
        userAgent: 'browser',
        severity: 'info',
        metadata: JSON.stringify({ method: 'passkey', passkey_id: 'pk-1' }),
      },
      { waitUntil }
    );
    await afterResponse();

    const stored = row('evt_user_login')!;
    expect(stored.details_json).not.toContain('sess-secret-cookie-value');
    expect(JSON.parse(stored.details_json!).resourceId).toBe(
      await sessionRef('sess-secret-cookie-value')
    );
    expect(stored.session_id).toBe(await sessionRef('sess-secret-cookie-value'));
    expect(stored.anonymized_user_id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('names the user of a SCIM user resource, without its raw ID', async () => {
    const { env, routedPii, waitUntil, afterResponse, row, mapping } = setup();
    routedPii.release();
    await createAuditLog(
      env,
      {
        id: 'evt_scim_patch',
        tenantId: 'default',
        userId: 'scim-service',
        action: 'scim.user.patch',
        resource: 'scim_user',
        resourceId: 'user-1',
        ipAddress: '203.0.113.9',
        userAgent: 'scim-client',
        severity: 'info',
        metadata: JSON.stringify({ operations: 1 }),
      },
      { waitUntil }
    );
    await afterResponse();

    expect(row('evt_scim_patch')?.anonymized_user_id).toBe(mapping(routedPii.db, 'user-1'));
    expect(row('evt_scim_patch')!.details_json).not.toContain('user-1');
  });

  it('treats the SCIM service actor as no user', async () => {
    const { env, routedPii, waitUntil, afterResponse, row } = setup();
    accountRoutes.pii.set('scim-service', routedPii.adapter);
    routedPii.release();
    await createAuditLog(
      env,
      {
        id: 'evt_scim_group',
        tenantId: 'default',
        userId: 'scim-service',
        action: 'scim.group.patch',
        resource: 'scim_group',
        resourceId: 'group-1',
        ipAddress: '203.0.113.9',
        userAgent: 'scim-client',
        severity: 'info',
        metadata: JSON.stringify({ operations: 1 }),
      },
      { waitUntil }
    );
    await afterResponse();

    expect(row('evt_scim_group')?.anonymized_user_id).toBeNull();
    expect(routedPii.calls).toEqual([]);
  });

  it('drops a session ID nested in event data', async () => {
    const { env, routedPii, waitUntil, afterResponse, row } = setup();
    routedPii.release();
    await createAuditLog(
      env,
      {
        ...signIn('evt_nested_session'),
        metadata: JSON.stringify({
          userId: 'user-1',
          context: { sessionId: 'sess-nested-cookie', steps: [{ session_id: 'sess-in-array' }] },
        }),
      },
      { waitUntil }
    );
    await afterResponse();

    const details = row('evt_nested_session')!.details_json!;
    expect(details).not.toContain('sess-nested-cookie');
    expect(details).not.toContain('sess-in-array');
  });

  it('does not let event data put a removed user resource ID back', async () => {
    const { env, routedPii, waitUntil, afterResponse, row } = setup();
    routedPii.release();
    await createAuditLog(
      env,
      {
        id: 'evt_resource_restore',
        tenantId: 'default',
        userId: 'admin-7',
        action: 'user.update',
        resource: 'user',
        resourceId: 'user-1',
        ipAddress: '203.0.113.9',
        userAgent: 'admin',
        severity: 'info',
        metadata: JSON.stringify({
          userId: 'user-1',
          resourceId: 'user-1',
          resource_id: 'user-1',
          from: 'subject:user-1',
          to: 'document:d1',
          actorId: 'user-1',
        }),
      },
      { waitUntil }
    );
    await afterResponse();

    const details = row('evt_resource_restore')!.details_json!;
    expect(details).not.toContain('user-1');
    expect(JSON.parse(details)).toMatchObject({ to: 'document:d1', resourceType: 'user' });
  });
});

describe('event_log mirror: a deleted mapping', () => {
  it('links new events to the old ID for at most the cache TTL when deleted elsewhere', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const { env, routedPii, waitUntil, afterResponse, row, mapping } = setup();
    routedPii.release();
    await createAuditLog(env, signIn('evt_before_deletion'), { waitUntil });
    await afterResponse();
    const before = mapping(routedPii.db, 'user-1');

    // Another isolate erases the user: tombstone first, then the mapping.
    routedPii.db
      .prepare(
        `INSERT INTO users_pii_tombstone (id, tenant_id, deleted_at, retention_until)
         VALUES ('user-1', 'default', 1, 9999999999999)`
      )
      .run();
    routedPii.db.prepare("DELETE FROM user_anonymization_map WHERE user_id = 'user-1'").run();

    vi.setSystemTime(1_000_000 + ANONYMIZED_USER_ID_CACHE_TTL_MS - 1);
    await createAuditLog(env, signIn('evt_within_ttl'), { waitUntil });
    await afterResponse();
    expect(row('evt_within_ttl')?.anonymized_user_id).toBe(before);

    vi.setSystemTime(1_000_000 + ANONYMIZED_USER_ID_CACHE_TTL_MS);
    await createAuditLog(env, signIn('evt_after_ttl'), { waitUntil });
    await afterResponse();
    expect(row('evt_after_ttl')?.anonymized_user_id).toBeNull();
    // The cached ID was never written back.
    expect(mapping(routedPii.db, 'user-1')).toBeUndefined();
  });

  it('drops the cached ID at once when this isolate deletes the mapping', async () => {
    const { env, routedPii, waitUntil, afterResponse, row } = setup();
    routedPii.release();
    await createAuditLog(env, signIn('evt_cached'), { waitUntil });
    await afterResponse();
    routedPii.db
      .prepare(
        `INSERT INTO users_pii_tombstone (id, tenant_id, deleted_at, retention_until)
         VALUES ('user-1', 'default', 1, 9999999999999)`
      )
      .run();
    await new AnonymizationService(routedPii.adapter).deleteMapping('default', 'user-1');

    await createAuditLog(env, signIn('evt_after_delete'), { waitUntil });
    await afterResponse();
    expect(row('evt_after_delete')?.anonymized_user_id).toBeNull();
  });
});

describe('anonymized user ID cache', () => {
  it('expires entries after the TTL', () => {
    cacheAnonymizedUserId('t', 'u', 'anon', 1_000);
    expect(getCachedAnonymizedUserId('t', 'u', 1_000 + ANONYMIZED_USER_ID_CACHE_TTL_MS - 1)).toBe(
      'anon'
    );
    expect(
      getCachedAnonymizedUserId('t', 'u', 1_000 + ANONYMIZED_USER_ID_CACHE_TTL_MS)
    ).toBeUndefined();
  });

  it('keys by tenant and user and drops the oldest entry past the bound', () => {
    cacheAnonymizedUserId('t1', 'u', 'anon-1', 0);
    expect(getCachedAnonymizedUserId('t2', 'u', 0)).toBeUndefined();
    for (let index = 0; index < ANONYMIZED_USER_ID_CACHE_MAX_ENTRIES; index += 1) {
      cacheAnonymizedUserId('t2', `u${index}`, `anon-${index}`, 0);
    }
    expect(anonymizedUserIdCacheSize()).toBe(ANONYMIZED_USER_ID_CACHE_MAX_ENTRIES);
    expect(getCachedAnonymizedUserId('t1', 'u', 0)).toBeUndefined();
    expect(getCachedAnonymizedUserId('t2', 'u0', 0)).toBe('anon-0');
  });
});

describe('sanitizeEventDetails user identifiers', () => {
  it('drops user identifier keys at any depth and keeps the rest', () => {
    expect(
      sanitizeEventDetails(
        {
          userId: 'user-1',
          user_id: 'user-1',
          sub: 'user-1',
          method: 'passkey',
          actorId: 'user-1',
          from: 'subject:user-1',
          members: ['user:user-2', 'group:g1'],
          target: { targetUserId: 'user-2', role: 'viewer', items: [{ subjectId: 'user-3' }] },
        },
        DEFAULT_PII_CONFIG
      )
    ).toEqual({
      method: 'passkey',
      members: ['group:g1'],
      target: { role: 'viewer', items: [{}] },
    });
  });
});
