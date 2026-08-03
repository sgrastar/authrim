/**
 * Authrim Naming Convention Module
 *
 * Implements naming conventions consistent with existing source code:
 * - Workers: {env}-ar-{component}
 * - D1 Databases: {env}-authrim-{db-type}
 * - KV Namespaces: {ENV}-{BINDING_NAME} (uppercase)
 */

// =============================================================================
// Worker Components
// =============================================================================

export const WORKER_COMPONENTS = [
  'ar-lib-core', // Durable Objects definition (must deploy first)
  'ar-discovery', // OpenID Discovery
  'ar-auth', // Authorization endpoint
  'ar-token', // Token endpoint
  'ar-userinfo', // UserInfo endpoint
  'ar-control', // Private Cloudflare control plane
  'ar-plugin-runner', // Private plugin execution plane
  'ar-management', // Management API
  'ar-agent-access', // Agent/MCP access plane
  'ar-router', // Service Bindings router (must deploy last)
  'ar-async', // Async queue processing
  'ar-policy', // Policy service (ReBAC)
  'ar-saml', // SAML IdP/SP
  'ar-bridge', // External IdP bridge
  'ar-vc', // Verifiable Credentials
] as const;

export type WorkerComponent = (typeof WORKER_COMPONENTS)[number];

// Standard components that are always deployed
export const CORE_WORKER_COMPONENTS: WorkerComponent[] = [
  'ar-lib-core',
  'ar-discovery',
  'ar-auth',
  'ar-token',
  'ar-userinfo',
  'ar-control',
  'ar-plugin-runner',
  'ar-management',
  'ar-agent-access',
  'ar-async',
  'ar-policy',
  'ar-saml',
  'ar-bridge',
  'ar-vc',
  'ar-router',
];

// Reserved for future install-time optional workers.
export const OPTIONAL_WORKER_COMPONENTS: WorkerComponent[] = [];

// =============================================================================
// Durable Objects
// =============================================================================

export const DURABLE_OBJECTS = [
  { name: 'SESSION_STORE', className: 'SessionStore' },
  { name: 'SESSION_REVOCATION_STORE', className: 'SessionRevocationStore' },
  { name: 'SESSION_CLIENT_STORE', className: 'SessionClientStore' },
  { name: 'KEY_MANAGER', className: 'KeyManager' },
  { name: 'AUTH_CODE_STORE', className: 'AuthorizationCodeStore' },
  { name: 'REFRESH_TOKEN_ROTATOR', className: 'RefreshTokenRotator' },
  { name: 'CHALLENGE_STORE', className: 'ChallengeStore' },
  { name: 'RATE_LIMITER', className: 'RateLimiterCounter' },
  { name: 'PAR_REQUEST_STORE', className: 'PARRequestStore' },
  { name: 'DPOP_JTI_STORE', className: 'DPoPJTIStore' },
  { name: 'DEVICE_CODE_STORE', className: 'DeviceCodeStore' },
  { name: 'CIBA_REQUEST_STORE', className: 'CIBARequestStore' },
  { name: 'TOKEN_REVOCATION_STORE', className: 'TokenRevocationStore' },
  { name: 'VERSION_MANAGER', className: 'VersionManager' },
  { name: 'SAML_REQUEST_STORE', className: 'SAMLRequestStore' },
  { name: 'SAML_AGGREGATE_METADATA_STORE', className: 'SAMLAggregateMetadataStore' },
  { name: 'PERMISSION_CHANGE_HUB', className: 'PermissionChangeHub' },
  { name: 'FLOW_STATE_STORE', className: 'FlowStateStore' },
  { name: 'DEVICE_SECRET_ROUTE_STORE', className: 'DeviceSecretRouteStore' },
] as const;

export type DurableObjectBinding = (typeof DURABLE_OBJECTS)[number];

// =============================================================================
// KV Namespaces
// =============================================================================

export const KV_NAMESPACES = [
  'CLIENTS_CACHE',
  'INITIAL_ACCESS_TOKENS',
  'SETTINGS',
  'REBAC_CACHE',
  'USER_CACHE',
  'AUTHRIM_CONFIG',
  'TENANT_RUNTIME_REGISTRY',
  'STATE_STORE',
  'CONSENT_CACHE',
] as const;

export type KVNamespace = (typeof KV_NAMESPACES)[number];

// =============================================================================
// D1 Databases
// =============================================================================

export const D1_DATABASES = [
  { binding: 'DB', dbType: 'core-db', locationProfile: 'core' },
  { binding: 'DB_PII', dbType: 'pii-db', locationProfile: 'pii' },
  { binding: 'DB_ADMIN', dbType: 'admin-db', locationProfile: 'pii' },
  { binding: 'CONTROL_DB', dbType: 'control-db', locationProfile: 'core' },
  { binding: 'LOOKUP_DB', dbType: 'lookup-db', locationProfile: 'pii' },
  { binding: 'PLUGIN_RUNNER_DB', dbType: 'plugin-runner-db', locationProfile: 'core' },
] as const;

