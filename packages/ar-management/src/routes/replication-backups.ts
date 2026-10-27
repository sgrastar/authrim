import { assertReplicationEnvironmentTenant } from '../environment-replication-inventory';
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
import { TenantBackupRequestStore } from '@authrim/ar-lib-core/services/tenant-portability/operation-request';
import { TenantBackupOperationStore } from '@authrim/ar-lib-core/services/tenant-portability/operation-store';
import { parseTenantBackupSelection } from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';
import { replicationCanonicalJson } from '@authrim/ar-lib-core/services/deployment-replication/transport';
import { openTenantBackupDownload } from '@authrim/ar-lib-core/services/tenant-portability/published-artifact-reader';
import {
  TenantBackupReplicationGrantStore,
  replicationExportInstallation,
  replicationExportActor,
  REPLICATION_GRANT_MAX_AGE_MS,
  type ReplicationExportGrant,
} from '../tenant-backup-replication-grants';
import { getTenantBackupKeyStore } from '../tenant-backup-services';
import { readTenantBackupExportReceipt } from '../tenant-backup-export-receipt';
import { TenantBackupOperationReadModel } from '../tenant-backup-operation-read-model';
import { getCanonicalTenantBaseUrlAsync } from '../request-issuer';
import { isFreshAdminHuman } from '../agent-fresh-auth';
import { writeAdminAuditLog } from '../admin-shared';
import { version as productVersion } from '../../package.json';

type Surface = {
  Bindings: Env;
  Variables: {
    adminAuth?: AdminAuthContext;
    tenantId?: string;
    replicationGrant: ReplicationExportGrant;
    recheckGrant: () => Promise<ReplicationExportGrant>;
  };
};
type C = Context<Surface>;
const database = (c: C) => requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup');
const store = (c: C) => new TenantBackupReplicationGrantStore(database(c));
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
const readBody = async (c: C) => object(await c.req.json().catch(() => null));
function human(c: C) {
  const auth = c.get('adminAuth');
  if (!auth?.tenantId || auth.tenantId !== getTenantIdFromContext(c))
    throw new Error('backup_forbidden');
  return { ...auth, tenantId: auth.tenantId };
}
async function audit(
  c: C,
  action: string,
  resourceId: string | null,
  metadata: Record<string, unknown> = {}
) {
  const grant = c.get('replicationGrant');
  return writeAdminAuditLog(c, {
    action,
    resourceType: 'tenant_backup_replication',
    resourceId,
    result: 'success',
    metadata: {
      ...metadata,
      ...(grant
        ? {
            grantId: grant.id,
            delegatedBy: grant.createdBy,
            machineActor: replicationExportActor(grant),
            pairId: grant.scope.pairId,
            sourceDeploymentId: grant.scope.sourceDeploymentId,
            destinationDeploymentId: grant.scope.destinationDeploymentId,
          }
        : {}),
    },
  });
}

