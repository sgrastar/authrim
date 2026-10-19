import { deriveTenantBundleStreamKey, type TenantBundleKeyEnvelope } from './bundle-key-envelope';
import { tenantBundleCipherParameters } from './bundle-cipher-parameters';
import type { TenantBundleManifest } from './bundle-manifest';

const MAGIC = new TextEncoder().encode('AUTHRIM2');
const HEADER_BYTES = 8 + 93 + 32;
const SINGLE_OBJECT_DATA_BYTES = 16 * 1024 * 1024;
const CAPACITY_PART_BYTES = 12 * 1024 * 1024;
/** Data frames end on a row boundary near this size, so a restore step decrypts little more than it reads. */
const TARGET_FRAME_PLAIN_BYTES = 4 * 1024 * 1024;
/** Upper bound for one frame's plaintext: a single row may exceed the target up to the row limit. */
const MAX_FRAME_PLAIN_BYTES = 16 * 1024 * 1024;
const FRAME_OVERHEAD_BYTES = 9 + 16;
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

/**
 * Frame boundaries for the plaintext data: each frame ends after a newline once it reaches the target
 * size, so readers rarely assemble a row from two frames. A longer row gets a frame of its own; only
 * a row beyond one capacity part is split, which keeps every frame inside a single R2 part.
 */
function frameCuts(data: Uint8Array): number[] {
  const cuts = [0];
  let start = 0;
  while (data.length - start > TARGET_FRAME_PLAIN_BYTES) {
    const target = start + TARGET_FRAME_PLAIN_BYTES;
    const before = data.lastIndexOf(10, target - 1);
    let end = before >= start ? before + 1 : data.indexOf(10, target) + 1;
    if (end <= start || end - start > CAPACITY_PART_BYTES) end = start + CAPACITY_PART_BYTES;
    if (end >= data.length) break;
    cuts.push(end);
    start = end;
  }
  cuts.push(data.length);
  return cuts;
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
  const cuts = frameCuts(data);
  const dataFrames = cuts.length - 1;
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
    const plain = data.subarray(cuts[sequence], cuts[sequence + 1]);
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

export interface TenantBackupContainerCipherV2 {
  headerHash: Uint8Array<ArrayBuffer>;
  key: CryptoKey;
}

/** Check the fixed v2 header against the accepted key envelope and derive this stream's key. */
export async function openTenantBackupContainerHeaderV2(
  header: Uint8Array,
  session: TenantBundleKeyEnvelope
): Promise<TenantBackupContainerCipherV2> {
  if (header.length !== HEADER_BYTES || !MAGIC.every((byte, index) => header[index] === byte))
    invalid();
  const envelope = header.subarray(8, 101);
  if (
    session.envelope.length !== envelope.length ||
    !envelope.every((byte, index) => byte === session.envelope[index])
  )
    invalid();
  return {
    headerHash: new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(header))),
    key: await deriveTenantBundleStreamKey(session.contentKey, header.subarray(101, HEADER_BYTES)),
  };
}

/** Parse the 9-byte frame prefix; `frameBytes` includes the 4-byte length field itself. */
export function readTenantBackupFramePrefixV2(
  prefix: Uint8Array,
  sequence: number
): { type: 1 | 2; frameBytes: number } {
  if (prefix.length < 9) invalid();
  const view = new DataView(prefix.buffer, prefix.byteOffset, 9);
  const length = view.getUint32(0);
  const type = prefix[8];
  if (length < 21 || view.getUint32(4) !== sequence || (type !== 1 && type !== 2)) invalid();
  return { type, frameBytes: 4 + length };
}

/** AES-GCM over one frame; the header hash, sequence and type are bound as additional data. */
export async function decryptTenantBackupFrameV2(
  cipher: TenantBackupContainerCipherV2,
  sequence: number,
  type: 1 | 2,
  encrypted: Uint8Array<ArrayBuffer>
): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        tenantBundleCipherParameters(cipher.headerHash, sequence, type),
        cipher.key,
        encrypted
      )
    );
  } catch {
    return invalid();
  }
}

/**
 * Validate the authenticated metadata frame of a container with `dataFrames` data frames. Dataset
 * descriptors must tile the data exactly; their hashes and row counts are checked by the caller.
 */
