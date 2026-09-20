import { openTenantBackupDownload } from '@authrim/ar-lib-core/services/tenant-portability/published-artifact-reader';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import {
  adminAuthMiddleware,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  getTenantIdFromContext,
  ensureDatabaseAdapter,
  requireDedicatedAdminDatabaseAdapter,
  type AdminAuthContext,
  type Env,
} from '@authrim/ar-lib-core';
import { TenantBackupOperationStore } from '@authrim/ar-lib-core/services/tenant-portability/operation-store';
import { TenantBackupAdminMappingStore } from '@authrim/ar-lib-core/services/tenant-portability/admin-mapping-store';
import { getTenantBackupKeyStore as keyStore } from '../../tenant-backup-services';
import { TenantBackupRequestStore } from '@authrim/ar-lib-core/services/tenant-portability/operation-request';
import type { TenantBackupRequestIntent } from '@authrim/ar-lib-core/services/tenant-portability/operation-request';
import { parseTenantBackupSelection } from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';
import { getCanonicalTenantBaseUrlAsync } from '../../request-issuer';
import { version as productVersion } from '../../../package.json';
import { isFreshAdminHuman } from '../../agent-fresh-auth';
import { writeAdminAuditLog } from '../../admin-shared';
import {
  TenantBackupUploadStore,
  TENANT_BACKUP_UPLOAD_PART_BYTES,
} from '@authrim/ar-lib-core/services/tenant-portability/upload-store';
import { initializeTenantBackupMultipart } from '@authrim/ar-lib-core/services/tenant-portability/allocate-upload';
import { uploadTenantBackupPart } from '@authrim/ar-lib-core/services/tenant-portability/upload-part';
import { completeTenantBackupUpload } from '@authrim/ar-lib-core/services/tenant-portability/complete-upload';
import { TenantBackupImportRequestStore } from '@authrim/ar-lib-core/services/tenant-portability/import-request';
import { TenantBackupOperationReadModel } from '../../tenant-backup-operation-read-model';

const SYNCHRONOUS_UPLOAD_COMPLETION_BYTES = 16 * 1024 * 1024;

export const tenantBackupsRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();
tenantBackupsRouter.use('*', adminAuthMiddleware());
tenantBackupsRouter.use('*', async (c, next) =>
  bodyLimit({
    maxSize: /\/uploads\/[^/]+\/parts\/[^/]+$/.test(c.req.path)
      ? TENANT_BACKUP_UPLOAD_PART_BYTES
      : c.req.path.endsWith('/imports')
        ? 32768
        : 4096,
  })(c, next)
);
tenantBackupsRouter.use('*', async (c, next) => {
  const auth = c.get('adminAuth');
  if (
    !auth?.tenantId ||
    auth.tenantId !== getTenantIdFromContext(c) ||
    !hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.BACKUPS_READ)
  )
    return c.json({ error: 'backup_forbidden' }, 403);
  if (c.req.method !== 'GET') {
    if (!hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.BACKUPS_MANAGE))
      return c.json({ error: 'backup_forbidden' }, 403);
    if (!isFreshAdminHuman(auth, Date.now()))
      return c.json({ error: 'backup_fresh_auth_required' }, 403);
  }
  c.header('Cache-Control', 'no-store');
  return next();
});

function tenantAuth(auth: AdminAuthContext | undefined) {
  if (!auth?.tenantId) throw new Error('backup_auth_context_missing');
  return { ...auth, tenantId: auth.tenantId };
}

const validateOperationId = createMiddleware(async (c, next) => {
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(c.req.param('operationId') ?? ''))
    return c.json({ error: 'invalid_backup_operation_id' }, 400);
  return next();
});
tenantBackupsRouter.use('/:operationId', validateOperationId);
tenantBackupsRouter.use('/:operationId/*', validateOperationId);

function requireImportPermission(auth: AdminAuthContext) {
  return hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.BACKUPS_IMPORT);
}

function hasOperationPermission(auth: AdminAuthContext, intent: TenantBackupRequestIntent) {
  const permitted =
    intent.kind === 'export'
      ? hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.BACKUPS_EXPORT)
      : requireImportPermission(auth);
  return (
    permitted &&
    (!intent.selection.logs.sensitive ||
      hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.BACKUPS_SENSITIVE))
  );
}