/** Only this human surface can issue or revoke credentials; normal Admin auth is not weakened. */
export const replicationBackupGrantsRouter = new Hono<Surface>();
replicationBackupGrantsRouter.use('*', bodyLimit({ maxSize: 8192 }));
replicationBackupGrantsRouter.use('*', adminAuthMiddleware());
replicationBackupGrantsRouter.use('*', async (c, next) => {
  const auth = c.get('adminAuth');
  if (
    !auth?.tenantId ||
    auth.tenantId !== getTenantIdFromContext(c) ||
    ![
      ADMIN_PERMISSIONS.BACKUPS_READ,
      ADMIN_PERMISSIONS.BACKUPS_MANAGE,
      ADMIN_PERMISSIONS.BACKUPS_EXPORT,
    ].every((p) => hasAdminPermission(auth.permissions ?? [], p))
  )
    return c.json({ error: 'backup_forbidden' }, 403);
  if (!isFreshAdminHuman(auth, Date.now()))
    return c.json({ error: 'backup_fresh_auth_required' }, 403);
  c.header('Cache-Control', 'no-store');
  return next();
});
replicationBackupGrantsRouter.onError((_error, c) =>
  c.json({ error: 'backup_replication_unavailable' }, 503)
);
replicationBackupGrantsRouter.post('/grants', async (c) => {
  const auth = human(c);
  const body = await readBody(c);
  const now = Date.now();
  if (
    !body ||
    Object.keys(body).sort().join(',') !==
      'destinationDeploymentId,expiresAt,pairId,selection,sourceDeploymentId' ||
    !identifier(body.pairId) ||
    !identifier(body.sourceDeploymentId) ||
    !identifier(body.destinationDeploymentId) ||
    typeof body.expiresAt !== 'number' ||
    !Number.isSafeInteger(body.expiresAt) ||
    body.expiresAt <= now ||
    body.expiresAt > now + REPLICATION_GRANT_MAX_AGE_MS
  )
    return c.json({ error: 'invalid_replication_grant' }, 400);
  let selection;
  try {
    selection = parseTenantBackupSelection(body.selection);
  } catch {
    return c.json({ error: 'invalid_replication_grant' }, 400);
  }
  if (
    selection.logs.sensitive &&
    !hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.BACKUPS_SENSITIVE)
  )
    return c.json({ error: 'backup_forbidden' }, 403);
  const installed = replicationExportInstallation(c.env);
  if (
    (installed.version === 1 && installed.tenantId !== auth.tenantId) ||
    installed.pairId !== body.pairId ||
    installed.deploymentId !== body.sourceDeploymentId ||
    body.sourceDeploymentId === body.destinationDeploymentId
  )
    return c.json({ error: 'invalid_replication_grant' }, 400);
  if (installed.version === 2) await assertReplicationEnvironmentTenant(c.env, auth.tenantId);
  const issuer = await getCanonicalTenantBaseUrlAsync(c.env, auth.tenantId);
  const scope = {
    version: 1,
    kind: 'tenant_backup_export',
    tenantId: auth.tenantId,
    pairId: body.pairId,
    sourceDeploymentId: body.sourceDeploymentId,
    destinationDeploymentId: body.destinationDeploymentId,
    issuer,
    selection,
  };
  const auditId = await audit(c, 'tenant_backup.replication_grant_requested', null, {
    scope,
    expiresAt: body.expiresAt,
  });
  if (!auditId) return c.json({ error: 'backup_audit_unavailable' }, 503);
  const created = await store(c).create({
    tenantId: auth.tenantId,
    actorId: auth.actorId ?? auth.userId,
    scope,
    expiresAt: body.expiresAt,
    now,
    auditId,
    installed,
  });
  return c.json(created, 201);
});
replicationBackupGrantsRouter.post('/grants/:grantId/revoke', async (c) => {
  const auth = human(c);
  const id = c.req.param('grantId');
  if (!identifier(id)) return c.json({ error: 'invalid_replication_grant' }, 400);
  if (!(await store(c).load(auth.tenantId, id)))
    return c.json({ error: 'backup_replication_grant_not_found' }, 404);
  const auditId = await audit(c, 'tenant_backup.replication_grant_revoked', id);
  if (!auditId) return c.json({ error: 'backup_audit_unavailable' }, 503);
  const grant = await store(c).revoke({
    tenantId: auth.tenantId,
    id,
    actorId: auth.actorId ?? auth.userId,
    auditId,
    now: Date.now(),
  });
  return c.json({ grant });
});

/** Exact allow-list used by the outer entrypoint when ordinary writer admission is closed. */
export function isReplicationBackupControlRequest(request: Request): boolean {
  const path = new URL(request.url).pathname;
  const id = '[A-Za-z0-9_.:-]{1,128}';
  const base = `/api/replication-backups/${id}/exports`;
  return request.method === 'GET'
    ? new RegExp(`^${base}/${id}(?:/export-receipt|/download)?$`).test(path)
    : request.method === 'POST' &&
        new RegExp(
          `^${base}(?:/${id}/(?:key-challenges|start|key-challenges/${id}/accept))?$`
        ).test(path);
}

