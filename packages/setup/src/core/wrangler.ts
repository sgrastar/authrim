/**
 * Wrangler Configuration Generator
 *
 * Generates wrangler.toml files for each component based on environment
 * configuration and resource IDs from authrim-lock.json.
 */

import type { AuthrimConfig } from './config.js';
import { extractZoneName } from './cloudflare.js';
import {
  getWorkerName,
  getDOScriptName,
  DURABLE_OBJECTS,
  D1_DATABASES,
  type WorkerComponent,
  type KVNamespace,
} from './naming.js';

// =============================================================================
// Types
// =============================================================================

export interface ResourceIds {
  d1: Record<string, { id: string; name: string }>;
  kv: Record<string, { id: string; name: string }>;
  queues?: Record<string, { id: string; name: string }>;
  r2?: Record<string, { name: string }>;
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
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
  durable_objects?: {
    bindings: Array<{ name: string; class_name: string; script_name?: string }>;
  };
  migrations?: Array<{ tag: string; new_sqlite_classes?: string[] }>;
  vars: Record<string, string>;
  routes?: Array<{ pattern: string; zone_name?: string; custom_domain?: boolean }>;
  queues?: {
    producers?: Array<{ queue: string; binding: string }>;
  };
  services?: Array<{ binding: string; service: string }>;
}

// =============================================================================
// Component-specific KV Requirements
// =============================================================================