async function stableOperationId(
  kind: 'export' | 'import',
  tenantId: string,
  actorId: string,
  idempotencyKey: string
) {
  const bytes = new TextEncoder().encode(JSON.stringify([kind, tenantId, actorId, idempotencyKey]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `tenant-backup-${Array.from(digest.subarray(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')}`;
}

tenantBackupsRouter.post('/uploads', async (c) => {
  const auth = tenantAuth(c.get('adminAuth'));
  if (!requireImportPermission(auth)) return c.json({ error: 'backup_forbidden' }, 403);
  if (!c.env.IMPORT_ARTIFACTS) return c.json({ error: 'backup_storage_unavailable' }, 503);
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return c.json({ error: 'invalid_backup_upload' }, 400);
  const value = body as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !== 'idempotencyKey,sha256,sizeBytes' ||
    typeof value.idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(value.idempotencyKey) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 174 ||
    value.sizeBytes > TENANT_BACKUP_UPLOAD_PART_BYTES * 10000
  )
    return c.json({ error: 'invalid_backup_upload' }, 400);
  const uploadId = crypto.randomUUID();
  const store = new TenantBackupUploadStore(
    requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup')
  );
  const owner = { tenantId: auth.tenantId, actorId: auth.actorId ?? auth.userId, uploadId };
  let created;
  try {
    created = await store.create({
      ...owner,
      idempotencyKey: value.idempotencyKey,
      bytes: value.sizeBytes,
      sha256: value.sha256,
      now: Date.now(),
    });
  } catch {
    return c.json({ error: 'backup_upload_conflict' }, 409);
  }
  if (
    !(await writeAdminAuditLog(c, {
      action: 'tenant_backup.upload_requested',
      resourceType: 'tenant_backup_upload',
      resourceId: created.id,
      result: 'success',
      metadata: { sizeBytes: value.sizeBytes, sha256: value.sha256 },
    }))
  )
    return c.json({ error: 'backup_audit_unavailable' }, 503);
  try {
    const upload = await initializeTenantBackupMultipart({
      store,
      bucket: c.env.IMPORT_ARTIFACTS,
      owner: { ...owner, uploadId: created.id },
      now: Date.now,
    });
    return c.json(
      {
        id: upload.id,
        state: upload.state,
        partSize: TENANT_BACKUP_UPLOAD_PART_BYTES,
        partCount: Math.ceil(upload.expected_bytes / TENANT_BACKUP_UPLOAD_PART_BYTES),
        expiresAt: upload.expires_at,
      },
      201
    );
  } catch {
    return c.json({ error: 'backup_upload_conflict' }, 409);
  }
});

tenantBackupsRouter.get('/uploads/:uploadId', async (c) => {
  const auth = tenantAuth(c.get('adminAuth'));
  if (!requireImportPermission(auth)) return c.json({ error: 'backup_forbidden' }, 403);
  try {
    const upload = await new TenantBackupUploadStore(
      requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup')
    ).get(
      {
        tenantId: auth.tenantId,
        actorId: auth.actorId ?? auth.userId,
        uploadId: c.req.param('uploadId'),
      },
      Date.now()
    );
    return c.json({
      id: upload.id,
      state: upload.state,
      sizeBytes: upload.expected_bytes,
      sha256: upload.expected_sha256,
      expiresAt: upload.expires_at,
    });
  } catch {
    return c.json({ error: 'backup_upload_unavailable' }, 404);
  }
});

tenantBackupsRouter.put('/uploads/:uploadId/parts/:partNumber', async (c) => {
  const auth = tenantAuth(c.get('adminAuth'));
  if (!requireImportPermission(auth)) return c.json({ error: 'backup_forbidden' }, 403);
  if (!c.env.IMPORT_ARTIFACTS) return c.json({ error: 'backup_storage_unavailable' }, 503);
  if (!/^application\/octet-stream(?:;|$)/i.test(c.req.header('Content-Type') ?? ''))
    return c.json({ error: 'invalid_backup_upload_part' }, 400);
  const partNumber = Number(c.req.param('partNumber'));
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10000)
    return c.json({ error: 'invalid_backup_upload_part' }, 400);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  try {
    const result = await uploadTenantBackupPart({
      store: new TenantBackupUploadStore(
        requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup')
      ),
      bucket: c.env.IMPORT_ARTIFACTS,
      owner: {
        tenantId: auth.tenantId,
        actorId: auth.actorId ?? auth.userId,
        uploadId: c.req.param('uploadId'),
      },
      number: partNumber,
      bytes,
      signal: c.req.raw.signal,
      now: Date.now,
    });
    return c.json(result);
  } catch {
    return c.json({ error: 'backup_upload_part_conflict' }, 409);
  }
});