export type D1Database = (typeof D1_DATABASES)[number];

export type WorkerRequiredDataRole =
  | 'tenant_core/default'
  | 'tenant_core/users'
  | 'tenant_pii'
  | 'lookup'
  | 'control'
  | 'plugin_runner';

export const WORKER_REQUIRED_DATA_ROLES: Record<
  WorkerComponent,
  readonly WorkerRequiredDataRole[]
> = {
  'ar-lib-core': ['tenant_core/default', 'tenant_core/users', 'tenant_pii', 'lookup'],
  'ar-discovery': ['tenant_core/default'],
  'ar-auth': ['tenant_core/default', 'tenant_core/users', 'tenant_pii', 'lookup'],
  'ar-token': ['tenant_core/default', 'tenant_core/users', 'tenant_pii', 'lookup'],
  'ar-userinfo': ['tenant_core/default', 'tenant_core/users', 'tenant_pii', 'lookup'],
  'ar-control': ['control'],
  'ar-plugin-runner': ['plugin_runner', 'tenant_core/default', 'tenant_core/users'],
  'ar-management': ['tenant_core/default', 'tenant_core/users', 'tenant_pii', 'lookup'],
  'ar-agent-access': ['tenant_core/default', 'tenant_core/users'],
  'ar-router': [],
  'ar-async': ['tenant_core/default', 'tenant_core/users', 'tenant_pii'],
  'ar-policy': ['tenant_core/default', 'tenant_core/users'],
  'ar-saml': ['tenant_core/default', 'tenant_core/users', 'tenant_pii'],
  'ar-bridge': ['tenant_core/default', 'tenant_core/users', 'tenant_pii', 'lookup'],
  'ar-vc': ['tenant_core/default', 'tenant_core/users', 'tenant_pii'],
};

export function getRequiredDataRolesForComponent(
  component: WorkerComponent
): readonly WorkerRequiredDataRole[] {
  return WORKER_REQUIRED_DATA_ROLES[component];
}

/**
 * Return the bootstrap D1 bindings a Worker is allowed to receive.
 * Control-plane databases are deliberately excluded from the default runtime set.
 */
export function getBuiltinD1BindingsForComponent(
  component: WorkerComponent
): readonly D1Database['binding'][] {
  if (component === 'ar-control') return ['CONTROL_DB'];
  if (component === 'ar-plugin-runner') return ['PLUGIN_RUNNER_DB'];
  if (component === 'ar-router') return [];
  if (component === 'ar-discovery') return ['DB'];
  if (component === 'ar-lib-core') return ['DB', 'DB_PII', 'LOOKUP_DB'];
  if (component === 'ar-management') return ['DB', 'DB_PII', 'DB_ADMIN', 'LOOKUP_DB'];
  if (component === 'ar-auth') return ['DB', 'DB_PII', 'DB_ADMIN', 'LOOKUP_DB'];
  if (component === 'ar-token') return ['DB', 'DB_PII', 'DB_ADMIN', 'LOOKUP_DB'];
  if (component === 'ar-userinfo' || component === 'ar-bridge') {
    return ['DB', 'DB_PII', 'LOOKUP_DB'];
  }
  if (component === 'ar-agent-access') return ['DB', 'DB_ADMIN'];
  if (component === 'ar-policy') return ['DB'];
  return ['DB', 'DB_PII'];
}

// =============================================================================
// Naming Functions
// =============================================================================

/**
 * Generate Worker name
 * Pattern: {env}-ar-{component}
 *
 * @example
 * getWorkerName('prod', 'ar-auth') => 'prod-ar-auth'
 * getWorkerName('conformance', 'ar-lib-core') => 'conformance-ar-lib-core'
 */
export function getWorkerName(env: string, component: WorkerComponent): string {
  return `${env}-${component}`;
}

/**
 * Generate D1 Database name
 * Pattern: {env}-authrim-{db-type}
 *
 * @example
 * getD1DatabaseName('prod', 'core-db') => 'prod-authrim-core-db'
 * getD1DatabaseName('staging', 'pii-db') => 'staging-authrim-pii-db'
 */
export function getD1DatabaseName(env: string, dbType: string): string {
  return `${env}-authrim-${dbType}`;
}

/**
 * Generate KV Namespace name
 * Pattern: {ENV}-{BINDING_NAME} (uppercase env)
 *
 * @example
 * getKVNamespaceName('prod', 'CLIENTS_CACHE') => 'PROD-CLIENTS_CACHE'
 * getKVNamespaceName('conformance', 'SETTINGS') => 'CONFORMANCE-SETTINGS'
 */
