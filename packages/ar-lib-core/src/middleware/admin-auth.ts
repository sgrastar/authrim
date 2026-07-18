/**
 * Admin Authentication Middleware
 *
 * This middleware provides Admin UI session authentication for admin endpoints.
 * Machine/Admin API bearer access is intentionally not backed by static root
 * secrets; it is added through scoped Admin Machine Access tokens.
 *
 * Admin/EndUser Separation:
 * - Admin users are stored in DB_ADMIN (separate from EndUsers in DB_CORE)
 * - Admin sessions are stored in admin_sessions table (not Durable Objects)
 * - Admin roles/permissions are from admin_role_assignments + admin_roles
 *
 * Security features:
 * - Admin role verification for session auth
 * - Sets adminAuth context for downstream handlers
 * - Configurable role requirements via requireRoles option
 * - IP restriction support (via admin_ip_allowlist)
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types/env';
import type { AdminAuthContext } from '../types/admin';
import type { DatabaseAdapter } from '../db/adapter';
import { requireAdminDatabaseAdapter } from '../services/admin-database-adapter';
import { createLogger } from '../utils/logger';
import { hasAdminPermission } from '../types/admin-user';
import { buildRequestIssuerUrl, getDefaultTenantId } from '../utils/issuer';
import { resolveTenantFromRequest } from '../utils/tenant-context';
import { parseTokenHeader, verifyToken } from '../utils/jwt';
import {
  AdminMachineAccessRepository,
  type AdminMachineTenantScope,
} from '../repositories/admin/admin-machine-access';
import { importJWK, type CryptoKey, type JWK, type JWTPayload } from 'jose';

const log = createLogger().module('ADMIN-AUTH');
const ADMIN_API_AUDIENCE = 'authrim:admin-api';
const ADMIN_UI_BFF_MODE_HEADER = 'X-Authrim-Admin-UI-Api-Mode';
const ADMIN_UI_BFF_MODE_VALUE = 'cross-site-proxy-bff';

interface AdminAuthRoleRow {
  id: string;
  name: string;
  permissions_json: string;
  hierarchy_level: number;
  inherits_from: string | null;
  has_global_scope?: number;
}

/**
 * Options for admin authentication middleware
 */
export interface AdminAuthOptions {
  /**
   * Admin authentication plane.
   *
   * tenant: session tenant must match the request tenant resolved from host/context.
   * platform: system/internal endpoints are not tied to a tenant host.
   *
   * Default: tenant
   */
  plane?: 'tenant' | 'platform';

  /**
   * Optional same-origin login redirect for browser GET journeys. The caller owns validation of
   * the returned location. API and mutation routes should leave this unset.
   */
  unauthenticatedRedirect?: (c: Context<{ Bindings: Env }>) => string | undefined;

  /**
   * Required roles for access. User must have at least one of these roles.
   * Default: ['super_admin', 'security_admin', 'admin', 'support', 'viewer']
   */
  requireRoles?: string[];

  /**
   * Required permissions for access. User must have all of these permissions.
   * If specified, this takes precedence over requireRoles.
   * Example: ['admin:users:read', 'admin:users:write']
   */
  requirePermissions?: string[];

  /**
   * Skip IP allowlist check (default: false)
   * Set to true for endpoints that need to work from any IP (e.g., initial setup)
   */
  skipIpCheck?: boolean;

  /**
   * Require MFA to be verified for this session (default: false)
   */
  requireMfa?: boolean;

  /**
   * Require an Admin UI session to establish the actor (default: false).
   *
   * This is intended for browser authorization journeys such as Admin Agent OAuth. A scoped
   * machine bearer token may still be used as BFF transport authentication, but it can never
   * replace the human admin session as the primary actor.
   */
  sessionOnly?: boolean;

  /**
   * Optional owner-package verifier for a signed bearer token type that ar-lib-core must not
   * depend on directly. The callback must fully verify the token and return a bounded context.
   */
  authenticateBearer?: (
    c: Context<{ Bindings: Env }>,
    token: string,
    tenantId: string
  ) => Promise<AdminAuthContext | null>;
}

