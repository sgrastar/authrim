import type { CloudflareControlTokens } from '@authrim/ar-lib-core/control-plane';

export type TenantShardDataRole = 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';

export interface ControlEnv {
  CONTROL_DB: D1Database;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_D1_API_TOKEN: string;
  CLOUDFLARE_WORKERS_API_TOKEN: string;
  CLOUDFLARE_KV_API_TOKEN?: string;
  CLOUDFLARE_R2_API_TOKEN?: string;
}

export interface TenantShardRequest {
  environmentId: string;
  dataRole: TenantShardDataRole;
  residencyPolicyId: string;
  residencyPartition: string;
  idempotencyKey: string;
  dryRun?: boolean;
}

export interface TenantShardPlan {
  operationId: string;
  desiredResourceId: string;
  shardId: string;
  environmentId: string;
  environmentName: string;
  dataRole: TenantShardDataRole;
  residencyPolicyId: string;
  residencyPartition: string;
  logicalShardId: string;
  databaseName: string;
  bindingRef: string;
  ownershipFingerprint: string;
  jurisdiction?: 'eu' | 'fedramp';
  locationHint?: 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc';
  readReplicationMode: 'enabled' | 'disabled';
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
  dataRole: TenantShardDataRole;
  residencyPolicyId: string;
  residencyPartition: string;
  supplyCount: number;
}

export function controlTokens(env: ControlEnv): CloudflareControlTokens {
  return {
    d1: env.CLOUDFLARE_D1_API_TOKEN,
    workers: env.CLOUDFLARE_WORKERS_API_TOKEN,
    kv: env.CLOUDFLARE_KV_API_TOKEN,
    r2: env.CLOUDFLARE_R2_API_TOKEN,
  };
}
