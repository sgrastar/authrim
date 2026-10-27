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
import {
  SAML_DR_RUNTIME_STATE_DATASET,
  type SamlDrFrozenSourceCapture,
  type SamlDrSnapshotPayload,
} from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-snapshot';
import { buildCoreAccountRouteGenerations } from './core-route-generations';
import type { VerifiedTenantBackupV2 } from './backup-reader';
import {
  readPinnedRestoreFile,
  canonicalRestoreJson,
  restoreEvidenceDigest,
} from './restore-evidence';
import { deriveAwsStateSourceExpectations } from './state-source-expectations';
import type { VerifiedAwsSamlSupplement } from './runtime-assembly-input';
import {
  assertVerifiedAwsStateSource,
  awsStateSupplementPayloadSha256,
  type VerifiedAwsStateSupplement,
} from './state-restore';
import { readVerifiedRows, rowInteger, rowNullableText, rowText } from './verified-rows';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';

import { isAwsUiOrigin } from '../ui/runtime-ui-config';

const SHA256 = /^[a-f0-9]{64}$/u;
const CATEGORY = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;

type SourceCapturePayload = SamlDrSnapshotPayload;

/** Compatibility alias; the snapshot contract is shared by all runtime backends. */
export type AwsSamlFrozenSourceCapture = SamlDrFrozenSourceCapture;

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
  if (source && 'mode' in source) {
    exactKeys(source, ['mode']);
    if (source.mode !== 'disabled') invalid();
    return;
  }
  exactKeys(source, ['client', 'origins']);
  if (!isArray(source.origins) || source.origins.length !== 1) invalid();
  if (
    rowText(source.client, 'tenant_id') !== manifest.source.tenantId ||
    !/^[A-Za-z0-9_.:-]{1,128}$/u.test(rowText(source.client, 'client_id')) ||
    rowText(source.client, 'application_type') !== 'web' ||
    rowNullableText(source.client, 'client_secret_hash') !== null ||
    rowNullableText(source.client, 'logout_webhook_secret_encrypted') !== null ||
    rowText(source.origins[0], 'tenant_id') !== manifest.source.tenantId ||
    rowText(source.origins[0], 'client_id') !== rowText(source.client, 'client_id') ||
    !isAwsUiOrigin(rowText(source.origins[0], 'origin')) ||
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
      typeof payload.sourceFlowRuntimeEnabled !== 'boolean' ||
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

/** Extract only the installed, authenticated logical state dataset from a verified bundle. */
export async function readEmbeddedSamlDrCapture(
  backup: VerifiedTenantBackupV2
): Promise<SamlDrFrozenSourceCapture> {
  try {
    const expected = SAML_DR_RUNTIME_STATE_DATASET;
    const found = backup.manifest.datasets.filter(({ id }) => id === expected.id);
    if (found.length !== 1) invalid();
    for (const key of Object.keys(expected) as Array<keyof typeof expected>)
      if (found[0][key] !== expected[key]) invalid();
    const dataset = backup.dataset(expected.id);
    if (dataset.rows !== 1 || dataset.bytes > MAX_CAPTURE_BYTES) invalid();
    const row = await dataset.readNextRow(null);
    if (!row || !row.nextCursor || (await dataset.readNextRow(row.nextCursor)) !== null) invalid();
    const value = JSON.parse(row.rowJson) as Record<string, unknown>;
    exactKeys(value, ['tenant_id', 'capture_json']);
    if (rowText(value as PortableSqliteRow, 'tenant_id') !== backup.manifest.source.tenantId)
      invalid();
    const raw = rowText(value as PortableSqliteRow, 'capture_json');
    if (new TextEncoder().encode(raw).byteLength > MAX_CAPTURE_BYTES) invalid();
    const capture = JSON.parse(raw) as SamlDrFrozenSourceCapture;
    if (canonicalRestoreJson(capture) !== raw) invalid();
    captureIdentity(capture, backup.manifest);
    return capture;
  } catch {
    return invalid();
  }
}

/** Derive a supplement from the same authenticated backup; no sidecar provenance is needed. */
export async function collectAwsSamlSupplementFromBackup(input: {
  backup: VerifiedTenantBackupV2;
  outputPath: string;
}): Promise<AwsSamlSupplementCollectionReceipt> {
  const capture = await readEmbeddedSamlDrCapture(input.backup);
  const supplement = await buildAwsSamlSupplementFromFrozenCapture({
    backup: input.backup,
    capture,
  });
  return writeCollectedSupplement(input.outputPath, supplement);
}

/** Reads a separately pinned legacy capture without changing its trust requirements. */
export async function collectAwsSamlSupplementFromPinnedCapture(input: {
  backup: VerifiedTenantBackupV2;
  capturePath: string;
  expectedCaptureSha256: string;
  outputPath: string;
}): Promise<AwsSamlSupplementCollectionReceipt> {
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
    return await writeCollectedSupplement(input.outputPath, supplement);
  } catch {
    return invalid();
  }
}

async function writeCollectedSupplement(
  outputPath: string,
  supplement: AwsSamlCollectedSupplement
): Promise<AwsSamlSupplementCollectionReceipt> {
  let created: { dev: bigint; ino: bigint } | null = null;
  try {
    const output = canonicalRestoreJson(supplement);
    const outputBytes = new TextEncoder().encode(output);
    if (outputBytes.length > MAX_CAPTURE_BYTES) invalid();
    if (!isAbsolute(outputPath) || resolve(outputPath) !== outputPath) invalid();
    if ((await realpath(dirname(outputPath))) !== dirname(outputPath)) invalid();
    const file = await open(
      outputPath,
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
    await readPinnedRestoreFile(outputPath, outputSha256, MAX_CAPTURE_BYTES);
    return {
      outputPath: outputPath,
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
      const observed = await lstat(outputPath, { bigint: true }).catch(() => null);
      if (observed?.dev === created.dev && observed.ino === created.ino) {
        await unlink(outputPath).catch(() => undefined);
      }
    }
    return invalid();
  }
}
