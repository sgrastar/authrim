/**
 * Wrangler Configuration Generator
 *
 * Generates wrangler.toml files for each component based on environment
 * configuration and resource IDs from authrim-lock.json.
 */

import type { AuthrimConfig } from './config.js';
import type { AuthrimLock, ControlKeyState } from './lock.js';
import { extractZoneName } from './cloudflare.js';
import {
  getWorkerName,
  getDOScriptName,
  getBuiltinD1BindingsForComponent,
  getRequiredDataRolesForComponent,
  DURABLE_OBJECTS,
  D1_DATABASES,
  type WorkerComponent,
  type KVNamespace,
} from './naming.js';
import { getSecretNamesForWorker } from './secrets.js';
import { classifyUiApiSite, type UiApiSiteClassification } from './site-classifier.js';
import {
  getControlGeneratedDatabaseDataRoleFromBinding,
  isControlGeneratedDatabaseBinding,
} from './tenant-database.js';
import { resolveRegisteredSchemaReferences } from './release-migrations.js';
import type { ActivePluginRunnerResourceBinding } from './plugin-resource-deployment-projection.js';
import { MANAGED_WORKER_DEPLOY_BUILD_COMMAND } from './managed-worker-deploy.js';

// =============================================================================
// Types
// =============================================================================

export interface ResourceIds {
  d1: Record<string, { id: string; name: string }>;
  kv: Record<string, { id: string; name: string }>;
  queues?: Record<string, { id: string; name: string }>;
  r2?: Record<string, { name: string }>;
  registeredSchemaReferences?: string[];
  controlKeyState?: ControlKeyState;
  pluginRunnerResources?: ActivePluginRunnerResourceBinding[];
}

export function buildResourceIdsFromLock(lock: AuthrimLock, config?: AuthrimConfig): ResourceIds {
  return {
    d1: Object.fromEntries(
      Object.entries(lock.d1 || {}).map(([key, value]) => [key, { id: value.id, name: value.name }])
    ),
    kv: Object.fromEntries(
      Object.entries(lock.kv || {}).map(([key, value]) => [key, { id: value.id, name: value.name }])
    ),
    queues: lock.queues
      ? Object.fromEntries(
          Object.entries(lock.queues).map(([key, value]) => [
            key,
            { id: value.id, name: value.name },
          ])
        )
      : undefined,
    r2: lock.r2 ? Object.fromEntries(Object.entries(lock.r2)) : undefined,
    controlKeyState: lock.controlKeyState,
    ...(config
      ? { registeredSchemaReferences: resolveRegisteredSchemaReferences({ lock, config }) }
      : {}),
  };
}

export interface WranglerConfig {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  workers_dev: boolean;
  build?: { command: string };
  placement?: { mode: string };
  version_metadata?: { binding: string };
  worker_loaders?: Array<{ binding: string }>;
  kv_namespaces?: Array<{ binding: string; id: string; preview_id?: string }>;
  d1_databases?: Array<{ binding: string; database_name: string; database_id: string }>;
  hyperdrive?: Array<{ binding: string; id: string }>;
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
  durable_objects?: {
    bindings: Array<{ name: string; class_name: string; script_name?: string }>;
  };
  migrations?: Array<{ tag: string; new_sqlite_classes?: string[] }>;
  vars: Record<string, string>;
  routes?: Array<{ pattern: string; zone_name?: string; custom_domain?: boolean }>;
  triggers?: {
    crons: string[];
  };
  queues?: {
    producers?: Array<{ queue: string; binding: string }>;
    consumers?: Array<{
      queue: string;
      max_batch_size?: number;
      max_batch_timeout?: number;
      max_retries?: number;
      dead_letter_queue?: string;
    }>;
  };
  services?: Array<{
    binding: string;
    service: string;
    entrypoint?: string;
    props?: Record<string, string | number | boolean>;
  }>;
  send_email?: Array<{
    name: string;
    destination_address?: string;
    allowed_destination_addresses?: string[];
    allowed_sender_addresses?: string[];
  }>;
}

export interface GenerateWranglerConfigOptions {
  includeDurableObjectMigrations?: boolean;
  /** Operator-controlled test experiment. Production defaults remain placement off. */
  placementMode?: 'off' | 'smart';
  /** Initial-deploy escape hatch for Control smoke bindings whose targets do not exist yet. */
  includeControlSmokeBindings?: boolean;
  /** Initial-deploy escape hatch for the Auth -> Management -> Auth bootstrap cycle. */
  includeAuthAccountProvisioner?: boolean;
  /** Initial-deploy escape hatch for the Bridge -> Management -> Bridge bootstrap cycle. */
  includeExternalIdpAccountProvisioner?: boolean;
}

const LOGGING_DELIVERY_QUEUE_DEFINITIONS = [
  {
    binding: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
    resourceKey: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
    fallbackName: (env: string) => `${env}-logging-delivery-critical-queue`,
  },
  {
    binding: 'LOGGING_DELIVERY_QUEUE',
    resourceKey: 'LOGGING_DELIVERY_QUEUE',
    fallbackName: (env: string) => `${env}-logging-delivery-queue`,
  },
  {
    binding: 'LOGGING_DELIVERY_BULK_QUEUE',
    resourceKey: 'LOGGING_DELIVERY_BULK_QUEUE',
    fallbackName: (env: string) => `${env}-logging-delivery-bulk-queue`,
  },
] as const;

const LOGGING_DELIVERY_PRODUCER_COMPONENTS: readonly WorkerComponent[] = [
  'ar-auth',
  'ar-management',
  'ar-token',
  'ar-userinfo',
  'ar-async',
  'ar-saml',
  'ar-bridge',
  'ar-vc',
];

const CONTROL_SMOKE_RUNTIME_COMPONENTS = [
  'ar-lib-core',
  'ar-discovery',
  'ar-auth',
  'ar-token',
  'ar-userinfo',
  'ar-management',
  'ar-agent-access',
  'ar-async',
  'ar-policy',
  'ar-saml',
  'ar-bridge',
  'ar-vc',
  'ar-plugin-runner',
] as const satisfies readonly WorkerComponent[];

const PLUGIN_RUNNER_RPC_COMPONENTS = [
  'ar-auth',
  'ar-bridge',
  'ar-management',
  'ar-policy',
  'ar-saml',
] as const satisfies readonly WorkerComponent[];

const PLATFORM_NOTIFICATION_COMPONENTS = [
  'ar-auth',
  'ar-management',
  'ar-plugin-runner',
] as const satisfies readonly WorkerComponent[];

function isPluginRunnerRpcComponent(
  component: WorkerComponent
): component is (typeof PLUGIN_RUNNER_RPC_COMPONENTS)[number] {
  return PLUGIN_RUNNER_RPC_COMPONENTS.includes(
    component as (typeof PLUGIN_RUNNER_RPC_COMPONENTS)[number]
  );
}

function isControlSmokeRuntimeComponent(
  component: WorkerComponent
): component is (typeof CONTROL_SMOKE_RUNTIME_COMPONENTS)[number] {
  return CONTROL_SMOKE_RUNTIME_COMPONENTS.includes(
    component as (typeof CONTROL_SMOKE_RUNTIME_COMPONENTS)[number]
  );
}

function getControlSmokeBindingName(component: WorkerComponent): string {
  return `SMOKE_${component.replace(/^ar-/u, 'AR_').replaceAll('-', '_').toUpperCase()}`;
}

function collectConfiguredHyperdriveBindings(
  config: AuthrimConfig
): Array<{ binding: string; id: string }> {
  const configured = Object.values(config.profiles?.references?.hyperdrive ?? {});
  const deduped = new Map<string, { binding: string; id: string }>();
  for (const entry of configured) {
    if (!entry.binding || !entry.id) {
      continue;
    }
    deduped.set(`${entry.binding}:${entry.id}`, {
      binding: entry.binding,
      id: entry.id,
    });
  }
  return Array.from(deduped.values()).sort((left, right) =>
    left.binding.localeCompare(right.binding)
  );
}

function shouldAttachConfiguredHyperdriveBindings(component: WorkerComponent): boolean {
  const roles = getRequiredDataRolesForComponent(component);
  return roles.some((role) => role.startsWith('tenant_'));
}

function collectD1DatabaseBindings(
  component: WorkerComponent,
  resourceIds: ResourceIds
): Array<{ binding: string; database_name: string; database_id: string }> {
  const allowedBuiltinBindings = new Set(getBuiltinD1BindingsForComponent(component));
  const selectedDatabases = D1_DATABASES.filter((database) =>
    allowedBuiltinBindings.has(database.binding)
  );
  const builtins = selectedDatabases
    .map((db) => ({
      binding: db.binding,
      database_name: resourceIds.d1[db.binding]?.name || '',
      database_id: resourceIds.d1[db.binding]?.id || '',
    }))
    .filter((db) => db.database_id);

  const requiredRoles = new Set(getRequiredDataRolesForComponent(component));
  const platformNotification =
    PLATFORM_NOTIFICATION_COMPONENTS.includes(
      component as (typeof PLATFORM_NOTIFICATION_COMPONENTS)[number]
    ) &&
    (requiredRoles.has('tenant_core/default') || requiredRoles.has('tenant_core/users')) &&
    resourceIds.d1.DB
      ? [
          {
            binding: 'PLATFORM_NOTIFICATION_DB',
            database_name: resourceIds.d1.DB.name,
            database_id: resourceIds.d1.DB.id,
          },
        ]
      : [];
  const tenantDatabases = Object.entries(resourceIds.d1)
    .filter(([binding]) => {
      if (!isControlGeneratedDatabaseBinding(binding)) return false;
      const role = getControlGeneratedDatabaseDataRoleFromBinding(binding);
      return role !== null && requiredRoles.has(role);
    })
    .map(([binding, resource]) => ({
      binding,
      database_name: resource.name,
      database_id: resource.id,
    }))
    .sort((left, right) => left.binding.localeCompare(right.binding));

  const pluginResources =
    component === 'ar-plugin-runner'
      ? (resourceIds.pluginRunnerResources ?? [])
          .filter((resource) => resource.kind === 'd1')
          .map((resource) => ({
            binding: resource.binding,
            database_name: resource.providerName,
            database_id: resource.providerResourceId,
          }))
      : [];

  return [...builtins, ...platformNotification, ...tenantDatabases, ...pluginResources];
}

// =============================================================================
// Component-specific KV Requirements
// =============================================================================

const COMPONENT_KV_BINDINGS: Record<WorkerComponent, KVNamespace[]> = {
  'ar-lib-core': ['AUTHRIM_CONFIG', 'TENANT_RUNTIME_REGISTRY'],
  'ar-control': ['TENANT_RUNTIME_REGISTRY'],
  'ar-plugin-runner': ['TENANT_RUNTIME_REGISTRY'],
  'ar-discovery': ['SETTINGS', 'AUTHRIM_CONFIG', 'TENANT_RUNTIME_REGISTRY'],
  'ar-auth': [
    'CLIENTS_CACHE',
    'SETTINGS',
    'USER_CACHE',
    'CONSENT_CACHE',
    'AUTHRIM_CONFIG',
    'TENANT_RUNTIME_REGISTRY',
  ],
  'ar-token': [
    'CLIENTS_CACHE',
    'SETTINGS',
    'USER_CACHE',
    'REBAC_CACHE',
    'AUTHRIM_CONFIG',
    'TENANT_RUNTIME_REGISTRY',
  ],
  'ar-userinfo': ['CLIENTS_CACHE', 'USER_CACHE', 'AUTHRIM_CONFIG', 'TENANT_RUNTIME_REGISTRY'],
  'ar-management': [
    'CLIENTS_CACHE',
    'SETTINGS',
    'USER_CACHE',
    'INITIAL_ACCESS_TOKENS',
    'AUTHRIM_CONFIG',
    'TENANT_RUNTIME_REGISTRY',
  ],
  'ar-agent-access': ['SETTINGS', 'AUTHRIM_CONFIG', 'TENANT_RUNTIME_REGISTRY'],
  'ar-router': ['SETTINGS', 'AUTHRIM_CONFIG'],
  'ar-async': ['INITIAL_ACCESS_TOKENS', 'AUTHRIM_CONFIG', 'TENANT_RUNTIME_REGISTRY'],
  'ar-policy': ['REBAC_CACHE', 'AUTHRIM_CONFIG', 'TENANT_RUNTIME_REGISTRY'],
  'ar-saml': ['SETTINGS', 'AUTHRIM_CONFIG', 'STATE_STORE', 'TENANT_RUNTIME_REGISTRY'],
  'ar-bridge': ['SETTINGS', 'AUTHRIM_CONFIG', 'TENANT_RUNTIME_REGISTRY'],
  'ar-vc': ['AUTHRIM_CONFIG', 'TENANT_RUNTIME_REGISTRY'],
};

