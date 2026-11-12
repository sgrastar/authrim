import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AdminAuthContext, DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from './test-sqlite';

/**
 * The platform tenant-domain-mapping handlers on a real SQLite table, with real domain hashing.
 * Verification must be for the domain the mapping was created for.
 */
interface State {
  db: unknown;
}
const state = vi.hoisted((): State => ({ db: null }));
const dns = vi.hoisted(() => ({ verify: vi.fn() }));
const audit = vi.hoisted(() => ({ log: vi.fn() }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const database = () => state.db as SQLiteDatabase;
  const adapter = {
    query: async (sql: string, params: SQLInputValue[] = []) =>
      database()
        .prepare(sql)
        .all(...params),
    queryOne: async (sql: string, params: SQLInputValue[] = []) =>
      database()
        .prepare(sql)
        .get(...params) ?? null,
    execute: async (sql: string, params: SQLInputValue[] = []) => ({
      success: true,
      rowsAffected: Number(
        database()
          .prepare(sql)
          .run(...params).changes
      ),
    }),
  } as unknown as DatabaseAdapter;
  return {
    ...actual,
    resolveOptionalCoreAdapterFromHono: () => adapter,
    getEmailDomainHashConfig: async () => ({
      current_version: 2,
      secrets: { 1: 'secret-one', 2: 'secret-two' },
      deprecated_versions: [],
      migration_in_progress: false,
    }),
    verifyDomainDnsTxt: dns.verify,
    createAuditLogFromContext: audit.log,
  };
});

import {
  confirmTenantDomainVerificationHandler,
  createTenantDomainMappingHandler,
  initiateTenantDomainVerificationHandler,
} from '../admin-tenant-domain-mappings';

const AUTH: AdminAuthContext = {
  userId: 'human-1',
  authMethod: 'bearer',
  actorId: 'actor-7',
  roles: ['ar_super_admin'],
  globalRoles: ['ar_super_admin'],
  tenantScope: ['*'],
};

function open(): SQLiteDatabase {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY);
    CREATE TABLE tenant_domain_mappings (
      id TEXT PRIMARY KEY, domain_hash TEXT NOT NULL, hash_version INTEGER NOT NULL,
      tenant_id TEXT NOT NULL, priority INTEGER, is_active INTEGER, active_domain_hash TEXT,
      verified INTEGER, verification_token TEXT, verification_expires_at INTEGER,
      created_by TEXT, created_at INTEGER, updated_at INTEGER
    );
  `);
  db.prepare("INSERT INTO tenants (id) VALUES ('tenant-a')").run();
  return db;
}

async function post(path: string, handler: (c: never) => Promise<Response>, body: unknown) {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>();
  app.use('*', async (c, next) => {
    c.set('adminAuth', AUTH);
    c.set('tenantId' as never, 'default' as never);
    await next();
  });
  app.post(path, (c) => handler(c as never));
  const response = await app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

const create = (domain: string) =>
  post('/m', createTenantDomainMappingHandler as never, { domain, tenant_id: 'tenant-a' });
const initiate = (id: string, domain: string) =>
  post('/v', initiateTenantDomainVerificationHandler as never, { id, domain });
const confirm = (id: string, domain: string) =>
  post('/c', confirmTenantDomainVerificationHandler as never, { id, domain });
const stored = (id: string) =>
  (state.db as SQLiteDatabase)
    .prepare(
      'SELECT verified, verification_token, created_by FROM tenant_domain_mappings WHERE id = ?'
    )
    .get(id) as { verified: number; verification_token: string | null; created_by: string | null };

describe('tenant domain mapping verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.db = open();
    dns.verify.mockResolvedValue(true);
  });

  it('records the caller as the creator', async () => {
    const created = await create('example.com');
    expect(created.status).toBe(201);
    expect(stored(created.body.id as string).created_by).toBe('actor-7');
  });

  it('issues a challenge only for the mapping’s own domain', async () => {
    const id = (await create('example.com')).body.id as string;

    const other = await initiate(id, 'attacker.example.org');
    expect(other.status).toBe(400);
    expect(stored(id).verification_token).toBeNull();

    const own = await initiate(id, 'Example.COM ');
    expect(own.status).toBe(200);
    expect(own.body.dns_record_name).toContain('example.com');
    expect(stored(id).verification_token).not.toBeNull();
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      'tenant_domain_mapping.verification_initiated',
      'tenant_domain_mapping',
      id,
      { domain: 'example.com' }
    );
  });

  it('does not verify a mapping for another domain, and looks nothing up', async () => {
    const id = (await create('example.com')).body.id as string;
    await initiate(id, 'example.com');

    for (const domain of ['attacker.example.org', 'sub.example.com', 'not a domain', '']) {
      const result = await confirm(id, domain);
      expect(result.status).toBe(400);
    }
    expect(dns.verify).not.toHaveBeenCalled();
    expect(stored(id).verified).toBe(0);

    const own = await confirm(id, 'example.com');
    expect(own.status).toBe(200);
    expect(stored(id)).toMatchObject({ verified: 1, verification_token: null });
    expect(dns.verify).toHaveBeenCalledWith('example.com', expect.any(String));
  });

  it('hashes with the version of the mapping, not the current one', async () => {
    const id = (await create('example.com')).body.id as string;
    // The mapping predates the current secret: its hash is the version-1 one.
    const { generateEmailDomainHash } = await import('@authrim/ar-lib-core');
    const oldHash = await generateEmailDomainHash('user@example.com', 'secret-one');
    (state.db as SQLiteDatabase)
      .prepare('UPDATE tenant_domain_mappings SET domain_hash = ?, hash_version = 1 WHERE id = ?')
      .run(oldHash, id);
    expect((await initiate(id, 'example.com')).status).toBe(200);
    expect((await initiate(id, 'other.com')).status).toBe(400);
  });
});
