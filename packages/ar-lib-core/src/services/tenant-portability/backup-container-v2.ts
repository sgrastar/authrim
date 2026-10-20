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

/** Header, stream key and frame sealing shared by the one-shot and the checkpointed writers. */
export interface TenantBackupContainerV2Cipher {
  header: Uint8Array;
  seal(sequence: number, type: 1 | 2, plain: Uint8Array): Promise<Uint8Array>;
  open(sequence: number, type: 1 | 2, encrypted: Uint8Array): Promise<Uint8Array>;
}

export async function openTenantBackupContainerV2Cipher(
  session: TenantBundleKeyEnvelope,
  streamSalt: Uint8Array
): Promise<TenantBackupContainerV2Cipher> {
  if (!(streamSalt instanceof Uint8Array) || streamSalt.length !== 32) invalid();
  const salt = new Uint8Array(streamSalt);
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC);
  header.set(session.envelope, 8);
  header.set(salt, 101);
  const headerHash = new Uint8Array(await crypto.subtle.digest('SHA-256', header));
  const key = await deriveTenantBundleStreamKey(session.contentKey, salt);
  return {
    header,
    async seal(sequence, type, plain) {
      const encrypted = new Uint8Array(
        await crypto.subtle.encrypt(
          tenantBundleCipherParameters(headerHash, sequence, type),
          key,
          Uint8Array.from(plain)
        )
      );
      return frame(sequence, type, encrypted);
    },
    async open(sequence, type, encrypted) {
      try {
        return new Uint8Array(
          await crypto.subtle.decrypt(
            tenantBundleCipherParameters(headerHash, sequence, type),
            key,
            Uint8Array.from(encrypted)
          )
        );
      } catch {
        invalid();
      }
    },
  };
}

export interface TenantBackupContainerV2Frame {
  sequence: number;
  type: 1 | 2;
  encrypted: Uint8Array;
  /** Offset just past this frame. */
  end: number;
}

/** Walk length-prefixed frames from `start`; every frame must end inside `bytes`. */
export function* tenantBackupContainerV2Frames(
  bytes: Uint8Array,
  start: number
): Generator<TenantBackupContainerV2Frame> {
  let offset = start;
  while (offset < bytes.length) {
    if (bytes.length - offset < 9) invalid();
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.length - offset);
    const length = view.getUint32(0);
    const sequence = view.getUint32(4);
    const type = bytes[offset + 8];
    if (length < 21 || offset + 4 + length > bytes.length) invalid();
    if (type !== 1 && type !== 2) invalid();
    const end = offset + 4 + length;
    yield { sequence, type, encrypted: bytes.subarray(offset + 9, end), end };
    offset = end;
  }
}

