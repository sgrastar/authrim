import type { LogIcebergRecordKeys } from './log-iceberg-record';

/** Log-only master history. Never publish this secret in config, SQL or backup metadata. */
export interface LogIcebergRootKeyring {
  schema_version: 1;
  current_version: number;
  roots: Record<string, string>;
}
export interface LogIcebergKeyEnv {
  OBJECT_ENCRYPTION_ROOT_KEY?: string;
  OBJECT_ENCRYPTION_KEY_VERSION?: string;
  LOG_ARCHIVE_ROOT_KEYRING?: string;
  LOG_ARCHIVE_CONTENT_HMAC_KEY?: string;
}
export const LOG_ICEBERG_ROOT_KEYRING_MAX_BYTES = 4096;
export const LOG_ICEBERG_ROOT_KEYRING_MAX_VERSIONS = 32;
const VERSION = /^[1-9][0-9]{0,8}$/;
const HEX = /^[a-fA-F0-9]{64}$/;

function invalid(): never {
  throw new Error('log_iceberg_root_keyring_invalid');
}

export function parseLogIcebergRootKeyring(value: string): LogIcebergRootKeyring {
  if (
    typeof value !== 'string' ||
    value.length > LOG_ICEBERG_ROOT_KEYRING_MAX_BYTES ||
    new TextEncoder().encode(value).byteLength > LOG_ICEBERG_ROOT_KEYRING_MAX_BYTES
  )
    invalid();
  let input: unknown;
  try {
    input = JSON.parse(value);
  } catch {
    invalid();
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const ring = input as Record<string, unknown>;
  if (
    Object.keys(ring).sort().join(',') !== 'current_version,roots,schema_version' ||
    ring.schema_version !== 1 ||
    !Number.isSafeInteger(ring.current_version) ||
    !VERSION.test(String(ring.current_version)) ||
    !ring.roots ||
    typeof ring.roots !== 'object' ||
    Array.isArray(ring.roots)
  )
    invalid();
  const entries = Object.entries(ring.roots);
  if (!entries.length || entries.length > LOG_ICEBERG_ROOT_KEYRING_MAX_VERSIONS) invalid();
  // This fixed schema has only three top-level names and numeric root names.
  // JSON.parse alone would silently accept a repeated version and discard a master.
  const names = [...value.matchAll(/("(?:[^"\\]|\\.)*")\s*:/gu)].map(
    (match) => JSON.parse(match[1]) as string
  );
  if (new Set(names).size !== names.length) invalid();
  const roots: Record<string, string> = {};
  for (const [version, root] of entries) {
    if (
      !VERSION.test(version) ||
      Number(version) > Number(ring.current_version) ||
      typeof root !== 'string' ||
      !HEX.test(root)
    )
      invalid();
    roots[version] = root.toLowerCase();
  }
  if (!Object.hasOwn(roots, String(ring.current_version))) invalid();
  return { schema_version: 1, current_version: Number(ring.current_version), roots };
}

/** Parse once per invocation; the returned closure has no mutable global request state. */
export function createLogIcebergKeyResolver(env: LogIcebergKeyEnv) {
  if (!env.LOG_ARCHIVE_ROOT_KEYRING) throw new Error('log_iceberg_root_keyring_required');
  const ring = parseLogIcebergRootKeyring(env.LOG_ARCHIVE_ROOT_KEYRING);
  const currentVersion = env.OBJECT_ENCRYPTION_KEY_VERSION ?? '1';
  if (!VERSION.test(currentVersion)) throw new Error('log_iceberg_encryption_key_version_invalid');
  if (
    !env.OBJECT_ENCRYPTION_ROOT_KEY ||
    !HEX.test(env.OBJECT_ENCRYPTION_ROOT_KEY) ||
    !env.LOG_ARCHIVE_CONTENT_HMAC_KEY ||
    !HEX.test(env.LOG_ARCHIVE_CONTENT_HMAC_KEY)
  )
    throw new Error('log_iceberg_encryption_key_unavailable');
  if (
    Number(currentVersion) !== ring.current_version ||
    ring.roots[currentVersion] !== env.OBJECT_ENCRYPTION_ROOT_KEY.toLowerCase()
  )
    throw new Error('log_iceberg_current_root_key_mismatch');
  const contentHmacKeyHex = env.LOG_ARCHIVE_CONTENT_HMAC_KEY.toLowerCase();
  return (keyVersion = ring.current_version): LogIcebergRecordKeys => {
    if (!Number.isSafeInteger(keyVersion) || !VERSION.test(String(keyVersion)))
      throw new Error('log_iceberg_encryption_key_version_invalid');
    const rootKeyHex = ring.roots[String(keyVersion)];
    if (!rootKeyHex) throw new Error('log_iceberg_root_key_version_unavailable');
    return { rootKeyHex, contentHmacKeyHex, keyVersion };
  };
}
