/**
 * Audit Log Utility
 *
 * This module provides utilities for creating audit log entries to track
 * admin operations for compliance and security monitoring.
 *
 * Key features:
 * - Non-blocking: Failures don't stop the main operation
 * - Severity levels: info, warning, critical
 * - Critical operations logged to console for immediate visibility
 */

import type { Context } from 'hono';
import type { Env } from '../types/env';
import type { AuditLogEntry } from '../types/admin';
import { generateSecureRandomString } from './crypto';
import { DEFAULT_TENANT_ID } from './tenant-context';

/**
 * Create an audit log entry in the database
 *
 * This function is non-blocking - if the audit log creation fails,
 * it will log the error but not throw, allowing the main operation to continue.
 *
 * @param env - Cloudflare Workers environment bindings
 * @param entry - Audit log entry data (id, tenantId, and createdAt will be generated/defaulted)
 */
export async function createAuditLog(
  env: Env,
  entry: Omit<AuditLogEntry, 'id' | 'tenantId' | 'createdAt'> & { tenantId?: string }
): Promise<void> {
  try {
    const id = generateSecureRandomString(16);
    const tenantId = entry.tenantId || DEFAULT_TENANT_ID;
    const createdAt = Date.now();

    await env.DB.prepare(
      `INSERT INTO audit_log (
        id, tenant_id, user_id, action, resource, resource_id,
        ip_address, user_agent, metadata, severity, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenantId,
        entry.userId,
        entry.action,
        entry.resource,
        entry.resourceId,
        entry.ipAddress,
        entry.userAgent,
        entry.metadata,
        entry.severity,
        createdAt
      )
      .run();

    // Log critical operations to console for immediate visibility
    if (entry.severity === 'critical') {
      console.warn('[CRITICAL AUDIT]', {
        tenantId,
        action: entry.action,
        userId: entry.userId,
        resource: entry.resource,
        resourceId: entry.resourceId,
        metadata: entry.metadata,
      });
    }
  } catch (error) {
    // Non-blocking: log error but don't fail the main operation
    console.error('Failed to create audit log:', error);
    console.error('Audit log data:', entry);
  }
}

/**
 * Helper function to create audit log from Hono context
 *
 * Automatically extracts tenantId, IP address, and user agent from the request.
 * Requires adminAuth context to be set by adminAuthMiddleware.
 * tenantId is obtained from requestContextMiddleware if available.
 *
 * @param c - Hono context
 * @param action - Action performed (e.g., 'signing_keys.rotate.emergency')
 * @param resource - Resource type (e.g., 'signing_keys')
 * @param resourceId - Resource identifier (e.g., kid)
 * @param metadata - Additional metadata object (will be JSON stringified)
 * @param severity - Severity level (default: 'info')
 */
export async function createAuditLogFromContext(
  c: Context<{ Bindings: Env }>,
  action: string,
  resource: string,
  resourceId: string,
  metadata: Record<string, unknown>,
  severity: 'info' | 'warning' | 'critical' = 'info'
): Promise<void> {
  // Get admin auth context (set by adminAuthMiddleware)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminAuth = (c as any).get('adminAuth') as { userId: string } | undefined;
  if (!adminAuth) {
    console.error('Cannot create audit log: adminAuth context not found');
    return;
  }

  // Get tenantId from request context (set by requestContextMiddleware)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tenantId = ((c as any).get('tenantId') as string | undefined) || DEFAULT_TENANT_ID;

  // Extract IP address (check CF headers first, then fallback)
  const ipAddress =
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    c.req.header('X-Real-IP') ||
    'unknown';

  // Extract user agent
  const userAgent = c.req.header('User-Agent') || 'unknown';

  await createAuditLog(c.env, {
    tenantId,
    userId: adminAuth.userId,
    action,
    resource,
    resourceId,
    ipAddress,
    userAgent,
    metadata: JSON.stringify(metadata),
    severity,
  });
}