export function getKVNamespaceName(env: string, bindingName: KVNamespace): string {
  return `${env.toUpperCase()}-${bindingName}`;
}

/**
 * Generate Queue name
 * Pattern: {env}-{queue-name}
 *
 * @example
 * getQueueName('prod', 'audit-queue') => 'prod-audit-queue'
 */
export function getQueueName(env: string, queueName: string): string {
  return `${env}-${queueName}`;
}

/**
 * Get the script_name for Durable Object bindings
 * All DOs are defined in ar-lib-core
 *
 * @example
 * getDOScriptName('prod') => 'prod-ar-lib-core'
 */
export function getDOScriptName(env: string): string {
  return getWorkerName(env, 'ar-lib-core');
}

/**
 * Generate auto URL for Workers (workers.dev domain)
 *
 * @example
 * getAutoWorkerUrl('prod', 'ar-router', 'abc123') => 'https://prod-ar-router.abc123.workers.dev'
 */
export function getAutoWorkerUrl(
  env: string,
  component: WorkerComponent,
  accountSubdomain: string
): string {
  return `https://${getWorkerName(env, component)}.${accountSubdomain}.workers.dev`;
}

// =============================================================================
// Deployment Order
// =============================================================================

/**
 * Worker-to-Worker deployment dependencies.
 *
 * Cloudflare validates Durable Object and Service Binding targets while a
 * Worker is uploaded. Keep this graph aligned with the bindings generated in
 * wrangler.ts. Dependencies that are not part of a partial deployment are
 * assumed to already exist remotely.
 */
export const WORKER_DEPLOYMENT_DEPENDENCIES: Record<WorkerComponent, readonly WorkerComponent[]> = {
  'ar-lib-core': [],
  'ar-control': [],
  'ar-plugin-runner': [],
  'ar-bridge': ['ar-lib-core', 'ar-plugin-runner'],
  'ar-discovery': ['ar-lib-core'],
  'ar-token': ['ar-lib-core'],
  'ar-userinfo': ['ar-lib-core'],
  'ar-async': ['ar-lib-core'],
  'ar-policy': ['ar-lib-core', 'ar-plugin-runner'],
  'ar-saml': ['ar-lib-core', 'ar-plugin-runner'],
  'ar-vc': ['ar-lib-core'],
  'ar-auth': ['ar-lib-core', 'ar-bridge', 'ar-plugin-runner'],
  'ar-management': [
    'ar-lib-core',
    'ar-control',
    'ar-plugin-runner',
    'ar-bridge',
    'ar-auth',
    'ar-vc',
  ],
  'ar-agent-access': ['ar-lib-core', 'ar-token', 'ar-management'],
  'ar-router': CORE_WORKER_COMPONENTS.filter(
    (component) =>
      component !== 'ar-router' && component !== 'ar-control' && component !== 'ar-plugin-runner'
  ),
};

/**
 * Coarse deployment levels retained for callers that display the plan. The
 * deploy engine uses WORKER_DEPLOYMENT_DEPENDENCIES directly so ar-auth can
 * start as soon as ar-bridge is ready without waiting for unrelated Workers.
 */
export const DEPLOYMENT_LEVELS: WorkerComponent[][] = [
  ['ar-lib-core', 'ar-control', 'ar-plugin-runner'],
  [
    'ar-bridge',
    'ar-discovery',
    'ar-token',
    'ar-userinfo',
    'ar-async',
    'ar-policy',
    'ar-saml',
    'ar-vc',
  ],
  ['ar-auth'],
  ['ar-management'],
  ['ar-agent-access'],
  ['ar-router'],
];

/**
 * Get deployment order for specified components
 * Returns array of levels, each level contains components that can be deployed in parallel
 */
export function getDeploymentOrder(enabledComponents: Set<WorkerComponent>): WorkerComponent[][] {
  return DEPLOYMENT_LEVELS.map((level) =>
    level.filter((component) => enabledComponents.has(component))
  ).filter((level) => level.length > 0);
}

/**
 * Get all components that should be enabled based on configuration
 */
export function getEnabledComponents(options: {
  saml?: boolean;
  async?: boolean;
  vc?: boolean;
  bridge?: boolean;
  policy?: boolean;
}): Set<WorkerComponent> {
  const components = new Set<WorkerComponent>(CORE_WORKER_COMPONENTS);

  if (options.saml) components.add('ar-saml');
  if (options.async) components.add('ar-async');
  if (options.vc) components.add('ar-vc');
  if (options.bridge) components.add('ar-bridge');
  if (options.policy) components.add('ar-policy');

  return components;
}
