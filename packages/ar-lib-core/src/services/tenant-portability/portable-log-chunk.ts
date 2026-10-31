type LogChunkCompression = 'none' | 'gzip_block';

const MAX_RECORDS = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;

export interface PortableLogChunkRecord {
  recordId: string;
  eventAt: number;
  surface: string | null;
  indexProfile: string;
  indexedFields: string | null;
  createdAt: number;
  payload: unknown;
}

export interface PortableLogChunkRecords {
  version: 1;
  compression: LogChunkCompression;
  records: PortableLogChunkRecord[];
}

function invalid(): never {
  throw new Error('backup_portable_log_chunk_invalid');
}

function validIndexedFields(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

function validate(input: PortableLogChunkRecords): void {
  if (
    input.version !== 1 ||
    !['none', 'gzip_block'].includes(input.compression) ||
    !Array.isArray(input.records) ||
    input.records.length < 1 ||
    input.records.length > MAX_RECORDS
  )
    invalid();
  const ids = new Set<string>();
  for (const record of input.records) {
    let payloadJson: string | undefined;
    try {
      payloadJson = JSON.stringify(record.payload);
    } catch {
      return invalid();
    }
    if (
      !record ||
      typeof record !== 'object' ||
      Object.keys(record).sort().join(',') !==
        'createdAt,eventAt,indexProfile,indexedFields,payload,recordId,surface' ||
      !SAFE_ID.test(record.recordId) ||
      ids.has(record.recordId) ||
      !Number.isSafeInteger(record.eventAt) ||
      record.eventAt < 0 ||
      (record.surface !== null &&
        (typeof record.surface !== 'string' ||
          new TextEncoder().encode(record.surface).length > 256)) ||
      typeof record.indexProfile !== 'string' ||
      !record.indexProfile ||
      record.indexProfile.length > 128 ||
      (record.indexedFields !== null &&
        (typeof record.indexedFields !== 'string' ||
          new TextEncoder().encode(record.indexedFields).length > 65_536 ||
          !validIndexedFields(record.indexedFields))) ||
      !Number.isSafeInteger(record.createdAt) ||
      record.createdAt < 0 ||
      payloadJson === undefined
    )
      invalid();
    ids.add(record.recordId);
  }
}

/** Encode selected log records without source object keys, encryption keys, or block offsets. */
export function encodePortableLogChunkRecords(input: PortableLogChunkRecords): Uint8Array {
  validate(input);
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    return invalid();
  }
  const bytes = new TextEncoder().encode(json);
  if (bytes.length > MAX_BYTES) invalid();
  decodePortableLogChunkRecords(bytes);
  return bytes;
}

export function decodePortableLogChunkRecords(bytes: Uint8Array): PortableLogChunkRecords {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_BYTES) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  const input = parsed as PortableLogChunkRecords;
  if (Object.keys(input).sort().join(',') !== 'compression,records,version') invalid();
  validate(input);
  return input;
}
