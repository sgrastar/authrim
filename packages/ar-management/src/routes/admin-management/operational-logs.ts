import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AdminAuthContext, Env, OperationalLogStorageOptions } from '@authrim/ar-lib-core';
import {
  adminAuthMiddleware,
  ADMIN_PERMISSIONS,
  AR_ERROR_CODES,
  createErrorResponse,
  getOperationalLog,
  getTenantIdFromContext,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';
import {
  auditAdminSensitiveRead,
  requireAdminPermissionOrElevationGrant,
} from '../../admin-elevation-access';

type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

interface OperationalLogSummaryRow {
  id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  actor_id: string;
  action: string;
  request_id: string | null;
  created_at: number;
  expires_at: number;
  detail_object_catalog_id: string | null;
}

function getAdminAdapter(c: Context<any, any, any>) {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-operational-logs');
}

function getOperationalLogStorageOptions(c: AdminContext): OperationalLogStorageOptions {
  return {
    inlineEncryptionKey: c.env.PII_ENCRYPTION_KEY,
    objectStorage:
      c.env.SENSITIVE_DETAILS && c.env.OBJECT_ENCRYPTION_ROOT_KEY
        ? {
            bucket: c.env.SENSITIVE_DETAILS,
            rootKeyHex: c.env.OBJECT_ENCRYPTION_ROOT_KEY,
          }
        : undefined,
  };
}

export const operationalLogsRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

operationalLogsRouter.use(
  '*',
  adminAuthMiddleware({
    requirePermissions: [ADMIN_PERMISSIONS.OPERATIONAL_LOGS_READ],
  })
);

operationalLogsRouter.get('/', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const tenantId = getTenantIdFromContext(c);
    const subjectType = c.req.query('subject_type');
    const subjectId = c.req.query('subject_id');
    const action = c.req.query('action');
    const actorId = c.req.query('actor_id');
    const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '50', 10), 100));

    const conditions = ['tenant_id = ?', 'expires_at > ?'];
    const bindings: Array<string | number> = [tenantId, Math.floor(Date.now() / 1000)];

    if (subjectType) {
      conditions.push('subject_type = ?');
      bindings.push(subjectType);
    }
    if (subjectId) {
      conditions.push('subject_id = ?');
      bindings.push(subjectId);
    }
    if (action) {
      conditions.push('action = ?');
      bindings.push(action);
    }
    if (actorId) {
      conditions.push('actor_id = ?');
      bindings.push(actorId);
    }

    bindings.push(limit);

    const rows = await adapter.query<OperationalLogSummaryRow>(
      `SELECT id, tenant_id, subject_type, subject_id, actor_id, action, request_id, created_at, expires_at, detail_object_catalog_id
       FROM operational_logs
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
      bindings
    );

    return c.json({
      items: rows.map((row) => ({
        id: row.id,
        tenant_id: row.tenant_id,
        subject_type: row.subject_type,
        subject_id: row.subject_id,
        actor_id: row.actor_id,
        action: row.action,
        request_id: row.request_id,
        created_at: row.created_at,
        expires_at: row.expires_at,
        has_detail: !!row.detail_object_catalog_id,
      })),
      total: rows.length,
    });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

operationalLogsRouter.get('/:id', async (c) => {
    try {
      const id = c.req.param('id')!;
      const access = await requireAdminPermissionOrElevationGrant(c as AdminContext, {
        directPermission: ADMIN_PERMISSIONS.OPERATIONAL_LOGS_DETAIL_READ,
        requestSurface: 'operational_logs',
        requestedAction: 'detail_read',
        resourceClass: 'operational_log_detail',
        resourceIds: [id],
        detailClass: 'reason_detail',
        targetAudience: 'admin_api',
      });
      if (access instanceof Response) {
        return access;
      }
      const adapter = getAdminAdapter(c);
      const tenantId = getTenantIdFromContext(c);
      const entry = await getOperationalLog(
        adapter,
        getOperationalLogStorageOptions(c as AdminContext),
        tenantId,
        id
      );

      if (!entry) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
      }

      await auditAdminSensitiveRead(c as AdminContext, access, {
        action: 'operational_log.detail_read',
        resourceType: 'operational_log',
        resourceId: id,
        metadata: {
          subject_type: entry.subject_type,
          subject_id: entry.subject_id,
          request_id: entry.request_id,
        },
      });

      return c.json(entry);
    } catch {
      return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
    }
});

export default operationalLogsRouter;
