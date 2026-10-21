import { describe, expect, it } from 'vitest';
import { adminAuthMiddleware } from '@authrim/ar-lib-core';
import { controlPlaneOperationsRouter } from '../routes/admin-management/control-plane-operations';
import { loggingPoliciesRouter } from '../routes/admin-management/logging-control';
import { storageDestinationsRouter } from '../routes/admin-management/storage-destinations';
import { readReplicationRouter } from '../routes/admin-management/read-replication';
import {
  GLOBAL_SUPER_ADMIN,
  GLOBAL_VIEWER_TENANT_SUPER_ADMIN,
  TENANT,
  TENANT_SUPER_ADMIN,
  createTokenKit,
  setupApp,
  signIn,
} from './helpers/admin-authority-fixture';

/**
 * A machine token with a global tenant scope is not a platform administrator by that scope: the
 * platform-wide gates (read replication, the control plane, platform logging) ask it for the
 * permission of the operation, held for every tenant. The setup tool the bootstrap wrote keeps the
 * routes that name it.
 *
 * These run the real admin-auth middleware and the real routers on the real Admin schema, with
 * Admin API access tokens signed the way the token endpoint signs them.
 */

const PUBLIC_JWK = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
let sequence = 0;

async function setup() {
  const kit = await createTokenKit();
  const context = setupApp((app) => {
    app.use('/api/admin/*', adminAuthMiddleware({ plane: 'tenant' }));
    app.route('/api/admin/platform/read-replication', readReplicationRouter);
    app.route('/api/admin/platform/control-plane', controlPlaneOperationsRouter);
    app.route('/api/admin/logging-policies', loggingPoliciesRouter);
    app.route('/api/admin/storage-destinations', storageDestinationsRouter);
  }, kit.env);

  /** A token of a stored machine principal with these permissions and tenant scope. */
  const token = (
    permissions: string[],
    scope: 'all' | 'allow',
    identity: { id?: string; clientId?: string; principalType?: string } = {}
  ) => {
    sequence += 1;
    const now = Date.now();
    const id = identity.id ?? `amp_platform_${sequence}`;
    context.db
      .prepare(
        `INSERT INTO admin_machine_principals (id, client_id, display_name, principal_type, status,
           default_audience, token_ttl_seconds, created_at, updated_at)
         VALUES (?, ?, 'Machine', ?, 'active', 'authrim:admin-api', 600, ?, ?)`
      )
      .run(
        id,
        identity.clientId ?? `client-${id}`,
        identity.principalType ?? 'automation',
        now,
        now
      );
    context.db
      .prepare(
        `INSERT INTO admin_machine_credentials (id, principal_id, kid, public_jwk_json, alg, display_name,
           status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ES256', 'Key', 'active', ?, ?)`
      )
      .run(`amk_${id}`, id, `kid-${id}`, JSON.stringify(PUBLIC_JWK), now, now);
    for (const permission of permissions) {
      context.db
        .prepare(
          `INSERT INTO admin_machine_principal_permissions (principal_id, permission, created_at)
           VALUES (?, ?, ?)`
        )
        .run(id, permission, now);
    }
    context.db
      .prepare(
        `INSERT INTO admin_machine_principal_tenant_scopes (principal_id, scope_mode, tenant_id, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, scope, scope === 'allow' ? TENANT : null, now);
    return kit.mint(context.db, `amk_${id}`, permissions);
  };
  return { ...context, token };
}

const REPLICATION = '/api/admin/platform/read-replication';
const SHARD_CLEANUP = '/api/admin/platform/control-plane/shard-cleanup';
const CAPACITY = '/api/admin/platform/control-plane/capacity/requests';
const PLATFORM_LOGGING = '/api/admin/logging-policies/runtime/verify?scope_type=platform';

// Past the authority check the routes find no Control binding to ask: 503, not 403.
describe('read replication', () => {
  it('asks a machine token for the database connections permission, for every tenant', async () => {
    const context = await setup();
    const holds = await context.token(['admin:database_connections:read'], 'all');
    const otherPermission = await context.token(
      ['admin:control_plane:read', 'admin:logging:overview:read'],
      'all'
    );
    const limited = await context.token(['admin:database_connections:read'], 'allow');

    expect((await context.callWithToken(holds, 'GET', REPLICATION)).status).toBe(503);
    expect((await context.callWithToken(otherPermission, 'GET', REPLICATION)).status).toBe(403);
    expect((await context.callWithToken(limited, 'GET', REPLICATION)).status).toBe(403);
  });

  it('does not let the setup tool read it, as before', async () => {
    const context = await setup();
    const setupTool = await context.token(['admin:database_connections:read'], 'allow', {
      id: 'amp_authrim_setup',
      clientId: 'authrim-setup',
      principalType: 'setup_tool',
    });

    expect((await context.callWithToken(setupTool, 'GET', REPLICATION)).status).toBe(403);
  });

  it('keeps the platform administrator', async () => {
    const context = await setup();
    const admin = signIn(context.db, GLOBAL_SUPER_ADMIN);

    expect((await context.call(admin.cookie, 'GET', REPLICATION)).status).toBe(503);
  });
});

describe('the control plane', () => {
  it('asks a machine token for the control plane permission of the operation', async () => {
    const context = await setup();
    const reader = await context.token(['admin:control_plane:read'], 'all');
    const rotator = await context.token(['admin:control_plane:rotate'], 'all');
    const logging = await context.token(['admin:logging:overview:read'], 'all');
    const limited = await context.token(['admin:control_plane:read'], 'allow');

    const byReader = await context.callWithToken(reader, 'GET', SHARD_CLEANUP);
    const byRotator = await context.callWithToken(rotator, 'GET', SHARD_CLEANUP);
    const byLogging = await context.callWithToken(logging, 'GET', SHARD_CLEANUP);
    const byLimited = await context.callWithToken(limited, 'GET', SHARD_CLEANUP);

    expect(byReader.status).toBe(503);
    expect(byRotator.status).toBe(403);
    expect(byLogging.status).toBe(403);
    expect(byLimited.status).toBe(403);
  });

  it('asks a write for the provision permission, which a read does not give', async () => {
    const context = await setup();
    const reader = await context.token(['admin:control_plane:read'], 'all');
    const provisioner = await context.token(['admin:control_plane:provision'], 'all');
    const body = { profile: 'recommended', scope: 'shared_pool', tenantId: null };
    const headers = { 'Idempotency-Key': 'capacity-1' };

    const byReader = await context.callWithToken(reader, 'POST', CAPACITY, body, headers);
    const byProvisioner = await context.callWithToken(provisioner, 'POST', CAPACITY, body, headers);

    expect(byReader.json.error).toBe('CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
    // Past the platform check, a machine is still not a human actor for this operation.
    expect(byProvisioner.json.error).toBe('CONTROL_PLANE_HUMAN_ACTOR_REQUIRED');
  });

  it('keeps the setup tool on the routes that name it, and the platform administrator', async () => {
    const context = await setup();
    const setupTool = await context.token(['admin:control_plane:provision'], 'allow', {
      id: 'amp_authrim_setup',
      clientId: 'authrim-setup',
      principalType: 'setup_tool',
    });
    const admin = signIn(context.db, GLOBAL_SUPER_ADMIN);
    const body = { profile: 'recommended', scope: 'shared_pool', tenantId: null };
    const headers = { 'Idempotency-Key': 'capacity-2' };

    const bySetup = await context.callWithToken(setupTool, 'POST', CAPACITY, body, headers);
    const setupOnShardCleanup = await context.callWithToken(setupTool, 'GET', SHARD_CLEANUP);
    const byAdmin = await context.call(admin.cookie, 'GET', SHARD_CLEANUP);

    expect(bySetup.json.error).not.toBe('CONTROL_PLANE_PLATFORM_AUTHORITY_REQUIRED');
    expect(setupOnShardCleanup.status).toBe(403);
    expect(byAdmin.status).toBe(503);
  });
});

describe('platform logging', () => {
  it('asks a machine token for everything under admin, for every tenant, as a platform gate with no permission of its own', async () => {
    const context = await setup();
    const narrow = await context.token(['admin:logging:overview:read'], 'all');
    const everything = await context.token(['admin:*'], 'all');
    const limited = await context.token(['admin:*'], 'allow');

    const byNarrow = await context.callWithToken(narrow, 'GET', PLATFORM_LOGGING);
    const byEverything = await context.callWithToken(everything, 'GET', PLATFORM_LOGGING);
    const byLimited = await context.callWithToken(limited, 'GET', PLATFORM_LOGGING);

    expect(byNarrow.status).toBe(403);
    expect(byEverything.status).not.toBe(403);
    expect(byLimited.status).toBe(403);
  });

  it('keeps the platform administrator', async () => {
    const context = await setup();
    const admin = signIn(context.db, GLOBAL_SUPER_ADMIN);

    expect((await context.call(admin.cookie, 'GET', PLATFORM_LOGGING)).status).not.toBe(403);
  });
});

describe('a disabled principal', () => {
  it('has its tokens refused while disabled, with its credentials untouched', async () => {
    const context = await setup();
    const token = await context.token(['admin:database_connections:read'], 'all', {
      id: 'amp_to_disable',
    });
    expect((await context.callWithToken(token, 'GET', REPLICATION)).status).toBe(503);

    context.db
      .prepare("UPDATE admin_machine_principals SET status = 'disabled' WHERE id = ?")
      .run('amp_to_disable');
    const refused = await context.callWithToken(token, 'GET', REPLICATION);
    const credential = context.db
      .prepare('SELECT status FROM admin_machine_credentials WHERE principal_id = ?')
      .get('amp_to_disable') as { status: string };

    expect(refused.status).toBe(401);
    expect(credential.status).toBe('active');
  });
});

describe('platform storage destinations', () => {
  const PLATFORM_DESTINATIONS = '/api/admin/storage-destinations?scope_type=platform';

  it("are the platform administrator's, not those of an Admin who holds the role for one tenant", async () => {
    const context = await setup();
    const tenantOnly = signIn(context.db, TENANT_SUPER_ADMIN);
    const mixed = signIn(context.db, GLOBAL_VIEWER_TENANT_SUPER_ADMIN);
    const platform = signIn(context.db, GLOBAL_SUPER_ADMIN);

    expect((await context.call(tenantOnly.cookie, 'GET', PLATFORM_DESTINATIONS)).status).toBe(403);
    expect((await context.call(mixed.cookie, 'GET', PLATFORM_DESTINATIONS)).status).toBe(403);
    expect((await context.call(platform.cookie, 'GET', PLATFORM_DESTINATIONS)).status).not.toBe(
      403
    );
    // The tenant's own destinations stay with the tenant's Admin.
    expect(
      (await context.call(tenantOnly.cookie, 'GET', '/api/admin/storage-destinations')).status
    ).not.toBe(403);
  });

  it('asks a machine token for everything under storage destinations, for every tenant', async () => {
    const context = await setup();
    const narrow = await context.token(['admin:storage_destinations:read'], 'all');
    const family = await context.token(['admin:storage_destinations:*'], 'all');
    const limited = await context.token(['admin:storage_destinations:*'], 'allow');

    expect((await context.callWithToken(narrow, 'GET', PLATFORM_DESTINATIONS)).status).toBe(403);
    expect((await context.callWithToken(family, 'GET', PLATFORM_DESTINATIONS)).status).not.toBe(
      403
    );
    expect((await context.callWithToken(limited, 'GET', PLATFORM_DESTINATIONS)).status).toBe(403);
  });
});
