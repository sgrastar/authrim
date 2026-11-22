const TENANT_INVENTORY_PATH =
  /^\/api\/admin\/tenants(?:\/([^/]+)(?:\/(info|runtime-profiles|set-default|clone|invitations(?:\/[^/]+)?|provisioning(?:\/(?:cleanup|retry))?|deletion\/cancel|lifecycle\/(?:suspend|resume|freeze|unfreeze|restore-validate|jobs(?:\/[^/]+\/retry)?)))?)?\/?$/;
const TENANT_SCOPED_PATH_TENANT_ID_PATTERNS = [
  /^\/api\/admin\/tenants\/([^/]+)\/.*$/,
  /^\/api\/admin\/settings\/logging\/tenant\/([^/]+)(?:\/.*)?$/,
] as const;
/**
 * The routes under `/api/admin/tenants/{id}/` that a tenant administrator may open for their own
 * tenant (the handlers check the caller's own scope). This is the one table both the Admin API
 * guard and the request context read, so what is opened and where the request runs cannot drift.
 * Group 1 is the tenant id of the path.
 */
const TENANT_ADMIN_OPEN_PATH_PATTERNS: readonly RegExp[] = [
  /^\/api\/admin\/tenants\/([^/]+)\/directory-(?:auth|connectors)(?:\/|$)/,
  /^\/api\/admin\/tenants\/([^/]+)\/settings(?:\/|$)/,
  // The page lists issuer and endpoint URLs.
  /^\/api\/admin\/tenants\/([^/]+)\/info\/?$/,
  // Each of these acts on that tenant only: its sign-up invitations, the order of its email
  // providers, and (read only) the audit and residency profiles it ends up with. Editing
  // profiles stays under /runtime-profiles.
  /^\/api\/admin\/tenants\/([^/]+)\/invitations(?:\/[^/]+)?\/?$/,
  /^\/api\/admin\/tenants\/([^/]+)\/email-settings\/?$/,
  /^\/api\/admin\/tenants\/([^/]+)\/runtime-profiles\/?$/,
];
const SETTINGS_METADATA_PATH =
  /^\/api\/admin\/settings\/(?:schema|diff|validate|meta(?:\/.*)?)\/?$/;
const SETTINGS_PLATFORM_PATH = /^\/api\/admin\/settings\/cache-mode(?:\/info)?\/?$/;
const RUNTIME_PROFILE_PLATFORM_PATH = /^\/api\/admin\/runtime-profiles(?:\/.*)?\/?$/;
const ADMIN_PLATFORM_AUTH_PATH =
  /^\/api\/admin\/(?:auth\/.*|setup-token\/.*|sessions\/me|me\/session|logout)\/?$/;
const INITIAL_ADMIN_SETUP_PATH =
  /^(?:\/admin-init-setup|\/api\/admin-init-setup\/(?:status|initialize|complete))\/?$/;
// An invited administrator has no session and no tenant context yet. The code-gated enrollment
// handlers read the invitation, and so its tenant, from the dedicated Admin database.
const ADMIN_INVITATION_ENROLLMENT_PATH =
  /^\/api\/admin\/invitations\/(?:redeem|passkey\/options|passkey\/register|activate)\/?$/;
const ADMIN_SELF_SERVICE_PATH =
  /^\/api\/admin\/me\/(?:(?:passkeys|agent-consents)(?:\/[^/]+)?|reauth\/(?:passkey|second-factor)\/(?:options|verify)|step-up\/receipts|second-factors(?:\/webauthn\/(?:options|verify)|\/totp\/(?:enroll(?:\/verify)?|verify)|\/[^/]+)?|second-factor-recovery(?:\/(?:complete|cancel))?|keyring\/(?:step-up|enroll)(?:\/[^/]+(?:\/response)?)?|notice-preferences)\/?$/;
const ADMIN_AGENT_LOGIN_HANDOFF_APPROVAL_PATH =
  /^\/api\/admin\/agent-login-handoffs\/alh_[A-Za-z0-9_-]{32}\/approve\/?$/;
const TENANT_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export type TenantRequestClass =
  | 'platform_admin'
  | 'tenant_inventory_admin'
  | 'tenant_scoped_admin'
  | 'discovery_ui'
  | 'health_or_internal'
  | 'public_protocol_or_rest';

