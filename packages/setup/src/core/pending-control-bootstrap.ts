import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readPrivateFileSecurely, writePrivateFileAtomically } from './atomic-file.js';
import type {
  CloudflareTokenOwnership,
  ControlSecretGenerationReceipt,
  ControlTokenBootstrapPreparedResult,
} from './cloudflare-control-token-bootstrap.js';
import { getEnvironmentPaths } from './paths.js';

const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const ENVIRONMENT = /^[a-z][a-z0-9-]{0,31}$/u;
const TOKEN_ID = /^[0-9a-f]{32}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_PENDING_CONTROL_BOOTSTRAP_BYTES = 256 * 1024;

interface PendingControlBootstrapArtifactBase {
  environment: string;
  accountId: string;
  ownership: CloudflareTokenOwnership;
  bootstrapTokenId: string;
  bootstrapTokenFingerprint: string;
  childTokens: ControlTokenBootstrapPreparedResult['childTokens'];
  secretGeneration: ControlSecretGenerationReceipt;
  /** All broad credentials whose absence must be proven by an independent recovery authority. */
  revocationTargetTokenIds: readonly string[];
  /** Latest independently verified recovery authority, staged before it mutates the provider. */
  recoveryToken: {
    token: string;
    tokenId: string;
    tokenFingerprint: string;
  } | null;
  revocationConfirmed: boolean;
}

export interface PendingControlBootstrapArtifactV1 extends PendingControlBootstrapArtifactBase {
  version: 1;
  /** Original bootstrap authority. Retained only by artifacts created before recovery v2. */
  bootstrapToken: string;
}

export interface PendingControlBootstrapArtifactV2 extends PendingControlBootstrapArtifactBase {
  version: 2;
  /** Recovery v2 never reconstructs or persists a bootstrap credential it cannot prove. */
  bootstrapToken: null;
  recoveryToken: NonNullable<PendingControlBootstrapArtifactBase['recoveryToken']>;
}

export type PendingControlBootstrapArtifact =
  | PendingControlBootstrapArtifactV1
  | PendingControlBootstrapArtifactV2;

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort();
  const expectedKeys = [...expected].sort();
  return (
    keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index])
  );
}

function validReceipt(value: unknown): value is ControlSecretGenerationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    hasExactKeys(record, ['deploymentId', 'versionId']) &&
    typeof record.deploymentId === 'string' &&
    RECEIPT_ID.test(record.deploymentId) &&
    typeof record.versionId === 'string' &&
    RECEIPT_ID.test(record.versionId)
  );
}

