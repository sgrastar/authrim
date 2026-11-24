/**
 * Admin IP Allowlist Management API
 *
 * Endpoints for managing IP-based access control for Admin panel.
 * When the allowlist is empty, all IPs are allowed (default behavior).
 * When entries exist, only matching IPs can access the Admin panel.
 *
 * Requires the admin:ip_allowlist:* permission.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AdminAuthContext, AdminIpAllowlistEntry } from '@authrim/ar-lib-core';

// Define context type with adminAuth variable
type AdminContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
import {
  AdminIpAllowlistRepository,
  adminIpMatchesRange,
  getAdminRequestClientIp,
  createErrorResponse,
  AR_ERROR_CODES,
  getTenantIdFromContext,
  adminAuthMiddleware,
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  requireDedicatedAdminDatabaseAdapter,
} from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../../admin-shared';

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
  return requireDedicatedAdminDatabaseAdapter(c.env, 'admin-management');
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
  await writeAdminAuditLog(c, {
    action,
    resourceType: 'admin_ip_allowlist',
    resourceId,
    result,
    severity: 'warn', // IP changes are security-sensitive
    metadata,
  });
}

/**
 * The allowlist is a way to lock oneself out: once an enabled entry exists, only the addresses in
 * an enabled range reach the admin console and the Admin API. A change that would leave the
 * caller's own address outside a limit they were not outside of is refused (409 `would_lock_out`)
 * unless the request says `?allow_lockout=true`. It is a guard against a slip, not a security
 * boundary: the check and the write are two steps, so a concurrent change can still pass it.
 */
const LOCKOUT_ERROR = 'would_lock_out';

type RangeEntry = Pick<AdminIpAllowlistEntry, 'ip_range' | 'enabled'>;

/** The address the allowlist judges the caller by (what the middleware enforces with). */
function clientIpOf(c: { req: { header: (name: string) => string | undefined } }): string | null {
  return getAdminRequestClientIp((name) => c.req.header(name));
}

function leavesCallerOutside(
  before: readonly RangeEntry[],
  after: readonly RangeEntry[],
  clientIp: string | null
): boolean {
  // With no address the caller matches no range: they are outside whenever a limit is on. That
  // can only be started here (an active limit refuses a caller with no address already), and a
  // limit started with no address in view shuts them out of the next request.
  const outside = (entries: readonly RangeEntry[]) => {
    const enabled = entries.filter((entry) => entry.enabled);
    return (
      enabled.length > 0 &&
      !enabled.some((entry) => clientIp !== null && adminIpMatchesRange(clientIp, entry.ip_range))
    );
  };
  return outside(after) && !outside(before);
}

/** The body of the refusal (409). */
function lockoutRefusalBody(clientIp: string | null) {
  return {
    error: LOCKOUT_ERROR,
    error_description:
      'This change would leave the current IP address outside the allowlist. Repeat it with allow_lockout=true to continue.',
    current_ip: clientIp,
  };
}

/**
 * Judges a change against the entries as they are now. `refusal` is the body to answer 409 with,
 * or null to go on; `overridden` tells the caller to note in the audit log that the guard was
 * passed on request.
 */
