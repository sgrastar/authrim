import { createLogReadAdapter, logCoverageHeaders, logPageRequest } from './log-read-adapter';
import { logQueryErrorResponse } from './log-archive-query';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  createPIIContextFromHono,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';
import { requireAccountSession } from './account-page';

type AccountOperationRow = {
  id: string;
  action: string;
  details_json: string | null;
  created_at: number;
};

function setNoStore(c: Context<{ Bindings: Env }>): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function normalizeLimit(value: string | undefined): number {
  const parsed = value ? Number.parseInt(value, 10) : 50;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 50;
  }
  return Math.min(parsed, 100);
}

function parseMetadata(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function listAccountOperationsHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const limit = normalizeLimit(c.req.query('limit'));
  try {
    const page = logPageRequest(c, tenantId, limit);
    const logRead = createLogReadAdapter({
      env: c.env,
      tenantId,
      adapter: authCtx.coreAdapter,
      dataset: 'core.event_log',
      includePendingDeliveries: false,
      onCoverage: logCoverageHeaders(c),
      page: { ...page, scope: JSON.stringify([page.scope, accountSession.userId]) },
    });
    // Session validation has already established the account's routed PII context.
    // Read its current pseudonym only; never create or restore an erased mapping.
    const pii = createPIIContextFromHono(c, tenantId).defaultPiiAdapter;
    const subject = await pii.queryOne<{ anonymized_user_id: string }>(
      'SELECT anonymized_user_id FROM user_anonymization_map WHERE tenant_id = ? AND user_id = ?',
      [tenantId, accountSession.userId],
      { consistencyClass: 'primary_required' }
    );
    const rows = await logRead.adapter.query<AccountOperationRow>(
      `SELECT id, event_type AS action, details_json, created_at
       FROM event_log
      WHERE tenant_id = ? AND anonymized_user_id = ? AND event_type LIKE 'account.%'
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
      [tenantId, subject?.anonymized_user_id ?? null, limit]
    );

    return c.json({
      coverage: logRead.coverage(),
      ...(logRead.pagination() ? { pagination: logRead.pagination() } : {}),
      operations: rows.map((row) => {
        const details = parseMetadata(row.details_json);
        const { source: _source, resourceType, resourceId, ...metadata } = details ?? {};
        return {
          id: row.id,
          action: row.action,
          resource_type: typeof resourceType === 'string' ? resourceType : null,
          resource_id: typeof resourceId === 'string' ? resourceId : null,
          created_at: Math.floor(row.created_at / 1000),
          ...(details && { metadata }),
        };
      }),
    });
  } catch (error) {
    const incomplete = logQueryErrorResponse(c, error);
    if (incomplete) return incomplete;
    throw error;
  }
}
