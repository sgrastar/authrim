import type { R2Bucket } from '@cloudflare/workers-types';
import type { RuntimeSmokeResult } from '@authrim/ar-lib-core';
import type { ControlTenantShardAllocationScope } from '@authrim/ar-lib-core/control-plane';

export interface RuntimeControlKeyVerificationResult {
  purpose: 'smoke_rpc' | 'runtime_registry';
  keyId: string;
  targetWorker: string;
  verifiedAt: number;
}

export interface RuntimeLookupHmacCandidateVerificationSuccess {
  ok: true;
  purpose: 'lookup_hmac';
  operationId: string;
  targetWorker: string;
  current: {
    generation: number;
    keyId: string;
    slot: 'A' | 'B';
    fingerprint: string;
    digest: string;
  };
  candidate: {
    generation: number;
    keyId: string;
    slot: 'A' | 'B';
    fingerprint: string;
    digest: string;
  };
  verifiedAt: number;
}

export interface RuntimeLookupHmacVerificationFailure {
  ok: false;
  errorCode: string;
}

export type RuntimeLookupHmacCandidateVerificationResult =
  | RuntimeLookupHmacCandidateVerificationSuccess
  | RuntimeLookupHmacVerificationFailure;

export interface RuntimeLookupHmacGenerationObservationSuccess {
  ok: true;
  purpose: 'lookup_hmac_generation';
  operationId: string;
  targetWorker: string;
  stateRevision: number;
  current: {
    generation: number;
    keyId: string;
    slot: 'A' | 'B';
    fingerprint: string;
  };
  previous: {
    generation: number;
    keyId: string;
    slot: 'A' | 'B';
    fingerprint: string;
  };
  observedAt: number;
}

export type RuntimeLookupHmacGenerationObservationResult =
  | RuntimeLookupHmacGenerationObservationSuccess
  | RuntimeLookupHmacVerificationFailure;

export type TenantShardDataRole = 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
export type ProvisionedD1DataRole = TenantShardDataRole | 'lookup';

export interface RuntimeSmokeServiceBinding {
  smokeTenantBinding: (token: string) => Promise<RuntimeSmokeResult>;
  smokeTenantBindings?: (
    tokens: string[]
  ) => Promise<
    Array<
      | { ok: true; result: RuntimeSmokeResult }
      | { ok: false; errorCode: string }
      | RuntimeSmokeResult
    >
  >;
  verifyControlKeyCandidate?: (input: unknown) => Promise<RuntimeControlKeyVerificationResult>;
  verifyLookupHmacCandidate?: (
    input: unknown
  ) => Promise<RuntimeLookupHmacCandidateVerificationResult>;
  observeLookupHmacGeneration?: (
    input: unknown
  ) => Promise<RuntimeLookupHmacGenerationObservationResult>;
  smokePluginResourceBindings?: (input: unknown) => Promise<{
    operationId: string;
    installationId: string;
    observedVersionId: string;
    resourceCount: number;
  }>;
}