// =============================================================================
// Component-specific DO Requirements
// =============================================================================

const COMPONENT_DO_BINDINGS: Record<WorkerComponent, string[]> = {
  'ar-lib-core': [], // Defines DOs, doesn't reference external
  'ar-control': [],
  'ar-plugin-runner': [],
  'ar-discovery': [],
  'ar-auth': [
    'KEY_MANAGER',
    'SESSION_STORE',
    'SESSION_REVOCATION_STORE',
    'AUTH_CODE_STORE',
    'CHALLENGE_STORE',
    'RATE_LIMITER',
    'PAR_REQUEST_STORE',
    'FLOW_STATE_STORE',
    'DPOP_JTI_STORE',
  ],
  'ar-token': [
    'KEY_MANAGER',
    'SESSION_STORE',
    'SESSION_REVOCATION_STORE',
    'AUTH_CODE_STORE',
    'REFRESH_TOKEN_ROTATOR',
    'RATE_LIMITER',
    'DPOP_JTI_STORE',
    'TOKEN_REVOCATION_STORE',
    'DEVICE_CODE_STORE',
    'CIBA_REQUEST_STORE',
    'DEVICE_SECRET_ROUTE_STORE',
  ],
  'ar-userinfo': [
    'KEY_MANAGER',
    'SESSION_STORE',
    'RATE_LIMITER',
    'DPOP_JTI_STORE',
    'TOKEN_REVOCATION_STORE',
  ],
  'ar-management': [
    'KEY_MANAGER',
    'REFRESH_TOKEN_ROTATOR',
    'RATE_LIMITER',
    'SESSION_STORE',
    'SESSION_REVOCATION_STORE',
    'TOKEN_REVOCATION_STORE',
    'VERSION_MANAGER',
    'CHALLENGE_STORE',
    'DPOP_JTI_STORE',
  ],
  'ar-agent-access': ['KEY_MANAGER', 'RATE_LIMITER', 'DPOP_JTI_STORE'],
  'ar-router': [],
  'ar-async': ['DEVICE_CODE_STORE', 'CIBA_REQUEST_STORE', 'DPOP_JTI_STORE'],
  'ar-policy': ['PERMISSION_CHANGE_HUB'],
  'ar-saml': [
    'KEY_MANAGER',
    'SAML_REQUEST_STORE',
    'SAML_AGGREGATE_METADATA_STORE',
    'SESSION_STORE',
    'SESSION_REVOCATION_STORE',
    'CHALLENGE_STORE',
  ],
  'ar-bridge': ['KEY_MANAGER', 'SESSION_STORE', 'SESSION_REVOCATION_STORE', 'CHALLENGE_STORE'],
  'ar-vc': ['KEY_MANAGER', 'RATE_LIMITER', 'TOKEN_REVOCATION_STORE'],
};

const COMPONENT_LOCAL_DO_BINDINGS: Partial<
  Record<WorkerComponent, Array<{ name: string; className: string }>>
> = {
  'ar-auth': [{ name: 'DIRECTORY_CONNECTOR_RELAY', className: 'DirectoryConnectorRelay' }],
  'ar-vc': [
    { name: 'CREDENTIAL_OFFER_STORE', className: 'CredentialOfferStoreV2' },
    { name: 'VP_REQUEST_STORE', className: 'VPRequestStoreV2' },
  ],
  'ar-agent-access': [{ name: 'AGENT_ACCESS_MCP', className: 'AgentAccessMcpAgent' }],
};

const COMPONENT_EXTERNAL_DO_BINDINGS: Partial<
  Record<
    WorkerComponent,
    Array<{ name: string; className: string; scriptComponent: WorkerComponent }>
  >
> = {
  'ar-management': [
    {
      name: 'DIRECTORY_CONNECTOR_RELAY',
      className: 'DirectoryConnectorRelay',
      scriptComponent: 'ar-auth',
    },
  ],
};

// =============================================================================
// Component Entry Points
// =============================================================================

const COMPONENT_ENTRY_POINTS: Record<WorkerComponent, string> = {
  'ar-lib-core': 'src/durable-objects/index.ts',
  'ar-control': 'src/index.ts',
  'ar-plugin-runner': 'src/worker.ts',
  'ar-discovery': 'src/index.ts',
  'ar-auth': 'src/index.ts',
  'ar-token': 'src/index.ts',
  'ar-userinfo': 'src/index.ts',
  'ar-management': 'src/index.ts',
  'ar-agent-access': 'src/platform/cloudflare/worker.ts',
  'ar-router': 'src/index.ts',
  'ar-async': 'src/index.ts',
  'ar-policy': 'src/index.ts',
  'ar-saml': 'src/index.ts',
  'ar-bridge': 'src/index.ts',
  'ar-vc': 'src/index.ts',
};

// =============================================================================
// CORS Helper Functions
// =============================================================================

/**
 * Normalize workers.dev URL to include account subdomain
 *
 * Cloudflare Workers.dev URLs always follow the format:
 *   {name}.{subdomain}.workers.dev
 *
 * There is NO short form like {name}.workers.dev - this format does not exist.
 * If config contains such a URL (e.g., from older setup or manual entry),
 * we need to expand it to the correct full form.
 *
 * @see https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
 */
export function normalizeWorkersDevUrl(url: string, workersSubdomain?: string): string {
  try {
    const parsed = new URL(url);

    if (parsed.hostname.endsWith('.workers.dev')) {
      const parts = parsed.hostname.split('.');
      // Check if it's missing the subdomain (only 3 parts: name.workers.dev)
      if (parts.length === 3 && workersSubdomain) {
        // Expand to full form: {name}.{subdomain}.workers.dev
        return `https://${parts[0]}.${workersSubdomain}.workers.dev`;
      }
    }

    return parsed.origin;
  } catch {
    return url;
  }
}

