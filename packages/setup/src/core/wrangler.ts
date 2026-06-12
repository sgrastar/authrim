/**
 * Wrangler Configuration Generator
 *
 * Generates wrangler.toml files for each component based on environment
 * configuration and resource IDs from authrim-lock.json.
 */

import type { AuthrimConfig } from './config.js';
import type { AuthrimLock } from './lock.js';
import { extractZoneName } from './cloudflare.js';
import {
  getWorkerName,
  getDOScriptName,
  DURABLE_OBJECTS,
  D1_DATABASES,
  type WorkerComponent,
  type KVNamespace,
} from './naming.js';
import { getSecretNamesForWorker } from './secrets.js';
import { classifyUiApiSite, type UiApiSiteClassification } from './site-classifier.js';
import { isTenantDatabaseBinding } from './tenant-database.js';

// =============================================================================
// Types
// =============================================================================

export interface ResourceIds {
  d1: Record<string, { id: string; name: string }>;
  kv: Record<string, { id: string; name: string }>;
  queues?: Record<string, { id: string; name: string }>;
  r2?: Record<string, { name: string }>;
}

export function buildResourceIdsFromLock(lock: AuthrimLock): ResourceIds {
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
  };
}

export interface WranglerConfig {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  workers_dev: boolean;
  placement?: { mode: string };
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
  services?: Array<{ binding: string; service: string }>;
  send_email?: Array<{
    name: string;
    destination_address?: string;
    allowed_destination_addresses?: string[];
    allowed_sender_addresses?: string[];
  }>;
}

export interface GenerateWranglerConfigOptions {
  includeDurableObjectMigrations?: boolean;
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
  return component !== 'ar-router';
}

function collectD1DatabaseBindings(
  component: WorkerComponent,
  resourceIds: ResourceIds
): Array<{ binding: string; database_name: string; database_id: string }> {
  if (component === 'ar-router' || component === 'ar-async') {
    return [];
  }

  const builtins = D1_DATABASES.map((db) => ({
    binding: db.binding,
    database_name: resourceIds.d1[db.binding]?.name || '',
    database_id: resourceIds.d1[db.binding]?.id || '',
  })).filter((db) => db.database_id);

  const tenantDatabases = Object.entries(resourceIds.d1)
    .filter(([binding]) => isTenantDatabaseBinding(binding))
    .map(([binding, resource]) => ({
      binding,
      database_name: resource.name,
      database_id: resource.id,
    }))
    .sort((left, right) => left.binding.localeCompare(right.binding));

  return [...builtins, ...tenantDatabases];
}

// =============================================================================
// Component-specific KV Requirements
// =============================================================================

const COMPONENT_KV_BINDINGS: Record<WorkerComponent, KVNamespace[]> = {
  'ar-lib-core': ['AUTHRIM_CONFIG'],
  'ar-discovery': ['AUTHRIM_CONFIG'],
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
  'ar-router': ['AUTHRIM_CONFIG'],
  'ar-async': ['AUTHRIM_CONFIG'],
  'ar-policy': ['REBAC_CACHE', 'AUTHRIM_CONFIG'],
  'ar-saml': ['SETTINGS', 'AUTHRIM_CONFIG', 'STATE_STORE', 'TENANT_RUNTIME_REGISTRY'],
  'ar-bridge': ['SETTINGS', 'AUTHRIM_CONFIG', 'TENANT_RUNTIME_REGISTRY'],
  'ar-vc': ['AUTHRIM_CONFIG', 'TENANT_RUNTIME_REGISTRY'],
};

// =============================================================================
// Component-specific DO Requirements
// =============================================================================

