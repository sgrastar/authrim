import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  generateVersion,
  settingsStorageKey,
  validateAccountRouteProjection,
} from '@authrim/ar-lib-core';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import { buildCoreAccountRouteGenerations } from './core-route-generations';
import type { VerifiedTenantBackupV2 } from './backup-reader';
import {
  readPinnedRestoreFile,
  canonicalRestoreJson,
  restoreEvidenceDigest,
} from './restore-evidence';
import { deriveAwsStateSourceExpectations } from './restore-offline';
import type { VerifiedAwsSamlSupplement } from './runtime-assembly-input';
import {
  assertVerifiedAwsStateSource,
  awsStateSupplementPayloadSha256,
  type VerifiedAwsStateSupplement,
} from './state-restore';
import { readVerifiedRows, rowInteger, rowNullableText, rowText } from './verified-rows';

const SHA256 = /^[a-f0-9]{64}$/u;
const CATEGORY = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;

type SourceCapturePayload = Omit<VerifiedAwsSamlSupplement, 'receipt' | 'state'> & {
  state: Omit<VerifiedAwsStateSupplement, 'receipt'>;
};

/**
 * A separately pinned, frozen source capture. Its provenance is supplied by the operator;
 * this shape alone cannot prove that Cloudflare read it under the bundle's boundary hold.
 */
export interface AwsSamlFrozenSourceCapture {
  formatVersion: 1;
  source: Pick<
    TenantBundleManifest,
    'bundleId' | 'snapshotId' | 'boundaryUnixMs' | 'inventoryDigestSha256' | 'source'
  >;
  completeness: {
    accountAuthStates: true;
    passkeyCounters: true;
    persistentNameIds: true;
    sourceLoginUi: true;
    platformDestinationProfiles: true;
    accountRoutes: true;
    platformSettings: true;
    sourceRuntimeSettings: true;
  };
  payload: SourceCapturePayload;
}

export interface AwsSamlCollectedSupplement {
  formatVersion: 1;
  receipt: VerifiedAwsSamlSupplement['receipt'];
  payload: Omit<VerifiedAwsSamlSupplement, 'receipt'>;
}

export interface AwsSamlSupplementCollectionReceipt {
  outputPath: string;
  outputSha256: string;
  supplementSha256: string;
  tenantId: string;
  bundleId: string;
  snapshotId: string;
  accountAuthStates: number;
  passkeyCounters: number;
  persistentNameIds: number;
}

function invalid(): never {
  // Source capture and supplement can contain credentials. Never include values in an error.
  throw new Error('aws_supplement_collector_invalid');
}

function exactKeys(value: unknown, expected: readonly string[]): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...expected].sort().join(',')
  )
    invalid();
}

function isArray(value: unknown): boolean {
  return Array.isArray(value);
}

function captureIdentity(capture: AwsSamlFrozenSourceCapture, manifest: TenantBundleManifest) {
  exactKeys(capture, ['formatVersion', 'source', 'completeness', 'payload']);
  exactKeys(capture.source, [
    'bundleId',
    'snapshotId',
    'boundaryUnixMs',
    'inventoryDigestSha256',
    'source',
  ]);
  exactKeys(capture.source.source, ['tenantId', 'issuer', 'productVersion']);
  exactKeys(capture.completeness, [
    'accountAuthStates',
    'passkeyCounters',
    'persistentNameIds',
    'sourceLoginUi',
    'platformDestinationProfiles',
    'accountRoutes',
    'platformSettings',
    'sourceRuntimeSettings',
  ]);
  if (
    capture.formatVersion !== 1 ||
    capture.source.bundleId !== manifest.bundleId ||
    capture.source.snapshotId !== manifest.snapshotId ||
    capture.source.boundaryUnixMs !== manifest.boundaryUnixMs ||
    capture.source.inventoryDigestSha256 !== manifest.inventoryDigestSha256 ||
    capture.source.source.tenantId !== manifest.source.tenantId ||
    capture.source.source.issuer !== manifest.source.issuer ||
    capture.source.source.productVersion !== manifest.source.productVersion ||
    Object.values(capture.completeness).some((value) => value !== true)
  )
    invalid();
}

