const MAX_BYTES = 16 * 1024 * 1024;

export interface PortableSensitiveDetailRecord {
  version: 1;
  contentType: string;
  plaintext: string;
}

function invalid(): never {
  throw new Error('backup_portable_sensitive_detail_invalid');
}

function validate(input: PortableSensitiveDetailRecord): void {
  if (
    input.version !== 1 ||
    typeof input.contentType !== 'string' ||
    !input.contentType ||
    new TextEncoder().encode(input.contentType).length > 256 ||
    typeof input.plaintext !== 'string'
  )
    invalid();
}

export function encodePortableSensitiveDetailRecord(
  input: PortableSensitiveDetailRecord
): Uint8Array {
  validate(input);
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  if (bytes.length > MAX_BYTES) invalid();
  decodePortableSensitiveDetailRecord(bytes);
  return bytes;
}

export function decodePortableSensitiveDetailRecord(
  bytes: Uint8Array
): PortableSensitiveDetailRecord {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_BYTES) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  const input = parsed as PortableSensitiveDetailRecord;
  if (Object.keys(input).sort().join(',') !== 'contentType,plaintext,version') invalid();
  validate(input);
  return input;
}
