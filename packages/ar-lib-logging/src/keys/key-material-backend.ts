import type { LoggingKeyScope } from './index';

export type LoggingKeyMaterialBackendKind = 'r2_wrapped_key' | 'd1_wrapped_key' | 'external_kms';

export interface WrappedLoggingKeyMaterialEnvelope {
  version: 1;
  algorithm: 'AES-256-GCM';
  backend: Exclude<LoggingKeyMaterialBackendKind, 'external_kms'>;
  keyVersion: number;
  contentType: 'application/authrim.logging-key+json';
  iv: string;
  ciphertext: string;
}

export interface LoggingKeyMaterial {
  keyBytes: Uint8Array;
  algorithm: 'AES-GCM';
}

export interface LoggingKeyMaterialRefParts {
  backend: LoggingKeyMaterialBackendKind;
  scopeId: string;
  version: number;
  keyId: string;
}

export interface LoggingKeyMaterialPutInput {
  scope: LoggingKeyScope;
  scopeId: string;
  version: number;
  material: LoggingKeyMaterial;
  now?: number;
}

export interface LoggingKeyMaterialSqlStore {
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface LoggingKeyMaterialR2Bucket {
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  ): Promise<unknown>;
  get(key: string): Promise<LoggingKeyMaterialTextObject | null>;
  delete(key: string): Promise<void>;
}

export interface LoggingKeyMaterialBackend {
  readonly kind: LoggingKeyMaterialBackendKind;
  put(input: LoggingKeyMaterialPutInput): Promise<string>;
  get(ref: string): Promise<LoggingKeyMaterial | null>;
  delete(ref: string): Promise<void>;
}

export interface D1WrappedLoggingKeyMaterialBackendOptions {
  store: LoggingKeyMaterialSqlStore;
  rootKeyHex: string;
  keyVersion?: number;
  now?: () => number;
}

export interface R2WrappedLoggingKeyMaterialBackendOptions {
  bucket: LoggingKeyMaterialR2Bucket;
  rootKeyHex: string;
  authority?: string;
  keyPrefix?: string;
  keyVersion?: number;
  now?: () => number;
}

export class LoggingKeyMaterialBackendError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_ref'
      | 'invalid_envelope'
      | 'unavailable'
      | 'not_found'
      | 'encryption_failed'
      | 'decryption_failed',
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'LoggingKeyMaterialBackendError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LOGGING_KEY_MATERIAL_OBJECT_MAX_BYTES = 64 * 1024;

interface LoggingKeyMaterialTextObject {
  readonly size?: number;
  readonly body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

function loggingKeyMaterialEnvelopeTooLarge(): LoggingKeyMaterialBackendError {
  return new LoggingKeyMaterialBackendError(
    'Logging key material envelope exceeds maximum size.',
    'invalid_envelope'
  );
}

async function readLoggingKeyMaterialObjectText(
  object: LoggingKeyMaterialTextObject
): Promise<string> {
  if (typeof object.size === 'number' && object.size > LOGGING_KEY_MATERIAL_OBJECT_MAX_BYTES) {
    throw loggingKeyMaterialEnvelopeTooLarge();
  }

  if (object.body) {
    const reader = object.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        totalBytes += value.byteLength;
        if (totalBytes > LOGGING_KEY_MATERIAL_OBJECT_MAX_BYTES) {
          void reader.cancel().catch(() => {});
          throw loggingKeyMaterialEnvelopeTooLarge();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return decoder.decode(body);
  }

  const text = await object.text();
  if (encoder.encode(text).byteLength > LOGGING_KEY_MATERIAL_OBJECT_MAX_BYTES) {
    throw loggingKeyMaterialEnvelopeTooLarge();
  }
  return text;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new LoggingKeyMaterialBackendError(
      'logging_key_root_key_invalid',
      'encryption_failed'
    );
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function readRowsAffected(result: unknown): number | null {
  if (!result || typeof result !== 'object' || !('rowsAffected' in result)) {
    return null;
  }
  const rowsAffected = Number((result as { rowsAffected?: unknown }).rowsAffected);
  return Number.isFinite(rowsAffected) ? rowsAffected : null;
}

async function deriveWrappingKey(
  rootKeyHex: string,
  backend: Exclude<LoggingKeyMaterialBackendKind, 'external_kms'>,
  keyVersion: number
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', hexToBytes(rootKeyHex), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('authrim-logging-key-material-root'),
      info: encoder.encode(`authrim:${backend}:v${keyVersion}`),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function keyMaterialAdditionalData(input: {
  backendRef: string;
  scopeId: string;
  version: number;
}): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      backend_ref: input.backendRef,
      scope_id: input.scopeId,
      version: input.version,
    })
  );
}

