/**
 * Admin IP Allowlist Management API
 *
 * Endpoints for managing IP-based access control for Admin panel.
 * When the allowlist is empty, all IPs are allowed (default behavior).
 * When entries exist, only matching IPs can access the Admin panel.
 *
 * Requires super_admin role or admin:ip_allowlist:* permission.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AdminAuthContext } from '@authrim/ar-lib-core';

// Define context type with adminAuth variable
type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
import {
  D1Adapter,
  AdminIpAllowlistRepository,
  AdminAuditLogRepository,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  adminAuthMiddleware,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
} from '@authrim/ar-lib-core';

// Create router
export const ipAllowlistRouter = new Hono<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>();

// Apply admin authentication to all routes
ipAllowlistRouter.use(
  '*',
  adminAuthMiddleware({
    requirePermissions: [ADMIN_PERMISSIONS.IP_ALLOWLIST_READ],
  })
);

/**
 * Helper to get DB_ADMIN adapter
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAdminAdapter(c: Context<any, any, any>) {
  if (!c.env.DB_ADMIN) {
    throw new Error('DB_ADMIN is not configured');
  }
  return new D1Adapter({ db: c.env.DB_ADMIN });
}

/**
 * Helper to check write permission
 */
function hasWritePermission(authContext: AdminAuthContext): boolean {
  const permissions = authContext.permissions || [];
  return hasAdminPermission(permissions, ADMIN_PERMISSIONS.IP_ALLOWLIST_WRITE);
}

/**
 * Create audit log entry
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createAuditLog(
  c: Context<any, any, any>,
  action: string,
  resourceId: string,
  result: 'success' | 'failure',
  metadata?: Record<string, unknown>
): Promise<void> {
  const authContext = c.get('adminAuth') as AdminAuthContext;
  const adapter = getAdminAdapter(c);
  const auditRepo = new AdminAuditLogRepository(adapter);
  const tenantId = getTenantIdFromContext(c);

  await auditRepo.createAuditLog({
    tenant_id: tenantId,
    admin_user_id: authContext.userId,
    admin_email: authContext.email,
    action,
    resource_type: 'admin_ip_allowlist',
    resource_id: resourceId,
    result,
    severity: 'warn', // IP changes are security-sensitive
    ip_address: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined,
    user_agent: c.req.header('user-agent') || undefined,
    metadata,
  });
}

/**
 * Validate IP address or CIDR notation
 */
function validateIpRange(ipRange: string): { valid: boolean; error?: string; version?: 4 | 6 } {
  // Remove whitespace
  const trimmed = ipRange.trim();

  // Check for CIDR notation
  const cidrMatch = trimmed.match(/^(.+)\/(\d+)$/);

  if (cidrMatch) {
    const [, ip, prefixStr] = cidrMatch;
    const prefix = parseInt(prefixStr, 10);

    // IPv6
    if (ip.includes(':')) {
      if (prefix < 0 || prefix > 128) {
        return { valid: false, error: 'IPv6 CIDR prefix must be between 0 and 128' };
      }
      if (!isValidIpv6(ip)) {
        return { valid: false, error: 'Invalid IPv6 address' };
      }
      return { valid: true, version: 6 };
    }

    // IPv4
    if (prefix < 0 || prefix > 32) {
      return { valid: false, error: 'IPv4 CIDR prefix must be between 0 and 32' };
    }
    if (!isValidIpv4(ip)) {
      return { valid: false, error: 'Invalid IPv4 address' };
    }
    return { valid: true, version: 4 };
  }

  // Single IP address
  if (trimmed.includes(':')) {
    if (!isValidIpv6(trimmed)) {
      return { valid: false, error: 'Invalid IPv6 address' };
    }
    return { valid: true, version: 6 };
  }

  if (!isValidIpv4(trimmed)) {
    return { valid: false, error: 'Invalid IPv4 address' };
  }
  return { valid: true, version: 4 };
}

/**
 * Validate IPv4 address
 */
function isValidIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;

  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return false;
    if (part !== num.toString()) return false; // No leading zeros
  }

  return true;
}

/**
 * Validate IPv6 address (simplified)
 */
function isValidIpv6(ip: string): boolean {
  // Check for double colon (::) - only allowed once
  const doubleColonCount = (ip.match(/::/g) || []).length;
  if (doubleColonCount > 1) return false;

  // Remove leading/trailing colons for validation
  const normalized = ip.replace(/^::|::$/g, '');

  // Check each segment
  const segments = normalized.split(':').filter((s) => s !== '');

  // With :: we need 1-7 segments, without we need exactly 8
  if (doubleColonCount === 0 && segments.length !== 8) return false;
  if (doubleColonCount === 1 && segments.length > 7) return false;

  for (const segment of segments) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(segment)) return false;
  }

  return true;
}

/**
 * GET /api/admin/ip-allowlist
 * List all IP allowlist entries
 */
