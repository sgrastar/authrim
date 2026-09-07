import type { WorkerComponent } from './naming.js';

export const SECRET_NAMES = [
  'PRIVATE_KEY_PEM',
  'PUBLIC_JWK_JSON',
  'RP_TOKEN_ENCRYPTION_KEY',
  'PII_ENCRYPTION_KEY',
  'OBJECT_ENCRYPTION_ROOT_KEY',
  'OTP_HMAC_SECRET',
  'LOGGING_CURSOR_HMAC_SECRET',
  'FLOW_RUNTIME_HMAC_SECRET',
  'VC_TRANSACTION_CODE_HMAC_SECRET',
  'VC_EVIDENCE_HMAC_SECRET',
  'VC_PROFILE_CONTRACT_HMAC_SECRET',
  'PLUGIN_ENCRYPTION_KEY',
  'PLUGIN_MUTATION_HMAC_KEY',
  'NOTIFICATION_PAYLOAD_ENCRYPTION_PUBLIC_JWKS',
  'NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A',
  'NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B',
  'NOTIFICATION_INTENT_HMAC_KEY',
  'AGENT_ELEVATION_ENCRYPTION_KEY',
  'TENANT_RUNTIME_REGISTRY_SIGNING_PRIVATE_JWK',
  'TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID',
  'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
  'RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A',
  'RUNTIME_REGISTRY_SIGNING_JWK_SLOT_B',
  'SMOKE_RPC_SIGNING_JWK_SLOT_A',
  'SMOKE_RPC_SIGNING_JWK_SLOT_B',
  'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
  'LOOKUP_HMAC_KEY_SLOT_A',
  'LOOKUP_HMAC_KEY_SLOT_B',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_D1_API_TOKEN',
  'CLOUDFLARE_WORKERS_API_TOKEN',
  'CLOUDFLARE_KV_API_TOKEN',
  'CLOUDFLARE_R2_API_TOKEN',
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
  LOGGING_CURSOR_HMAC_SECRET: 'logging_cursor_hmac_secret.txt',
  FLOW_RUNTIME_HMAC_SECRET: 'flow_runtime_hmac_secret.txt',
  VC_TRANSACTION_CODE_HMAC_SECRET: 'vc_transaction_code_hmac_secret.txt',
  VC_EVIDENCE_HMAC_SECRET: 'vc_evidence_hmac_secret.txt',
  VC_PROFILE_CONTRACT_HMAC_SECRET: 'vc_profile_contract_hmac_secret.txt',
  PLUGIN_ENCRYPTION_KEY: 'plugin_encryption_key.txt',
  PLUGIN_MUTATION_HMAC_KEY: 'plugin_mutation_hmac_key.txt',
  NOTIFICATION_PAYLOAD_ENCRYPTION_PUBLIC_JWKS: 'notification_payload_encryption_public.jwks.json',
  NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A:
    'notification_payload_decryption_jwk_slot_a.private.jwk.json',
  NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B:
    'notification_payload_decryption_jwk_slot_b.private.jwk.json',
  NOTIFICATION_INTENT_HMAC_KEY: 'notification_intent_hmac_key.txt',
  AGENT_ELEVATION_ENCRYPTION_KEY: 'agent_elevation_encryption_key.txt',
  TENANT_RUNTIME_REGISTRY_SIGNING_PRIVATE_JWK: 'tenant_runtime_registry_signing_private.jwk.json',
  TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'tenant_runtime_registry_signing_key_id.txt',
  TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: 'tenant_runtime_registry_verify.jwks.json',
  RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: 'tenant_runtime_registry_signing_private.jwk.json',
  RUNTIME_REGISTRY_SIGNING_JWK_SLOT_B: 'runtime_registry_signing_jwk_slot_b.private.jwk.json',
  SMOKE_RPC_SIGNING_JWK_SLOT_A: 'smoke_rpc_signing_jwk_slot_a.private.jwk.json',
  SMOKE_RPC_SIGNING_JWK_SLOT_B: 'smoke_rpc_signing_jwk_slot_b.private.jwk.json',
  CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS: 'control_smoke_verify.jwks.json',
  LOOKUP_HMAC_KEY_SLOT_A: 'lookup_hmac_key_slot_a.txt',
  LOOKUP_HMAC_KEY_SLOT_B: 'lookup_hmac_key_slot_b.txt',
  CLOUDFLARE_API_TOKEN: 'cloudflare_api_token.txt',
  RESEND_API_KEY: 'resend_api_key.txt',
  DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID: 'downstream_grant_introspection_client_id.txt',
  DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET: 'downstream_grant_introspection_client_secret.txt',
};

