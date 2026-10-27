import { normalizeAwsRuntimeUiConfig, type AwsRuntimeUiConfig } from '../ui/runtime-ui-config';
import { normalizeAwsAuthStateConfig, type AwsAuthStateConfig } from '../storage/auth-state-config';
import type { OpenVerifiedTenantBackupV2Input } from '../import/backup-reader';
import type { AwsRestoreActivationEvidence } from '../import/restore-coordinator';
import type { LoadActivatedAwsSamlTenantInput } from './load-activated-tenant';
import {
  parseReplicationWriterConfiguration,
  type ReplicationWriterConfiguration,
} from '@authrim/ar-lib-core/services/deployment-replication/writer';
import { assertReplicationSecret } from '@authrim/ar-lib-core/services/deployment-replication/transport';

export interface AwsS3ObjectPin {
  key: string;
  versionId: string;
  size: number;
  sha256: string;
}

/** Immutable, deployment-owned S3 document. It contains no database passwords or signing keys. */
export interface AwsSamlDeploymentManifest {
  formatVersion: 1;
  evidence: AwsRestoreActivationEvidence;
  backup: Pick<
    OpenVerifiedTenantBackupV2Input,
    'receipt' | 'selection' | 'datasets' | 'maxSnapshotAgeMs'
  > & {
    parts: readonly AwsS3ObjectPin[];
  };
  supplement: AwsS3ObjectPin;
  core: { targetId: string; bindingRefs: readonly string[] };
  pii: { targetId: string; bindingRefs: readonly string[] };
  environmentName: string;
  destinationUi?: AwsRuntimeUiConfig;
  authState?: AwsAuthStateConfig;
  replicationWriter?: ReplicationWriterConfiguration;
  spEntityIds: readonly string[];
  allocationScope: LoadActivatedAwsSamlTenantInput['allocationScope'];
}

/** One pinned Secrets Manager version per tenant deployment. */
export interface AwsSamlDeploymentSecrets {
  formatVersion: 1;
  tenantId: string;
  backupPassphrase: string;
  coreDatabaseUrl: string;
  piiDatabaseUrl: string;
  stateDatabaseUrl: string;
  flowHmacSecret: string;
  lookupReadKeys: LoadActivatedAwsSamlTenantInput['awsLookupReadKeys'];
  replicationWriterSecret?: string;
}

export interface AwsSamlDeploymentLocation {
  region: string;
  issuerOrigin: string;
  secretArn: string;
  secretVersionId: string;
  bucket: string;
  bucketOwner: string;
  manifestKey: string;
  manifestVersionId: string;
  manifestSha256: string;
}

export const MAX_AWS_STARTUP_ASSET_BYTES = 256 * 1024 * 1024;
export const MAX_AWS_STARTUP_MANIFEST_BYTES = 2 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;

function invalid(): never {
  throw new Error('aws_deployment_config_invalid');
}

function exact(value: object, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    invalid();
}

function nonEmpty(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}

export function assertS3Version(value: unknown): asserts value is string {
  if (!nonEmpty(value, 1024) || value === 'null') invalid();
}

export function parseAwsSamlDeploymentLocation(
  environment: Readonly<Record<string, string | undefined>>
): AwsSamlDeploymentLocation {
  const read = (name: string) => environment[name] ?? invalid();
  const result = {
    region: read('AWS_REGION'),
    issuerOrigin: read('AUTHRIM_AWS_ISSUER_ORIGIN'),
    secretArn: read('AUTHRIM_AWS_RUNTIME_SECRET_ARN'),
    secretVersionId: read('AUTHRIM_AWS_RUNTIME_SECRET_VERSION_ID'),
    bucket: read('AUTHRIM_AWS_MANIFEST_BUCKET'),
    bucketOwner: read('AUTHRIM_AWS_BUCKET_OWNER'),
    manifestKey: read('AUTHRIM_AWS_MANIFEST_KEY'),
    manifestVersionId: read('AUTHRIM_AWS_MANIFEST_VERSION_ID'),
    manifestSha256: read('AUTHRIM_AWS_MANIFEST_SHA256'),
  };
  let issuer: URL;
  try {
    issuer = new URL(result.issuerOrigin);
  } catch {
    return invalid();
  }
  if (
    issuer.protocol !== 'https:' ||
    issuer.origin !== result.issuerOrigin ||
    issuer.username ||
    issuer.password
  )
    invalid();
  const arn =
    /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:([a-z0-9-]+):(\d{12}):secret:([A-Za-z0-9/_+=.@-]+)$/u.exec(
      result.secretArn
    );
  if (
    !/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(result.region) ||
    !arn ||
    arn[2] !== result.region ||
    arn[3] !== result.bucketOwner ||
    !/^[A-Za-z0-9-]{32,64}$/u.test(result.secretVersionId) ||
    !/^\d{12}$/u.test(result.bucketOwner) ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(result.bucket) ||
    /\.\.|\.-|-\./u.test(result.bucket) ||
    /^\d+\.\d+\.\d+\.\d+$/u.test(result.bucket) ||
    !nonEmpty(result.manifestKey, 1024) ||
    !HASH.test(result.manifestSha256)
  )
    invalid();
  assertS3Version(result.manifestVersionId);
  return result;
}

export function assertAwsDatabaseTlsUrl(value: unknown): asserts value is string {
  if (!nonEmpty(value, 8192)) invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.password ||
    !url.pathname ||
    url.pathname === '/' ||
    url.hash ||
    url.hostname.includes('/') ||
    url.hostname.startsWith('[') ||
    url.searchParams.getAll('sslmode').length !== 1 ||
    url.searchParams.get('sslmode') !== 'verify-full' ||
    [...url.searchParams.keys()].some((key) => key !== 'sslmode')
  )
    invalid();
}