tenantBackupsRouter.post('/uploads/:uploadId/complete', async (c) => {
  const auth = tenantAuth(c.get('adminAuth'));
  if (!requireImportPermission(auth)) return c.json({ error: 'backup_forbidden' }, 403);
  if (!c.env.IMPORT_ARTIFACTS) return c.json({ error: 'backup_storage_unavailable' }, 503);
  const uploadId = c.req.param('uploadId');
  if (
    !(await writeAdminAuditLog(c, {
      action: 'tenant_backup.upload_completion_requested',
      resourceType: 'tenant_backup_upload',
      resourceId: uploadId,
      result: 'success',
    }))
  )
    return c.json({ error: 'backup_audit_unavailable' }, 503);
  const store = new TenantBackupUploadStore(
    requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup')
  );
  const owner = { tenantId: auth.tenantId, actorId: auth.actorId ?? auth.userId, uploadId };
  let upload;
  try {
    upload = (await store.prepareCompletion(owner, Date.now())).upload;
  } catch {
    return c.json({ error: 'backup_upload_incomplete' }, 409);
  }
  if (upload.expected_bytes <= SYNCHRONOUS_UPLOAD_COMPLETION_BYTES) {
    try {
      await completeTenantBackupUpload({
        store,
        bucket: c.env.IMPORT_ARTIFACTS,
        owner,
        signal: c.req.raw.signal,
        now: Date.now,
      });
      return c.json({ id: upload.id, state: 'uploaded' }, 200);
    } catch {
      return c.json({ error: 'backup_upload_verification_unavailable' }, 503);
    }
  }
  return c.json({ id: upload.id, state: upload.state }, 202);
});

tenantBackupsRouter.post('/uploads/:uploadId/cancel', async (c) => {
  const auth = tenantAuth(c.get('adminAuth'));
  if (!requireImportPermission(auth)) return c.json({ error: 'backup_forbidden' }, 403);
  if (!c.env.IMPORT_ARTIFACTS) return c.json({ error: 'backup_storage_unavailable' }, 503);
  const uploadId = c.req.param('uploadId');
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(uploadId))
    return c.json({ error: 'invalid_backup_upload' }, 400);
  if (
    !(await writeAdminAuditLog(c, {
      action: 'tenant_backup.upload_cancel_requested',
      resourceType: 'tenant_backup_upload',
      resourceId: uploadId,
      result: 'success',
    }))
  )
    return c.json({ error: 'backup_audit_unavailable' }, 503);
  try {
    const upload = await new TenantBackupUploadStore(
      requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup')
    ).requestCancel(
      { tenantId: auth.tenantId, actorId: auth.actorId ?? auth.userId, uploadId },
      Date.now()
    );
    return c.json({ id: upload.id, state: upload.state }, 202);
  } catch {
    return c.json({ error: 'backup_upload_conflict' }, 409);
  }
});

tenantBackupsRouter.post('/imports', async (c) => {
  const auth = tenantAuth(c.get('adminAuth'));
  if (!requireImportPermission(auth)) return c.json({ error: 'backup_forbidden' }, 403);
  if (!c.env.IMPORT_ARTIFACTS) return c.json({ error: 'backup_storage_unavailable' }, 503);
  if (!(await keyStore(c.env))) return c.json({ error: 'backup_key_service_unavailable' }, 503);
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return c.json({ error: 'invalid_backup_request' }, 400);
  const input = body as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(',') !== 'idempotencyKey,selection,source,uploadIds' ||
    typeof input.idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(input.idempotencyKey) ||
    !Array.isArray(input.uploadIds) ||
    input.uploadIds.length < 1 ||
    input.uploadIds.length > 32 ||
    input.uploadIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(id))
  )
    return c.json({ error: 'invalid_backup_request' }, 400);
  const source = input.source as Record<string, unknown> | null;
  if (
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    Object.keys(source).sort().join(',') !== 'issuer,productVersion,tenantId' ||
    source.tenantId !== auth.tenantId ||
    source.productVersion !== productVersion ||
    typeof source.issuer !== 'string' ||
    source.issuer.length < 1 ||
    source.issuer.length > 2048
  )
    return c.json({ error: 'invalid_backup_request' }, 400);
  try {
    const url = new URL(source.issuer);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return c.json({ error: 'invalid_backup_request' }, 400);
  } catch {
    return c.json({ error: 'invalid_backup_request' }, 400);
  }
  let selection;
  try {
    selection = parseTenantBackupSelection(input.selection);
  } catch {
    return c.json({ error: 'invalid_backup_request' }, 400);
  }
  if (
    selection.logs.sensitive &&
    !hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.BACKUPS_SENSITIVE)
  )
    return c.json({ error: 'backup_forbidden' }, 403);
  const actorId = auth.actorId ?? auth.userId;
  const id = await stableOperationId('import', auth.tenantId, actorId, input.idempotencyKey);
  if (
    !(await writeAdminAuditLog(c, {
      action: 'tenant_backup.import_requested',
      resourceType: 'tenant_backup',
      resourceId: id,
      result: 'success',
      metadata: { selection, inputCount: input.uploadIds.length },
    }))
  )
    return c.json({ error: 'backup_audit_unavailable' }, 503);
  try {
    const operation = await new TenantBackupImportRequestStore(
      requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup')
    ).create({
      id,
      tenantId: auth.tenantId,
      actorId,
      idempotencyKey: input.idempotencyKey,
      source: {
        tenantId: auth.tenantId,
        issuer: source.issuer,
        productVersion,
      },
      selection,
      uploadIds: input.uploadIds as string[],
      now: Date.now(),
    });
    return c.json(
      {
        id: operation.id,
        kind: operation.kind,
        state: operation.state,
        phase: operation.phase,
        revision: operation.revision,
      },
      201
    );
  } catch {
    return c.json({ error: 'backup_operation_conflict' }, 409);
  }
});

