import type { Context, Hono, Next } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  getLogger,
  hasAdminPermission,
  requireAdminPermissions,
  type AdminAuthContext,
} from '@authrim/ar-lib-core';

type AdminPermissionMiddleware = (
  c: Context<{ Bindings: Env }>,
  next: Next
) => Promise<Response | void>;

function isUserRbacSubresource(path: string): boolean {
  return /^\/api\/admin\/users\/[^/]+\/(roles|relationships|effective-permissions)(?:\/|$)/.test(
    path
  );
}

function isUserSessionSubresource(path: string): boolean {
  return /^\/api\/admin\/users\/[^/]+\/(sessions|refresh-tokens|device-secrets)(?:\/|$)/.test(path);
}

function isUserDeletePath(path: string): boolean {
  return /^\/api\/admin\/users\/[^/]+$/.test(path) || /\/pii$/.test(path);
}

function isUserAnonymizePath(path: string): boolean {
  return /\/anonymize$/.test(path);
}

function requireUserManagementPermission(): AdminPermissionMiddleware {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (isUserRbacSubresource(path) || isUserSessionSubresource(path)) {
      return next();
    }

    const method = c.req.method.toUpperCase();
    const permission =
      method === 'GET'
        ? ADMIN_PERMISSIONS.USERS_READ
        : method === 'DELETE' && isUserDeletePath(path)
          ? ADMIN_PERMISSIONS.USERS_DELETE
          : isUserAnonymizePath(path)
            ? ADMIN_PERMISSIONS.USERS_DELETE
            : ADMIN_PERMISSIONS.USERS_WRITE;

    return requireAdminPermissions([permission])(c, next);
  };
}

function requireSessionManagementPermission(): AdminPermissionMiddleware {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    const permission =
      method === 'GET' ? ADMIN_PERMISSIONS.SESSIONS_READ : ADMIN_PERMISSIONS.SESSIONS_REVOKE;

    return requireAdminPermissions([permission])(c, next);
  };
}

function requireSettingsManagementPermission(): AdminPermissionMiddleware {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    const path = new URL(c.req.url).pathname;
    const permission =
      path === '/api/admin/settings/agent'
        ? method === 'GET'
          ? ADMIN_PERMISSIONS.AGENT_SETTINGS_READ
          : ADMIN_PERMISSIONS.AGENT_SETTINGS_WRITE
        : method === 'GET'
          ? ADMIN_PERMISSIONS.SETTINGS_READ
          : ADMIN_PERMISSIONS.SETTINGS_WRITE;

    return requireAdminPermissions([permission])(c, next);
  };
}

function requireUserAttributePermission(): AdminPermissionMiddleware {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    const permission =
      method === 'GET' ? ADMIN_PERMISSIONS.USERS_READ : ADMIN_PERMISSIONS.USERS_WRITE;

    return requireAdminPermissions([permission])(c, next);
  };
}

function requireSecurityCredentialPermission(): AdminPermissionMiddleware {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    const permission =
      method === 'GET' ? ADMIN_PERMISSIONS.SECURITY_READ : ADMIN_PERMISSIONS.SECURITY_WRITE;

    const authContext = (c as unknown as { get: (key: string) => unknown }).get('adminAuth') as
      | AdminAuthContext
      | undefined;
    if (!hasAdminPermission(authContext?.permissions ?? [], permission)) {
      getLogger(c)
        .module('ADMIN-RESOURCE-PERMISSIONS')
        .warn('Security resource access denied', {
          method,
          path: new URL(c.req.url).pathname,
          authMethod: authContext?.authMethod,
          requiredPermissions: [permission],
          actualPermissions: authContext?.permissions ?? [],
        });
    }

    return requireAdminPermissions([permission])(c, next);
  };
}

function requireClientRegistrationTokenPermission(): AdminPermissionMiddleware {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    const permission =
      method === 'GET' ? ADMIN_PERMISSIONS.CLIENTS_READ : ADMIN_PERMISSIONS.CLIENTS_WRITE;

    return requireAdminPermissions([permission])(c, next);
  };
}

