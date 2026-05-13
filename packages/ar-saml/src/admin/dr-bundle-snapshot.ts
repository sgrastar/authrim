import type { AuthrimDRBundle } from '@authrim/ar-lib-core';
import {
  assertDRBundleContainsNoPrivateMaterial,
  createObjectCatalogEntry,
} from '@authrim/ar-lib-core';
import { requireSAMLTenantId } from '../common/tenant';

const DEFAULT_STORAGE_PREFIX = 'exports';
const DR_BUNDLE_CONTENT_TYPE = 'application/vnd.authrim.dr-bundle+json;version=1';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export type SAMLDRBundleSnapshotTrigger = 'manual' | 'scheduled';
export type SAMLDRBundleArtifactName = 'bundle' | 'manifest' | 'checksums';

export interface SAMLDRBundleStoredObject {
  name: SAMLDRBundleArtifactName;
  key: string;
  contentType: string;
  checksumSha256: string;
  bytes: number;
}

export interface SAMLDRBundleManifest {
  kind: 'authrim.dr_bundle_manifest.v1';
  objectClass: 'dr_bundle';
  bundleId: string;
  tenantId: string;
  schemaVersion: string;
  snapshotVersion: '1';
  trigger: SAMLDRBundleSnapshotTrigger;
  sequence: number;
  watermark: string;
  generatedAt: number;
  objects: SAMLDRBundleStoredObject[];
}

export interface SAMLDRBundleChecksums {
  kind: 'authrim.dr_bundle_checksums.v1';
  algorithm: 'sha256';
  bundleId: string;
  tenantId: string;
  generatedAt: number;
  checksums: Record<Exclude<SAMLDRBundleArtifactName, 'checksums'>, string>;
}

export interface SAMLDRBundleAvailableEvent {
  kind: 'authrim.event.dr_bundle.available.v1';
  eventType: 'dr_bundle.available';
  objectClass: 'dr_bundle';
  bundleId: string;
  tenantId: string;
  snapshotVersion: '1';
  trigger: SAMLDRBundleSnapshotTrigger;
  sequence: number;
  watermark: string;
  occurredAt: number;
  storage: {
    primary: 'r2';
    bucketBinding: 'EXPORT_ARTIFACTS';
    objects: SAMLDRBundleStoredObject[];
  };
}

export interface SAMLDRBundleArtifacts {
  bundle: AuthrimDRBundle;
  bundleJson: string;
  manifest: SAMLDRBundleManifest;
  manifestJson: string;
  checksums: SAMLDRBundleChecksums;
  checksumsJson: string;
  webhookEvent: SAMLDRBundleAvailableEvent;
}

export interface CreateSAMLDRBundleArtifactsInput {
  bundle: AuthrimDRBundle;
  trigger: SAMLDRBundleSnapshotTrigger;
  sequence: number;
  storagePrefix?: string;
}

export interface SAMLDRBundleExternalSink {
  id: string;
  write(artifacts: SAMLDRBundleArtifacts): Promise<void>;
}

export interface SAMLDRBundleSnapshotWriteResult {
  artifacts: SAMLDRBundleArtifacts;
  destinations: Array<{
    kind: 'r2' | 'external_sink';
    id: string;
  }>;
  objectCatalog?: {
    catalogId: string;
    publicArtifactId: string;
  };
}

export interface WriteSAMLDRBundleSnapshotInput {
  bucket?: R2Bucket;
  artifacts: SAMLDRBundleArtifacts;
  externalSinks?: SAMLDRBundleExternalSink[];
  catalogAdapter?: Parameters<typeof createObjectCatalogEntry>[0];
}

export interface SAMLDRBundleDownloadPayload {
  filename: string;
  contentType: string;
  body: string;
  checksumSha256: string;
}