export function parseAwsSamlDeploymentSecrets(
  raw: string,
  expectedTenantId: string
): AwsSamlDeploymentSecrets {
  try {
    if (new TextEncoder().encode(raw).byteLength > 65_536) invalid();
    const value = JSON.parse(raw) as AwsSamlDeploymentSecrets;
    exact(value, [
      'formatVersion',
      'tenantId',
      'backupPassphrase',
      'coreDatabaseUrl',
      'piiDatabaseUrl',
      'stateDatabaseUrl',
      'flowHmacSecret',
      'lookupReadKeys',
      ...(Object.hasOwn(value, 'replicationWriterSecret') ? ['replicationWriterSecret'] : []),
    ]);
    if (Object.hasOwn(value, 'replicationWriterSecret'))
      assertReplicationSecret(value.replicationWriterSecret);
    if (
      value.formatVersion !== 1 ||
      value.tenantId !== expectedTenantId ||
      typeof value.backupPassphrase !== 'string' ||
      value.backupPassphrase.length < 16 ||
      value.backupPassphrase.length > 1024 ||
      !nonEmpty(value.flowHmacSecret, 4096) ||
      value.flowHmacSecret.length < 32 ||
      !Array.isArray(value.lookupReadKeys as unknown) ||
      value.lookupReadKeys.length < 1 ||
      value.lookupReadKeys.length > 2
    )
      invalid();
    for (const url of [value.coreDatabaseUrl, value.piiDatabaseUrl, value.stateDatabaseUrl])
      assertAwsDatabaseTlsUrl(url);
    const generations = new Set<number>();
    for (const key of value.lookupReadKeys) {
      exact(key, ['generation', 'secret']);
      if (
        !Number.isSafeInteger(key.generation) ||
        key.generation < 1 ||
        generations.has(key.generation) ||
        !nonEmpty(key.secret, 4096) ||
        key.secret.length < 32
      )
        invalid();
      generations.add(key.generation);
    }
    return value;
  } catch {
    return invalid();
  }
}

export function parseAwsSamlDeploymentManifest(raw: string): AwsSamlDeploymentManifest {
  try {
    if (new TextEncoder().encode(raw).byteLength > MAX_AWS_STARTUP_MANIFEST_BYTES) invalid();
    const value = JSON.parse(raw) as AwsSamlDeploymentManifest;
    exact(value, [
      'formatVersion',
      'evidence',
      'backup',
      'supplement',
      'core',
      'pii',
      'environmentName',
      'spEntityIds',
      'allocationScope',
      ...(Object.hasOwn(value, 'destinationUi') ? ['destinationUi'] : []),
      ...(Object.hasOwn(value, 'authState') ? ['authState'] : []),
      ...(Object.hasOwn(value, 'replicationWriter') ? ['replicationWriter'] : []),
    ]);
    if (Object.hasOwn(value, 'replicationWriter')) {
      value.replicationWriter = parseReplicationWriterConfiguration(
        JSON.stringify(value.replicationWriter)
      );
      if (
        value.replicationWriter.tenantId !== value.evidence?.tenantId ||
        (value.replicationWriter.version === 1
          ? value.replicationWriter.generationId !== value.evidence?.restoreId
          : value.replicationWriter.restoreId !== value.evidence?.restoreId)
      )
        invalid();
    }
    if (Object.hasOwn(value, 'destinationUi'))
      value.destinationUi = normalizeAwsRuntimeUiConfig(value.destinationUi);
    if (Object.hasOwn(value, 'authState'))
      value.authState = normalizeAwsAuthStateConfig(value.authState, {
        restoreId: value.evidence?.restoreId,
      });
    exact(value.backup, ['receipt', 'selection', 'datasets', 'maxSnapshotAgeMs', 'parts']);
    exact(value.core, ['targetId', 'bindingRefs']);
    exact(value.pii, ['targetId', 'bindingRefs']);
    if (
      value.formatVersion !== 1 ||
      !value.evidence ||
      !value.backup.receipt ||
      !Array.isArray(value.backup.parts as unknown) ||
      value.backup.parts.length === 0 ||
      value.backup.parts.length > 128 ||
      !Array.isArray(value.backup.receipt.parts as unknown) ||
      value.backup.receipt.parts.length !== value.backup.parts.length ||
      !Array.isArray(value.spEntityIds as unknown) ||
      value.spEntityIds.length === 0 ||
      !['shared_pool', 'tenant_exclusive'].includes(value.allocationScope)
    )
      invalid();
    let bytes = 0;
    const identities = new Set<string>();
    for (const pin of [...value.backup.parts, value.supplement]) {
      exact(pin, ['key', 'versionId', 'size', 'sha256']);
      assertS3Version(pin.versionId);
      if (
        !nonEmpty(pin.key, 1024) ||
        !Number.isSafeInteger(pin.size) ||
        pin.size < 1 ||
        !HASH.test(pin.sha256)
      )
        invalid();
      const identity = JSON.stringify([pin.key, pin.versionId]);
      if (identities.has(identity)) invalid();
      identities.add(identity);
      bytes += pin.size;
      if (!Number.isSafeInteger(bytes) || bytes > MAX_AWS_STARTUP_ASSET_BYTES) invalid();
    }
    for (let index = 0; index < value.backup.parts.length; index++) {
      const pin = value.backup.parts[index];
      const receipt = value.backup.receipt.parts[index];
      if (pin.size !== receipt.size || pin.sha256 !== receipt.sha256) invalid();
    }
    if (value.supplement.sha256 !== value.evidence.supplementFileSha256) invalid();
    return value;
  } catch {
    return invalid();
  }
}
