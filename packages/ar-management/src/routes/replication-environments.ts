import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  adminAuthMiddleware,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  getTenantIdFromContext,
  requireDedicatedAdminDatabaseAdapter,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';
import { hasPlatformTenantManagementAuthority } from '../admin-tenant-access';
import { isFreshAdminHuman } from '../agent-fresh-auth';
import { writeAdminAuditLog } from '../admin-shared';
import {
  EnvironmentInventoryGrantStore,
  REPLICATION_GRANT_MAX_AGE_MS,
  environmentInventoryActor,
} from '../environment-replication-grants';
import {
  environmentReplicationInstallation,
  readEnvironmentReplicationInventory,
} from '../environment-replication-inventory';

type Surface = { Bindings: Env; Variables: { adminAuth?: AdminAuthContext; tenantId?: string } };
type C = Context<Surface>;
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const store = (c: C) =>
  new EnvironmentInventoryGrantStore(
    requireDedicatedAdminDatabaseAdapter(c.env, 'replication-environment-grant')
  );
export const environmentReplicationGrantsRouter = new Hono<Surface>();
environmentReplicationGrantsRouter.use('*', bodyLimit({ maxSize: 4096 }), adminAuthMiddleware());
environmentReplicationGrantsRouter.use('*', async (c, next) => {
  const auth = c.get('adminAuth');
  if (
    !auth?.tenantId ||
    auth.tenantId !== getTenantIdFromContext(c) ||
    !hasPlatformTenantManagementAuthority(auth, ADMIN_PERMISSIONS.SETTINGS_READ) ||
    !hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.BACKUPS_MANAGE)
  )
    return c.json({ error: 'backup_forbidden' }, 403);
  if (!isFreshAdminHuman(auth, Date.now()))
    return c.json({ error: 'backup_fresh_auth_required' }, 403);
  c.header('Cache-Control', 'no-store');
  return next();
});
environmentReplicationGrantsRouter.onError((_error, c) =>
  c.json({ error: 'backup_replication_unavailable' }, 503)
);
environmentReplicationGrantsRouter.post('/grants', async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return c.json({ error: 'invalid_replication_grant' }, 400);
  const b = body as Record<string, unknown>;
  const now = Date.now();
  if (
    Object.keys(b).sort().join(',') !==
      'destinationDeploymentId,expiresAt,pairId,sourceDeploymentId' ||
    !id(b.pairId) ||
    !id(b.sourceDeploymentId) ||
    !id(b.destinationDeploymentId) ||
    b.sourceDeploymentId === b.destinationDeploymentId ||
    !Number.isSafeInteger(b.expiresAt) ||
    typeof b.expiresAt !== 'number' ||
    b.expiresAt <= now ||
    b.expiresAt > now + REPLICATION_GRANT_MAX_AGE_MS
  )
    return c.json({ error: 'invalid_replication_grant' }, 400);
  const installed = environmentReplicationInstallation(c.env);
  if (installed.pairId !== b.pairId || installed.deploymentId !== b.sourceDeploymentId)
    return c.json({ error: 'invalid_replication_grant' }, 400);
  const auth = c.get('adminAuth');
  if (!auth?.tenantId) return c.json({ error: 'backup_forbidden' }, 403);
  const scope = {
    version: 1,
    kind: 'environment_inventory_read',
    ownerTenantId: auth.tenantId,
    environmentId: installed.environmentId,
    pairId: b.pairId,
    sourceDeploymentId: b.sourceDeploymentId,
    destinationDeploymentId: b.destinationDeploymentId,
  };
  const auditId = await writeAdminAuditLog(c, {
    action: 'replication.environment_inventory_grant_requested',
    resourceType: 'replication_environment',
    resourceId: installed.environmentId,
    result: 'success',
    metadata: { scope, expiresAt: b.expiresAt },
  });
  if (!auditId) return c.json({ error: 'backup_audit_unavailable' }, 503);
  return c.json(
    await store(c).create({
      tenantId: auth.tenantId,
      actorId: auth.actorId ?? auth.userId,
      scope,
      expiresAt: b.expiresAt,
      now,
      auditId,
      installed,
    }),
    201
  );
});
environmentReplicationGrantsRouter.post('/grants/:grantId/revoke', async (c) => {
  const auth = c.get('adminAuth');
  const grantId = c.req.param('grantId');
  if (!auth?.tenantId || !id(grantId)) return c.json({ error: 'invalid_replication_grant' }, 400);
  if (!(await store(c).load(auth.tenantId, grantId)))
    return c.json({ error: 'backup_replication_grant_not_found' }, 404);
  const auditId = await writeAdminAuditLog(c, {
    action: 'replication.environment_inventory_grant_revoked',
    resourceType: 'replication_environment',
    resourceId: grantId,
    result: 'success',
  });
  if (!auditId) return c.json({ error: 'backup_audit_unavailable' }, 503);
  return c.json({
    grant: await store(c).revoke({
      tenantId: auth.tenantId,
      id: grantId,
      actorId: auth.actorId ?? auth.userId,
      auditId,
      now: Date.now(),
    }),
  });
});
export function isEnvironmentReplicationControlRequest(request: Request): boolean {
  return (
    request.method === 'GET' &&
    /^\/api\/replication-environments\/[A-Za-z0-9_.:-]{1,128}\/inventory$/.test(
      new URL(request.url).pathname
    )
  );
}
export const environmentReplicationMachineRouter = new Hono<Surface>();
environmentReplicationMachineRouter.get('/:grantId/inventory', async (c) => {
  c.header('Cache-Control', 'no-store');
  const credential = /^Bearer ([a-f0-9]{64})$/.exec(c.req.header('Authorization') ?? '');
  const ownerTenantId = c.req.header('X-Tenant-Id');
  if (!credential || !id(ownerTenantId) || new URL(c.req.url).search)
    return c.json({ error: 'backup_replication_grant_denied' }, 403);
  let grant;
  try {
    grant = await store(c).authenticate({
      tenantId: ownerTenantId,
      id: c.req.param('grantId'),
      credential: credential[1],
      now: Date.now(),
      installed: environmentReplicationInstallation(c.env),
    });
  } catch {
    return c.json({ error: 'backup_replication_grant_denied' }, 403);
  }
  c.set('tenantId', ownerTenantId);
  c.set('adminAuth', {
    userId: environmentInventoryActor(grant),
    actorId: environmentInventoryActor(grant),
    actorType: 'machine',
    authMethod: 'machine_access_token',
    credentialId: grant.id,
    tenantId: ownerTenantId,
    roles: [],
    permissions: [],
  });
  const result = await readEnvironmentReplicationInventory(c.env);
  const auditId = await writeAdminAuditLog(c, {
    action: 'replication.environment_inventory_read',
    resourceType: 'replication_environment',
    resourceId: result.environmentId,
    result: 'success',
    metadata: {
      grantId: grant.id,
      delegatedBy: grant.createdBy,
      inventorySha256: result.inventorySha256,
      tenantCount: result.tenants.length,
    },
  });
  if (!auditId) return c.json({ error: 'backup_audit_unavailable' }, 503);
  await store(c).authenticate({
    tenantId: ownerTenantId,
    id: grant.id,
    credential: credential[1],
    now: Date.now(),
    installed: environmentReplicationInstallation(c.env),
  });
  return c.json(result);
});
environmentReplicationMachineRouter.onError((_error, c) =>
  c.json({ error: 'replication_environment_inventory_unavailable' }, 503)
);