export async function createSAMLDRBundleArtifacts(
  input: CreateSAMLDRBundleArtifactsInput
): Promise<SAMLDRBundleArtifacts> {
  assertDRBundleContainsNoPrivateMaterial(input.bundle);
  assertValidSequence(input.sequence);
  const tenantId = requireSAMLTenantId(input.bundle.tenantId, 'SAML DR bundle tenant');

  const storagePrefix = normalizeStoragePrefix(input.storagePrefix ?? DEFAULT_STORAGE_PREFIX);
  const objectBaseKey = [
    storagePrefix,
    sanitizeKeySegment(tenantId),
    'dr-bundles',
    sanitizeKeySegment(input.bundle.bundleId),
  ].join('/');
  const bundleJson = stableJson(input.bundle);
  const bundleChecksum = await sha256Hex(bundleJson);
  const bundleObject: SAMLDRBundleStoredObject = {
    name: 'bundle',
    key: `${objectBaseKey}/bundle.json`,
    contentType: DR_BUNDLE_CONTENT_TYPE,
    checksumSha256: bundleChecksum,
    bytes: byteLength(bundleJson),
  };
  const watermark = buildSAMLDRBundleWatermark(input.bundle.generatedAt, input.sequence);

  const manifest: SAMLDRBundleManifest = {
    kind: 'authrim.dr_bundle_manifest.v1',
    objectClass: 'dr_bundle',
    bundleId: input.bundle.bundleId,
    tenantId,
    schemaVersion: input.bundle.schemaVersion,
    snapshotVersion: '1',
    trigger: input.trigger,
    sequence: input.sequence,
    watermark,
    generatedAt: input.bundle.generatedAt,
    objects: [bundleObject],
  };
  const manifestJson = stableJson(manifest);
  const manifestObject: SAMLDRBundleStoredObject = {
    name: 'manifest',
    key: `${objectBaseKey}/manifest.json`,
    contentType: JSON_CONTENT_TYPE,
    checksumSha256: await sha256Hex(manifestJson),
    bytes: byteLength(manifestJson),
  };

  const checksums: SAMLDRBundleChecksums = {
    kind: 'authrim.dr_bundle_checksums.v1',
    algorithm: 'sha256',
    bundleId: input.bundle.bundleId,
    tenantId,
    generatedAt: input.bundle.generatedAt,
    checksums: {
      bundle: bundleObject.checksumSha256,
      manifest: manifestObject.checksumSha256,
    },
  };
  const checksumsJson = stableJson(checksums);
  const checksumsObject: SAMLDRBundleStoredObject = {
    name: 'checksums',
    key: `${objectBaseKey}/checksums.json`,
    contentType: JSON_CONTENT_TYPE,
    checksumSha256: await sha256Hex(checksumsJson),
    bytes: byteLength(checksumsJson),
  };

  const objects = [bundleObject, manifestObject, checksumsObject];
  return {
    bundle: input.bundle,
    bundleJson,
    manifest,
    manifestJson,
    checksums,
    checksumsJson,
    webhookEvent: {
      kind: 'authrim.event.dr_bundle.available.v1',
      eventType: 'dr_bundle.available',
      objectClass: 'dr_bundle',
      bundleId: input.bundle.bundleId,
      tenantId,
      snapshotVersion: '1',
      trigger: input.trigger,
      sequence: input.sequence,
      watermark,
      occurredAt: input.bundle.generatedAt,
      storage: {
        primary: 'r2',
        bucketBinding: 'EXPORT_ARTIFACTS',
        objects,
      },
    },
  };
}

export async function writeSAMLDRBundleSnapshot(
  input: WriteSAMLDRBundleSnapshotInput
): Promise<SAMLDRBundleSnapshotWriteResult> {
  const destinations: SAMLDRBundleSnapshotWriteResult['destinations'] = [];

  if (input.bucket) {
    await writeSAMLDRBundleArtifactsToR2(input.bucket, input.artifacts);
    destinations.push({ kind: 'r2', id: 'EXPORT_ARTIFACTS' });
  }

  for (const sink of input.externalSinks ?? []) {
    await sink.write(input.artifacts);
    destinations.push({ kind: 'external_sink', id: sink.id });
  }

  const objectCatalog = input.catalogAdapter
    ? await createObjectCatalogEntry(input.catalogAdapter, {
        id: input.artifacts.bundle.bundleId,
        tenantId: input.artifacts.bundle.tenantId,
        objectClass: 'dr_bundle',
        createdAt: input.artifacts.bundle.generatedAt,
        objects: input.artifacts.webhookEvent.storage.objects.map((object, index) => ({
          representation: 'canonical_json',
          objectKind: index === 0 ? 'single' : 'manifest',
          objectIndex: index,
          bucketBinding: 'EXPORT_ARTIFACTS',
          objectKey: object.key,
          keyVersion: 1,
          checksumSha256: object.checksumSha256,
          totalBytes: object.bytes,
        })),
      })
    : undefined;

  return {
    artifacts: input.artifacts,
    destinations,
    objectCatalog,
  };
}

export async function writeSAMLDRBundleArtifactsToR2(
  bucket: R2Bucket,
  artifacts: SAMLDRBundleArtifacts
): Promise<void> {
  const objects = artifacts.webhookEvent.storage.objects;
  await Promise.all([
    putJsonObject(bucket, objects[0], artifacts.bundleJson),
    putJsonObject(bucket, objects[1], artifacts.manifestJson),
    putJsonObject(bucket, objects[2], artifacts.checksumsJson),
  ]);
}

export async function createSAMLDRBundleDownloadPayload(
  bundle: AuthrimDRBundle
): Promise<SAMLDRBundleDownloadPayload> {
  assertDRBundleContainsNoPrivateMaterial(bundle);
  const tenantId = requireSAMLTenantId(bundle.tenantId, 'SAML DR bundle tenant');
  const body = stableJson(bundle);
  return {
    filename: `${sanitizeKeySegment(tenantId)}-${sanitizeKeySegment(bundle.bundleId)}.dr-bundle.json`,
    contentType: DR_BUNDLE_CONTENT_TYPE,
    body,
    checksumSha256: await sha256Hex(body),
  };
}

export function buildSAMLDRBundleWatermark(generatedAt: number, sequence: number): string {
  assertValidSequence(sequence);
  return `${generatedAt.toString(10)}-${sequence.toString().padStart(12, '0')}`;
}

async function putJsonObject(
  bucket: R2Bucket,
  object: SAMLDRBundleStoredObject | undefined,
  body: string
): Promise<void> {
  if (!object) {
    throw new Error('Missing DR bundle object descriptor');
  }

  await bucket.put(object.key, body, {
    httpMetadata: {
      contentType: object.contentType,
    },
    customMetadata: {
      checksumSha256: object.checksumSha256,
      objectClass: 'dr_bundle',
    },
  });
}

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeStoragePrefix(prefix: string): string {
  return prefix
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map(sanitizeKeySegment)
    .join('/');
}

function sanitizeKeySegment(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '_');
}

function assertValidSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('SAML DR bundle sequence must be a positive safe integer');
  }
}