export async function wrapLoggingKeyMaterial(
  material: LoggingKeyMaterial,
  options: {
    rootKeyHex: string;
    backend: Exclude<LoggingKeyMaterialBackendKind, 'external_kms'>;
    keyVersion: number;
    backendRef: string;
    scopeId: string;
    version: number;
  }
): Promise<WrappedLoggingKeyMaterialEnvelope> {
  const key = await deriveWrappingKey(options.rootKeyHex, options.backend, options.keyVersion);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = JSON.stringify({
    algorithm: material.algorithm,
    key_bytes: toBase64Url(material.keyBytes),
  });
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: keyMaterialAdditionalData(options),
      tagLength: 128,
    },
    key,
    encoder.encode(plaintext)
  );

  return {
    version: 1,
    algorithm: 'AES-256-GCM',
    backend: options.backend,
    keyVersion: options.keyVersion,
    contentType: 'application/authrim.logging-key+json',
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function unwrapLoggingKeyMaterial(
  envelope: WrappedLoggingKeyMaterialEnvelope,
  options: {
    rootKeyHex: string;
    backendRef: string;
    scopeId: string;
    version: number;
  }
): Promise<LoggingKeyMaterial> {
  try {
    const key = await deriveWrappingKey(options.rootKeyHex, envelope.backend, envelope.keyVersion);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(envelope.iv),
        additionalData: keyMaterialAdditionalData(options),
        tagLength: 128,
      },
      key,
      fromBase64Url(envelope.ciphertext)
    );
    const parsed = JSON.parse(decoder.decode(plaintext)) as {
      algorithm?: string;
      key_bytes?: string;
    };
    if (parsed.algorithm !== 'AES-GCM' || !parsed.key_bytes) {
      throw new Error('invalid_logging_key_material_envelope');
    }
    return {
      algorithm: 'AES-GCM',
      keyBytes: fromBase64Url(parsed.key_bytes),
    };
  } catch (cause) {
    throw new LoggingKeyMaterialBackendError(
      'logging_key_material_decryption_failed',
      'decryption_failed',
      { cause }
    );
  }
}

export function buildLoggingKeyMaterialRef(parts: LoggingKeyMaterialRefParts): string {
  const scopeId = encodeURIComponent(parts.scopeId);
  const keyId = encodeURIComponent(parts.keyId);
  return `logkey:${parts.backend}:${scopeId}:v${parts.version}:${keyId}`;
}

export function parseLoggingKeyMaterialRef(ref: string): LoggingKeyMaterialRefParts {
  const match = ref.match(/^logkey:([^:]+):([^:]+):v([1-9][0-9]*):([^:]+)$/);
  if (!match) {
    throw new LoggingKeyMaterialBackendError('invalid_logging_key_material_ref', 'invalid_ref');
  }

  const backend = match[1] as LoggingKeyMaterialBackendKind;
  if (!['r2_wrapped_key', 'd1_wrapped_key', 'external_kms'].includes(backend)) {
    throw new LoggingKeyMaterialBackendError('unknown_logging_key_material_backend', 'invalid_ref');
  }

  return {
    backend,
    scopeId: decodeURIComponent(match[2]),
    version: Number.parseInt(match[3], 10),
    keyId: decodeURIComponent(match[4]),
  };
}

export class ExternalLoggingKeyMaterialBackendStub implements LoggingKeyMaterialBackend {
  readonly kind = 'external_kms' as const;

  async put(_input: LoggingKeyMaterialPutInput): Promise<string> {
    throw new LoggingKeyMaterialBackendError('external_kms_backend_unavailable', 'unavailable');
  }

  async get(_ref: string): Promise<LoggingKeyMaterial | null> {
    throw new LoggingKeyMaterialBackendError('external_kms_backend_unavailable', 'unavailable');
  }

  async delete(_ref: string): Promise<void> {
    throw new LoggingKeyMaterialBackendError('external_kms_backend_unavailable', 'unavailable');
  }
}

export class D1WrappedLoggingKeyMaterialBackend implements LoggingKeyMaterialBackend {
  readonly kind = 'd1_wrapped_key' as const;

  private readonly store: LoggingKeyMaterialSqlStore;
  private readonly rootKeyHex: string;
  private readonly keyVersion: number;
  private readonly now: () => number;

  constructor(options: D1WrappedLoggingKeyMaterialBackendOptions) {
    this.store = options.store;
    this.rootKeyHex = options.rootKeyHex;
    this.keyVersion = options.keyVersion ?? 1;
    this.now = options.now ?? Date.now;
  }

