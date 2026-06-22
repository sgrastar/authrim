import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  getLogger,
  getTenantIdFromContext,
} from '@authrim/ar-lib-core';

export async function recordAccountOperation(
  c: Context<{ Bindings: Env }>,
  input: {
    userId: string;
    action: string;
    resourceType?: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const tenantId = getTenantIdFromContext(c);
  const authCtx = createAuthContextFromHono(c, tenantId);
  try {
    await authCtx.coreAdapter.execute(
      `INSERT INTO audit_log (
         id, tenant_id, user_id, action, resource_type, resource_id,
         ip_address, user_agent, metadata_json, created_at, severity
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        tenantId,
        input.userId,
        input.action,
        input.resourceType ?? null,
        input.resourceId ?? null,
        null,
        null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        Math.floor(Date.now() / 1000),
        'info',
      ]
    );
  } catch {
    const log = getLogger(c).module('ACCOUNT-OPERATIONS');
    log.warn('Failed to record Account Page operation', {
      action: input.action,
      resourceType: input.resourceType,
    });
  }
}