function parsePermissionsJson(value: string): string[] {
  try {
    const permissions = JSON.parse(value) as unknown;
    return Array.isArray(permissions)
      ? permissions.filter((permission): permission is string => typeof permission === 'string')
      : [];
  } catch {
    return [];
  }
}

function collectInheritedRolePermissions(
  role: AdminAuthRoleRow,
  rolesById: Map<string, AdminAuthRoleRow>,
  permissions: Set<string>,
  visitedIds: Set<string> = new Set()
): void {
  if (visitedIds.has(role.id)) {
    return;
  }
  visitedIds.add(role.id);

  for (const permission of parsePermissionsJson(role.permissions_json)) {
    permissions.add(permission);
  }

  if (!role.inherits_from) {
    return;
  }
  const parent = rolesById.get(role.inherits_from);
  if (parent) {
    collectInheritedRolePermissions(parent, rolesById, permissions, visitedIds);
  }
}

async function getAdminAccessTokenVerificationKey(
  env: Env,
  tenantId: string,
  kid?: string
): Promise<CryptoKey> {
  const publicJwkJson = env.PUBLIC_JWK_JSON;
  if (publicJwkJson) {
    const publicJwk = JSON.parse(publicJwkJson) as JWK;
    if (!kid || !publicJwk.kid || publicJwk.kid === kid) {
      return importJWK(publicJwk, 'RS256') as Promise<CryptoKey>;
    }
  }

  if (!env.KEY_MANAGER) {
    throw new Error('KEY_MANAGER binding not available');
  }

  const keyManagerId = env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
  const keyManager = env.KEY_MANAGER.get(keyManagerId);
  const publicKeys = (await keyManager.getAllPublicKeysRpc()) as JWK[];
  const publicJwk = kid
    ? publicKeys.find((key) => key.kid === kid)
    : publicKeys.find((key) => key.kty);
  if (!publicJwk) {
    throw new Error('No matching Admin API token verification key found');
  }
  return importJWK(publicJwk, 'RS256') as Promise<CryptoKey>;
}

function hasTenantScope(authContext: AdminAuthContext, tenantId: string): boolean {
  if (!authContext.tenantScope && authContext.authMethod !== 'machine_access_token') {
    return true;
  }
  const tenantScope = authContext.tenantScope ?? [];
  return tenantScope.includes('*') || tenantScope.includes(tenantId);
}

