import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  adminAuthMiddleware,
  hasAdminPermission,
  intersectMachinePermissionSets,
  resolveMachineTenantScope,
  type AdminMachineTenantScope,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from '../test-sqlite';

/**
 * A real Admin schema in SQLite, the real `adminAuthMiddleware`, and sessions for Admins with a
 * given mix of global and tenant assignments. The authority tests run the real routers on it, so
 * the roles and permissions that `adminAuth` adds up from all of an Admin's assignments are the
 * ones the routes see.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');

export function openAdminDatabase(): SQLiteDatabase {
  const db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(resolve(REPO_ROOT, 'migrations/admin/d1/001_0_4_0_admin_baseline.sql'), 'utf8')
      .replaceAll(
        '__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__',
        "(CAST(strftime('%s', 'now') AS INTEGER) * 1000)"
      )
      .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
      .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
  );
  db.exec(
    readFileSync(
      resolve(REPO_ROOT, 'migrations/admin/d1/050_identity_mapping_level_history.sql'),
      'utf8'
    )
  );
  return db;
}

/**
 * Lets a test run another request between a request's reads and its write: `beforeBatch` runs
 * once, right before the next `batch`, which is where the routes write.
 */
export interface AdapterHooks {
  beforeBatch?: () => Promise<void>;
  /** Runs once, right before the next read whose SQL matches, to put a change in the middle of a request's reads. */
  beforeQuery?: { match: RegExp; run: () => Promise<void> };
}

export function sqliteAdapter(db: SQLiteDatabase, hooks: AdapterHooks = {}): DatabaseAdapter {
  const bind = (params: unknown[] = []) => params.map((value) => (value ?? null) as SQLInputValue);
  const interleave = async (sql: string) => {
    const hook = hooks.beforeQuery;
    if (hook?.match.test(sql)) {
      hooks.beforeQuery = undefined;
      await hook.run();
    }
  };
  const adapter = {
    async query(sql: string, params?: unknown[]) {
      await interleave(sql);
      return db.prepare(sql).all(...bind(params));
    },
    async queryOne(sql: string, params?: unknown[]) {
      await interleave(sql);
      return db.prepare(sql).get(...bind(params)) ?? null;
    },
    async execute(sql: string, params?: unknown[]) {
      const result = db.prepare(sql).run(...bind(params));
      return { rowsAffected: Number(result.changes), success: true };
    },
    // D1 has no interactive transaction: the callback runs statement by statement and a failure
    // part-way leaves what was already written. Only `batch` is atomic.
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(adapter);
    },
    async batch(statements: Array<{ sql: string; params?: unknown[] }>) {
      const hook = hooks.beforeBatch;
      hooks.beforeBatch = undefined;
      await hook?.();
      db.exec('BEGIN');
      try {
        const results = [];
        for (const item of statements) {
          const result = db.prepare(item.sql).run(...bind(item.params));
          results.push({ rowsAffected: Number(result.changes), success: true });
        }
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async isHealthy() {
      return { healthy: true, latencyMs: 1, type: 'sqlite' };
    },
    getType: () => 'sqlite',
    async close() {},
  };
  return adapter as unknown as DatabaseAdapter;
}

export const TENANT = 'tenant-a';
let sessions = 0;

export type Assignment = { role: string; scope: 'global' | 'tenant' };

export const TENANT_SUPER_ADMIN: Assignment[] = [{ role: 'role_super_admin', scope: 'tenant' }];
export const GLOBAL_SUPER_ADMIN: Assignment[] = [{ role: 'role_super_admin', scope: 'global' }];
/** A global assignment that is only a viewer, with the wildcard held for the tenant alone. */
export const GLOBAL_VIEWER_TENANT_SUPER_ADMIN: Assignment[] = [
  { role: 'role_viewer', scope: 'global' },
  ...TENANT_SUPER_ADMIN,
];

/** An Admin of the tenant with these assignments, signed in; returns the session cookie. */
export function signIn(
  db: SQLiteDatabase,
  assignments: Assignment[]
): { userId: string; cookie: string } {
  sessions += 1;
  const userId = `admin-${sessions}`;
  const sessionId = `session-${sessions}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO admin_users (id, tenant_id, email, is_active, status, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'active', ?, ?)`
  ).run(userId, TENANT, `${userId}@example.test`, now, now);
  db.prepare(
    `INSERT INTO admin_sessions (id, tenant_id, admin_user_id, created_at, expires_at, mfa_verified)
     VALUES (?, ?, ?, ?, ?, 0)`
  ).run(sessionId, TENANT, userId, now, now + 3_600_000);
  assignments.forEach((assignment, index) => {
    db.prepare(
      `INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `${userId}-assignment-${index}`,
      TENANT,
      userId,
      assignment.role,
      assignment.scope,
      assignment.scope === 'tenant' ? TENANT : null,
      now
    );
  });
  return { userId, cookie: `authrim_admin_session=${sessionId}` };
}

/** A custom role of the tenant, written straight into the schema. */
export function insertRole(
  db: SQLiteDatabase,
  role: {
    id: string;
    name: string;
    permissions: string[];
    hierarchy: number;
    inheritsFrom?: string | null;
  }
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO admin_roles (id, tenant_id, name, permissions_json, hierarchy_level, role_type, is_system, inherits_from, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'custom', 0, ?, ?, ?)`
  ).run(
    role.id,
    TENANT,
    role.name,
    JSON.stringify(role.permissions),
    role.hierarchy,
    role.inheritsFrom ?? null,
    now,
    now
  );
}

export type Mount = (app: Hono<{ Bindings: Env }>) => void;

/** The routes under test, behind a fixed request tenant, on a fresh Admin schema. */
export function setupApp(mount: Mount, envExtras: Record<string, unknown> = {}) {
  const db = openAdminDatabase();
  const hooks: AdapterHooks = {};
  const adapter = sqliteAdapter(db, hooks);
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set(key: string, value: unknown): void }).set('tenantId', TENANT);
    await next();
  });
  mount(app);
  // What a session ends up with after its assignments are added up.
  app.use('/probe/*', adminAuthMiddleware({ plane: 'tenant' }));
  app.get('/probe/:tenant', (c) =>
    c.json((c as unknown as { get(key: string): unknown }).get('adminAuth') as object)
  );
  const send = async (
    credentials: Record<string, string>,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ) => {
    const response = await app.request(
      path,
      {
        method,
        headers: {
          'content-type': 'application/json',
          'X-Tenant-Id': TENANT,
          ...credentials,
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { DB_ADMIN: adapter, ...envExtras } as unknown as Env
    );
    const text = await response.text();
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text) as Record<string, any>;
    } catch {
      json = { raw: text };
    }
    return { status: response.status, json };
  };
  const call = (
    cookie: string,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ) => send({ Cookie: cookie }, method, path, body, headers);
  /** The same with an Admin API access token of a machine credential. */
  const callWithToken = (
    token: string,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ) => send({ Authorization: `Bearer ${token}` }, method, path, body, headers);
  return { db, adapter, app, call, callWithToken, hooks };
}

