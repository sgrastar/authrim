import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readPrivateFileSecurely, writePrivateFileAtomically } from './atomic-file.js';
import {
  CloudflareTokenAuthorityHttpClient,
  type CloudflareTokenAuthority,
  type CloudflareTokenOwnership,
  type CloudflareTokenPolicy,
  type CloudflareTokenRecord,
} from './cloudflare-control-token-bootstrap.js';
import { getAccountId, getCloudflareApiToken } from './cloudflare.js';
import {
  readControlProvisioningAuthority,
  type ControlProvisioningAuthorityState,
} from './control-provisioning-authority.js';
import {
  loadPendingControlBootstrap,
  type PendingControlBootstrapArtifact,
} from './pending-control-bootstrap.js';
import { getEnvironmentPaths } from './paths.js';

const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const ENVIRONMENT = /^[a-z][a-z0-9-]{0,31}$/u;
const TOKEN_ID = /^[0-9a-f]{32}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CLEANUP_FILE = 'control-token-cleanup.json';
const MAX_CLEANUP_CHECKPOINT_BYTES = 64 * 1024;
const DEFAULT_RETRY_DELAYS_MS = [250, 1_000, 2_000] as const;

type CleanupAuthority = Pick<
  CloudflareTokenAuthority,
  'verifySelf' | 'getToken' | 'listTokens' | 'listPermissionGroups' | 'deleteToken'
>;

interface CleanupAuthoritySnapshot {
  tokenOwnership: CloudflareTokenOwnership;
  tokenManagement: 'setup';
  childTokens: Array<{
    resourceClass: 'd1' | 'workers' | 'kv' | 'r2';
    tokenId: string;
    tokenFingerprint: string;
  }>;
  secretGeneration: { deploymentId: string; versionId: string };
}

export interface ControlTokenCleanupCheckpoint {
  version: 1;
  environment: string;
  accountId: string;
  authority: CleanupAuthoritySnapshot;
  authorityDigest: string;
  targetTokenIds: string[];
  broadTokenIds: string[];
  pendingArtifactDigest: string | null;
  completedTokenIds: string[];
  createdAt: string;
  updatedAt: string;
  checkpointDigest: string;
}

interface CleanupDependencies {
  readAuthority?: typeof readControlProvisioningAuthority;
  loadPending?: typeof loadPendingControlBootstrap;
  resolveAccountId?: () => Promise<string | null>;
  resolveApiToken?: () => Promise<string | null>;
  authorityFactory?: (input: {
    accountId: string;
    ownership: CloudflareTokenOwnership;
    apiToken: string;
  }) => CleanupAuthority;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
}

export interface CleanupSetupManagedControlTokensResult {
  status: 'not_required' | 'completed';
  reason?: 'authority_absent' | 'not_setup_managed';
  revokedTokenIds: string[];
  alreadyAbsentTokenIds: string[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function checkpointPath(baseDir: string, environment: string): string {
  return join(getEnvironmentPaths({ baseDir, env: environment }).root, CLEANUP_FILE);
}

function checkpointContent(
  checkpoint: Omit<ControlTokenCleanupCheckpoint, 'checkpointDigest'>
): string {
  return canonicalize(checkpoint);
}

function withCheckpointDigest(
  checkpoint: Omit<ControlTokenCleanupCheckpoint, 'checkpointDigest'>
): ControlTokenCleanupCheckpoint {
  return { ...checkpoint, checkpointDigest: sha256(checkpointContent(checkpoint)) };
}

function parseAuthoritySnapshot(value: unknown): CleanupAuthoritySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_token_cleanup_checkpoint_invalid');
  }
  const record = value as Record<string, unknown>;
  const childTokens = record.childTokens;
  const secretGeneration = record.secretGeneration;
  if (
    !hasExactKeys(record, [
      'childTokens',
      'secretGeneration',
      'tokenManagement',
      'tokenOwnership',
    ]) ||
    (record.tokenOwnership !== 'user' && record.tokenOwnership !== 'account') ||
    record.tokenManagement !== 'setup' ||
    !Array.isArray(childTokens) ||
    childTokens.length < 2 ||
    !secretGeneration ||
    typeof secretGeneration !== 'object' ||
    Array.isArray(secretGeneration)
  ) {
    throw new Error('control_token_cleanup_checkpoint_invalid');
  }
  const normalizedChildren = childTokens.map((child) => {
    if (!child || typeof child !== 'object' || Array.isArray(child)) {
      throw new Error('control_token_cleanup_checkpoint_invalid');
    }
    const candidate = child as Record<string, unknown>;
    if (
      !hasExactKeys(candidate, ['resourceClass', 'tokenFingerprint', 'tokenId']) ||
      !['d1', 'workers', 'kv', 'r2'].includes(String(candidate.resourceClass)) ||
      typeof candidate.tokenId !== 'string' ||
      !TOKEN_ID.test(candidate.tokenId) ||
      typeof candidate.tokenFingerprint !== 'string' ||
      !FINGERPRINT.test(candidate.tokenFingerprint)
    ) {
      throw new Error('control_token_cleanup_checkpoint_invalid');
    }
    return {
      resourceClass:
        candidate.resourceClass as CleanupAuthoritySnapshot['childTokens'][number]['resourceClass'],
      tokenId: candidate.tokenId,
      tokenFingerprint: candidate.tokenFingerprint,
    };
  });
  if (
    new Set(normalizedChildren.map((child) => child.tokenId)).size !== normalizedChildren.length ||
    new Set(normalizedChildren.map((child) => child.resourceClass)).size !==
      normalizedChildren.length
  ) {
    throw new Error('control_token_cleanup_checkpoint_invalid');
  }
  const receipt = secretGeneration as Record<string, unknown>;
  if (
    !hasExactKeys(receipt, ['deploymentId', 'versionId']) ||
    typeof receipt.deploymentId !== 'string' ||
    !RECEIPT_ID.test(receipt.deploymentId) ||
    typeof receipt.versionId !== 'string' ||
    !RECEIPT_ID.test(receipt.versionId)
  ) {
    throw new Error('control_token_cleanup_checkpoint_invalid');
  }
  return {
    tokenOwnership: record.tokenOwnership,
    tokenManagement: 'setup',
    childTokens: normalizedChildren.sort((left, right) =>
      left.tokenId.localeCompare(right.tokenId)
    ),
    secretGeneration: { deploymentId: receipt.deploymentId, versionId: receipt.versionId },
  };
}