export function classifyTenantRequestPath(path?: string | null): TenantRequestClass {
  const normalizedPath = path || '/';

  if (
    normalizedPath.startsWith('/.well-known/') ||
    normalizedPath === '/api/auth/discovery' ||
    normalizedPath.startsWith('/api/auth/discovery/')
  ) {
    return 'discovery_ui';
  }

  if (
    normalizedPath === '/api/health' ||
    normalizedPath === '/health/live' ||
    normalizedPath === '/health/ready' ||
    normalizedPath.startsWith('/internal/') ||
    normalizedPath.startsWith('/api/internal/') ||
    normalizedPath.startsWith('/_internal/')
  ) {
    return 'health_or_internal';
  }

  if (normalizedPath.startsWith('/api/admin/platform/')) {
    return 'platform_admin';
  }

  if (ADMIN_PLATFORM_AUTH_PATH.test(normalizedPath)) {
    return 'platform_admin';
  }

  // Initial administrators live in the dedicated Admin database. Their one-time
  // setup token and origin checks must run before a tenant runtime exists.
  if (INITIAL_ADMIN_SETUP_PATH.test(normalizedPath)) {
    return 'platform_admin';
  }

  if (ADMIN_INVITATION_ENROLLMENT_PATH.test(normalizedPath)) {
    return 'platform_admin';
  }

  // These handlers derive ownership from the authenticated Admin identity in DB_ADMIN.
  if (ADMIN_SELF_SERVICE_PATH.test(normalizedPath)) {
    return 'platform_admin';
  }

  // The central Admin UI cannot send a tenant header before it has resolved the opaque
  // handoff. The approval handler derives and validates the target tenant from DB_ADMIN.
  // Keep this exemption exact so malformed or adjacent Agent routes remain tenant-scoped.
  if (ADMIN_AGENT_LOGIN_HANDOFF_APPROVAL_PATH.test(normalizedPath)) {
    return 'platform_admin';
  }

  if (SETTINGS_METADATA_PATH.test(normalizedPath)) {
    return 'platform_admin';
  }

  if (SETTINGS_PLATFORM_PATH.test(normalizedPath)) {
    return 'platform_admin';
  }

  if (RUNTIME_PROFILE_PLATFORM_PATH.test(normalizedPath)) {
    return 'platform_admin';
  }

  if (TENANT_INVENTORY_PATH.test(normalizedPath)) {
    return 'tenant_inventory_admin';
  }

  if (normalizedPath.startsWith('/api/admin/')) {
    return 'tenant_scoped_admin';
  }

  return 'public_protocol_or_rest';
}

export function isTenantScopedAdminPath(path?: string | null): boolean {
  return classifyTenantRequestPath(path) === 'tenant_scoped_admin';
}

export function isAdminTenantHeaderRequired(path?: string | null): boolean {
  return classifyTenantRequestPath(path) === 'tenant_scoped_admin';
}

/**
 * The tenant id of a route a tenant administrator may open for their own tenant, or null for any
 * other path. Decide on the router's own path (`c.req.path`), never on the raw URL.
 */
export function extractTenantAdminOpenPathTenantId(path?: string | null): string | null {
  const normalizedPath = path || '';
  for (const pattern of TENANT_ADMIN_OPEN_PATH_PATTERNS) {
    const match = normalizedPath.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function isTenantAdminOpenPath(path?: string | null): boolean {
  return extractTenantAdminOpenPathTenantId(path) !== null;
}

/**
 * A tenant-admin-open route that is classified as tenant inventory (`info`, `invitations`,
 * `runtime-profiles`). It sends no tenant header, so the request runs in the tenant the path names
 * (the caller's roles are worked out for that tenant); every other tenant-admin-open route is
 * `tenant_scoped_admin` and runs in the tenant of its `X-Tenant-Id` header.
 */
export function isTenantAdminOpenInventoryPath(path?: string | null): boolean {
  return (
    classifyTenantRequestPath(path) === 'tenant_inventory_admin' && isTenantAdminOpenPath(path)
  );
}

export function isValidTenantIdentifier(value: string): boolean {
  return TENANT_ID_PATTERN.test(value);
}

export function extractTenantScopedPathTenantId(path?: string | null): string | null {
  const normalizedPath = path || '';
  for (const pattern of TENANT_SCOPED_PATH_TENANT_ID_PATTERNS) {
    const match = normalizedPath.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

const ADMIN_PATH_TARGET_TENANT_PATTERNS: readonly RegExp[] = [
  // Every route under a tenant of the inventory (including the ones a tenant administrator may
  // open for their own tenant): the tenant is the first segment after `/tenants/`.
  /^\/api\/admin\/tenants\/([^/]+)(?:\/|$)/i,
  /^\/api\/admin\/settings\/logging\/tenant\/([^/]+)(?:\/|$)/i,
];

/**
 * The tenant an Admin API path names as its target, normalised for comparison: percent-decoded
 * (more than once, as a handler's own parameter decoding may decode again), NFKC-normalised,
 * trimmed and lowercased.
 *
 * - `{ kind: 'none' }`: the path names no tenant.
 * - `{ kind: 'tenant', tenantId }`: it names that tenant.
 * - `{ kind: 'unresolvable' }`: it names one, but the segment cannot be read as a tenant ID
 *   (malformed or nested percent-encoding). A decision that protects tenants must treat that as
 *   naming any of them.
 *
 * Pass the router's own path (`c.req.path`), never one taken from the raw URL.
 */
export type AdminPathTargetTenant =
  | { kind: 'none' }
  | { kind: 'tenant'; tenantId: string }
  | { kind: 'unresolvable' };

export function resolveAdminPathTargetTenant(path?: string | null): AdminPathTargetTenant {
  const normalizedPath = path || '';
  for (const pattern of ADMIN_PATH_TARGET_TENANT_PATTERNS) {
    const match = normalizedPath.match(pattern);
    if (!match?.[1]) continue;
    let segment = match[1];
    for (let round = 0; round < 3 && segment.includes('%'); round += 1) {
      try {
        const decoded = decodeURIComponent(segment);
        if (decoded === segment) break;
        segment = decoded;
      } catch {
        return { kind: 'unresolvable' };
      }
    }
    if (segment.includes('%')) return { kind: 'unresolvable' };
    return { kind: 'tenant', tenantId: segment.normalize('NFKC').trim().toLowerCase() };
  }
  return { kind: 'none' };
}
