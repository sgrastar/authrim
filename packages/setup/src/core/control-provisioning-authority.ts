import { executeD1Command, queryD1Rows } from './cloudflare.js';
import type {
  CloudflareTokenOwnership,
  ControlSecretGenerationReceipt,
  ControlTokenResourceClass,
} from './cloudflare-control-token-bootstrap.js';

const SAFE_ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TOKEN_ID = /^[0-9a-f]{32}$/u;
const TOKEN_FINGERPRINT = /^[0-9a-f]{64}$/u;
const TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SECRET_NAME_BY_RESOURCE_CLASS = {
  d1: 'CLOUDFLARE_D1_API_TOKEN',
  workers: 'CLOUDFLARE_WORKERS_API_TOKEN',
  kv: 'CLOUDFLARE_KV_API_TOKEN',
  r2: 'CLOUDFLARE_R2_API_TOKEN',
} as const satisfies Record<ControlTokenResourceClass, string>;

export type ControlProvisioningCapabilityState = 'disabled' | 'pending' | 'ready' | 'blocked';
export type ControlProvisioningBootstrapPhase = 'none' | 'pending_revocation' | 'cutover_verified';
export type ControlProvisioningTokenManagement = 'none' | 'setup' | 'operator';

export interface ControlProvisioningChildToken {
  resourceClass: ControlTokenResourceClass;
  tokenId: string;
  tokenName: string;
  secretName: string;
  /** Null is read-only compatibility for authority rows written before migration 008. */
  tokenFingerprint: string | null;
}

export interface ControlProvisioningAuthorityState {
  environmentId: string;
  automaticProvisioningEnabled: boolean;
  tokenOwnership: 'none' | CloudflareTokenOwnership;
  tokenManagement: ControlProvisioningTokenManagement;
  capabilityState: ControlProvisioningCapabilityState;
  capabilityCheckedAt: number | null;
  bootstrapPhase: ControlProvisioningBootstrapPhase;
  bootstrapTokenOwnership: 'none' | CloudflareTokenOwnership;
  bootstrapTokenId: string | null;
  bootstrapTokenFingerprint: string | null;
  childTokens: readonly ControlProvisioningChildToken[];
  secretGeneration: ControlSecretGenerationReceipt | null;
  updatedAt: number;
}

export function isTokenlessPendingControlProvisioningAuthority(
  authority: ControlProvisioningAuthorityState | null
): authority is ControlProvisioningAuthorityState {
  return (
    authority?.automaticProvisioningEnabled === true &&
    authority.capabilityState === 'pending' &&
    authority.tokenOwnership === 'none' &&
    authority.tokenManagement === 'none' &&
    authority.bootstrapPhase === 'none'
  );
}

interface ProvisioningAuthorityRow extends Record<string, unknown> {
  environment_id: string;
  automatic_provisioning_enabled: number;
  provisioning_token_ownership: 'none' | CloudflareTokenOwnership;
  provisioning_token_management?: ControlProvisioningTokenManagement;
  provisioning_capability_state: ControlProvisioningCapabilityState;
  provisioning_capability_checked_at: number | null;
  provisioning_bootstrap_phase?: ControlProvisioningBootstrapPhase;
  provisioning_bootstrap_token_ownership?: 'none' | CloudflareTokenOwnership;
  provisioning_bootstrap_token_id?: string | null;
  provisioning_bootstrap_token_fingerprint?: string | null;
  provisioning_child_tokens_json?: string | null;
  provisioning_secret_generation_deployment_id?: string | null;
  provisioning_secret_generation_version_id?: string | null;
  updated_at: number;
}