function lockoutGuard(
  c: {
    req: {
      header: (name: string) => string | undefined;
      query: (name: string) => string | undefined;
    };
  },
  before: readonly RangeEntry[],
  after: readonly RangeEntry[]
): { refusal: ReturnType<typeof lockoutRefusalBody> | null; overridden: boolean } {
  const clientIp = clientIpOf(c);
  if (!leavesCallerOutside(before, after, clientIp)) return { refusal: null, overridden: false };
  if (c.req.query('allow_lockout') === 'true') return { refusal: null, overridden: true };
  return { refusal: lockoutRefusalBody(clientIp), overridden: false };
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

    // The address the allowlist judges this caller by.
    const currentIp = clientIpOf(c) ?? 'unknown';

    return c.json({
      items: entries,
      total: entries.length,
      current_ip: currentIp,
      // Only an enabled entry limits anyone; the list may hold disabled ones too.
      restriction_active: entries.some((entry) => entry.enabled),
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
    const tenantId = getTenantIdFromContext(c);

    const id = c.req.param('id');
    const entry = await ipRepo.getEntry(id);

    if (!entry || entry.tenant_id !== tenantId) {
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

    // Validate required fields. The flag is what the lock-out guard judges by, so it must be a
    // boolean, not something that is stored one way and read another.
    if (typeof body.ip_range !== 'string' || !body.ip_range.trim()) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
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

    const current = await ipRepo.getAllEntries(tenantId);
    const guard = lockoutGuard(c, current, [
      ...current,
      { ip_range: body.ip_range.trim(), enabled: body.enabled ?? true },
    ]);
    if (guard.refusal) return c.json(guard.refusal, 409);

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
      ...(guard.overridden ? { lockout_override: true } : {}),
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
    const tenantId = getTenantIdFromContext(c);

    const id = c.req.param('id');

    // Check if entry exists
    const existing = await ipRepo.getEntry(id);
    if (!existing || existing.tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const body = await c.req.json<{
      ip_range?: string;
      description?: string;
      enabled?: boolean;
    }>();

    // What decides who gets in must be what the guard judges: an empty range or a flag that is not
    // a boolean would be stored as given.
    if (
      body.ip_range !== undefined &&
      (typeof body.ip_range !== 'string' || !body.ip_range.trim())
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
    }

    // Validate IP format if being updated
    let ipVersion: 4 | 6 | undefined;
    if (body.ip_range) {
      const validation = validateIpRange(body.ip_range);
      if (!validation.valid) {
        return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST);
      }
      ipVersion = validation.version;
    }

    // A range already listed under another entry is refused, as on create.
    const newRange = body.ip_range?.trim();
    if (
      newRange &&
      newRange !== existing.ip_range &&
      (await ipRepo.entryExists(tenantId, newRange))
    ) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_CONFLICT);
    }

    const current = await ipRepo.getAllEntries(tenantId);
    const guard = lockoutGuard(
      c,
      current,
      current.map((item) =>
        item.id === id
          ? { ip_range: newRange ?? item.ip_range, enabled: body.enabled ?? item.enabled }
          : item
      )
    );
    if (guard.refusal) return c.json(guard.refusal, 409);

    const entry = await ipRepo.updateEntry(id, {
      ip_range: newRange,
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
      ...(guard.overridden ? { lockout_override: true } : {}),
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
    const tenantId = getTenantIdFromContext(c);

    const id = c.req.param('id');

    // Check if entry exists
    const existing = await ipRepo.getEntry(id);
    if (!existing || existing.tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const current = await ipRepo.getAllEntries(tenantId);
    const guard = lockoutGuard(
      c,
      current,
      current.filter((item) => item.id !== id)
    );
    if (guard.refusal) return c.json(guard.refusal, 409);

    await ipRepo.deleteEntry(id);

    // Create audit log
    await createAuditLog(c, 'ip_allowlist.delete', id, 'success', {
      ip_range: existing.ip_range,
      ...(guard.overridden ? { lockout_override: true } : {}),
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
    const tenantId = getTenantIdFromContext(c);

    const id = c.req.param('id');

    const existing = await ipRepo.getEntry(id);
    if (!existing || existing.tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const current = await ipRepo.getAllEntries(tenantId);
    const guard = lockoutGuard(
      c,
      current,
      current.map((item) => (item.id === id ? { ip_range: item.ip_range, enabled: true } : item))
    );
    if (guard.refusal) return c.json(guard.refusal, 409);

    const success = await ipRepo.enableEntry(id);
    if (!success) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Create audit log
    await createAuditLog(
      c,
      'ip_allowlist.enable',
      id,
      'success',
      guard.overridden ? { lockout_override: true } : undefined
    );

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
    const tenantId = getTenantIdFromContext(c);

    const id = c.req.param('id');

    const existing = await ipRepo.getEntry(id);
    if (!existing || existing.tenant_id !== tenantId) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    const current = await ipRepo.getAllEntries(tenantId);
    const guard = lockoutGuard(
      c,
      current,
      current.map((item) => (item.id === id ? { ip_range: item.ip_range, enabled: false } : item))
    );
    if (guard.refusal) return c.json(guard.refusal, 409);

    const success = await ipRepo.disableEntry(id);
    if (!success) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    // Create audit log
    await createAuditLog(
      c,
      'ip_allowlist.disable',
      id,
      'success',
      guard.overridden ? { lockout_override: true } : undefined
    );

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