function validateSourceLoginUi(
  source: SourceCapturePayload['sourceLoginUi'],
  manifest: TenantBundleManifest
): void {
  exactKeys(source, ['client', 'origins']);
  if (!isArray(source.origins) || source.origins.length !== 1) invalid();
  if (
    rowText(source.client, 'tenant_id') !== manifest.source.tenantId ||
    rowText(source.client, 'client_id') !== 'login-ui' ||
    rowText(source.client, 'application_type') !== 'web' ||
    rowNullableText(source.client, 'client_secret_hash') !== null ||
    rowNullableText(source.client, 'logout_webhook_secret_encrypted') !== null ||
    rowText(source.origins[0], 'tenant_id') !== manifest.source.tenantId ||
    rowText(source.origins[0], 'client_id') !== 'login-ui' ||
    rowText(source.origins[0], 'origin') !== manifest.source.issuer ||
    rowInteger(source.origins[0], 'handoff_allowed') !== 1 ||
    rowInteger(source.origins[0], 'is_active') !== 1
  )
    invalid();
  const channels = JSON.parse(rowText(source.client, 'allowed_channels')) as unknown;
  if (!Array.isArray(channels) || !channels.includes('browser')) invalid();
}

function validatePlatformSettings(settings: SourceCapturePayload['platformSettings']): void {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) invalid();
  for (const [category, entry] of Object.entries(settings)) {
    exactKeys(entry, ['documentJson', 'version']);
    if (!CATEGORY.test(category) || typeof entry.documentJson !== 'string') invalid();
    const document = JSON.parse(entry.documentJson) as unknown;
    if (
      !document ||
      typeof document !== 'object' ||
      Array.isArray(document) ||
      generateVersion(document as Record<string, unknown>) !== entry.version
    )
      invalid();
    settingsStorageKey(category, { type: 'platform' });
  }
}

async function validateRoutes(
  backup: VerifiedTenantBackupV2,
  routes: SourceCapturePayload['accountRoutes']
): Promise<void> {
  if (!routes || typeof routes !== 'object' || Array.isArray(routes)) invalid();
  const accounts = await readVerifiedRows(backup, 'core.identity_accounts');
  const generations = buildCoreAccountRouteGenerations(backup.manifest.source.tenantId, accounts);
  const keys = Object.keys(routes).sort();
  const expected = Object.keys(generations).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    invalid();
  for (const [accountId, generation] of Object.entries(generations)) {
    const route = validateAccountRouteProjection(routes[accountId]);
    if (route.accountRouteGeneration !== generation || route.targets.length !== 2) invalid();
    for (const role of ['tenant_core/users', 'tenant_pii'] as const) {
      if (route.targets.filter((target) => target.dataRole === role).length !== 1) invalid();
    }
  }
}

/**
 * Converts one already frozen capture into the exact offline import supplement format.
 * The caller must independently authenticate the capture and its boundary completeness.
 */
export async function buildAwsSamlSupplementFromFrozenCapture(input: {
  backup: VerifiedTenantBackupV2;
  capture: AwsSamlFrozenSourceCapture;
}): Promise<AwsSamlCollectedSupplement> {
  try {
    const manifest = input.backup.manifest;
    const capture = structuredClone(input.capture);
    captureIdentity(capture, manifest);
    const payload = capture.payload;
    const payloadKeys = [
      'sourceLoginUi',
      'platformDestinationProfiles',
      'state',
      'accountRoutes',
      'platformSettings',
      'sourceFlowRuntimeEnabled',
      'consentIpSalt',
    ];
    if (Object.hasOwn(payload, 'sourcePairwiseFallbackSecret'))
      payloadKeys.push('sourcePairwiseFallbackSecret');
    exactKeys(payload, payloadKeys);
    exactKeys(payload.platformDestinationProfiles, ['profiles', 'versions']);
    exactKeys(payload.state, [
      'accountAuthStates',
      'passkeyCounters',
      'persistentNameIdsComplete',
      'persistentNameIds',
    ]);
    if (
      !manifest.selection.settings ||
      !manifest.selection.users ||
      payload.sourceFlowRuntimeEnabled !== true ||
      !Array.isArray(payload.platformDestinationProfiles.profiles) ||
      !Array.isArray(payload.platformDestinationProfiles.versions) ||
      typeof payload.consentIpSalt !== 'string' ||
      payload.consentIpSalt.length < 32 ||
      (payload.sourcePairwiseFallbackSecret !== undefined &&
        (typeof payload.sourcePairwiseFallbackSecret !== 'string' ||
          payload.sourcePairwiseFallbackSecret.length < 32))
    )
      invalid();
    validateSourceLoginUi(payload.sourceLoginUi, manifest);
    validatePlatformSettings(payload.platformSettings);
    await validateRoutes(input.backup, payload.accountRoutes);
    const state: VerifiedAwsStateSupplement = {
      ...payload.state,
      receipt: {
        tenantId: manifest.source.tenantId,
        issuer: manifest.source.issuer,
        productVersion: manifest.source.productVersion,
        bundleId: manifest.bundleId,
        snapshotId: manifest.snapshotId,
        inventoryDigestSha256: manifest.inventoryDigestSha256,
        supplementSha256: '',
      },
    };
    state.receipt.supplementSha256 = awsStateSupplementPayloadSha256(state);
    assertVerifiedAwsStateSource({
      manifest,
      supplement: state,
      expected: await deriveAwsStateSourceExpectations(input.backup),
    });
    const finalPayload: AwsSamlCollectedSupplement['payload'] = { ...payload, state };
    const receipt: VerifiedAwsSamlSupplement['receipt'] = {
      tenantId: manifest.source.tenantId,
      issuer: manifest.source.issuer,
      productVersion: manifest.source.productVersion,
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
      inventoryDigestSha256: manifest.inventoryDigestSha256,
      supplementSha256: restoreEvidenceDigest(finalPayload),
    };
    return { formatVersion: 1, receipt, payload: finalPayload };
  } catch {
    return invalid();
  }
}