function requiredEnvironmentId(environmentId: string): string {
  if (!SAFE_ENVIRONMENT.test(environmentId)) {
    throw new Error('control_provisioning_authority_environment_invalid');
  }
  return environmentId;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseSecretGeneration(
  row: ProvisioningAuthorityRow
): ControlSecretGenerationReceipt | null {
  const deploymentId = row.provisioning_secret_generation_deployment_id;
  const versionId = row.provisioning_secret_generation_version_id;
  if (
    (deploymentId === null || deploymentId === undefined) &&
    (versionId === null || versionId === undefined)
  ) {
    return null;
  }
  if (
    typeof deploymentId !== 'string' ||
    !SAFE_RECEIPT_ID.test(deploymentId) ||
    typeof versionId !== 'string' ||
    !SAFE_RECEIPT_ID.test(versionId)
  ) {
    throw new Error('control_provisioning_authority_secret_generation_invalid');
  }
  return { deploymentId, versionId };
}

function parseChildTokens(
  value: string | null | undefined,
  options: { requireFingerprint: boolean }
): readonly ControlProvisioningChildToken[] {
  if (value === null || value === undefined) {
    if (options.requireFingerprint) {
      throw new Error('control_provisioning_authority_bootstrap_metadata_invalid');
    }
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('control_provisioning_authority_bootstrap_metadata_invalid');
  }
  if (!Array.isArray(parsed) || (options.requireFingerprint && parsed.length < 2)) {
    throw new Error('control_provisioning_authority_bootstrap_metadata_invalid');
  }
  const resourceClasses = new Set<ControlTokenResourceClass>();
  const tokenIds = new Set<string>();
  return parsed.map((candidate) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('control_provisioning_authority_bootstrap_metadata_invalid');
    }
    const record = candidate as Record<string, unknown>;
    const resourceClass = String(record.resourceClass) as ControlTokenResourceClass;
    const tokenId = String(record.tokenId);
    const tokenFingerprint = record.tokenFingerprint;
    if (
      !['d1', 'workers', 'kv', 'r2'].includes(resourceClass) ||
      resourceClasses.has(resourceClass) ||
      !TOKEN_ID.test(tokenId) ||
      tokenIds.has(tokenId) ||
      typeof record.tokenName !== 'string' ||
      !TOKEN_NAME.test(record.tokenName) ||
      typeof record.secretName !== 'string' ||
      record.secretName !== SECRET_NAME_BY_RESOURCE_CLASS[resourceClass] ||
      (tokenFingerprint !== undefined &&
        (typeof tokenFingerprint !== 'string' || !TOKEN_FINGERPRINT.test(tokenFingerprint))) ||
      (options.requireFingerprint &&
        (typeof tokenFingerprint !== 'string' || !TOKEN_FINGERPRINT.test(tokenFingerprint)))
    ) {
      throw new Error('control_provisioning_authority_bootstrap_metadata_invalid');
    }
    resourceClasses.add(resourceClass);
    tokenIds.add(tokenId);
    return {
      resourceClass,
      tokenId,
      tokenName: record.tokenName,
      secretName: record.secretName,
      tokenFingerprint: typeof tokenFingerprint === 'string' ? tokenFingerprint : null,
    };
  });
}

function stateFromRow(row: ProvisioningAuthorityRow): ControlProvisioningAuthorityState {
  const secretGeneration = parseSecretGeneration(row);
  return {
    environmentId: row.environment_id,
    automaticProvisioningEnabled: row.automatic_provisioning_enabled === 1,
    tokenOwnership: row.provisioning_token_ownership,
    tokenManagement: row.provisioning_token_management ?? 'none',
    capabilityState: row.provisioning_capability_state,
    capabilityCheckedAt: row.provisioning_capability_checked_at,
    bootstrapPhase: row.provisioning_bootstrap_phase ?? 'none',
    bootstrapTokenOwnership: row.provisioning_bootstrap_token_ownership ?? 'none',
    bootstrapTokenId: row.provisioning_bootstrap_token_id ?? null,
    bootstrapTokenFingerprint: row.provisioning_bootstrap_token_fingerprint ?? null,
    childTokens: parseChildTokens(row.provisioning_child_tokens_json, {
      requireFingerprint: secretGeneration !== null,
    }),
    secretGeneration,
    updatedAt: row.updated_at,
  };
}