const COMPONENT_KV_BINDINGS: Record<WorkerComponent, KVNamespace[]> = {
  'ar-lib-core': ['AUTHRIM_CONFIG'],
  'ar-discovery': ['AUTHRIM_CONFIG'],
  'ar-auth': ['CLIENTS_CACHE', 'SETTINGS', 'USER_CACHE', 'CONSENT_CACHE', 'AUTHRIM_CONFIG'],
  'ar-token': ['CLIENTS_CACHE', 'SETTINGS', 'USER_CACHE', 'REBAC_CACHE', 'AUTHRIM_CONFIG'],
  'ar-userinfo': ['CLIENTS_CACHE', 'USER_CACHE', 'AUTHRIM_CONFIG'],
  'ar-management': [
    'CLIENTS_CACHE',
    'SETTINGS',
    'USER_CACHE',
    'INITIAL_ACCESS_TOKENS',
    'AUTHRIM_CONFIG',
  ],
  'ar-router': ['AUTHRIM_CONFIG'],
  'ar-async': ['AUTHRIM_CONFIG'],
  'ar-policy': ['REBAC_CACHE', 'AUTHRIM_CONFIG'],
  'ar-saml': ['SETTINGS', 'AUTHRIM_CONFIG'],
  'ar-bridge': ['SETTINGS', 'AUTHRIM_CONFIG'],
  'ar-vc': ['AUTHRIM_CONFIG'],
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
  'ar-saml': ['KEY_MANAGER', 'SAML_REQUEST_STORE', 'SESSION_STORE', 'VERSION_MANAGER'],
  'ar-bridge': ['SESSION_STORE', 'VERSION_MANAGER'],
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

/**
 * Derive CORS allowed origins from config URLs
 *
 * Includes:
 * - API origin (router) - needed for admin-init-setup WebAuthn operations
 * - LoginUI origin - for cross-origin requests from login UI
 * - AdminUI origin - for cross-origin requests from admin UI
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
  // When sameAsApi=true, the actual origin is the API domain (UI is proxied)
  const adminUiUrl = config.urls?.adminUi?.sameAsApi
    ? apiUrl
    : config.urls?.adminUi?.custom || config.urls?.adminUi?.auto;
  if (adminUiUrl) {
    addOriginWithSubdomain(origins, adminUiUrl, workersSubdomain);
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
  workersSubdomain?: string
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
    // With Service Binding, Pages can reach ar-router internally without workers.dev.
    // Disable workers.dev when a custom API domain is set to avoid dual public endpoints.
    workers_dev: !config.urls?.api?.custom,
    vars: generateEnvVars(component, config, workersSubdomain),
  };

  // Placement (off for better performance with sharded DOs)
  wranglerConfig.placement = { mode: 'off' };

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

  // D1 Databases (most components need both)
  if (component !== 'ar-router' && component !== 'ar-async') {
    wranglerConfig.d1_databases = D1_DATABASES.map((db) => ({
      binding: db.binding,
      database_name: resourceIds.d1[db.binding]?.name || '',
      database_id: resourceIds.d1[db.binding]?.id || '',
    })).filter((db) => db.database_id);
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

    // Migrations for ar-lib-core
    wranglerConfig.migrations = generateDOMigrations();
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
    }

    if (r2Buckets.length > 0) {
      wranglerConfig.r2_buckets = r2Buckets;
    }
  }

  // Queues (optional)
  if (config.features.queue?.enabled && resourceIds.queues) {
    if (component === 'ar-auth' || component === 'ar-token') {
      wranglerConfig.queues = {
        producers: [
          {
            queue: resourceIds.queues['AUDIT_QUEUE']?.name || `${env}-audit-queue`,
            binding: 'AUDIT_QUEUE',
          },
        ],
      };
    }
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

    // Optional services (only if enabled in config)
    if (config.components.bridge) {
      services.push({ binding: 'EXTERNAL_IDP', service: `${env}-ar-bridge` });
    }
    if (config.components.policy) {
      services.push({ binding: 'POLICY_SERVICE', service: `${env}-ar-policy` });
    }
    if (config.components.async) {
      services.push({ binding: 'OP_ASYNC', service: `${env}-ar-async` });
    }
    if (config.components.saml) {
      services.push({ binding: 'OP_SAML', service: `${env}-ar-saml` });
    }
    if (config.components.vc) {
      services.push({ binding: 'OP_VC', service: `${env}-ar-vc` });
    }

    wranglerConfig.services = services;

    // Routes / Custom Domain Binding for ar-router (catch-all)
    if (config.urls?.api?.custom) {
      try {
        const customUrl = new URL(config.urls.api.custom);
        const hostname = customUrl.hostname;
        const zoneName = extractZoneName(hostname);
        if (config.urls?.api?.customDomainBinding) {
          // In multi-tenant mode, the naked domain can use a custom domain binding, but
          // tenant subdomains still need wildcard route matching.
          if (multiTenantEnabled) {
            wranglerConfig.routes = [
              { pattern: hostname, custom_domain: true },
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
  // special-case routing (e.g. /api/auth/login-methods, /api/admin/setup-token/*)
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

  // Determine issuer URL
  // In multi-tenant mode with BASE_DOMAIN: issuer is dynamically built from {tenant}.{baseDomain}
  // Otherwise: use workers.dev or custom API domain
  let issuerUrl: string;
  if (multiTenantEnabled) {
    // Multi-tenant mode: use BASE_DOMAIN (ISSUER_URL is not used, kept for fallback)
    issuerUrl = config.urls?.api?.auto || '';
  } else {
    // Single-tenant or workers.dev mode: use explicit issuer URL
    issuerUrl = config.urls?.api?.custom || config.urls?.api?.auto || '';
  }
  // UI_URL: when sameAsApi=true, UI is proxied through the API domain
  const apiUrlForUi = config.urls?.api?.custom || config.urls?.api?.auto || '';
  const uiUrl = config.urls?.loginUi?.sameAsApi
    ? apiUrlForUi
    : config.urls?.loginUi?.custom || config.urls?.loginUi?.auto || issuerUrl;

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
  if (
    component === 'ar-auth' ||
    component === 'ar-management' ||
    component === 'ar-router' ||
    component === 'ar-discovery'
  ) {
    vars['DEFAULT_TENANT_ID'] = config.tenant?.name || 'default';

    // User ID format (nanoid or uuid)
    vars['USER_ID_FORMAT'] = config.tenant?.userIdFormat || 'nanoid';

    if (multiTenantEnabled) {
      vars['BASE_DOMAIN'] = multiTenantBaseDomain;

      if (config.tenant.primaryTenant) {
        vars['PRIMARY_TENANT_ID'] = config.tenant.primaryTenant;
      }

      // Naked domain as issuer (use naked domain instead of tenant subdomain)
      if (config.tenant.nakedDomain) {
        vars['NAKED_DOMAIN_AS_ISSUER'] = 'true';
      }
    }
  }

  if (component === 'ar-auth' || component === 'ar-management') {
    vars['UI_URL'] = uiUrl;
    vars['LOGIN_UI_ENABLED'] = config.components.loginUi ? 'true' : 'false';
    vars['ADMIN_UI_ENABLED'] = config.components.adminUi ? 'true' : 'false';
  }

  if (component === 'ar-auth') {
    vars['ENABLE_CONFORMANCE_MODE'] = 'false';

    // Cookie SameSite configuration based on origin relationship
    // If UI is served from same domain as API (via proxy), use 'Lax' (more secure)
    // If UI is on different domain, use 'None' (required for cross-origin)
    const loginUiSameOrigin = config.urls?.loginUi?.sameAsApi === true;
    vars['COOKIE_SAME_SITE'] = loginUiSameOrigin ? 'Lax' : 'None';

    // Admin UI URL and cookie configuration
    const adminUiUrl = config.urls?.adminUi?.sameAsApi
      ? apiUrlForUi
      : config.urls?.adminUi?.custom || config.urls?.adminUi?.auto || issuerUrl;
    vars['ADMIN_UI_URL'] = adminUiUrl;
    const adminUiSameOrigin = config.urls?.adminUi?.sameAsApi === true;
    vars['ADMIN_COOKIE_SAME_SITE'] = adminUiSameOrigin ? 'Lax' : 'None';
  }

  // ar-management also needs cookie configuration for admin sessions
  if (component === 'ar-management') {
    // Admin UI URL and cookie configuration (same logic as ar-auth)
    const adminUiUrl = config.urls?.adminUi?.sameAsApi
      ? apiUrlForUi
      : config.urls?.adminUi?.custom || config.urls?.adminUi?.auto || issuerUrl;
    vars['ADMIN_UI_URL'] = adminUiUrl;
    const adminUiSameOrigin = config.urls?.adminUi?.sameAsApi === true;
    vars['ADMIN_COOKIE_SAME_SITE'] = adminUiSameOrigin ? 'Lax' : 'None';
    vars['SAML_ENABLED'] = config.components.saml ? 'true' : 'false';
    vars['ASYNC_ENABLED'] = config.components.async ? 'true' : 'false';
    vars['VC_ENABLED'] = config.components.vc ? 'true' : 'false';
  }

  if (component === 'ar-discovery') {
    vars['ASYNC_ENABLED'] = config.components.async ? 'true' : 'false';
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
  // Flow Engine sharding (for ar-auth only)
  if (component === 'ar-auth') {
    vars['AUTHRIM_FLOW_STATE_SHARDS'] = (config.sharding.flowStateShards ?? 32).toString();
  }

  // Secrets placeholders (will be set via wrangler secret put)
  // KEY_MANAGER_SECRET is needed by workers that access KeyManager DO
  const needsKeyManagerSecret = [
    'ar-lib-core',
    'ar-auth',
    'ar-token',
    'ar-userinfo',
    'ar-discovery',
    'ar-management',
    'ar-saml',
  ];
  // ADMIN_API_SECRET is needed by workers that expose Admin API endpoints
  const needsAdminApiSecret = ['ar-lib-core', 'ar-auth', 'ar-token', 'ar-management'];

  if (needsKeyManagerSecret.includes(component)) {
    vars['KEY_MANAGER_SECRET'] = ''; // Set via secret
  }
  if (needsAdminApiSecret.includes(component)) {
    vars['ADMIN_API_SECRET'] = ''; // Set via secret
  }

  // ar-router: UI proxy configuration
  // When sameAsApi=true, the router proxies /admin/* and /login/* to the Pages projects
  if (component === 'ar-router') {
    const adminSameAsApi = config.urls?.adminUi?.sameAsApi === true;
    vars['ENABLE_ADMIN_UI_PROXY'] = adminSameAsApi ? 'true' : 'false';
    if (adminSameAsApi) {
      const adminPagesUrl = config.urls?.adminUi?.auto || config.urls?.adminUi?.custom || '';
      if (adminPagesUrl) {
        vars['AR_ADMIN_UI_URL'] = adminPagesUrl;
      }
    }

    const loginSameAsApi = config.urls?.loginUi?.sameAsApi === true;
    vars['ENABLE_LOGIN_UI_PROXY'] = loginSameAsApi ? 'true' : 'false';
    if (loginSameAsApi) {
      const loginPagesUrl = config.urls?.loginUi?.auto || config.urls?.loginUi?.custom || '';
      if (loginPagesUrl) {
        vars['AR_LOGIN_UI_URL'] = loginPagesUrl;
      }
    }
  }

  // CORS allowed origins for workers that handle cross-origin requests
  // Workers.dev URLs are normalized to correct format: {name}.{subdomain}.workers.dev
  if (['ar-auth', 'ar-management', 'ar-router'].includes(component)) {
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

    // Queues
    if (config.queues?.producers && config.queues.producers.length > 0) {
      lines.push('# Cloudflare Queues');
      for (const producer of config.queues.producers) {
        lines.push(`[[env.${envName}.queues.producers]]`);
        lines.push(`queue = "${producer.queue}"`);
        lines.push(`binding = "${producer.binding}"`);
        lines.push('');
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

    // Queues
    if (config.queues?.producers && config.queues.producers.length > 0) {
      lines.push('# Cloudflare Queues');
      for (const producer of config.queues.producers) {
        lines.push('[[queues.producers]]');
        lines.push(`queue = "${producer.queue}"`);
        lines.push(`binding = "${producer.binding}"`);
        lines.push('');
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
      routes.push({ pattern: `${domain}/userinfo`, zone_name: zoneName });
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
    type: 'kv' | 'd1';
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
): { kv: Record<string, string>; d1: Record<string, string> } {
  const result = { kv: {} as Record<string, string>, d1: {} as Record<string, string> };

  // Find the [env.{env}] section
  const envSectionRegex = new RegExp(`\\[env\\.${env}\\]`, 'g');
  const envStart = content.search(envSectionRegex);
  if (envStart === -1) {
    return result;
  }

  // Find the next [env.*] section or end of file
  const nextEnvMatch = content.slice(envStart + 1).search(/\[env\.[^\]]+\]/);
  const envEnd = nextEnvMatch === -1 ? content.length : envStart + 1 + nextEnvMatch;
  const envSection = content.slice(envStart, envEnd);

  // Parse KV namespaces: [[env.{env}.kv_namespaces]]
  const kvRegex = new RegExp(
    `\\[\\[env\\.${env}\\.kv_namespaces\\]\\]\\s*\\nbinding\\s*=\\s*"([^"]+)"\\s*\\nid\\s*=\\s*"([^"]+)"`,
    'g'
  );
  let kvMatch;
  while ((kvMatch = kvRegex.exec(envSection)) !== null) {
    result.kv[kvMatch[1]] = kvMatch[2];
  }

  // Parse D1 databases: [[env.{env}.d1_databases]]
  const d1Regex = new RegExp(
    `\\[\\[env\\.${env}\\.d1_databases\\]\\]\\s*\\nbinding\\s*=\\s*"([^"]+)"\\s*\\ndatabase_name\\s*=\\s*"[^"]+"\\s*\\ndatabase_id\\s*=\\s*"([^"]+)"`,
    'g'
  );
  let d1Match;
  while ((d1Match = d1Regex.exec(envSection)) !== null) {
    result.d1[d1Match[1]] = d1Match[2];
  }

  return result;
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
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pages wrangler.toml generation
// ---------------------------------------------------------------------------

export interface PagesWranglerOptions {
  component: 'ar-login-ui' | 'ar-admin-ui';
  env: string;
  needsProxy: boolean;
}

/**
 * Generate wrangler.toml content for a Cloudflare Pages component.
 *
 * When needsProxy=true, includes a [[services]] binding so the Pages Function
 * can reach ar-router via Service Binding (no workers.dev needed, ITP-safe).
 *
 * Pages projects are separate per environment (e.g., test-ar-login-ui,
 * prod-ar-login-ui), so no [env.*] sections are required — the file is flat.
 */
export function generatePagesWranglerConfig(options: PagesWranglerOptions): string {
  const { component, env, needsProxy } = options;
  const workerName = `${env}-ar-router`;

  const lines = [
    `# Auto-generated by @authrim/setup - do not edit manually`,
    `name = "${env}-${component}"`,
    `compatibility_date = "2024-01-01"`,
    `compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]`,
    `pages_build_output_dir = ".svelte-kit/cloudflare"`,
  ];

  if (needsProxy) {
    lines.push(``, `[[services]]`);
    lines.push(`binding = "AR_ROUTER"`);
    lines.push(`service = "${workerName}"`);
  }

  return lines.join('\n') + '\n';
}
