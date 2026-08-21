import type { Context, Hono, Next } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  getLogger,
  hasAdminPermission,
  type AdminAuthContext,
} from '@authrim/ar-lib-core';

export type AdminRouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface AdminRouteAccessRule {
  pattern: string;
  methods: AdminRouteMethod[];
  permissions?: string[];
  anyPermissions?: string[];
  roles?: string[];
  authenticated?: boolean;
  description: string;
}

type RuleInput = Omit<AdminRouteAccessRule, 'methods'> & {
  methods?: AdminRouteMethod[];
};

const READ_METHODS: AdminRouteMethod[] = ['GET'];
const WRITE_METHODS: AdminRouteMethod[] = ['POST', 'PUT', 'PATCH'];
const DELETE_METHODS: AdminRouteMethod[] = ['DELETE'];
const ALL_METHODS: AdminRouteMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const TENANT_ADMIN_ROLES = ['system_admin', 'distributor_admin', 'tenant_admin', 'admin'];
const PLATFORM_ADMIN_ROLES = ['super_admin', 'system_admin'];

function rule(input: RuleInput): AdminRouteAccessRule {
  return {
    ...input,
    methods: input.methods ?? ALL_METHODS,
  };
}

function authenticated(pattern: string, description: string): AdminRouteAccessRule {
  return rule({
    pattern,
    authenticated: true,
    description,
  });
}

function byMethod(
  pattern: string,
  readPermission: string,
  writePermission: string,
  deletePermission: string = writePermission,
  description: string,
  roles?: string[]
): AdminRouteAccessRule[] {
  return [
    rule({
      pattern,
      methods: READ_METHODS,
      permissions: [readPermission],
      roles,
      description: `${description} read`,
    }),
    rule({
      pattern,
      methods: WRITE_METHODS,
      permissions: [writePermission],
      roles,
      description: `${description} write`,
    }),
    rule({
      pattern,
      methods: DELETE_METHODS,
      permissions: [deletePermission],
      roles,
      description: `${description} delete`,
    }),
  ];
}

function readOnly(pattern: string, permission: string, description: string): AdminRouteAccessRule {
  return rule({
    pattern,
    methods: READ_METHODS,
    permissions: [permission],
    description,
  });
}

function writeOnly(pattern: string, permission: string, description: string): AdminRouteAccessRule {
  return rule({
    pattern,
    methods: [...WRITE_METHODS, ...DELETE_METHODS],
    permissions: [permission],
    description,
  });
}