export async function readControlProvisioningAuthority(input: {
  controlDatabaseName: string;
  environmentId: string;
  query?: typeof queryD1Rows;
}): Promise<ControlProvisioningAuthorityState | null> {
  const environmentId = requiredEnvironmentId(input.environmentId);
  const query = input.query ?? queryD1Rows;
  let rows: ProvisioningAuthorityRow[];
  try {
    rows = await query<ProvisioningAuthorityRow>(
      input.controlDatabaseName,
      `SELECT environment_id, automatic_provisioning_enabled, provisioning_token_ownership,
            provisioning_token_management, provisioning_capability_state,
            provisioning_capability_checked_at,
            provisioning_bootstrap_phase, provisioning_bootstrap_token_ownership,
            provisioning_bootstrap_token_id, provisioning_bootstrap_token_fingerprint,
            provisioning_child_tokens_json,
            provisioning_secret_generation_deployment_id,
            provisioning_secret_generation_version_id, updated_at
       FROM control_environments
      WHERE environment_id = ${sqlString(environmentId)}
      LIMIT 1`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !/no such column:\s*provisioning_(?:token_management|secret_generation_|bootstrap_)/iu.test(
        message
      )
    ) {
      throw error;
    }
    try {
      rows = await query<ProvisioningAuthorityRow>(
        input.controlDatabaseName,
        `SELECT environment_id, automatic_provisioning_enabled, provisioning_token_ownership,
                provisioning_capability_state, provisioning_capability_checked_at,
                provisioning_bootstrap_phase, provisioning_bootstrap_token_ownership,
                provisioning_bootstrap_token_id, provisioning_bootstrap_token_fingerprint,
                provisioning_child_tokens_json, updated_at
           FROM control_environments
          WHERE environment_id = ${sqlString(environmentId)}
          LIMIT 1`
      );
    } catch (fallbackError) {
      const fallbackMessage =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      if (!/no such column:\s*provisioning_bootstrap_/iu.test(fallbackMessage)) {
        throw fallbackError;
      }
      rows = await query<ProvisioningAuthorityRow>(
        input.controlDatabaseName,
        `SELECT environment_id, automatic_provisioning_enabled, provisioning_token_ownership,
                provisioning_capability_state, provisioning_capability_checked_at, updated_at
           FROM control_environments
          WHERE environment_id = ${sqlString(environmentId)}
          LIMIT 1`
      );
    }
  }
  return rows[0] ? stateFromRow(rows[0]) : null;
}