tenantBackupsRouter.get('/operations', async (c) => {
  const auth = tenantAuth(c.get('adminAuth'));
  const views = await new TenantBackupOperationReadModel(
    requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup')
  ).list(auth.tenantId);
  return c.json({ operations: views });
});

tenantBackupsRouter.get('/:operationId', async (c) => {
  const auth = tenantAuth(c.get('adminAuth'));
  let result;
  try {
    result = await new TenantBackupOperationReadModel(
      requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup')
    ).get(auth.tenantId, c.req.param('operationId'), Date.now());
  } catch {
    return c.json({ error: 'backup_operation_status_unavailable' }, 409);
  }
  if (!result) return c.json({ error: 'backup_operation_not_found' }, 404);
  if (!hasOperationPermission(auth, result.intent))
    return c.json({ error: 'backup_forbidden' }, 403);
  return c.json(result.view);
});

tenantBackupsRouter.get('/:operationId/admin-mappings', async (c) => {
  const auth = tenantAuth(c.get('adminAuth'));
  const database = requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup');
  let result;
  try {
    result = await new TenantBackupOperationReadModel(database).get(
      auth.tenantId,
      c.req.param('operationId'),
      Date.now()
    );
  } catch {
    return c.json({ error: 'backup_admin_mapping_unavailable' }, 409);
  }
  if (!result) return c.json({ error: 'backup_operation_not_found' }, 404);
  if (!hasOperationPermission(auth, result.intent))
    return c.json({ error: 'backup_forbidden' }, 403);
  if (result.intent.kind !== 'import' || !result.intent.selection.admin)
    return c.json({ error: 'backup_admin_mapping_unavailable' }, 409);
  const after = c.req.query('after') ?? '';
  const targetAfter = c.req.query('targetAfter') ?? '';
  try {
    const store = new TenantBackupAdminMappingStore(database);
    const [status, sources, targets] = await Promise.all([
      store.status(auth.tenantId, result.operation.id),
      store.listSources(auth.tenantId, result.operation.id, after),
      store.listTargets(auth.tenantId, targetAfter),
    ]);
    return c.json({ status, sources, targets });
  } catch {
    return c.json({ error: 'backup_admin_mapping_unavailable' }, 409);
  }
});

