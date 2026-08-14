import type { Env } from '../../../packages/ar-lib-core/src/types/env';
import type { DatabaseAdapter } from '../../../packages/ar-lib-core/src/db/adapter';
import { AuthorizationCodeStore } from '../../../packages/ar-lib-core/src/durable-objects/AuthorizationCodeStore';
import { RefreshTokenRotator } from '../../../packages/ar-lib-core/src/durable-objects/RefreshTokenRotator';
import { DeviceCodeStore } from '../../../packages/ar-lib-core/src/durable-objects/DeviceCodeStore';
import { CIBARequestStore } from '../../../packages/ar-lib-core/src/durable-objects/CIBARequestStore';
import { SessionStore } from '../../../packages/ar-lib-core/src/durable-objects/SessionStore';
import { SessionRevocationStore } from '../../../packages/ar-lib-core/src/durable-objects/SessionRevocationStore';
import { ChallengeStore } from '../../../packages/ar-lib-core/src/durable-objects/ChallengeStore';
import { PARRequestStore } from '../../../packages/ar-lib-core/src/durable-objects/PARRequestStore';
import type { CallLedger } from './call-ledger';
import { MemoryDatabaseAdapter } from './d1-adapter';
import { MemoryKVNamespace } from './kv';
import { MemoryR2Bucket } from './r2';
import { MemoryQueue } from './queue';
import { getFixedSigningKeySet } from './fixed-keys';
import { MemoryDurableObjectNamespace } from './do-namespace';
import { installFrozenNow, frozenNowMs } from './deterministic-clock';

export const TEST_ISSUER = 'https://authrim.example';
export const TEST_TENANT = 'default';
export const TEST_USER = 'user-001';
export const TEST_ACCOUNT = 'account:user-001';

export interface SecurityMatrixEnvKit {
  env: Env;
  ledger: CallLedger;
  authrimConfig: MemoryKVNamespace;
  settings: MemoryKVNamespace;
  clientsCache: MemoryKVNamespace;
  rebacCache: MemoryKVNamespace;
  coreAdapter: MemoryDatabaseAdapter;
  piiAdapter: MemoryDatabaseAdapter;
  adminAdapter: MemoryDatabaseAdapter;
  authCodeNamespace: MemoryDurableObjectNamespace<AuthorizationCodeStore>;
  rotatorNamespace: MemoryDurableObjectNamespace<RefreshTokenRotator>;
  deviceCodeNamespace: MemoryDurableObjectNamespace<DeviceCodeStore>;
  cibaNamespace: MemoryDurableObjectNamespace<CIBARequestStore>;
  sessionStoreNamespace: MemoryDurableObjectNamespace<SessionStore>;
  sessionRevocationNamespace: MemoryDurableObjectNamespace<SessionRevocationStore>;
  challengeNamespace: MemoryDurableObjectNamespace<ChallengeStore>;
  parNamespace: MemoryDurableObjectNamespace<PARRequestStore>;
  keyManagerStub: Record<string, unknown>;
  revocationJtis: string[];
}

export function seedClientRow(
  kit: SecurityMatrixEnvKit,
  overrides: Record<string, unknown> = {}
): void {
  const row: Record<string, unknown> = {
    client_id: 'matrix-confidential',
    client_secret_hash: 'aa6b73af0f9d3bd6a7ec2f8c9f6b4e3d2a1c0b9e8f7d6c5b4a3f2e1d0c9b8a7',
    client_name: 'Matrix Confidential Client',
    redirect_uris: 'https://client.example/callback',
    grant_types: 'authorization_code refresh_token',
    response_types: 'code',
    scope: 'openid',
    token_endpoint_auth_method: 'client_secret_basic',
    default_resource: 'svc://matrix-api',
    require_pkce: 1,
    tenant_id: TEST_TENANT,
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides,
  };
  const clientId = String(row.client_id);
  kit.coreAdapter.addBehavior({
    match: (sql, params) =>
      sql.includes('FROM oauth_clients') &&
      sql.includes('client_id') &&
      params[params.length - 1] === clientId,
    result: () => [row],
  });
}