/** A separate export-only bearer surface. Never mount below /api/admin or reuse its credential there. */
export const replicationBackupMachineRouter = new Hono<Surface>();
replicationBackupMachineRouter.use('*', bodyLimit({ maxSize: 4096 }));
replicationBackupMachineRouter.use('/:grantId/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const id = c.req.param('grantId');
  const match = /^Bearer ([a-f0-9]{64})$/.exec(c.req.header('Authorization') ?? '');
  if (!identifier(id) || !match) return c.json({ error: 'backup_replication_grant_denied' }, 403);
  try {
    const installed = replicationExportInstallation(c.env);
    const tenantId = c.req.header('X-Tenant-Id');
    if (!identifier(tenantId)) throw new Error('scope');
    const grantStore = new TenantBackupReplicationGrantStore(
      requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup')
    );
    const recheck = async () => {
      if (installed.version === 2) await assertReplicationEnvironmentTenant(c.env, tenantId);
      return grantStore.authenticate({
        id,
        tenantId,
        credential: match[1],
        now: Date.now(),
        installed: replicationExportInstallation(c.env),
      });
    };
    if (installed.version === 1 && tenantId !== installed.tenantId) throw new Error('scope');
    if (installed.version === 2) await assertReplicationEnvironmentTenant(c.env, tenantId);
    const grant = await recheck();
    c.set('tenantId', tenantId);
    c.set('replicationGrant', grant);
    c.set('recheckGrant', recheck);
    c.set('adminAuth', {
      userId: replicationExportActor(grant),
      actorId: replicationExportActor(grant),
      actorType: 'machine',
      authMethod: 'machine_access_token',
      credentialId: grant.id,
      tenantId,
      roles: [],
      permissions: [],
    });
  } catch {
    return c.json({ error: 'backup_replication_grant_denied' }, 403);
  }
  return next();
});
replicationBackupMachineRouter.onError((_error, c) =>
  c.json({ error: 'backup_replication_unavailable' }, 503)
);

async function scopedOperation(c: C) {
  const grant = await c.get('recheckGrant')();
  const id = c.req.param('operationId');
  if (!identifier(id)) throw new Error('backup_replication_operation_denied');
  const db = database(c);
  const operation = await new TenantBackupOperationStore(db).get(grant.scope.tenantId, id);
  if (
    !operation ||
    operation.kind !== 'export' ||
    operation.created_by !== replicationExportActor(grant)
  )
    throw new Error('backup_replication_operation_denied');
  const intent = await new TenantBackupRequestStore(db).load(grant.scope.tenantId, id);
  if (
    intent.kind !== 'export' ||
    intent.source.tenantId !== grant.scope.tenantId ||
    intent.source.issuer !== grant.scope.issuer ||
    replicationCanonicalJson(intent.selection) !== replicationCanonicalJson(grant.scope.selection)
  )
    throw new Error('backup_replication_operation_denied');
  return { grant, operation, intent };
}
const view = (operation: { id: string; state: string; phase: string; revision: number }) => ({
  id: operation.id,
  state: operation.state,
  phase: operation.phase,
  revision: operation.revision,
});
async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

