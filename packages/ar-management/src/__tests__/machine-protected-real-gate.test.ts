import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readRenderedMigrationSql } from '../../../../test/helpers/migration-source.mjs';

// Only the audit write is replaced. The step-up gate is the real one: requirements and receipts
// are really issued and consumed (against an in-memory challenge store).
vi.mock('../admin-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../admin-shared')>();
  return { ...actual, writeAdminAuditLog: vi.fn(async () => undefined) };
});

import {
  adminAuthMiddleware,
  issueAdminStepUpReceipt,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';
import { machineAccessRouter } from '../routes/admin-management/machine-access';
import { GLOBAL_SUPER_ADMIN, TENANT, setupApp, signIn } from './helpers/admin-authority-fixture';

/**
 * One request that needs two step-ups (the grant's and the protected tenant's) takes ONE receipt,
 * bound to both operations. These run the real gate end to end.
 */

const PROTECTED = 'tenant-prot';
const OTHER = 'tenant-b';
const PUBLIC_JWK = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
const MGMT = '/api/admin/machine-access/principals';

function challengeStore() {
  interface Row {
    id: string;
    ttl?: number;
    consumed: boolean;
    expiresAt: number;
    metadata?: unknown;
  }
  const rows = new Map<string, Row>();
  const stub = {
    storeChallengeRpc: async (request: Omit<Row, 'consumed' | 'expiresAt'>) => {
      rows.set(request.id, {
        ...request,
        consumed: false,
        expiresAt: Date.now() + (request.ttl ?? 300) * 1000,
      });
    },
    getChallengeRpc: async (id: string) => rows.get(id) ?? null,
    consumeChallengeRpc: async ({ id }: { id: string }) => {
      const row = rows.get(id);
      if (!row || row.consumed) throw new Error('consumed');
      row.consumed = true;
      return { metadata: row.metadata };
    },
  };
  return { idFromName: (name: string) => name, get: () => stub };
}

function setup(extraEnv: Record<string, unknown> = {}) {
  const env = {
    MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: PROTECTED,
    CHALLENGE_STORE: challengeStore(),
    ...extraEnv,
  };
  const context = setupApp((app) => {
    app.use('/api/admin/*', async (c, next) => {
      const header = c.req.header('X-Tenant-Id');
      if (header) (c as unknown as { set(k: string, v: unknown): void }).set('tenantId', header);
      await next();
    });
    app.use('/api/admin/*', adminAuthMiddleware({ plane: 'tenant' }));
    app.route('/api/admin/machine-access', machineAccessRouter);
  }, env);
  // Passkey and second-factor evidence on the sessions (the fixture schema predates them).
  const root = resolve(__dirname, '../../../..');
  for (const file of ['003_admin_session_passkey_evidence.sql', '004_admin_second_factors.sql']) {
    context.db.exec(readRenderedMigrationSql(resolve(root, 'migrations/admin/d1/'), file));
  }
  const human = signIn(context.db, GLOBAL_SUPER_ADMIN);
  const now = Date.now();
  context.db
    .prepare(
      `INSERT INTO admin_second_factors (id, admin_user_id, kind, credential_id, public_key, created_at)
       VALUES ('sf-1', ?, 'webauthn_credential', 'cred-1', 'cGs=', ?)`
    )
    .run(human.userId, now);
  context.db
    .prepare(
      `UPDATE admin_sessions SET mfa_verified = 1, passkey_verified_at = ?, second_factor_id = 'sf-1',
         second_factor_verified_at = ? WHERE admin_user_id = ?`
    )
    .run(now, now, human.userId);

  const addPrincipal = (type: string, scopes: Array<string | null>) => {
    const id = `amp_${Math.random().toString(36).slice(2, 10)}`;
    context.db
      .prepare(
        `INSERT INTO admin_machine_principals (id, client_id, display_name, principal_type, status,
           default_audience, token_ttl_seconds, created_at, updated_at)
         VALUES (?, ?, 'P', ?, 'active', 'authrim:admin-api', 600, ?, ?)`
      )
      .run(id, `client-${id}`, type, now, now);
    context.db
      .prepare(
        `INSERT INTO admin_machine_credentials (id, principal_id, kid, public_jwk_json, alg, display_name,
           status, created_at, updated_at) VALUES (?, ?, ?, ?, 'ES256', 'K', 'active', ?, ?)`
      )
      .run(`amk_${id}`, id, `kid-${id}`, JSON.stringify(PUBLIC_JWK), now, now);
    context.db
      .prepare(
        `INSERT INTO admin_machine_principal_permissions (principal_id, permission, created_at)
         VALUES (?, 'admin:machine_access:read', ?)`
      )
      .run(id, now);
    for (const scope of scopes) {
      context.db
        .prepare(
          `INSERT INTO admin_machine_principal_tenant_scopes (principal_id, scope_mode, tenant_id, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(id, scope === null ? 'all' : 'allow', scope, now);
    }
    return { id, credentialId: `amk_${id}` };
  };

  const adminEnv = () => ({ DB_ADMIN: context.adapter, ...env }) as unknown as Env;
  const authOf = async () =>
    (await context.call(human.cookie, 'GET', '/probe/x')).json as unknown as AdminAuthContext;
  /** Asks for the operation, receives the requirement, and issues the receipt for it. */
  const receiptFor = async (method: string, path: string, body?: unknown) => {
    const first = await context.call(human.cookie, method, path, body);
    expect(first.status).toBe(403);
    expect(first.json.error).toBe('step_up_required');
    const issued = await issueAdminStepUpReceipt(adminEnv(), {
      stepUpId: first.json.step_up_id as string,
      auth: await authOf(),
      isSecondFactorActive: async () => true,
    });
    return issued.receipt;
  };
  const withReceipt = (receipt: string, method: string, path: string, body?: unknown) =>
    context.call(human.cookie, method, path, body, { 'authrim-step-up-receipt': receipt });
  const principalCount = () =>
    (
      context.db.prepare('SELECT COUNT(*) AS n FROM admin_machine_principals').get() as {
        n: number;
      }
    ).n;
  return { ...context, human, addPrincipal, receiptFor, withReceipt, principalCount };
}

const principalBody = (overrides: Record<string, unknown> = {}) => ({
  client_id: `c-${Math.random().toString(36).slice(2)}`,
  display_name: 'New',
  principal_type: 'automation',
  permissions: ['admin:machine_access:read'],
  tenant_scopes: [{ scope_mode: 'allow', tenant_id: PROTECTED }],
  ...overrides,
});
const credentialBody = (overrides: Record<string, unknown> = {}) => ({
  kid: 'new-kid',
  display_name: 'Key',
  alg: 'ES256',
  public_jwk: PUBLIC_JWK,
  ...overrides,
});

describe('one receipt for a request that needs the grant step-up and the protected-tenant step-up', () => {
  it('creates a principal that names a protected tenant, with permissions, on one receipt', async () => {
    const t = setup();
    const body = principalBody();
    const receipt = await t.receiptFor('POST', MGMT, body);
    const created = await t.withReceipt(receipt, 'POST', MGMT, body);
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(t.principalCount()).toBe(1);
    // The receipt is spent: a second request with it asks again.
    const again = await t.withReceipt(receipt, 'POST', MGMT, principalBody());
    expect(again.status).toBe(403);
  });

  it('creates and rotates a credential of a platform principal on one receipt each', async () => {
    const t = setup();
    const platform = t.addPrincipal('setup_tool', [null]);
    const createPath = `${MGMT}/${platform.id}/credentials`;
    const create = credentialBody();
    const created = await t.withReceipt(
      await t.receiptFor('POST', createPath, create),
      'POST',
      createPath,
      create
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);

    const rotatePath = `${MGMT}/${platform.id}/credentials/${platform.credentialId}/rotate`;
    const rotate = credentialBody({ kid: 'rotated-kid' });
    const rotated = await t.withReceipt(
      await t.receiptFor('POST', rotatePath, rotate),
      'POST',
      rotatePath,
      rotate
    );
    expect(rotated.status, JSON.stringify(rotated.json)).toBe(201);
  });

  it('reaches a protected tenant by intersection the same way: a credential for all on a principal that names it', async () => {
    const t = setup();
    const principal = t.addPrincipal('automation', [PROTECTED]);
    const path = `${MGMT}/${principal.id}/credentials`;
    const body = credentialBody({ tenant_scopes: [{ scope_mode: 'all' }] });
    const receipt = await t.receiptFor('POST', path, body);
    // A receipt for the grant's step-up alone (a credential that reaches no protected tenant, on
    // another principal) does not carry the protected grant.
    const plain = t.addPrincipal('automation', [OTHER]);
    const plainPath = `${MGMT}/${plain.id}/credentials`;
    const plainBody = credentialBody({ kid: 'plain-kid' });
    const plainReceipt = await t.receiptFor('POST', plainPath, plainBody);
    const refused = await t.withReceipt(plainReceipt, 'POST', path, body);
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe('step_up_required');
    // The one that covers both goes through.
    const created = await t.withReceipt(receipt, 'POST', path, body);
    expect(created.status, JSON.stringify(created.json)).toBe(201);
  });

  it('refuses a receipt that covers only one of the two operations', async () => {
    const t = setup();
    // The grant's step-up alone: a principal for an unprotected tenant with permissions.
    const grantOnly = principalBody({ tenant_scopes: [{ scope_mode: 'allow', tenant_id: OTHER }] });
    const grantReceipt = await t.receiptFor('POST', MGMT, grantOnly);
    // The protected grant alone: a platform principal without permissions.
    const protectedOnly = principalBody({
      principal_type: 'setup_tool',
      permissions: [],
      tenant_scopes: [{ scope_mode: 'all' }],
    });
    const protectedReceipt = await t.receiptFor('POST', MGMT, protectedOnly);

    const both = principalBody();
    for (const receipt of [grantReceipt, protectedReceipt]) {
      const refused = await t.withReceipt(receipt, 'POST', MGMT, both);
      expect(refused.status).toBe(403);
      expect(refused.json.error).toBe('step_up_required');
    }
    expect(t.principalCount()).toBe(0);
    // Each of them works for what it was issued for.
    // (Receipts are spent by the refused attempts above: ask again.)
    const own = await t.withReceipt(
      await t.receiptFor('POST', MGMT, protectedOnly),
      'POST',
      MGMT,
      protectedOnly
    );
    expect(own.status, JSON.stringify(own.json)).toBe(201);
  });

  it('is not asked for anything extra for an unprotected tenant', async () => {
    const t = setup();
    const body = principalBody({ tenant_scopes: [{ scope_mode: 'allow', tenant_id: OTHER }] });
    const created = await t.withReceipt(await t.receiptFor('POST', MGMT, body), 'POST', MGMT, body);
    expect(created.status).toBe(201);
    expect(TENANT).toBeDefined();
  });
});

describe('all together with a named protected tenant, with step-up enforcement switched off', () => {
  const OFF = { ADMIN_STEP_UP_ENFORCED: 'false' };
  const own = (t: ReturnType<typeof setup>, credentialId: string, tenant: string) =>
    t.db
      .prepare(
        `INSERT INTO admin_machine_credential_tenant_scopes (credential_id, scope_mode, tenant_id, created_at)
         VALUES (?, 'allow', ?, ?)`
      )
      .run(credentialId, tenant, Date.now());
  const mixed = [{ scope_mode: 'all' }, { scope_mode: 'allow', tenant_id: PROTECTED }];

  it('creating a principal with all and the protected tenant needs the always-enforced receipt', async () => {
    const t = setup(OFF);
    const body = principalBody({ tenant_scopes: mixed });
    const first = await t.call(t.human.cookie, 'POST', MGMT, body);
    expect(first.status).toBe(403);
    expect(first.json.error).toBe('step_up_required');
    expect(t.principalCount()).toBe(0);
    const created = await t.withReceipt(await t.receiptFor('POST', MGMT, body), 'POST', MGMT, body);
    expect(created.status, JSON.stringify(created.json)).toBe(201);
  });

  it('creating, updating and rotating a credential that reaches the protected tenant next to all each need it', async () => {
    const t = setup(OFF);
    const principal = t.addPrincipal('automation', [null, PROTECTED]);
    const base = `${MGMT}/${principal.id}/credentials`;

    const create = credentialBody({ kid: 'mixed-create', tenant_scopes: mixed });
    const noReceipt = await t.call(t.human.cookie, 'POST', base, create);
    expect(noReceipt.status).toBe(403);
    expect(noReceipt.json.error).toBe('step_up_required');
    const created = await t.withReceipt(
      await t.receiptFor('POST', base, create),
      'POST',
      base,
      create
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);

    // Update: the key was limited to another tenant; making it reach the protected one is a grant.
    own(t, principal.credentialId, OTHER);
    const path = `${base}/${principal.credentialId}`;
    const update = { tenant_scopes: mixed };
    const updateNo = await t.call(t.human.cookie, 'PATCH', path, update);
    expect(updateNo.status).toBe(403);
    expect(updateNo.json.error).toBe('step_up_required');
    const updated = await t.withReceipt(
      await t.receiptFor('PATCH', path, update),
      'PATCH',
      path,
      update
    );
    expect(updated.status, JSON.stringify(updated.json)).toBe(200);

    // Rotate: a new key is a new grant.
    const rotatePath = `${path}/rotate`;
    const rotate = credentialBody({ kid: 'mixed-rotate', tenant_scopes: mixed });
    const rotateNo = await t.call(t.human.cookie, 'POST', rotatePath, rotate);
    expect(rotateNo.status).toBe(403);
    expect(rotateNo.json.error).toBe('step_up_required');
    const rotated = await t.withReceipt(
      await t.receiptFor('POST', rotatePath, rotate),
      'POST',
      rotatePath,
      rotate
    );
    expect(rotated.status, JSON.stringify(rotated.json)).toBe(201);
  });

  it('renaming and revoking stay free with enforcement off', async () => {
    const t = setup(OFF);
    const principal = t.addPrincipal('automation', [null, PROTECTED]);
    expect(
      (await t.call(t.human.cookie, 'PATCH', `${MGMT}/${principal.id}`, { display_name: 'R' }))
        .status
    ).toBe(200);
    expect(
      (
        await t.call(
          t.human.cookie,
          'PATCH',
          `${MGMT}/${principal.id}/credentials/${principal.credentialId}`,
          { status: 'revoked' }
        )
      ).status
    ).toBe(200);
  });

  it('changing a principal so that an EXISTING key reaches the protected tenant is a grant', async () => {
    const t = setup(OFF);
    // The principal reaches nothing, its key names the protected tenant: it reaches nothing now.
    const principal = t.addPrincipal('automation', []);
    own(t, principal.credentialId, PROTECTED);
    const path = `${MGMT}/${principal.id}`;
    const widen = { tenant_scopes: [{ scope_mode: 'all' }] };
    const refused = await t.call(t.human.cookie, 'PATCH', path, widen);
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe('step_up_required');
    const done = await t.withReceipt(
      await t.receiptFor('PATCH', path, widen),
      'PATCH',
      path,
      widen
    );
    expect(done.status, JSON.stringify(done.json)).toBe(200);
  });

  it('enabling a principal whose key names the protected tenant is a grant', async () => {
    const t = setup(OFF);
    const principal = t.addPrincipal('automation', [null]);
    own(t, principal.credentialId, PROTECTED);
    t.db
      .prepare("UPDATE admin_machine_principals SET status = 'disabled' WHERE id = ?")
      .run(principal.id);
    const path = `${MGMT}/${principal.id}/enable`;
    const refused = await t.call(t.human.cookie, 'POST', path);
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe('step_up_required');
    const done = await t.withReceipt(await t.receiptFor('POST', path), 'POST', path);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
  });

  it('widening what a principal that already reaches the protected tenant can do is a grant', async () => {
    const t = setup(OFF);
    const principal = t.addPrincipal('automation', [PROTECTED]);
    const path = `${MGMT}/${principal.id}`;
    const more = { permissions: ['admin:machine_access:read', 'admin:users:read'] };
    const refused = await t.call(t.human.cookie, 'PATCH', path, more);
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe('step_up_required');
    const done = await t.withReceipt(await t.receiptFor('PATCH', path, more), 'PATCH', path, more);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
  });

  it('extending or removing the expiry of a key that reaches the protected tenant is a grant; shortening is not', async () => {
    const t = setup(OFF);
    const principal = t.addPrincipal('automation', [PROTECTED]);
    const soon = Date.now() + 3_600_000;
    t.db
      .prepare('UPDATE admin_machine_credentials SET expires_at = ? WHERE id = ?')
      .run(soon, principal.credentialId);
    const path = `${MGMT}/${principal.id}/credentials/${principal.credentialId}`;
    // Shortening needs nothing.
    const shorter = await t.call(t.human.cookie, 'PATCH', path, { expires_at: soon - 60_000 });
    expect(shorter.status, JSON.stringify(shorter.json)).toBe(200);
    // Removing it is a grant.
    const remove = { expires_at: null };
    const refused = await t.call(t.human.cookie, 'PATCH', path, remove);
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe('step_up_required');
    const done = await t.withReceipt(
      await t.receiptFor('PATCH', path, remove),
      'PATCH',
      path,
      remove
    );
    expect(done.status, JSON.stringify(done.json)).toBe(200);
  });

  it('widening something that does not reach a protected tenant needs no protected grant', async () => {
    const t = setup(OFF);
    const principal = t.addPrincipal('automation', [OTHER]);
    const path = `${MGMT}/${principal.id}`;
    const more = { permissions: ['admin:machine_access:read', 'admin:users:read'] };
    // With enforcement off the grant's own step-up is off too: nothing is asked.
    expect((await t.call(t.human.cookie, 'PATCH', path, more)).status).toBe(200);
  });

  const ownAll = (t: ReturnType<typeof setup>, credentialId: string) =>
    t.db
      .prepare(
        `INSERT INTO admin_machine_credential_tenant_scopes (credential_id, scope_mode, tenant_id, created_at)
         VALUES (?, 'all', NULL, ?)`
      )
      .run(credentialId, Date.now());

  it('removing all from a principal that already names the protected tenant lets an existing key reach it: a grant', async () => {
    const t = setup(OFF);
    // The principal names the protected tenant next to all; its key is limited to all, whose
    // reach on the protected tenant is refused (the key does not name it). The principal's own
    // naming and the key's reach are two things.
    const principal = t.addPrincipal('automation', [null, PROTECTED]);
    ownAll(t, principal.credentialId);
    const path = `${MGMT}/${principal.id}`;
    const narrow = { tenant_scopes: [{ scope_mode: 'allow', tenant_id: PROTECTED }] };
    const refused = await t.call(t.human.cookie, 'PATCH', path, narrow);
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe('step_up_required');
    const done = await t.withReceipt(
      await t.receiptFor('PATCH', path, narrow),
      'PATCH',
      path,
      narrow
    );
    expect(done.status, JSON.stringify(done.json)).toBe(200);
  });

  it('the mirror: limiting a key to the protected tenant on a principal that names it next to all is a grant', async () => {
    const t = setup(OFF);
    const principal = t.addPrincipal('automation', [null, PROTECTED]);
    ownAll(t, principal.credentialId);
    const path = `${MGMT}/${principal.id}/credentials/${principal.credentialId}`;
    const narrow = { tenant_scopes: [{ scope_mode: 'allow', tenant_id: PROTECTED }] };
    const refused = await t.call(t.human.cookie, 'PATCH', path, narrow);
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe('step_up_required');
    const done = await t.withReceipt(
      await t.receiptFor('PATCH', path, narrow),
      'PATCH',
      path,
      narrow
    );
    expect(done.status, JSON.stringify(done.json)).toBe(200);
  });

  it('a change that leaves every key reaching what it reached is free', async () => {
    const t = setup(OFF);
    const principal = t.addPrincipal('automation', [null, PROTECTED]);
    ownAll(t, principal.credentialId);
    // Narrowing to nothing, or renaming: no key reaches anything new.
    const path = `${MGMT}/${principal.id}`;
    expect(
      (await t.call(t.human.cookie, 'PATCH', path, { tenant_scopes: [{ scope_mode: 'none' }] }))
        .status
    ).toBe(200);
  });
});

describe('the same while the setting cannot be read (every tenant is protected)', () => {
  const failingKv = {
    get: async (key: string) => {
      if (key === 'settings:platform:machine-access') throw new Error('KV unavailable');
      return null;
    },
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true }),
  };

  it('a key that starts to reach any tenant by a principal change needs the always-enforced step-up', async () => {
    const t = setup({ ADMIN_STEP_UP_ENFORCED: 'false', SETTINGS: failingKv });
    const principal = t.addPrincipal('automation', [null, OTHER]);
    t.db
      .prepare(
        `INSERT INTO admin_machine_credential_tenant_scopes (credential_id, scope_mode, tenant_id, created_at)
         VALUES (?, 'all', NULL, ?)`
      )
      .run(principal.credentialId, Date.now());
    const path = `${MGMT}/${principal.id}`;
    const narrow = { tenant_scopes: [{ scope_mode: 'allow', tenant_id: OTHER }] };
    const refused = await t.call(t.human.cookie, 'PATCH', path, narrow);
    expect(refused.status).toBe(403);
    expect(refused.json.error).toBe('step_up_required');
    const done = await t.withReceipt(
      await t.receiptFor('PATCH', path, narrow),
      'PATCH',
      path,
      narrow
    );
    expect(done.status, JSON.stringify(done.json)).toBe(200);
  });
});

describe('a principal change and a credential change under it decided against each other', () => {
  const OFF = { ADMIN_STEP_UP_ENFORCED: 'false' };
  const scopeRows = (t: ReturnType<typeof setup>, id: string) =>
    (
      t.db
        .prepare(
          'SELECT scope_mode, tenant_id FROM admin_machine_principal_tenant_scopes WHERE principal_id = ? ORDER BY scope_mode'
        )
        .all(id) as Array<{ scope_mode: string; tenant_id: string | null }>
    ).map((row) => `${row.scope_mode}:${row.tenant_id ?? ''}`);
  const keyCount = (t: ReturnType<typeof setup>, id: string) =>
    (
      t.db
        .prepare('SELECT COUNT(*) AS n FROM admin_machine_credentials WHERE principal_id = ?')
        .get(id) as { n: number }
    ).n;
  const newKey = (kid: string) => credentialBody({ kid, tenant_scopes: [{ scope_mode: 'all' }] });

  it('a principal patch decided before a key was created under it is not saved (409), so the key cannot end up reaching the protected tenant unasked', async () => {
    const t = setup(OFF);
    // The principal names the protected tenant next to all and has no key yet.
    const principal = t.addPrincipal('automation', [null, PROTECTED]);
    t.db.prepare('DELETE FROM admin_machine_credentials WHERE principal_id = ?').run(principal.id);
    const path = `${MGMT}/${principal.id}`;
    // A: narrow the principal to the protected tenant only. Its reach decision (no key, so nothing
    // newly reached) is made first; before it saves, B creates a key limited to all.
    let created: { status: number } | undefined;
    t.hooks.beforeBatch = async () => {
      created = await t.call(t.human.cookie, 'POST', `${path}/credentials`, newKey('key-b'));
    };
    const patched = await t.call(t.human.cookie, 'PATCH', path, {
      tenant_scopes: [{ scope_mode: 'allow', tenant_id: PROTECTED }],
    });
    expect(created?.status).toBe(201);
    expect(patched.status).toBe(409);
    // A was not saved: the principal still has all and the protected tenant.
    expect(scopeRows(t, principal.id)).toEqual(['all:', `allow:${PROTECTED}`]);
    // Retried, it is decided against the key that exists now: that key would newly reach the
    // protected tenant, so the always-enforced step-up is asked.
    const retry = await t.call(t.human.cookie, 'PATCH', path, {
      tenant_scopes: [{ scope_mode: 'allow', tenant_id: PROTECTED }],
    });
    expect(retry.status).toBe(403);
    expect(retry.json.error).toBe('step_up_required');
  });

  it('the mirror: a key created against a principal scope that was patched meanwhile is not saved (409)', async () => {
    const t = setup(OFF);
    const principal = t.addPrincipal('automation', [null, PROTECTED]);
    t.db.prepare('DELETE FROM admin_machine_credentials WHERE principal_id = ?').run(principal.id);
    const path = `${MGMT}/${principal.id}`;
    let patched: { status: number } | undefined;
    t.hooks.beforeBatch = async () => {
      patched = await t.call(t.human.cookie, 'PATCH', path, {
        tenant_scopes: [{ scope_mode: 'allow', tenant_id: PROTECTED }],
      });
    };
    const created = await t.call(t.human.cookie, 'POST', `${path}/credentials`, newKey('key-c'));
    expect(patched?.status).toBe(200);
    expect(created.status).toBe(409);
    expect(keyCount(t, principal.id)).toBe(0);
  });

  it('a key changed under a principal moves the principal revision, so its own writes keep working when nothing raced', async () => {
    const t = setup(OFF);
    const principal = t.addPrincipal('automation', [null, PROTECTED]);
    const path = `${MGMT}/${principal.id}`;
    expect(
      (await t.call(t.human.cookie, 'POST', `${path}/credentials`, newKey('key-d'))).status
    ).toBe(201);
    expect((await t.call(t.human.cookie, 'PATCH', path, { display_name: 'Renamed' })).status).toBe(
      200
    );
  });

  it('a key revoked and revived between a principal patch’s decision and its save does not restore the old revision (409)', async () => {
    const t = setup(OFF);
    // The principal names the protected tenant next to all; its key is limited to all (so it does
    // not reach the protected tenant now).
    const principal = t.addPrincipal('automation', [null, PROTECTED]);
    t.db
      .prepare(
        `INSERT INTO admin_machine_credential_tenant_scopes (credential_id, scope_mode, tenant_id, created_at)
         VALUES (?, 'all', NULL, ?)`
      )
      .run(principal.credentialId, Date.now());
    const path = `${MGMT}/${principal.id}`;
    const keyPath = `${path}/credentials/${principal.credentialId}`;
    // A reads the principal's revision (the key is active), then its decision reads the keys: the
    // key was revoked meanwhile, so the decision ignores it ("nothing newly reached"). Before A
    // saves, the key is revived: the same revision as the one A read, were it not for the key's
    // own `updated_at`.
    let revoked: { status: number } | undefined;
    let revived: { status: number } | undefined;
    t.hooks.beforeQuery = {
      match: /FROM admin_machine_credentials\s+WHERE principal_id = \?\s+ORDER BY created_at DESC/,
      run: async () => {
        revoked = await t.call(t.human.cookie, 'PATCH', keyPath, { status: 'revoked' });
        // Armed only now, so it runs before A's own batch and not before the revoke's.
        t.hooks.beforeBatch = async () => {
          revived = await t.call(t.human.cookie, 'PATCH', keyPath, { status: 'active' });
        };
      },
    };
    const patched = await t.call(t.human.cookie, 'PATCH', path, {
      tenant_scopes: [{ scope_mode: 'allow', tenant_id: PROTECTED }],
    });
    expect(revoked?.status).toBe(200);
    expect(revived?.status).toBe(200);
    expect(patched.status).toBe(409);
    expect(scopeRows(t, principal.id)).toEqual(['all:', `allow:${PROTECTED}`]);
  });
});
