/**
 * SCIM Audit Log Utility
 *
 * Provides non-blocking audit logging for SCIM operations.
 * Uses 'scim-service' as userId to indicate machine-to-machine operation.
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { createAuditLog } from '@authrim/ar-lib-core';

/**
 * SCIM resource types for audit logging
 */
export type ScimAuditResource = 'scim_user' | 'scim_group' | 'scim_token';

/**
 * SCIM audit action types
 */
export type ScimAuditAction =
  | 'scim.user.create'
  | 'scim.user.replace'
  | 'scim.user.patch'
  | 'scim.user.delete'
  | 'scim.group.create'
  | 'scim.group.replace'
  | 'scim.group.patch'
  | 'scim.group.delete'
  | 'scim.bulk.execute'
  | 'scim.token.create'
  | 'scim.token.revoke';

/**
 * Create audit log from SCIM context.
 *
 * Unlike adminAuth context, SCIM uses Bearer token authentication.
 * The userId is set to 'scim-service' to indicate machine-to-machine operation.
 *
 * This function is non-blocking - errors are logged but don't fail the main operation.
 *
 * @param c - Hono context
 * @param action - SCIM action type (e.g., 'scim.user.create')
 * @param resource - Resource type ('scim_user', 'scim_group', 'scim_token')
 * @param resourceId - ID of the resource being operated on
 * @param metadata - Additional metadata (will be JSON stringified)
 * @param severity - Severity level (default: 'info')
 */
export async function createScimAuditLog(
  c: Context<{ Bindings: Env }>,
  action: ScimAuditAction,
  resource: ScimAuditResource,
  resourceId: string,
  metadata: Record<string, unknown>,
  severity: 'info' | 'warning' | 'critical' = 'info'
): Promise<void> {
  // Get tenantId from context (set by requestContextMiddleware).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tenantId = ((c as any).get?.('tenantId') as string | undefined)?.trim();
  if (!tenantId) {
    return;
  }

  // Extract IP address (Cloudflare-aware)
  const ipAddress =
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    c.req.header('X-Real-IP') ||
    'unknown';

  // Extract user agent
  const userAgent = c.req.header('User-Agent') || 'unknown';

  await createAuditLog(c.env, {
    tenantId,
    userId: 'scim-service', // Machine-to-machine operation identifier
    action,
    resource,
    resourceId,
    ipAddress,
    userAgent,
    metadata: JSON.stringify(metadata),
    severity,
  });
}

/**
 * Non-blocking wrapper for createScimAuditLog
 *
 * Use this when you want to fire-and-forget the audit log without awaiting.
 * Errors are silently caught to ensure the main operation is not affected.
 *
 * @example
 * ```typescript
 * // Fire and forget - won't block or throw
 * logScimAudit(c, 'scim.user.create', 'scim_user', userId, { externalId });
 * ```
 */
export function logScimAudit(
  c: Context<{ Bindings: Env }>,
  action: ScimAuditAction,
  resource: ScimAuditResource,
  resourceId: string,
  metadata: Record<string, unknown>,
  severity: 'info' | 'warning' | 'critical' = 'info'
): void {
  createScimAuditLog(c, action, resource, resourceId, metadata, severity).catch(() => {
    // Silently ignore errors - audit log failures should not affect SCIM operations
  });
}