function getUrlHost(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeHostnameCandidate(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

/**
 * Add origin to set, normalizing workers.dev URLs to include subdomain
 */
function addOriginWithSubdomain(
  origins: Set<string>,
  url: string,
  workersSubdomain?: string
): void {
  const normalizedUrl = normalizeWorkersDevUrl(url, workersSubdomain);
  origins.add(normalizedUrl);
}

function getAdminUiApiMode(
  apiUrl: string,
  adminUiUrl: string,
  baseDomain?: string
): 'same-origin' | 'same-site-cross-origin' | 'cross-site-proxy' {
  const classification: UiApiSiteClassification = classifyUiApiSite(apiUrl, adminUiUrl, {
    baseDomain,
  });
  return classification === 'cross-site' ? 'cross-site-proxy' : classification;
}

/**
 * Derive CORS allowed origins from config URLs.
 *
 * Setup exposes web_origin_registry semantics to operators, but this generator
 * still materializes the current internal ALLOWED_ORIGINS representation.
 *
 * Includes:
 * - API origin (router) - needed for admin-init-setup WebAuthn operations
 * - LoginUI origin - for cross-origin requests from login UI
 * - AdminUI origin only when Admin UI is same-site with the API
 *
 * Workers.dev URLs are normalized to the correct format:
 *   {name}.{subdomain}.workers.dev
 */
export function deriveAllowedOrigins(config: AuthrimConfig, workersSubdomain?: string): string[] {
  const origins = new Set<string>();

  // API origin (the issuer URL / router)
  // This is needed for admin-init-setup page which runs on the router domain
  const apiUrl = config.urls?.api?.custom || config.urls?.api?.auto;
  if (apiUrl) {
    addOriginWithSubdomain(origins, apiUrl, workersSubdomain);
  }

  // LoginUI origin
  // When sameAsApi=true, the actual origin is the API domain (UI is proxied)
  const loginUiUrl = config.urls?.loginUi?.sameAsApi
    ? apiUrl
    : config.urls?.loginUi?.custom || config.urls?.loginUi?.auto;
  if (loginUiUrl) {
    addOriginWithSubdomain(origins, loginUiUrl, workersSubdomain);
  }

  // AdminUI origin
  // Direct cross-site browser mode is not supported. Cross-site Admin UI uses
  // the Admin UI Worker/BFF, so the public Admin API CORS allowlist must not
  // include that cross-site browser origin.
  const adminUiUrl = config.urls?.adminUi?.sameAsApi
    ? apiUrl
    : config.urls?.adminUi?.custom || config.urls?.adminUi?.auto;
  if (adminUiUrl && apiUrl) {
    const normalizedApiUrl = normalizeWorkersDevUrl(apiUrl || '', workersSubdomain);
    const normalizedAdminUiUrl = normalizeWorkersDevUrl(adminUiUrl, workersSubdomain);
    const adminUiSiteClassification = classifyUiApiSite(normalizedApiUrl, normalizedAdminUiUrl, {
      baseDomain: config.tenant?.multiTenant === true ? config.tenant.baseDomain : undefined,
    });

    if (adminUiSiteClassification !== 'cross-site') {
      origins.add(normalizedAdminUiUrl);
    }
  }

  return Array.from(origins);
}

// =============================================================================
// Generator Functions
// =============================================================================

/**
 * Generate wrangler.toml configuration for a component
 *
 * @param component - Worker component name
 * @param config - Authrim configuration
 * @param resourceIds - Resource IDs from authrim-lock.json
 * @param workersSubdomain - Account subdomain for workers.dev (e.g., "sgrastar")
 */
export function generateWranglerConfig(
  component: WorkerComponent,
  config: AuthrimConfig,
  resourceIds: ResourceIds,
  workersSubdomain?: string,
  options: GenerateWranglerConfigOptions = {}
): WranglerConfig {
  const env = config.environment.prefix;
  const multiTenantBaseDomain =
    config.tenant?.multiTenant === true ? config.tenant.baseDomain : undefined;
  const multiTenantEnabled = !!multiTenantBaseDomain;
  const workerName = getWorkerName(env, component);

  // Base configuration
  const wranglerConfig: WranglerConfig = {
    name: workerName,
    main: COMPONENT_ENTRY_POINTS[component],
    compatibility_date:
      component === 'ar-agent-access'
        ? '2026-07-16'
        : component === 'ar-control' || component === 'ar-plugin-runner'
          ? '2026-07-01'
          : '2024-09-23',
    compatibility_flags:
      component === 'ar-management' ? ['nodejs_compat', 'enable_ctx_exports'] : ['nodejs_compat'],
    // With Service Binding, UI Workers can reach ar-router internally without workers.dev.
    // Disable workers.dev when a custom API domain is set to avoid dual public endpoints.
    workers_dev:
      component === 'ar-control' || component === 'ar-plugin-runner'
        ? false
        : !config.urls?.api?.custom,
    build: { command: MANAGED_WORKER_DEPLOY_BUILD_COMMAND },
    vars: generateEnvVars(component, config, workersSubdomain),
  };
  if (resourceIds.controlKeyState && component === 'ar-control') {
    wranglerConfig.vars['RUNTIME_REGISTRY_SIGNING_ACTIVE_SLOT'] =
      resourceIds.controlKeyState.runtimeRegistry.activeSlot;
    wranglerConfig.vars['SMOKE_RPC_SIGNING_ACTIVE_SLOT'] =
      resourceIds.controlKeyState.smokeRpc.activeSlot;
    wranglerConfig.vars['SMOKE_RPC_SIGNING_ACTIVE_KID'] =
      resourceIds.controlKeyState.smokeRpc.activeKeyId;
  }
  if (resourceIds.controlKeyState && component === 'ar-management') {
    wranglerConfig.vars['LOOKUP_HMAC_ACTIVE_SLOT'] =
      resourceIds.controlKeyState.lookupHmac.activeSlot;
    wranglerConfig.vars['LOOKUP_HMAC_ACTIVE_GENERATION'] = String(
      resourceIds.controlKeyState.lookupHmac.activeGeneration
    );
  }
  if (component === 'ar-management') {
    const registeredSchemaReferences = JSON.stringify(resourceIds.registeredSchemaReferences ?? []);
    if (Buffer.byteLength(registeredSchemaReferences, 'utf-8') > 5 * 1024) {
      throw new Error('registered_schema_references_exceed_cloudflare_variable_limit');
    }
    wranglerConfig.vars['AUTHRIM_REGISTERED_SCHEMA_REFS'] = registeredSchemaReferences;
  }

  if (isControlSmokeRuntimeComponent(component)) {
    wranglerConfig.version_metadata = { binding: 'CONTROL_SMOKE_VERSION' };
  }

  // Placement remains off by default because most Workers also access sharded Durable Objects.
  wranglerConfig.placement = { mode: options.placementMode ?? 'off' };

  if (component === 'ar-bridge') {
    wranglerConfig.triggers = {
      crons: ['*/15 * * * *'],
    };
  }

  if (component === 'ar-saml') {
    wranglerConfig.triggers = {
      crons: ['*/5 * * * *'],
    };
  }

  if (component === 'ar-control') {
    wranglerConfig.triggers = {
      crons: ['* * * * *'],
    };
  }

  if (component === 'ar-plugin-runner') {
    wranglerConfig.vars['PLUGIN_ENCRYPTION_ACTIVE_KEY_ID'] = 'v1';
  }

  if (component === 'ar-plugin-runner' && config.features.pluginDynamicWorkers?.enabled === true) {
    if (!resourceIds.r2?.['PLUGIN_BUNDLES']?.name) {
      throw new Error('plugin_dynamic_workers_bundle_bucket_missing');
    }
    wranglerConfig.triggers = {
      crons: ['* * * * *'],
    };
    wranglerConfig.worker_loaders = [{ binding: 'PLUGIN_LOADER' }];
  }

  if (component === 'ar-plugin-runner' && config.features.pluginDynamicWorkers?.enabled !== true) {
    wranglerConfig.triggers = {
      crons: ['* * * * *'],
    };
  }

  if (component === 'ar-management') {
    wranglerConfig.triggers = {
      crons: ['* * * * *', '*/2 * * * *', '*/5 * * * *', '0 */6 * * *'],
    };
    wranglerConfig.vars['AUTHRIM_R2_MAINTENANCE_CRON_ENABLED'] = 'true';
  }

  if (component === 'ar-agent-access') {
    wranglerConfig.triggers = {
      crons: ['* * * * *'],
    };
  }

  if (component === 'ar-control' && options.includeControlSmokeBindings !== false) {
    wranglerConfig.services = CONTROL_SMOKE_RUNTIME_COMPONENTS.map((targetComponent) => ({
      binding: getControlSmokeBindingName(targetComponent),
      service: `${env}-${targetComponent}`,
      entrypoint: 'RuntimeSmokeEntrypoint',
      props: {
        caller: 'ar-control',
        audience: 'authrim-runtime-smoke-v1',
        environmentId: env,
        targetWorker: `${env}-${targetComponent}`,
      },
    }));
  }

  // KV Namespaces
  const kvBindings = COMPONENT_KV_BINDINGS[component];
  const pluginKvBindings =
    component === 'ar-plugin-runner'
      ? (resourceIds.pluginRunnerResources ?? [])
          .filter((resource) => resource.kind === 'kv_namespace')
          .map((resource) => ({
            binding: resource.binding,
            id: resource.providerResourceId,
          }))
      : [];
  if (kvBindings.length > 0 || pluginKvBindings.length > 0) {
    wranglerConfig.kv_namespaces = [
      ...kvBindings
        .filter((binding) => resourceIds.kv[binding])
        .map((binding) => ({
          binding,
          id: resourceIds.kv[binding].id,
        })),
      ...pluginKvBindings,
    ];
  }

  // D1 databases, including Control-managed TDB_* routes where a Worker needs data-plane access.
  const d1Databases = collectD1DatabaseBindings(component, resourceIds);
  if (d1Databases.length > 0) {
    wranglerConfig.d1_databases = d1Databases;
  }

  const hyperdriveBindings = collectConfiguredHyperdriveBindings(config);
  if (shouldAttachConfiguredHyperdriveBindings(component) && hyperdriveBindings.length > 0) {
    wranglerConfig.hyperdrive = hyperdriveBindings;
  }

  // Durable Objects
  if (component === 'ar-lib-core') {
    // ar-lib-core defines all DOs
    wranglerConfig.durable_objects = {
      bindings: DURABLE_OBJECTS.map((dob) => ({
        name: dob.name,
        class_name: dob.className,
      })),
    };

    if (options.includeDurableObjectMigrations !== false) {
      // Migrations for ar-lib-core. Existing environment updates must not resend
      // initial new_sqlite_classes migrations for already-created Durable Objects.
      wranglerConfig.migrations = generateDOMigrations();
    }
  } else {
    // Other components reference DOs from ar-lib-core
    const doBindings = COMPONENT_DO_BINDINGS[component];
    const localDOBindings = COMPONENT_LOCAL_DO_BINDINGS[component] ?? [];
    const externalDOBindings = COMPONENT_EXTERNAL_DO_BINDINGS[component] ?? [];
    if (doBindings.length > 0 || localDOBindings.length > 0 || externalDOBindings.length > 0) {
      const scriptName = getDOScriptName(env);
      wranglerConfig.durable_objects = {
        bindings: [
          ...doBindings.map((doName) => {
            const doDef = DURABLE_OBJECTS.find((d) => d.name === doName);
            return {
              name: doName,
              class_name: doDef?.className || doName,
              script_name: scriptName,
            };
          }),
          ...localDOBindings.map((binding) => ({
            name: binding.name,
            class_name: binding.className,
          })),
          ...externalDOBindings.map((binding) => ({
            name: binding.name,
            class_name: binding.className,
            script_name: getWorkerName(env, binding.scriptComponent),
          })),
        ],
      };
    }
    if (localDOBindings.length > 0) {
      wranglerConfig.migrations =
        component === 'ar-vc'
          ? [
              {
                tag: 'ar-vc-local-v1',
                new_sqlite_classes: ['CredentialOfferStore', 'VPRequestStore'],
              },
              {
                tag: 'ar-vc-local-v2',
                new_sqlite_classes: ['CredentialOfferStoreV2'],
              },
              {
                tag: 'ar-vc-local-v3',
                new_sqlite_classes: ['VPRequestStoreV2'],
              },
            ]
          : [
              {
                tag: `${component}-local-v1`,
                new_sqlite_classes: localDOBindings.map((binding) => binding.className),
              },
            ];
    }
  }

  // R2 Buckets — bind only resources recorded in the environment lock.
  //
  // Do not synthesize bucket names here. Wrangler treats a binding to a missing
  // bucket as an instruction to provision it during deploy. Multiple Workers
  // share these buckets, so concurrent first deploys can race and one fails with
  // Cloudflare error 10004 after another Worker creates the same bucket.
  if (resourceIds.r2 && Object.keys(resourceIds.r2).length > 0) {
    const r2Buckets: Array<{ binding: string; bucket_name: string }> = [];
    const addProvisionedR2Binding = (binding: string): void => {
      const bucket = resourceIds.r2?.[binding];
      if (bucket) {
        r2Buckets.push({ binding, bucket_name: bucket.name });
      }
    };

    if (component === 'ar-control') {
      addProvisionedR2Binding('MIGRATION_RELEASES');
    }

    if (component === 'ar-plugin-runner') {
      addProvisionedR2Binding('PLUGIN_BUNDLES');
    }

    if (component === 'ar-plugin-runner') {
      r2Buckets.push(
        ...(resourceIds.pluginRunnerResources ?? [])
          .filter((resource) => resource.kind === 'r2_bucket')
          .map((resource) => ({
            binding: resource.binding,
            bucket_name: resource.providerName,
          }))
      );
    }

    if (component === 'ar-management') {
      addProvisionedR2Binding('PUBLIC_ASSETS');
    }

    if (
      component === 'ar-auth' ||
      component === 'ar-token' ||
      component === 'ar-async' ||
      component === 'ar-saml' ||
      component === 'ar-bridge' ||
      component === 'ar-vc' ||
      component === 'ar-management'
    ) {
      addProvisionedR2Binding('DIAGNOSTIC_LOGS');
      addProvisionedR2Binding('AUDIT_ARCHIVE');
    }

    if (component === 'ar-bridge') {
      addProvisionedR2Binding('SENSITIVE_DETAILS');
    }

    if (component === 'ar-management') {
      addProvisionedR2Binding('IMPORT_ARTIFACTS');
      addProvisionedR2Binding('EXPORT_ARTIFACTS');
      addProvisionedR2Binding('SENSITIVE_DETAILS');
    }

    if (r2Buckets.length > 0) {
      wranglerConfig.r2_buckets = r2Buckets;
    }
  }

  // Queues (optional)
  if (config.features.queue?.enabled && resourceIds.queues) {
    const producers: Array<{ queue: string; binding: string }> = [];
    const consumers: Array<{
      queue: string;
      max_batch_size?: number;
      max_batch_timeout?: number;
      max_retries?: number;
      dead_letter_queue?: string;
    }> = [];

    if (component === 'ar-auth' || component === 'ar-token') {
      producers.push({
        queue: resourceIds.queues['AUDIT_QUEUE']?.name || `${env}-audit-queue`,
        binding: 'AUDIT_QUEUE',
      });
    }

    if (LOGGING_DELIVERY_PRODUCER_COMPONENTS.includes(component)) {
      for (const definition of LOGGING_DELIVERY_QUEUE_DEFINITIONS) {
        producers.push({
          queue: resourceIds.queues[definition.resourceKey]?.name ?? definition.fallbackName(env),
          binding: definition.binding,
        });
      }
    }

    if (component === 'ar-management') {
      consumers.push({
        queue: resourceIds.queues['AUDIT_QUEUE']?.name || `${env}-audit-queue`,
      });
      for (const definition of LOGGING_DELIVERY_QUEUE_DEFINITIONS) {
        consumers.push({
          queue: resourceIds.queues[definition.resourceKey]?.name ?? definition.fallbackName(env),
        });
      }
    }

    if (producers.length > 0 || consumers.length > 0) {
      wranglerConfig.queues = {
        ...(producers.length > 0 ? { producers } : {}),
        ...(consumers.length > 0 ? { consumers } : {}),
      };
      if (component === 'ar-management') {
        wranglerConfig.vars.LOGGING_DELIVERY_QUEUE_NAMES = LOGGING_DELIVERY_QUEUE_DEFINITIONS.map(
          (definition) =>
            resourceIds.queues?.[definition.resourceKey]?.name ?? definition.fallbackName(env)
        ).join(',');
      }
    }
  }

  if (config.features.email?.provider === 'cloudflare' && component === 'ar-plugin-runner') {
    wranglerConfig.send_email = [{ name: 'EMAIL' }];
  }

  // Service Bindings for standard services used by auth/runtime and admin proxies.
  if (component === 'ar-discovery') {
    wranglerConfig.services = [
      {
        binding: 'KEY_MANAGER_PUBLIC',
        service: `${env}-ar-lib-core`,
        entrypoint: 'KeyManagerPublicEntrypoint',
      },
    ];
  }

  if (component === 'ar-agent-access') {
    wranglerConfig.services = [
      { binding: 'OP_MANAGEMENT', service: `${env}-ar-management` },
      { binding: 'OP_DISCOVERY', service: `${env}-ar-discovery` },
      {
        binding: 'AGENT_DOWNSCOPE',
        service: `${env}-ar-token`,
        entrypoint: 'AgentDownscopeEntrypoint',
      },
    ];
  }

  if (component === 'ar-auth' || component === 'ar-management') {
    wranglerConfig.services = [{ binding: 'EXTERNAL_IDP', service: `${env}-ar-bridge` }];
    if (component === 'ar-auth' && options.includeAuthAccountProvisioner !== false) {
      wranglerConfig.services.push({
        binding: 'ACCOUNT_PROVISIONER',
        service: `${env}-ar-management`,
        entrypoint: 'AuthAccountProvisioningEntrypoint',
        props: {
          caller: 'ar-auth',
          environmentId: env,
          audience: 'authrim-auth-account-provisioning-v1',
        },
      });
    }
    if (component === 'ar-management') {
      wranglerConfig.services.push({
        binding: 'CONTROL',
        service: `${env}-ar-control`,
        props: {
          caller: 'ar-management',
          environmentId: env,
          audience: 'authrim-control-v1',
        },
      });
    }
    if (component === 'ar-management' && config.components.vc === true) {
      wranglerConfig.services.push({
        binding: 'VC_ISSUER',
        service: `${env}-ar-vc`,
        entrypoint: 'VCIssuerEntrypoint',
      });
    }
  }

  if (component === 'ar-plugin-runner') {
    wranglerConfig.services ??= [];
    wranglerConfig.services.push({
      binding: 'CONTROL',
      service: `${env}-ar-control`,
      props: {
        caller: 'ar-plugin-runner',
        environmentId: env,
        audience: 'authrim-control-v1',
      },
    });
  }

  if (component === 'ar-bridge' && options.includeExternalIdpAccountProvisioner !== false) {
    wranglerConfig.services = [
      {
        binding: 'EXTERNAL_IDP_ACCOUNT_PROVISIONER',
        service: `${env}-ar-management`,
        entrypoint: 'AuthAccountProvisioningEntrypoint',
        props: {
          caller: 'ar-bridge',
          environmentId: env,
          audience: 'authrim-external-idp-account-provisioning-v1',
        },
      },
    ];
  }

  if (isPluginRunnerRpcComponent(component)) {
    wranglerConfig.services ??= [];
    wranglerConfig.services.push({
      binding: 'PLUGIN_RUNNER',
      service: `${env}-ar-plugin-runner`,
      props: {
        caller: component,
        environmentId: env,
        audience: 'authrim-plugin-runner-v1',
      },
    });
  }

  // Service Bindings for ar-router (required for routing to other workers)
  if (component === 'ar-router') {
    // Core services (always required)
    const services: Array<{ binding: string; service: string }> = [
      { binding: 'OP_DISCOVERY', service: `${env}-ar-discovery` },
      { binding: 'OP_AUTH', service: `${env}-ar-auth` },
      { binding: 'OP_TOKEN', service: `${env}-ar-token` },
      { binding: 'OP_USERINFO', service: `${env}-ar-userinfo` },
      { binding: 'OP_MANAGEMENT', service: `${env}-ar-management` },
      { binding: 'OP_CONTROL', service: `${env}-ar-control` },
      { binding: 'OP_AGENT_ACCESS', service: `${env}-ar-agent-access` },
    ];

    // Standard services are installed by default. Some features still require runtime setup.
    services.push({ binding: 'EXTERNAL_IDP', service: `${env}-ar-bridge` });
    services.push({ binding: 'POLICY_SERVICE', service: `${env}-ar-policy` });
    services.push({ binding: 'OP_ASYNC', service: `${env}-ar-async` });
    services.push({ binding: 'OP_SAML', service: `${env}-ar-saml` });
    services.push({ binding: 'OP_VC', service: `${env}-ar-vc` });
    if (config.components.loginUi) {
      services.push({ binding: 'LOGIN_UI_WORKER', service: `${env}-ar-login-ui` });
    }
    if (config.components.adminUi) {
      services.push({ binding: 'ADMIN_UI_WORKER', service: `${env}-ar-admin-ui` });
    }
    if (config.serviceSite?.enabled && config.serviceSite.workerName) {
      services.push({
        binding: config.serviceSite.binding || 'SERVICE_SITE',
        service: config.serviceSite.workerName,
      });
    }

    wranglerConfig.services = services;

    // Routes / Custom Domain Binding for ar-router (catch-all)
    if (config.urls?.api?.custom) {
      try {
        const customUrl = new URL(config.urls.api.custom);
        const hostname =
          multiTenantEnabled && config.tenant?.baseDomain
            ? normalizeHostnameCandidate(config.tenant.baseDomain) || customUrl.hostname
            : customUrl.hostname;
        const zoneName = extractZoneName(hostname);
        if (config.urls?.api?.customDomainBinding) {
          // In multi-tenant mode, the naked domain can use a custom domain binding, but
          // tenant subdomains still need wildcard route matching.
          if (multiTenantEnabled) {
            wranglerConfig.routes = [
              { pattern: hostname, custom_domain: true },
              { pattern: `*.${hostname}`, zone_name: zoneName },
              { pattern: `*.${hostname}/*`, zone_name: zoneName },
            ];
          } else {
            // Custom Domain Binding: Cloudflare assigns the domain directly to the Worker.
            // No zone_name required; pattern is just the hostname.
            wranglerConfig.routes = [{ pattern: hostname, custom_domain: true }];
          }
        } else {
          // Route: Pattern-based routing via DNS zone.
          wranglerConfig.routes = [{ pattern: `${hostname}/*`, zone_name: zoneName }];
          if (multiTenantEnabled) {
            wranglerConfig.routes.push({ pattern: `*.${hostname}`, zone_name: zoneName });
            wranglerConfig.routes.push({ pattern: `*.${hostname}/*`, zone_name: zoneName });
          }
        }
      } catch {
        // Invalid URL, skip routing configuration
      }
    }
  }

  // Custom-domain routing is terminated at ar-router.
  // Non-router workers are reached through service bindings, otherwise ar-router's
  // special-case routing (e.g. /api/auth/authentication-methods, /api/admin/setup-token/*)
  // is bypassed by Cloudflare route precedence.

  return wranglerConfig;
}

/**
 * Generate environment variables for a component
 *
 * @param component - Worker component name
 * @param config - Authrim configuration
 * @param workersSubdomain - Account subdomain for workers.dev (e.g., "sgrastar")
 */
export function generateEnvVars(
  component: WorkerComponent,
  config: AuthrimConfig,
  workersSubdomain?: string
): Record<string, string> {
  const vars: Record<string, string> = {};
  const multiTenantBaseDomain =
    config.tenant?.multiTenant === true ? config.tenant.baseDomain : undefined;
  const multiTenantEnabled = !!multiTenantBaseDomain;
  const loginUiUsesApiDomain = config.urls?.loginUi?.sameAsApi === true;
  const loginUiRunsOnIssuer = loginUiUsesApiDomain || multiTenantEnabled;

  if (
    component === 'ar-lib-core' ||
    component === 'ar-discovery' ||
    component === 'ar-control' ||
    component === 'ar-plugin-runner' ||
    isControlSmokeRuntimeComponent(component)
  ) {
    vars['AUTHRIM_ENVIRONMENT_NAME'] = config.environment.prefix;
  }

  if (isControlSmokeRuntimeComponent(component)) {
    vars['AUTHRIM_WORKER_SCRIPT_NAME'] = getWorkerName(config.environment.prefix, component);
  }

  if (component === 'ar-control') {
    vars['RUNTIME_REGISTRY_SIGNING_ACTIVE_SLOT'] = 'A';
    vars['SMOKE_RPC_SIGNING_ACTIVE_SLOT'] = 'A';
    vars['CONTROL_DESTRUCTIVE_OPERATIONS_ENABLED'] = 'false';
    vars['AUTHRIM_AUTOMATIC_PROVISIONING'] =
      config.controlPlane?.automaticProvisioning === true ? 'true' : 'false';
    vars['AUTHRIM_DEPLOYMENT_TARGET'] = 'default';
    if (config.keys.keyId) {
      vars['SMOKE_RPC_SIGNING_ACTIVE_KID'] = `${config.keys.keyId}-control-smoke`;
    }
  }

  if (component === 'ar-management') {
    vars['LOOKUP_HMAC_ACTIVE_SLOT'] = 'A';
    vars['LOOKUP_HMAC_ACTIVE_GENERATION'] = '1';
  }

  if (component === 'ar-control' && config.cloudflare?.accountId) {
    vars['CLOUDFLARE_ACCOUNT_ID'] = config.cloudflare.accountId;
  }

  // Determine issuer URL
  // In multi-tenant mode with BASE_DOMAIN: issuer is dynamically built from {tenant}.{baseDomain}
  // Otherwise: use workers.dev or custom API domain
  let issuerUrl: string;
  if (multiTenantEnabled) {
    // Multi-tenant mode: use BASE_DOMAIN (ISSUER_URL is not used, kept for fallback)
    issuerUrl = normalizeWorkersDevUrl(config.urls?.api?.auto || '', workersSubdomain);
  } else {
    // Single-tenant or workers.dev mode: use explicit issuer URL
    issuerUrl = normalizeWorkersDevUrl(
      config.urls?.api?.custom || config.urls?.api?.auto || '',
      workersSubdomain
    );
  }
  // UI_URL remains the Login UI deployment origin used for service-to-service
  // configuration. Browser login execution is explicitly pinned to the issuer
  // below, so a single-tenant custom domain can become the primary tenant of a
  // multi-tenant deployment without changing its Login UI origin.
  const apiUrlForUi = normalizeWorkersDevUrl(
    config.urls?.api?.custom || config.urls?.api?.auto || '',
    workersSubdomain
  );
  const tenantIssuerUiUrl =
    multiTenantEnabled && multiTenantBaseDomain
      ? config.tenant?.nakedDomain
        ? `https://${multiTenantBaseDomain}`
        : `https://${config.tenant?.name || 'default'}.${multiTenantBaseDomain}`
      : apiUrlForUi;
  const uiUrl = loginUiUsesApiDomain
    ? tenantIssuerUiUrl
    : normalizeWorkersDevUrl(
        config.urls?.loginUi?.custom || config.urls?.loginUi?.auto || issuerUrl,
        workersSubdomain
      );
  const adminUiUrl = config.urls?.adminUi?.sameAsApi
    ? apiUrlForUi
    : normalizeWorkersDevUrl(
        config.urls?.adminUi?.custom || config.urls?.adminUi?.auto || issuerUrl,
        workersSubdomain
      );
  const hasAdminUiOrigins = Boolean(getUrlHost(apiUrlForUi) && getUrlHost(adminUiUrl));
  if (config.components.adminUi && !hasAdminUiOrigins) {
    throw new Error('admin_ui_origin_configuration_invalid');
  }
  const profileDefaults = config.profiles?.defaults ?? {
    audit: 'builtin:audit:standard',
    residency: 'builtin:residency:default',
  };
  const profileRegistryBackend = config.profiles?.registry?.backend ?? 'kv';
  const profileAwareComponents: WorkerComponent[] = [
    'ar-lib-core',
    'ar-auth',
    'ar-management',
    'ar-token',
    'ar-userinfo',
    'ar-discovery',
    'ar-saml',
    'ar-bridge',
  ];

  // Issuer URL (single-tenant mode uses this directly)
  // In multi-tenant mode, issuer is dynamically built from subdomain + BASE_DOMAIN
  if (
    component === 'ar-auth' ||
    component === 'ar-token' ||
    component === 'ar-discovery' ||
    component === 'ar-management' ||
    component === 'ar-agent-access' ||
    component === 'ar-saml'
  ) {
    vars['ISSUER_URL'] = issuerUrl;
  }

  // Tenant configuration
  // Multi-tenant mode is always enabled when BASE_DOMAIN is set.
  // Domain pattern: {tenant}.{baseDomain}
  const tenantAwareComponents: WorkerComponent[] = [
    'ar-discovery',
    'ar-auth',
    'ar-token',
    'ar-userinfo',
    'ar-management',
    'ar-agent-access',
    'ar-router',
    'ar-async',
    'ar-policy',
    'ar-saml',
    'ar-bridge',
    'ar-vc',
  ];
  const routerServiceBoundComponents: WorkerComponent[] = [
    'ar-discovery',
    'ar-auth',
    'ar-token',
    'ar-userinfo',
    'ar-management',
    'ar-agent-access',
    'ar-async',
    'ar-policy',
    'ar-saml',
    'ar-bridge',
    'ar-vc',
  ];

  if (tenantAwareComponents.includes(component)) {
    vars['DEFAULT_TENANT_ID'] = config.tenant?.name || 'default';

    // User ID format (nanoid or uuid)
    vars['USER_ID_FORMAT'] = config.tenant?.userIdFormat || 'nanoid';

    if (multiTenantEnabled) {
      vars['BASE_DOMAIN'] = multiTenantBaseDomain;

      const primaryTenantId =
        config.tenant.primaryTenant || (config.tenant.nakedDomain ? config.tenant.name : undefined);

      if (primaryTenantId) {
        vars['PRIMARY_TENANT_ID'] = primaryTenantId;
      }

      // Naked domain as issuer (use naked domain instead of tenant subdomain)
      if (config.tenant.nakedDomain) {
        vars['NAKED_DOMAIN_AS_ISSUER'] = 'true';
      }
    }

    if (config.urls?.api?.custom && routerServiceBoundComponents.includes(component)) {
      vars['AUTHRIM_TRUST_FORWARDED_HOST'] = 'true';
    }
  }

  if (component === 'ar-auth' || component === 'ar-management' || component === 'ar-saml') {
    vars['UI_URL'] = uiUrl;
    vars['LOGIN_UI_ENABLED'] = config.components.loginUi ? 'true' : 'false';
    if ((component === 'ar-auth' || component === 'ar-management') && config.components.loginUi) {
      // workers.dev-only deployments use the Login UI Worker's own origin.
      // Once Login UI shares the API/issuer host (or tenant hosts are enabled),
      // execute browser flows on the issuer.
      vars['LOGIN_UI_EXECUTION_HOST_MODE'] = loginUiRunsOnIssuer ? 'issuer' : 'dedicated';
    }
  }

  if (
    component === 'ar-auth' ||
    component === 'ar-management' ||
    component === 'ar-plugin-runner'
  ) {
    if (component !== 'ar-plugin-runner') {
      vars['ADMIN_UI_ENABLED'] = config.components.adminUi ? 'true' : 'false';
    }
    if (config.features.email?.fromAddress) {
      vars['EMAIL_FROM'] = config.features.email.fromAddress;
    }
    if (config.features.email?.fromName) {
      vars['EMAIL_FROM_NAME'] = config.features.email.fromName;
    }
  }

  if (component === 'ar-auth' || component === 'ar-saml') {
    vars['ENABLE_CONFORMANCE_MODE'] = 'false';
  }

  if (component === 'ar-auth') {
    // Cookie SameSite configuration based on origin relationship
    // If UI is served from same domain as API (via proxy), use 'Lax' (more secure)
    // If UI is on different domain, use 'None' (required for cross-origin)
    const loginUiSameOrigin = config.components.loginUi && loginUiRunsOnIssuer;
    vars['COOKIE_SAME_SITE'] = loginUiSameOrigin ? 'Lax' : 'None';

    if (hasAdminUiOrigins) {
      vars['ADMIN_UI_URL'] = adminUiUrl;
      vars['ADMIN_UI_API_MODE'] = getAdminUiApiMode(apiUrlForUi, adminUiUrl, multiTenantBaseDomain);
    }
    vars['ADMIN_COOKIE_SAME_SITE'] = 'Lax';
  }

  // ar-management also needs cookie configuration for admin sessions
  if (component === 'ar-management') {
    if (hasAdminUiOrigins) {
      vars['ADMIN_UI_URL'] = adminUiUrl;
      vars['ADMIN_UI_API_MODE'] = getAdminUiApiMode(apiUrlForUi, adminUiUrl, multiTenantBaseDomain);
    }
    vars['ADMIN_COOKIE_SAME_SITE'] = 'Lax';
    vars['SAML_ENABLED'] = 'true';
    vars['ASYNC_ENABLED'] = 'true';
    vars['VC_ENABLED'] = 'true';
  }

  if (component === 'ar-vc') {
    vars['VC_ATTRIBUTE_ELEVATION_AUDIENCE'] = 'svc://op-vc/attribute-elevation';
  }

  if (component === 'ar-discovery') {
    vars['ASYNC_ENABLED'] = 'true';
  }

  if (profileAwareComponents.includes(component)) {
    vars['PROFILE_REGISTRY_BACKEND'] = profileRegistryBackend;
    vars['DEFAULT_AUDIT_PROFILE_ID'] = profileDefaults.audit;
    vars['DEFAULT_RESIDENCY_PROFILE_ID'] = profileDefaults.residency;
  }

  // OIDC settings
  if (component === 'ar-lib-core') {
    // AuthorizationCodeStore lives in ar-lib-core, so the DO must receive the
    // same auth-code TTL as ar-auth/ar-token.
    vars['AUTH_CODE_EXPIRY'] = config.oidc.authCodeTtl.toString();
  }

  if (component === 'ar-auth' || component === 'ar-token') {
    vars['ACCESS_TOKEN_EXPIRY'] = config.oidc.accessTokenTtl.toString();
    vars['AUTH_CODE_EXPIRY'] = config.oidc.authCodeTtl.toString();
    vars['STATE_EXPIRY'] = '300';
    vars['NONCE_EXPIRY'] = '300';
    vars['REFRESH_TOKEN_EXPIRY'] = config.oidc.refreshTokenTtl.toString();
  }

  // Key configuration
  if (config.keys.keyId) {
    vars['KEY_ID'] = config.keys.keyId;
    if (component === 'ar-auth' || component === 'ar-management') {
      vars['NOTIFICATION_PAYLOAD_ENCRYPTION_ACTIVE_KID'] =
        `${config.keys.keyId}-notification-payload`;
    }
  }

  // Security settings
  vars['ENABLE_HTTP_REDIRECT'] = 'false';
  vars['ENABLE_OPEN_REGISTRATION'] = 'false';
  if (component === 'ar-auth') {
    vars['ENABLE_LOGIN_RUNTIME_FLOW'] = 'true';
  }

  // Sharding configuration
  if (component === 'ar-lib-core' || component === 'ar-auth' || component === 'ar-token') {
    vars['AUTHRIM_CODE_SHARDS'] = config.sharding.authCodeShards.toString();
    vars['AUTHRIM_SESSION_SHARDS'] = (config.sharding.sessionShards ?? 4).toString();
  }
  if (component === 'ar-lib-core' || COMPONENT_DO_BINDINGS[component].includes('CHALLENGE_STORE')) {
    vars['AUTHRIM_CHALLENGE_SHARDS'] = (config.sharding.challengeShards ?? 4).toString();
  }

  const componentSecrets = getSecretNamesForWorker(component);
  if (componentSecrets.includes('PLUGIN_ENCRYPTION_KEY')) {
    vars['PLUGIN_ENCRYPTION_KEY'] = ''; // Set via secret
  }
  if (componentSecrets.includes('AGENT_ELEVATION_ENCRYPTION_KEY')) {
    vars['AGENT_ELEVATION_ENCRYPTION_KEY'] = ''; // Set via secret
    vars['AGENT_ELEVATION_KEY_VERSION'] = 'v1';
  }
  if (componentSecrets.includes('PII_ENCRYPTION_KEY')) {
    vars['PII_ENCRYPTION_KEY'] = ''; // Set via secret
  }
  if (componentSecrets.includes('OTP_HMAC_SECRET')) {
    vars['OTP_HMAC_SECRET'] = ''; // Set via secret
  }
  if (componentSecrets.includes('FLOW_RUNTIME_HMAC_SECRET')) {
    vars['FLOW_RUNTIME_HMAC_SECRET'] = ''; // Set via secret
  }
  if (componentSecrets.includes('VC_TRANSACTION_CODE_HMAC_SECRET')) {
    vars['VC_TRANSACTION_CODE_HMAC_SECRET'] = ''; // Set via secret
  }
  if (componentSecrets.includes('VC_EVIDENCE_HMAC_SECRET')) {
    vars['VC_EVIDENCE_HMAC_SECRET'] = ''; // Set via secret
  }
  if (componentSecrets.includes('VC_PROFILE_CONTRACT_HMAC_SECRET')) {
    vars['VC_PROFILE_CONTRACT_HMAC_SECRET'] = ''; // Set via secret
  }

  // ar-router: UI proxy configuration
  // In multi-tenant mode, the login UI must also be reachable on issuer/tenant hosts so
  // tenant-specific /login, /discover, and /signup URLs stay canonical and host-bound.
  // Admin UI custom domains inside the multi-tenant base domain are also handled here because
  // the router owns the wildcard route for tenant hosts.
  if (component === 'ar-router') {
    const adminSameAsApi = config.urls?.adminUi?.sameAsApi === true;
    const adminProxyEnabled = adminSameAsApi || multiTenantEnabled;
    vars['ENABLE_ADMIN_UI_PROXY'] = adminProxyEnabled ? 'true' : 'false';
    const adminUiPublicUrl = config.urls?.adminUi?.custom || config.urls?.adminUi?.auto;
    if (adminUiPublicUrl) {
      vars['ADMIN_UI_URL'] = adminUiPublicUrl;
    }
    if (adminProxyEnabled) {
      const adminUiWorkerUrl = normalizeWorkersDevUrl(
        config.urls?.adminUi?.auto || adminUiPublicUrl || '',
        workersSubdomain
      );
      if (adminUiWorkerUrl) {
        vars['AR_ADMIN_UI_URL'] = adminUiWorkerUrl;
      }
    }

    // A dedicated Login UI keeps browser traffic off Router UI paths. When the
    // UI shares the API/issuer host (or tenant hosts are enabled), Router owns
    // both the root proxy behaviour and Login UI paths.
    const loginProxyEnabled = config.urls?.loginUi?.sameAsApi === true || multiTenantEnabled;
    const loginUiHostMode =
      config.urls?.loginUi?.sameAsApi === true || getUrlHost(uiUrl) === getUrlHost(apiUrlForUi)
        ? 'shared'
        : 'dedicated';
    vars['ENABLE_LOGIN_UI_PROXY'] = loginProxyEnabled ? 'true' : 'false';
    vars['ENABLE_LOGIN_UI_PATH_PROXY'] = loginProxyEnabled ? 'true' : 'false';
    if (uiUrl) {
      vars['LOGIN_UI_URL'] = uiUrl;
      vars['LOGIN_UI_HOST_MODE'] = loginUiHostMode;
    }
    if (loginProxyEnabled) {
      const loginUiWorkerUrl = normalizeWorkersDevUrl(
        config.urls?.loginUi?.auto || config.urls?.loginUi?.custom || '',
        workersSubdomain
      );
      if (loginUiWorkerUrl) {
        vars['AR_LOGIN_UI_URL'] = loginUiWorkerUrl;
      }
    }
    if (config.serviceSite?.enabled && config.serviceSite.workerName) {
      vars['SERVICE_SITE_BINDING'] = config.serviceSite.binding || 'SERVICE_SITE';
    }
  }

  // CORS allowed origins for workers that handle cross-origin requests.
  // This is the setup-side web_origin_registry -> ALLOWED_ORIGINS materialization boundary.
  // Workers.dev URLs are normalized to correct format: {name}.{subdomain}.workers.dev
  if (['ar-auth', 'ar-management', 'ar-agent-access', 'ar-router', 'ar-saml'].includes(component)) {
    const allowedOrigins = deriveAllowedOrigins(config, workersSubdomain);
    if (allowedOrigins.length > 0) {
      vars['ALLOWED_ORIGINS'] = allowedOrigins.join(',');
    }
  }

  return vars;
}

/**
 * Generate DO migrations for ar-lib-core
 */
function generateDOMigrations(): WranglerConfig['migrations'] {
  return [
    {
      tag: 'v1',
      new_sqlite_classes: [
        'SessionStore',
        'AuthorizationCodeStore',
        'RefreshTokenRotator',
        'KeyManager',
        'ChallengeStore',
        'RateLimiterCounter',
        'PARRequestStore',
        'DPoPJTIStore',
      ],
    },
    { tag: 'v2' },
    {
      tag: 'v3',
      new_sqlite_classes: ['DeviceCodeStore', 'CIBARequestStore'],
    },
    {
      tag: 'v4',
      new_sqlite_classes: ['TokenRevocationStore'],
    },
    {
      tag: 'v5',
      new_sqlite_classes: ['VersionManager'],
    },
    {
      tag: 'v6',
      new_sqlite_classes: ['SAMLRequestStore'],
    },
    {
      tag: 'v7',
      new_sqlite_classes: ['PermissionChangeHub'],
    },
    {
      tag: 'v8',
      new_sqlite_classes: ['FlowStateStore'],
    },
    {
      tag: 'v9',
      new_sqlite_classes: ['SessionClientStore'],
    },
    {
      tag: 'v10',
      new_sqlite_classes: ['SAMLAggregateMetadataStore'],
    },
    {
      tag: 'v11',
      new_sqlite_classes: ['DeviceSecretRouteStore'],
    },
    {
      tag: 'v12',
      new_sqlite_classes: ['SessionRevocationStore'],
    },
  ];
}

// =============================================================================
// TOML Serialization
// =============================================================================

/**
 * Convert WranglerConfig to TOML string
 *
 * When envName is provided, generates the new Cloudflare [env.xxx] section format:
 * - Top-level: main, compatibility_date, compatibility_flags, migrations
 * - [env.{envName}]: name, workers_dev, placement, kv, d1, do, vars, services, routes
 *
 * When envName is not provided, generates the legacy flat format (for backward compatibility).
 *
 * @param config - Wrangler configuration object
 * @param envName - Optional environment name (e.g., "conformance", "prod")
 */
export function toToml(config: WranglerConfig, envName?: string): string {
  const lines: string[] = [];
  const serializeServiceProps = (props: Record<string, string | number | boolean>): string => {
    const entries = Object.entries(props)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
          throw new Error(`invalid_service_binding_prop_key:${key}`);
        }
        if (typeof value === 'number' && !Number.isFinite(value)) {
          throw new Error(`invalid_service_binding_prop_value:${key}`);
        }
        return `${key} = ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`;
      });
    return `{ ${entries.join(', ')} }`;
  };
  const appendSendEmailBindings = (prefix?: string) => {
    if (!config.send_email || config.send_email.length === 0) {
      return;
    }

    lines.push('# Email Service Bindings');
    for (const binding of config.send_email) {
      const tableName = prefix ? `[[${prefix}.send_email]]` : '[[send_email]]';
      lines.push(tableName);
      lines.push(`name = "${binding.name}"`);
      if (binding.destination_address) {
        lines.push(`destination_address = "${binding.destination_address}"`);
      }
      if (binding.allowed_destination_addresses?.length) {
        lines.push(
          `allowed_destination_addresses = [${binding.allowed_destination_addresses
            .map((value) => `"${value}"`)
            .join(', ')}]`
        );
      }
      if (binding.allowed_sender_addresses?.length) {
        lines.push(
          `allowed_sender_addresses = [${binding.allowed_sender_addresses
            .map((value) => `"${value}"`)
            .join(', ')}]`
        );
      }
      lines.push('');
    }
  };

  if (envName) {
    // =========================================================================
    // New format: [env.xxx] sections
    // =========================================================================

    // Top-level: shared settings (main, compatibility)
    lines.push(`main = "${config.main}"`);
    lines.push(`compatibility_date = "${config.compatibility_date}"`);
    lines.push(
      `compatibility_flags = [${config.compatibility_flags.map((f) => `"${f}"`).join(', ')}]`
    );
    lines.push('');

    if (config.build) {
      lines.push('[build]');
      lines.push(`command = ${JSON.stringify(config.build.command)}`);
      lines.push('');
    }

    // Migrations at top level (for Durable Objects definitions - applies to all envs)
    if (config.migrations && config.migrations.length > 0) {
      lines.push('# Durable Objects Migrations');
      for (const migration of config.migrations) {
        lines.push('[[migrations]]');
        lines.push(`tag = "${migration.tag}"`);
        if (migration.new_sqlite_classes && migration.new_sqlite_classes.length > 0) {
          lines.push('new_sqlite_classes = [');
          for (const cls of migration.new_sqlite_classes) {
            lines.push(`  "${cls}",`);
          }
          lines.push(']');
        }
        lines.push('');
      }
    }

    // Environment-specific section
    lines.push(`# Environment: ${envName}`);
    lines.push(`[env.${envName}]`);
    // Explicitly set worker name to maintain current naming convention ({env}-{component})
    lines.push(`name = "${config.name}"`);
    lines.push(`workers_dev = ${config.workers_dev}`);
    lines.push('');

    // Placement
    if (config.placement) {
      lines.push(`[env.${envName}.placement]`);
      lines.push(`mode = "${config.placement.mode}"`);
      lines.push('');
    }

    if (config.version_metadata) {
      lines.push(`[env.${envName}.version_metadata]`);
      lines.push(`binding = "${config.version_metadata.binding}"`);
      lines.push('');
    }

    if (config.worker_loaders && config.worker_loaders.length > 0) {
      lines.push('# Dynamic Workers Loader');
      for (const loader of config.worker_loaders) {
        lines.push(`[[env.${envName}.worker_loaders]]`);
        lines.push(`binding = "${loader.binding}"`);
        lines.push('');
      }
    }

    if (config.triggers?.crons && config.triggers.crons.length > 0) {
      lines.push(`[env.${envName}.triggers]`);
      lines.push(`crons = [${config.triggers.crons.map((cron) => `"${cron}"`).join(', ')}]`);
      lines.push('');
    }

    // KV Namespaces
    if (config.kv_namespaces && config.kv_namespaces.length > 0) {
      lines.push('# KV Namespaces');
      for (const kv of config.kv_namespaces) {
        lines.push(`[[env.${envName}.kv_namespaces]]`);
        lines.push(`binding = "${kv.binding}"`);
        lines.push(`id = "${kv.id}"`);
        if (kv.preview_id) {
          lines.push(`preview_id = "${kv.preview_id}"`);
        }
        lines.push('');
      }
    }

    // D1 Databases
    if (config.d1_databases && config.d1_databases.length > 0) {
      lines.push('# D1 Databases');
      for (const db of config.d1_databases) {
        lines.push(`[[env.${envName}.d1_databases]]`);
        lines.push(`binding = "${db.binding}"`);
        lines.push(`database_name = "${db.database_name}"`);
        lines.push(`database_id = "${db.database_id}"`);
        lines.push('');
      }
    }

    // R2 Buckets
    if (config.r2_buckets && config.r2_buckets.length > 0) {
      lines.push('# R2 Buckets');
      for (const r2 of config.r2_buckets) {
        lines.push(`[[env.${envName}.r2_buckets]]`);
        lines.push(`binding = "${r2.binding}"`);
        lines.push(`bucket_name = "${r2.bucket_name}"`);
        lines.push('');
      }
    }

    // Hyperdrive
    if (config.hyperdrive && config.hyperdrive.length > 0) {
      lines.push('# Hyperdrive');
      for (const binding of config.hyperdrive) {
        lines.push(`[[env.${envName}.hyperdrive]]`);
        lines.push(`binding = "${binding.binding}"`);
        lines.push(`id = "${binding.id}"`);
        lines.push('');
      }
    }

    // Queues
    if (
      (config.queues?.producers && config.queues.producers.length > 0) ||
      (config.queues?.consumers && config.queues.consumers.length > 0)
    ) {
      lines.push('# Cloudflare Queues');
      if (config.queues?.producers) {
        for (const producer of config.queues.producers) {
          lines.push(`[[env.${envName}.queues.producers]]`);
          lines.push(`queue = "${producer.queue}"`);
          lines.push(`binding = "${producer.binding}"`);
          lines.push('');
        }
      }
      if (config.queues?.consumers) {
        for (const consumer of config.queues.consumers) {
          lines.push(`[[env.${envName}.queues.consumers]]`);
          lines.push(`queue = "${consumer.queue}"`);
          if (consumer.max_batch_size !== undefined) {
            lines.push(`max_batch_size = ${consumer.max_batch_size}`);
          }
          if (consumer.max_batch_timeout !== undefined) {
            lines.push(`max_batch_timeout = ${consumer.max_batch_timeout}`);
          }
          if (consumer.max_retries !== undefined) {
            lines.push(`max_retries = ${consumer.max_retries}`);
          }
          if (consumer.dead_letter_queue) {
            lines.push(`dead_letter_queue = "${consumer.dead_letter_queue}"`);
          }
          lines.push('');
        }
      }
    }

    // Durable Objects
    if (config.durable_objects?.bindings && config.durable_objects.bindings.length > 0) {
      lines.push('# Durable Objects Bindings');
      for (const dob of config.durable_objects.bindings) {
        lines.push(`[[env.${envName}.durable_objects.bindings]]`);
        lines.push(`name = "${dob.name}"`);
        lines.push(`class_name = "${dob.class_name}"`);
        if (dob.script_name) {
          lines.push(`script_name = "${dob.script_name}"`);
        }
        lines.push('');
      }
    }

    // Environment variables
    if (Object.keys(config.vars).length > 0) {
      lines.push('# Environment Variables');
      lines.push(`[env.${envName}.vars]`);
      for (const [key, value] of Object.entries(config.vars)) {
        if (value) {
          lines.push(`${key} = ${JSON.stringify(value)}`);
        }
      }
      lines.push('');
    }

    // Service Bindings
    if (config.services && config.services.length > 0) {
      lines.push('# Service Bindings');
      for (const svc of config.services) {
        lines.push(`[[env.${envName}.services]]`);
        lines.push(`binding = "${svc.binding}"`);
        lines.push(`service = "${svc.service}"`);
        if (svc.entrypoint) {
          lines.push(`entrypoint = "${svc.entrypoint}"`);
        }
        if (svc.props) {
          lines.push(`props = ${serializeServiceProps(svc.props)}`);
        }
        lines.push('');
      }
    }

    appendSendEmailBindings(`env.${envName}`);

    // Routes
    if (config.routes && config.routes.length > 0) {
      lines.push('# Routes');
      for (const route of config.routes) {
        lines.push(`[[env.${envName}.routes]]`);
        lines.push(`pattern = "${route.pattern}"`);
        if (route.zone_name) {
          lines.push(`zone_name = "${route.zone_name}"`);
        }
        if (route.custom_domain) {
          lines.push(`custom_domain = true`);
        }
        lines.push('');
      }
    }
  } else {
    // =========================================================================
    // Legacy format: flat structure (backward compatibility)
    // =========================================================================

    // Basic fields
    lines.push(`name = "${config.name}"`);
    lines.push(`main = "${config.main}"`);
    lines.push(`compatibility_date = "${config.compatibility_date}"`);
    lines.push(
      `compatibility_flags = [${config.compatibility_flags.map((f) => `"${f}"`).join(', ')}]`
    );
    lines.push(`workers_dev = ${config.workers_dev}`);
    lines.push('');

    if (config.build) {
      lines.push('[build]');
      lines.push(`command = ${JSON.stringify(config.build.command)}`);
      lines.push('');
    }

    // Placement
    if (config.placement) {
      lines.push('[placement]');
      lines.push(`mode = "${config.placement.mode}"`);
      lines.push('');
    }
    if (config.worker_loaders && config.worker_loaders.length > 0) {
      lines.push('# Dynamic Workers Loader');
      for (const loader of config.worker_loaders) {
        lines.push('[[worker_loaders]]');
        lines.push(`binding = "${loader.binding}"`);
        lines.push('');
      }
    }

    if (config.version_metadata) {
      lines.push('[version_metadata]');
      lines.push(`binding = "${config.version_metadata.binding}"`);
      lines.push('');
    }

    if (config.triggers?.crons && config.triggers.crons.length > 0) {
      lines.push('[triggers]');
      lines.push(`crons = [${config.triggers.crons.map((cron) => `"${cron}"`).join(', ')}]`);
      lines.push('');
    }

    // KV Namespaces
    if (config.kv_namespaces && config.kv_namespaces.length > 0) {
      lines.push('# KV Namespaces');
      for (const kv of config.kv_namespaces) {
        lines.push('[[kv_namespaces]]');
        lines.push(`binding = "${kv.binding}"`);
        lines.push(`id = "${kv.id}"`);
        if (kv.preview_id) {
          lines.push(`preview_id = "${kv.preview_id}"`);
        }
        lines.push('');
      }
    }

    // D1 Databases
    if (config.d1_databases && config.d1_databases.length > 0) {
      lines.push('# D1 Databases');
      for (const db of config.d1_databases) {
        lines.push('[[d1_databases]]');
        lines.push(`binding = "${db.binding}"`);
        lines.push(`database_name = "${db.database_name}"`);
        lines.push(`database_id = "${db.database_id}"`);
        lines.push('');
      }
    }

    // R2 Buckets
    if (config.r2_buckets && config.r2_buckets.length > 0) {
      lines.push('# R2 Buckets');
      for (const r2 of config.r2_buckets) {
        lines.push('[[r2_buckets]]');
        lines.push(`binding = "${r2.binding}"`);
        lines.push(`bucket_name = "${r2.bucket_name}"`);
        lines.push('');
      }
    }

    // Hyperdrive
    if (config.hyperdrive && config.hyperdrive.length > 0) {
      lines.push('# Hyperdrive');
      for (const binding of config.hyperdrive) {
        lines.push('[[hyperdrive]]');
        lines.push(`binding = "${binding.binding}"`);
        lines.push(`id = "${binding.id}"`);
        lines.push('');
      }
    }

    // Queues
    if (
      (config.queues?.producers && config.queues.producers.length > 0) ||
      (config.queues?.consumers && config.queues.consumers.length > 0)
    ) {
      lines.push('# Cloudflare Queues');
      if (config.queues?.producers) {
        for (const producer of config.queues.producers) {
          lines.push('[[queues.producers]]');
          lines.push(`queue = "${producer.queue}"`);
          lines.push(`binding = "${producer.binding}"`);
          lines.push('');
        }
      }
      if (config.queues?.consumers) {
        for (const consumer of config.queues.consumers) {
          lines.push('[[queues.consumers]]');
          lines.push(`queue = "${consumer.queue}"`);
          if (consumer.max_batch_size !== undefined) {
            lines.push(`max_batch_size = ${consumer.max_batch_size}`);
          }
          if (consumer.max_batch_timeout !== undefined) {
            lines.push(`max_batch_timeout = ${consumer.max_batch_timeout}`);
          }
          if (consumer.max_retries !== undefined) {
            lines.push(`max_retries = ${consumer.max_retries}`);
          }
          if (consumer.dead_letter_queue) {
            lines.push(`dead_letter_queue = "${consumer.dead_letter_queue}"`);
          }
          lines.push('');
        }
      }
    }

    // Durable Objects
    if (config.durable_objects?.bindings && config.durable_objects.bindings.length > 0) {
      lines.push('# Durable Objects Bindings');
      for (const dob of config.durable_objects.bindings) {
        lines.push('[[durable_objects.bindings]]');
        lines.push(`name = "${dob.name}"`);
        lines.push(`class_name = "${dob.class_name}"`);
        if (dob.script_name) {
          lines.push(`script_name = "${dob.script_name}"`);
        }
        lines.push('');
      }
    }

    // Migrations
    if (config.migrations && config.migrations.length > 0) {
      lines.push('# Durable Objects Migrations');
      for (const migration of config.migrations) {
        lines.push('[[migrations]]');
        lines.push(`tag = "${migration.tag}"`);
        if (migration.new_sqlite_classes && migration.new_sqlite_classes.length > 0) {
          lines.push('new_sqlite_classes = [');
          for (const cls of migration.new_sqlite_classes) {
            lines.push(`  "${cls}",`);
          }
          lines.push(']');
        }
        lines.push('');
      }
    }

    // Environment variables
    if (Object.keys(config.vars).length > 0) {
      lines.push('# Environment Variables');
      lines.push('[vars]');
      for (const [key, value] of Object.entries(config.vars)) {
        if (value) {
          lines.push(`${key} = ${JSON.stringify(value)}`);
        }
      }
      lines.push('');
    }

    // Service Bindings
    if (config.services && config.services.length > 0) {
      lines.push('# Service Bindings');
      for (const svc of config.services) {
        lines.push('[[services]]');
        lines.push(`binding = "${svc.binding}"`);
        lines.push(`service = "${svc.service}"`);
        if (svc.entrypoint) {
          lines.push(`entrypoint = "${svc.entrypoint}"`);
        }
        if (svc.props) {
          lines.push(`props = ${serializeServiceProps(svc.props)}`);
        }
        lines.push('');
      }
    }

    // Routes
    if (config.routes && config.routes.length > 0) {
      lines.push('# Routes');
      for (const route of config.routes) {
        lines.push('[[routes]]');
        lines.push(`pattern = "${route.pattern}"`);
        if (route.zone_name) {
          lines.push(`zone_name = "${route.zone_name}"`);
        }
        if (route.custom_domain) {
          lines.push(`custom_domain = true`);
        }
        lines.push('');
      }
    }

    appendSendEmailBindings();
  }

  return lines.join('\n');
}

