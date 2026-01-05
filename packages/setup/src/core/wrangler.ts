/**
 * Wrangler Configuration Generator
 *
 * Generates wrangler.toml files for each component based on environment
 * configuration and resource IDs from authrim-lock.json.
 */

import type { AuthrimConfig } from './config.js';
import {
  getWorkerName,
  getDOScriptName,
  DURABLE_OBJECTS,
  KV_NAMESPACES,
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
  routes?: Array<{ pattern: string; zone_name: string }>;
  queues?: {
    producers?: Array<{ queue: string; binding: string }>;
  };
}

// =============================================================================
// Component-specific KV Requirements
// =============================================================================

const COMPONENT_KV_BINDINGS: Record<WorkerComponent, KVNamespace[]> = {
  'ar-lib-core': ['AUTHRIM_CONFIG'],
  'ar-discovery': ['AUTHRIM_CONFIG'],
  'ar-auth': ['CLIENTS_CACHE', 'SETTINGS', 'USER_CACHE', 'CONSENT_CACHE', 'AUTHRIM_CONFIG'],
  'ar-token': ['CLIENTS_CACHE', 'SETTINGS', 'AUTHRIM_CONFIG'],
  'ar-userinfo': ['SETTINGS', 'AUTHRIM_CONFIG'],
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
  'ar-discovery': ['KEY_MANAGER'],
  'ar-auth': [
    'KEY_MANAGER',
    'SESSION_STORE',
    'AUTH_CODE_STORE',
    'CHALLENGE_STORE',
    'RATE_LIMITER',
    'PAR_REQUEST_STORE',
    'VERSION_MANAGER',
  ],
  'ar-token': [
    'KEY_MANAGER',
    'AUTH_CODE_STORE',
    'REFRESH_TOKEN_ROTATOR',
    'DPOP_JTI_STORE',
    'DEVICE_CODE_STORE',
    'CIBA_REQUEST_STORE',
    'TOKEN_REVOCATION_STORE',
  ],
  'ar-userinfo': ['KEY_MANAGER', 'SESSION_STORE'],
  'ar-management': ['KEY_MANAGER', 'VERSION_MANAGER', 'RATE_LIMITER'],
  'ar-router': ['VERSION_MANAGER'],
  'ar-async': [],
  'ar-policy': ['PERMISSION_CHANGE_HUB'],
  'ar-saml': ['KEY_MANAGER', 'SAML_REQUEST_STORE', 'SESSION_STORE'],
  'ar-bridge': ['SESSION_STORE'],
  'ar-vc': ['KEY_MANAGER'],
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
// Generator Functions
// =============================================================================

/**
 * Generate wrangler.toml configuration for a component
 */
export function generateWranglerConfig(
  component: WorkerComponent,
  config: AuthrimConfig,
  resourceIds: ResourceIds
): WranglerConfig {
  const env = config.environment.prefix;
  const workerName = getWorkerName(env, component);

  // Base configuration
  const wranglerConfig: WranglerConfig = {
    name: workerName,
    main: COMPONENT_ENTRY_POINTS[component],
    compatibility_date: '2024-09-23',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: !config.urls?.api?.custom, // Enable workers_dev if no custom domain
    vars: generateEnvVars(component, config),
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

  // R2 Buckets (optional)
  if (config.features.r2?.enabled && resourceIds.r2) {
    if (component === 'ar-auth' || component === 'ar-management') {
      wranglerConfig.r2_buckets = [
        {
          binding: 'AVATARS',
          bucket_name: resourceIds.r2['AVATARS']?.name || `${env}-authrim-avatars`,
        },
      ];
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

  return wranglerConfig;
}

/**
 * Generate environment variables for a component
 */
function generateEnvVars(
  component: WorkerComponent,
  config: AuthrimConfig
): Record<string, string> {
  const vars: Record<string, string> = {};

  // Common variables
  const issuerUrl = config.urls?.api?.custom || config.urls?.api?.auto || '';
  const uiUrl = config.urls?.loginUi?.custom || config.urls?.loginUi?.auto || issuerUrl;

  if (component === 'ar-auth' || component === 'ar-token' || component === 'ar-discovery') {
    vars['ISSUER_URL'] = issuerUrl;
  }

  if (component === 'ar-auth') {
    vars['UI_URL'] = uiUrl;
    vars['CONFORMANCE_MODE'] = 'false';
  }

  // OIDC settings
  if (component === 'ar-auth' || component === 'ar-token') {
    vars['TOKEN_EXPIRY'] = config.oidc.accessTokenTtl.toString();
    vars['CODE_EXPIRY'] = config.oidc.authCodeTtl.toString();
    vars['STATE_EXPIRY'] = '300';
    vars['NONCE_EXPIRY'] = '300';
    vars['REFRESH_TOKEN_EXPIRY'] = config.oidc.refreshTokenTtl.toString();
  }

  // Key configuration
  if (config.keys.keyId) {
    vars['KEY_ID'] = config.keys.keyId;
  }

  // Security settings
  vars['ALLOW_HTTP_REDIRECT'] = 'false';
  vars['OPEN_REGISTRATION'] = 'false';

  // Sharding configuration
  if (component === 'ar-lib-core' || component === 'ar-auth' || component === 'ar-token') {
    vars['AUTHRIM_CODE_SHARDS'] = config.sharding.authCodeShards.toString();
    vars['AUTHRIM_SESSION_SHARDS'] = '32';
  }

  // Secrets placeholders (will be set via wrangler secret put)
  if (component === 'ar-lib-core' || component === 'ar-management') {
    vars['KEY_MANAGER_SECRET'] = ''; // Set via secret
    vars['ADMIN_API_SECRET'] = ''; // Set via secret
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
  ];
}

// =============================================================================
// TOML Serialization
// =============================================================================

/**
 * Convert WranglerConfig to TOML string
 */
export function toToml(config: WranglerConfig): string {
  const lines: string[] = [];

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

  // Routes
  if (config.routes && config.routes.length > 0) {
    lines.push('# Routes');
    for (const route of config.routes) {
      lines.push('[[routes]]');
      lines.push(`pattern = "${route.pattern}"`);
      lines.push(`zone_name = "${route.zone_name}"`);
      lines.push('');
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
        { pattern: `${domain}/par`, zone_name: zoneName },
        { pattern: `${domain}/session/check`, zone_name: zoneName },
        { pattern: `${domain}/as/*`, zone_name: zoneName },
        { pattern: `${domain}/api/auth/*`, zone_name: zoneName },
        { pattern: `${domain}/api/sessions/*`, zone_name: zoneName },
        { pattern: `${domain}/logout*`, zone_name: zoneName },
        { pattern: `${domain}/logged-out`, zone_name: zoneName },
        { pattern: `${domain}/auth/consent*`, zone_name: zoneName },
        { pattern: `${domain}/_internal/*`, zone_name: zoneName }
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
      routes.push(
        { pattern: `${domain}/api/admin/*`, zone_name: zoneName },
        { pattern: `${domain}/register`, zone_name: zoneName }
      );
      break;
  }

  return routes;
}
