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
  resolveTenantDatabaseSourceFromRegistry,
  type Env as CoreEnv,
} from '@authrim/ar-lib-core';
import { CloudflareAdminAgentAuditAdapter } from './admin-agent-audit';
import { CloudflareAgentMcpAdmissionAuditAdapter } from './mcp-admission-audit';
import { CloudflareAgentConfigurationPlanAdapter } from './configuration-plans';
import { CloudflareAgentConfigurationResourceReader } from './configuration-resources';
import { CloudflareAgentBulkCoordinator } from './bulk-plans';
import { CloudflareAgentBaselineRemediationCoordinator } from './baseline-remediation';
import { CloudflareAgentBulkPlanAdapter } from './bulk-plan-adapter';
import { CloudflareAgentElevationAdapter } from './elevation';
import { CloudflareDurableObjectRateLimiter } from './durable-object-rate-limiter';
import { CloudflareAgentMcpSessionRegistry } from './mcp-session-registry';
import { CloudflareAgentSettingsProvider } from './tenant-settings';
import { CloudflareTenantConfigurationReader } from './tenant-configuration-reader';
import { CloudflareAgentRuntimeDiagnostics } from './runtime-diagnostics';
import { CLOUDFLARE_ADMIN_READ_ROUTES } from './admin-read-routes';
import { CLOUDFLARE_ADMIN_WRITE_ROUTES } from './admin-write-routes';
import {
  AGENT_ACCESS_MCP_DEFAULT_PREAUTH_RATE_LIMIT_PER_MINUTE,
  createCloudflareAgentAccessMcpWorker,
} from './mcp-admission';
import {
  createCloudflareAgentAccessMcpAgent,
  destroyCloudflareAgentAccessMcpSession,
  validateCloudflareAgentAccessMcpSession,
} from './mcp-agent';
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
  AGENT_ACCESS_MCP: DurableObjectNamespace;
  ENABLE_AGENT_MCP?: string;
  AGENT_MCP_PREAUTH_RATE_LIMIT_PER_MINUTE?: string;
  AGENT_ELEVATION_ENCRYPTION_KEY?: string;
  AGENT_ELEVATION_KEY_VERSION?: string;
  AUTHRIM_ENVIRONMENT_NAME?: string;
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

async function resolveActiveBulkTenantIds(
  env: CloudflareAgentAccessWorkerEnv,
  tenantIds: readonly string[]
): Promise<ReadonlySet<string>> {
  const active = new Set<string>();
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, tenantIds.length) }, async () => {
      while (cursor < tenantIds.length) {
        const tenantId = tenantIds[cursor++]!;
        const store = await resolveTenantDatabaseSourceFromRegistry(env, {
          tenantId,
          role: 'tenant_core',
          dataRole: 'tenant_core/default',
          shardGroup: 'default',
          shardIndex: 0,
        });
        const row = await ensureDatabaseAdapter(
          store.source,
          'agent-bulk-tenant-directory'
        ).queryOne<{
          id: string;
        }>("SELECT id FROM tenants WHERE id = ? AND lifecycle_state = 'active' LIMIT 1", [
          tenantId,
        ]);
        if (row?.id === tenantId) active.add(tenantId);
      }
    })
  );
  return active;
}

