import {
  signTenantRuntimeRegistrySnapshot,
  type TenantRuntimeRegistrySnapshot,
} from '@authrim/ar-lib-core';

const TEST_TENANT_ID = 'default';
const TEST_DEPLOYMENT_TARGET = 'default';
const TEST_CORE_BINDING = 'TDB_POLICY_TEST_CORE';
const TEST_RUNTIME_GENERATION = 1;
const TEST_PUBLISHED_AT = '2026-08-04T00:00:00.000Z';
const TEST_EXPIRES_AT = '2099-08-04T00:00:00.000Z';

const keyPair = (await crypto.subtle.generateKey('Ed25519', true, [
  'sign',
  'verify',
])) as CryptoKeyPair;
const privateJwk = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JsonWebKey & {
  kid?: string;
};
const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey & {
  kid?: string;
};
privateJwk.kid = 'policy-runtime-test-key';
privateJwk.alg = 'EdDSA';
privateJwk.use = 'sig';
publicJwk.kid = 'policy-runtime-test-key';
publicJwk.alg = 'EdDSA';
publicJwk.use = 'sig';

const snapshot: TenantRuntimeRegistrySnapshot = {
  version: 4,
  tenantId: TEST_TENANT_ID,
  snapshotScope: 'tenant',
  deploymentTarget: TEST_DEPLOYMENT_TARGET,
  runtimeGeneration: TEST_RUNTIME_GENERATION,
  routeStatus: 'active',
  quarantineDenyGeneration: 0,
  backend: { provider: 'd1', resolver: 'control-plane' },
  placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 1 },
  publishedAt: TEST_PUBLISHED_AT,
  expiresAt: TEST_EXPIRES_AT,
  stores: [
    {
      tenantId: TEST_TENANT_ID,
      role: 'tenant_core',
      dataRole: 'tenant_core/default',
      residencyPolicyId: 'builtin:residency:default',
      residencyPartition: 'default',
      shardId: 'policy-test-core',
      assignmentGeneration: 1,
      bindingRouteGeneration: 1,
      placementPolicyGeneration: 1,
      allocationScope: 'tenant_exclusive',
      ownerTenantId: TEST_TENANT_ID,
      generation: 1,
      runtimeGeneration: TEST_RUNTIME_GENERATION,
      schemaVersion: 1,
      shardGroup: 'default',
      shardIndex: 0,
      shardCount: 1,
      shardKeyStrategy: 'none',
      provider: 'd1',
      driver: 'd1',
      bindingRef: TEST_CORE_BINDING,
      connectionRef: null,
      deploymentTarget: TEST_DEPLOYMENT_TARGET,
      status: 'active',
      healthStatus: 'active',
      databaseId: 'policy-test-core-id',
      databaseName: 'policy-test-core',
      regionHint: null,
      jurisdiction: null,
    },
  ],
  metadata: {
    storeCount: 1,
    roles: ['tenant_core'],
    signature: null,
    signatureKeyId: null,
    signatureAlgorithm: null,
    signedAt: null,
  },
};

const signedSnapshot = await signTenantRuntimeRegistrySnapshot(
  snapshot,
  {
    privateJwk,
    keyId: privateJwk.kid,
  },
  TEST_PUBLISHED_AT
);
const signedSnapshotJson = JSON.stringify(signedSnapshot);
const generationJson = JSON.stringify({
  runtimeGeneration: TEST_RUNTIME_GENERATION,
  routeStatus: 'active',
  quarantineDenyGeneration: 0,
  publishedAt: TEST_PUBLISHED_AT,
  expiresAt: TEST_EXPIRES_AT,
});

export function createPolicyRuntimeEnv<T extends Record<string, unknown>>(
  coreDb: D1Database,
  values: T
): T & Record<string, unknown> {
  return {
    ...values,
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    AUTHRIM_DEPLOYMENT_TARGET: TEST_DEPLOYMENT_TARGET,
    DEFAULT_TENANT_ID: TEST_TENANT_ID,
    TENANT_RUNTIME_REGISTRY: {
      get: async (key: string) =>
        key.includes(':runtime-registry:generation:') ? generationJson : signedSnapshotJson,
    },
    TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
    [TEST_CORE_BINDING]: coreDb,
  };
}