export const SECRET_UPLOAD_PLAN: Record<WorkerComponent, readonly SecretName[]> = {
  'ar-lib-core': [
    'OBJECT_ENCRYPTION_ROOT_KEY',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    'LOOKUP_HMAC_KEY_SLOT_A',
    'LOOKUP_HMAC_KEY_SLOT_B',
    'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
  ],
  'ar-control': [
    'RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A',
    'RUNTIME_REGISTRY_SIGNING_JWK_SLOT_B',
    'TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID',
    'SMOKE_RPC_SIGNING_JWK_SLOT_A',
    'SMOKE_RPC_SIGNING_JWK_SLOT_B',
    'CLOUDFLARE_D1_API_TOKEN',
    'CLOUDFLARE_WORKERS_API_TOKEN',
    'CLOUDFLARE_KV_API_TOKEN',
    'CLOUDFLARE_R2_API_TOKEN',
  ],
  'ar-plugin-runner': [
    'PLUGIN_ENCRYPTION_KEY',
    'PLUGIN_MUTATION_HMAC_KEY',
    'NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A',
    'NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
  ],
  'ar-discovery': [
    'PUBLIC_JWK_JSON',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
  ],
  'ar-auth': [
    'PRIVATE_KEY_PEM',
    'PUBLIC_JWK_JSON',
    'OBJECT_ENCRYPTION_ROOT_KEY',
    'RP_TOKEN_ENCRYPTION_KEY',
    'PII_ENCRYPTION_KEY',
    'OTP_HMAC_SECRET',
    'FLOW_RUNTIME_HMAC_SECRET',
    'NOTIFICATION_PAYLOAD_ENCRYPTION_PUBLIC_JWKS',
    'NOTIFICATION_INTENT_HMAC_KEY',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    'LOOKUP_HMAC_KEY_SLOT_A',
    'LOOKUP_HMAC_KEY_SLOT_B',
    'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
  ],
  'ar-token': [
    'PUBLIC_JWK_JSON',
    'OBJECT_ENCRYPTION_ROOT_KEY',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    'LOOKUP_HMAC_KEY_SLOT_A',
    'LOOKUP_HMAC_KEY_SLOT_B',
    'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
  ],
  'ar-userinfo': [
    'PUBLIC_JWK_JSON',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    'LOOKUP_HMAC_KEY_SLOT_A',
    'LOOKUP_HMAC_KEY_SLOT_B',
    'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID',
    'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET',
    'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
  ],
  'ar-management': [
    'PUBLIC_JWK_JSON',
    'RP_TOKEN_ENCRYPTION_KEY',
    'PII_ENCRYPTION_KEY',
    'OBJECT_ENCRYPTION_ROOT_KEY',
    'OTP_HMAC_SECRET',
    'LOGGING_CURSOR_HMAC_SECRET',
    'PLUGIN_ENCRYPTION_KEY',
    'NOTIFICATION_PAYLOAD_ENCRYPTION_PUBLIC_JWKS',
    'NOTIFICATION_INTENT_HMAC_KEY',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    'VC_PROFILE_CONTRACT_HMAC_SECRET',
    'AGENT_ELEVATION_ENCRYPTION_KEY',
    'LOOKUP_HMAC_KEY_SLOT_A',
    'LOOKUP_HMAC_KEY_SLOT_B',
    'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
  ],
  'ar-agent-access': [
    'AGENT_ELEVATION_ENCRYPTION_KEY',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
  ],
  'ar-router': [],
  'ar-async': [
    'OBJECT_ENCRYPTION_ROOT_KEY',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
  ],
  'ar-policy': [
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
  ],
  'ar-saml': [
    'OBJECT_ENCRYPTION_ROOT_KEY',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
  ],
  'ar-bridge': [
    'RP_TOKEN_ENCRYPTION_KEY',
    'OBJECT_ENCRYPTION_ROOT_KEY',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    'LOOKUP_HMAC_KEY_SLOT_A',
    'LOOKUP_HMAC_KEY_SLOT_B',
    'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
  ],
  'ar-vc': [
    'PUBLIC_JWK_JSON',
    'OBJECT_ENCRYPTION_ROOT_KEY',
    'VC_TRANSACTION_CODE_HMAC_SECRET',
    'VC_EVIDENCE_HMAC_SECRET',
    'VC_PROFILE_CONTRACT_HMAC_SECRET',
    'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
  ],
};

/** Provider/integration credentials that are intentionally optional at deploy time. */
export const OPTIONAL_DEPLOY_SECRET_NAMES: readonly SecretName[] = [
  'CLOUDFLARE_KV_API_TOKEN',
  'CLOUDFLARE_R2_API_TOKEN',
  'RESEND_API_KEY',
  'LOOKUP_HMAC_KEY_SLOT_B',
  'SMOKE_RPC_SIGNING_JWK_SLOT_B',
  'RUNTIME_REGISTRY_SIGNING_JWK_SLOT_B',
  'NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B',
  'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID',
  'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET',
];

/** Control-plane credentials are accepted only from the setup process environment. */
export const EPHEMERAL_ENV_SECRET_NAMES: readonly SecretName[] = [
  'CLOUDFLARE_D1_API_TOKEN',
  'CLOUDFLARE_WORKERS_API_TOKEN',
  'CLOUDFLARE_KV_API_TOKEN',
  'CLOUDFLARE_R2_API_TOKEN',
];

/**
 * Return required secret values missing for Workers that do not yet exist.
 * Existing Workers keep their current secret bindings when a local key archive
 * is unavailable; first deployments must never create a partially configured Worker.
 */
export function getMissingRequiredDeploySecrets(
  secrets: Readonly<Record<string, string>>,
  workers: readonly WorkerComponent[],
  options: { automaticProvisioning?: boolean } = {}
): SecretName[] {
  const optional = new Set<SecretName>(OPTIONAL_DEPLOY_SECRET_NAMES);
  if (options.automaticProvisioning === false) {
    optional.add('CLOUDFLARE_D1_API_TOKEN');
    optional.add('CLOUDFLARE_WORKERS_API_TOKEN');
  }
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