function requireExternalProviderPermission(): AdminPermissionMiddleware {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    const permission =
      method === 'GET'
        ? ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_READ
        : method === 'DELETE'
          ? ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_DELETE
          : ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_WRITE;

    return requireAdminPermissions([permission])(c, next);
  };
}

function requireExternalTokenRefreshPermission(): AdminPermissionMiddleware {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const method = c.req.method.toUpperCase();
    const permission =
      method === 'GET'
        ? ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_READ
        : path.endsWith('/run')
          ? ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_RUN
          : ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_WRITE;

    return requireAdminPermissions([permission])(c, next);
  };
}

export function registerAdminResourcePermissionMiddleware(app: Hono<any, any, any>): void {
  const userPermission = requireUserManagementPermission();
  const sessionPermission = requireSessionManagementPermission();
  const settingsPermission = requireSettingsManagementPermission();
  const userAttributePermission = requireUserAttributePermission();
  const securityCredentialPermission = requireSecurityCredentialPermission();
  const clientRegistrationTokenPermission = requireClientRegistrationTokenPermission();
  const externalProviderPermission = requireExternalProviderPermission();
  const externalTokenRefreshPermission = requireExternalTokenRefreshPermission();
  const vcProfilePermission: AdminPermissionMiddleware = async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const permission = path.endsWith('/offers')
      ? ADMIN_PERMISSIONS.VC_CREDENTIAL_OFFERS_CREATE
      : path.endsWith('/publish')
        ? ADMIN_PERMISSIONS.VC_CREDENTIAL_PROFILES_PUBLISH
        : c.req.method === 'GET'
          ? ADMIN_PERMISSIONS.VC_CREDENTIAL_PROFILES_READ
          : ADMIN_PERMISSIONS.VC_CREDENTIAL_PROFILES_WRITE;
    return requireAdminPermissions([permission])(c, next);
  };

  app.use('/api/admin/users', userPermission);
  app.use('/api/admin/users/*', userPermission);
  app.use('/api/admin/sessions', sessionPermission);
  app.use('/api/admin/sessions/*', sessionPermission);
  app.use('/api/admin/users/:id/sessions', sessionPermission);
  app.use('/api/admin/users/:id/refresh-tokens', sessionPermission);
  app.use('/api/admin/users/:id/device-secrets', sessionPermission);
  app.use('/api/admin/device-secrets', sessionPermission);
  app.use('/api/admin/device-secrets/*', sessionPermission);
  app.use('/api/admin/settings', settingsPermission);
  app.use('/api/admin/settings/*', settingsPermission);
  app.use('/api/admin/attributes', userAttributePermission);
  app.use('/api/admin/attributes/*', userAttributePermission);
  app.use('/api/admin/custom-claims', settingsPermission);
  app.use('/api/admin/custom-claims/*', settingsPermission);
  app.use('/api/admin/token-claim-rules', settingsPermission);
  app.use('/api/admin/token-claim-rules/*', settingsPermission);
  app.use('/api/admin/org-domain-mappings', settingsPermission);
  app.use('/api/admin/org-domain-mappings/*', settingsPermission);
  app.use('/api/admin/signing-keys', securityCredentialPermission);
  app.use('/api/admin/signing-keys/*', securityCredentialPermission);
  app.use('/api/admin/scim-tokens', securityCredentialPermission);
  app.use('/api/admin/scim-tokens/*', securityCredentialPermission);
  app.use('/api/admin/check-api-keys', securityCredentialPermission);
  app.use('/api/admin/check-api-keys/*', securityCredentialPermission);
  app.use('/api/admin/iat-tokens', clientRegistrationTokenPermission);
  app.use('/api/admin/iat-tokens/*', clientRegistrationTokenPermission);
  app.use('/api/admin/external-providers', externalProviderPermission);
  app.use('/api/admin/external-providers/*', externalProviderPermission);
  app.use('/api/admin/external-token-refresh', externalTokenRefreshPermission);
  app.use('/api/admin/external-token-refresh/*', externalTokenRefreshPermission);
  app.use('/api/admin/credential-profiles', vcProfilePermission);
  app.use('/api/admin/credential-profiles/*', vcProfilePermission);
}