/**
 * Generate route configurations for custom domains
 */
export function generateRoutes(
  component: WorkerComponent,
  domain: string,
  zoneName: string
): Array<{ pattern: string; zone_name: string }> {
  const routes: Array<{ pattern: string; zone_name: string }> = [];

  switch (component) {
    case 'ar-auth':
      routes.push(
        { pattern: `${domain}/authorize*`, zone_name: zoneName },
        { pattern: `${domain}/flow/*`, zone_name: zoneName },
        { pattern: `${domain}/api/flow/*`, zone_name: zoneName },
        { pattern: `${domain}/par`, zone_name: zoneName },
        { pattern: `${domain}/session/check`, zone_name: zoneName },
        { pattern: `${domain}/as/*`, zone_name: zoneName },
        { pattern: `${domain}/api/auth/*`, zone_name: zoneName },
        { pattern: `${domain}/api/sessions/*`, zone_name: zoneName },
        { pattern: `${domain}/logout*`, zone_name: zoneName },
        { pattern: `${domain}/logged-out`, zone_name: zoneName },
        { pattern: `${domain}/auth/consent*`, zone_name: zoneName },
        { pattern: `${domain}/_internal/*`, zone_name: zoneName },
        // Admin initial setup routes (one-time use for first admin account creation)
        { pattern: `${domain}/admin-init-setup*`, zone_name: zoneName },
        { pattern: `${domain}/api/admin-init-setup/*`, zone_name: zoneName },
        // Admin passkey setup and login routes must go directly to ar-auth
        { pattern: `${domain}/api/admin/setup-token/*`, zone_name: zoneName },
        { pattern: `${domain}/api/admin/auth/*`, zone_name: zoneName }
      );
      break;
    case 'ar-token':
      routes.push(
        { pattern: `${domain}/token`, zone_name: zoneName },
        { pattern: `${domain}/revoke`, zone_name: zoneName },
        { pattern: `${domain}/introspect`, zone_name: zoneName },
        { pattern: `${domain}/device*`, zone_name: zoneName }
      );
      break;
    case 'ar-userinfo':
      routes.push(
        { pattern: `${domain}/userinfo`, zone_name: zoneName },
        { pattern: `${domain}/api/protected/customer-profiles/*`, zone_name: zoneName }
      );
      break;
    case 'ar-discovery':
      routes.push(
        { pattern: `${domain}/.well-known/openid-configuration`, zone_name: zoneName },
        { pattern: `${domain}/.well-known/jwks.json`, zone_name: zoneName },
        { pattern: `${domain}/.well-known/oauth-authorization-server`, zone_name: zoneName }
      );
      break;
    case 'ar-management':
      routes.push({ pattern: `${domain}/register`, zone_name: zoneName });
      break;
    case 'ar-saml':
      routes.push(
        { pattern: `${domain}/saml/*`, zone_name: zoneName },
        { pattern: `${domain}/idp/profile/SAML2/POST/SSO`, zone_name: zoneName },
        { pattern: `${domain}/idp/profile/SAML2/Redirect/SSO`, zone_name: zoneName },
        { pattern: `${domain}/idp/profile/SAML2/POST/SLO`, zone_name: zoneName },
        { pattern: `${domain}/idp/profile/SAML2/Redirect/SLO`, zone_name: zoneName }
      );
      break;
  }

  return routes;
}

