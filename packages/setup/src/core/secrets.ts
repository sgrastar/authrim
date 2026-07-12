import type { WorkerComponent } from './naming.js';

export const SECRET_NAMES = [
  'PRIVATE_KEY_PEM',
  'PUBLIC_JWK_JSON',
  'RP_TOKEN_ENCRYPTION_KEY',
  'PII_ENCRYPTION_KEY',
  'OBJECT_ENCRYPTION_ROOT_KEY',
  'OTP_HMAC_SECRET',
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

/** Local key-file mapping used by every deploy entry point. */
export const SECRET_KEY_FILES: Partial<Record<SecretName, string>> = {
  PRIVATE_KEY_PEM: 'private.pem',
  PUBLIC_JWK_JSON: 'public.jwk.json',
  RP_TOKEN_ENCRYPTION_KEY: 'rp_token_encryption_key.txt',
  PII_ENCRYPTION_KEY: 'pii_encryption_key.txt',
  OBJECT_ENCRYPTION_ROOT_KEY: 'object_encryption_root_key.txt',
  OTP_HMAC_SECRET: 'otp_hmac_secret.txt',
  VERSION_MANAGER_SECRET: 'version_manager_secret.txt',
  LOGGING_CURSOR_HMAC_SECRET: 'logging_cursor_hmac_secret.txt',
  FLOW_RUNTIME_HMAC_SECRET: 'flow_runtime_hmac_secret.txt',
  PLUGIN_ENCRYPTION_KEY: 'plugin_encryption_key.txt',
  TENANT_RUNTIME_REGISTRY_SIGNING_PRIVATE_JWK: 'tenant_runtime_registry_signing_private.jwk.json',
  TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'tenant_runtime_registry_signing_key_id.txt',
  TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: 'tenant_runtime_registry_verify.jwks.json',
  ADMIN_API_SECRET: 'admin_api_secret.txt',
  KEY_MANAGER_SECRET: 'key_manager_secret.txt',
  CLOUDFLARE_API_TOKEN: 'cloudflare_api_token.txt',
  RESEND_API_KEY: 'resend_api_key.txt',
  DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID: 'downstream_grant_introspection_client_id.txt',
  DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET: 'downstream_grant_introspection_client_secret.txt',
};

export const SECRET_UPLOAD_PLAN: Record<WorkerComponent, readonly SecretName[]> = {
  'ar-lib-core': ['OBJECT_ENCRYPTION_ROOT_KEY', 'VERSION_MANAGER_SECRET', 'KEY_MANAGER_SECRET'],
  'ar-discovery': ['PUBLIC_JWK_JSON'],
  'ar-auth': [
    'PRIVATE_KEY_PEM',
    'PUBLIC_JWK_JSON',
    'RP_TOKEN_ENCRYPTION_KEY',
    'PII_ENCRYPTION_KEY',
    'OTP_HMAC_SECRET',
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
    'PII_ENCRYPTION_KEY',
    'OBJECT_ENCRYPTION_ROOT_KEY',
    'OTP_HMAC_SECRET',
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
  'ar-bridge': ['RP_TOKEN_ENCRYPTION_KEY', 'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS'],
  'ar-vc': [
    'PUBLIC_JWK_JSON',
    'KEY_MANAGER_SECRET',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
  ],
};

/** Provider/integration credentials that are intentionally optional at deploy time. */
export const OPTIONAL_DEPLOY_SECRET_NAMES: readonly SecretName[] = [
  'RESEND_API_KEY',
  'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID',
  'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET',
];

/**
 * Return required secret values missing for Workers that do not yet exist.
 * Existing Workers keep their current secret bindings when a local key archive
 * is unavailable; first deployments must never create a partially configured Worker.
 */
export function getMissingRequiredDeploySecrets(
  secrets: Readonly<Record<string, string>>,
  workers: readonly WorkerComponent[]
): SecretName[] {
  const optional = new Set<SecretName>(OPTIONAL_DEPLOY_SECRET_NAMES);
  return [
    ...new Set(
      workers
        .flatMap((worker) => SECRET_UPLOAD_PLAN[worker] ?? [])
        .filter((name) => !optional.has(name))
        .filter((name) => !secrets[name]?.trim())
    ),
  ];
}

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