function authoritySnapshot(authority: ControlProvisioningAuthorityState): CleanupAuthoritySnapshot {
  const tokenOwnership =
    authority.tokenOwnership === 'none'
      ? authority.bootstrapTokenOwnership
      : authority.tokenOwnership;
  if (
    authority.tokenManagement !== 'setup' ||
    tokenOwnership === 'none' ||
    authority.secretGeneration === null
  ) {
    throw new Error('control_token_cleanup_checkpoint_invalid');
  }
  return parseAuthoritySnapshot({
    tokenOwnership,
    tokenManagement: authority.tokenManagement,
    childTokens: authority.childTokens.map((child) => ({
      resourceClass: child.resourceClass,
      tokenId: child.tokenId,
      tokenFingerprint: child.tokenFingerprint,
    })),
    secretGeneration: authority.secretGeneration,
  });
}

function pendingAuthoritySnapshot(
  artifact: PendingControlBootstrapArtifact
): CleanupAuthoritySnapshot {
  return parseAuthoritySnapshot({
    tokenOwnership: artifact.ownership,
    tokenManagement: 'setup',
    childTokens: artifact.childTokens.map((child) => ({
      resourceClass: child.resourceClass,
      tokenId: child.tokenId,
      tokenFingerprint: child.tokenFingerprint,
    })),
    secretGeneration: artifact.secretGeneration,
  });
}

function pendingArtifactEvidence(artifact: PendingControlBootstrapArtifact): unknown {
  return {
    version: artifact.version,
    environment: artifact.environment,
    accountId: artifact.accountId,
    ownership: artifact.ownership,
    bootstrapTokenId: artifact.bootstrapTokenId,
    bootstrapTokenFingerprint: artifact.bootstrapTokenFingerprint,
    childTokens: artifact.childTokens
      .map((child) => ({
        resourceClass: child.resourceClass,
        tokenId: child.tokenId,
        tokenName: child.tokenName,
        secretName: child.secretName,
        tokenFingerprint: child.tokenFingerprint,
      }))
      .sort((left, right) => left.tokenId.localeCompare(right.tokenId)),
    secretGeneration: artifact.secretGeneration,
    revocationTargetTokenIds: [...artifact.revocationTargetTokenIds].sort(),
    recoveryToken:
      artifact.recoveryToken === null
        ? null
        : {
            tokenId: artifact.recoveryToken.tokenId,
            tokenFingerprint: artifact.recoveryToken.tokenFingerprint,
          },
    revocationConfirmed: artifact.revocationConfirmed,
  };
}

function pendingArtifactDigest(artifact: PendingControlBootstrapArtifact): string {
  return sha256(canonicalize(pendingArtifactEvidence(artifact)));
}