const COMPONENT_DO_BINDINGS: Record<WorkerComponent, string[]> = {
  'ar-lib-core': [], // Defines DOs, doesn't reference external
  'ar-discovery': ['KEY_MANAGER', 'VERSION_MANAGER'],
  'ar-auth': [
    'KEY_MANAGER',
    'SESSION_STORE',
    'AUTH_CODE_STORE',
    'CHALLENGE_STORE',
    'RATE_LIMITER',
    'PAR_REQUEST_STORE',
    'VERSION_MANAGER',
    'FLOW_STATE_STORE',
  ],
  'ar-token': [
    'KEY_MANAGER',
    'SESSION_STORE',
    'AUTH_CODE_STORE',
    'REFRESH_TOKEN_ROTATOR',
    'RATE_LIMITER',
    'DPOP_JTI_STORE',
    'TOKEN_REVOCATION_STORE',
    'DEVICE_CODE_STORE',
    'CIBA_REQUEST_STORE',
    'VERSION_MANAGER',
  ],
  'ar-userinfo': [
    'KEY_MANAGER',
    'SESSION_STORE',
    'RATE_LIMITER',
    'DPOP_JTI_STORE',
    'TOKEN_REVOCATION_STORE',
    'VERSION_MANAGER',
  ],
  'ar-management': [
    'KEY_MANAGER',
    'REFRESH_TOKEN_ROTATOR',
    'RATE_LIMITER',
    'SESSION_STORE',
    'TOKEN_REVOCATION_STORE',
    'VERSION_MANAGER',
    'CHALLENGE_STORE',
  ],
  'ar-router': ['VERSION_MANAGER'],
  'ar-async': ['DEVICE_CODE_STORE', 'CIBA_REQUEST_STORE', 'VERSION_MANAGER'],
  'ar-policy': ['PERMISSION_CHANGE_HUB', 'VERSION_MANAGER'],
  'ar-saml': [
    'KEY_MANAGER',
    'SAML_REQUEST_STORE',
    'SAML_AGGREGATE_METADATA_STORE',
    'SESSION_STORE',
    'CHALLENGE_STORE',
    'VERSION_MANAGER',
  ],
  'ar-bridge': ['SESSION_STORE', 'CHALLENGE_STORE', 'VERSION_MANAGER'],
  'ar-vc': ['KEY_MANAGER', 'VERSION_MANAGER'],
};

// =============================================================================
// Component Entry Points
// =============================================================================

