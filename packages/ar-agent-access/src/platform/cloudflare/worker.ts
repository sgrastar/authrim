import {
  AdminAgentAccessRepository,
  AgentBaselineRepository,
  AgentBulkRepository,
  AgentConfigurationRepository,
  LiveAgentAuthorizationService,
  getAgentTaskSetWithBuiltins,
  isPublicClientStandardOptInEligibleTool,
  type AgentRiskPolicy,
} from '../../core';
import {
  ADMIN_CONFIGURATION_PROMPTS,
  ADMIN_CONFIGURATION_RESOURCES,
  createAdminConfigurationResourceTemplates,
  McpSdkJsonSchemaValidator,
  createAdminToolCatalog,
} from '../../protocol/mcp';
import {
  AdminMachineAccessRepository,
  buildIssuerUrl,
  ensureDatabaseAdapter,
  hasAdminPermission,
  isAllowedOrigin,
  parseAllowedOrigins,
  requireDedicatedAdminDatabaseAdapter,
  type Env as CoreEnv,
} from '@authrim/ar-lib-core';
import { CloudflareAdminAgentAuditAdapter } from './admin-agent-audit';
import { CloudflareAgentConfigurationPlanAdapter } from './configuration-plans';
import { CloudflareAgentConfigurationResourceReader } from './configuration-resources';
import { CloudflareAgentBulkCoordinator } from './bulk-plans';
import { CloudflareAgentBaselineRemediationCoordinator } from './baseline-remediation';
import { CloudflareAgentBulkPlanAdapter } from './bulk-plan-adapter';
import { CloudflareAgentElevationAdapter } from './elevation';
import { CloudflareDurableObjectRateLimiter } from './durable-object-rate-limiter';
import { CloudflareAgentSettingsProvider } from './tenant-settings';
import { CloudflareTenantConfigurationReader } from './tenant-configuration-reader';
import { CloudflareAgentRuntimeDiagnostics } from './runtime-diagnostics';
import { CLOUDFLARE_ADMIN_READ_ROUTES } from './admin-read-routes';
import { CLOUDFLARE_ADMIN_WRITE_ROUTES } from './admin-write-routes';
import { createCloudflareAgentAccessMcpWorker } from './mcp-admission';
import { createCloudflareAgentAccessMcpAgent } from './mcp-agent';
import {
  CloudflareServiceBindingManagementApi,
  CloudflareServiceBindingBulkChildExecutor,
  CloudflareSecretTextKeyProvider,
  createCloudflareRequestScopedDownscopeTokenProvider,
  type CloudflareAgentDownscopeExchangeBinding,
  type CloudflareFetcherBinding,
} from './service-binding';
import {
  createCloudflareAgentAccessTokenAuthenticator,
  isCloudflareAgentAccessMcpEnabled,
} from './token-authentication';

export interface CloudflareAgentAccessWorkerEnv extends CoreEnv {
  OP_MANAGEMENT: CloudflareFetcherBinding;
  OP_DISCOVERY: CloudflareFetcherBinding;
  AGENT_DOWNSCOPE: CloudflareAgentDownscopeExchangeBinding;
  ENABLE_AGENT_MCP?: string;
  AGENT_ELEVATION_ENCRYPTION_KEY?: string;
  AGENT_ELEVATION_KEY_VERSION?: string;
}

const ADMIN_TOOL_CATALOG = createAdminToolCatalog();
const PUBLIC_CLIENT_STANDARD_OPT_IN_TOOL_IDS = new Set(
  ADMIN_TOOL_CATALOG.list()
    .filter(isPublicClientStandardOptInEligibleTool)
    .map((tool) => tool.id)
);
const ADMIN_OPERATION_ROUTES = Object.freeze({
  ...CLOUDFLARE_ADMIN_READ_ROUTES,
  ...CLOUDFLARE_ADMIN_WRITE_ROUTES,
});
const BASE_RISK_POLICY: Omit<AgentRiskPolicy, 'highRiskPermissionsAdditional'> = {
  allowedRiskByAssurance: {
    public_client_transaction: ['low'],
    confidential_client: ['low', 'standard'],
    machine_key: ['low', 'standard', 'high'],
  },
  highRiskRequiresElevation: true,
  dpopRequiredForModeB: true,
};

