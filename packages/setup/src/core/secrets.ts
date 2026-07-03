import type { WorkerComponent } from './naming.js';

export const SECRET_NAMES = [
  'PRIVATE_KEY_PEM',
  'PUBLIC_JWK_JSON',
  'RP_TOKEN_ENCRYPTION_KEY',
  'OBJECT_ENCRYPTION_ROOT_KEY',
  'VERSION_MANAGER_SECRET',
  'LOGGING_CURSOR_HMAC_SECRET',
  'FLOW_RUNTIME_HMAC_SECRET',
  'PLUGIN_ENCRYPTION_KEY',
  'TENANT_RUNTIME_REGISTRY_SIGNING_PRIVATE_JWK',
  'TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID',
  'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
  'ADMIN_API_SECRET',
  'KEY_MANAGER_SECRET',
  'CLOUDFLARE_API_TOKEN',
  'RESEND_API_KEY',
  'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID',
  'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET',
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

export const SECRET_UPLOAD_PLAN: Record<WorkerComponent, readonly SecretName[]> = {
  'ar-lib-core': ['OBJECT_ENCRYPTION_ROOT_KEY', 'VERSION_MANAGER_SECRET', 'KEY_MANAGER_SECRET'],
  'ar-discovery': ['PUBLIC_JWK_JSON'],
  'ar-auth': [
    'PRIVATE_KEY_PEM',
    'PUBLIC_JWK_JSON',
    'RP_TOKEN_ENCRYPTION_KEY',
    'ADMIN_API_SECRET',
    'KEY_MANAGER_SECRET',
    'FLOW_RUNTIME_HMAC_SECRET',
    'PLUGIN_ENCRYPTION_KEY',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    'RESEND_API_KEY',
  ],
  'ar-token': [
    'PUBLIC_JWK_JSON',
    'ADMIN_API_SECRET',
    'KEY_MANAGER_SECRET',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
  ],
  'ar-userinfo': [
    'PUBLIC_JWK_JSON',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID',
    'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET',
  ],
  'ar-management': [
    'PUBLIC_JWK_JSON',
    'RP_TOKEN_ENCRYPTION_KEY',
    'OBJECT_ENCRYPTION_ROOT_KEY',
    'VERSION_MANAGER_SECRET',
    'LOGGING_CURSOR_HMAC_SECRET',
    'KEY_MANAGER_SECRET',
    'PLUGIN_ENCRYPTION_KEY',
    'TENANT_RUNTIME_REGISTRY_SIGNING_PRIVATE_JWK',
    'TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    'RESEND_API_KEY',
  ],
  'ar-router': [],
  'ar-async': ['OBJECT_ENCRYPTION_ROOT_KEY'],
  'ar-policy': [],
  'ar-saml': ['KEY_MANAGER_SECRET', 'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS'],
  'ar-bridge': ['TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS'],
  'ar-vc': [
    'PUBLIC_JWK_JSON',
    'KEY_MANAGER_SECRET',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
  ],
};

export const DEFAULT_SECRET_TARGET_WORKERS: WorkerComponent[] = Object.entries(SECRET_UPLOAD_PLAN)
  .filter(([, secrets]) => secrets.length > 0)
  .map(([component]) => component as WorkerComponent);

export function getSecretTargetWorkers(workers?: WorkerComponent[]): WorkerComponent[] {
  const requestedWorkers = workers && workers.length > 0 ? workers : DEFAULT_SECRET_TARGET_WORKERS;
  return requestedWorkers.filter((component) => SECRET_UPLOAD_PLAN[component]?.length > 0);
}

export function getSecretNamesForWorker(component: WorkerComponent): readonly SecretName[] {
  return SECRET_UPLOAD_PLAN[component] ?? [];
}