export function seedAccountState(kit: SecurityMatrixEnvKit, userId: string): void {
  kit.coreAdapter.addBehavior({
    match: (sql) => sql.includes('FROM identity_accounts') && sql.includes('legacy_user_id'),
    result: () => [
      {
        user_id: userId,
        account_type: 'end_user',
        account_lifecycle_state: 'active',
        subject_lifecycle_state: 'active',
        directory_publication_state: 'active',
        account_updated_at: 1700000000,
        subject_updated_at: 1700000000,
      },
    ],
  });
}

export function seedRegionShardConfig(
  kit: SecurityMatrixEnvKit,
  tenantId: string = TEST_TENANT
): void {
  kit.authrimConfig.seed(
    `region_shard_config:${tenantId}`,
    JSON.stringify({
      currentGeneration: 1,
      currentTotalShards: 4,
      currentRegions: {
        enam: { startShard: 0, endShard: 0, shardCount: 1 },
        weur: { startShard: 1, endShard: 1, shardCount: 1 },
        apac: { startShard: 2, endShard: 2, shardCount: 1 },
        wnam: { startShard: 3, endShard: 3, shardCount: 1 },
      },
      previousGenerations: [],
      maxPreviousGenerations: 2,
      updatedAt: 1700000000,
      residency: {
        version: 1,
        residencyPolicyId: 'matrix-default',
        residencyPartition: 'default',
        jurisdiction: null,
        allowedRegions: ['enam', 'weur', 'apac', 'wnam'],
        policyGeneration: 1,
      },
    })
  );
}