export interface ControlEnv {
  CONTROL_DB: D1Database;
  MIGRATION_RELEASES: R2Bucket;
  TENANT_RUNTIME_REGISTRY?: KVNamespace;
  RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A?: string;
  RUNTIME_REGISTRY_SIGNING_JWK_SLOT_B?: string;
  RUNTIME_REGISTRY_SIGNING_ACTIVE_SLOT?: 'A' | 'B';
  TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID?: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  AUTHRIM_ENVIRONMENT_NAME?: string;
  AUTHRIM_AUTOMATIC_PROVISIONING?: 'true' | 'false';
  CLOUDFLARE_D1_API_TOKEN?: string;
  CLOUDFLARE_WORKERS_API_TOKEN?: string;
  CLOUDFLARE_KV_API_TOKEN?: string;
  CLOUDFLARE_R2_API_TOKEN?: string;
  AUTHRIM_DEPLOYMENT_TARGET?: string;
  CONTROL_DESTRUCTIVE_OPERATIONS_ENABLED?: 'true' | 'false';
  SMOKE_RPC_SIGNING_JWK_SLOT_A?: string;
  SMOKE_RPC_SIGNING_JWK_SLOT_B?: string;
  SMOKE_RPC_SIGNING_ACTIVE_SLOT?: 'A' | 'B';
  SMOKE_RPC_SIGNING_ACTIVE_KID?: string;
  SMOKE_AR_LIB_CORE?: RuntimeSmokeServiceBinding;
  SMOKE_AR_DISCOVERY?: RuntimeSmokeServiceBinding;
  SMOKE_AR_AUTH?: RuntimeSmokeServiceBinding;
  SMOKE_AR_TOKEN?: RuntimeSmokeServiceBinding;
  SMOKE_AR_USERINFO?: RuntimeSmokeServiceBinding;
  SMOKE_AR_MANAGEMENT?: RuntimeSmokeServiceBinding;
  SMOKE_AR_AGENT_ACCESS?: RuntimeSmokeServiceBinding;
  SMOKE_AR_ASYNC?: RuntimeSmokeServiceBinding;
  SMOKE_AR_POLICY?: RuntimeSmokeServiceBinding;
  SMOKE_AR_SAML?: RuntimeSmokeServiceBinding;
  SMOKE_AR_BRIDGE?: RuntimeSmokeServiceBinding;
  SMOKE_AR_VC?: RuntimeSmokeServiceBinding;
  SMOKE_AR_PLUGIN_RUNNER?: RuntimeSmokeServiceBinding;
}

export interface ControlRpcProps {
  caller: 'ar-management' | 'ar-plugin-runner';
  environmentId: string;
  audience: 'authrim-control-v1';
}

export interface TenantShardRequest {
  environmentId: string;
  tenantId?: string;
  dataRole: ProvisionedD1DataRole;
  residencyPolicyId: string;
  residencyPartition: string;
  lookupCapacityDomainId?: string;
  idempotencyKey: string;
  allocationScope?: ControlTenantShardAllocationScope;
  ownerTenantId?: string | null;
  dryRun?: boolean;
}

export interface TenantShardPlan {
  operationId: string;
  desiredResourceId: string;
  shardId: string;
  environmentId: string;
  environmentName: string;
  dataRole: ProvisionedD1DataRole;
  residencyPolicyId: string;
  residencyPartition: string;
  lookupCapacityDomainId: string | null;
  logicalShardId: string;
  databaseName: string;
  bindingRef: string;
  ownershipFingerprint: string;
  providerCreateState: 'not_started' | 'issued' | 'identified';
  providerResourceId: string | null;
  providerIdentityCheckpointedAt: number | null;
  allocationScope: ControlTenantShardAllocationScope;
  ownerTenantId: string | null;
  jurisdiction?: 'eu' | 'fedramp';
  locationHint?: 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc';
  readReplicationMode: 'enabled' | 'disabled';
  migrationStreamId: 'd1-core' | 'd1-pii' | 'd1-lookup';
  idempotencyKey: string;
}

export interface ControlOperationView {
  operationId: string;
  environmentId: string;
  operationKind: string;
  status: string;
  attemptCount: number;
  nextAttemptAt: number | null;
  lastErrorCode: string | null;
  retryBudgetStartedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface TenantShardRequestResult {
  dryRun: boolean;
  plan: TenantShardPlan;
  operation: ControlOperationView | null;
}

export interface LowWatermarkRequest {
  environmentId: string;
  tenantId: string;
  dataRole: TenantShardDataRole;
  residencyPolicyId: string;
  residencyPartition: string;
  allocationScope: ControlTenantShardAllocationScope;
  ownerTenantId: string | null;
  activeSupplyCount: number;
}

export interface PendingMigrationPlan {
  operationId: string;
  desiredResourceId: string;
  shardId: string;
  environmentId: string;
  databaseId: string;
  streamId: 'd1-core' | 'd1-pii' | 'd1-lookup';
  releaseId: string;
  manifestDigest: string;
  manifestObjectKey: string;
  bindingRef: string;
  dataRole: ProvisionedD1DataRole;
  residencyPartition: string;
  migrationGeneration: number;
}
