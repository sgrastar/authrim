export type CredentialSecretBackendKind =
  | 'r2_encrypted_object'
  | 'd1_encrypted_table'
  | 'cloudflare_secret_binding'
  | 'external_secret_manager';

export type CredentialSecretRefScheme = 'r2secret' | 'd1secret' | 'cfsecret' | 'extsecret';

export type CredentialSecretStatus = 'active' | 'next' | 'retiring' | 'retired' | 'deleted';

export interface EncryptedCredentialSecretEnvelope {
  version: 1;
  algorithm: 'AES-256-GCM';
  backend: Exclude<CredentialSecretBackendKind, 'external_secret_manager'>;
  keyVersion: number;
  contentType: string;
  iv: string;
  ciphertext: string;
}

const CREDENTIAL_SECRET_OBJECT_MAX_BYTES = 64 * 1024;

interface CredentialSecretTextObject {
  readonly size?: number;
  readonly body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

function credentialSecretEnvelopeTooLarge(): CredentialSecretBackendError {
  return new CredentialSecretBackendError(
    'invalid_secret_envelope',
    'Credential secret envelope exceeds maximum size.'
  );
}

async function readCredentialSecretObjectText(object: CredentialSecretTextObject): Promise<string> {
  if (typeof object.size === 'number' && object.size > CREDENTIAL_SECRET_OBJECT_MAX_BYTES) {
    throw credentialSecretEnvelopeTooLarge();
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
        if (totalBytes > CREDENTIAL_SECRET_OBJECT_MAX_BYTES) {
          void reader.cancel().catch(() => {});
          throw credentialSecretEnvelopeTooLarge();
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
    return new TextDecoder().decode(body);
  }

  const text = await object.text();
  if (new TextEncoder().encode(text).byteLength > CREDENTIAL_SECRET_OBJECT_MAX_BYTES) {
    throw credentialSecretEnvelopeTooLarge();
  }
  return text;
}

export interface CredentialSecretMetadata {
  destinationId: string;
  version: number;
  status?: CredentialSecretStatus;
  contentType?: string;
  createdAt?: number;
  rotatedAt?: number;
  retireAfter?: number | null;
  labels?: Record<string, string>;
}

export interface CredentialSecretMaterial {
  plaintext: string | Uint8Array;
  metadata: CredentialSecretMetadata;
}

export interface CredentialSecretPutInput {
  destinationId: string;
  version: number;
  plaintext: string | Uint8Array;
  metadata?: Omit<CredentialSecretMetadata, 'destinationId' | 'version'>;
}

export interface CredentialSecretRotateInput {
  destinationId: string;
  nextPlaintext: string | Uint8Array;
  nextVersion: number;
  metadata?: Omit<CredentialSecretMetadata, 'destinationId' | 'version'>;
}

export interface CredentialSecretRefParts {
  scheme: CredentialSecretRefScheme;
  authority: string;
  path: string;
  version?: number;
}

export interface CredentialSecretBackend {
  readonly kind: CredentialSecretBackendKind;
  putSecret(input: CredentialSecretPutInput): Promise<string>;
  getSecret(credentialRef: string, expectedVersion?: number): Promise<CredentialSecretMaterial>;
  rotateSecret(input: CredentialSecretRotateInput): Promise<string>;
  retireSecret(credentialRef: string): Promise<void>;
  deleteSecret(credentialRef: string): Promise<void>;
}

export interface CredentialSecretSqlStore {
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface CredentialSecretR2Bucket {
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  ): Promise<unknown>;
  get(key: string): Promise<CredentialSecretTextObject | null>;
  delete(key: string): Promise<void>;
}

export interface D1EncryptedCredentialSecretBackendOptions {
  store: CredentialSecretSqlStore;
  rootKeyHex: string;
  authority?: string;
  keyVersion?: number;
  now?: () => number;
}

export interface R2EncryptedCredentialSecretBackendOptions {
  bucket: CredentialSecretR2Bucket;
  metadataStore?: CredentialSecretSqlStore;
  rootKeyHex: string;
  bucketName?: string;
  keyPrefix?: string;
  keyVersion?: number;
  now?: () => number;
}

export class CredentialSecretBackendError extends Error {
  readonly code:
    | 'invalid_credential_ref'
    | 'version_mismatch'
    | 'backend_unavailable'
    | 'secret_not_found'
    | 'invalid_secret_envelope'
    | 'encryption_failed'
    | 'decryption_failed';

  constructor(
    code: CredentialSecretBackendError['code'],
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'CredentialSecretBackendError';
    this.code = code;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hexToBytes(hex: string): Uint8Array {
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new CredentialSecretBackendError(
      'encryption_failed',
      'Credential secret root key must be 64 hex characters.'
    );
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
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

function plaintextToString(value: string | Uint8Array): string {
  return typeof value === 'string' ? value : decoder.decode(value);
}

function buildSecretAdditionalData(input: {
  credentialRef: string;
  destinationId: string;
  version: number;
}): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      credential_ref: input.credentialRef,
      destination_id: input.destinationId,
      version: input.version,
    })
  );
}

async function deriveCredentialSecretKey(
  rootKeyHex: string,
  backend: CredentialSecretBackendKind,
  keyVersion: number
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', hexToBytes(rootKeyHex), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('authrim-credential-secret-root'),
      info: encoder.encode(`authrim:${backend}:v${keyVersion}`),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptCredentialSecret(
  plaintext: string | Uint8Array,
  options: {
    rootKeyHex: string;
    backend: Exclude<CredentialSecretBackendKind, 'external_secret_manager'>;
    keyVersion: number;
    contentType: string;
    credentialRef: string;
    destinationId: string;
    version: number;
  }
): Promise<EncryptedCredentialSecretEnvelope> {
  const key = await deriveCredentialSecretKey(
    options.rootKeyHex,
    options.backend,
    options.keyVersion
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: buildSecretAdditionalData(options),
      tagLength: 128,
    },
    key,
    encoder.encode(plaintextToString(plaintext))
  );

  return {
    version: 1,
    algorithm: 'AES-256-GCM',
    backend: options.backend,
    keyVersion: options.keyVersion,
    contentType: options.contentType,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function decryptCredentialSecret(
  envelope: EncryptedCredentialSecretEnvelope,
  options: {
    rootKeyHex: string;
    credentialRef: string;
    destinationId: string;
    version: number;
  }
): Promise<string> {
  try {
    const key = await deriveCredentialSecretKey(
      options.rootKeyHex,
      envelope.backend,
      envelope.keyVersion
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(envelope.iv),
        additionalData: buildSecretAdditionalData(options),
        tagLength: 128,
      },
      key,
      fromBase64Url(envelope.ciphertext)
    );
    return decoder.decode(plaintext);
  } catch (cause) {
    throw new CredentialSecretBackendError(
      'decryption_failed',
      'Credential secret could not be decrypted.',
      { cause }
    );
  }
}

export function buildCredentialSecretRef(parts: CredentialSecretRefParts): string {
  const normalizedPath = parts.path.startsWith('/') ? parts.path : `/${parts.path}`;
  const fragment = parts.version === undefined ? '' : `#v${parts.version}`;
  return `${parts.scheme}://${parts.authority}${normalizedPath}${fragment}`;
}

export function parseCredentialSecretRef(ref: string): CredentialSecretRefParts {
  let url: URL;
  try {
    url = new URL(ref);
  } catch (cause) {
    throw new CredentialSecretBackendError(
      'invalid_credential_ref',
      'Credential ref is not a URI.',
      {
        cause,
      }
    );
  }

  const scheme = url.protocol.slice(0, -1);
  if (!['r2secret', 'd1secret', 'cfsecret', 'extsecret'].includes(scheme)) {
    throw new CredentialSecretBackendError(
      'invalid_credential_ref',
      'Credential ref scheme is not supported.'
    );
  }

  const versionMatch = /^v(\d+)$/.exec(url.hash.slice(1));
  const version = versionMatch ? Number.parseInt(versionMatch[1] ?? '', 10) : undefined;

  return {
    scheme: scheme as CredentialSecretRefScheme,
    authority: url.host,
    path: url.pathname,
    version: Number.isFinite(version) ? version : undefined,
  };
}

export function assertCredentialRefVersion(ref: string, expectedVersion?: number): void {
  if (expectedVersion === undefined) {
    return;
  }
  const parsed = parseCredentialSecretRef(ref);
  if (parsed.version !== undefined && parsed.version !== expectedVersion) {
    throw new CredentialSecretBackendError(
      'version_mismatch',
      'Credential ref version does not match the expected version.'
    );
  }
}

export class D1EncryptedCredentialSecretBackend implements CredentialSecretBackend {
  readonly kind = 'd1_encrypted_table' as const;

  private readonly authority: string;
  private readonly keyVersion: number;
  private readonly now: () => number;

  constructor(private readonly options: D1EncryptedCredentialSecretBackendOptions) {
    this.authority = options.authority ?? 'admin';
    this.keyVersion = options.keyVersion ?? 1;
    this.now = options.now ?? Date.now;
  }

  async putSecret(input: CredentialSecretPutInput): Promise<string> {
    const now = this.now();
    const credentialRef = buildCredentialSecretRef({
      scheme: 'd1secret',
      authority: this.authority,
      path: `/credential_secrets/${input.destinationId}/v${input.version}`,
      version: input.version,
    });
    const metadata: CredentialSecretMetadata = {
      destinationId: input.destinationId,
      version: input.version,
      status: input.metadata?.status ?? 'active',
      contentType: input.metadata?.contentType ?? 'text/plain',
      createdAt: input.metadata?.createdAt ?? now,
      rotatedAt: input.metadata?.rotatedAt,
      retireAfter: input.metadata?.retireAfter,
      labels: input.metadata?.labels,
    };
    const envelope = await encryptCredentialSecret(input.plaintext, {
      rootKeyHex: this.options.rootKeyHex,
      backend: this.kind,
      keyVersion: this.keyVersion,
      contentType: metadata.contentType ?? 'text/plain',
      credentialRef,
      destinationId: input.destinationId,
      version: input.version,
    });

    await this.options.store.execute(
      `INSERT INTO credential_secret_bodies (
        credential_ref, destination_id, version, envelope_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [credentialRef, input.destinationId, input.version, JSON.stringify(envelope), now, now]
    );
    await this.options.store.execute(
      `INSERT INTO credential_secret_metadata (
        credential_ref, destination_id, backend, version, status, created_at, retired_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        credentialRef,
        input.destinationId,
        this.kind,
        input.version,
        metadata.status ?? 'active',
        metadata.createdAt ?? now,
        null,
        JSON.stringify(metadata),
      ]
    );

    return credentialRef;
  }

  async getSecret(
    credentialRef: string,
    expectedVersion?: number
  ): Promise<CredentialSecretMaterial> {
    assertCredentialRefVersion(credentialRef, expectedVersion);
    const parsed = parseCredentialSecretRef(credentialRef);
    if (parsed.scheme !== 'd1secret') {
      throw new CredentialSecretBackendError(
        'invalid_credential_ref',
        'Credential ref is not a D1 secret ref.'
      );
    }

    const row = await this.options.store.queryOne<{
      destination_id: string;
      version: number;
      envelope_json: string;
      metadata: string | null;
      status: CredentialSecretStatus;
    }>(
      `SELECT body.destination_id, body.version, body.envelope_json, meta.metadata, meta.status
       FROM credential_secret_bodies body
       LEFT JOIN credential_secret_metadata meta ON meta.credential_ref = body.credential_ref
       WHERE body.credential_ref = ?`,
      [credentialRef]
    );
    if (!row || row.status === 'deleted') {
      throw new CredentialSecretBackendError(
        'secret_not_found',
        'Credential secret was not found.'
      );
    }

    const envelope = JSON.parse(row.envelope_json) as EncryptedCredentialSecretEnvelope;
    const plaintext = await decryptCredentialSecret(envelope, {
      rootKeyHex: this.options.rootKeyHex,
      credentialRef,
      destinationId: row.destination_id,
      version: Number(row.version),
    });
    const metadata = row.metadata
      ? (JSON.parse(row.metadata) as CredentialSecretMetadata)
      : {
          destinationId: row.destination_id,
          version: Number(row.version),
          status: row.status,
        };

    return {
      plaintext,
      metadata,
    };
  }

  async rotateSecret(input: CredentialSecretRotateInput): Promise<string> {
    return this.putSecret({
      destinationId: input.destinationId,
      version: input.nextVersion,
      plaintext: input.nextPlaintext,
      metadata: {
        ...input.metadata,
        status: input.metadata?.status ?? 'next',
        rotatedAt: input.metadata?.rotatedAt ?? this.now(),
      },
    });
  }

  async retireSecret(credentialRef: string): Promise<void> {
    const now = this.now();
    await this.options.store.execute(
      `UPDATE credential_secret_metadata
       SET status = 'retired', retired_at = ?
       WHERE credential_ref = ?`,
      [now, credentialRef]
    );
  }

  async deleteSecret(credentialRef: string): Promise<void> {
    const now = this.now();
    await this.options.store.execute(
      `UPDATE credential_secret_metadata
       SET status = 'deleted', retired_at = ?
       WHERE credential_ref = ?`,
      [now, credentialRef]
    );
    await this.options.store.execute(
      `DELETE FROM credential_secret_bodies
       WHERE credential_ref = ?`,
      [credentialRef]
    );
  }
}

export class R2EncryptedCredentialSecretBackend implements CredentialSecretBackend {
  readonly kind = 'r2_encrypted_object' as const;

  private readonly bucketName: string;
  private readonly keyPrefix: string;
  private readonly keyVersion: number;
  private readonly now: () => number;

  constructor(private readonly options: R2EncryptedCredentialSecretBackendOptions) {
    this.bucketName = options.bucketName ?? 'admin-secrets';
    this.keyPrefix = (options.keyPrefix ?? 'destinations').replace(/^\/+|\/+$/g, '');
    this.keyVersion = options.keyVersion ?? 1;
    this.now = options.now ?? Date.now;
  }

  private buildObjectKey(destinationId: string, version: number): string {
    if (!Number.isInteger(version) || version < 1) {
      throw new CredentialSecretBackendError(
        'invalid_credential_ref',
        'Credential secret version must be a positive integer.'
      );
    }
    const cleanDestinationId =
      destinationId.replaceAll(/[^a-zA-Z0-9._=-]/g, '_').slice(0, 128) || 'unknown';
    return `${this.keyPrefix}/${cleanDestinationId}/credentials/v${version}.json`;
  }

  private objectKeyFromRef(credentialRef: string): string {
    const parsed = parseCredentialSecretRef(credentialRef);
    if (parsed.scheme !== 'r2secret') {
      throw new CredentialSecretBackendError(
        'invalid_credential_ref',
        'Credential ref is not an R2 secret ref.'
      );
    }
    if (parsed.authority !== this.bucketName) {
      throw new CredentialSecretBackendError(
        'invalid_credential_ref',
        'Credential ref authority does not match this backend.'
      );
    }
    return parsed.path.replace(/^\/+/, '');
  }

  async putSecret(input: CredentialSecretPutInput): Promise<string> {
    const now = this.now();
    const objectKey = this.buildObjectKey(input.destinationId, input.version);
    const credentialRef = buildCredentialSecretRef({
      scheme: 'r2secret',
      authority: this.bucketName,
      path: objectKey,
      version: input.version,
    });
    const metadata: CredentialSecretMetadata = {
      destinationId: input.destinationId,
      version: input.version,
      status: input.metadata?.status ?? 'active',
      contentType: input.metadata?.contentType ?? 'text/plain',
      createdAt: input.metadata?.createdAt ?? now,
      rotatedAt: input.metadata?.rotatedAt,
      retireAfter: input.metadata?.retireAfter,
      labels: input.metadata?.labels,
    };
    const envelope = await encryptCredentialSecret(input.plaintext, {
      rootKeyHex: this.options.rootKeyHex,
      backend: this.kind,
      keyVersion: this.keyVersion,
      contentType: metadata.contentType ?? 'text/plain',
      credentialRef,
      destinationId: input.destinationId,
      version: input.version,
    });

    await this.options.bucket.put(objectKey, JSON.stringify(envelope), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        credential_ref: credentialRef,
        destination_id: input.destinationId,
        version: String(input.version),
      },
    });
    await this.options.metadataStore?.execute(
      `INSERT INTO credential_secret_metadata (
        credential_ref, destination_id, backend, version, status, created_at, retired_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        credentialRef,
        input.destinationId,
        this.kind,
        input.version,
        metadata.status ?? 'active',
        metadata.createdAt ?? now,
        null,
        JSON.stringify(metadata),
      ]
    );

    return credentialRef;
  }

  async getSecret(
    credentialRef: string,
    expectedVersion?: number
  ): Promise<CredentialSecretMaterial> {
    assertCredentialRefVersion(credentialRef, expectedVersion);
    const objectKey = this.objectKeyFromRef(credentialRef);
    const object = await this.options.bucket.get(objectKey);
    if (!object) {
      throw new CredentialSecretBackendError(
        'secret_not_found',
        'Credential secret was not found.'
      );
    }

    const metadataRow = await this.options.metadataStore?.queryOne<{
      destination_id: string;
      version: number;
      metadata: string | null;
      status: CredentialSecretStatus;
    }>(
      `SELECT destination_id, version, metadata, status
       FROM credential_secret_metadata
       WHERE credential_ref = ?`,
      [credentialRef]
    );
    if (metadataRow?.status === 'deleted') {
      throw new CredentialSecretBackendError(
        'secret_not_found',
        'Credential secret was not found.'
      );
    }

    const parsed = parseCredentialSecretRef(credentialRef);
    const pathParts = parsed.path.split('/').filter(Boolean);
    const destinationId = metadataRow?.destination_id ?? pathParts[1];
    const version = metadataRow?.version ?? parsed.version;
    if (!destinationId || version === undefined) {
      throw new CredentialSecretBackendError(
        'invalid_credential_ref',
        'Credential ref does not include enough context.'
      );
    }

    const envelope = JSON.parse(
      await readCredentialSecretObjectText(object)
    ) as EncryptedCredentialSecretEnvelope;
    const plaintext = await decryptCredentialSecret(envelope, {
      rootKeyHex: this.options.rootKeyHex,
      credentialRef,
      destinationId,
      version: Number(version),
    });
    const metadata = metadataRow?.metadata
      ? (JSON.parse(metadataRow.metadata) as CredentialSecretMetadata)
      : {
          destinationId,
          version: Number(version),
        };

    return {
      plaintext,
      metadata,
    };
  }

  async rotateSecret(input: CredentialSecretRotateInput): Promise<string> {
    return this.putSecret({
      destinationId: input.destinationId,
      version: input.nextVersion,
      plaintext: input.nextPlaintext,
      metadata: {
        ...input.metadata,
        status: input.metadata?.status ?? 'next',
        rotatedAt: input.metadata?.rotatedAt ?? this.now(),
      },
    });
  }

  async retireSecret(credentialRef: string): Promise<void> {
    if (!this.options.metadataStore) {
      return;
    }
    const now = this.now();
    await this.options.metadataStore.execute(
      `UPDATE credential_secret_metadata
       SET status = 'retired', retired_at = ?
       WHERE credential_ref = ?`,
      [now, credentialRef]
    );
  }

  async deleteSecret(credentialRef: string): Promise<void> {
    const objectKey = this.objectKeyFromRef(credentialRef);
    await this.options.bucket.delete(objectKey);
    if (this.options.metadataStore) {
      const now = this.now();
      await this.options.metadataStore.execute(
        `UPDATE credential_secret_metadata
         SET status = 'deleted', retired_at = ?
         WHERE credential_ref = ?`,
        [now, credentialRef]
      );
    }
  }
}

export class ExternalCredentialSecretManagerStub implements CredentialSecretBackend {
  readonly kind = 'external_secret_manager' as const;

  async putSecret(_input: CredentialSecretPutInput): Promise<string> {
    throw new CredentialSecretBackendError(
      'backend_unavailable',
      'External credential secret manager is not configured.'
    );
  }

  async getSecret(
    _credentialRef: string,
    _expectedVersion?: number
  ): Promise<CredentialSecretMaterial> {
    throw new CredentialSecretBackendError(
      'backend_unavailable',
      'External credential secret manager is not configured.'
    );
  }

  async rotateSecret(_input: CredentialSecretRotateInput): Promise<string> {
    throw new CredentialSecretBackendError(
      'backend_unavailable',
      'External credential secret manager is not configured.'
    );
  }

  async retireSecret(_credentialRef: string): Promise<void> {
    throw new CredentialSecretBackendError(
      'backend_unavailable',
      'External credential secret manager is not configured.'
    );
  }

  async deleteSecret(_credentialRef: string): Promise<void> {
    throw new CredentialSecretBackendError(
      'backend_unavailable',
      'External credential secret manager is not configured.'
    );
  }
}
