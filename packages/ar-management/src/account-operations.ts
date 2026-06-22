import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { createAuthContextFromHono, getTenantIdFromContext } from '@authrim/ar-lib-core';
import { requireAccountSession } from './account-page';

type AccountOperationRow = {
  id: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata_json: string | null;
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
  const rows = await authCtx.coreAdapter.query<AccountOperationRow>(
    `SELECT id, action, resource_type, resource_id, metadata_json, created_at
       FROM audit_log
      WHERE tenant_id = ? AND user_id = ? AND action LIKE 'account.%'
      ORDER BY created_at DESC
      LIMIT ?`,
    [tenantId, accountSession.userId, limit]
  );

  return c.json({
    operations: rows.map((row) => {
      const metadata = parseMetadata(row.metadata_json);
      return {
        id: row.id,
        action: row.action,
        resource_type: row.resource_type,
        resource_id: row.resource_id,
        created_at: row.created_at,
        ...(metadata && { metadata }),
      };
    }),
  });
}
