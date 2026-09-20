import {
  parseTenantBackupSelection,
  tenantBackupSelectionIsSubset,
  tenantDatasetSelectionRule,
  type TenantBackupSelection,
  type TenantPortableSourceIdentity,
} from './selection-contract';
import { TENANT_PORTABILITY_MODULES, type TenantPortableDataset } from './module-contract';

export const TENANT_BUNDLE_MANIFEST_MAX_BYTES = 262_144;
const MAX_DATASETS = 4096;

export interface TenantBundleManifest {
  formatVersion: 1;
  bundleId: string;
  source: TenantPortableSourceIdentity;
  snapshotId: string;
  boundaryUnixMs: number;
  inventoryDigestSha256: string;
  selection: TenantBackupSelection;
  datasets: TenantPortableDataset[];
}

/** Obtained from the authorized operation and installed adapters, not the upload. */
export interface TenantBundleManifestExpectation {
  bundleId: string;
  source: TenantPortableSourceIdentity;
  selection: TenantBackupSelection;
  datasets: readonly TenantPortableDataset[];
}

export class TenantBundleManifestError extends Error {
  constructor() {
    super('invalid_tenant_bundle_manifest');
    this.name = 'TenantBundleManifestError';
  }
}
function invalid(): never {
  throw new TenantBundleManifestError();
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(record, key))
  )
    invalid();
  return record;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    invalid();
  return value;
}
function logicalId(value: unknown): string {
  const id = text(value, 256);
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.:-]*$/.test(id) || id.includes('..')) invalid();
  return id;
}

function validate(
  value: unknown,
  expected: TenantBundleManifestExpectation,
  selectionMode: 'exact' | 'subset' = 'exact'
): TenantBundleManifest {
  const root = object(value, [
    'formatVersion',
    'bundleId',
    'source',
    'snapshotId',
    'boundaryUnixMs',
    'inventoryDigestSha256',
    'selection',
    'datasets',
  ]);
  if (root.formatVersion !== 1) invalid();
  const bundleId = text(root.bundleId, 32);
  if (!/^[0-9a-f]{32}$/.test(bundleId) || bundleId !== expected.bundleId) invalid();
  const source = object(root.source, ['tenantId', 'issuer', 'productVersion']);
  const identity = {
    tenantId: text(source.tenantId, 128),
    issuer: text(source.issuer, 4096),
    productVersion: text(source.productVersion, 128),
  };
  if (
    identity.tenantId !== expected.source.tenantId ||
    identity.issuer !== expected.source.issuer ||
    identity.productVersion !== expected.source.productVersion
  )
    invalid();
  const snapshotId = logicalId(root.snapshotId);
  if (!Number.isSafeInteger(root.boundaryUnixMs) || (root.boundaryUnixMs as number) < 0) invalid();
  const digest = text(root.inventoryDigestSha256, 64);
  if (!/^[0-9a-f]{64}$/.test(digest)) invalid();
  let selection: TenantBackupSelection;
  try {
    selection = parseTenantBackupSelection(root.selection);
    if (
      selectionMode === 'exact'
        ? JSON.stringify(selection) !==
          JSON.stringify(parseTenantBackupSelection(expected.selection))
        : !tenantBackupSelectionIsSubset(selection, expected.selection)
    )
      invalid();
  } catch {
    invalid();
  }
  if (
    !Array.isArray(root.datasets) ||
    root.datasets.length === 0 ||
    root.datasets.length > MAX_DATASETS ||
    root.datasets.length !==
      (selectionMode === 'exact'
        ? expected.datasets.length
        : expected.datasets.filter(({ kind }) => {
            const rule = tenantDatasetSelectionRule(kind, selection);
            return rule.action === 'selected' || rule.action === 'resolve_references';
          }).length)
  )
    invalid();
  const expectedDatasets =
    selectionMode === 'exact'
      ? expected.datasets
      : expected.datasets.filter(({ kind }) => {
          const rule = tenantDatasetSelectionRule(kind, selection);
          return rule.action === 'selected' || rule.action === 'resolve_references';
        });
  if (new Set(expected.datasets.map(({ id }) => id)).size !== expected.datasets.length) invalid();
  const installed = new Map(expectedDatasets.map((dataset) => [dataset.id, dataset]));
  if (installed.size !== expectedDatasets.length) invalid();
  const seen = new Set<string>();
  const datasets = root.datasets.map((value) => {
    const entry = object(value, ['id', 'module', 'kind', 'store', 'schemaVersion', 'disposition']);
    const id = logicalId(entry.id);
    const supported = installed.get(id);
    if (
      !supported ||
      seen.has(id) ||
      !(TENANT_PORTABILITY_MODULES as readonly string[]).includes(supported.module) ||
      supported.disposition === 'unsupported' ||
      !Number.isSafeInteger(supported.schemaVersion) ||
      supported.schemaVersion < 1
    )
      invalid();
    seen.add(id);
    for (const field of ['module', 'kind', 'store', 'schemaVersion', 'disposition'] as const) {
      if (entry[field] !== supported[field]) invalid();
    }
    if (tenantDatasetSelectionRule(supported.kind, selection).action === 'excluded') invalid();
    return {
      id,
      module: supported.module,
      kind: supported.kind,
      store: supported.store,
      schemaVersion: supported.schemaVersion,
      disposition: supported.disposition,
    };
  });
  return {
    formatVersion: 1,
    bundleId,
    source: identity,
    snapshotId,
    boundaryUnixMs: root.boundaryUnixMs as number,
    inventoryDigestSha256: digest,
    selection,
    datasets,
  };
}

/** Decode one input contributing a strict subset of a combined import request. */
export function decodeTenantBundleImportManifest(
  bytes: Uint8Array,
  expected: TenantBundleManifestExpectation
): TenantBundleManifest {
  if (!(bytes instanceof Uint8Array) || bytes.length > TENANT_BUNDLE_MANIFEST_MAX_BYTES) invalid();
  try {
    const encoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const manifest = validate(JSON.parse(encoded), expected, 'subset');
    if (JSON.stringify(manifest) !== encoded) invalid();
    return manifest;
  } catch {
    invalid();
  }
}

/** Canonicalize one input manifest while allowing it to contribute a category subset. */
export function encodeTenantBundleImportManifest(
  manifest: TenantBundleManifest,
  expected: TenantBundleManifestExpectation
): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(validate(manifest, expected, 'subset')));
  if (bytes.length > TENANT_BUNDLE_MANIFEST_MAX_BYTES) invalid();
  return bytes;
}

/** Bounded, canonical UTF-8. Duplicate JSON keys and alternate representations fail. */
export function decodeTenantBundleManifest(
  bytes: Uint8Array,
  expected: TenantBundleManifestExpectation
): TenantBundleManifest {
  if (!(bytes instanceof Uint8Array) || bytes.length > TENANT_BUNDLE_MANIFEST_MAX_BYTES) invalid();
  try {
    const encoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const manifest = validate(JSON.parse(encoded), expected);
    if (JSON.stringify(manifest) !== encoded) invalid();
    return manifest;
  } catch {
    invalid();
  }
}

export function encodeTenantBundleManifest(
  manifest: TenantBundleManifest,
  expected: TenantBundleManifestExpectation
): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(validate(manifest, expected)));
  if (bytes.length > TENANT_BUNDLE_MANIFEST_MAX_BYTES) invalid();
  return bytes;
}