export const ISSUER_URL = 'https://test.example.com';

/**
 * Signs Admin API access tokens the way the token endpoint does for a stored machine credential:
 * the permissions are the principal's narrowed by the credential's, and the tenant scope is the
 * principal's narrowed by the credential's.
 */
export async function createTokenKit(
  /** The issuer the tokens carry; the request's own issuer when the app derives it from a base domain. */
  issuer: string = ISSUER_URL
) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'admin-token-key';
  publicJwk.alg = 'RS256';
  const env = { PUBLIC_JWK_JSON: JSON.stringify(publicJwk), ISSUER_URL: issuer };

  const scopesOf = (
    db: SQLiteDatabase,
    table: string,
    column: string,
    id: string
  ): AdminMachineTenantScope[] =>
    (
      db
        .prepare(`SELECT scope_mode, tenant_id FROM ${table} WHERE ${column} = ?`)
        .all(id) as Array<{ scope_mode: 'none' | 'all' | 'allow'; tenant_id: string | null }>
    ).map((row) => ({ scopeMode: row.scope_mode, tenantId: row.tenant_id }));
  const permissionsOf = (db: SQLiteDatabase, table: string, column: string, id: string) =>
    (
      db.prepare(`SELECT permission FROM ${table} WHERE ${column} = ?`).all(id) as Array<{
        permission: string;
      }>
    ).map((row) => row.permission);

  /** What the credential can do, as the token endpoint works it out from the stored rows. */
  function grantOf(db: SQLiteDatabase, credentialId: string) {
    const credential = db
      .prepare('SELECT principal_id FROM admin_machine_credentials WHERE id = ?')
      .get(credentialId) as { principal_id: string };
    const principalPermissions = permissionsOf(
      db,
      'admin_machine_principal_permissions',
      'principal_id',
      credential.principal_id
    );
    const credentialPermissions = permissionsOf(
      db,
      'admin_machine_credential_permissions',
      'credential_id',
      credentialId
    );
    return {
      principalId: credential.principal_id,
      permissions:
        credentialPermissions.length > 0
          ? intersectMachinePermissionSets(principalPermissions, credentialPermissions)
          : principalPermissions,
      tenantScope: resolveMachineTenantScope(
        scopesOf(
          db,
          'admin_machine_principal_tenant_scopes',
          'principal_id',
          credential.principal_id
        ),
        scopesOf(db, 'admin_machine_credential_tenant_scopes', 'credential_id', credentialId)
      ),
    };
  }

  async function mint(db: SQLiteDatabase, credentialId: string, requested: string[]) {
    const grant = grantOf(db, credentialId);
    const scope = requested.filter((entry) => hasAdminPermission(grant.permissions, entry));
    return new SignJWT({
      sub: `machine:${grant.principalId}`,
      aud: 'authrim:admin-api',
      actor_type: 'machine',
      actor_id: grant.principalId,
      credential_id: credentialId,
      client_auth_method: 'private_key_jwt',
      scope: scope.join(' '),
      tenant_scope: grant.tenantScope,
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'admin-token-key' })
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);
  }

  /** A token with exactly these claims, whatever the stored credential would give. */
  async function sign(
    db: SQLiteDatabase,
    credentialId: string,
    scope: string[],
    tenantScope: string[]
  ) {
    const grant = grantOf(db, credentialId);
    return new SignJWT({
      sub: `machine:${grant.principalId}`,
      aud: 'authrim:admin-api',
      actor_type: 'machine',
      actor_id: grant.principalId,
      credential_id: credentialId,
      client_auth_method: 'private_key_jwt',
      scope: scope.join(' '),
      tenant_scope: tenantScope,
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'admin-token-key' })
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);
  }

  return { env, mint, grantOf, sign };
}