export async function tenantBackupContainerV2Metadata(input: {
  manifest: TenantBundleManifest;
  datasets: TenantBackupContainerDatasetV2[];
  dataFrames: number;
  dataSha256: string;
}): Promise<{
  manifest: TenantBackupContainerManifestV2;
  footer: TenantBackupContainerFooterV2;
  bytes: Uint8Array;
}> {
  const totalBytes = input.datasets.reduce((sum, dataset) => sum + dataset.bytes, 0);
  const totalRows = input.datasets.reduce((sum, dataset) => sum + dataset.rows, 0);
  const manifest: TenantBackupContainerManifestV2 = {
    formatVersion: 2,
    backup: structuredClone(input.manifest),
    datasets: input.datasets.map((dataset) => ({ ...dataset })),
    totalRows,
    totalBytes,
    dataSha256: input.dataSha256,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const footer: TenantBackupContainerFooterV2 = {
    formatVersion: 2,
    datasets: manifest.datasets.length,
    dataFrames: input.dataFrames,
    totalRows,
    totalBytes,
    dataSha256: input.dataSha256,
    manifestSha256: await sha256(manifestBytes),
  };
  return { manifest, footer, bytes: canonicalMetadata(manifest, footer) };
}

/**
 * Authenticate decrypted metadata against the envelope and the counted data frames. Dataset
 * offsets and counts are checked here; their bytes and digests are the caller's to check.
 */
export async function parseTenantBackupContainerV2Metadata(
  metadata: Uint8Array,
  envelope: Uint8Array,
  dataFrames: number
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

/** Newline-delimited record count used for dataset row totals. */
export function tenantBackupContainerV2Records(bytes: Uint8Array): number {
  return records(bytes);
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
  const dataFrames = Math.max(1, Math.ceil(data.length / CAPACITY_PART_BYTES));
  const {
    manifest,
    footer,
    bytes: metadata,
  } = await tenantBackupContainerV2Metadata({
    manifest: input.manifest,
    datasets: datasetStats,
    dataFrames,
    dataSha256,
  });
  if (manifest.totalRows !== totalRows || manifest.totalBytes !== totalBytes) invalid();
  const cipher = await openTenantBackupContainerV2Cipher(
    input.session,
    input.streamSalt ?? crypto.getRandomValues(new Uint8Array(32))
  );
  const header = cipher.header;
  const frames: Uint8Array[] = [];
  for (let sequence = 0; sequence < dataFrames; sequence++) {
    const plain = data.subarray(
      sequence * CAPACITY_PART_BYTES,
      Math.min((sequence + 1) * CAPACITY_PART_BYTES, data.length)
    );
    frames.push(await cipher.seal(sequence, 1, plain));
  }
  frames.push(await cipher.seal(dataFrames, 2, metadata));

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
  const cipher = await openTenantBackupContainerV2Cipher(
    input.session,
    bytes.subarray(101, HEADER_BYTES)
  );
  const plainData: Uint8Array[] = [];
  let metadata: Uint8Array | null = null;
  let sequence = 0;
  let dataFrames = 0;
  for (const item of tenantBackupContainerV2Frames(bytes, HEADER_BYTES)) {
    if (item.sequence !== sequence) invalid();
    const plain = await cipher.open(sequence, item.type, item.encrypted);
    if (item.type === 1) {
      if (metadata) invalid();
      plainData.push(plain);
      dataFrames++;
    } else {
      if (metadata || item.end !== bytes.length) invalid();
      metadata = plain;
    }
    sequence++;
  }
  if (!metadata) invalid();
  const { manifest, footer } = await parseTenantBackupContainerV2Metadata(
    metadata,
    envelope,
    dataFrames
  );
  const data = join(plainData);
  if (data.length !== manifest.totalBytes || (await sha256(data)) !== manifest.dataSha256)
    invalid();
  const datasets = new Map<string, Uint8Array>();
  for (const dataset of manifest.datasets) {
    const value = data.slice(dataset.offset, dataset.offset + dataset.bytes);
    if (
      value.length !== dataset.bytes ||
      (await sha256(value)) !== dataset.sha256 ||
      records(value) !== dataset.rows
    )
      invalid();
    datasets.set(dataset.id, value);
  }
  return { manifest, footer, datasets };
}

/** Frame prefix (length, sequence, type) and AES-GCM tag around a frame's plaintext. */
const FRAME_OVERHEAD_BYTES = 9 + 16;
/** Largest frame plaintext a streaming reader accepts (encoders write 4 or 12 MiB). */
const MAX_FRAME_PLAIN_BYTES = 16 * 1024 * 1024;

/**
 * Check a container header read from storage against the accepted key envelope and open its
 * stream cipher. Frames read later are authenticated with this header's hash.
 */
export async function openTenantBackupContainerHeaderV2(
  header: Uint8Array,
  session: TenantBundleKeyEnvelope
): Promise<TenantBackupContainerV2Cipher> {
  if (header.length !== HEADER_BYTES || !MAGIC.every((byte, index) => header[index] === byte))
    invalid();
  const envelope = header.subarray(8, 101);
  if (
    session.envelope.length !== envelope.length ||
    !envelope.every((byte, index) => byte === session.envelope[index])
  )
    invalid();
  const cipher = await openTenantBackupContainerV2Cipher(session, header.subarray(101));
  if (!cipher.header.every((byte, index) => byte === header[index])) invalid();
  return cipher;
}

/** Parse a 9-byte frame prefix; `frameBytes` includes the 4-byte length field itself. */
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

/** Rows as the encoder counts them: newline-terminated rows plus an unterminated tail. */
export function tenantBackupContainerRowCountV2(newlines: number, bytes: number, lastByte: number) {
  return bytes && lastByte !== 10 ? newlines + 1 : newlines;
}

/**
 * Largest container object export, verification and import accept. All three stream the
 * container (sliced export and verification, frame-indexed import), so they share this one cap;
 * the in-memory `decodeTenantBackupContainerV2` keeps its own 256 MiB bound.
 */
export const TENANT_BACKUP_CONTAINER_V2_MAX_OBJECT_BYTES = 16 * 1024 * 1024 * 1024;

/**
 * Most data frames a container may have, for export, verification, import and download alike.
 * Every artifact part holds at least one data frame, so a container has at most this many parts
 * plus one, and the public download (four subrequests per part) stays well inside the 50,000
 * subrequests ar-management is configured for. 16 GiB of 4 MiB frames needs about 4,100, which
 * leaves room for the shorter frames sliced exports write where a transition stopped.
 */
export const TENANT_BACKUP_CONTAINER_V2_MAX_DATA_FRAMES = 10_000;

export const TENANT_BACKUP_CONTAINER_V2_LIMITS = {
  singleObjectDataBytes: SINGLE_OBJECT_DATA_BYTES,
  capacityPartBytes: CAPACITY_PART_BYTES,
  headerBytes: HEADER_BYTES,
  frameOverheadBytes: FRAME_OVERHEAD_BYTES,
  maxFramePlainBytes: MAX_FRAME_PLAIN_BYTES,
} as const;