const AgentAccessMcpAgentBase = createCloudflareAgentAccessMcpAgent<CloudflareAgentAccessWorkerEnv>(
  {
    getEnvironmentName: (env) => env.AUTHRIM_ENVIRONMENT_NAME,
    createDependencies(env, _getCurrentRequest, discoveryProfiles) {
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
          (tenantIds) => resolveActiveBulkTenantIds(env, tenantIds),
          () => Date.now()
        ),
        runtimeDiagnostics: new CloudflareAgentRuntimeDiagnostics(
          env.OP_DISCOVERY,
          env.OP_MANAGEMENT
        ),
        discoveryProfiles,
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
    validateSession(sessionId, env, verifiedProps) {
      return validateCloudflareAgentAccessMcpSession({
        namespace: env.AGENT_ACCESS_MCP,
        sessionId,
        context: verifiedProps.context,
      });
    },
    controls: {
      getSettings(env, verifiedProps) {
        return new CloudflareAgentSettingsProvider(env).get(verifiedProps.context.grant.tenantId);
      },
      getRateLimiter(env) {
        return new CloudflareDurableObjectRateLimiter(env.RATE_LIMITER);
      },
      getAdmissionAudit(env) {
        return new CloudflareAgentMcpAdmissionAuditAdapter(
          new AdminAgentAccessRepository(
            requireDedicatedAdminDatabaseAdapter(env, 'agent-access-mcp-admission-audit')
          )
        );
      },
      getPreAuthRateLimitPerMinute(env) {
        const configured = Number(env.AGENT_MCP_PREAUTH_RATE_LIMIT_PER_MINUTE);
        return Number.isSafeInteger(configured) && configured >= 60 && configured <= 60_000
          ? configured
          : AGENT_ACCESS_MCP_DEFAULT_PREAUTH_RATE_LIMIT_PER_MINUTE;
      },
      getSessionRegistry(env) {
        return new CloudflareAgentMcpSessionRegistry(
          requireDedicatedAdminDatabaseAdapter(env, 'agent-access-mcp-session-registry')
        );
      },
      destroySession(sessionId, env) {
        return destroyCloudflareAgentAccessMcpSession({
          namespace: env.AGENT_ACCESS_MCP,
          sessionId,
        });
      },
    },
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

export async function runAgentAccessScheduledTasks(input: {
  evaluateBaselines(): Promise<unknown>;
  runBaselineRemediation(): Promise<unknown>;
  runBulkPlans(): Promise<unknown>;
  cleanupMcpSessions(): Promise<unknown>;
}): Promise<void> {
  const failures: unknown[] = [];
  for (const task of [
    input.evaluateBaselines,
    input.runBaselineRemediation,
    input.runBulkPlans,
    input.cleanupMcpSessions,
  ]) {
    try {
      await task();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more Agent Access scheduled tasks failed');
  }
}

export async function cleanupExpiredAgentAccessMcpSessions(
  env: CloudflareAgentAccessWorkerEnv,
  now: number = Date.now()
): Promise<number> {
  const registry = new CloudflareAgentMcpSessionRegistry(
    requireDedicatedAdminDatabaseAdapter(env, 'agent-access-mcp-session-cleanup')
  );
  const expired = await registry.listExpired(now, 500);
  let cleaned = 0;
  for (const session of expired) {
    await destroyCloudflareAgentAccessMcpSession({
      namespace: env.AGENT_ACCESS_MCP,
      sessionId: session.sessionId,
    });
    await registry.delete(session);
    cleaned += 1;
  }
  return cleaned;
}

interface AgentAccessReadinessResult {
  status: 'ok' | 'unavailable';
  service: 'ar-agent-access';
  checks: Record<string, 'ok' | 'unavailable'>;
}

function hasMethod(value: unknown, method: string): boolean {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as Record<string, unknown>)[method] === 'function'
  );
}

export async function checkAgentAccessReadiness(
  env: CloudflareAgentAccessWorkerEnv
): Promise<AgentAccessReadinessResult> {
  const checks: AgentAccessReadinessResult['checks'] = {};
  try {
    const database = requireDedicatedAdminDatabaseAdapter(env, 'agent-access-readiness');
    checks.database = (await database.isHealthy()).healthy ? 'ok' : 'unavailable';
  } catch {
    checks.database = 'unavailable';
  }

  const settings = env.SETTINGS ?? env.AUTHRIM_CONFIG;
  try {
    if (!settings) throw new Error('settings binding is unavailable');
    await settings.get('__authrim_agent_access_readiness__');
    checks.settings = 'ok';
  } catch {
    checks.settings = 'unavailable';
  }

  checks.rateLimiter = hasMethod(env.RATE_LIMITER, 'idFromName') ? 'ok' : 'unavailable';
  checks.mcpSessions = hasMethod(env.AGENT_ACCESS_MCP, 'idFromName') ? 'ok' : 'unavailable';
  checks.keyManager = hasMethod(env.KEY_MANAGER, 'idFromName') ? 'ok' : 'unavailable';
  checks.dpopReplayStore = hasMethod(env.DPOP_JTI_STORE, 'idFromName') ? 'ok' : 'unavailable';
  checks.downscope = hasMethod(env.AGENT_DOWNSCOPE, 'exchangeAgentAccessToken')
    ? 'ok'
    : 'unavailable';
  try {
    const keyVersion = env.AGENT_ELEVATION_KEY_VERSION ?? 'v1';
    await new CloudflareSecretTextKeyProvider({
      [keyVersion]: env.AGENT_ELEVATION_ENCRYPTION_KEY,
    }).getEncryptionKey(keyVersion);
    checks.elevationKey = 'ok';
  } catch {
    checks.elevationKey = 'unavailable';
  }

  for (const [name, binding] of [
    ['management', env.OP_MANAGEMENT],
    ['discovery', env.OP_DISCOVERY],
  ] as const) {
    try {
      if (!hasMethod(binding, 'fetch')) throw new Error(`${name} binding is unavailable`);
      const response = await binding.fetch(new Request(`https://${name}.internal/health/ready`));
      checks[name] = response.ok ? 'ok' : 'unavailable';
    } catch {
      checks[name] = 'unavailable';
    }
  }

  return {
    status: Object.values(checks).every((value) => value === 'ok') ? 'ok' : 'unavailable',
    service: 'ar-agent-access',
    checks,
  };
}

const worker: ExportedHandler<CloudflareAgentAccessWorkerEnv> = {
  async fetch(request, env, context) {
    const path = new URL(request.url).pathname;
    if (path === '/health/live' || path === '/api/health') {
      return Response.json({ status: 'ok', service: 'ar-agent-access' });
    }
    if (path === '/health/ready') {
      const readiness = await checkAgentAccessReadiness(env);
      return Response.json(readiness, {
        status: readiness.status === 'ok' ? 200 : 503,
        headers: { 'cache-control': 'no-store' },
      });
    }
    if (path !== '/mcp') return new Response(null, { status: 404 });
    return mcp.fetch!(request, env, context);
  },
  async scheduled(_controller, env, _context) {
    const baseline = baselineRemediationCoordinator(env);
    const bulk = bulkCoordinator(env);
    await runAgentAccessScheduledTasks({
      evaluateBaselines: () => baseline.evaluateScheduled(),
      runBaselineRemediation: () => baseline.runScheduled(),
      runBulkPlans: () => bulk.runScheduled(),
      cleanupMcpSessions: () => cleanupExpiredAgentAccessMcpSessions(env),
    });
  },
};

export default worker;
export { RuntimeSmokeEntrypoint } from '@authrim/ar-lib-core';
