import { deriveTenantBundleStreamKey, type TenantBundleKeyEnvelope } from './bundle-key-envelope';
import { tenantBundleCipherParameters } from './bundle-cipher-parameters';
import type { TenantBundleManifest } from './bundle-manifest';

const MAGIC = new TextEncoder().encode('AUTHRIM2');
const HEADER_BYTES = 8 + 93 + 32;
const SINGLE_OBJECT_DATA_BYTES = 16 * 1024 * 1024;
const CAPACITY_PART_BYTES = 12 * 1024 * 1024;
const MAX_CONTAINER_BYTES = 256 * 1024 * 1024;

export interface TenantBackupContainerDatasetV2 {
  id: string;
  rows: number;
  bytes: number;
  sha256: string;
  offset: number;
}

export interface TenantBackupContainerManifestV2 {
  formatVersion: 2;
  backup: TenantBundleManifest;
  datasets: TenantBackupContainerDatasetV2[];
  totalRows: number;
  totalBytes: number;
  dataSha256: string;
}

export interface TenantBackupContainerFooterV2 {
  formatVersion: 2;
  datasets: number;
  dataFrames: number;
  totalRows: number;
  totalBytes: number;
  dataSha256: string;
  manifestSha256: string;
}

export interface TenantBackupContainerDatasetSourceV2 {
  datasetId: string;
  chunks: AsyncIterable<Uint8Array>;
}

export interface EncodedTenantBackupContainerV2 {
  manifest: TenantBackupContainerManifestV2;
  footer: TenantBackupContainerFooterV2;
  /** One R2 object for normal backups; capacity parts only when plaintext exceeds 16 MiB. */
  parts: Uint8Array[];
}

function invalid(): never {
  throw new Error('invalid_tenant_backup_container_v2');
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))));
}

function join(
  chunks: readonly Uint8Array[],
  total = chunks.reduce((sum, value) => sum + value.length, 0)
) {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function records(bytes: Uint8Array): number {
  if (!bytes.length) return 0;
  let rows = bytes[bytes.length - 1] === 10 ? 0 : 1;
  for (const byte of bytes) if (byte === 10) rows++;
  return rows;
}

function frame(sequence: number, type: 1 | 2, encrypted: Uint8Array): Uint8Array {
  const output = new Uint8Array(9 + encrypted.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, output.length - 4);
  view.setUint32(4, sequence);
  output[8] = type;
  output.set(encrypted, 9);
  return output;
}

function canonicalMetadata(
  manifest: TenantBackupContainerManifestV2,
  footer: TenantBackupContainerFooterV2
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ manifest, footer }));
}

function validateSession(session: TenantBundleKeyEnvelope, manifest: TenantBundleManifest): void {
  if (
    session.envelope.length !== 93 ||
    session.envelope[0] !== 1 ||
    hex(session.envelope.subarray(1, 17)) !== manifest.bundleId
  )
    invalid();
}

/**
 * Build the unpublished v2 container. The normal path has one R2 object and no row/event
 * checkpoint. Large inputs are split only at capacity boundaries; crypto frames stay internal.
 */