const COMPONENT_ENTRY_POINTS: Record<WorkerComponent, string> = {
  'ar-lib-core': 'src/durable-objects/index.ts',
  'ar-discovery': 'src/index.ts',
  'ar-auth': 'src/index.ts',
  'ar-token': 'src/index.ts',
  'ar-userinfo': 'src/index.ts',
  'ar-management': 'src/index.ts',
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
    compatibility_date: '2024-09-23',
    compatibility_flags: ['nodejs_compat'],
    // With Service Binding, UI Workers can reach ar-router internally without workers.dev.
    // Disable workers.dev when a custom API domain is set to avoid dual public endpoints.
    workers_dev: !config.urls?.api?.custom,
    vars: generateEnvVars(component, config, workersSubdomain),
  };

  // Placement (off for better performance with sharded DOs)
  wranglerConfig.placement = { mode: 'off' };

  if (component === 'ar-bridge') {
    wranglerConfig.triggers = {
      crons: ['*/15 * * * *'],
    };
  }

  if (component === 'ar-management') {
    wranglerConfig.triggers = {
      crons: ['0 */6 * * *'],
    };
  }

  // KV Namespaces
  const kvBindings = COMPONENT_KV_BINDINGS[component];
  if (kvBindings.length > 0) {
    wranglerConfig.kv_namespaces = kvBindings
      .filter((binding) => resourceIds.kv[binding])
      .map((binding) => ({
        binding,
        id: resourceIds.kv[binding].id,
      }));
  }

  // D1 Databases (most components need shared D1; tenant-d1 adds generated TDB_* bindings)
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
    if (doBindings.length > 0) {
      const scriptName = getDOScriptName(env);
      wranglerConfig.durable_objects = {
        bindings: doBindings.map((doName) => {
          const doDef = DURABLE_OBJECTS.find((d) => d.name === doName);
          return {
            name: doName,
            class_name: doDef?.className || doName,
            script_name: scriptName,
          };
        }),
      };
    }
  }

  // R2 Buckets — add bindings whenever provisioned resources are available
  if (resourceIds.r2 && Object.keys(resourceIds.r2).length > 0) {
    const r2Buckets: Array<{ binding: string; bucket_name: string }> = [];

    if (component === 'ar-auth' || component === 'ar-management') {
      r2Buckets.push({
        binding: 'AVATARS',
        bucket_name: resourceIds.r2['AVATARS']?.name || `${env}-authrim-avatars`,
      });
    }

    if (
      component === 'ar-auth' ||
      component === 'ar-token' ||
      component === 'ar-async' ||
      component === 'ar-saml' ||
      component === 'ar-vc' ||
      component === 'ar-management'
    ) {
      r2Buckets.push({
        binding: 'DIAGNOSTIC_LOGS',
        bucket_name: resourceIds.r2['DIAGNOSTIC_LOGS']?.name || `${env}-diagnostic-logs`,
      });
      r2Buckets.push({
        binding: 'AUDIT_ARCHIVE',
        bucket_name: resourceIds.r2['AUDIT_ARCHIVE']?.name || `${env}-audit-archive`,
      });
    }

    if (component === 'ar-management') {
      r2Buckets.push({
        binding: 'IMPORT_ARTIFACTS',
        bucket_name: resourceIds.r2['IMPORT_ARTIFACTS']?.name || `${env}-import-artifacts`,
      });
      r2Buckets.push({
        binding: 'EXPORT_ARTIFACTS',
        bucket_name: resourceIds.r2['EXPORT_ARTIFACTS']?.name || `${env}-export-artifacts`,
      });
      r2Buckets.push({
        binding: 'SENSITIVE_DETAILS',
        bucket_name: resourceIds.r2['SENSITIVE_DETAILS']?.name || `${env}-sensitive-details`,
      });
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

  if (
    config.features.email?.provider === 'cloudflare' &&
    (component === 'ar-auth' || component === 'ar-management')
  ) {
    wranglerConfig.send_email = [{ name: 'EMAIL' }];
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
  const loginUiUsesApiDomain = config.urls?.loginUi?.sameAsApi === true || multiTenantEnabled;

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
  // UI_URL: when sameAsApi=true, UI is proxied through the API domain
  const apiUrlForUi = normalizeWorkersDevUrl(
    config.urls?.api?.custom || config.urls?.api?.auto || '',
    workersSubdomain
  );
  const uiUrl = loginUiUsesApiDomain
    ? apiUrlForUi
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
  const adminUiApiMode = getAdminUiApiMode(apiUrlForUi, adminUiUrl, multiTenantBaseDomain);
  const profileDefaults = config.profiles?.defaults ?? {
    storage: 'builtin:storage:shared-d1',
    audit: 'builtin:audit:standard',
    residency: 'builtin:residency:default',
  };
  const profileRegistryBackend = config.profiles?.registry?.backend ?? 'kv';
  const profileAwareComponents: WorkerComponent[] = [
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
    'ar-router',
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
  }

  if (component === 'ar-auth' || component === 'ar-management' || component === 'ar-saml') {
    vars['UI_URL'] = uiUrl;
    vars['LOGIN_UI_ENABLED'] = config.components.loginUi ? 'true' : 'false';
  }

  if (component === 'ar-auth' || component === 'ar-management') {
    vars['ADMIN_UI_ENABLED'] = config.components.adminUi ? 'true' : 'false';
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
    const loginUiSameOrigin = loginUiUsesApiDomain;
    vars['COOKIE_SAME_SITE'] = loginUiSameOrigin ? 'Lax' : 'None';

    vars['ADMIN_UI_URL'] = adminUiUrl;
    vars['ADMIN_UI_API_MODE'] = adminUiApiMode;
    vars['ADMIN_COOKIE_SAME_SITE'] = 'Lax';
  }

  // ar-management also needs cookie configuration for admin sessions
  if (component === 'ar-management') {
    vars['ADMIN_UI_URL'] = adminUiUrl;
    vars['ADMIN_UI_API_MODE'] = adminUiApiMode;
    vars['ADMIN_COOKIE_SAME_SITE'] = 'Lax';
    vars['SAML_ENABLED'] = 'true';
    vars['ASYNC_ENABLED'] = 'true';
    vars['VC_ENABLED'] = 'true';
  }

  if (component === 'ar-discovery') {
    vars['ASYNC_ENABLED'] = 'true';
  }

  if (profileAwareComponents.includes(component)) {
    vars['PROFILE_REGISTRY_BACKEND'] = profileRegistryBackend;
    vars['DEFAULT_STORAGE_PROFILE_ID'] = profileDefaults.storage;
    vars['DEFAULT_AUDIT_PROFILE_ID'] = profileDefaults.audit;
    vars['DEFAULT_RESIDENCY_PROFILE_ID'] = profileDefaults.residency;
  }

  // OIDC settings
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
  }

  // Security settings
  vars['ENABLE_HTTP_REDIRECT'] = 'false';
  vars['ENABLE_OPEN_REGISTRATION'] = 'false';

  // Sharding configuration
  if (component === 'ar-lib-core' || component === 'ar-auth' || component === 'ar-token') {
    vars['AUTHRIM_CODE_SHARDS'] = config.sharding.authCodeShards.toString();
    vars['AUTHRIM_SESSION_SHARDS'] = (config.sharding.sessionShards ?? 4).toString();
    vars['AUTHRIM_CHALLENGE_SHARDS'] = (config.sharding.challengeShards ?? 4).toString();
  }

  const componentSecrets = getSecretNamesForWorker(component);
  if (componentSecrets.includes('KEY_MANAGER_SECRET')) {
    vars['KEY_MANAGER_SECRET'] = ''; // Set via secret
  }
  if (componentSecrets.includes('VERSION_MANAGER_SECRET')) {
    vars['VERSION_MANAGER_SECRET'] = ''; // Set via secret
  }
  if (componentSecrets.includes('ADMIN_API_SECRET')) {
    vars['ADMIN_API_SECRET'] = ''; // Set via secret
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

    const loginProxyEnabled = config.urls?.loginUi?.sameAsApi === true || multiTenantEnabled;
    vars['ENABLE_LOGIN_UI_PROXY'] = loginProxyEnabled ? 'true' : 'false';
    if (uiUrl) {
      vars['LOGIN_UI_URL'] = uiUrl;
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
  }

  // CORS allowed origins for workers that handle cross-origin requests.
  // This is the setup-side web_origin_registry -> ALLOWED_ORIGINS materialization boundary.
  // Workers.dev URLs are normalized to correct format: {name}.{subdomain}.workers.dev
  if (['ar-auth', 'ar-management', 'ar-router', 'ar-saml'].includes(component)) {
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
          lines.push(`${key} = "${value}"`);
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

    // Placement
    if (config.placement) {
      lines.push('[placement]');
      lines.push(`mode = "${config.placement.mode}"`);
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
          lines.push(`${key} = "${value}"`);
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
  kv: Record<string, string>;
  d1: Record<string, string>;
  hyperdrive: Record<string, string>;
  r2: Record<string, string>;
  queueProducers: Record<string, string>;
  queueConsumers: string[];
} {
  const result = {
    kv: {} as Record<string, string>,
    d1: {} as Record<string, string>,
    hyperdrive: {} as Record<string, string>,
    r2: {} as Record<string, string>,
    queueProducers: {} as Record<string, string>,
    queueConsumers: [] as string[],
  };
  const escapedEnv = escapeRegExp(env);

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

  for (const component of components) {
    const tomlPath = join(rootDir, 'packages', component, 'wrangler.toml');
    if (!existsSync(tomlPath)) {
      continue;
    }

    const content = await readFile(tomlPath, 'utf-8');
    const parsed = parseWranglerToml(content, env);

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
  }

  return lines.join('\n') + '\n';
}
