import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { createAuditLog, getLogger, getTenantIdFromContext } from '@authrim/ar-lib-core';

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
  try {
    await createAuditLog(c.env, {
      tenantId,
      userId: input.userId,
      action: input.action,
      resource: input.resourceType ?? 'account',
      resourceId: input.resourceId ?? input.userId,
      ipAddress:
        c.req.header('CF-Connecting-IP') ||
        c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
        c.req.header('X-Real-IP') ||
        'unknown',
      userAgent: c.req.header('User-Agent') || 'unknown',
      metadata: JSON.stringify(input.metadata ?? {}),
      severity: 'info',
    });
  } catch {
    const log = getLogger(c).module('ACCOUNT-OPERATIONS');
    log.warn('Failed to record Account Page operation', {
      action: input.action,
      resourceType: input.resourceType,
    });
  }
}