function pendingTokenInventory(artifact: PendingControlBootstrapArtifact): {
  targetTokenIds: string[];
  broadTokenIds: string[];
} {
  const broadTokenIds = [
    ...artifact.revocationTargetTokenIds,
    ...(artifact.recoveryToken ? [artifact.recoveryToken.tokenId] : []),
  ];
  return {
    targetTokenIds: [
      ...new Set([...artifact.childTokens.map((child) => child.tokenId), ...broadTokenIds]),
    ].sort(),
    broadTokenIds: [...new Set(broadTokenIds)].sort(),
  };
}

function isTokenlessAuthorityBeforePendingWrite(
  authority: ControlProvisioningAuthorityState
): boolean {
  return (
    authority.automaticProvisioningEnabled &&
    authority.capabilityState === 'pending' &&
    authority.tokenOwnership === 'none' &&
    authority.tokenManagement === 'none' &&
    authority.bootstrapPhase === 'none' &&
    authority.bootstrapTokenOwnership === 'none' &&
    authority.bootstrapTokenId === null &&
    authority.bootstrapTokenFingerprint === null &&
    authority.childTokens.length === 0 &&
    authority.secretGeneration === null
  );
}

function assertPendingMatchesAuthority(input: {
  artifact: PendingControlBootstrapArtifact;
  authority: ControlProvisioningAuthorityState | null;
}): void {
  if (input.authority === null || isTokenlessAuthorityBeforePendingWrite(input.authority)) return;
  const authority = input.authority;
  let snapshot: CleanupAuthoritySnapshot;
  try {
    snapshot = authoritySnapshot(authority);
  } catch (error) {
    throw new Error('control_token_cleanup_pending_authority_mismatch_manual_recovery_required', {
      cause: error,
    });
  }
  const artifactSnapshot = pendingAuthoritySnapshot(input.artifact);
  const authorityChildren = authority.childTokens
    .map((child) => ({
      resourceClass: child.resourceClass,
      tokenId: child.tokenId,
      tokenName: child.tokenName,
      secretName: child.secretName,
      tokenFingerprint: child.tokenFingerprint,
    }))
    .sort((left, right) => left.tokenId.localeCompare(right.tokenId));
  const artifactChildren = input.artifact.childTokens
    .map((child) => ({
      resourceClass: child.resourceClass,
      tokenId: child.tokenId,
      tokenName: child.tokenName,
      secretName: child.secretName,
      tokenFingerprint: child.tokenFingerprint,
    }))
    .sort((left, right) => left.tokenId.localeCompare(right.tokenId));
  const snapshotMatches = canonicalize(snapshot) === canonicalize(artifactSnapshot);
  const childrenMatch = canonicalize(authorityChildren) === canonicalize(artifactChildren);
  const pendingBootstrapMatches =
    authority.bootstrapPhase !== 'none' &&
    authority.capabilityState === 'pending' &&
    authority.bootstrapTokenOwnership === input.artifact.ownership &&
    authority.bootstrapTokenId === input.artifact.bootstrapTokenId &&
    authority.bootstrapTokenFingerprint === input.artifact.bootstrapTokenFingerprint &&
    (authority.bootstrapPhase !== 'cutover_verified' || input.artifact.revocationConfirmed);
  const readyMatches =
    authority.bootstrapPhase === 'none' &&
    authority.capabilityState === 'ready' &&
    authority.tokenOwnership === input.artifact.ownership &&
    input.artifact.revocationConfirmed;
  if (
    authority.environmentId !== input.artifact.environment ||
    !snapshotMatches ||
    !childrenMatch ||
    (!pendingBootstrapMatches && !readyMatches)
  ) {
    throw new Error('control_token_cleanup_pending_authority_mismatch_manual_recovery_required');
  }
}