function parseArtifact(raw: unknown, expectedEnvironment: string): PendingControlBootstrapArtifact {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('pending_control_bootstrap_invalid');
  }
  const value = raw as Record<string, unknown>;
  const childTokens = value.childTokens;
  const revocationTargetTokenIds = value.revocationTargetTokenIds;
  const recoveryToken = value.recoveryToken;
  if (
    !hasExactKeys(value, [
      'accountId',
      'bootstrapToken',
      'bootstrapTokenFingerprint',
      'bootstrapTokenId',
      'childTokens',
      'environment',
      'ownership',
      'recoveryToken',
      'revocationConfirmed',
      'revocationTargetTokenIds',
      'secretGeneration',
      'version',
    ]) ||
    (value.version !== 1 && value.version !== 2) ||
    value.environment !== expectedEnvironment ||
    typeof value.accountId !== 'string' ||
    !ACCOUNT_ID.test(value.accountId) ||
    (value.ownership !== 'account' && value.ownership !== 'user') ||
    (value.version === 1
      ? typeof value.bootstrapToken !== 'string' ||
        value.bootstrapToken.length < 20 ||
        value.bootstrapToken.length > 4096 ||
        /\s/u.test(value.bootstrapToken)
      : value.bootstrapToken !== null) ||
    typeof value.bootstrapTokenId !== 'string' ||
    !TOKEN_ID.test(value.bootstrapTokenId) ||
    typeof value.bootstrapTokenFingerprint !== 'string' ||
    !FINGERPRINT.test(value.bootstrapTokenFingerprint) ||
    (value.version === 1 &&
      fingerprint(String(value.bootstrapToken)) !== value.bootstrapTokenFingerprint) ||
    !Array.isArray(childTokens) ||
    childTokens.length < 2 ||
    childTokens.some((child) => {
      if (!child || typeof child !== 'object' || Array.isArray(child)) return true;
      const record = child as Record<string, unknown>;
      return (
        !hasExactKeys(record, [
          'resourceClass',
          'secretName',
          'tokenFingerprint',
          'tokenId',
          'tokenName',
        ]) ||
        !['d1', 'workers', 'kv', 'r2'].includes(String(record.resourceClass)) ||
        typeof record.tokenId !== 'string' ||
        !TOKEN_ID.test(record.tokenId) ||
        typeof record.tokenName !== 'string' ||
        typeof record.secretName !== 'string' ||
        typeof record.tokenFingerprint !== 'string' ||
        !FINGERPRINT.test(record.tokenFingerprint)
      );
    }) ||
    new Set(childTokens.map((child) => String((child as Record<string, unknown>).resourceClass)))
      .size !== childTokens.length ||
    new Set(childTokens.map((child) => String((child as Record<string, unknown>).tokenId))).size !==
      childTokens.length ||
    new Set(childTokens.map((child) => String((child as Record<string, unknown>).tokenFingerprint)))
      .size !== childTokens.length ||
    childTokens.some(
      (child) =>
        String((child as Record<string, unknown>).tokenFingerprint) ===
        value.bootstrapTokenFingerprint
    ) ||
    !validReceipt(value.secretGeneration) ||
    !Array.isArray(revocationTargetTokenIds) ||
    revocationTargetTokenIds.length < 1 ||
    revocationTargetTokenIds.some(
      (tokenId) => typeof tokenId !== 'string' || !TOKEN_ID.test(tokenId)
    ) ||
    new Set(revocationTargetTokenIds).size !== revocationTargetTokenIds.length ||
    !revocationTargetTokenIds.includes(String(value.bootstrapTokenId)) ||
    revocationTargetTokenIds.some((tokenId) =>
      childTokens.some((child) => String((child as Record<string, unknown>).tokenId) === tokenId)
    ) ||
    (value.version === 2 && recoveryToken === null) ||
    (recoveryToken !== null &&
      (!recoveryToken ||
        typeof recoveryToken !== 'object' ||
        Array.isArray(recoveryToken) ||
        !hasExactKeys(recoveryToken as Record<string, unknown>, [
          'token',
          'tokenFingerprint',
          'tokenId',
        ]) ||
        typeof (recoveryToken as Record<string, unknown>).token !== 'string' ||
        String((recoveryToken as Record<string, unknown>).token).length < 20 ||
        String((recoveryToken as Record<string, unknown>).token).length > 4096 ||
        /\s/u.test(String((recoveryToken as Record<string, unknown>).token)) ||
        typeof (recoveryToken as Record<string, unknown>).tokenId !== 'string' ||
        !TOKEN_ID.test(String((recoveryToken as Record<string, unknown>).tokenId)) ||
        typeof (recoveryToken as Record<string, unknown>).tokenFingerprint !== 'string' ||
        !FINGERPRINT.test(String((recoveryToken as Record<string, unknown>).tokenFingerprint)) ||
        fingerprint(String((recoveryToken as Record<string, unknown>).token)) !==
          (recoveryToken as Record<string, unknown>).tokenFingerprint ||
        (recoveryToken as Record<string, unknown>).tokenFingerprint ===
          value.bootstrapTokenFingerprint ||
        revocationTargetTokenIds.includes(
          String((recoveryToken as Record<string, unknown>).tokenId)
        ) ||
        childTokens.some(
          (child) =>
            String((child as Record<string, unknown>).tokenId) ===
            String((recoveryToken as Record<string, unknown>).tokenId)
        ) ||
        childTokens.some(
          (child) =>
            String((child as Record<string, unknown>).tokenFingerprint) ===
            String((recoveryToken as Record<string, unknown>).tokenFingerprint)
        ))) ||
    typeof value.revocationConfirmed !== 'boolean'
  ) {
    throw new Error('pending_control_bootstrap_invalid');
  }
  return value as unknown as PendingControlBootstrapArtifact;
}