tenantBackupsRouter.put('/:operationId/admin-mappings', async (c) => {
  const auth = tenantAuth(c.get('adminAuth'));
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return c.json({ error: 'invalid_backup_admin_mapping' }, 400);
  const input = body as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(',') !== 'sourceAdminId,targetAdminId' ||
    typeof input.sourceAdminId !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(input.sourceAdminId) ||
    typeof input.targetAdminId !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(input.targetAdminId)
  )
    return c.json({ error: 'invalid_backup_admin_mapping' }, 400);
  const database = requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup');
  let result;
  try {
    result = await new TenantBackupOperationReadModel(database).get(
      auth.tenantId,
      c.req.param('operationId'),
      Date.now()
    );
  } catch {
    return c.json({ error: 'backup_admin_mapping_conflict' }, 409);
  }
  if (!result) return c.json({ error: 'backup_operation_not_found' }, 404);
  if (!hasOperationPermission(auth, result.intent))
    return c.json({ error: 'backup_forbidden' }, 403);
  if (
    result.intent.kind !== 'import' ||
    !result.intent.selection.admin ||
    result.operation.state !== 'waiting' ||
    result.operation.phase !== 'await_restore_approval'
  )
    return c.json({ error: 'backup_admin_mapping_conflict' }, 409);
  if (
    !(await writeAdminAuditLog(c, {
      action: 'tenant_backup.admin_mapping_requested',
      resourceType: 'tenant_backup',
      resourceId: result.operation.id,
      result: 'success',
      metadata: {
        sourceAdminId: input.sourceAdminId,
        targetAdminId: input.targetAdminId,
      },
    }))
  )
    return c.json({ error: 'backup_audit_unavailable' }, 503);
  try {
    const status = await new TenantBackupAdminMappingStore(database).map({
      tenantId: auth.tenantId,
      operationId: result.operation.id,
      sourceAdminId: input.sourceAdminId,
      targetAdminId: input.targetAdminId,
      actorId: auth.actorId ?? auth.userId,
      now: Date.now(),
    });
    return c.json({ status });
  } catch {
    return c.json({ error: 'backup_admin_mapping_conflict' }, 409);
  }
});

tenantBackupsRouter.post('/:operationId/approve', async (c) => {
  const auth = tenantAuth(c.get('adminAuth'));
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return c.json({ error: 'invalid_backup_approval' }, 400);
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input).sort().join(',');
  if (
    !['adminMappingRevision,planDigest,revision', 'planDigest,revision'].includes(keys) ||
    typeof input.planDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.planDigest) ||
    typeof input.revision !== 'number' ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0
  )
    return c.json({ error: 'invalid_backup_approval' }, 400);
  const database = requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup');
  let result;
  try {
    result = await new TenantBackupOperationReadModel(database).get(
      auth.tenantId,
      c.req.param('operationId'),
      Date.now()
    );
  } catch {
    return c.json({ error: 'backup_restore_preview_stale' }, 409);
  }
  if (!result) return c.json({ error: 'backup_operation_not_found' }, 404);
  if (!hasOperationPermission(auth, result.intent))
    return c.json({ error: 'backup_forbidden' }, 403);
  if (
    result.operation.kind !== 'import' ||
    result.operation.state !== 'waiting' ||
    result.operation.phase !== 'await_restore_approval' ||
    result.operation.revision !== input.revision ||
    result.view.preview?.planDigest !== input.planDigest ||
    !result.view.preview.canApprove
  )
    return c.json({ error: 'backup_restore_preview_stale' }, 409);
  if (
    result.intent.selection.admin &&
    (typeof input.adminMappingRevision !== 'number' ||
      !Number.isSafeInteger(input.adminMappingRevision) ||
      input.adminMappingRevision < 0 ||
      result.view.adminMapping?.revision !== input.adminMappingRevision ||
      !result.view.adminMapping.complete ||
      result.view.adminMapping.state !== 'open')
  )
    return c.json({ error: 'backup_restore_preview_stale' }, 409);
  if (!result.intent.selection.admin && 'adminMappingRevision' in input)
    return c.json({ error: 'invalid_backup_approval' }, 400);
  if (
    !(await writeAdminAuditLog(c, {
      action: 'tenant_backup.restore_approved',
      resourceType: 'tenant_backup',
      resourceId: result.operation.id,
      result: 'success',
      metadata: {
        planDigest: input.planDigest,
        revision: input.revision,
        ...(result.intent.selection.admin
          ? { adminMappingRevision: input.adminMappingRevision }
          : {}),
      },
    }))
  )
    return c.json({ error: 'backup_audit_unavailable' }, 503);
  let operation;
  try {
    operation = result.intent.selection.admin
      ? (
          await new TenantBackupAdminMappingStore(database).approve({
            tenantId: auth.tenantId,
            operationId: result.operation.id,
            actorId: auth.actorId ?? auth.userId,
            operationRevision: result.operation.revision,
            mappingRevision: input.adminMappingRevision as number,
            now: Date.now(),
          })
        ).operation
      : await new TenantBackupOperationStore(database).resumeWaiting(
          auth.tenantId,
          result.operation.id,
          result.operation.revision,
          result.operation.request_digest,
          Date.now()
        );
  } catch {
    return c.json({ error: 'backup_restore_preview_stale' }, 409);
  }
  if (!operation) return c.json({ error: 'backup_restore_preview_stale' }, 409);
  return c.json(
    {
      id: operation.id,
      state: operation.state,
      phase: operation.phase,
      revision: operation.revision,
    },
    202
  );
});