export const ADMIN_ROUTE_ACCESS_RULES: AdminRouteAccessRule[] = [
  rule({
    pattern: '/api/internal/versions/:workerName',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.CONTROL_PLANE_PROVISION],
    description: 'internal Worker version registration',
  }),
  readOnly(
    '/api/internal/version-manager/status',
    ADMIN_PERMISSIONS.CONTROL_PLANE_READ,
    'internal Worker version status'
  ),
  authenticated('/api/admin/me/session', 'current admin session'),
  authenticated('/api/admin/logout', 'current admin logout'),
  authenticated('/api/admin/sessions/me', 'removed legacy session endpoint'),
  authenticated('/api/admin/me/passkeys', 'current admin passkey management'),
  authenticated('/api/admin/me/passkeys/*', 'current admin passkey management'),
  authenticated('/api/admin/me/agent-consents', 'current admin Agent consent management'),
  authenticated('/api/admin/me/agent-consents/*', 'current admin Agent consent management'),

  rule({
    pattern: '/api/admin/agent-write/clients/:id/metadata',
    methods: ['PUT'],
    permissions: [ADMIN_PERMISSIONS.CLIENTS_UPDATE],
    description: 'Agent OAuth client display metadata update',
  }),
  rule({
    pattern: '/api/admin/agent-write/clients/:id/protocol-security',
    methods: ['PUT'],
    permissions: [ADMIN_PERMISSIONS.CLIENTS_UPDATE],
    description: 'Agent operation-bound OAuth client protocol security update',
  }),
  rule({
    pattern: '/api/admin/agent-write/clients/public',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.CLIENTS_CREATE],
    description: 'Agent operation-bound public OAuth client creation',
  }),
  rule({
    pattern: '/api/admin/clients',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.CLIENTS_CREATE],
    description: 'Create OAuth client',
  }),
  rule({
    pattern: '/api/admin/clients/:id',
    methods: ['PUT', 'PATCH'],
    permissions: [ADMIN_PERMISSIONS.CLIENTS_UPDATE],
    description: 'Update OAuth client',
  }),
  rule({
    pattern: '/api/admin/clients/:id/regenerate-secret',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.CLIENTS_SECRET_ROTATE],
    description: 'Rotate OAuth client secret',
  }),
  rule({
    pattern: '/api/admin/policies/simulate',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.POLICY_SIMULATE],
    description: 'Simulate authorization policy',
  }),
  rule({
    pattern: '/api/admin/flows/:id/validate',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.FLOWS_VALIDATE],
    description: 'Validate authentication Flow',
  }),
  rule({
    pattern: '/api/admin/flows/:id/compile',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.FLOWS_COMPILE],
    description: 'Compile authentication Flow',
  }),
  rule({
    pattern: '/api/admin/flows/:id/publish',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.FLOWS_PUBLISH],
    description: 'Publish authentication Flow',
  }),
  rule({
    pattern: '/api/admin/test/*',
    permissions: [ADMIN_PERMISSIONS.SECURITY_WRITE],
    roles: PLATFORM_ADMIN_ROLES,
    description: 'gated admin test endpoints',
  }),

  ...byMethod(
    '/api/admin/users/:id/roles',
    ADMIN_PERMISSIONS.ROLES_READ,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    'end-user role assignments'
  ),
  ...byMethod(
    '/api/admin/users/:id/roles/*',
    ADMIN_PERMISSIONS.ROLES_READ,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    'end-user role assignments'
  ),
  ...byMethod(
    '/api/admin/users/:id/relationships',
    ADMIN_PERMISSIONS.ROLES_READ,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    'end-user access graph relationships'
  ),
  ...byMethod(
    '/api/admin/users/:id/relationships/*',
    ADMIN_PERMISSIONS.ROLES_READ,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    'end-user access graph relationships'
  ),
  readOnly(
    '/api/admin/users/:id/effective-permissions',
    ADMIN_PERMISSIONS.ROLES_READ,
    'end-user effective permissions'
  ),
  ...byMethod(
    '/api/admin/roles',
    ADMIN_PERMISSIONS.ROLES_READ,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    ADMIN_PERMISSIONS.ROLES_DELETE,
    'end-user roles'
  ),
  ...byMethod(
    '/api/admin/roles/*',
    ADMIN_PERMISSIONS.ROLES_READ,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    ADMIN_PERMISSIONS.ROLES_DELETE,
    'end-user roles'
  ),
  ...byMethod(
    '/api/admin/organizations',
    ADMIN_PERMISSIONS.ROLES_READ,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    'organizations and access graph'
  ),
  ...byMethod(
    '/api/admin/organizations/*',
    ADMIN_PERMISSIONS.ROLES_READ,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    'organizations and access graph'
  ),
  ...byMethod(
    '/api/admin/policies',
    ADMIN_PERMISSIONS.ROLES_READ,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    'authorization policies'
  ),
  ...byMethod(
    '/api/admin/policies/*',
    ADMIN_PERMISSIONS.ROLES_READ,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    'authorization policies'
  ),
  ...byMethod(
    '/api/admin/role-assignment-rules',
    ADMIN_PERMISSIONS.ROLES_READ,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    'role assignment rules'
  ),
  ...byMethod(
    '/api/admin/role-assignment-rules/*',
    ADMIN_PERMISSIONS.ROLES_READ,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    'role assignment rules'
  ),
  ...byMethod(
    '/api/admin/resource-permissions',
    ADMIN_PERMISSIONS.ROLES_READ,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    'resource permissions'
  ),
  ...byMethod(
    '/api/admin/resource-permissions/*',
    ADMIN_PERMISSIONS.ROLES_READ,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    'resource permissions'
  ),

  ...byMethod(
    '/api/admin/users/:id/sessions',
    ADMIN_PERMISSIONS.SESSIONS_READ,
    ADMIN_PERMISSIONS.SESSIONS_REVOKE,
    ADMIN_PERMISSIONS.SESSIONS_REVOKE,
    'user session management'
  ),
  ...byMethod(
    '/api/admin/users/:id/refresh-tokens',
    ADMIN_PERMISSIONS.SESSIONS_READ,
    ADMIN_PERMISSIONS.SESSIONS_REVOKE,
    ADMIN_PERMISSIONS.SESSIONS_REVOKE,
    'user refresh-token revocation'
  ),
  ...byMethod(
    '/api/admin/users/:userId/device-secrets',
    ADMIN_PERMISSIONS.SESSIONS_READ,
    ADMIN_PERMISSIONS.SESSIONS_REVOKE,
    ADMIN_PERMISSIONS.SESSIONS_REVOKE,
    'native SSO user device secrets'
  ),
  ...byMethod(
    '/api/admin/users/:userId/device-secrets/*',
    ADMIN_PERMISSIONS.SESSIONS_READ,
    ADMIN_PERMISSIONS.SESSIONS_REVOKE,
    ADMIN_PERMISSIONS.SESSIONS_REVOKE,
    'native SSO user device secrets'
  ),
  ...byMethod(
    '/api/admin/sessions',
    ADMIN_PERMISSIONS.SESSIONS_READ,
    ADMIN_PERMISSIONS.SESSIONS_REVOKE,
    ADMIN_PERMISSIONS.SESSIONS_REVOKE,
    'admin-visible sessions'
  ),
  ...byMethod(
    '/api/admin/sessions/*',
    ADMIN_PERMISSIONS.SESSIONS_READ,
    ADMIN_PERMISSIONS.SESSIONS_REVOKE,
    ADMIN_PERMISSIONS.SESSIONS_REVOKE,
    'admin-visible sessions'
  ),
  ...byMethod(
    '/api/admin/device-secrets',
    ADMIN_PERMISSIONS.SESSIONS_READ,
    ADMIN_PERMISSIONS.SESSIONS_REVOKE,
    ADMIN_PERMISSIONS.SESSIONS_REVOKE,
    'native SSO device secrets'
  ),
  ...byMethod(
    '/api/admin/device-secrets/*',
    ADMIN_PERMISSIONS.SESSIONS_READ,
    ADMIN_PERMISSIONS.SESSIONS_REVOKE,
    ADMIN_PERMISSIONS.SESSIONS_REVOKE,
    'native SSO device secrets'
  ),

  ...byMethod(
    '/api/admin/email-deliveries',
    ADMIN_PERMISSIONS.EMAIL_DELIVERIES_READ,
    ADMIN_PERMISSIONS.EMAIL_DELIVERIES_READ,
    ADMIN_PERMISSIONS.EMAIL_DELIVERIES_READ,
    'email delivery diagnostics',
    TENANT_ADMIN_ROLES
  ),
  readOnly(
    '/api/admin/users/:id/email-deliveries',
    ADMIN_PERMISSIONS.EMAIL_DELIVERIES_READ,
    'user email delivery diagnostics'
  ),
  ...byMethod(
    '/api/admin/users/:id/support-context',
    ADMIN_PERMISSIONS.ACCOUNT_SUPPORT_CONTEXT_READ,
    ADMIN_PERMISSIONS.ACCOUNT_SUPPORT_CONTEXT_WRITE,
    ADMIN_PERMISSIONS.ACCOUNT_SUPPORT_CONTEXT_WRITE,
    'account support context'
  ),
  ...byMethod(
    '/api/admin/users/:id/legal-holds',
    ADMIN_PERMISSIONS.ACCOUNT_LEGAL_HOLDS_READ,
    ADMIN_PERMISSIONS.ACCOUNT_LEGAL_HOLDS_WRITE,
    ADMIN_PERMISSIONS.ACCOUNT_LEGAL_HOLDS_WRITE,
    'account legal holds'
  ),
  writeOnly(
    '/api/admin/users/:id/legal-holds/*',
    ADMIN_PERMISSIONS.ACCOUNT_LEGAL_HOLDS_WRITE,
    'account legal hold lifecycle'
  ),
  ...byMethod(
    '/api/admin/users',
    ADMIN_PERMISSIONS.USERS_READ,
    ADMIN_PERMISSIONS.USERS_WRITE,
    ADMIN_PERMISSIONS.USERS_DELETE,
    'end users'
  ),
  ...byMethod(
    '/api/admin/users/*',
    ADMIN_PERMISSIONS.USERS_READ,
    ADMIN_PERMISSIONS.USERS_WRITE,
    ADMIN_PERMISSIONS.USERS_DELETE,
    'end users'
  ),
  ...byMethod(
    '/api/admin/assets/login-ui',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'Login UI public assets'
  ),
  ...byMethod(
    '/api/admin/anonymous-users',
    ADMIN_PERMISSIONS.USERS_READ,
    ADMIN_PERMISSIONS.USERS_WRITE,
    ADMIN_PERMISSIONS.USERS_DELETE,
    'anonymous users'
  ),
  ...byMethod(
    '/api/admin/anonymous-users/*',
    ADMIN_PERMISSIONS.USERS_READ,
    ADMIN_PERMISSIONS.USERS_WRITE,
    ADMIN_PERMISSIONS.USERS_DELETE,
    'anonymous users'
  ),

  ...byMethod(
    '/api/admin/clients',
    ADMIN_PERMISSIONS.CLIENTS_READ,
    ADMIN_PERMISSIONS.CLIENTS_WRITE,
    ADMIN_PERMISSIONS.CLIENTS_DELETE,
    'OAuth clients'
  ),
  ...byMethod(
    '/api/admin/clients/*',
    ADMIN_PERMISSIONS.CLIENTS_READ,
    ADMIN_PERMISSIONS.CLIENTS_WRITE,
    ADMIN_PERMISSIONS.CLIENTS_DELETE,
    'OAuth clients'
  ),
  ...byMethod(
    '/api/admin/iat-tokens',
    ADMIN_PERMISSIONS.CLIENTS_READ,
    ADMIN_PERMISSIONS.CLIENTS_WRITE,
    ADMIN_PERMISSIONS.CLIENTS_WRITE,
    'initial access tokens'
  ),
  ...byMethod(
    '/api/admin/iat-tokens/*',
    ADMIN_PERMISSIONS.CLIENTS_READ,
    ADMIN_PERMISSIONS.CLIENTS_WRITE,
    ADMIN_PERMISSIONS.CLIENTS_WRITE,
    'initial access tokens'
  ),

  ...byMethod(
    '/api/admin/settings',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'tenant settings'
  ),
  ...byMethod(
    '/api/admin/settings/agent',
    ADMIN_PERMISSIONS.AGENT_SETTINGS_READ,
    ADMIN_PERMISSIONS.AGENT_SETTINGS_WRITE,
    ADMIN_PERMISSIONS.AGENT_SETTINGS_WRITE,
    'Agent Access settings'
  ),
  ...byMethod(
    '/api/admin/settings/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'tenant settings'
  ),
  ...byMethod(
    '/api/admin/platform/settings/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'platform settings',
    PLATFORM_ADMIN_ROLES
  ),
  rule({
    pattern: '/api/admin/tenants/:tenantId/settings/assurance',
    methods: ['PATCH'],
    permissions: [ADMIN_PERMISSIONS.SETTINGS_ASSURANCE_UPDATE],
    description: 'tenant assurance settings update',
  }),
  rule({
    pattern: '/api/admin/tenants/:tenantId/settings/security',
    methods: ['PATCH'],
    permissions: [ADMIN_PERMISSIONS.SETTINGS_SECURITY_UPDATE],
    description: 'tenant protocol security settings update',
  }),
  rule({
    pattern: '/api/admin/tenants/:tenantId/settings/tokens',
    methods: ['PATCH'],
    permissions: [ADMIN_PERMISSIONS.SETTINGS_TOKEN_EXCHANGE_UPDATE],
    description: 'tenant token settings update',
  }),
  rule({
    pattern: '/api/admin/tenants/:tenantId/settings/oauth',
    methods: ['PATCH'],
    permissions: [ADMIN_PERMISSIONS.SETTINGS_OAUTH_UPDATE],
    description: 'tenant OAuth settings update',
  }),
  rule({
    pattern: '/api/admin/tenants/:tenantId/settings/session',
    methods: ['PATCH'],
    permissions: [ADMIN_PERMISSIONS.SETTINGS_SESSION_UPDATE],
    description: 'tenant session and logout settings update',
  }),
  rule({
    pattern: '/api/admin/tenants/:tenantId/settings/login-ui',
    methods: ['PATCH'],
    permissions: [ADMIN_PERMISSIONS.SETTINGS_LOGIN_UI_UPDATE],
    description: 'tenant login UI settings update',
  }),
  ...byMethod(
    '/api/admin/tenants/:tenantId/settings/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'scoped tenant settings'
  ),
  ...byMethod(
    '/api/admin/tenants/:tenantId/email-settings',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'tenant email settings'
  ),
  ...byMethod(
    '/api/admin/tenants/:tenantId/directory-connectors',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_READ,
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_WRITE,
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_WRITE,
    'tenant directory connectors'
  ),
  ...byMethod(
    '/api/admin/tenants/:tenantId/directory-connectors/*',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_READ,
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_WRITE,
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_WRITE,
    'tenant directory connector operations'
  ),
  readOnly(
    '/api/admin/tenants/:tenantId/directory-auth/overview',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_READ,
    'tenant directory authentication overview'
  ),
  ...byMethod(
    '/api/admin/tenants/:tenantId/directory-auth/policy',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_READ,
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_WRITE,
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_WRITE,
    'tenant directory authentication policy'
  ),
  readOnly(
    '/api/admin/tenants/:tenantId/directory-auth/migration/campaigns',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_READ,
    'tenant directory authentication migration campaigns'
  ),
  writeOnly(
    '/api/admin/tenants/:tenantId/directory-auth/migration/campaigns',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_MIGRATION_WRITE,
    'tenant directory authentication migration campaign changes'
  ),
  writeOnly(
    '/api/admin/tenants/:tenantId/directory-auth/migration/campaigns/*',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_MIGRATION_WRITE,
    'tenant directory authentication migration campaign changes'
  ),
  readOnly(
    '/api/admin/tenants/:tenantId/directory-auth/migration/user-states',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_READ,
    'tenant directory authentication migration user states'
  ),
  writeOnly(
    '/api/admin/tenants/:tenantId/directory-auth/migration/user-states/*',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_MIGRATION_WRITE,
    'tenant directory authentication migration user state changes'
  ),
  ...byMethod(
    '/api/admin/tenants/:tenantId/directory-auth/compliance/retention',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_READ,
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_WRITE,
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_WRITE,
    'tenant directory authentication retention policy'
  ),
  readOnly(
    '/api/admin/tenants/:tenantId/directory-auth/compliance/config-history',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_READ,
    'tenant directory authentication config history'
  ),
  readOnly(
    '/api/admin/tenants/:tenantId/directory-auth/compliance/evidence-exports',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_EVIDENCE_EXPORT_CREATE,
    'tenant directory authentication evidence exports'
  ),
  writeOnly(
    '/api/admin/tenants/:tenantId/directory-auth/compliance/evidence-exports',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_EVIDENCE_EXPORT_CREATE,
    'tenant directory authentication evidence export creation'
  ),
  readOnly(
    '/api/admin/tenants/:tenantId/directory-auth/compliance/evidence-exports/*',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_EVIDENCE_EXPORT_CREATE,
    'tenant directory authentication evidence export artifacts'
  ),
  ...byMethod(
    '/api/admin/tenants/:tenantId/directory-auth/support/bundles',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_READ,
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_WRITE,
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_WRITE,
    'tenant directory authentication support bundles'
  ),
  readOnly(
    '/api/admin/tenants/:tenantId/directory-auth/support/bundles/*',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_WRITE,
    'tenant directory authentication support bundle artifacts'
  ),
  readOnly(
    '/api/admin/tenants/:tenantId/directory-auth/managed/advisories',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_READ,
    'tenant directory authentication managed advisories'
  ),
  rule({
    pattern: '/api/admin/tenants/:tenantId/directory-auth/maintenance/cleanup',
    methods: [...WRITE_METHODS, ...DELETE_METHODS],
    roles: TENANT_ADMIN_ROLES,
    description: 'tenant directory authentication maintenance cleanup',
  }),
  readOnly(
    '/api/admin/tenants/:tenantId/directory-auth/managed/connectors',
    ADMIN_PERMISSIONS.DIRECTORY_AUTH_READ,
    'tenant directory authentication managed connectors'
  ),
  ...byMethod(
    '/api/admin/tenants/:tenantId/audit/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'tenant audit settings'
  ),
  ...byMethod(
    '/api/admin/tenants',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'tenant administration',
    PLATFORM_ADMIN_ROLES
  ),
  rule({
    pattern: '/api/admin/tenants/:tenantId/clone',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.TENANT_LIFECYCLE_STANDARD],
    description: 'clone tenant configuration',
  }),
  ...byMethod(
    '/api/admin/tenants/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'tenant administration',
    PLATFORM_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/runtime-profiles',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'runtime profiles',
    PLATFORM_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/runtime-profiles/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'runtime profiles',
    PLATFORM_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/tenant-policy',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'contract tenant policy',
    ['system_admin', 'org_admin', 'admin']
  ),
  ...byMethod(
    '/api/admin/tenant-policy/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'contract tenant policy',
    ['system_admin', 'org_admin', 'admin']
  ),
  ...byMethod(
    '/api/admin/client-profile-presets',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'client profile presets'
  ),
  readOnly('/api/admin/effective-policy', ADMIN_PERMISSIONS.SETTINGS_READ, 'effective policy'),
  readOnly('/api/admin/effective-policy/*', ADMIN_PERMISSIONS.SETTINGS_READ, 'effective policy'),

  ...byMethod(
    '/api/admin/tenant-vanity-domains',
    ADMIN_PERMISSIONS.TENANT_DOMAINS_READ,
    ADMIN_PERMISSIONS.TENANT_DOMAINS_WRITE,
    ADMIN_PERMISSIONS.TENANT_DOMAINS_DELETE,
    'tenant vanity domains'
  ),
  ...byMethod(
    '/api/admin/tenant-vanity-domains/*',
    ADMIN_PERMISSIONS.TENANT_DOMAINS_READ,
    ADMIN_PERMISSIONS.TENANT_DOMAINS_WRITE,
    ADMIN_PERMISSIONS.TENANT_DOMAINS_DELETE,
    'tenant vanity domains'
  ),
  ...byMethod(
    '/api/admin/platform/tenant-domain-mappings',
    ADMIN_PERMISSIONS.TENANT_DOMAINS_READ,
    ADMIN_PERMISSIONS.TENANT_DOMAINS_WRITE,
    ADMIN_PERMISSIONS.TENANT_DOMAINS_DELETE,
    'platform tenant domain mappings',
    PLATFORM_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/platform/tenant-domain-mappings/*',
    ADMIN_PERMISSIONS.TENANT_DOMAINS_READ,
    ADMIN_PERMISSIONS.TENANT_DOMAINS_WRITE,
    ADMIN_PERMISSIONS.TENANT_DOMAINS_DELETE,
    'platform tenant domain mappings',
    PLATFORM_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/platform/tenant-vanity-domains',
    ADMIN_PERMISSIONS.TENANT_DOMAINS_READ,
    ADMIN_PERMISSIONS.TENANT_DOMAINS_WRITE,
    ADMIN_PERMISSIONS.TENANT_DOMAINS_DELETE,
    'platform tenant vanity domains',
    PLATFORM_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/platform/tenant-vanity-domains/*',
    ADMIN_PERMISSIONS.TENANT_DOMAINS_READ,
    ADMIN_PERMISSIONS.TENANT_DOMAINS_WRITE,
    ADMIN_PERMISSIONS.TENANT_DOMAINS_DELETE,
    'platform tenant vanity domains',
    PLATFORM_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/org-domain-mappings',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'organization domain mappings'
  ),
  ...byMethod(
    '/api/admin/org-domain-mappings/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'organization domain mappings'
  ),

  ...byMethod(
    '/api/admin/attributes',
    ADMIN_PERMISSIONS.USERS_READ,
    ADMIN_PERMISSIONS.USERS_WRITE,
    ADMIN_PERMISSIONS.USERS_WRITE,
    'ABAC attributes',
    TENANT_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/attributes/*',
    ADMIN_PERMISSIONS.USERS_READ,
    ADMIN_PERMISSIONS.USERS_WRITE,
    ADMIN_PERMISSIONS.USERS_WRITE,
    'ABAC attributes',
    TENANT_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/custom-claims',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'custom claims',
    TENANT_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/custom-claims/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'custom claims',
    TENANT_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/token-claim-rules',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'token claim rules'
  ),
  ...byMethod(
    '/api/admin/token-claim-rules/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'token claim rules'
  ),
  ...byMethod(
    '/api/admin/field-mapping',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'identity field mapping'
  ),
  ...byMethod(
    '/api/admin/field-mapping/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'identity field mapping'
  ),
  readOnly(
    '/api/admin/credential-profiles',
    ADMIN_PERMISSIONS.VC_CREDENTIAL_PROFILES_READ,
    'credential profiles'
  ),
  writeOnly(
    '/api/admin/credential-profiles',
    ADMIN_PERMISSIONS.VC_CREDENTIAL_PROFILES_WRITE,
    'credential profiles'
  ),
  readOnly(
    '/api/admin/credential-profiles/:id',
    ADMIN_PERMISSIONS.VC_CREDENTIAL_PROFILES_READ,
    'credential profile'
  ),
  writeOnly(
    '/api/admin/credential-profiles/:id',
    ADMIN_PERMISSIONS.VC_CREDENTIAL_PROFILES_WRITE,
    'credential profile'
  ),
  writeOnly(
    '/api/admin/credential-profiles/:id/versions',
    ADMIN_PERMISSIONS.VC_CREDENTIAL_PROFILES_WRITE,
    'credential profile versions'
  ),
  writeOnly(
    '/api/admin/credential-profiles/:id/versions/:versionId/publish',
    ADMIN_PERMISSIONS.VC_CREDENTIAL_PROFILES_PUBLISH,
    'credential profile publication'
  ),
  writeOnly(
    '/api/admin/credential-profiles/:id/offers',
    ADMIN_PERMISSIONS.VC_CREDENTIAL_OFFERS_CREATE,
    'credential offer creation'
  ),
  ...byMethod(
    '/api/admin/flows',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'flow definitions',
    TENANT_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/flows/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'flow definitions',
    TENANT_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/screens',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'screens',
    TENANT_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/screens/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'screens',
    TENANT_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/flow-assignments',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'flow assignments',
    TENANT_ADMIN_ROLES
  ),

  ...byMethod(
    '/api/admin/signing-keys',
    ADMIN_PERMISSIONS.SECURITY_READ,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    'signing keys'
  ),
  ...byMethod(
    '/api/admin/signing-keys/*',
    ADMIN_PERMISSIONS.SECURITY_READ,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    'signing keys'
  ),
  ...byMethod(
    '/api/admin/scim-tokens',
    ADMIN_PERMISSIONS.SECURITY_READ,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    'SCIM bearer tokens'
  ),
  ...byMethod(
    '/api/admin/scim-tokens/*',
    ADMIN_PERMISSIONS.SECURITY_READ,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    'SCIM bearer tokens'
  ),
  ...byMethod(
    '/api/admin/scim-settings',
    ADMIN_PERMISSIONS.SECURITY_READ,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    'SCIM inbound settings'
  ),
  ...byMethod(
    '/api/admin/check-api-keys',
    ADMIN_PERMISSIONS.SECURITY_READ,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    'check API keys'
  ),
  ...byMethod(
    '/api/admin/check-api-keys/*',
    ADMIN_PERMISSIONS.SECURITY_READ,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    'check API keys'
  ),
  ...byMethod(
    '/api/admin/security',
    ADMIN_PERMISSIONS.SECURITY_READ,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    'security monitoring',
    TENANT_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/security/*',
    ADMIN_PERMISSIONS.SECURITY_READ,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    'security monitoring',
    TENANT_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/vc',
    ADMIN_PERMISSIONS.SECURITY_READ,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    'verifiable credential status'
  ),
  ...byMethod(
    '/api/admin/vc/*',
    ADMIN_PERMISSIONS.SECURITY_READ,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    ADMIN_PERMISSIONS.SECURITY_WRITE,
    'verifiable credential status'
  ),

  ...byMethod(
    '/api/admin/external-providers',
    ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_READ,
    ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_WRITE,
    ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_DELETE,
    'external identity providers'
  ),
  ...byMethod(
    '/api/admin/external-providers/*',
    ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_READ,
    ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_WRITE,
    ADMIN_PERMISSIONS.EXTERNAL_PROVIDERS_DELETE,
    'external identity providers'
  ),
  ...byMethod(
    '/api/admin/external-token-refresh',
    ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_READ,
    ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_WRITE,
    ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_WRITE,
    'external token refresh'
  ),
  rule({
    pattern: '/api/admin/external-token-refresh/run',
    methods: WRITE_METHODS,
    permissions: [ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_RUN],
    description: 'external token refresh manual run',
  }),
  ...byMethod(
    '/api/admin/external-token-refresh/*',
    ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_READ,
    ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_WRITE,
    ADMIN_PERMISSIONS.EXTERNAL_TOKEN_REFRESH_WRITE,
    'external token refresh'
  ),

  ...byMethod(
    '/api/admin/admins',
    ADMIN_PERMISSIONS.ADMIN_USERS_READ,
    ADMIN_PERMISSIONS.ADMIN_USERS_WRITE,
    ADMIN_PERMISSIONS.ADMIN_USERS_DELETE,
    'admin users'
  ),
  ...byMethod(
    '/api/admin/admins/*',
    ADMIN_PERMISSIONS.ADMIN_USERS_READ,
    ADMIN_PERMISSIONS.ADMIN_USERS_WRITE,
    ADMIN_PERMISSIONS.ADMIN_USERS_DELETE,
    'admin users'
  ),
  rule({
    pattern: '/api/admin/admin-invitations',
    methods: READ_METHODS,
    permissions: [ADMIN_PERMISSIONS.ADMIN_USERS_READ],
    description: 'admin invitations read',
  }),
  rule({
    pattern: '/api/admin/admin-invitations',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.ADMIN_USERS_WRITE, ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE],
    description: 'admin invitations create',
  }),
  rule({
    pattern: '/api/admin/admin-invitations/*',
    methods: ['POST', 'DELETE'],
    permissions: [ADMIN_PERMISSIONS.ADMIN_USERS_WRITE, ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE],
    description: 'admin invitations resend or revoke',
  }),
  ...byMethod(
    '/api/admin/admin-roles',
    ADMIN_PERMISSIONS.ADMIN_ROLES_READ,
    ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
    ADMIN_PERMISSIONS.ADMIN_ROLES_DELETE,
    'admin roles'
  ),
  ...byMethod(
    '/api/admin/admin-roles/*',
    ADMIN_PERMISSIONS.ADMIN_ROLES_READ,
    ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
    ADMIN_PERMISSIONS.ADMIN_ROLES_DELETE,
    'admin roles'
  ),
  ...byMethod(
    '/api/admin/ip-allowlist',
    ADMIN_PERMISSIONS.IP_ALLOWLIST_READ,
    ADMIN_PERMISSIONS.IP_ALLOWLIST_WRITE,
    ADMIN_PERMISSIONS.IP_ALLOWLIST_DELETE,
    'admin IP allowlist'
  ),
  ...byMethod(
    '/api/admin/ip-allowlist/*',
    ADMIN_PERMISSIONS.IP_ALLOWLIST_READ,
    ADMIN_PERMISSIONS.IP_ALLOWLIST_WRITE,
    ADMIN_PERMISSIONS.IP_ALLOWLIST_DELETE,
    'admin IP allowlist'
  ),
  ...byMethod(
    '/api/admin/admin-audit-log',
    ADMIN_PERMISSIONS.ADMIN_AUDIT_READ,
    ADMIN_PERMISSIONS.ADMIN_AUDIT_READ,
    ADMIN_PERMISSIONS.ADMIN_AUDIT_READ,
    'admin audit log'
  ),
  ...byMethod(
    '/api/admin/admin-audit-log/*',
    ADMIN_PERMISSIONS.ADMIN_AUDIT_READ,
    ADMIN_PERMISSIONS.ADMIN_AUDIT_DETAIL_READ,
    ADMIN_PERMISSIONS.ADMIN_AUDIT_DETAIL_READ,
    'admin audit log'
  ),
  ...byMethod(
    '/api/admin/admin-attributes',
    ADMIN_PERMISSIONS.ADMIN_USERS_READ,
    ADMIN_PERMISSIONS.ADMIN_USERS_WRITE,
    ADMIN_PERMISSIONS.ADMIN_USERS_DELETE,
    'admin ABAC attributes'
  ),
  ...byMethod(
    '/api/admin/admin-attributes/*',
    ADMIN_PERMISSIONS.ADMIN_USERS_READ,
    ADMIN_PERMISSIONS.ADMIN_USERS_WRITE,
    ADMIN_PERMISSIONS.ADMIN_USERS_DELETE,
    'admin ABAC attributes'
  ),
  ...byMethod(
    '/api/admin/admin-relationships',
    ADMIN_PERMISSIONS.ADMIN_ROLES_READ,
    ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
    ADMIN_PERMISSIONS.ADMIN_ROLES_DELETE,
    'admin ReBAC relationships'
  ),
  ...byMethod(
    '/api/admin/admin-relationships/*',
    ADMIN_PERMISSIONS.ADMIN_ROLES_READ,
    ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
    ADMIN_PERMISSIONS.ADMIN_ROLES_DELETE,
    'admin ReBAC relationships'
  ),
  ...byMethod(
    '/api/admin/admin-rebac-definitions',
    ADMIN_PERMISSIONS.ADMIN_ROLES_READ,
    ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
    ADMIN_PERMISSIONS.ADMIN_ROLES_DELETE,
    'admin ReBAC definitions'
  ),
  ...byMethod(
    '/api/admin/admin-rebac-definitions/*',
    ADMIN_PERMISSIONS.ADMIN_ROLES_READ,
    ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
    ADMIN_PERMISSIONS.ADMIN_ROLES_DELETE,
    'admin ReBAC definitions'
  ),
  ...byMethod(
    '/api/admin/admin-policies',
    ADMIN_PERMISSIONS.ADMIN_ROLES_READ,
    ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
    ADMIN_PERMISSIONS.ADMIN_ROLES_DELETE,
    'admin access policies'
  ),
  ...byMethod(
    '/api/admin/admin-policies/*',
    ADMIN_PERMISSIONS.ADMIN_ROLES_READ,
    ADMIN_PERMISSIONS.ADMIN_ROLES_WRITE,
    ADMIN_PERMISSIONS.ADMIN_ROLES_DELETE,
    'admin access policies'
  ),
  readOnly(
    '/api/admin/admin-access-control',
    ADMIN_PERMISSIONS.ADMIN_ROLES_READ,
    'admin access control hub'
  ),
  readOnly(
    '/api/admin/admin-access-control/*',
    ADMIN_PERMISSIONS.ADMIN_ROLES_READ,
    'admin access control hub'
  ),
  ...byMethod(
    '/api/admin/approvals',
    ADMIN_PERMISSIONS.APPROVALS_READ,
    ADMIN_PERMISSIONS.APPROVALS_WRITE,
    ADMIN_PERMISSIONS.APPROVALS_WRITE,
    'admin approvals'
  ),
  ...byMethod(
    '/api/admin/approvals/*',
    ADMIN_PERMISSIONS.APPROVALS_READ,
    ADMIN_PERMISSIONS.APPROVALS_WRITE,
    ADMIN_PERMISSIONS.APPROVALS_WRITE,
    'admin approvals'
  ),
  ...byMethod(
    '/api/admin/operational-logs',
    ADMIN_PERMISSIONS.OPERATIONAL_LOGS_READ,
    ADMIN_PERMISSIONS.OPERATIONAL_LOGS_DETAIL_READ,
    ADMIN_PERMISSIONS.OPERATIONAL_LOGS_DETAIL_READ,
    'operational logs'
  ),
  ...byMethod(
    '/api/admin/operational-logs/*',
    ADMIN_PERMISSIONS.OPERATIONAL_LOGS_READ,
    ADMIN_PERMISSIONS.OPERATIONAL_LOGS_DETAIL_READ,
    ADMIN_PERMISSIONS.OPERATIONAL_LOGS_DETAIL_READ,
    'operational logs'
  ),
  ...byMethod(
    '/api/admin/storage-destinations',
    ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_LIST,
    ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE,
    ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_DELETE,
    'storage destinations'
  ),
  ...byMethod(
    '/api/admin/storage-destinations/*',
    ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_READ,
    ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE,
    ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_DELETE,
    'storage destinations'
  ),
  ...byMethod(
    '/api/admin/database-connections',
    ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_LIST,
    ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_CREATE,
    ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_DELETE,
    'database connections'
  ),
  ...byMethod(
    '/api/admin/database-connections/*',
    ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_READ,
    ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_UPDATE,
    ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_DELETE,
    'database connections'
  ),
  ...byMethod(
    '/api/admin/platform/read-replication',
    ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_READ,
    ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_UPDATE,
    ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_UPDATE,
    'platform D1 read replication',
    PLATFORM_ADMIN_ROLES
  ),
  rule({
    pattern: '/api/admin/platform/control-plane/capacity/preview',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.CONTROL_PLANE_READ],
    roles: PLATFORM_ADMIN_ROLES,
    description: 'platform control plane capacity preview',
  }),
  rule({
    pattern: '/api/admin/platform/control-plane/lookup-hmac/rotations',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.CONTROL_PLANE_ROTATE],
    roles: PLATFORM_ADMIN_ROLES,
    description: 'platform control plane lookup HMAC rotation start',
  }),
  rule({
    pattern: '/api/admin/platform/control-plane/lookup-hmac/rotations/:operationId/activate',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.CONTROL_PLANE_ROTATE],
    roles: PLATFORM_ADMIN_ROLES,
    description: 'platform control plane lookup HMAC rotation activation',
  }),
  rule({
    pattern:
      '/api/admin/platform/control-plane/lookup-hmac/rotations/:operationId/observe-generation',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.CONTROL_PLANE_ROTATE],
    roles: PLATFORM_ADMIN_ROLES,
    description: 'platform control plane lookup HMAC generation observation',
  }),
  ...byMethod(
    '/api/admin/platform/control-plane/*',
    ADMIN_PERMISSIONS.CONTROL_PLANE_READ,
    ADMIN_PERMISSIONS.CONTROL_PLANE_PROVISION,
    ADMIN_PERMISSIONS.CONTROL_PLANE_PROVISION,
    'platform control plane operations',
    PLATFORM_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/machine-access',
    ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_READ,
    ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE,
    ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_DELETE,
    'admin machine access'
  ),
  ...byMethod(
    '/api/admin/machine-access/*',
    ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_READ,
    ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_WRITE,
    ADMIN_PERMISSIONS.ADMIN_MACHINE_ACCESS_DELETE,
    'admin machine access'
  ),

  ...byMethod(
    '/api/admin/destinations',
    ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_LIST,
    ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE,
    ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_DELETE,
    'logging destinations'
  ),
  ...byMethod(
    '/api/admin/destinations/*',
    ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_READ,
    ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE,
    ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_DELETE,
    'logging destinations'
  ),
  ...byMethod(
    '/api/admin/logging-policies',
    ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
    ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
    ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
    'logging policies'
  ),
  ...byMethod(
    '/api/admin/logging-policies/*',
    ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
    ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
    ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
    'logging policies'
  ),
  ...byMethod(
    '/api/admin/admin-logging',
    ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ,
    ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN,
    ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN,
    'admin logging operations'
  ),
  ...byMethod(
    '/api/admin/admin-logging/*',
    ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ,
    ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN,
    ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_RUN,
    'admin logging operations'
  ),
  ...byMethod(
    '/api/admin/notifications',
    ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
    ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
    'logging notifications'
  ),
  ...byMethod(
    '/api/admin/notifications/*',
    ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
    ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
    ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
    'logging notifications'
  ),
  ...byMethod(
    '/api/admin/diagnostic-logging',
    ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
    ADMIN_PERMISSIONS.LOGGING_EXPORT_CREATE,
    ADMIN_PERMISSIONS.LOGGING_EXPORT_CREATE,
    'diagnostic logging'
  ),
  ...byMethod(
    '/api/admin/diagnostic-logging/*',
    ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
    ADMIN_PERMISSIONS.LOGGING_EXPORT_CREATE,
    ADMIN_PERMISSIONS.LOGGING_EXPORT_CREATE,
    'diagnostic logging'
  ),

  ...byMethod(
    '/api/admin/webhooks',
    ADMIN_PERMISSIONS.WEBHOOKS_READ,
    ADMIN_PERMISSIONS.WEBHOOKS_WRITE,
    ADMIN_PERMISSIONS.WEBHOOKS_DELETE,
    'webhooks'
  ),
  ...byMethod(
    '/api/admin/webhooks/*',
    ADMIN_PERMISSIONS.WEBHOOKS_READ,
    ADMIN_PERMISSIONS.WEBHOOKS_WRITE,
    ADMIN_PERMISSIONS.WEBHOOKS_DELETE,
    'webhooks'
  ),

  ...byMethod(
    '/api/admin/jobs',
    ADMIN_PERMISSIONS.JOBS_READ,
    ADMIN_PERMISSIONS.JOBS_WRITE,
    ADMIN_PERMISSIONS.JOBS_WRITE,
    'admin jobs',
    TENANT_ADMIN_ROLES
  ),
  rule({
    pattern: '/api/admin/jobs/schedules',
    methods: READ_METHODS,
    roles: PLATFORM_ADMIN_ROLES,
    description: 'platform R2 maintenance schedules and storage metrics',
  }),
  ...byMethod(
    '/api/admin/jobs/*',
    ADMIN_PERMISSIONS.JOBS_READ,
    ADMIN_PERMISSIONS.JOBS_WRITE,
    ADMIN_PERMISSIONS.JOBS_WRITE,
    'admin jobs',
    TENANT_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/support-ops',
    ADMIN_PERMISSIONS.SUPPORT_OPS_REGISTRY_READ,
    ADMIN_PERMISSIONS.SUPPORT_OPS_ACTIONS_REQUEST,
    ADMIN_PERMISSIONS.SUPPORT_OPS_ACTIONS_REQUEST,
    'privacy-preserving support operations'
  ),
  ...byMethod(
    '/api/admin/support-ops/*',
    ADMIN_PERMISSIONS.SUPPORT_OPS_REGISTRY_READ,
    ADMIN_PERMISSIONS.SUPPORT_OPS_ACTIONS_REQUEST,
    ADMIN_PERMISSIONS.SUPPORT_OPS_ACTIONS_REQUEST,
    'privacy-preserving support operations'
  ),

  rule({
    pattern: '/api/admin/stats',
    methods: READ_METHODS,
    anyPermissions: [
      ADMIN_PERMISSIONS.USERS_READ,
      ADMIN_PERMISSIONS.CLIENTS_READ,
      ADMIN_PERMISSIONS.AUDIT_READ,
    ],
    description: 'admin dashboard stats',
  }),
  rule({
    pattern: '/api/admin/stats/*',
    methods: READ_METHODS,
    anyPermissions: [
      ADMIN_PERMISSIONS.USERS_READ,
      ADMIN_PERMISSIONS.CLIENTS_READ,
      ADMIN_PERMISSIONS.AUDIT_READ,
    ],
    roles: TENANT_ADMIN_ROLES,
    description: 'admin dashboard stats',
  }),
  ...byMethod(
    '/api/admin/access-trace',
    ADMIN_PERMISSIONS.AUDIT_READ,
    ADMIN_PERMISSIONS.AUDIT_READ,
    ADMIN_PERMISSIONS.AUDIT_READ,
    'access trace',
    TENANT_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/access-trace/*',
    ADMIN_PERMISSIONS.AUDIT_READ,
    ADMIN_PERMISSIONS.AUDIT_READ,
    ADMIN_PERMISSIONS.AUDIT_READ,
    'access trace',
    TENANT_ADMIN_ROLES
  ),
  readOnly(
    '/api/admin/access-control/*',
    ADMIN_PERMISSIONS.ROLES_READ,
    'access control aggregate stats'
  ),
  ...byMethod(
    '/api/admin/agent-grants',
    ADMIN_PERMISSIONS.AGENT_GRANTS_READ,
    ADMIN_PERMISSIONS.AGENT_GRANTS_WRITE,
    ADMIN_PERMISSIONS.AGENT_GRANTS_REVOKE,
    'Agent Access grants'
  ),
  readOnly(
    '/api/admin/agent-grants/eligible-permissions',
    ADMIN_PERMISSIONS.AGENT_GRANTS_WRITE,
    'Agent Access grant permission eligibility'
  ),
  ...byMethod(
    '/api/admin/agent-grants/*',
    ADMIN_PERMISSIONS.AGENT_GRANTS_READ,
    ADMIN_PERMISSIONS.AGENT_GRANTS_WRITE,
    ADMIN_PERMISSIONS.AGENT_GRANTS_REVOKE,
    'Agent Access grants'
  ),
  rule({
    pattern: '/api/admin/agent-login-handoffs/:id/approve',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.AGENT_USE],
    description: 'Approve an Admin Agent login handoff on the central Admin origin',
  }),
  ...byMethod(
    '/api/admin/agent-elevations/*',
    ADMIN_PERMISSIONS.AGENT_USE,
    ADMIN_PERMISSIONS.AGENT_USE,
    ADMIN_PERMISSIONS.AGENT_ELEVATION_RECONCILE,
    'Agent elevation review and decision'
  ),
  ...byMethod(
    '/api/admin/agent-task-sets',
    ADMIN_PERMISSIONS.AGENT_TASK_SETS_READ,
    ADMIN_PERMISSIONS.AGENT_TASK_SETS_WRITE,
    ADMIN_PERMISSIONS.AGENT_TASK_SETS_WRITE,
    'Agent Task Sets'
  ),
  ...byMethod(
    '/api/admin/agent-task-sets/*',
    ADMIN_PERMISSIONS.AGENT_TASK_SETS_READ,
    ADMIN_PERMISSIONS.AGENT_TASK_SETS_WRITE,
    ADMIN_PERMISSIONS.AGENT_TASK_SETS_WRITE,
    'Agent Task Sets'
  ),
  ...byMethod(
    '/api/admin/agent-scope-policies',
    ADMIN_PERMISSIONS.AGENT_SCOPE_POLICIES_READ,
    ADMIN_PERMISSIONS.AGENT_SCOPE_POLICIES_WRITE,
    ADMIN_PERMISSIONS.AGENT_SCOPE_POLICIES_WRITE,
    'Agent Scope Policies'
  ),
  ...byMethod(
    '/api/admin/agent-scope-policies/*',
    ADMIN_PERMISSIONS.AGENT_SCOPE_POLICIES_READ,
    ADMIN_PERMISSIONS.AGENT_SCOPE_POLICIES_WRITE,
    ADMIN_PERMISSIONS.AGENT_SCOPE_POLICIES_WRITE,
    'Agent Scope Policies'
  ),
  ...byMethod(
    '/api/admin/agent-templates',
    ADMIN_PERMISSIONS.AGENT_TEMPLATES_PUBLISH,
    ADMIN_PERMISSIONS.AGENT_TEMPLATES_PUBLISH,
    ADMIN_PERMISSIONS.AGENT_TEMPLATES_PUBLISH,
    'Agent configuration templates'
  ),
  ...byMethod(
    '/api/admin/agent-templates/*',
    ADMIN_PERMISSIONS.AGENT_TEMPLATES_PUBLISH,
    ADMIN_PERMISSIONS.AGENT_TEMPLATES_PUBLISH,
    ADMIN_PERMISSIONS.AGENT_TEMPLATES_PUBLISH,
    'Agent configuration template copies'
  ),
  ...byMethod(
    '/api/admin/agent-baselines',
    ADMIN_PERMISSIONS.AGENT_BASELINES_READ,
    ADMIN_PERMISSIONS.AGENT_BASELINES_WRITE,
    ADMIN_PERMISSIONS.AGENT_BASELINES_APPLY,
    'Agent baselines'
  ),
  ...byMethod(
    '/api/admin/agent-baselines/*',
    ADMIN_PERMISSIONS.AGENT_BASELINES_READ,
    ADMIN_PERMISSIONS.AGENT_BASELINES_APPLY,
    ADMIN_PERMISSIONS.AGENT_BASELINES_APPLY,
    'Agent baseline assignments and exceptions'
  ),
  ...byMethod(
    '/api/admin/agent-bulk-plans',
    ADMIN_PERMISSIONS.BULK_PLANS_READ,
    ADMIN_PERMISSIONS.BULK_PLANS_CREATE,
    ADMIN_PERMISSIONS.BULK_PLANS_APPLY,
    'Agent Bulk Plans'
  ),
  rule({
    pattern: '/api/admin/agent-bulk-plans/:id/:version/start',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.BULK_PLANS_APPLY],
    description: 'Start Agent Bulk Plan',
  }),
  rule({
    pattern: '/api/admin/agent-bulk-plans/:id/:version/pause',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.BULK_PLANS_PAUSE],
    description: 'Pause Agent Bulk Plan',
  }),
  rule({
    pattern: '/api/admin/agent-bulk-plans/:id/:version/resume',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.BULK_PLANS_RESUME],
    description: 'Resume Agent Bulk Plan',
  }),
  rule({
    pattern: '/api/admin/agent-bulk-plans/:id/:version/cancel',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.BULK_PLANS_APPLY],
    description: 'Cancel Agent Bulk Plan',
  }),
  ...byMethod(
    '/api/admin/agent-bulk-plans/*',
    ADMIN_PERMISSIONS.BULK_PLANS_READ,
    ADMIN_PERMISSIONS.BULK_PLANS_CREATE,
    ADMIN_PERMISSIONS.BULK_PLANS_APPLY,
    'Agent Bulk Plans'
  ),
  rule({
    pattern: '/api/admin/agent-config-plans/:id/:version/confirm',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_APPLY],
    description: 'Agent configuration Plan confirmation',
  }),
  rule({
    pattern: '/api/admin/agent-config-plans/:id/:version/cancel',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CANCEL],
    description: 'Cancel Agent configuration Plan',
  }),
  ...byMethod(
    '/api/admin/agent-config-plans/*',
    ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_READ,
    ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CREATE,
    ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CANCEL,
    'Agent configuration Plans'
  ),
  ...byMethod(
    '/api/admin/agent-config-plans',
    ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_READ,
    ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CREATE,
    ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CANCEL,
    'Agent configuration Plans'
  ),
  ...byMethod(
    '/api/admin/agent-secret-refs',
    ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_READ,
    ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CREATE,
    ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CANCEL,
    'Agent opaque secret references'
  ),
  rule({
    pattern: '/api/admin/agent-secret-refs/:id/revoke',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.AUTH_CONFIG_PLANS_CREATE],
    description: 'Revoke an Agent opaque secret reference',
  }),
  readOnly('/api/admin/agent-read/users', ADMIN_PERMISSIONS.USERS_READ, 'Agent-safe user search'),
  readOnly('/api/admin/agent-read/users/*', ADMIN_PERMISSIONS.USERS_READ, 'Agent-safe user detail'),
  readOnly(
    '/api/admin/agent-read/clients',
    ADMIN_PERMISSIONS.CLIENTS_READ,
    'Agent-safe client list'
  ),
  readOnly(
    '/api/admin/agent-read/clients/*',
    ADMIN_PERMISSIONS.CLIENTS_READ,
    'Agent-safe client detail'
  ),
  readOnly(
    '/api/admin/agent-read/session-posture',
    ADMIN_PERMISSIONS.SESSIONS_READ,
    'Agent-safe aggregate session posture'
  ),
  rule({
    pattern: '/api/admin/agent-write/users/:id/suspend',
    methods: ['POST'],
    permissions: [ADMIN_PERMISSIONS.USERS_SUSPEND],
    description: 'Agent operation-bound user suspension',
  }),
  readOnly(
    '/api/admin/agent-read/admin-audit-log',
    ADMIN_PERMISSIONS.ADMIN_AUDIT_READ,
    'Agent-safe Admin audit search'
  ),
  ...byMethod(
    '/api/admin/rebac',
    ADMIN_PERMISSIONS.ROLES_READ,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    ADMIN_PERMISSIONS.ROLES_DELETE,
    'ReBAC definitions',
    PLATFORM_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/rebac/*',
    ADMIN_PERMISSIONS.ROLES_READ,
    ADMIN_PERMISSIONS.ROLES_WRITE,
    ADMIN_PERMISSIONS.ROLES_DELETE,
    'ReBAC definitions',
    PLATFORM_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/compliance',
    ADMIN_PERMISSIONS.AUDIT_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'compliance operations',
    TENANT_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/compliance/*',
    ADMIN_PERMISSIONS.AUDIT_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'compliance operations',
    TENANT_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/data-retention',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'data retention'
  ),
  ...byMethod(
    '/api/admin/data-retention/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'data retention'
  ),
  readOnly('/api/admin/audit-logs', ADMIN_PERMISSIONS.AUDIT_READ, 'end-user audit logs'),
  readOnly('/api/admin/audit-logs/*', ADMIN_PERMISSIONS.AUDIT_READ, 'end-user audit logs'),
  ...byMethod(
    '/api/admin/consent-statements',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'consent statements'
  ),
  ...byMethod(
    '/api/admin/consent-statements/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'consent statements'
  ),
  ...byMethod(
    '/api/admin/consent-policies',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'consent policies'
  ),
  ...byMethod(
    '/api/admin/consent-policies/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'consent policies'
  ),
  ...byMethod(
    '/api/admin/client-trust-policies',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'client trust policies'
  ),
  ...byMethod(
    '/api/admin/sign-in-confirmation-policies',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'sign-in confirmation policies'
  ),
  ...byMethod(
    '/api/admin/consent-requirements',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'consent requirements'
  ),
  ...byMethod(
    '/api/admin/consent-requirements/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'consent requirements'
  ),
  ...byMethod(
    '/api/admin/plugins',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'tenant plugins'
  ),
  ...byMethod(
    '/api/admin/plugins/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'tenant plugins'
  ),
  ...byMethod(
    '/api/admin/platform/plugins',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'platform plugins',
    PLATFORM_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/platform/plugins/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'platform plugins',
    PLATFORM_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/tombstones',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'tombstones'
  ),
  ...byMethod(
    '/api/admin/tombstones/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'tombstones'
  ),
  ...byMethod(
    '/api/admin/platform/tombstones',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'platform tombstones',
    PLATFORM_ADMIN_ROLES
  ),
  ...byMethod(
    '/api/admin/platform/tombstones/*',
    ADMIN_PERMISSIONS.SETTINGS_READ,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    ADMIN_PERMISSIONS.SETTINGS_WRITE,
    'platform tombstones',
    PLATFORM_ADMIN_ROLES
  ),
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patternToRegExp(pattern: string): RegExp {
  const segments = pattern.split('/').map((segment) => {
    if (segment === '*') return '.*';
    if (segment.startsWith(':')) return '[^/]+';
    return escapeRegExp(segment);
  });

  return new RegExp(`^${segments.join('/')}$`);
}

const compiledRules = ADMIN_ROUTE_ACCESS_RULES.map((accessRule) => ({
  accessRule,
  regex: patternToRegExp(accessRule.pattern),
}));

export function findAdminRouteAccessRule(
  method: string,
  pathname: string
): AdminRouteAccessRule | null {
  const normalizedMethod = method.toUpperCase();
  return (
    compiledRules.find(
      ({ accessRule, regex }) =>
        accessRule.methods.includes(normalizedMethod as AdminRouteMethod) && regex.test(pathname)
    )?.accessRule ?? null
  );
}

function hasAnyPermission(permissions: string[], required: string[]): boolean {
  return required.some((permission) => hasAdminPermission(permissions, permission));
}

function hasAnyRole(roles: string[], required: string[]): boolean {
  return required.some((role) => roles.includes(role));
}

function isAllowedByRule(authContext: AdminAuthContext, accessRule: AdminRouteAccessRule): boolean {
  if (accessRule.authenticated) {
    return true;
  }

  const permissions = authContext.permissions || [];
  const roles = authContext.roles || [];

  if (accessRule.permissions?.every((permission) => hasAdminPermission(permissions, permission))) {
    return true;
  }

  if (accessRule.anyPermissions && hasAnyPermission(permissions, accessRule.anyPermissions)) {
    return true;
  }

  if (accessRule.roles && hasAnyRole(roles, accessRule.roles)) {
    return true;
  }

  return false;
}

function insufficientPermissionsResponse(
  c: Context<{ Bindings: Env }>,
  accessRule?: AdminRouteAccessRule
): Response {
  const authContext = (c as unknown as { get: (key: string) => unknown }).get('adminAuth') as
    | AdminAuthContext
    | undefined;
  getLogger(c)
    .module('ADMIN-ROUTE-ACCESS')
    .warn('Declared Admin route access denied', {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      authMethod: authContext?.authMethod,
      requiredPermissions: accessRule?.permissions ?? accessRule?.anyPermissions ?? [],
      actualPermissions: authContext?.permissions ?? [],
    });
  return c.json(
    {
      error: 'insufficient_permissions',
      error_description: 'You do not have the required permissions for this operation.',
    },
    403
  );
}

export function enforceDeclaredAdminRouteAccess() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const authContext = (c as unknown as { get: (key: string) => unknown }).get('adminAuth') as
      | AdminAuthContext
      | undefined;

    if (!authContext) {
      return c.json(
        {
          error: 'invalid_token',
          error_description: 'Admin authentication required.',
        },
        401
      );
    }

    const pathname = new URL(c.req.url).pathname;
    const accessRule = findAdminRouteAccessRule(c.req.method, pathname);
    if (!accessRule) {
      return insufficientPermissionsResponse(c);
    }

    if (!isAllowedByRule(authContext, accessRule)) {
      return insufficientPermissionsResponse(c, accessRule);
    }

    return next();
  };
}

export function registerDeclaredAdminRouteAccessMiddleware(app: Hono<any, any, any>): void {
  app.use('/api/admin/*', enforceDeclaredAdminRouteAccess());
}