const AgentAccessMcpAgentBase = createCloudflareAgentAccessMcpAgent<CloudflareAgentAccessWorkerEnv>(
  {
    createDependencies(env) {
      const database = requireDedicatedAdminDatabaseAdapter(env, 'agent-access-mcp-worker');
      const repository = new AdminAgentAccessRepository(database);
      const configurationRepository = new AgentConfigurationRepository(database);
      const machineRepository = new AdminMachineAccessRepository(
        requireDedicatedAdminDatabaseAdapter(env, 'agent-access-machine-principal')
      );
      const managementApi = new CloudflareServiceBindingManagementApi(
        env.OP_MANAGEMENT,
        ADMIN_OPERATION_ROUTES,
        createCloudflareRequestScopedDownscopeTokenProvider(env.AGENT_DOWNSCOPE)
      );
      const clock = { now: () => Date.now() };
      const settings = new CloudflareAgentSettingsProvider(env);
      const authorization = new LiveAgentAuthorizationService({
        now: () => Date.now(),
        isFeatureEnabled: (tenantId) => isCloudflareAgentAccessMcpEnabled(env, tenantId),
        getDelegatorPermissions: (tenantId, delegatorId, now) =>
          repository.getActiveDelegatorPermissions(tenantId, delegatorId, now),
        getPrincipalPermissionLimit: async (tenantId, principalId, credentialId) => {
          const principal = await machineRepository.findPrincipalById(principalId);
          if (!principal || principal.status !== 'active') return null;
          const tenantScopes = await machineRepository.getPrincipalTenantScopes(principalId);
          if (
            tenantScopes.length === 0 ||
            tenantScopes.some((scope) => scope.scopeMode !== 'allow') ||
            !tenantScopes.some((scope) => scope.tenantId === tenantId)
          ) {
            return null;
          }
          const principalPermissions = await machineRepository.getPrincipalPermissions(principalId);
          if (!credentialId) return principalPermissions;
          const credential = await machineRepository.findCredentialById(credentialId);
          if (
            !credential ||
            credential.principalId !== principalId ||
            (credential.status !== 'active' && credential.status !== 'rotating')
          ) {
            return null;
          }
          const credentialScopes = await machineRepository.getCredentialTenantScopes(credentialId);
          if (
            credentialScopes.length > 0 &&
            (credentialScopes.some((scope) => scope.scopeMode !== 'allow') ||
              !credentialScopes.some((scope) => scope.tenantId === tenantId))
          ) {
            return null;
          }
          const credentialPermissions =
            await machineRepository.getCredentialPermissions(credentialId);
          return credentialPermissions.length === 0
            ? principalPermissions
            : principalPermissions.filter((permission) =>
                hasAdminPermission(credentialPermissions, permission)
              );
        },
        getRiskPolicy: async (tenantId) => {
          const tenantSettings = await settings.get(tenantId);
          return {
            ...BASE_RISK_POLICY,
            highRiskPermissionsAdditional: tenantSettings.highRiskPermissionsAdditional,
            publicClientStandardToolIds: tenantSettings.publicClientStandardToolIds.filter(
              (toolId) => PUBLIC_CLIENT_STANDARD_OPT_IN_TOOL_IDS.has(toolId)
            ),
          };
        },
        isConfigurationSnapshotActive: async (tenantId, snapshot) => {
          const [taskSet, scopePolicy] = await Promise.all([
            getAgentTaskSetWithBuiltins({
              repository: configurationRepository,
              catalog: ADMIN_TOOL_CATALOG,
              tenantId,
              id: snapshot.taskSetId,
              version: snapshot.taskSetVersion,
            }),
            configurationRepository.getScopePolicyVersion(
              tenantId,
              snapshot.scopePolicyId,
              snapshot.scopePolicyVersion
            ),
          ]);
          return taskSet?.status === 'active' && scopePolicy?.status === 'active';
        },
      });
      const schemaValidator = new McpSdkJsonSchemaValidator();
      return {
        toolCatalog: ADMIN_TOOL_CATALOG,
        authorization,
        managementApi,
        rateLimiter: new CloudflareDurableObjectRateLimiter(env.RATE_LIMITER),
        settings,
        audit: new CloudflareAdminAgentAuditAdapter(repository),
        clock,
        schemaValidator,
        elevation: new CloudflareAgentElevationAdapter(
          repository,
          new CloudflareSecretTextKeyProvider({
            [env.AGENT_ELEVATION_KEY_VERSION ?? 'v1']: env.AGENT_ELEVATION_ENCRYPTION_KEY,
          }),
          { payloadKeyId: env.AGENT_ELEVATION_KEY_VERSION ?? 'v1' }
        ),
        resources: ADMIN_CONFIGURATION_RESOURCES,
        resourceTemplates: createAdminConfigurationResourceTemplates(
          new CloudflareAgentConfigurationResourceReader(
            configurationRepository,
            ADMIN_TOOL_CATALOG
          )
        ),
        prompts: ADMIN_CONFIGURATION_PROMPTS,
        configurationPlans: new CloudflareAgentConfigurationPlanAdapter(
          configurationRepository,
          ADMIN_TOOL_CATALOG,
          managementApi,
          clock,
          authorization,
          schemaValidator
        ),
        bulkPlans: new CloudflareAgentBulkPlanAdapter(
          database,
          ADMIN_TOOL_CATALOG,
          settings,
          schemaValidator,
          () => Date.now(),
          ensureDatabaseAdapter(env.DB, 'agent-bulk-tenant-directory')
        ),
        runtimeDiagnostics: new CloudflareAgentRuntimeDiagnostics(
          env.OP_DISCOVERY,
          env.OP_MANAGEMENT
        ),
      };
    },
  }
);