// =============================================================================
// Wrangler Config Validation
// =============================================================================

export interface WranglerValidationResult {
  valid: boolean;
  mismatches: Array<{
    component: string;
    type: 'kv' | 'd1' | 'r2' | 'queue';
    binding: string;
    expected: string;
    actual: string;
  }>;
}

/**
 * Parse wrangler.toml and extract resource IDs for a specific environment
 */
export function parseWranglerToml(
  content: string,
  env: string
): {
  crons: string[];
  kv: Record<string, string>;
  d1: Record<string, string>;
  hyperdrive: Record<string, string>;
  r2: Record<string, string>;
  queueProducers: Record<string, string>;
  queueConsumers: string[];
} {
  const result = {
    crons: [] as string[],
    kv: {} as Record<string, string>,
    d1: {} as Record<string, string>,
    hyperdrive: {} as Record<string, string>,
    r2: {} as Record<string, string>,
    queueProducers: {} as Record<string, string>,
    queueConsumers: [] as string[],
  };
  const escapedEnv = escapeRegExp(env);

  // Parse the environment-scoped Cron Trigger list. Generated deployment configs always use a
  // single-line string array, which lets recovery compare the checked-in intent with Cloudflare's
  // provider state without accepting arbitrary TOML syntax.
  const cronRegex = new RegExp(
    `\\[env\\.${escapedEnv}\\.triggers\\]\\s*\\ncrons\\s*=\\s*\\[([^\\]]*)\\]`,
    'u'
  );
  const cronMatch = cronRegex.exec(content);
  if (cronMatch) {
    try {
      const values: unknown = JSON.parse(`[${cronMatch[1]}]`);
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
        throw new Error('wrangler_cron_trigger_invalid');
      }
      result.crons.push(...values);
    } catch (error) {
      if (error instanceof Error && error.message === 'wrangler_cron_trigger_invalid') throw error;
      throw new Error('wrangler_cron_trigger_invalid');
    }
  }

  // Parse KV namespaces: [[env.{env}.kv_namespaces]]
  const kvRegex = new RegExp(
    `\\[\\[env\\.${escapedEnv}\\.kv_namespaces\\]\\]\\s*\\nbinding\\s*=\\s*"([^"]+)"\\s*\\nid\\s*=\\s*"([^"]+)"`,
    'g'
  );
  let kvMatch;
  while ((kvMatch = kvRegex.exec(content)) !== null) {
    result.kv[kvMatch[1]] = kvMatch[2];
  }

  // Parse D1 databases: [[env.{env}.d1_databases]]
  const d1Regex = new RegExp(
    `\\[\\[env\\.${escapedEnv}\\.d1_databases\\]\\]\\s*\\nbinding\\s*=\\s*"([^"]+)"\\s*\\ndatabase_name\\s*=\\s*"[^"]+"\\s*\\ndatabase_id\\s*=\\s*"([^"]+)"`,
    'g'
  );
  let d1Match;
  while ((d1Match = d1Regex.exec(content)) !== null) {
    result.d1[d1Match[1]] = d1Match[2];
  }

  const hyperdriveRegex = new RegExp(
    `\\[\\[env\\.${escapedEnv}\\.hyperdrive\\]\\]\\s*\\nbinding\\s*=\\s*"([^"]+)"\\s*\\nid\\s*=\\s*"([^"]+)"`,
    'g'
  );
  let hyperdriveMatch;
  while ((hyperdriveMatch = hyperdriveRegex.exec(content)) !== null) {
    result.hyperdrive[hyperdriveMatch[1]] = hyperdriveMatch[2];
  }

  const r2Regex = new RegExp(
    `\\[\\[env\\.${escapedEnv}\\.r2_buckets\\]\\]\\s*\\nbinding\\s*=\\s*"([^"]+)"\\s*\\nbucket_name\\s*=\\s*"([^"]+)"`,
    'g'
  );
  let r2Match;
  while ((r2Match = r2Regex.exec(content)) !== null) {
    result.r2[r2Match[1]] = r2Match[2];
  }

  const queueProducerRegex = new RegExp(
    `\\[\\[env\\.${escapedEnv}\\.queues\\.producers\\]\\]\\s*\\nqueue\\s*=\\s*"([^"]+)"\\s*\\nbinding\\s*=\\s*"([^"]+)"`,
    'g'
  );
  let queueProducerMatch;
  while ((queueProducerMatch = queueProducerRegex.exec(content)) !== null) {
    result.queueProducers[queueProducerMatch[2]] = queueProducerMatch[1];
  }

  const queueConsumerRegex = new RegExp(
    `\\[\\[env\\.${escapedEnv}\\.queues\\.consumers\\]\\]\\s*\\nqueue\\s*=\\s*"([^"]+)"`,
    'g'
  );
  let queueConsumerMatch;
  while ((queueConsumerMatch = queueConsumerRegex.exec(content)) !== null) {
    result.queueConsumers.push(queueConsumerMatch[1]);
  }

  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate wrangler.toml files against lock file resource IDs
 */
