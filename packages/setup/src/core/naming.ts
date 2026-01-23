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
  'ar-management', // Management API
  'ar-router', // Service Bindings router (must deploy last)
  'ar-async', // Async queue processing
  'ar-policy', // Policy service (ReBAC)
  'ar-saml', // SAML IdP/SP
  'ar-bridge', // External IdP bridge
  'ar-vc', // Verifiable Credentials
] as const;

export type WorkerComponent = (typeof WORKER_COMPONENTS)[number];

// Core components that are always deployed
export const CORE_WORKER_COMPONENTS: WorkerComponent[] = [
  'ar-lib-core',
  'ar-discovery',
  'ar-auth',
  'ar-token',
  'ar-userinfo',
  'ar-management',
  'ar-router',
];

// Optional components
export const OPTIONAL_WORKER_COMPONENTS: WorkerComponent[] = [
  'ar-async',
  'ar-policy',
  'ar-saml',
  'ar-bridge',
  'ar-vc',
];

// =============================================================================
// Durable Objects
// =============================================================================

export const DURABLE_OBJECTS = [
  { name: 'SESSION_STORE', className: 'SessionStore' },
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
  { name: 'PERMISSION_CHANGE_HUB', className: 'PermissionChangeHub' },
  { name: 'FLOW_STATE_STORE', className: 'FlowStateStore' },
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
  'STATE_STORE',
  'CONSENT_CACHE',
] as const;

export type KVNamespace = (typeof KV_NAMESPACES)[number];

// =============================================================================
// D1 Databases
// =============================================================================

export const D1_DATABASES = [
  { binding: 'DB', dbType: 'core-db' },
  { binding: 'DB_PII', dbType: 'pii-db' },
] as const;

export type D1Database = (typeof D1_DATABASES)[number];

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

/**
 * Generate auto URL for Pages (pages.dev domain)
 *
 * @example
 * getAutoPagesUrl('prod', 'ar-ui') => 'https://prod-ar-ui.pages.dev'
 */
export function getAutoPagesUrl(env: string, projectName: string): string {
  return `https://${env}-${projectName}.pages.dev`;
}

// =============================================================================
// Deployment Order
// =============================================================================

/**
 * Deployment levels - components at the same level can be deployed in parallel
 */
export const DEPLOYMENT_LEVELS: WorkerComponent[][] = [
  // Level 0: DO definitions (must be first)
  ['ar-lib-core'],
  // Level 1: Discovery
  ['ar-discovery'],
  // Level 2: Core OIDC endpoints (parallel)
  ['ar-auth', 'ar-token', 'ar-userinfo', 'ar-management'],
  // Level 3: Optional components (parallel)
  ['ar-async', 'ar-policy', 'ar-saml', 'ar-bridge', 'ar-vc'],
  // Level 4: Router with Service Bindings (must be last)
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