  async put(input: LoggingKeyMaterialPutInput): Promise<string> {
    const keyId = `${input.scopeId}/v${input.version}`;
    const backendRef = buildLoggingKeyMaterialRef({
      backend: this.kind,
      scopeId: input.scopeId,
      version: input.version,
      keyId,
    });
    const now = input.now ?? this.now();
    const envelope = await wrapLoggingKeyMaterial(input.material, {
      rootKeyHex: this.rootKeyHex,
      backend: this.kind,
      keyVersion: this.keyVersion,
      backendRef,
      scopeId: input.scopeId,
      version: input.version,
    });

    const update = await this.store.execute(
      `UPDATE logging_key_material_bodies
       SET envelope_json = ?,
           updated_at = ?
       WHERE backend_ref = ?`,
      [JSON.stringify(envelope), now, backendRef]
    );
    if ((readRowsAffected(update) ?? 0) > 0) {
      return backendRef;
    }

    await this.store.execute(
      `INSERT INTO logging_key_material_bodies (
        backend_ref, scope_id, tenant_key, surface, log_type, plane, version,
        envelope_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        backendRef,
        input.scopeId,
        input.scope.tenantKey,
        input.scope.surface ?? null,
        input.scope.logType,
        input.scope.plane,
        input.version,
        JSON.stringify(envelope),
        now,
        now,
      ]
    );

    return backendRef;
  }

  async get(ref: string): Promise<LoggingKeyMaterial | null> {
    const parsed = parseLoggingKeyMaterialRef(ref);
    if (parsed.backend !== this.kind) {
      throw new LoggingKeyMaterialBackendError(
        'logging_key_material_backend_mismatch',
        'invalid_ref'
      );
    }

    const row = await this.store.queryOne<{
      scope_id: string;
      version: number;
      envelope_json: string;
    }>(
      `SELECT scope_id, version, envelope_json
       FROM logging_key_material_bodies
       WHERE backend_ref = ?`,
      [ref]
    );
    if (!row) {
      return null;
    }

    return unwrapLoggingKeyMaterial(JSON.parse(row.envelope_json), {
      rootKeyHex: this.rootKeyHex,
      backendRef: ref,
      scopeId: row.scope_id,
      version: Number(row.version),
    });
  }

  async delete(ref: string): Promise<void> {
    const parsed = parseLoggingKeyMaterialRef(ref);
    if (parsed.backend !== this.kind) {
      throw new LoggingKeyMaterialBackendError(
        'logging_key_material_backend_mismatch',
        'invalid_ref'
      );
    }
    await this.store.execute('DELETE FROM logging_key_material_bodies WHERE backend_ref = ?', [
      ref,
    ]);
  }
}

export class R2WrappedLoggingKeyMaterialBackend implements LoggingKeyMaterialBackend {
  readonly kind = 'r2_wrapped_key' as const;

  private readonly bucket: LoggingKeyMaterialR2Bucket;
  private readonly rootKeyHex: string;
  private readonly authority: string;
  private readonly keyPrefix: string;
  private readonly keyVersion: number;
  private readonly now: () => number;

  constructor(options: R2WrappedLoggingKeyMaterialBackendOptions) {
    this.bucket = options.bucket;
    this.rootKeyHex = options.rootKeyHex;
    this.authority = options.authority ?? 'logging-keys';
    this.keyPrefix = options.keyPrefix ?? 'logging-key-material';
    this.keyVersion = options.keyVersion ?? 1;
    this.now = options.now ?? Date.now;
  }

  async put(input: LoggingKeyMaterialPutInput): Promise<string> {
    const now = input.now ?? this.now();
    const objectKey = `${this.keyPrefix}/scope=${encodeURIComponent(input.scopeId)}/v${input.version}.json`;
    const backendRef = buildLoggingKeyMaterialRef({
      backend: this.kind,
      scopeId: input.scopeId,
      version: input.version,
      keyId: `${this.authority}/${objectKey}`,
    });
    const envelope = await wrapLoggingKeyMaterial(input.material, {
      rootKeyHex: this.rootKeyHex,
      backend: this.kind,
      keyVersion: this.keyVersion,
      backendRef,
      scopeId: input.scopeId,
      version: input.version,
    });

    await this.bucket.put(objectKey, JSON.stringify(envelope), {
      httpMetadata: {
        contentType: 'application/authrim.logging-key+json',
      },
      customMetadata: {
        scopeId: input.scopeId,
        tenantKey: input.scope.tenantKey,
        logType: input.scope.logType,
        plane: input.scope.plane,
        version: String(input.version),
        createdAt: String(now),
      },
    });

    return backendRef;
  }

  async get(ref: string): Promise<LoggingKeyMaterial | null> {
    const parsed = parseLoggingKeyMaterialRef(ref);
    if (parsed.backend !== this.kind) {
      throw new LoggingKeyMaterialBackendError(
        'logging_key_material_backend_mismatch',
        'invalid_ref'
      );
    }
    const objectKey = this.objectKeyFromRef(parsed.keyId);
    const object = await this.bucket.get(objectKey);
    if (!object) {
      return null;
    }
    return unwrapLoggingKeyMaterial(
      JSON.parse(await readLoggingKeyMaterialObjectText(object)),
      {
        rootKeyHex: this.rootKeyHex,
        backendRef: ref,
        scopeId: parsed.scopeId,
        version: parsed.version,
      }
    );
  }

  async delete(ref: string): Promise<void> {
    const parsed = parseLoggingKeyMaterialRef(ref);
    if (parsed.backend !== this.kind) {
      throw new LoggingKeyMaterialBackendError(
        'logging_key_material_backend_mismatch',
        'invalid_ref'
      );
    }
    await this.bucket.delete(this.objectKeyFromRef(parsed.keyId));
  }

  private objectKeyFromRef(keyId: string): string {
    const prefix = `${this.authority}/`;
    if (!keyId.startsWith(prefix)) {
      throw new LoggingKeyMaterialBackendError(
        'logging_key_material_authority_mismatch',
        'invalid_ref'
      );
    }
    return keyId.slice(prefix.length);
  }
}