function parseCheckpoint(raw: unknown, expectedEnvironment: string): ControlTokenCleanupCheckpoint {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('control_token_cleanup_checkpoint_invalid');
  }
  const value = raw as Record<string, unknown>;
  const authority = parseAuthoritySnapshot(value.authority);
  const completedTokenIds = value.completedTokenIds;
  const currentSchema = hasExactKeys(value, [
    'accountId',
    'authority',
    'authorityDigest',
    'broadTokenIds',
    'checkpointDigest',
    'completedTokenIds',
    'createdAt',
    'environment',
    'pendingArtifactDigest',
    'targetTokenIds',
    'updatedAt',
    'version',
  ]);
  const legacySchema = hasExactKeys(value, [
    'accountId',
    'authority',
    'authorityDigest',
    'checkpointDigest',
    'completedTokenIds',
    'createdAt',
    'environment',
    'updatedAt',
    'version',
  ]);
  const targetTokenIds = currentSchema
    ? value.targetTokenIds
    : authority.childTokens.map((child) => child.tokenId);
  const broadTokenIds = currentSchema ? value.broadTokenIds : [];
  const pendingDigest = currentSchema ? value.pendingArtifactDigest : null;
  if (
    (!currentSchema && !legacySchema) ||
    value.version !== 1 ||
    value.environment !== expectedEnvironment ||
    typeof value.accountId !== 'string' ||
    !ACCOUNT_ID.test(value.accountId) ||
    typeof value.authorityDigest !== 'string' ||
    !FINGERPRINT.test(value.authorityDigest) ||
    value.authorityDigest !== sha256(canonicalize(authority)) ||
    !Array.isArray(targetTokenIds) ||
    targetTokenIds.length < authority.childTokens.length ||
    targetTokenIds.some((tokenId) => typeof tokenId !== 'string' || !TOKEN_ID.test(tokenId)) ||
    new Set(targetTokenIds).size !== targetTokenIds.length ||
    authority.childTokens.some((child) => !targetTokenIds.includes(child.tokenId)) ||
    !Array.isArray(broadTokenIds) ||
    broadTokenIds.some((tokenId) => typeof tokenId !== 'string' || !TOKEN_ID.test(tokenId)) ||
    new Set(broadTokenIds).size !== broadTokenIds.length ||
    broadTokenIds.some(
      (tokenId) =>
        !targetTokenIds.includes(tokenId) ||
        authority.childTokens.some((child) => child.tokenId === tokenId)
    ) ||
    new Set([...authority.childTokens.map((child) => child.tokenId), ...broadTokenIds]).size !==
      targetTokenIds.length ||
    (pendingDigest !== null &&
      (typeof pendingDigest !== 'string' || !FINGERPRINT.test(pendingDigest))) ||
    broadTokenIds.length > 0 !== (pendingDigest !== null) ||
    !Array.isArray(completedTokenIds) ||
    completedTokenIds.some((tokenId) => typeof tokenId !== 'string' || !TOKEN_ID.test(tokenId)) ||
    new Set(completedTokenIds).size !== completedTokenIds.length ||
    completedTokenIds.some((tokenId) => !targetTokenIds.includes(tokenId)) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    typeof value.checkpointDigest !== 'string' ||
    !FINGERPRINT.test(value.checkpointDigest)
  ) {
    throw new Error('control_token_cleanup_checkpoint_invalid');
  }
  const withoutDigest = {
    version: 1 as const,
    environment: value.environment,
    accountId: value.accountId,
    authority,
    authorityDigest: value.authorityDigest,
    ...(currentSchema
      ? {
          targetTokenIds: [...targetTokenIds].sort(),
          broadTokenIds: [...broadTokenIds].sort(),
          pendingArtifactDigest: pendingDigest,
        }
      : {}),
    completedTokenIds: [...completedTokenIds].sort(),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (value.checkpointDigest !== sha256(canonicalize(withoutDigest))) {
    throw new Error('control_token_cleanup_checkpoint_tampered');
  }
  return {
    version: 1,
    environment: value.environment,
    accountId: value.accountId,
    authority,
    authorityDigest: value.authorityDigest,
    targetTokenIds: [...targetTokenIds].sort(),
    broadTokenIds: [...broadTokenIds].sort(),
    pendingArtifactDigest: pendingDigest,
    completedTokenIds: [...completedTokenIds].sort(),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    checkpointDigest: value.checkpointDigest,
  };
}

export async function loadControlTokenCleanupCheckpoint(input: {
  baseDir: string;
  environment: string;
}): Promise<ControlTokenCleanupCheckpoint | null> {
  if (!ENVIRONMENT.test(input.environment)) {
    throw new Error('control_token_cleanup_environment_invalid');
  }
  const path = checkpointPath(input.baseDir, input.environment);
  const content = await readPrivateFileSecurely(path, {
    maxBytes: MAX_CLEANUP_CHECKPOINT_BYTES,
    invalidError: 'control_token_cleanup_checkpoint_invalid',
    permissionsError: 'control_token_cleanup_checkpoint_permissions_invalid',
  });
  if (content === null) return null;
  try {
    return parseCheckpoint(JSON.parse(content), input.environment);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('control_token_cleanup_')) throw error;
    throw new Error('control_token_cleanup_checkpoint_invalid', { cause: error });
  }
}