tenantBackupsRouter.get('/:operationId/download', async (c) => {
  const auth = tenantAuth(c.get('adminAuth'));
  if (!hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.BACKUPS_EXPORT))
    return c.json({ error: 'backup_forbidden' }, 403);
  if (!isFreshAdminHuman(auth, Date.now()))
    return c.json({ error: 'backup_fresh_auth_required' }, 403);
  const database = requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup');
  const id = c.req.param('operationId');
  let intent;
  try {
    intent = await new TenantBackupRequestStore(database).load(auth.tenantId, id);
  } catch {
    return c.json({ error: 'backup_operation_not_found' }, 404);
  }
  if (intent.kind !== 'export') return c.json({ error: 'backup_download_unavailable' }, 409);
  if (
    intent.selection.logs.sensitive &&
    !hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.BACKUPS_SENSITIVE)
  )
    return c.json({ error: 'backup_forbidden' }, 403);
  if (!c.env.EXPORT_ARTIFACTS) return c.json({ error: 'backup_storage_unavailable' }, 503);
  let download;
  try {
    download = await openTenantBackupDownload({
      database,
      bucket: c.env.EXPORT_ARTIFACTS,
      tenantId: auth.tenantId,
      operationId: id,
      now: Date.now,
      signal: c.req.raw.signal,
    });
  } catch {
    return c.json({ error: 'backup_download_unavailable' }, 409);
  }
  if (
    !(await writeAdminAuditLog(c, {
      action: 'tenant_backup.download_started',
      resourceType: 'tenant_backup',
      resourceId: id,
      result: 'success',
    }))
  )
    return c.json({ error: 'backup_audit_unavailable' }, 503);
  const iterator = download.chunks[Symbol.asyncIterator]();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await iterator.next();
        if (part.done) controller.close();
        else controller.enqueue(part.value);
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
      'Content-Disposition': `attachment; filename="authrim-${id}.authrim"`,
      'Content-Length': String(download.byteCount),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

tenantBackupsRouter.post('/:operationId/cancel', async (c) => {
  const auth = tenantAuth(c.get('adminAuth'));
  const database = requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup');
  const store = new TenantBackupOperationStore(database);
  const id = c.req.param('operationId');
  if (!(await store.get(auth.tenantId, id)))
    return c.json({ error: 'backup_operation_not_found' }, 404);
  let intent: TenantBackupRequestIntent;
  try {
    intent = await new TenantBackupRequestStore(database).load(auth.tenantId, id);
  } catch {
    return c.json({ error: 'backup_operation_not_found' }, 404);
  }
  if (!hasOperationPermission(auth, intent)) return c.json({ error: 'backup_forbidden' }, 403);
  const evidence = await writeAdminAuditLog(c, {
    action: 'tenant_backup.cancel_requested',
    resourceType: 'tenant_backup',
    resourceId: id,
    result: 'success',
  });
  if (!evidence) return c.json({ error: 'backup_audit_unavailable' }, 503);
  const operation = await store.requestCancel(auth.tenantId, id, Date.now());
  if (!operation) return c.json({ error: 'backup_operation_conflict' }, 409);
  return c.json({ id, state: operation.state }, 202);
});

tenantBackupsRouter.post('/:operationId/key-challenges', async (c) => {
  const auth = tenantAuth(c.get('adminAuth'));
  const id = c.req.param('operationId');
  let intent: TenantBackupRequestIntent;
  try {
    intent = await new TenantBackupRequestStore(
      requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup')
    ).load(auth.tenantId, id);
  } catch {
    return c.json({ error: 'backup_operation_not_found' }, 404);
  }
  if (!hasOperationPermission(auth, intent)) return c.json({ error: 'backup_forbidden' }, 403);
  let inputId: string | undefined;
  const body = await c.req.text();
  if (intent.kind === 'import') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return c.json({ error: 'invalid_backup_key_input' }, 400);
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).join(',') !== 'inputId' ||
      !('inputId' in parsed) ||
      typeof parsed.inputId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(parsed.inputId)
    )
      return c.json({ error: 'invalid_backup_key_input' }, 400);
    inputId = parsed.inputId;
  } else if (body.length) return c.json({ error: 'invalid_backup_key_input' }, 400);
  const keys = await keyStore(c.env);
  if (!keys) return c.json({ error: 'backup_key_service_unavailable' }, 503);
  const evidence = await writeAdminAuditLog(c, {
    action: 'tenant_backup.key_challenge_requested',
    resourceType: 'tenant_backup',
    resourceId: id,
    result: 'success',
  });
  if (!evidence) return c.json({ error: 'backup_audit_unavailable' }, 503);
  try {
    return c.json(
      await keys.issue(auth.tenantId, id, auth.actorId ?? auth.userId, Date.now(), inputId),
      201
    );
  } catch {
    return c.json({ error: 'backup_operation_key_unavailable' }, 409);
  }
});

