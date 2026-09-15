import { CompactSign, compactVerify, importJWK, importPKCS8, type JWK } from 'jose';

export type PortableKeyStatus = 'active' | 'overlap' | 'revoked';
export type PortableECAlgorithm = 'ES256' | 'ES384' | 'ES512';

export interface PortableRsaKey {
  kid: string;
  publicJWK: JWK;
  privatePEM: string;
  createdAt: number;
  status: PortableKeyStatus;
  certificatePEM?: string;
  certificateCreatedAt?: number;
  certificateSha256Thumbprint?: string;
  expiresAt?: number;
  revokedAt?: number;
  revokedReason?: string;
}

export interface PortableEcKey {
  kid: string;
  algorithm: PortableECAlgorithm;
  curve: 'P-256' | 'P-384' | 'P-521';
  publicJWK: JWK;
  privatePEM: string;
  createdAt: number;
  status: PortableKeyStatus;
  expiresAt?: number;
  revokedAt?: number;
  revokedReason?: string;
}

interface RotationConfig {
  rotationIntervalDays: number;
  retentionPeriodDays: number;
}

interface PortableSecretVersion {
  kid: string;
  value: string;
  createdAt: number;
}

interface PortableSecret {
  secretRef: string;
  active: PortableSecretVersion;
  previous?: PortableSecretVersion;
  updatedAt: number;
}

export interface KeyManagerTenantBackupSnapshot {
  kind: 'authrim.key_manager_tenant_backup.v1';
  version: 1;
  rsa: {
    keys: PortableRsaKey[];
    activeKeyId: string | null;
    config: RotationConfig;
    lastRotation: number | null;
    secrets: Record<string, PortableSecret>;
  };
  vcEc: {
    keys: PortableEcKey[];
    activeKeyIds: Record<PortableECAlgorithm, string | null>;
    config: RotationConfig;
    lastRotation: number | null;
  };
  oidcEs256: {
    keys: PortableEcKey[];
    activeKeyId: string | null;
    config: RotationConfig;
    lastRotation: number | null;
  };
  oidcPs256: {
    keys: PortableRsaKey[];
    activeKeyId: string | null;
    config: RotationConfig;
    lastRotation: number | null;
  };
}

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_KEYS_PER_STATE = 128;
const MAX_SECRETS = 256;
const SECRET_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

function invalid(): never {
  throw new Error('backup_key_manager_snapshot_invalid');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
) {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    invalid();
}

function string(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || new TextEncoder().encode(value).length > max)
    invalid();
  return value;
}