async function persistCheckpoint(input: {
  baseDir: string;
  checkpoint: Omit<ControlTokenCleanupCheckpoint, 'checkpointDigest'>;
}): Promise<ControlTokenCleanupCheckpoint> {
  const checkpoint = withCheckpointDigest(input.checkpoint);
  await writePrivateFileAtomically(
    checkpointPath(input.baseDir, checkpoint.environment),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    0o600
  );
  const reflected = await loadControlTokenCleanupCheckpoint({
    baseDir: input.baseDir,
    environment: checkpoint.environment,
  });
  if (!reflected || reflected.checkpointDigest !== checkpoint.checkpointDigest) {
    throw new Error('control_token_cleanup_checkpoint_reflection_failed');
  }
  return reflected;
}

async function configuredAccountId(baseDir: string, environment: string): Promise<string | null> {
  const path = getEnvironmentPaths({ baseDir, env: environment }).config;
  const content = await readPrivateFileSecurely(path, {
    maxBytes: 1024 * 1024,
    invalidError: 'control_token_cleanup_config_invalid',
    permissionsError: 'control_token_cleanup_config_permissions_invalid',
  });
  if (content === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new Error('control_token_cleanup_config_invalid', { cause: error });
  }
  const accountId =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { cloudflare?: { accountId?: unknown } }).cloudflare?.accountId
      : undefined;
  if (accountId === undefined) return null;
  if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) {
    throw new Error('control_token_cleanup_config_invalid');
  }
  return accountId;
}

async function readAuthorityForCleanup(input: {
  controlDatabaseName: string;
  environment: string;
  readAuthority: typeof readControlProvisioningAuthority;
}): Promise<ControlProvisioningAuthorityState | null> {
  try {
    return await input.readAuthority({
      controlDatabaseName: input.controlDatabaseName,
      environmentId: input.environment,
    });
  } catch (error) {
    throw new Error('control_token_cleanup_authority_unavailable_manual_recovery_required', {
      cause: error,
    });
  }
}

function policyAppliesToAuthority(
  policy: CloudflareTokenPolicy,
  ownership: CloudflareTokenOwnership,
  accountId: string
): boolean {
  return Object.entries(policy.resources).some(([resource, value]) => {
    if (value !== '*') return false;
    if (ownership === 'account') {
      return (
        resource === `com.cloudflare.api.account.${accountId}` ||
        resource === 'com.cloudflare.api.account.*'
      );
    }
    return resource.startsWith('com.cloudflare.api.user.');
  });
}

function hasExpectedEditPolicy(input: {
  credential: CloudflareTokenRecord;
  permissionGroups: Awaited<ReturnType<CleanupAuthority['listPermissionGroups']>>;
  ownership: CloudflareTokenOwnership;
  accountId: string;
}): boolean {
  const expectedNames =
    input.ownership === 'account'
      ? new Set(['Account API Tokens Write', 'Account API Tokens Edit'])
      : new Set(['API Tokens Write', 'API Tokens Edit']);
  const expectedScope =
    input.ownership === 'account' ? 'com.cloudflare.api.account' : 'com.cloudflare.api.user';
  const editGroupIds = new Set(
    input.permissionGroups
      .filter((group) => expectedNames.has(group.name) && group.scopes.includes(expectedScope))
      .map((group) => group.id)
  );
  if (editGroupIds.size === 0 || !Array.isArray(input.credential.policies)) return false;
  const matchingPolicies = input.credential.policies.filter(
    (policy) =>
      policy.permission_groups.some((group: { id: string }) => editGroupIds.has(group.id)) &&
      policyAppliesToAuthority(policy, input.ownership, input.accountId)
  );
  return (
    matchingPolicies.some((policy) => policy.effect === 'allow') &&
    !matchingPolicies.some((policy) => policy.effect === 'deny')
  );
}