replicationBackupMachineRouter.post('/:grantId/exports', async (c) => {
  const body = await readBody(c);
  if (!body || Object.keys(body).join(',') !== 'idempotencyKey' || !identifier(body.idempotencyKey))
    return c.json({ error: 'invalid_backup_request' }, 400);
  const grant = await c.get('recheckGrant')();
  if (!c.env.EXPORT_ARTIFACTS) return c.json({ error: 'backup_storage_unavailable' }, 503);
  if (!(await getTenantBackupKeyStore(c.env)))
    return c.json({ error: 'backup_key_service_unavailable' }, 503);
  if ((await getCanonicalTenantBaseUrlAsync(c.env, grant.scope.tenantId)) !== grant.scope.issuer)
    return c.json({ error: 'backup_source_unavailable' }, 409);
  const requestHash = await digest(JSON.stringify([grant.id, body.idempotencyKey]));
  const id = `replication-backup-${requestHash}`;
  if (!(await audit(c, 'tenant_backup.replication_export_requested', id)))
    return c.json({ error: 'backup_audit_unavailable' }, 503);
  await c.get('recheckGrant')();
  const operation = await new TenantBackupRequestStore(database(c)).create({
    id,
    tenantId: grant.scope.tenantId,
    actorId: replicationExportActor(grant),
    idempotencyKey: `replication:${requestHash}`,
    now: Date.now(),
    intent: {
      version: 1,
      kind: 'export',
      source: { tenantId: grant.scope.tenantId, issuer: grant.scope.issuer, productVersion },
      selection: grant.scope.selection,
      inputs: [],
    },
  });
  return c.json(view(operation), 201);
});
replicationBackupMachineRouter.get('/:grantId/exports/:operationId', async (c) => {
  let scoped;
  try {
    scoped = await scopedOperation(c);
  } catch {
    return c.json({ error: 'backup_replication_operation_denied' }, 403);
  }
  const result = await new TenantBackupOperationReadModel(database(c)).get(
    scoped.grant.scope.tenantId,
    scoped.operation.id,
    Date.now()
  );
  if (!(await audit(c, 'tenant_backup.replication_export_status_read', scoped.operation.id)))
    return c.json({ error: 'backup_audit_unavailable' }, 503);
  await c.get('recheckGrant')();
  if (!result) return c.json({ error: 'backup_replication_operation_denied' }, 403);
  return c.json(result.view);
});
replicationBackupMachineRouter.post('/:grantId/exports/:operationId/key-challenges', async (c) => {
  if ((await c.req.text()).length) return c.json({ error: 'invalid_backup_key_input' }, 400);
  let scoped;
  try {
    scoped = await scopedOperation(c);
  } catch {
    return c.json({ error: 'backup_replication_operation_denied' }, 403);
  }
  const keys = await getTenantBackupKeyStore(c.env);
  if (!keys) return c.json({ error: 'backup_key_service_unavailable' }, 503);
  if (!(await audit(c, 'tenant_backup.replication_key_challenge_requested', scoped.operation.id)))
    return c.json({ error: 'backup_audit_unavailable' }, 503);
  await c.get('recheckGrant')();
  try {
    return c.json(
      await keys.issue(
        scoped.grant.scope.tenantId,
        scoped.operation.id,
        replicationExportActor(scoped.grant),
        Date.now()
      ),
      201
    );
  } catch {
    return c.json({ error: 'backup_operation_key_unavailable' }, 409);
  }
});
replicationBackupMachineRouter.post(
  '/:grantId/exports/:operationId/key-challenges/:challengeId/accept',
  async (c) => {
    const body = await readBody(c);
    const challengeId = c.req.param('challengeId');
    if (
      !identifier(challengeId) ||
      !body ||
      Object.keys(body).sort().join(',') !== 'envelope,handoff' ||
      typeof body.envelope !== 'string' ||
      !/^[a-f0-9]{186}$/.test(body.envelope) ||
      typeof body.handoff !== 'string' ||
      !/^[a-f0-9]{512}$/.test(body.handoff)
    )
      return c.json({ error: 'invalid_backup_key_input' }, 400);
    let scoped;
    try {
      scoped = await scopedOperation(c);
    } catch {
      return c.json({ error: 'backup_replication_operation_denied' }, 403);
    }
    const keys = await getTenantBackupKeyStore(c.env);
    if (!keys) return c.json({ error: 'backup_key_service_unavailable' }, 503);
    if (!(await audit(c, 'tenant_backup.replication_key_accept_requested', scoped.operation.id)))
      return c.json({ error: 'backup_audit_unavailable' }, 503);
    await c.get('recheckGrant')();
    const decode = (value: string) =>
      Uint8Array.from(value.match(/../g) ?? [], (b) => parseInt(b, 16));
    try {
      await keys.accept(
        scoped.grant.scope.tenantId,
        scoped.operation.id,
        replicationExportActor(scoped.grant),
        challengeId,
        decode(body.envelope),
        decode(body.handoff),
        Date.now()
      );
      return c.json({ accepted: true });
    } catch {
      return c.json({ error: 'backup_operation_key_unavailable' }, 409);
    }
  }
);
replicationBackupMachineRouter.post('/:grantId/exports/:operationId/start', async (c) => {
  const body = await readBody(c);
  if (
    !body ||
    Object.keys(body).sort().join(',') !== 'challengeId,revision' ||
    !identifier(body.challengeId) ||
    typeof body.revision !== 'number' ||
    !Number.isSafeInteger(body.revision) ||
    body.revision < 0
  )
    return c.json({ error: 'invalid_backup_request' }, 400);
  let scoped;
  try {
    scoped = await scopedOperation(c);
  } catch {
    return c.json({ error: 'backup_replication_operation_denied' }, 403);
  }
  if (!c.env.EXPORT_ARTIFACTS || !(await getTenantBackupKeyStore(c.env)))
    return c.json({ error: 'backup_storage_unavailable' }, 503);
  if (!(await audit(c, 'tenant_backup.replication_export_start_requested', scoped.operation.id)))
    return c.json({ error: 'backup_audit_unavailable' }, 503);
  await c.get('recheckGrant')();
  const operation = await new TenantBackupRequestStore(database(c)).start({
    tenantId: scoped.grant.scope.tenantId,
    operationId: scoped.operation.id,
    actorId: replicationExportActor(scoped.grant),
    challengeId: body.challengeId,
    revision: body.revision,
    now: Date.now(),
  });
  if (!operation) return c.json({ error: 'backup_operation_conflict' }, 409);
  return c.json(view(operation), 202);
});
replicationBackupMachineRouter.get('/:grantId/exports/:operationId/export-receipt', async (c) => {
  let scoped;
  try {
    scoped = await scopedOperation(c);
  } catch {
    return c.json({ error: 'backup_replication_operation_denied' }, 403);
  }
  let receipt;
  try {
    receipt = await readTenantBackupExportReceipt({
      database: database(c),
      tenantId: scoped.grant.scope.tenantId,
      operationId: scoped.operation.id,
      intent: scoped.intent,
      now: Date.now,
      signal: c.req.raw.signal,
    });
  } catch {
    return c.json({ error: 'backup_export_receipt_unavailable' }, 409);
  }
  if (!(await audit(c, 'tenant_backup.replication_export_receipt_read', scoped.operation.id)))
    return c.json({ error: 'backup_audit_unavailable' }, 503);
  await c.get('recheckGrant')();
  return c.json(receipt);
});
replicationBackupMachineRouter.get('/:grantId/exports/:operationId/download', async (c) => {
  let scoped;
  try {
    scoped = await scopedOperation(c);
  } catch {
    return c.json({ error: 'backup_replication_operation_denied' }, 403);
  }
  if (!c.env.EXPORT_ARTIFACTS) return c.json({ error: 'backup_storage_unavailable' }, 503);
  let download;
  try {
    download = await openTenantBackupDownload({
      database: database(c),
      bucket: c.env.EXPORT_ARTIFACTS,
      tenantId: scoped.grant.scope.tenantId,
      operationId: scoped.operation.id,
      now: Date.now,
      signal: c.req.raw.signal,
    });
  } catch {
    return c.json({ error: 'backup_download_unavailable' }, 409);
  }
  if (!(await audit(c, 'tenant_backup.replication_download_started', scoped.operation.id)))
    return c.json({ error: 'backup_audit_unavailable' }, 503);
  await c.get('recheckGrant')();
  const iterator = download.chunks[Symbol.asyncIterator]();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        await c.get('recheckGrant')();
        const item = await iterator.next();
        await c.get('recheckGrant')();
        if (item.done) controller.close();
        else controller.enqueue(item.value);
      } catch {
        await iterator.return?.().catch(() => undefined);
        controller.error(new Error('backup_download_unavailable'));
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(download.byteCount),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