function optionalString(value: unknown, max = 4096): string | undefined {
  return value === undefined ? undefined : string(value, max);
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function optionalTimestamp(value: unknown): number | undefined {
  return value === undefined ? undefined : timestamp(value);
}

function nullableTimestamp(value: unknown): number | null {
  return value === null ? null : timestamp(value);
}

function status(value: unknown): PortableKeyStatus {
  if (!['active', 'overlap', 'revoked'].includes(value as string)) invalid();
  return value as PortableKeyStatus;
}

function rotationConfig(value: unknown): RotationConfig {
  const source = object(value);
  exactKeys(source, ['rotationIntervalDays', 'retentionPeriodDays']);
  const rotationIntervalDays = timestamp(source.rotationIntervalDays);
  const retentionPeriodDays = timestamp(source.retentionPeriodDays);
  if (rotationIntervalDays < 1 || rotationIntervalDays > 3650 || retentionPeriodDays > 3650)
    invalid();
  return { rotationIntervalDays, retentionPeriodDays };
}

function jwk(value: unknown, kid: string, algorithm: string, curve?: string): JWK {
  const source = object(value) as JWK;
  if (
    source.kid !== kid ||
    source.use !== 'sig' ||
    source.alg !== algorithm ||
    (curve ? source.kty !== 'EC' || source.crv !== curve : source.kty !== 'RSA') ||
    'd' in source
  )
    invalid();
  return structuredClone(source);
}

function commonKey(
  value: unknown,
  additionalRequired: readonly string[],
  additionalOptional: readonly string[] = []
) {
  const source = object(value);
  exactKeys(
    source,
    ['kid', 'privatePEM', 'publicJWK', 'createdAt', 'status', ...additionalRequired],
    ['expiresAt', 'revokedAt', 'revokedReason', ...additionalOptional]
  );
  const kid = string(source.kid);
  const privatePEM = string(source.privatePEM, 64 * 1024);
  if (
    !privatePEM.startsWith('-----BEGIN PRIVATE KEY-----') ||
    !privatePEM.includes('-----END PRIVATE KEY-----')
  )
    invalid();
  const result = {
    kid,
    privatePEM,
    createdAt: timestamp(source.createdAt),
    status: status(source.status),
    expiresAt: optionalTimestamp(source.expiresAt),
    revokedAt: optionalTimestamp(source.revokedAt),
    revokedReason: optionalString(source.revokedReason, 2048),
  };
  if (result.status === 'revoked' && result.revokedAt === undefined) invalid();
  return { source, result };
}

function rsaKey(value: unknown, algorithm: 'RS256' | 'PS256'): PortableRsaKey {
  const { source, result } = commonKey(
    value,
    [],
    ['certificatePEM', 'certificateCreatedAt', 'certificateSha256Thumbprint']
  );
  const certificatePEM = optionalString(source.certificatePEM, 32 * 1024);
  if (
    certificatePEM &&
    (!certificatePEM.startsWith('-----BEGIN CERTIFICATE-----') ||
      !certificatePEM.includes('-----END CERTIFICATE-----'))
  )
    invalid();
  return {
    ...result,
    publicJWK: jwk(source.publicJWK, result.kid, algorithm),
    certificatePEM,
    certificateCreatedAt: optionalTimestamp(source.certificateCreatedAt),
    certificateSha256Thumbprint: optionalString(source.certificateSha256Thumbprint, 256),
  };
}

const curves: Record<PortableECAlgorithm, PortableEcKey['curve']> = {
  ES256: 'P-256',
  ES384: 'P-384',
  ES512: 'P-521',
};

function ecKey(value: unknown, requiredAlgorithm?: PortableECAlgorithm): PortableEcKey {
  const { source, result } = commonKey(value, ['algorithm', 'curve']);
  const algorithm = source.algorithm as PortableECAlgorithm;
  if (!Object.hasOwn(curves, algorithm) || (requiredAlgorithm && algorithm !== requiredAlgorithm))
    invalid();
  const curve = curves[algorithm];
  if (source.curve !== curve) invalid();
  return {
    ...result,
    algorithm,
    curve,
    publicJWK: jwk(source.publicJWK, result.kid, algorithm, curve),
  };
}

async function verifyPair(key: PortableRsaKey | PortableEcKey, algorithm: string): Promise<void> {
  try {
    const privateKey = await importPKCS8(key.privatePEM, algorithm);
    const publicKey = await importJWK(key.publicJWK, algorithm);
    if (publicKey instanceof Uint8Array) invalid();
    const token = await new CompactSign(new TextEncoder().encode('authrim-backup-key-check'))
      .setProtectedHeader({ alg: algorithm, kid: key.kid })
      .sign(privateKey);
    await compactVerify(token, publicKey, { algorithms: [algorithm] });
  } catch {
    invalid();
  }
}

function assertActive(
  keys: readonly { kid: string; status: PortableKeyStatus }[],
  active: unknown
) {
  const activeKeyId = active === null ? null : string(active);
  const activeKeys = keys.filter((key) => key.status === 'active');
  if (
    (activeKeyId === null && activeKeys.length !== 0) ||
    (activeKeyId !== null &&
      (activeKeys.length !== 1 ||
        activeKeys[0].kid !== activeKeyId ||
        !keys.some((k) => k.kid === activeKeyId)))
  )
    invalid();
  return activeKeyId;
}

function keyArray<T>(value: unknown, read: (item: unknown) => T & { kid: string }): T[] {
  if (!Array.isArray(value) || value.length > MAX_KEYS_PER_STATE) invalid();
  const keys = value.map(read);
  if (new Set(keys.map(({ kid }) => kid)).size !== keys.length) invalid();
  return keys;
}

function secretVersion(value: unknown): PortableSecretVersion {
  const source = object(value);
  exactKeys(source, ['kid', 'value', 'createdAt']);
  return {
    kid: string(source.kid),
    value: string(source.value, 128 * 1024),
    createdAt: timestamp(source.createdAt),
  };
}

function secrets(value: unknown): Record<string, PortableSecret> {
  const source = object(value);
  const entries = Object.entries(source);
  if (entries.length > MAX_SECRETS) invalid();
  return Object.fromEntries(
    entries.map(([secretRef, raw]) => {
      if (
        !SECRET_REF.test(secretRef) ||
        ['__proto__', 'constructor', 'prototype'].includes(secretRef)
      )
        invalid();
      const record = object(raw);
      exactKeys(record, ['secretRef', 'active', 'updatedAt'], ['previous']);
      const active = secretVersion(record.active);
      const previous = record.previous === undefined ? undefined : secretVersion(record.previous);
      if (record.secretRef !== secretRef || previous?.kid === active.kid) invalid();
      return [
        secretRef,
        {
          secretRef,
          active,
          previous,
          updatedAt: timestamp(record.updatedAt),
        },
      ];
    })
  );
}

/** Validate shape, state invariants and every public/private signing key pair. */
export async function normalizeKeyManagerTenantBackupSnapshot(
  input: unknown
): Promise<KeyManagerTenantBackupSnapshot> {
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    return invalid();
  }
  if (!encoded || new TextEncoder().encode(encoded).length > MAX_SNAPSHOT_BYTES) invalid();
  const source = object(input);
  exactKeys(source, ['kind', 'version', 'rsa', 'vcEc', 'oidcEs256', 'oidcPs256']);
  if (source.kind !== 'authrim.key_manager_tenant_backup.v1' || source.version !== 1) invalid();
  const rsaSource = object(source.rsa);
  const vcSource = object(source.vcEc);
  const oidcEsSource = object(source.oidcEs256);
  const oidcPsSource = object(source.oidcPs256);
  exactKeys(rsaSource, ['keys', 'activeKeyId', 'config', 'lastRotation', 'secrets']);
  exactKeys(vcSource, ['keys', 'activeKeyIds', 'config', 'lastRotation']);
  exactKeys(oidcEsSource, ['keys', 'activeKeyId', 'config', 'lastRotation']);
  exactKeys(oidcPsSource, ['keys', 'activeKeyId', 'config', 'lastRotation']);
  const rsaKeys = keyArray(rsaSource.keys, (key) => rsaKey(key, 'RS256'));
  const vcKeys = keyArray(vcSource.keys, (key) => ecKey(key));
  const oidcEsKeys = keyArray(oidcEsSource.keys, (key) => ecKey(key, 'ES256'));
  const oidcPsKeys = keyArray(oidcPsSource.keys, (key) => rsaKey(key, 'PS256'));
  const vcActiveSource = object(vcSource.activeKeyIds);
  exactKeys(vcActiveSource, ['ES256', 'ES384', 'ES512']);
  const vcActive = Object.fromEntries(
    (Object.keys(curves) as PortableECAlgorithm[]).map((algorithm) => [
      algorithm,
      assertActive(
        vcKeys.filter((key) => key.algorithm === algorithm),
        vcActiveSource[algorithm]
      ),
    ])
  ) as Record<PortableECAlgorithm, string | null>;
  await Promise.all([
    ...rsaKeys.map((key) => verifyPair(key, 'RS256')),
    ...vcKeys.map((key) => verifyPair(key, key.algorithm)),
    ...oidcEsKeys.map((key) => verifyPair(key, 'ES256')),
    ...oidcPsKeys.map((key) => verifyPair(key, 'PS256')),
  ]);
  return {
    kind: 'authrim.key_manager_tenant_backup.v1',
    version: 1,
    rsa: {
      keys: rsaKeys,
      activeKeyId: assertActive(rsaKeys, rsaSource.activeKeyId),
      config: rotationConfig(rsaSource.config),
      lastRotation: nullableTimestamp(rsaSource.lastRotation),
      secrets: secrets(rsaSource.secrets ?? {}),
    },
    vcEc: {
      keys: vcKeys,
      activeKeyIds: vcActive,
      config: rotationConfig(vcSource.config),
      lastRotation: nullableTimestamp(vcSource.lastRotation),
    },
    oidcEs256: {
      keys: oidcEsKeys,
      activeKeyId: assertActive(oidcEsKeys, oidcEsSource.activeKeyId),
      config: rotationConfig(oidcEsSource.config),
      lastRotation: nullableTimestamp(oidcEsSource.lastRotation),
    },
    oidcPs256: {
      keys: oidcPsKeys,
      activeKeyId: assertActive(oidcPsKeys, oidcPsSource.activeKeyId),
      config: rotationConfig(oidcPsSource.config),
      lastRotation: nullableTimestamp(oidcPsSource.lastRotation),
    },
  };
}