ipAllowlistRouter.get('/', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const ipRepo = new AdminIpAllowlistRepository(adapter);
    const tenantId = getTenantIdFromContext(c);

    const includeDisabled = c.req.query('include_disabled') === 'true';

    const entries = includeDisabled
      ? await ipRepo.getAllEntries(tenantId)
      : await ipRepo.getEnabledEntries(tenantId);

    // Get current client IP for reference
    const currentIp =
      c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';

    return c.json({
      items: entries,
      total: entries.length,
      current_ip: currentIp,
      restriction_active: entries.length > 0,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * GET /api/admin/ip-allowlist/:id
 * Get IP allowlist entry details
 */
ipAllowlistRouter.get('/:id', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const ipRepo = new AdminIpAllowlistRepository(adapter);

    const id = c.req.param('id');
    const entry = await ipRepo.getEntry(id);

    if (!entry) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    return c.json(entry);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/ip-allowlist
 * Add a new IP allowlist entry
 */
ipAllowlistRouter.post('/', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasWritePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const ipRepo = new AdminIpAllowlistRepository(adapter);
    const tenantId = getTenantIdFromContext(c);

    const body = await c.req.json<{
      ip_range: string;
      description?: string;
      enabled?: boolean;
    }>();

    // Validate required fields
    if (!body.ip_range) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    // Validate IP format
    const validation = validateIpRange(body.ip_range);
    if (!validation.valid) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    // Check if entry already exists
    const exists = await ipRepo.entryExists(tenantId, body.ip_range.trim());
    if (exists) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }

    // Warn if adding an entry would lock out current IP
    const currentIp = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for');
    const existingEntries = await ipRepo.getEnabledEntries(tenantId);

    // If this is the first entry, warn about self-lockout
    if (existingEntries.length === 0 && currentIp) {
      const wouldMatch = await ipRepo.isIpAllowed(tenantId, currentIp);
      // After adding the entry, would the current IP still be allowed?
      // This is a simplified check - the actual check would need to include the new entry
    }

    const entry = await ipRepo.createEntry({
      tenant_id: tenantId,
      ip_range: body.ip_range.trim(),
      ip_version: validation.version,
      description: body.description,
      enabled: body.enabled ?? true,
      created_by: authContext.userId,
    });

    // Create audit log
    await createAuditLog(c, 'ip_allowlist.create', entry.id, 'success', {
      ip_range: entry.ip_range,
      ip_version: entry.ip_version,
    });

    return c.json(entry, 201);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * PATCH /api/admin/ip-allowlist/:id
 * Update an IP allowlist entry
 */
ipAllowlistRouter.patch('/:id', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasWritePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const ipRepo = new AdminIpAllowlistRepository(adapter);

    const id = c.req.param('id');

    // Check if entry exists
    const existing = await ipRepo.getEntry(id);
    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const body = await c.req.json<{
      ip_range?: string;
      description?: string;
      enabled?: boolean;
    }>();

    // Validate IP format if being updated
    let ipVersion: 4 | 6 | undefined;
    if (body.ip_range) {
      const validation = validateIpRange(body.ip_range);
      if (!validation.valid) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
      }
      ipVersion = validation.version;
    }

    const entry = await ipRepo.updateEntry(id, {
      ip_range: body.ip_range?.trim(),
      ip_version: ipVersion,
      description: body.description,
      enabled: body.enabled,
    });

    if (!entry) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Create audit log
    await createAuditLog(c, 'ip_allowlist.update', id, 'success', {
      changes: body,
    });

    return c.json(entry);
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * DELETE /api/admin/ip-allowlist/:id
 * Delete an IP allowlist entry
 */
ipAllowlistRouter.delete('/:id', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasWritePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const ipRepo = new AdminIpAllowlistRepository(adapter);

    const id = c.req.param('id');

    // Check if entry exists
    const existing = await ipRepo.getEntry(id);
    if (!existing) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    await ipRepo.deleteEntry(id);

    // Create audit log
    await createAuditLog(c, 'ip_allowlist.delete', id, 'success', {
      ip_range: existing.ip_range,
    });

    return c.json({ success: true, message: 'IP allowlist entry deleted' });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/ip-allowlist/:id/enable
 * Enable an IP allowlist entry
 */
ipAllowlistRouter.post('/:id/enable', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasWritePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const ipRepo = new AdminIpAllowlistRepository(adapter);

    const id = c.req.param('id');

    const success = await ipRepo.enableEntry(id);
    if (!success) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Create audit log
    await createAuditLog(c, 'ip_allowlist.enable', id, 'success');

    return c.json({ success: true, message: 'IP allowlist entry enabled' });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/ip-allowlist/:id/disable
 * Disable an IP allowlist entry
 */
ipAllowlistRouter.post('/:id/disable', async (c) => {
  const authContext = c.get('adminAuth') as AdminAuthContext;

  if (!hasWritePermission(authContext)) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
  }

  try {
    const adapter = getAdminAdapter(c);
    const ipRepo = new AdminIpAllowlistRepository(adapter);

    const id = c.req.param('id');

    const success = await ipRepo.disableEntry(id);
    if (!success) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Create audit log
    await createAuditLog(c, 'ip_allowlist.disable', id, 'success');

    return c.json({ success: true, message: 'IP allowlist entry disabled' });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/admin/ip-allowlist/check
 * Check if an IP address is allowed
 */
ipAllowlistRouter.post('/check', async (c) => {
  try {
    const adapter = getAdminAdapter(c);
    const ipRepo = new AdminIpAllowlistRepository(adapter);
    const tenantId = getTenantIdFromContext(c);

    const body = await c.req.json<{ ip: string }>();

    if (!body.ip) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    const isAllowed = await ipRepo.isIpAllowed(tenantId, body.ip);
    const entryCount = await ipRepo.countEntries(tenantId);

    return c.json({
      ip: body.ip,
      allowed: isAllowed,
      restriction_active: entryCount > 0,
      entry_count: entryCount,
    });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

export default ipAllowlistRouter;