export async function validateWranglerConfigs(
  rootDir: string,
  env: string,
  lockResourceIds: ResourceIds,
  components: WorkerComponent[]
): Promise<WranglerValidationResult> {
  const { readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');

  const result: WranglerValidationResult = { valid: true, mismatches: [] };
  const expectedPluginResources = lockResourceIds.pluginRunnerResources;
  const expectedPluginResourceMap = new Map(
    (expectedPluginResources ?? []).map((resource) => [
      `${resource.kind}:${resource.binding}`,
      resource,
    ])
  );

  const recordPluginResourceMismatch = (
    component: WorkerComponent,
    type: 'kv' | 'd1' | 'r2',
    binding: string,
    expected: string,
    actual: string
  ) => {
    result.valid = false;
    result.mismatches.push({ component, type, binding, expected, actual });
  };

  for (const component of components) {
    const tomlPath = join(rootDir, 'packages', component, 'wrangler.toml');
    if (!existsSync(tomlPath)) {
      continue;
    }

    const content = await readFile(tomlPath, 'utf-8');
    const parsed = parseWranglerToml(content, env);

    const parsedPluginResources = [
      ...Object.entries(parsed.d1).map(([binding, id]) => ({
        binding,
        id,
        kind: 'd1' as const,
        type: 'd1' as const,
        pattern: /^PRES_D1_[A-F0-9]{24}$/u,
      })),
      ...Object.entries(parsed.kv).map(([binding, id]) => ({
        binding,
        id,
        kind: 'kv_namespace' as const,
        type: 'kv' as const,
        pattern: /^PRES_KV_[A-F0-9]{24}$/u,
      })),
      ...Object.entries(parsed.r2).map(([binding, id]) => ({
        binding,
        id,
        kind: 'r2_bucket' as const,
        type: 'r2' as const,
        pattern: /^PRES_R2_[A-F0-9]{24}$/u,
      })),
    ].filter((binding) => binding.binding.startsWith('PRES_'));

    for (const binding of parsedPluginResources) {
      if (component !== 'ar-plugin-runner' || !binding.pattern.test(binding.binding)) {
        recordPluginResourceMismatch(
          component,
          binding.type,
          binding.binding,
          'valid ar-plugin-runner PRES resource binding',
          binding.id
        );
        continue;
      }
      if (expectedPluginResources === undefined) continue;
      const expected = expectedPluginResourceMap.get(`${binding.kind}:${binding.binding}`);
      const expectedId =
        expected?.kind === 'r2_bucket' ? expected.providerName : expected?.providerResourceId;
      if (!expectedId || binding.id !== expectedId) {
        recordPluginResourceMismatch(
          component,
          binding.type,
          binding.binding,
          expectedId ?? 'not present in Control deployable desired state',
          binding.id
        );
      }
    }

    if (component === 'ar-plugin-runner' && expectedPluginResources !== undefined) {
      const parsedKeys = new Set(
        parsedPluginResources.map((binding) => `${binding.kind}:${binding.binding}`)
      );
      for (const expected of expectedPluginResources) {
        if (parsedKeys.has(`${expected.kind}:${expected.binding}`)) continue;
        recordPluginResourceMismatch(
          component,
          expected.kind === 'kv_namespace' ? 'kv' : expected.kind === 'r2_bucket' ? 'r2' : 'd1',
          expected.binding,
          expected.kind === 'r2_bucket' ? expected.providerName : expected.providerResourceId,
          'missing'
        );
      }
    }

    // Check KV namespaces
    for (const [binding, id] of Object.entries(parsed.kv)) {
      const expected = lockResourceIds.kv[binding]?.id;
      if (expected && id !== expected) {
        result.valid = false;
        result.mismatches.push({
          component,
          type: 'kv',
          binding,
          expected,
          actual: id,
        });
      }
    }

    // Check D1 databases
    for (const [binding, id] of Object.entries(parsed.d1)) {
      const expected = lockResourceIds.d1[binding]?.id;
      if (expected && id !== expected) {
        result.valid = false;
        result.mismatches.push({
          component,
          type: 'd1',
          binding,
          expected,
          actual: id,
        });
      }
    }

    for (const [binding, bucketName] of Object.entries(parsed.r2)) {
      const expected = lockResourceIds.r2?.[binding]?.name;
      if (expected && bucketName !== expected) {
        result.valid = false;
        result.mismatches.push({
          component,
          type: 'r2',
          binding,
          expected,
          actual: bucketName,
        });
      }
    }

    for (const [binding, queueName] of Object.entries(parsed.queueProducers)) {
      const expected = lockResourceIds.queues?.[binding]?.name;
      if (expected && queueName !== expected) {
        result.valid = false;
        result.mismatches.push({
          component,
          type: 'queue',
          binding,
          expected,
          actual: queueName,
        });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// UI Workers wrangler.toml generation
// ---------------------------------------------------------------------------

export interface UiWorkersWranglerOptions {
  component: 'ar-login-ui' | 'ar-admin-ui';
  env: string;
  needsProxy: boolean;
  workersDev?: boolean;
  routes?: Array<{ pattern: string; zone_name?: string; custom_domain?: boolean }>;
  vars?: Record<string, string | undefined>;
}

/**
 * Generate wrangler.toml content for a Workers static-assets UI component.
 *
 * When needsProxy=true, includes a [[services]] binding so the UI Worker
 * can reach ar-router via Service Binding (no workers.dev needed, ITP-safe).
 */
export function generateUiWorkersWranglerConfig(options: UiWorkersWranglerOptions): string {
  const { component, env, needsProxy, workersDev = true, routes = [], vars = {} } = options;
  const workerName = `${env}-ar-router`;
  const uiWorkerName = `${env}-${component}`;

  const lines = [
    `# Auto-generated by @authrim/setup - do not edit manually`,
    `name = "${uiWorkerName}"`,
    `workers_dev = ${workersDev}`,
    `compatibility_date = "2024-01-01"`,
    `compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]`,
    `main = ".svelte-kit/cloudflare/_worker.js"`,
    ``,
    `[assets]`,
    `directory = ".svelte-kit/cloudflare"`,
    `binding = "ASSETS"`,
  ];
  if (component === 'ar-login-ui') {
    lines.push(`run_worker_first = ["/account", "/account/*"]`);
  }

  const definedVars = Object.entries(vars).filter((entry): entry is [string, string] => {
    const [, value] = entry;
    return typeof value === 'string' && value.length > 0;
  });
  if (definedVars.length > 0) {
    lines.push(``, `[vars]`);
    for (const [key, value] of definedVars) {
      lines.push(`${key} = ${JSON.stringify(value)}`);
    }
  }

  if (routes.length > 0) {
    for (const route of routes) {
      lines.push(``, `[[routes]]`);
      lines.push(`pattern = ${JSON.stringify(route.pattern)}`);
      if (route.zone_name) {
        lines.push(`zone_name = ${JSON.stringify(route.zone_name)}`);
      }
      if (route.custom_domain) {
        lines.push(`custom_domain = true`);
      }
    }
  }

  if (needsProxy) {
    lines.push(``, `[[services]]`);
    lines.push(`binding = "AR_ROUTER"`);
    lines.push(`service = "${workerName}"`);
    if (component === 'ar-login-ui') {
      lines.push(`entrypoint = "LoginUiBackendEntrypoint"`);
    }
  }

  return lines.join('\n') + '\n';
}