export async function createSecurityMatrixEnv(ledger: CallLedger): Promise<SecurityMatrixEnvKit> {
  const authrimConfig = new MemoryKVNamespace(ledger, 'autrhm_config');
  const settings = new MemoryKVNamespace(ledger, 'settings');
  const clientsCache = new MemoryKVNamespace(ledger, 'clients_cache');
  const rebacCache = new MemoryKVNamespace(ledger, 'rebac_cache');
  const stateStore = new MemoryKVNamespace(ledger, 'state_store');
  const nonceStore = new MemoryKVNamespace(ledger, 'nonce_store');
  const coreAdapter = new MemoryDatabaseAdapter(ledger, 'core');
  const piiAdapter = new MemoryDatabaseAdapter(ledger, 'pii');
  const adminAdapter = new MemoryDatabaseAdapter(ledger, 'admin');

  const keys = await getFixedSigningKeySet();

  const signingCalls: string[] = [];
  const keyManagerStub: Record<string, unknown> = {
    'signing-calls': signingCalls,
    getActiveKeyWithPrivateRpc: async () => {
      signingCalls.push('getActiveKeyWithPrivateRpc');
      return { kid: keys.kid, privatePEM: keys.privatePem };
    },
    getActiveOIDCSigningKeyWithPrivateRpc: async () => {
      signingCalls.push('getActiveOIDCSigningKeyWithPrivateRpc');
      return { kid: keys.kid, privatePEM: keys.privatePem };
    },
    rotateKeysWithPrivateRpc: async () => {
      signingCalls.push('rotateKeysWithPrivateRpc');
      return { kid: keys.kid, privatePEM: keys.privatePem };
    },
    getAllPublicKeysRpc: async () => [keys.publicJwk],
    fetch: async () => new Response('{}', { status: 200 }),
  };

  const revocationJtis: string[] = [];
  const revocationStub = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname.endsWith('/revoke')) {
        const body = (await request.json()) as { jti?: string };
        if (body.jti) revocationJtis.push(body.jti);
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const jti = url.searchParams.get('jti') ?? '';
      return new Response(JSON.stringify({ revoked: revocationJtis.includes(jti) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };

  const sessionRevocationStub = {
    getAccountStateRpc: async () => ({
      lifecycle: 'active',
      revokedAfterMs: null,
      lastLoginAtMs: 1700000000,
      lifecycleVersionMs: 1700000000,
      lifecycleOperationId: 'matrix-seed',
    }),
    initializeAccountStateRpc: async () => ({
      lifecycle: 'active',
      revokedAfterMs: null,
      lastLoginAtMs: 1700000000,
      lifecycleVersionMs: 1700000000,
      lifecycleOperationId: 'matrix-seed',
    }),
  };

  const dpopJtiStub = {
    fetch: async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
  };

  // AUTH_CODE_STORE routes to a real AuthorizationCodeStore over memory durable storage.
  const authCodeNamespace = new MemoryDurableObjectNamespace<AuthorizationCodeStore>(
    AuthorizationCodeStore,
    undefined as unknown as Env,
    ledger,
    'auth_code'
  );
  const rotatorNamespace = new MemoryDurableObjectNamespace<RefreshTokenRotator>(
    RefreshTokenRotator,
    undefined as unknown as Env,
    ledger,
    'rotator'
  );
  const deviceCodeNamespace = new MemoryDurableObjectNamespace<DeviceCodeStore>(
    DeviceCodeStore,
    undefined as unknown as Env,
    ledger,
    'device'
  );
  const cibaNamespace = new MemoryDurableObjectNamespace<CIBARequestStore>(
    CIBARequestStore,
    undefined as unknown as Env,
    ledger,
    'ciba'
  );
  const sessionStoreNamespace = new MemoryDurableObjectNamespace<SessionStore>(
    SessionStore,
    undefined as unknown as Env,
    ledger,
    'session'
  );
  const sessionRevocationNamespace = new MemoryDurableObjectNamespace<SessionRevocationStore>(
    SessionRevocationStore,
    undefined as unknown as Env,
    ledger,
    'session-revocation'
  );
  const challengeNamespace = new MemoryDurableObjectNamespace<ChallengeStore>(
    ChallengeStore,
    undefined as unknown as Env,
    ledger,
    'challenge'
  );
  const parNamespace = new MemoryDurableObjectNamespace<PARRequestStore>(
    PARRequestStore,
    undefined as unknown as Env,
    ledger,
    'par'
  );

  const env = {
    DB: coreAdapter,
    DB_PII: piiAdapter,
    DB_ADMIN: adminAdapter,
    STATE_STORE: stateStore,
    NONCE_STORE: nonceStore,
    CLIENTS_CACHE: clientsCache,
    AUTHRIM_CONFIG: authrimConfig,
    SETTINGS: settings,
    REBAC_CACHE: rebacCache,
    KEY_MANAGER: createNamespaceFromStub(keyManagerStub, ledger),
    AUTH_CODE_STORE: authCodeNamespace,
    REFRESH_TOKEN_ROTATOR: rotatorNamespace,
    DEVICE_CODE_STORE: deviceCodeNamespace,
    CIBA_REQUEST_STORE: cibaNamespace,
    SESSION_STORE: sessionStoreNamespace,
    SESSION_REVOCATION_STORE: sessionRevocationNamespace,
    CHALLENGE_STORE: challengeNamespace,
    PAR_REQUEST_STORE: parNamespace,
    TOKEN_REVOCATION_STORE: createNamespaceFromStub(revocationStub, ledger),
    DPOP_JTI_STORE: createNamespaceFromStub(dpopJtiStub, ledger),
    SESSION_CLIENT_STORE: createNamespaceFromStub(sessionRevocationStub, ledger),
    AVATARS: new MemoryR2Bucket(ledger, 'avatars'),
    AUDIT_ARCHIVE: new MemoryR2Bucket(ledger, 'audit_archive'),
    DIAGNOSTIC_LOGS: new MemoryR2Bucket(ledger, 'diagnostic_logs'),
    AUDIT_QUEUE: new MemoryQueue(ledger, 'audit_queue'),
    LOGGING_DELIVERY_QUEUE: new MemoryQueue(ledger, 'logging_delivery_queue'),
    LOGGING_DELIVERY_CRITICAL_QUEUE: new MemoryQueue(ledger, 'logging_delivery_critical_queue'),
    LOGGING_DELIVERY_BULK_QUEUE: new MemoryQueue(ledger, 'logging_delivery_bulk_queue'),
    ISSUER_URL: TEST_ISSUER,
    ACCESS_TOKEN_EXPIRY: '3600',
    REFRESH_TOKEN_EXPIRY: '2592000',
    AUTH_CODE_EXPIRY: '60',
    PUBLIC_JWK_JSON: keys.publicJwkJson,
    KEY_ID: keys.kid,
    PRIVATE_KEY_PEM: keys.privatePem,
    KEY_MANAGER_SECRET: 'matrix-key-manager-secret',
    ENABLE_REFRESH_TOKEN_ROTATION: 'true',
    RBAC_ACCESS_TOKEN_CLAIMS: 'none',
    RBAC_ID_TOKEN_CLAIMS: 'none',
    REGION_SHARD_TOTAL_SHARDS: '4',
    REGION_SHARD_GENERATION: '1',
    REGION_SHARD_APAC_PERCENT: '25',
    REGION_SHARD_ENAM_PERCENT: '25',
    REGION_SHARD_WEUR_PERCENT: '25',
    REGION_SHARD_WNAM_PERCENT: '25',
    ENVIRONMENT: 'test',
    LOG_LEVEL: 'error',
    LOG_FORMAT: 'json',
  } as unknown as Env;

  // Attach the real env to DO namespaces after construction so instances read bindings.
  for (const namespace of [
    authCodeNamespace,
    rotatorNamespace,
    deviceCodeNamespace,
    cibaNamespace,
    sessionStoreNamespace,
    sessionRevocationNamespace,
    challengeNamespace,
    parNamespace,
  ]) {
    (namespace as unknown as { setEnv(env: Env): void }).setEnv?.(env);
  }

  // The real SessionRevocationStore validates sessions against an initialized per-user
  // account lifecycle. Production hydrates this state lazily from D1; security matrix tests
  // seed the deterministic default user exactly like that hydration step so the real
  // store validation path sees an active lifecycle.
  const accountStateStore = sessionRevocationNamespace.get(
    sessionRevocationNamespace.idFromName(`tenant:${TEST_TENANT}:user-session:${TEST_USER}`)
  ) as unknown as SessionRevocationStore;
  await accountStateStore.initializeAccountStateRpc(
    TEST_TENANT,
    TEST_USER,
    TEST_ACCOUNT,
    'active',
    1700000000
  );

  return {
    env,
    ledger,
    authrimConfig,
    settings,
    clientsCache,
    rebacCache,
    coreAdapter,
    piiAdapter,
    adminAdapter,
    authCodeNamespace,
    rotatorNamespace,
    deviceCodeNamespace,
    cibaNamespace,
    sessionStoreNamespace,
    sessionRevocationNamespace,
    challengeNamespace,
    parNamespace,
    keyManagerStub,
    revocationJtis,
  };
}

function createNamespaceFromStub(stub: Record<string, unknown>, ledger: CallLedger): unknown {
  return {
    idFromName: (name: string) => ({
      toString: () => name,
      equals: (other: { toString(): string }) => other.toString() === name,
      name,
    }),
    idFromString: (id: string) => ({ toString: () => id, equals: () => false, name: id }),
    newUniqueId: () => ({ toString: () => `uniq-${crypto.randomUUID()}`, equals: () => false }),
    get: (_id: DurableObjectId) => stub,
  } as unknown as DurableObjectNamespace;
}

export function setMatrixNow(epochMs: number): () => void {
  installFrozenNow(epochMs);
  return () => undefined;
}

export function evalNowMs(): number {
  return frozenNowMs();
}