function stringArrayClaim(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function intersectMachinePermissionSets(
  principalPermissions: string[],
  credentialPermissions: string[]
): string[] {
  const result = new Set<string>();
  for (const principalPermission of principalPermissions) {
    for (const credentialPermission of credentialPermissions) {
      if (hasAdminPermission([principalPermission], credentialPermission)) {
        result.add(credentialPermission);
      } else if (hasAdminPermission([credentialPermission], principalPermission)) {
        result.add(principalPermission);
      }
    }
  }
  return Array.from(result);
}

function resolveMachineTenantScope(
  principalScopes: AdminMachineTenantScope[],
  credentialScopes: AdminMachineTenantScope[]
): string[] {
  const effectiveCredentialScopes =
    credentialScopes.length > 0 ? credentialScopes : principalScopes;
  const principalAll = principalScopes.some((scope) => scope.scopeMode === 'all');
  const credentialAll = effectiveCredentialScopes.some((scope) => scope.scopeMode === 'all');

  if (principalAll && credentialAll) {
    return ['*'];
  }

  const principalTenants = principalAll
    ? null
    : new Set(
        principalScopes
          .filter((scope) => scope.scopeMode === 'allow' && scope.tenantId)
          .map((scope) => scope.tenantId as string)
      );
  const credentialTenants = credentialAll
    ? null
    : new Set(
        effectiveCredentialScopes
          .filter((scope) => scope.scopeMode === 'allow' && scope.tenantId)
          .map((scope) => scope.tenantId as string)
      );

  if (principalTenants === null) {
    return Array.from(credentialTenants ?? []);
  }
  if (credentialTenants === null) {
    return Array.from(principalTenants);
  }

  return Array.from(principalTenants).filter((tenantId) => credentialTenants.has(tenantId));
}

function isSubsetOfTenantScope(claimTenantScope: string[], currentTenantScope: string[]): boolean {
  if (claimTenantScope.includes('*')) {
    return currentTenantScope.includes('*');
  }
  if (currentTenantScope.includes('*')) {
    return true;
  }
  const current = new Set(currentTenantScope);
  return claimTenantScope.every((tenantId) => current.has(tenantId));
}

function isAdminUiBffTransportRequest(c: Context<{ Bindings: Env }>): boolean {
  return c.req.header(ADMIN_UI_BFF_MODE_HEADER) === ADMIN_UI_BFF_MODE_VALUE;
}

function toTransportAuthContext(
  authContext: AdminAuthContext
): NonNullable<AdminAuthContext['transportAuth']> {
  return {
    authMethod: 'machine_access_token',
    actorType: 'machine',
    actorId: authContext.actorId ?? authContext.userId,
    principalType: authContext.principalType,
    credentialId: authContext.credentialId ?? '',
    clientId: authContext.clientId,
    clientAuthMethod: authContext.clientAuthMethod,
    credentialStrength: authContext.credentialStrength,
    senderConstrained: authContext.senderConstrained,
    tenantScope: authContext.tenantScope,
    permissions: authContext.permissions,
  };
}

async function authenticateMachineAccessToken(
  c: Context<{ Bindings: Env }>,
  token: string,
  tenantId: string
): Promise<AdminAuthContext | null> {
  try {
    const header = parseTokenHeader(token);
    const publicKey = await getAdminAccessTokenVerificationKey(c.env, tenantId, header.kid);
    const issuer = buildRequestIssuerUrl(c.req.raw, c.env, tenantId);
    const payload = (await verifyToken(token, publicKey, issuer, {
      audience: ADMIN_API_AUDIENCE,
    })) as JWTPayload & Record<string, unknown>;

    if (payload.actor_type !== 'machine') {
      return null;
    }
    if (typeof payload.actor_id !== 'string' || !payload.actor_id) {
      return null;
    }
    if (typeof payload.credential_id !== 'string' || !payload.credential_id) {
      return null;
    }
    if (typeof payload.scope !== 'string') {
      return null;
    }

    const adminAdapter: DatabaseAdapter = requireAdminDatabaseAdapter(
      c.env,
      'admin-machine-access'
    );
    const machineRepo = new AdminMachineAccessRepository(adminAdapter);
    const principal = await machineRepo.findPrincipalById(payload.actor_id);
    const credential = await machineRepo.findCredentialById(payload.credential_id);
    if (!principal || !credential) {
      return null;
    }
    if (principal.status !== 'active') {
      return null;
    }
    if (credential.status !== 'active' && credential.status !== 'rotating') {
      return null;
    }
    if (credential.principalId !== principal.id) {
      return null;
    }

    const tokenPermissions = payload.scope.split(/\s+/).filter((scope) => scope.length > 0);
    const [
      principalPermissions,
      credentialPermissions,
      principalTenantScopes,
      credentialTenantScopes,
    ] = await Promise.all([
      machineRepo.getPrincipalPermissions(principal.id),
      machineRepo.getCredentialPermissions(credential.id),
      machineRepo.getPrincipalTenantScopes(principal.id),
      machineRepo.getCredentialTenantScopes(credential.id),
    ]);
    const currentPermissions =
      credentialPermissions.length > 0
        ? intersectMachinePermissionSets(principalPermissions, credentialPermissions)
        : principalPermissions;
    if (tokenPermissions.some((scope) => !hasAdminPermission(currentPermissions, scope))) {
      return null;
    }

    const tenantScope = stringArrayClaim(payload.tenant_scope);
    const currentTenantScope = resolveMachineTenantScope(
      principalTenantScopes,
      credentialTenantScopes
    );
    if (!isSubsetOfTenantScope(tenantScope, currentTenantScope)) {
      return null;
    }

    return {
      userId: principal.id,
      actorType: 'machine',
      actorId: principal.id,
      principalType: principal.principalType,
      clientId: principal.clientId,
      credentialId: credential.id,
      authMethod: 'machine_access_token',
      roles: [],
      tenantId,
      permissions: tokenPermissions,
      hierarchyLevel: 0,
      mfaVerified: false,
      clientAuthMethod:
        payload.client_auth_method === 'private_key_jwt' ? 'private_key_jwt' : undefined,
      credentialStrength:
        payload.credential_strength === 'asymmetric_key' ? 'asymmetric_key' : undefined,
      senderConstrained: payload.sender_constrained === true,
      tenantScope,
    };
  } catch (error) {
    log.debug('Admin machine access token authentication failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Authenticate using session cookie
 *
 * Validates session from DB_ADMIN and checks for admin roles.
 * Uses admin_sessions and admin_role_assignments tables.
 *
 * @param c - Hono context
 * @param sessionId - Session ID from cookie
 * @param requiredRoles - Roles required for access (user must have at least one)
 * @returns AdminAuthContext if valid, null otherwise
 */
async function authenticateSession(
  c: Context<{ Bindings: Env }>,
  sessionId: string,
  requiredRoles: string[] = ['super_admin', 'security_admin', 'admin', 'support', 'viewer'],
  targetTenantId?: string
): Promise<AdminAuthContext | null> {
  try {
    const adminAdapter: DatabaseAdapter = requireAdminDatabaseAdapter(c.env, 'admin-auth');
    const now = Date.now();

    // Fetch session from admin_sessions
    const session = await adminAdapter.queryOne<{
      id: string;
      tenant_id: string;
      admin_user_id: string;
      expires_at: number;
      mfa_verified: number;
      mfa_verified_at: number | null;
      created_at: number;
    }>('SELECT * FROM admin_sessions WHERE id = ? AND expires_at > ?', [sessionId, now]);

    if (!session) {
      log.debug('Admin session not found or expired', { sessionId: sessionId.substring(0, 8) });
      return null;
    }

    // Fetch admin user
    const adminUser = await adminAdapter.queryOne<{
      id: string;
      tenant_id: string;
      email: string;
      is_active: number;
      status: string;
    }>('SELECT * FROM admin_users WHERE id = ? AND tenant_id = ? AND is_active = 1', [
      session.admin_user_id,
      session.tenant_id,
    ]);

    if (!adminUser) {
      log.debug('Admin user not found or inactive', { userId: session.admin_user_id });
      return null;
    }

    // Check if account is locked or suspended
    if (adminUser.status !== 'active') {
      log.warn('Admin account is not active', { userId: adminUser.id, status: adminUser.status });
      return null;
    }

    const effectiveTargetTenantId = targetTenantId || session.tenant_id;

    // Fetch effective roles for this Admin user. Global assignments are platform-wide.
    // Tenant assignments only apply to the requested tenant; legacy NULL scope_id only
    // applies to the assignment tenant for backward compatibility.
    const rolesResult = await adminAdapter.query<AdminAuthRoleRow>(
      `SELECT
         r.id,
         r.name,
         r.permissions_json,
         r.hierarchy_level,
         r.inherits_from,
         MAX(CASE WHEN ra.scope_type = 'global' THEN 1 ELSE 0 END) as has_global_scope
       FROM admin_role_assignments ra
       JOIN admin_roles r ON ra.admin_role_id = r.id
       WHERE ra.admin_user_id = ?
         AND ra.tenant_id = ?
         AND (
           r.tenant_id = ?
           OR (r.tenant_id = 'default' AND r.is_system = 1)
         )
         AND (
           ra.scope_type = 'global'
           OR (
             ra.scope_type = 'tenant'
             AND (
               ra.scope_id = ?
               OR (ra.scope_id IS NULL AND ? = ra.tenant_id)
             )
           )
         )
         AND (ra.expires_at IS NULL OR ra.expires_at > ?)
       GROUP BY r.id, r.name, r.permissions_json, r.hierarchy_level, r.inherits_from
       ORDER BY r.hierarchy_level DESC`,
      [
        session.admin_user_id,
        session.tenant_id,
        session.tenant_id,
        effectiveTargetTenantId,
        effectiveTargetTenantId,
        now,
      ]
    );
    const allTenantRoles = await adminAdapter.query<AdminAuthRoleRow>(
      `SELECT id, name, permissions_json, hierarchy_level, inherits_from
         FROM admin_roles
        WHERE tenant_id = ?
           OR (tenant_id = 'default' AND is_system = 1)`,
      [session.tenant_id]
    );
    const rolesById = new Map<string, AdminAuthRoleRow>();
    for (const role of allTenantRoles) {
      rolesById.set(role.id, role);
    }

    const roles: string[] = [];
    const allPermissions = new Set<string>();
    let maxHierarchyLevel = 0;
    let hasGlobalScope = false;

    for (const role of rolesResult) {
      roles.push(role.name);
      maxHierarchyLevel = Math.max(maxHierarchyLevel, role.hierarchy_level);
      hasGlobalScope = hasGlobalScope || Number(role.has_global_scope ?? 0) > 0;
      collectInheritedRolePermissions(role, rolesById, allPermissions);
    }

    // Check if user has any of the required roles
    const hasRequiredRole = roles.some((role) => requiredRoles.includes(role));

    if (!hasRequiredRole) {
      log.debug('Admin user lacks required roles', {
        userId: adminUser.id,
        userRoles: roles,
        requiredRoles,
      });
      return null;
    }

    // Update session activity (fire and forget)
    adminAdapter
      .execute('UPDATE admin_sessions SET last_activity_at = ? WHERE id = ? AND tenant_id = ?', [
        now,
        sessionId,
        session.tenant_id,
      ])
      .catch(() => {
        // Ignore errors
      });

    return {
      userId: adminUser.id,
      authMethod: 'session',
      roles,
      tenantId: session.tenant_id,
      email: adminUser.email,
      permissions: Array.from(allPermissions),
      hierarchyLevel: maxHierarchyLevel,
      mfaVerified: Boolean(session.mfa_verified),
      authenticationTimeMs:
        session.mfa_verified_at && session.mfa_verified_at > session.created_at
          ? session.mfa_verified_at
          : session.created_at,
      sessionId: session.id,
      tenantScope: hasGlobalScope ? ['*'] : [session.tenant_id],
    };
  } catch (error) {
    log.error('Admin session authentication failed', {}, error as Error);
    return null;
  }
}

/**
 * Check if client IP is allowed (from admin_ip_allowlist)
 *
 * @param c - Hono context
 * @param tenantId - Tenant ID
 * @returns true if allowed (or if no allowlist entries exist)
 */
async function isIpAllowed(c: Context<{ Bindings: Env }>, tenantId: string): Promise<boolean> {
  try {
    const adminAdapter: DatabaseAdapter = requireAdminDatabaseAdapter(c.env, 'admin-auth');

    // Check if any enabled entries exist
    const entries = await adminAdapter.query<{
      ip_range: string;
      ip_version: number;
    }>('SELECT ip_range, ip_version FROM admin_ip_allowlist WHERE tenant_id = ? AND enabled = 1', [
      tenantId,
    ]);

    // If no entries, allow all IPs (default behavior)
    if (entries.length === 0) {
      return true;
    }

    // Get client IP from Cloudflare header after determining that an allowlist is active.
    const clientIp =
      c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim();

    if (!clientIp) {
      log.warn('Could not determine client IP for active allowlist check');
      return false;
    }

    // Check if client IP matches any entry
    for (const entry of entries) {
      if (ipMatches(clientIp, entry.ip_range)) {
        return true;
      }
    }

    log.warn('Client IP not in allowlist', { clientIp, tenantId });
    return false;
  } catch (error) {
    log.error('IP allowlist check failed', {}, error as Error);
    return false;
  }
}

/**
 * Check if an IP matches a range (single IP or CIDR)
 */
function ipMatches(ip: string, range: string): boolean {
  // Exact match
  if (ip === range) {
    return true;
  }

  // CIDR match
  if (range.includes('/')) {
    return ipMatchesCidr(ip, range);
  }

  return false;
}

/**
 * Check if an IP matches an IPv4 or IPv6 CIDR range.
 */
function ipMatchesCidr(ip: string, cidr: string): boolean {
  const cidrParts = cidr.split('/');
  if (cidrParts.length !== 2 || !/^\d+$/.test(cidrParts[1])) {
    return false;
  }
  const [rangeIp, prefixLengthStr] = cidrParts;
  const prefixLength = Number(prefixLengthStr);

  // IPv4 handling
  if (!ip.includes(':') && !rangeIp.includes(':')) {
    const ipNum = ipv4ToNumber(ip);
    const rangeNum = ipv4ToNumber(rangeIp);

    if (ipNum === null || rangeNum === null || prefixLength < 0 || prefixLength > 32) {
      return false;
    }

    const mask = prefixLength === 0 ? 0 : (-1 << (32 - prefixLength)) >>> 0;
    return (ipNum & mask) === (rangeNum & mask);
  }

  // IPv6 handling. Parse both compressed and full notation and compare prefix bits.
  if (ip.includes(':') && rangeIp.includes(':')) {
    const ipNum = ipv6ToBigInt(ip);
    const rangeNum = ipv6ToBigInt(rangeIp);
    if (ipNum === null || rangeNum === null || prefixLength < 0 || prefixLength > 128) {
      return false;
    }
    const hostBits = BigInt(128 - prefixLength);
    return ipNum >> hostBits === rangeNum >> hostBits;
  }

  return false;
}

/**
 * Convert IPv4 address to 32-bit number
 */
function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }

  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const num = Number(part);
    if (num > 255) {
      return null;
    }
    result = (result << 8) | num;
  }

  return result >>> 0;
}

function ipv6ToBigInt(ip: string): bigint | null {
  if (ip.includes('.') || ip.includes(':::') || (ip.match(/::/g) ?? []).length > 1) {
    return null;
  }

  const compressed = ip.includes('::');
  const [leftText, rightText = ''] = compressed ? ip.split('::') : [ip, ''];
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  if ((!compressed && left.length !== 8) || (compressed && left.length + right.length >= 8)) {
    return null;
  }

  const groups = compressed
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group))) {
    return null;
  }

  let result = 0n;
  for (const group of groups) {
    result = (result << 16n) | BigInt(`0x${group}`);
  }
  return result;
}