tenantBackupsRouter.post('/:operationId/key-challenges/:challengeId/accept', async (c) => {
  const auth = tenantAuth(c.get('adminAuth'));
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return c.json({ error: 'invalid_backup_key_input' }, 400);
  const input = body as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    typeof input.envelope !== 'string' ||
    !/^[a-f0-9]{186}$/.test(input.envelope) ||
    typeof input.handoff !== 'string' ||
    !/^[a-f0-9]{512}$/.test(input.handoff)
  )
    return c.json({ error: 'invalid_backup_key_input' }, 400);
  const id = c.req.param('operationId');
  let intent: TenantBackupRequestIntent;
  try {
    intent = await new TenantBackupRequestStore(
      requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup')
    ).load(auth.tenantId, id);
  } catch {
    return c.json({ error: 'backup_operation_not_found' }, 404);
  }
  if (!hasOperationPermission(auth, intent)) return c.json({ error: 'backup_forbidden' }, 403);
  const keys = await keyStore(c.env);
  if (!keys) return c.json({ error: 'backup_key_service_unavailable' }, 503);
  const evidence = await writeAdminAuditLog(c, {
    action: 'tenant_backup.key_accept_requested',
    resourceType: 'tenant_backup',
    resourceId: id,
    result: 'success',
  });
  if (!evidence) return c.json({ error: 'backup_audit_unavailable' }, 503);
  const decode = (value: string) =>
    Uint8Array.from(value.match(/../g) ?? [], (byte) => parseInt(byte, 16));
  try {
    await keys.accept(
      auth.tenantId,
      id,
      auth.actorId ?? auth.userId,
      c.req.param('challengeId'),
      decode(input.envelope),
      decode(input.handoff),
      Date.now()
    );
    return c.json({ accepted: true });
  } catch {
    return c.json({ error: 'backup_operation_key_unavailable' }, 409);
  }
});

tenantBackupsRouter.post('/exports', async (c) => {
  const auth = tenantAuth(c.get('adminAuth'));
  if (!hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.BACKUPS_EXPORT))
    return c.json({ error: 'backup_forbidden' }, 403);
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return c.json({ error: 'invalid_backup_request' }, 400);
  const input = body as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    !Object.hasOwn(input, 'selection') ||
    typeof input.idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(input.idempotencyKey)
  )
    return c.json({ error: 'invalid_backup_request' }, 400);
  let selection;
  try {
    selection = parseTenantBackupSelection(input.selection);
  } catch {
    return c.json({ error: 'invalid_backup_request' }, 400);
  }
  if (
    selection.logs.sensitive &&
    !hasAdminPermission(auth.permissions ?? [], ADMIN_PERMISSIONS.BACKUPS_SENSITIVE)
  )
    return c.json({ error: 'backup_forbidden' }, 403);
  if (!c.env.EXPORT_ARTIFACTS) return c.json({ error: 'backup_storage_unavailable' }, 503);
  if (!(await keyStore(c.env))) return c.json({ error: 'backup_key_service_unavailable' }, 503);
  let issuer: string;
  try {
    issuer = await getCanonicalTenantBaseUrlAsync(c.env, auth.tenantId);
  } catch {
    return c.json({ error: 'backup_source_unavailable' }, 503);
  }
  const actorId = auth.actorId ?? auth.userId;
  const id = await stableOperationId('export', auth.tenantId, actorId, input.idempotencyKey);
  const audit = await writeAdminAuditLog(c, {
    action: 'tenant_backup.export_requested',
    resourceType: 'tenant_backup',
    resourceId: id,
    result: 'success',
    metadata: { selection },
  });
  if (!audit) return c.json({ error: 'backup_audit_unavailable' }, 503);
  const requests = new TenantBackupRequestStore(
    requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup')
  );
  try {
    const operation = await requests.create({
      id,
      tenantId: auth.tenantId,
      actorId,
      idempotencyKey: input.idempotencyKey,
      now: Date.now(),
      intent: {
        version: 1,
        kind: 'export',
        source: { tenantId: auth.tenantId, issuer, productVersion },
        selection,
        inputs: [],
      },
    });
    return c.json(
      {
        id: operation.id,
        kind: operation.kind,
        state: operation.state,
        phase: operation.phase,
        revision: operation.revision,
      },
      201
    );
  } catch {
    return c.json({ error: 'backup_operation_conflict' }, 409);
  }
});