export function keyManagerTenantBackupSnapshotIsEmpty(
  snapshot: KeyManagerTenantBackupSnapshot
): boolean {
  return (
    snapshot.rsa.keys.length === 0 &&
    Object.keys(snapshot.rsa.secrets).length === 0 &&
    snapshot.vcEc.keys.length === 0 &&
    snapshot.oidcEs256.keys.length === 0 &&
    snapshot.oidcPs256.keys.length === 0
  );
}

export function emptyKeyManagerTenantBackupSnapshot(): KeyManagerTenantBackupSnapshot {
  const config = { rotationIntervalDays: 90, retentionPeriodDays: 30 };
  return {
    kind: 'authrim.key_manager_tenant_backup.v1',
    version: 1,
    rsa: { keys: [], activeKeyId: null, config: { ...config }, lastRotation: null, secrets: {} },
    vcEc: {
      keys: [],
      activeKeyIds: { ES256: null, ES384: null, ES512: null },
      config: { ...config },
      lastRotation: null,
    },
    oidcEs256: { keys: [], activeKeyId: null, config: { ...config }, lastRotation: null },
    oidcPs256: { keys: [], activeKeyId: null, config: { ...config }, lastRotation: null },
  };
}

export function keyManagerTenantBackupSnapshotsEqual(
  left: KeyManagerTenantBackupSnapshot,
  right: KeyManagerTenantBackupSnapshot
): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
