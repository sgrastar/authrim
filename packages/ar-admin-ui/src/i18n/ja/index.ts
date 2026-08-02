import type { Translation } from '../i18n-types';
import core from './core';
import auth from './auth';
import adminShell from './admin-shell';
import adminDashboard from './admin-dashboard';
import adminAccount from './admin-account';
import adminUsers from './admin-users';
import adminClients from './admin-clients';
import adminExternalIdp from './admin-external-idp';
import adminDirectoryAuthentication from './admin-directory-authentication';
import adminSaml from './admin-saml';
import adminDrBackup from './admin-dr-backup';
import adminScale from './admin-scale';
import adminSessions from './admin-sessions';
import adminAuditLogs from './admin-audit-logs';
import adminOrganizations from './admin-organizations';
import adminRoles from './admin-roles';
import adminAccessControl from './admin-access-control';
import adminAccessTrace from './admin-access-trace';
import adminAttributes from './admin-attributes';
import adminPolicies from './admin-policies';
import adminRebac from './admin-rebac';
import adminScimTokens from './admin-scim-tokens';
import adminCustomClaims from './admin-custom-claims';
import adminEmailSettings from './admin-email-settings';
import adminTenantDiscovery from './admin-tenant-discovery';
import adminWebhooks from './admin-webhooks';
import adminTenants from './admin-tenants';
import adminAdmins from './admin-admins';
import adminAdminAccessControl from './admin-admin-access-control';
import adminAdminRbac from './admin-admin-rbac';
import adminAdminAbac from './admin-admin-abac';
import adminAdminRebac from './admin-admin-rebac';
import adminAdminPolicies from './admin-admin-policies';
import adminAdminAudit from './admin-admin-audit';
import adminAdminLogging from './admin-admin-logging';
import adminIpAllowlist from './admin-ip-allowlist';
import adminMachineAccess from './admin-machine-access';
import adminAgentAccess from './admin-agent-access';
import adminOperationalLogs from './admin-operational-logs';
import adminSecurity from './admin-security';
import adminCompliance from './admin-compliance';
import adminStorageDestinations from './admin-storage-destinations';
import adminLoggingPolicies from './admin-logging-policies';
import adminNotifications from './admin-notifications';
import adminDatabaseConnections from './admin-database-connections';
import adminJobs from './admin-jobs';
import adminApprovals from './admin-approvals';
import adminSupportOps from './admin-support-ops';
import adminDiagnosticLogging from './admin-diagnostic-logging';
import adminExternalTokenRefresh from './admin-external-token-refresh';
import adminIatTokens from './admin-iat-tokens';
import adminPlugins from './admin-plugins';
import adminIdentityMapping from './admin-identity-mapping';
import adminConsentPolicies from './admin-consent-policies';
import adminFlows from './admin-flows';
import adminScreens from './admin-screens';
import adminOther from './admin-other';
import adminControlPlane from './admin-control-plane';

const ja: Translation = {
	...core,
	...auth,
	...adminShell,
	...adminDashboard,
	...adminAccount,
	...adminUsers,
	...adminClients,
	...adminExternalIdp,
	...adminDirectoryAuthentication,
	...adminSaml,
	...adminDrBackup,
	...adminScale,
	...adminSessions,
	...adminAuditLogs,
	...adminOrganizations,
	...adminRoles,
	...adminAccessControl,
	...adminAccessTrace,
	...adminAttributes,
	...adminPolicies,
	...adminRebac,
	...adminScimTokens,
	...adminCustomClaims,
	...adminEmailSettings,
	...adminTenantDiscovery,
	...adminWebhooks,
	...adminTenants,
	...adminAdmins,
	...adminAdminAccessControl,
	...adminAdminRbac,
	...adminAdminAbac,
	...adminAdminRebac,
	...adminAdminPolicies,
	...adminAdminAudit,
	...adminAdminLogging,
	...adminIpAllowlist,
	...adminMachineAccess,
	...adminAgentAccess,
	...adminOperationalLogs,
	...adminSecurity,
	...adminCompliance,
	...adminStorageDestinations,
	...adminLoggingPolicies,
	...adminNotifications,
	...adminDatabaseConnections,
	...adminJobs,
	...adminApprovals,
	...adminSupportOps,
	...adminDiagnosticLogging,
	...adminExternalTokenRefresh,
	...adminIatTokens,
	...adminPlugins,
	...adminIdentityMapping,
	...adminConsentPolicies,
	...adminFlows,
	...adminScreens,
	...adminControlPlane,
	...adminOther
} satisfies Translation;

export default ja;