export async function parseTenantBackupContainerMetadataV2(
  metadata: Uint8Array,
  dataFrames: number,
  envelope: Uint8Array
): Promise<{ manifest: TenantBackupContainerManifestV2; footer: TenantBackupContainerFooterV2 }> {
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
    !Array.isArray(manifest.datasets) ||
    footer.datasets !== manifest.datasets.length ||
    footer.dataFrames !== dataFrames ||
    footer.totalRows !== manifest.totalRows ||
    footer.totalBytes !== manifest.totalBytes ||
    footer.dataSha256 !== manifest.dataSha256 ||
    footer.manifestSha256 !== (await sha256(new TextEncoder().encode(JSON.stringify(manifest)))) ||
    hex(envelope.subarray(1, 17)) !== manifest.backup.bundleId
  )
    invalid();
  const ids = new Set<string>();
  let expectedOffset = 0;
  let totalRows = 0;
  for (const dataset of manifest.datasets) {
    if (
      !dataset ||
      typeof dataset.id !== 'string' ||
      !dataset.id ||
      ids.has(dataset.id) ||
      dataset.offset !== expectedOffset ||
      !Number.isSafeInteger(dataset.bytes) ||
      dataset.bytes < 0 ||
      !Number.isSafeInteger(dataset.rows) ||
      dataset.rows < 0 ||
      !/^[a-f0-9]{64}$/.test(dataset.sha256)
    )
      invalid();
    ids.add(dataset.id);
    expectedOffset += dataset.bytes;
    totalRows += dataset.rows;
  }
  if (expectedOffset !== manifest.totalBytes || totalRows !== manifest.totalRows) invalid();
  return { manifest, footer };
}

/** Rows as counted by the encoder: newline-terminated rows plus an unterminated tail. */
export function tenantBackupContainerRowCountV2(newlines: number, bytes: number, lastByte: number) {
  return bytes && lastByte !== 10 ? newlines + 1 : newlines;
}

/**
 * Authenticate a whole in-memory container (small inputs, tests and the browser inspector). Large
 * inputs are verified frame by frame by decode_input instead; both accept exactly the same bytes.
 */
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
  const cipher = await openTenantBackupContainerHeaderV2(
    bytes.subarray(0, HEADER_BYTES),
    input.session
  );
  const plainData: Uint8Array[] = [];
  let metadata: Uint8Array | null = null;
  let offset = HEADER_BYTES;
  let sequence = 0;
  let dataFrames = 0;
  while (offset < bytes.length) {
    const { type, frameBytes } = readTenantBackupFramePrefixV2(
      bytes.subarray(offset, offset + 9),
      sequence
    );
    if (offset + frameBytes > bytes.length) invalid();
    const plain = await decryptTenantBackupFrameV2(
      cipher,
      sequence,
      type,
      bytes.subarray(offset + 9, offset + frameBytes)
    );
    if (type === 1) {
      if (metadata) invalid();
      plainData.push(plain);
      dataFrames++;
    } else {
      if (metadata || offset + frameBytes !== bytes.length) invalid();
      metadata = plain;
    }
    sequence++;
    offset += frameBytes;
  }
  if (!metadata) invalid();
  const { manifest, footer } = await parseTenantBackupContainerMetadataV2(
    metadata,
    dataFrames,
    bytes.subarray(8, 101)
  );
  const data = join(plainData);
  if (data.length !== manifest.totalBytes || (await sha256(data)) !== manifest.dataSha256)
    invalid();
  const datasets = new Map<string, Uint8Array>();
  for (const dataset of manifest.datasets) {
    const value = data.slice(dataset.offset, dataset.offset + dataset.bytes);
    if ((await sha256(value)) !== dataset.sha256 || records(value) !== dataset.rows) invalid();
    datasets.set(dataset.id, value);
  }
  return { manifest, footer, datasets };
}

export const TENANT_BACKUP_CONTAINER_V2_LIMITS = {
  singleObjectDataBytes: SINGLE_OBJECT_DATA_BYTES,
  capacityPartBytes: CAPACITY_PART_BYTES,
  headerBytes: HEADER_BYTES,
  frameOverheadBytes: FRAME_OVERHEAD_BYTES,
  targetFramePlainBytes: TARGET_FRAME_PLAIN_BYTES,
  maxFramePlainBytes: MAX_FRAME_PLAIN_BYTES,
} as const;
