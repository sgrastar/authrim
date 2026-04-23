import { Context } from 'hono';
import {
  D1Adapter,
  type DatabaseAdapter,
  getTenantIdFromContext,
  getLogger,
  AdminAuditLogRepository,
  type AdminAuthContext,
} from '@authrim/ar-lib-core';
import type { Env } from '@authrim/ar-lib-core';

export interface ImageTypeInfo {
  mimeType: string;
  extension: string;
}

export const ADMIN_USER_CREATE_RESERVED_FIELDS = new Set([
  'email',
  'name',
  'given_name',
  'family_name',
  'nickname',
  'preferred_username',
  'picture',
  'email_verified',
  'phone_number',
  'phone_number_verified',
  'user_type',
]);

export const ADMIN_USER_UPDATE_RESERVED_FIELDS = new Set([
  'name',
  'given_name',
  'family_name',
  'nickname',
  'preferred_username',
  'email_verified',
  'phone_number',
  'phone_number_verified',
  'picture',
  'user_type',
]);

export const VALID_USER_LIFECYCLE_STATES = new Set([
  'invited',
  'pending_verification',
  'provisioning',
  'incomplete',
  'active',
  'dormant',
  'archived',
  'deprovisioned',
]);

export function extractCustomClaimInput(
  body: Record<string, string | boolean | number | null | undefined>,
  reservedFields: Set<string>
): Record<string, unknown> {
  const customFields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body)) {
    if (reservedFields.has(key)) {
      continue;
    }
    customFields[key] = value;
  }

  return customFields;
}

/**
 * Detect image type from file content using Magic Bytes.
 * Returns null if not a recognized image format.
 */
export function detectImageType(data: Uint8Array): ImageTypeInfo | null {
  if (data.length < 12) return null;

  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }

  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return { mimeType: 'image/png', extension: 'png' };
  }

  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
    return { mimeType: 'image/gif', extension: 'gif' };
  }

  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }

  return null;
}

function getAdminAdapter(c: Context<{ Bindings: Env }>): DatabaseAdapter {
  const db = c.env.DB_ADMIN ?? c.env.DB;
  return new D1Adapter({ db });
}

async function createAdminAuditLog(
  c: Context<{ Bindings: Env }>,
  action: string,
  resourceId: string | null,
  result: 'success' | 'failure',
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    const adminAdapter = getAdminAdapter(c);
    const auditRepo = new AdminAuditLogRepository(adminAdapter);
    const tenantId = getTenantIdFromContext(c);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminAuth = (c as any).get?.('adminAuth') as AdminAuthContext | undefined;

    const ipAddress =
      c.req.header('CF-Connecting-IP') ||
      c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
      'unknown';
    const userAgent = c.req.header('User-Agent') || 'unknown';
    const resourceType = action.startsWith('client.') ? 'client' : 'user';

    await auditRepo.createAuditLog({
      tenant_id: tenantId,
      admin_user_id: adminAuth?.userId || 'system',
      admin_email: adminAuth?.email ?? undefined,
      action,
      resource_type: resourceType,
      resource_id: resourceId ?? undefined,
      result,
      severity: result === 'failure' ? 'warn' : 'info',
      ip_address: ipAddress,
      user_agent: userAgent,
      session_id: adminAuth?.sessionId ?? undefined,
      metadata: metadata ?? undefined,
    });
  } catch (error) {
    const log = getLogger(c).module('ADMIN');
    log.error('Failed to create admin audit log', { action }, error as Error);
  }
}

export function scheduleAdminAuditLog(
  c: Context<{ Bindings: Env }>,
  action: string,
  resourceId: string | null,
  result: 'success' | 'failure',
  metadata?: Record<string, unknown>
): void {
  const promise = createAdminAuditLog(c, action, resourceId, result, metadata);
  c.executionCtx?.waitUntil(promise);
}

/**
 * Sanitize error for logging. Kept for backward compatibility with the existing
 * admin module until all handlers are fully moved to structured logger calls.
 */
export function logSanitizedError(context: string, error: unknown): void {
  const { createLogger } = require('@authrim/ar-lib-core') as {
    createLogger: () => {
      module: (name: string) => {
        error: (msg: string, ctx: Record<string, unknown>, err?: Error) => void;
      };
    };
  };
  const log = createLogger().module('ADMIN');
  if (error instanceof Error) {
    log.error(context, { type: error.name }, error);
  } else {
    log.error(`${context}: Unknown error type`, {});
  }
}

export function parseClientStringArray(value: unknown, fallback: string[] = []): string[] {
  let current: unknown = value;

  for (let i = 0; i < 3; i++) {
    if (typeof current !== 'string') {
      break;
    }

    const trimmed = current.trim();
    if (!trimmed) {
      return fallback;
    }

    if (
      !(
        (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
      )
    ) {
      break;
    }

    try {
      current = JSON.parse(trimmed);
    } catch {
      break;
    }
  }

  if (Array.isArray(current)) {
    if (current.every((item) => typeof item === 'string' && item.length === 1)) {
      return parseClientStringArray(current.join(''), fallback);
    }

    return current
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  if (typeof current === 'string') {
    const trimmed = current.trim();
    if (!trimmed) {
      return fallback;
    }

    if (trimmed.includes(',')) {
      return trimmed
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }

    return [trimmed];
  }

  return fallback;
}

export function isCharArrayLike(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.length === 1)
  );
}

export function getErrorDetailsForResponse(error: unknown, env: Env): { details?: string } {
  const isDevelopment = env.ENVIRONMENT !== 'production' && env.NODE_ENV !== 'production';
  if (isDevelopment) {
    return {
      details: error instanceof Error ? error.message : String(error),
    };
  }
  return {};
}

export function toMilliseconds(timestamp: number | null | undefined): number | null {
  if (!timestamp) return null;
  if (timestamp < 1e12) {
    return timestamp * 1000;
  }
  return timestamp;
}

export function toSeconds(timestamp: number | null | undefined): number | null {
  if (!timestamp) return null;
  if (timestamp >= 1e12) {
    return Math.floor(timestamp / 1000);
  }
  return timestamp;
}