/** Cloudflare transport shell. MCP Tool/Resource/Prompt definitions remain in protocol/mcp. */
export class AgentAccessMcpAgent extends AgentAccessMcpAgentBase {}

const mcp = createCloudflareAgentAccessMcpWorker<CloudflareAgentAccessWorkerEnv>(
  AgentAccessMcpAgent,
  {
    binding: 'AGENT_ACCESS_MCP',
    authenticate: createCloudflareAgentAccessTokenAuthenticator<CloudflareAgentAccessWorkerEnv>(),
    resolveAllowedOrigin(request, env) {
      const origin = request.headers.get('origin');
      if (!origin) return null;
      const ownOrigin = new URL(request.url).origin;
      return origin === ownOrigin ||
        isAllowedOrigin(origin, parseAllowedOrigins(env.ALLOWED_ORIGINS))
        ? origin
        : null;
    },
  }
);

function bulkCoordinator(env: CloudflareAgentAccessWorkerEnv): CloudflareAgentBulkCoordinator {
  const repository = new AgentBulkRepository(
    requireDedicatedAdminDatabaseAdapter(env, 'agent-bulk-coordinator')
  );
  return new CloudflareAgentBulkCoordinator(
    repository,
    new CloudflareServiceBindingBulkChildExecutor(
      env.OP_MANAGEMENT,
      ADMIN_OPERATION_ROUTES,
      env.AGENT_DOWNSCOPE
    ),
    { now: () => Date.now() },
    { getIssuerOrigin: (tenantId) => buildIssuerUrl(env, tenantId) }
  );
}

function baselineRemediationCoordinator(
  env: CloudflareAgentAccessWorkerEnv
): CloudflareAgentBaselineRemediationCoordinator {
  const database = requireDedicatedAdminDatabaseAdapter(env, 'agent-baseline-remediation');
  return new CloudflareAgentBaselineRemediationCoordinator(
    new AgentBaselineRepository(database),
    new AgentBulkRepository(database),
    new CloudflareAgentSettingsProvider(env),
    { now: () => Date.now() },
    new CloudflareTenantConfigurationReader(env)
  );
}

const worker: ExportedHandler<CloudflareAgentAccessWorkerEnv> = {
  async fetch(request, env, context) {
    const path = new URL(request.url).pathname;
    if (path === '/health/live' || path === '/health/ready' || path === '/api/health') {
      return Response.json({ status: 'ok', service: 'ar-agent-access' });
    }
    if (path !== '/mcp') return new Response(null, { status: 404 });
    return mcp.fetch!(request, env, context);
  },
  async scheduled(_controller, env, _context) {
    const baseline = baselineRemediationCoordinator(env);
    await baseline.evaluateScheduled().catch(() => []);
    await baseline.runScheduled().catch(() => []);
    await bulkCoordinator(env).runScheduled();
  },
};

export default worker;
