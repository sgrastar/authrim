const TENANT_INVENTORY_PATH =
  /^\/api\/admin\/tenants(?:\/([^/]+)(?:\/(info|runtime-profiles|set-default|clone|invitations(?:\/[^/]+)?|provisioning(?:\/(?:cleanup|retry))?))?)?\/?$/;
const TENANT_SCOPED_PATH_TENANT_ID_PATTERNS = [
  /^\/api\/admin\/tenants\/([^/]+)\/(settings|audit|email-settings|clients)(?:\/.*)?$/,
  /^\/api\/admin\/settings\/logging\/tenant\/([^/]+)(?:\/.*)?$/,
] as const;
const SETTINGS_METADATA_PATH =
  /^\/api\/admin\/settings\/(?:schema|diff|validate|meta(?:\/.*)?)\/?$/;
const SETTINGS_PLATFORM_PATH =
  /^\/api\/admin\/settings\/(?:ui-config|ui-routing|cache-mode(?:\/info)?)\/?$/;
const RUNTIME_PROFILE_PLATFORM_PATH = /^\/api\/admin\/runtime-profiles(?:\/.*)?\/?$/;
const ADMIN_PLATFORM_AUTH_PATH =
  /^\/api\/admin\/(?:auth\/.*|setup-token\/.*|sessions\/me|me\/session|logout)\/?$/;
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