async function preflightCleanupAuthority(input: {
  authority: CleanupAuthority;
  checkpoint: ControlTokenCleanupCheckpoint;
}): Promise<Map<string, CloudflareTokenRecord | null>> {
  const verified = await input.authority.verifySelf();
  if (!verified || verified.status !== 'active' || !TOKEN_ID.test(verified.id)) {
    throw new Error('control_token_cleanup_credential_verification_failed');
  }
  const permissionScope =
    input.checkpoint.authority.tokenOwnership === 'account'
      ? 'com.cloudflare.api.account'
      : 'com.cloudflare.api.user';
  const [listed, permissionGroups, credential] = await Promise.all([
    input.authority.listTokens(),
    input.authority.listPermissionGroups(permissionScope),
    input.authority.getToken(verified.id),
  ]);
  if (
    !credential ||
    credential.id !== verified.id ||
    credential.status !== 'active' ||
    !listed.some((token) => token.id === verified.id) ||
    !hasExpectedEditPolicy({
      credential,
      permissionGroups,
      ownership: input.checkpoint.authority.tokenOwnership,
      accountId: input.checkpoint.accountId,
    })
  ) {
    throw new Error('control_token_cleanup_token_edit_permission_required');
  }
  const completed = new Set(input.checkpoint.completedTokenIds);
  const targets = new Map<string, CloudflareTokenRecord | null>();
  const broadTokenIds = new Set(input.checkpoint.broadTokenIds);
  for (const tokenId of input.checkpoint.targetTokenIds) {
    if (completed.has(tokenId)) continue;
    if (tokenId === verified.id) {
      throw new Error('control_token_cleanup_credential_is_revocation_target');
    }
    const reflected = await input.authority.getToken(tokenId);
    if (reflected && reflected.id !== tokenId) {
      throw new Error('control_token_cleanup_target_identity_mismatch');
    }
    if (reflected && !listed.some((token) => token.id === tokenId)) {
      throw new Error('control_token_cleanup_inventory_inconsistent');
    }
    if (
      reflected &&
      broadTokenIds.has(tokenId) &&
      !hasExpectedEditPolicy({
        credential: reflected,
        permissionGroups,
        ownership: input.checkpoint.authority.tokenOwnership,
        accountId: input.checkpoint.accountId,
      })
    ) {
      throw new Error('control_token_cleanup_broad_target_policy_mismatch');
    }
    targets.set(tokenId, reflected);
  }
  return targets;
}

function tokenApiErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) return String(error.code);
  return error instanceof Error ? error.message : String(error);
}

function isUnauthorizedTokenApiError(error: unknown): boolean {
  return /^cloudflare_token_api_http_(?:401|403)$/u.test(tokenApiErrorCode(error));
}

function isAlreadyAbsentTokenApiError(error: unknown): boolean {
  return tokenApiErrorCode(error) === 'cloudflare_token_api_http_404';
}

function isRetryableTokenApiError(error: unknown): boolean {
  const code = tokenApiErrorCode(error);
  return (
    code === 'cloudflare_token_api_response_lost' ||
    code === 'cloudflare_token_api_rejected' ||
    /^cloudflare_token_api_http_(?:408|409|425|429|5\d\d)$/u.test(code)
  );
}