/** Reads a separately pinned capture and writes a mode-0600, non-overwriting import input. */
export async function collectAwsSamlSupplementFromPinnedCapture(input: {
  backup: VerifiedTenantBackupV2;
  capturePath: string;
  expectedCaptureSha256: string;
  outputPath: string;
}): Promise<AwsSamlSupplementCollectionReceipt> {
  let created: { dev: bigint; ino: bigint } | null = null;
  try {
    if (!SHA256.test(input.expectedCaptureSha256)) invalid();
    const sourceBefore = await lstat(input.capturePath, { bigint: true });
    if (!sourceBefore.isFile() || (sourceBefore.mode & 0o077n) !== 0n) invalid();
    const bytes = await readPinnedRestoreFile(
      input.capturePath,
      input.expectedCaptureSha256,
      MAX_CAPTURE_BYTES
    );
    const sourceAfter = await lstat(input.capturePath, { bigint: true });
    if (
      sourceAfter.dev !== sourceBefore.dev ||
      sourceAfter.ino !== sourceBefore.ino ||
      sourceAfter.mode !== sourceBefore.mode
    )
      invalid();
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const capture = JSON.parse(raw) as AwsSamlFrozenSourceCapture;
    if (canonicalRestoreJson(capture) !== raw) invalid();
    const supplement = await buildAwsSamlSupplementFromFrozenCapture({
      backup: input.backup,
      capture,
    });
    const output = canonicalRestoreJson(supplement);
    const outputBytes = new TextEncoder().encode(output);
    if (outputBytes.length > MAX_CAPTURE_BYTES) invalid();
    if (!isAbsolute(input.outputPath) || resolve(input.outputPath) !== input.outputPath) invalid();
    if ((await realpath(dirname(input.outputPath))) !== dirname(input.outputPath)) invalid();
    const file = await open(
      input.outputPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      const identity = await file.stat({ bigint: true });
      created = { dev: identity.dev, ino: identity.ino };
      await file.writeFile(outputBytes);
      await file.sync();
    } finally {
      await file.close();
    }
    const outputSha256 = createHash('sha256').update(outputBytes).digest('hex');
    await readPinnedRestoreFile(input.outputPath, outputSha256, MAX_CAPTURE_BYTES);
    return {
      outputPath: input.outputPath,
      outputSha256,
      supplementSha256: supplement.receipt.supplementSha256,
      tenantId: supplement.receipt.tenantId,
      bundleId: supplement.receipt.bundleId,
      snapshotId: supplement.receipt.snapshotId,
      accountAuthStates: supplement.payload.state.accountAuthStates.length,
      passkeyCounters: supplement.payload.state.passkeyCounters.length,
      persistentNameIds: supplement.payload.state.persistentNameIds.length,
    };
  } catch {
    if (created) {
      const observed = await lstat(input.outputPath, { bigint: true }).catch(() => null);
      if (observed?.dev === created.dev && observed.ino === created.ino) {
        await unlink(input.outputPath).catch(() => undefined);
      }
    }
    return invalid();
  }
}