function resolveAdminRequestTenantId(c: Context<{ Bindings: Env }>): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contextTenantId = (c as any).get('tenantId') as string | undefined;
  if (contextTenantId) {
    return contextTenantId;
  }

  const tenantResult = resolveTenantFromRequest(c.req.raw, c.env);
  if (tenantResult.success) {
    return tenantResult.tenantId;
  }

  return c.env.BASE_DOMAIN ? null : getDefaultTenantId(c.env);
}

function isPlatformAdminSessionStatusPath(path: string): boolean {
  return path === '/api/admin/me/session' || path === '/api/admin/me/session/';
}

/**
 * Admin authentication middleware
 *
 * Supports Admin UI session authentication:
 * - Session Cookie: authrim_admin_session=<id>
 *
 * Static Admin API root bearer secrets are not accepted. Machine access must use
 * scoped Admin Machine Access tokens once that path is enabled.
 *
 * Sets adminAuth context on successful authentication:
 * - c.get('adminAuth') => { userId, authMethod, roles, permissions, ... }
 *
 * Returns 401 if authentication fails.
 * Returns 403 if IP is not allowed or MFA required but not verified.
 *
 * @param options - Optional configuration for role/permission requirements
 */
export function adminAuthMiddleware(options: AdminAuthOptions = {}) {
  const plane = options.plane || 'tenant';
  const requiredRoles = options.requireRoles || [
    'super_admin',
    'security_admin',
    'admin',
    'support',
    'viewer',
  ];

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const existingAuthContext = (c as unknown as { get?: (key: string) => unknown }).get?.(
      'adminAuth'
    );
    let authContext: AdminAuthContext | null =
      existingAuthContext && typeof existingAuthContext === 'object'
        ? (existingAuthContext as AdminAuthContext)
        : null;
    const effectivePlane = isPlatformAdminSessionStatusPath(c.req.path) ? 'platform' : plane;
    const authHeader = c.req.header('Authorization');
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    const requiresBffTransportAuth = isAdminUiBffTransportRequest(c);
    const requestTenantIdForSession =
      effectivePlane === 'tenant' ? resolveAdminRequestTenantId(c) : undefined;

    // Try session-based authentication.
    if (!authContext) {
      let sessionId: string | undefined;

      const cookieHeader = c.req.header('Cookie');
      if (cookieHeader) {
        const sessionMatch = cookieHeader.match(/authrim_admin_session=([^;]+)/);
        if (sessionMatch) {
          try {
            sessionId = decodeURIComponent(sessionMatch[1]);
          } catch {
            return c.json(
              {
                error: 'invalid_token',
                error_description: 'Admin authentication required. Use a valid session.',
              },
              401
            );
          }
        }
      }

      if (sessionId) {
        authContext = await authenticateSession(
          c,
          sessionId,
          requiredRoles,
          requestTenantIdForSession ?? undefined
        );
      }
    }

    if (requiresBffTransportAuth) {
      const tokenTenantId =
        effectivePlane === 'tenant'
          ? resolveAdminRequestTenantId(c)
          : ((c as unknown as { get?: (key: string) => unknown }).get?.('tenantId') as
              | string
              | undefined) || getDefaultTenantId(c.env);
      if (!tokenTenantId) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Tenant context is required for tenant admin routes.',
          },
          400
        );
      }

      if (!bearerToken) {
        return c.json(
          {
            error: 'invalid_token',
            error_description: 'Admin UI BFF transport credential is required.',
          },
          401
        );
      }

      const transportAuthContext = await authenticateMachineAccessToken(
        c,
        bearerToken,
        tokenTenantId
      );
      if (!transportAuthContext) {
        return c.json(
          {
            error: 'invalid_token',
            error_description: 'Admin UI BFF transport credential is invalid.',
          },
          401
        );
      }
      if (transportAuthContext.principalType !== 'admin_ui_bff') {
        return c.json(
          {
            error: 'access_denied',
            error_description: 'Machine credential is not authorized for Admin UI BFF transport.',
          },
          403
        );
      }
      if (!hasTenantScope(transportAuthContext, tokenTenantId)) {
        return c.json(
          {
            error: 'access_denied',
            error_description: 'Admin UI BFF credential is not valid for this tenant.',
          },
          403
        );
      }
      if (!authContext) {
        return c.json(
          {
            error: 'invalid_token',
            error_description: 'Admin UI BFF requests require a valid admin session.',
          },
          401
        );
      }

      authContext = {
        ...authContext,
        transportAuth: toTransportAuthContext(transportAuthContext),
      };
    }

    if (!options.sessionOnly && !authContext && bearerToken) {
      const tokenTenantId =
        effectivePlane === 'tenant'
          ? resolveAdminRequestTenantId(c)
          : ((c as unknown as { get?: (key: string) => unknown }).get?.('tenantId') as
              | string
              | undefined) || getDefaultTenantId(c.env);
      if (!tokenTenantId) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Tenant context is required for tenant admin routes.',
          },
          400
        );
      }
      if (options.authenticateBearer) {
        try {
          authContext = await options.authenticateBearer(c, bearerToken, tokenTenantId);
        } catch {
          authContext = null;
        }
      }
      authContext ??= await authenticateMachineAccessToken(c, bearerToken, tokenTenantId);
      if (authContext?.principalType === 'admin_ui_bff') {
        return c.json(
          {
            error: 'invalid_token',
            error_description: 'Admin UI BFF credential cannot be used as primary Admin API auth.',
          },
          401
        );
      }
    }

    // Authentication failed
    if (!authContext) {
      const redirectLocation = options.unauthenticatedRedirect?.(c);
      if (redirectLocation) return c.redirect(redirectLocation, 302);
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Admin authentication required. Use a valid session.',
        },
        401
      );
    }

    if (effectivePlane === 'tenant') {
      const requestTenantId = requestTenantIdForSession ?? resolveAdminRequestTenantId(c);
      if (!requestTenantId) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Tenant context is required for tenant admin routes.',
          },
          400
        );
      }

      if (
        authContext.authMethod === 'session' &&
        authContext.tenantId !== requestTenantId &&
        !hasTenantScope(authContext, requestTenantId)
      ) {
        log.warn('Admin session tenant does not match request tenant', {
          userId: authContext.userId,
          sessionTenantId: authContext.tenantId,
          requestTenantId,
        });
        return c.json(
          {
            error: 'access_denied',
            error_description: 'Admin session is not valid for this tenant.',
          },
          403
        );
      }

      if (authContext.authMethod === 'session' && authContext.tenantId !== requestTenantId) {
        authContext = {
          ...authContext,
          tenantId: requestTenantId,
        };
      }

      if (!hasTenantScope(authContext, requestTenantId)) {
        log.warn('Admin machine token tenant scope does not allow request tenant', {
          userId: authContext.userId,
          requestTenantId,
          tenantScope: authContext.tenantScope,
        });
        return c.json(
          {
            error: 'access_denied',
            error_description: 'Admin machine credential is not valid for this tenant.',
          },
          403
        );
      }
    }

    // Check IP allowlist (unless skipped)
    if (!options.skipIpCheck && authContext.authMethod === 'session') {
      const tenantId = authContext.tenantId?.trim();
      if (!tenantId) {
        return c.json(
          {
            error: 'invalid_request',
            error_description: 'Admin session tenant context is required.',
          },
          400
        );
      }
      const ipAllowed = await isIpAllowed(c, tenantId);
      if (!ipAllowed) {
        return c.json(
          {
            error: 'access_denied',
            error_description: 'Access denied. Your IP address is not allowed.',
          },
          403
        );
      }
    }

    // Check MFA requirement
    if (options.requireMfa && !authContext.mfaVerified) {
      return c.json(
        {
          error: 'mfa_required',
          error_description: 'Multi-factor authentication is required for this operation.',
        },
        403
      );
    }

    // Check required permissions (if specified)
    if (options.requirePermissions && options.requirePermissions.length > 0) {
      const userPermissions = authContext.permissions || [];
      const hasAllPermissions = options.requirePermissions.every((perm) =>
        hasAdminPermission(userPermissions, perm)
      );

      if (!hasAllPermissions) {
        log.debug('Admin lacks required permissions', {
          userId: authContext.userId,
          requiredPermissions: options.requirePermissions,
          userPermissions,
        });
        return c.json(
          {
            error: 'insufficient_permissions',
            error_description: 'You do not have the required permissions for this operation.',
          },
          403
        );
      }
    }

    // Set authenticated context
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).set('adminAuth', authContext);
    // Set tenantId for downstream handlers
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).set('tenantId', authContext.tenantId);
    return next();
  };
}