export async function writeControlProvisioningAuthority(input: {
  controlDatabaseName: string;
  environmentId: string;
  automaticProvisioningEnabled: boolean;
  tokenOwnership: 'none' | CloudflareTokenOwnership;
  tokenManagement?: ControlProvisioningTokenManagement;
  capabilityState: ControlProvisioningCapabilityState;
  bootstrapPhase?: ControlProvisioningBootstrapPhase;
  bootstrapTokenOwnership?: 'none' | CloudflareTokenOwnership;
  bootstrapTokenId?: string;
  bootstrapTokenFingerprint?: string;
  childTokens?: readonly ControlProvisioningChildToken[];
  secretGeneration?: ControlSecretGenerationReceipt | null;
  now?: number;
  execute?: typeof executeD1Command;
  query?: typeof queryD1Rows;
}): Promise<ControlProvisioningAuthorityState> {
  const environmentId = requiredEnvironmentId(input.environmentId);
  const bootstrapPhase = input.bootstrapPhase ?? 'none';
  const bootstrapTokenOwnership = input.bootstrapTokenOwnership ?? 'none';
  const tokenManagement = input.tokenManagement ?? 'none';
  const cutoverState = bootstrapPhase !== 'none';
  const childTokens =
    input.childTokens === undefined
      ? null
      : parseChildTokens(JSON.stringify(input.childTokens), { requireFingerprint: true });
  const secretGeneration = input.secretGeneration ?? null;
  if (
    secretGeneration !== null &&
    (!SAFE_RECEIPT_ID.test(secretGeneration.deploymentId) ||
      !SAFE_RECEIPT_ID.test(secretGeneration.versionId))
  ) {
    throw new Error('control_provisioning_authority_secret_generation_invalid');
  }
  const hasOwnershipEvidence = childTokens !== null && secretGeneration !== null;
  const hasNoOwnershipEvidence = childTokens === null && secretGeneration === null;
  const bootstrapMetadataClear =
    bootstrapTokenOwnership === 'none' &&
    input.bootstrapTokenId === undefined &&
    input.bootstrapTokenFingerprint === undefined;
  const validBootstrapMetadata =
    cutoverState &&
    TOKEN_ID.test(input.bootstrapTokenId ?? '') &&
    TOKEN_FINGERPRINT.test(input.bootstrapTokenFingerprint ?? '') &&
    bootstrapTokenOwnership !== 'none' &&
    hasOwnershipEvidence;
  const valid = input.automaticProvisioningEnabled
    ? (!cutoverState &&
        input.capabilityState === 'pending' &&
        input.tokenOwnership === 'none' &&
        tokenManagement === 'none' &&
        bootstrapMetadataClear &&
        hasNoOwnershipEvidence) ||
      (cutoverState &&
        input.capabilityState === 'pending' &&
        input.tokenOwnership === 'none' &&
        tokenManagement === 'setup' &&
        validBootstrapMetadata) ||
      (!cutoverState &&
        input.capabilityState === 'ready' &&
        input.tokenOwnership !== 'none' &&
        (tokenManagement === 'setup' || tokenManagement === 'operator') &&
        bootstrapMetadataClear &&
        hasOwnershipEvidence) ||
      (!cutoverState &&
        input.capabilityState === 'blocked' &&
        input.tokenOwnership !== 'none' &&
        tokenManagement === 'none' &&
        bootstrapMetadataClear &&
        hasNoOwnershipEvidence)
    : input.tokenOwnership === 'none' &&
      input.capabilityState === 'disabled' &&
      tokenManagement === 'none' &&
      !cutoverState &&
      bootstrapMetadataClear &&
      hasNoOwnershipEvidence;
  if (!valid) throw new Error('control_provisioning_authority_state_invalid');
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 1) {
    throw new Error('control_provisioning_authority_timestamp_invalid');
  }
  const checkedAt = input.capabilityState === 'pending' ? 'NULL' : String(now);
  const retainBootstrapMetadata = cutoverState;
  const bootstrapTokenId = retainBootstrapMetadata ? sqlString(input.bootstrapTokenId!) : 'NULL';
  const bootstrapTokenFingerprint = retainBootstrapMetadata
    ? sqlString(input.bootstrapTokenFingerprint!)
    : 'NULL';
  const childTokensSql = childTokens ? sqlString(JSON.stringify(childTokens)) : 'NULL';
  const secretGenerationDeploymentId = secretGeneration
    ? sqlString(secretGeneration.deploymentId)
    : 'NULL';
  const secretGenerationVersionId = secretGeneration
    ? sqlString(secretGeneration.versionId)
    : 'NULL';
  await (input.execute ?? executeD1Command)(
    input.controlDatabaseName,
    `UPDATE control_environments
        SET automatic_provisioning_enabled = ${input.automaticProvisioningEnabled ? 1 : 0},
            provisioning_token_ownership = ${sqlString(input.tokenOwnership)},
            provisioning_token_management = ${sqlString(tokenManagement)},
            provisioning_capability_state = ${sqlString(input.capabilityState)},
            provisioning_capability_checked_at = ${checkedAt},
            provisioning_bootstrap_phase = ${sqlString(bootstrapPhase)},
            provisioning_bootstrap_token_ownership = ${sqlString(bootstrapTokenOwnership)},
            provisioning_bootstrap_token_id = ${bootstrapTokenId},
            provisioning_bootstrap_token_fingerprint = ${bootstrapTokenFingerprint},
            provisioning_child_tokens_json = ${childTokensSql},
            provisioning_secret_generation_deployment_id = ${secretGenerationDeploymentId},
            provisioning_secret_generation_version_id = ${secretGenerationVersionId},
            updated_at = ${now}
      WHERE environment_id = ${sqlString(environmentId)}`
  );
  const reflected = await readControlProvisioningAuthority({
    controlDatabaseName: input.controlDatabaseName,
    environmentId,
    query: input.query,
  });
  if (
    !reflected ||
    reflected.automaticProvisioningEnabled !== input.automaticProvisioningEnabled ||
    reflected.tokenOwnership !== input.tokenOwnership ||
    reflected.tokenManagement !== tokenManagement ||
    reflected.capabilityState !== input.capabilityState ||
    reflected.bootstrapPhase !== bootstrapPhase ||
    reflected.bootstrapTokenOwnership !== bootstrapTokenOwnership ||
    reflected.capabilityCheckedAt !== (input.capabilityState === 'pending' ? null : now) ||
    reflected.bootstrapTokenId !== (cutoverState ? input.bootstrapTokenId : null) ||
    reflected.bootstrapTokenFingerprint !==
      (cutoverState ? input.bootstrapTokenFingerprint : null) ||
    JSON.stringify(reflected.childTokens) !== JSON.stringify(childTokens ?? []) ||
    reflected.secretGeneration?.deploymentId !== secretGeneration?.deploymentId ||
    reflected.secretGeneration?.versionId !== secretGeneration?.versionId
  ) {
    throw new Error('control_provisioning_authority_reflection_failed');
  }
  return reflected;
}
