const TENANT_INVENTORY_PATH =
  /^\/api\/admin\/tenants(?:\/([^/]+)(?:\/(info|set-default|clone|invitations(?:\/[^/]+)?))?)?\/?$/;
const TENANT_SCOPED_PATH_TENANT_ID = /^\/api\/admin\/tenants\/([^/]+)\/(settings|audit)(?:\/.*)?$/;
const SETTINGS_METADATA_PATH =
  /^\/api\/admin\/settings\/(?:schema|diff|validate|meta(?:\/.*)?)\/?$/;
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

  if (normalizedPath === '/api/auth/discovery') {
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

  if (SETTINGS_METADATA_PATH.test(normalizedPath)) {
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
  const match = (path || '').match(TENANT_SCOPED_PATH_TENANT_ID);
  return match?.[1] ?? null;
}