async function wait(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

export async function cleanupSetupManagedControlTokens(input: {
  baseDir: string;
  environment: string;
  controlDatabaseIdentifier?: string | null;
  /** @deprecated Production callers must pass the immutable lock ID via controlDatabaseIdentifier. */
  controlDatabaseName?: string | null;
  accountId?: string | null;
  dependencies?: CleanupDependencies;
}): Promise<CleanupSetupManagedControlTokensResult> {
  if (!ENVIRONMENT.test(input.environment)) {
    throw new Error('control_token_cleanup_environment_invalid');
  }
  const controlDatabaseIdentifier =
    input.controlDatabaseIdentifier ?? input.controlDatabaseName ?? null;
  const configured = await configuredAccountId(input.baseDir, input.environment);
  if (input.accountId && configured && input.accountId !== configured) {
    throw new Error('control_token_cleanup_account_mismatch');
  }
  const resolvedAccountId =
    input.accountId ??
    configured ??
    (await (input.dependencies?.resolveAccountId ?? getAccountId)());
  if (!resolvedAccountId || !ACCOUNT_ID.test(resolvedAccountId)) {
    throw new Error('control_token_cleanup_account_id_required');
  }

  let checkpoint = await loadControlTokenCleanupCheckpoint({
    baseDir: input.baseDir,
    environment: input.environment,
  });
  if (checkpoint && checkpoint.accountId !== resolvedAccountId) {
    throw new Error('control_token_cleanup_account_mismatch');
  }

  const pendingArtifact = await (input.dependencies?.loadPending ?? loadPendingControlBootstrap)({
    baseDir: input.baseDir,
    environment: input.environment,
  });
  if (pendingArtifact && pendingArtifact.accountId !== resolvedAccountId) {
    throw new Error('control_token_cleanup_pending_account_mismatch_manual_recovery_required');
  }

  const currentAuthority = controlDatabaseIdentifier
    ? await readAuthorityForCleanup({
        controlDatabaseName: controlDatabaseIdentifier,
        environment: input.environment,
        readAuthority: input.dependencies?.readAuthority ?? readControlProvisioningAuthority,
      })
    : undefined;
  if (pendingArtifact) {
    assertPendingMatchesAuthority({
      artifact: pendingArtifact,
      authority: currentAuthority ?? null,
    });
  }

  const checkpointMatchesSnapshot = (
    candidate: ControlTokenCleanupCheckpoint,
    snapshot: CleanupAuthoritySnapshot
  ): boolean =>
    candidate.authorityDigest === sha256(canonicalize(snapshot)) &&
    canonicalize(candidate.authority) === canonicalize(snapshot);

  if (checkpoint && currentAuthority !== undefined) {
    let currentSnapshot: CleanupAuthoritySnapshot;
    try {
      currentSnapshot =
        pendingArtifact &&
        (currentAuthority === null || isTokenlessAuthorityBeforePendingWrite(currentAuthority))
          ? pendingAuthoritySnapshot(pendingArtifact)
          : authoritySnapshot(currentAuthority!);
    } catch (error) {
      throw new Error('control_token_cleanup_authority_changed_manual_recovery_required', {
        cause: error,
      });
    }
    if (!checkpointMatchesSnapshot(checkpoint, currentSnapshot)) {
      throw new Error('control_token_cleanup_authority_changed_manual_recovery_required');
    }
  } else if (checkpoint && controlDatabaseIdentifier && !pendingArtifact) {
    throw new Error('control_token_cleanup_authority_changed_manual_recovery_required');
  }

  if (checkpoint && pendingArtifact) {
    const snapshot = pendingAuthoritySnapshot(pendingArtifact);
    const digest = pendingArtifactDigest(pendingArtifact);
    const inventory = pendingTokenInventory(pendingArtifact);
    if (!checkpointMatchesSnapshot(checkpoint, snapshot)) {
      throw new Error('control_token_cleanup_pending_authority_mismatch_manual_recovery_required');
    }
    if (
      (checkpoint.pendingArtifactDigest !== null && checkpoint.pendingArtifactDigest !== digest) ||
      (checkpoint.pendingArtifactDigest !== null &&
        (canonicalize(checkpoint.targetTokenIds) !== canonicalize(inventory.targetTokenIds) ||
          canonicalize(checkpoint.broadTokenIds) !== canonicalize(inventory.broadTokenIds)))
    ) {
      throw new Error('control_token_cleanup_pending_artifact_changed_manual_recovery_required');
    }
    if (checkpoint.pendingArtifactDigest === null) {
      const { checkpointDigest: _previousDigest, ...checkpointWithoutDigest } = checkpoint;
      checkpoint = await persistCheckpoint({
        baseDir: input.baseDir,
        checkpoint: {
          ...checkpointWithoutDigest,
          targetTokenIds: inventory.targetTokenIds,
          broadTokenIds: inventory.broadTokenIds,
          pendingArtifactDigest: digest,
          updatedAt: new Date().toISOString(),
        },
      });
    }
  }

  if (!checkpoint) {
    if (pendingArtifact) {
      const snapshot = pendingAuthoritySnapshot(pendingArtifact);
      const inventory = pendingTokenInventory(pendingArtifact);
      const now = new Date().toISOString();
      checkpoint = await persistCheckpoint({
        baseDir: input.baseDir,
        checkpoint: {
          version: 1,
          environment: input.environment,
          accountId: resolvedAccountId,
          authority: snapshot,
          authorityDigest: sha256(canonicalize(snapshot)),
          targetTokenIds: inventory.targetTokenIds,
          broadTokenIds: inventory.broadTokenIds,
          pendingArtifactDigest: pendingArtifactDigest(pendingArtifact),
          completedTokenIds: [],
          createdAt: now,
          updatedAt: now,
        },
      });
    } else if (!controlDatabaseIdentifier) {
      throw new Error(
        'control_token_cleanup_checkpoint_required_for_missing_control_database_manual_recovery_required'
      );
    } else if (!currentAuthority) {
      return {
        status: 'not_required',
        reason: 'authority_absent',
        revokedTokenIds: [],
        alreadyAbsentTokenIds: [],
      };
    } else if (currentAuthority.tokenManagement !== 'setup') {
      return {
        status: 'not_required',
        reason: 'not_setup_managed',
        revokedTokenIds: [],
        alreadyAbsentTokenIds: [],
      };
    } else {
      if (currentAuthority.bootstrapPhase !== 'none') {
        throw new Error('control_token_cleanup_pending_artifact_required_manual_recovery_required');
      }
      const snapshot = authoritySnapshot(currentAuthority);
      const targetTokenIds = snapshot.childTokens.map((child) => child.tokenId).sort();
      const now = new Date().toISOString();
      checkpoint = await persistCheckpoint({
        baseDir: input.baseDir,
        checkpoint: {
          version: 1,
          environment: input.environment,
          accountId: resolvedAccountId,
          authority: snapshot,
          authorityDigest: sha256(canonicalize(snapshot)),
          targetTokenIds,
          broadTokenIds: [],
          pendingArtifactDigest: null,
          completedTokenIds: [],
          createdAt: now,
          updatedAt: now,
        },
      });
    }
  }

  const allTokenIds = checkpoint.targetTokenIds;
  if (checkpoint.completedTokenIds.length === allTokenIds.length) {
    return { status: 'completed', revokedTokenIds: [], alreadyAbsentTokenIds: [] };
  }

  const apiToken = await (
    input.dependencies?.resolveApiToken ??
    (async () => {
      return (await getCloudflareApiToken())?.token ?? null;
    })
  )();
  if (!apiToken) throw new Error('control_token_cleanup_token_edit_credential_required');
  const authority = (
    input.dependencies?.authorityFactory ??
    ((authorityInput) =>
      new CloudflareTokenAuthorityHttpClient({
        accountId: authorityInput.accountId,
        ownership: authorityInput.ownership,
        bootstrapToken: authorityInput.apiToken,
      }))
  )({
    accountId: checkpoint.accountId,
    ownership: checkpoint.authority.tokenOwnership,
    apiToken,
  });

  let targets: Map<string, CloudflareTokenRecord | null>;
  try {
    targets = await preflightCleanupAuthority({ authority, checkpoint });
  } catch (error) {
    if (isUnauthorizedTokenApiError(error)) {
      throw new Error('control_token_cleanup_token_edit_credential_unauthorized', { cause: error });
    }
    throw error;
  }

  const revokedTokenIds: string[] = [];
  const alreadyAbsentTokenIds: string[] = [];
  const completed = new Set(checkpoint.completedTokenIds);
  const persistCompleted = async (tokenId: string): Promise<void> => {
    completed.add(tokenId);
    const { checkpointDigest: _previousDigest, ...checkpointWithoutDigest } = checkpoint!;
    checkpoint = await persistCheckpoint({
      baseDir: input.baseDir,
      checkpoint: {
        ...checkpointWithoutDigest,
        completedTokenIds: [...completed].sort(),
        updatedAt: new Date().toISOString(),
      },
    });
  };

  for (const [tokenId, preflightRecord] of targets) {
    if (!preflightRecord) {
      await persistCompleted(tokenId);
      alreadyAbsentTokenIds.push(tokenId);
      continue;
    }
    const retryDelays = input.dependencies?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    let completedByReflection = false;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      let deleteError: unknown;
      try {
        await authority.deleteToken(tokenId);
      } catch (error) {
        deleteError = error;
      }
      if (deleteError && isUnauthorizedTokenApiError(deleteError)) {
        throw new Error('control_token_cleanup_token_edit_credential_unauthorized', {
          cause: deleteError,
        });
      }
      if (deleteError && isAlreadyAbsentTokenApiError(deleteError)) {
        completedByReflection = true;
        alreadyAbsentTokenIds.push(tokenId);
      } else {
        let reflected: CloudflareTokenRecord | null | undefined;
        let reflectionError: unknown;
        try {
          reflected = await authority.getToken(tokenId);
        } catch (error) {
          reflectionError = error;
        }
        if (reflectionError && isUnauthorizedTokenApiError(reflectionError)) {
          throw new Error('control_token_cleanup_token_edit_credential_unauthorized', {
            cause: reflectionError,
          });
        }
        if (reflected === null) {
          completedByReflection = true;
          if (deleteError) alreadyAbsentTokenIds.push(tokenId);
          else revokedTokenIds.push(tokenId);
        } else if (
          (deleteError && !isRetryableTokenApiError(deleteError)) ||
          (reflectionError && !isRetryableTokenApiError(reflectionError))
        ) {
          throw deleteError ?? reflectionError;
        }
      }
      if (completedByReflection) break;
      const retryDelay = retryDelays[attempt];
      if (retryDelay === undefined) {
        throw new Error('control_token_cleanup_revocation_retry_exhausted', {
          cause: deleteError,
        });
      }
      await (input.dependencies?.wait ?? wait)(retryDelay);
    }
    if (!completedByReflection) throw new Error('control_token_cleanup_revocation_unconfirmed');
    await persistCompleted(tokenId);
  }

  return { status: 'completed', revokedTokenIds, alreadyAbsentTokenIds };
}