async function removeDurably(path: string): Promise<void> {
  if (!existsSync(path)) return;
  await rm(path, { force: true });
  const directory = await open(dirname(path), 'r').catch(() => undefined);
  if (!directory) return;
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function stagePendingControlBootstrap(input: {
  baseDir: string;
  artifact: PendingControlBootstrapArtifact;
}): Promise<void> {
  if (!ENVIRONMENT.test(input.artifact.environment)) {
    throw new Error('pending_control_bootstrap_environment_invalid');
  }
  const artifact = parseArtifact(input.artifact, input.artifact.environment);
  const path = getEnvironmentPaths({
    baseDir: input.baseDir,
    env: artifact.environment,
  }).pendingControlBootstrap;
  await writePrivateFileAtomically(path, `${JSON.stringify(artifact, null, 2)}\n`, 0o600);
}

export async function loadPendingControlBootstrap(input: {
  baseDir: string;
  environment: string;
}): Promise<PendingControlBootstrapArtifact | null> {
  if (!ENVIRONMENT.test(input.environment)) {
    throw new Error('pending_control_bootstrap_environment_invalid');
  }
  const path = getEnvironmentPaths({
    baseDir: input.baseDir,
    env: input.environment,
  }).pendingControlBootstrap;
  const content = await readPrivateFileSecurely(path, {
    maxBytes: MAX_PENDING_CONTROL_BOOTSTRAP_BYTES,
    invalidError: 'pending_control_bootstrap_invalid',
    permissionsError: 'pending_control_bootstrap_permissions_invalid',
  });
  if (content === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new Error('pending_control_bootstrap_invalid', { cause: error });
  }
  return parseArtifact(raw, input.environment);
}

export async function markPendingControlBootstrapRevocationConfirmed(input: {
  baseDir: string;
  environment: string;
}): Promise<PendingControlBootstrapArtifact> {
  const artifact = await loadPendingControlBootstrap(input);
  if (!artifact) throw new Error('pending_control_bootstrap_missing');
  if (artifact.revocationConfirmed) return artifact;
  const updated = { ...artifact, revocationConfirmed: true };
  await stagePendingControlBootstrap({ baseDir: input.baseDir, artifact: updated });
  const reflected = await loadPendingControlBootstrap(input);
  if (!reflected?.revocationConfirmed) {
    throw new Error('pending_control_bootstrap_revocation_reflection_failed');
  }
  return reflected;
}

export async function stagePendingControlBootstrapRecoveryToken(input: {
  baseDir: string;
  environment: string;
  token: string;
  tokenId: string;
}): Promise<PendingControlBootstrapArtifact> {
  const artifact = await loadPendingControlBootstrap({
    baseDir: input.baseDir,
    environment: input.environment,
  });
  if (!artifact) throw new Error('pending_control_bootstrap_missing');
  if (!TOKEN_ID.test(input.tokenId) || !input.token || /\s/u.test(input.token)) {
    throw new Error('pending_control_bootstrap_recovery_token_invalid');
  }
  const previousRecoveryTokenId = artifact.recoveryToken?.tokenId;
  const revocationTargetTokenIds = [
    ...artifact.revocationTargetTokenIds,
    ...(previousRecoveryTokenId ? [previousRecoveryTokenId] : []),
  ];
  if (revocationTargetTokenIds.includes(input.tokenId)) {
    throw new Error('pending_control_bootstrap_recovery_token_reused');
  }
  const updated: PendingControlBootstrapArtifact = {
    ...artifact,
    revocationTargetTokenIds: [...new Set(revocationTargetTokenIds)],
    recoveryToken: {
      token: input.token,
      tokenId: input.tokenId,
      tokenFingerprint: fingerprint(input.token),
    },
  };
  await stagePendingControlBootstrap({ baseDir: input.baseDir, artifact: updated });
  const reflected = await loadPendingControlBootstrap({
    baseDir: input.baseDir,
    environment: input.environment,
  });
  if (
    !reflected?.recoveryToken ||
    reflected.recoveryToken.tokenId !== input.tokenId ||
    reflected.revocationTargetTokenIds.length !== updated.revocationTargetTokenIds.length ||
    !reflected.revocationTargetTokenIds.every(
      (tokenId, index) => tokenId === updated.revocationTargetTokenIds[index]
    )
  ) {
    throw new Error('pending_control_bootstrap_recovery_reflection_failed');
  }
  return reflected;
}

/**
 * Reconstructs the minimum durable recovery evidence after the original private artifact was
 * lost. The supplied Control/provider evidence must be validated by the caller before this write.
 * No provider mutation may occur until this function has fsynced and read back the artifact.
 */
export async function stageReconstructedPendingControlBootstrapRecovery(input: {
  baseDir: string;
  environment: string;
  accountId: string;
  ownership: CloudflareTokenOwnership;
  bootstrapTokenId: string;
  bootstrapTokenFingerprint: string;
  childTokens: ControlTokenBootstrapPreparedResult['childTokens'];
  secretGeneration: ControlSecretGenerationReceipt;
  recoveryToken: string;
  recoveryTokenId: string;
}): Promise<PendingControlBootstrapArtifactV2> {
  const artifact: PendingControlBootstrapArtifactV2 = {
    version: 2,
    environment: input.environment,
    accountId: input.accountId,
    ownership: input.ownership,
    bootstrapToken: null,
    bootstrapTokenId: input.bootstrapTokenId,
    bootstrapTokenFingerprint: input.bootstrapTokenFingerprint,
    childTokens: input.childTokens,
    secretGeneration: input.secretGeneration,
    revocationTargetTokenIds: [input.bootstrapTokenId],
    recoveryToken: {
      token: input.recoveryToken,
      tokenId: input.recoveryTokenId,
      tokenFingerprint: fingerprint(input.recoveryToken),
    },
    revocationConfirmed: false,
  };
  await stagePendingControlBootstrap({ baseDir: input.baseDir, artifact });
  const reflected = await loadPendingControlBootstrap({
    baseDir: input.baseDir,
    environment: input.environment,
  });
  if (
    reflected?.version !== 2 ||
    reflected.recoveryToken.tokenId !== input.recoveryTokenId ||
    reflected.bootstrapTokenId !== input.bootstrapTokenId ||
    JSON.stringify(reflected.childTokens) !== JSON.stringify(input.childTokens) ||
    JSON.stringify(reflected.secretGeneration) !== JSON.stringify(input.secretGeneration)
  ) {
    throw new Error('pending_control_bootstrap_reconstruction_reflection_failed');
  }
  return reflected;
}

export async function clearPendingControlBootstrap(input: {
  baseDir: string;
  environment: string;
}): Promise<void> {
  if (!ENVIRONMENT.test(input.environment)) {
    throw new Error('pending_control_bootstrap_environment_invalid');
  }
  await removeDurably(
    getEnvironmentPaths({ baseDir: input.baseDir, env: input.environment }).pendingControlBootstrap
  );
}