export async function encodeTenantBackupContainerV2(input: {
  manifest: TenantBundleManifest;
  datasets: AsyncIterable<TenantBackupContainerDatasetSourceV2>;
  session: TenantBundleKeyEnvelope;
  signal?: AbortSignal;
  /** Stable per-attempt salt makes retries byte-identical against the immutable T0 snapshot. */
  streamSalt?: Uint8Array;
}): Promise<EncodedTenantBackupContainerV2> {
  validateSession(input.session, input.manifest);
  const expected = input.manifest.datasets;
  const seen = new Set<string>();
  const allData: Uint8Array[] = [];
  const datasetStats: TenantBackupContainerDatasetV2[] = [];
  let totalBytes = 0;
  let totalRows = 0;
  for await (const source of input.datasets) {
    input.signal?.throwIfAborted();
    const descriptor = expected[datasetStats.length];
    if (!descriptor || descriptor.id !== source.datasetId || seen.has(source.datasetId)) invalid();
    seen.add(source.datasetId);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of source.chunks) {
      input.signal?.throwIfAborted();
      if (!(chunk instanceof Uint8Array) || !chunk.length) invalid();
      bytes += chunk.length;
      if (!Number.isSafeInteger(bytes) || totalBytes + bytes > MAX_CONTAINER_BYTES) invalid();
      chunks.push(new Uint8Array(chunk));
    }
    const data = join(chunks, bytes);
    const rows = records(data);
    datasetStats.push({
      id: source.datasetId,
      rows,
      bytes,
      sha256: await sha256(data),
      offset: totalBytes,
    });
    if (bytes) allData.push(data);
    totalBytes += bytes;
    totalRows += rows;
  }
  if (seen.size !== expected.length) invalid();
  const data = join(allData, totalBytes);
  const dataSha256 = await sha256(data);
  const manifest: TenantBackupContainerManifestV2 = {
    formatVersion: 2,
    backup: structuredClone(input.manifest),
    datasets: datasetStats,
    totalRows,
    totalBytes,
    dataSha256,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const dataFrames = Math.max(1, Math.ceil(data.length / CAPACITY_PART_BYTES));
  const footer: TenantBackupContainerFooterV2 = {
    formatVersion: 2,
    datasets: datasetStats.length,
    dataFrames,
    totalRows,
    totalBytes,
    dataSha256,
    manifestSha256: await sha256(manifestBytes),
  };
  const salt = input.streamSalt
    ? new Uint8Array(input.streamSalt)
    : crypto.getRandomValues(new Uint8Array(32));
  if (salt.length !== 32) invalid();
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC);
  header.set(input.session.envelope, 8);
  header.set(salt, 101);
  const headerHash = new Uint8Array(await crypto.subtle.digest('SHA-256', header));
  const key = await deriveTenantBundleStreamKey(input.session.contentKey, salt);
  const frames: Uint8Array[] = [];
  for (let sequence = 0; sequence < dataFrames; sequence++) {
    const plain = data.subarray(
      sequence * CAPACITY_PART_BYTES,
      Math.min((sequence + 1) * CAPACITY_PART_BYTES, data.length)
    );
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(tenantBundleCipherParameters(headerHash, sequence, 1), key, plain)
    );
    frames.push(frame(sequence, 1, encrypted));
  }
  const metadata = canonicalMetadata(manifest, footer);
  const metadataSequence = dataFrames;
  const encryptedMetadata = new Uint8Array(
    await crypto.subtle.encrypt(
      tenantBundleCipherParameters(headerHash, metadataSequence, 2),
      key,
      Uint8Array.from(metadata)
    )
  );
  frames.push(frame(metadataSequence, 2, encryptedMetadata));

  const single = join([header, ...frames]);
  if (single.length <= SINGLE_OBJECT_DATA_BYTES) return { manifest, footer, parts: [single] };

  const parts: Uint8Array[] = [];
  let pending: Uint8Array[] = [header];
  let pendingBytes = header.length;
  for (const value of frames) {
    if (pendingBytes > HEADER_BYTES && pendingBytes + value.length > CAPACITY_PART_BYTES) {
      parts.push(join(pending, pendingBytes));
      pending = [];
      pendingBytes = 0;
    }
    pending.push(value);
    pendingBytes += value.length;
  }
  if (pendingBytes) parts.push(join(pending, pendingBytes));
  return { manifest, footer, parts };
}

export interface DecodedTenantBackupContainerV2 {
  manifest: TenantBackupContainerManifestV2;
  footer: TenantBackupContainerFooterV2;
  datasets: Map<string, Uint8Array>;
}