tenantBackupsRouter.post('/:operationId/start', async (c) => {
  const auth = tenantAuth(c.get('adminAuth'));
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return c.json({ error: 'invalid_backup_request' }, 400);
  const input = body as Record<string, unknown>;
  if (
    typeof input.revision !== 'number' ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0
  )
    return c.json({ error: 'invalid_backup_request' }, 400);
  const requests = new TenantBackupRequestStore(
    requireDedicatedAdminDatabaseAdapter(c.env, 'tenant-backup')
  );
  const id = c.req.param('operationId');
  let intent;
  try {
    intent = await requests.load(auth.tenantId, id);
  } catch {
    return c.json({ error: 'backup_operation_not_found' }, 404);
  }
  if (!hasOperationPermission(auth, intent)) return c.json({ error: 'backup_forbidden' }, 403);
  let challengeId: string | undefined;
  let challenges: { inputId: string; challengeId: string }[] | undefined;
  if (intent.kind === 'export') {
    if (
      Object.keys(input).sort().join(',') !== 'challengeId,revision' ||
      typeof input.challengeId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(input.challengeId)
    )
      return c.json({ error: 'invalid_backup_request' }, 400);
    challengeId = input.challengeId;
  } else {
    if (
      Object.keys(input).sort().join(',') !== 'challenges,revision' ||
      !Array.isArray(input.challenges) ||
      input.challenges.length < 1 ||
      input.challenges.length > 32
    )
      return c.json({ error: 'invalid_backup_request' }, 400);
    try {
      challenges = input.challenges.map((value) => {
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          Object.keys(value).sort().join(',') !== 'challengeId,inputId' ||
          !('inputId' in value) ||
          !('challengeId' in value) ||
          typeof value.inputId !== 'string' ||
          typeof value.challengeId !== 'string' ||
          !/^[A-Za-z0-9_.:-]{1,256}$/.test(value.inputId) ||
          !/^[A-Za-z0-9_.:-]{1,256}$/.test(value.challengeId)
        )
          throw new Error('invalid');
        return { inputId: value.inputId, challengeId: value.challengeId };
      });
    } catch {
      return c.json({ error: 'invalid_backup_request' }, 400);
    }
  }
  if (
    intent.source.productVersion !== productVersion ||
    intent.source.tenantId !== auth.tenantId ||
    (intent.kind === 'export' &&
      intent.source.issuer !== (await getCanonicalTenantBaseUrlAsync(c.env, auth.tenantId)))
  )
    return c.json({ error: 'backup_source_changed' }, 409);
  if (
    (intent.kind === 'export' && !c.env.EXPORT_ARTIFACTS) ||
    (intent.kind === 'import' && !c.env.IMPORT_ARTIFACTS)
  )
    return c.json({ error: 'backup_storage_unavailable' }, 503);
  if (intent.kind === 'import') {
    const target = await ensureDatabaseAdapter(c.env.DB, 'tenant-backup-restore-start').queryOne<{
      lifecycle_state: string;
    }>('SELECT lifecycle_state FROM tenants WHERE id=?', [auth.tenantId]);
    if (target?.lifecycle_state !== 'provisioning')
      return c.json({ error: 'backup_restore_target_not_provisioning' }, 409);
  }
  const keys = await keyStore(c.env);
  if (!keys) return c.json({ error: 'backup_key_service_unavailable' }, 503);
  const audit = await writeAdminAuditLog(c, {
    action: 'tenant_backup.start_requested',
    resourceType: 'tenant_backup',
    resourceId: id,
    result: 'success',
  });
  if (!audit) return c.json({ error: 'backup_audit_unavailable' }, 503);
  const common = {
    tenantId: auth.tenantId,
    operationId: id,
    actorId: auth.actorId ?? auth.userId,
    revision: input.revision,
    now: Date.now(),
  };
  let operation;
  if (intent.kind === 'export') {
    if (!challengeId) return c.json({ error: 'invalid_backup_request' }, 400);
    operation = await requests.start({ ...common, challengeId });
  } else {
    if (!challenges) return c.json({ error: 'invalid_backup_request' }, 400);
    operation = await requests.startImport({ ...common, challenges });
  }
  if (!operation) return c.json({ error: 'backup_operation_conflict' }, 409);
  return c.json(
    {
      id: operation.id,
      state: operation.state,
      phase: operation.phase,
      revision: operation.revision,
    },
    202
  );
});