/**
 * Require specific permissions for an endpoint
 *
 * Use this after adminAuthMiddleware to check for specific permissions.
 *
 * @example
 * app.delete('/api/admin/users/:id',
 *   adminAuthMiddleware(),
 *   requireAdminPermissions(['admin:users:delete']),
 *   deleteUserHandler
 * )
 */
export function requireAdminPermissions(permissions: string[]) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authContext = (c as any).get('adminAuth') as AdminAuthContext | undefined;

    if (!authContext) {
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Admin authentication required.',
        },
        401
      );
    }

    const userPermissions = authContext.permissions || [];
    const hasAllPermissions = permissions.every((perm) =>
      hasAdminPermission(userPermissions, perm)
    );

    if (!hasAllPermissions) {
      log.warn('Admin permission middleware denied request', {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        authMethod: authContext.authMethod,
        requiredPermissions: permissions,
        actualPermissions: userPermissions,
      });
      return c.json(
        {
          error: 'insufficient_permissions',
          error_description: 'You do not have the required permissions for this operation.',
        },
        403
      );
    }

    return next();
  };
}

/**
 * Require MFA verification for an endpoint
 *
 * Use this after adminAuthMiddleware to require MFA.
 *
 * @example
 * app.post('/api/admin/security/rotate-keys',
 *   adminAuthMiddleware(),
 *   requireMfa(),
 *   rotateKeysHandler
 * )
 */
export function requireMfa() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const authContext = (c as any).get('adminAuth') as AdminAuthContext | undefined;

    if (!authContext) {
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Admin authentication required.',
        },
        401
      );
    }

    if (!authContext.mfaVerified) {
      return c.json(
        {
          error: 'mfa_required',
          error_description: 'Multi-factor authentication is required for this operation.',
        },
        403
      );
    }

    return next();
  };
}