/** Authenticate the whole container before exposing dataset bytes to a restore plan. */
export async function decodeTenantBackupContainerV2(input: {
  parts: readonly Uint8Array[];
  session: TenantBundleKeyEnvelope;
}): Promise<DecodedTenantBackupContainerV2> {
  if (
    !input.parts.length ||
    input.parts.some((part) => !(part instanceof Uint8Array) || !part.length)
  )
    invalid();
  const bytes = join(input.parts);
  if (bytes.length < HEADER_BYTES + 9 + 16 || bytes.length > MAX_CONTAINER_BYTES + 1024 * 1024)
    invalid();
  if (!MAGIC.every((byte, index) => bytes[index] === byte)) invalid();
  const envelope = bytes.subarray(8, 101);
  if (
    input.session.envelope.length !== envelope.length ||
    !envelope.every((byte, index) => byte === input.session.envelope[index])
  )
    invalid();
  const header = bytes.subarray(0, HEADER_BYTES);
  const salt = bytes.subarray(101, HEADER_BYTES);
  const headerHash = new Uint8Array(await crypto.subtle.digest('SHA-256', header));
  const key = await deriveTenantBundleStreamKey(input.session.contentKey, salt);
  const plainData: Uint8Array[] = [];
  let metadata: Uint8Array | null = null;
  let offset = HEADER_BYTES;
  let sequence = 0;
  let dataFrames = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 9) invalid();
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.length - offset);
    const length = view.getUint32(0);
    const savedSequence = view.getUint32(4);
    const type = bytes[offset + 8];
    if (length < 21 || offset + 4 + length > bytes.length || savedSequence !== sequence) invalid();
    if (type !== 1 && type !== 2) invalid();
    const encrypted = bytes.subarray(offset + 9, offset + 4 + length);
    let plain: Uint8Array;
    try {
      plain = new Uint8Array(
        await crypto.subtle.decrypt(
          tenantBundleCipherParameters(headerHash, sequence, type),
          key,
          encrypted
        )
      );
    } catch {
      invalid();
    }
    if (type === 1) {
      if (metadata) invalid();
      plainData.push(plain);
      dataFrames++;
    } else {
      if (metadata || offset + 4 + length !== bytes.length) invalid();
      metadata = plain;
    }
    sequence++;
    offset += 4 + length;
  }
  if (!metadata) invalid();
  let parsed: { manifest: TenantBackupContainerManifestV2; footer: TenantBackupContainerFooterV2 };
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(metadata);
    parsed = JSON.parse(text) as typeof parsed;
    if (JSON.stringify(parsed) !== text) invalid();
  } catch {
    invalid();
  }
  const { manifest, footer } = parsed;
  if (
    manifest?.formatVersion !== 2 ||
    footer?.formatVersion !== 2 ||
    footer.datasets !== manifest.datasets.length ||
    footer.dataFrames !== dataFrames ||
    footer.totalRows !== manifest.totalRows ||
    footer.totalBytes !== manifest.totalBytes ||
    footer.dataSha256 !== manifest.dataSha256 ||
    footer.manifestSha256 !== (await sha256(new TextEncoder().encode(JSON.stringify(manifest)))) ||
    hex(envelope.subarray(1, 17)) !== manifest.backup.bundleId
  )
    invalid();
  const data = join(plainData);
  if (data.length !== manifest.totalBytes || (await sha256(data)) !== manifest.dataSha256)
    invalid();
  const datasets = new Map<string, Uint8Array>();
  let expectedOffset = 0;
  let totalRows = 0;
  for (const dataset of manifest.datasets) {
    if (
      !dataset ||
      typeof dataset.id !== 'string' ||
      !dataset.id ||
      datasets.has(dataset.id) ||
      dataset.offset !== expectedOffset ||
      !Number.isSafeInteger(dataset.bytes) ||
      dataset.bytes < 0 ||
      !Number.isSafeInteger(dataset.rows) ||
      dataset.rows < 0 ||
      !/^[a-f0-9]{64}$/.test(dataset.sha256)
    )
      invalid();
    const value = data.slice(dataset.offset, dataset.offset + dataset.bytes);
    if (
      value.length !== dataset.bytes ||
      (await sha256(value)) !== dataset.sha256 ||
      records(value) !== dataset.rows
    )
      invalid();
    datasets.set(dataset.id, value);
    expectedOffset += dataset.bytes;
    totalRows += dataset.rows;
  }
  if (expectedOffset !== data.length || totalRows !== manifest.totalRows) invalid();
  return { manifest, footer, datasets };
}

export const TENANT_BACKUP_CONTAINER_V2_LIMITS = {
  singleObjectDataBytes: SINGLE_OBJECT_DATA_BYTES,
  capacityPartBytes: CAPACITY_PART_BYTES,
} as const;
