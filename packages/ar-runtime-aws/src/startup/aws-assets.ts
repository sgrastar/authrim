import { createHash } from 'node:crypto';
import { mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { canonicalRestoreJson } from '../import/restore-evidence';
import { normalizeAwsAuthStateConfig } from '../storage/auth-state-config';
import {
  loadActivatedAwsSamlTenant,
  type LoadActivatedAwsSamlTenantInput,
} from './load-activated-tenant';
import {
  MAX_AWS_STARTUP_MANIFEST_BYTES,
  parseAwsSamlDeploymentManifest,
  parseAwsSamlDeploymentSecrets,
  type AwsSamlDeploymentLocation,
  type AwsS3ObjectPin,
} from './deployment-config';

export interface AwsAssetReader {
  getSecret(input: { arn: string; versionId: string; signal: AbortSignal }): Promise<{
    arn: string | undefined;
    versionId: string | undefined;
    value: string | undefined;
  }>;
  getObject(input: {
    bucket: string;
    owner: string;
    key: string;
    versionId: string;
    signal: AbortSignal;
  }): Promise<{
    versionId: string | undefined;
    size: number | undefined;
    body: AsyncIterable<Uint8Array>;
    close(): void;
  }>;
  close(): void;
}

function invalid(): never {
  throw new Error('aws_deployment_assets_invalid');
}

/** SDK clients are reused for warm invocations; only pinned read APIs are exposed. */
export function createAwsSdkAssetReader(region: string | undefined): AwsAssetReader {
  const clientConfig = {
    region,
    maxAttempts: 2,
    ignoreConfiguredEndpointUrls: true,
    requestHandler: {
      connectionTimeout: 3_000,
      requestTimeout: 15_000,
      httpsAgent: { maxSockets: 4 },
    },
  };
  const s3 = new S3Client(clientConfig);
  const secrets = new SecretsManagerClient(clientConfig);
  return {
    async getSecret(input) {
      const value = await secrets.send(
        new GetSecretValueCommand({ SecretId: input.arn, VersionId: input.versionId }),
        { abortSignal: input.signal }
      );
      return { arn: value.ARN, versionId: value.VersionId, value: value.SecretString };
    },
    async getObject(input) {
      const value = await s3.send(
        new GetObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          VersionId: input.versionId,
          ExpectedBucketOwner: input.owner,
        }),
        { abortSignal: input.signal }
      );
      const body = value.Body;
      if (!(body instanceof Readable)) {
        if (body && 'cancel' in body && typeof body.cancel === 'function') await body.cancel();
        invalid();
      }
      const abort = () => body.destroy(new Error('aws_asset_read_aborted'));
      input.signal.addEventListener('abort', abort, { once: true });
      if (input.signal.aborted) abort();
      return {
        versionId: value.VersionId,
        size: value.ContentLength,
        body: body as AsyncIterable<Uint8Array>,
        close() {
          input.signal.removeEventListener('abort', abort);
          body.destroy();
        },
      };
    },
    close() {
      s3.destroy();
      secrets.destroy();
    },
  };
}

async function consumeObject(input: {
  reader: AwsAssetReader;
  location: AwsSamlDeploymentLocation;
  key: string;
  versionId: string;
  expectedSize?: number;
  expectedSha256: string;
  maxBytes: number;
  signal: AbortSignal;
  write(chunk: Uint8Array): Promise<void>;
}) {
  const object = await input.reader.getObject({
    bucket: input.location.bucket,
    owner: input.location.bucketOwner,
    key: input.key,
    versionId: input.versionId,
    signal: input.signal,
  });
  try {
    if (
      object.versionId !== input.versionId ||
      !Number.isSafeInteger(object.size) ||
      (object.size ?? 0) < 1 ||
      (object.size ?? 0) > input.maxBytes ||
      (input.expectedSize !== undefined && object.size !== input.expectedSize)
    )
      invalid();
    let size = 0;
    const hash = createHash('sha256');
    for await (const chunk of object.body) {
      input.signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) invalid();
      size += chunk.byteLength;
      if (size > input.maxBytes || size > (object.size ?? 0)) invalid();
      hash.update(chunk);
      await input.write(chunk);
    }
    if (size !== object.size || hash.digest('hex') !== input.expectedSha256) invalid();
  } finally {
    object.close();
  }
}

async function downloadAsset(
  reader: AwsAssetReader,
  location: AwsSamlDeploymentLocation,
  pin: AwsS3ObjectPin,
  path: string,
  signal: AbortSignal
) {
  const file = await open(path, 'wx', 0o600);
  try {
    await consumeObject({
      reader,
      location,
      key: pin.key,
      versionId: pin.versionId,
      expectedSize: pin.size,
      expectedSha256: pin.sha256,
      maxBytes: pin.size,
      signal,
      write: async (chunk) => {
        await file.writeFile(chunk);
      },
    });
  } finally {
    await file.close();
  }
}

/** Download trusted inputs for one issuer; never execute SQL imports during a cold start. */
export async function loadAwsSamlDeployment(input: {
  location: AwsSamlDeploymentLocation;
  reader: AwsAssetReader;
  /** Test seam; production always uses the verified published-state loader. */
  loadTenant?: typeof loadActivatedAwsSamlTenant;
}): Promise<Awaited<ReturnType<typeof loadActivatedAwsSamlTenant>>> {
  const location = structuredClone(input.location);
  const signal = AbortSignal.timeout(25_000);
  let directory: string | undefined;
  let loaded: Awaited<ReturnType<typeof loadActivatedAwsSamlTenant>> | undefined;
  try {
    const chunks: Uint8Array[] = [];
    await consumeObject({
      reader: input.reader,
      location,
      key: location.manifestKey,
      versionId: location.manifestVersionId,
      expectedSha256: location.manifestSha256,
      maxBytes: MAX_AWS_STARTUP_MANIFEST_BYTES,
      signal,
      write: async (chunk) => {
        chunks.push(chunk.slice());
      },
    });
    const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const manifest = parseAwsSamlDeploymentManifest(raw);
    normalizeAwsAuthStateConfig(manifest.authState, {
      accountId: location.bucketOwner,
      region: location.region,
      restoreId: manifest.evidence.restoreId,
    });
    if (
      raw !== canonicalRestoreJson(manifest) ||
      manifest.evidence.issuer !== location.issuerOrigin
    )
      invalid();
    const secret = await input.reader.getSecret({
      arn: location.secretArn,
      versionId: location.secretVersionId,
      signal,
    });
    if (
      secret.arn !== location.secretArn ||
      secret.versionId !== location.secretVersionId ||
      secret.value === undefined
    )
      invalid();
    const config = parseAwsSamlDeploymentSecrets(secret.value, manifest.evidence.tenantId);
    if (
      (manifest.replicationWriter === undefined) !==
      (config.replicationWriterSecret === undefined)
    )
      invalid();
    directory = await mkdtemp(join(await realpath(tmpdir()), 'authrim-aws-startup-'));
    const partPaths: string[] = [];
    for (let index = 0; index < manifest.backup.parts.length; index++) {
      const path = join(directory, `part-${index}.authrim`);
      await downloadAsset(input.reader, location, manifest.backup.parts[index], path, signal);
      partPaths.push(path);
    }
    const supplementPath = join(directory, 'supplement.json');
    await downloadAsset(input.reader, location, manifest.supplement, supplementPath, signal);
    signal.throwIfAborted();
    const tenantInput: LoadActivatedAwsSamlTenantInput = {
      backup: {
        partPaths,
        receipt: manifest.backup.receipt,
        selection: manifest.backup.selection,
        datasets: manifest.backup.datasets,
        maxSnapshotAgeMs: manifest.backup.maxSnapshotAgeMs,
        passphrase: config.backupPassphrase,
        signal,
      },
      supplement: { path: supplementPath, expectedSha256: manifest.supplement.sha256 },
      evidence: manifest.evidence,
      core: { ...manifest.core, connectionString: config.coreDatabaseUrl },
      pii: { ...manifest.pii, connectionString: config.piiDatabaseUrl },
      state: { connectionString: config.stateDatabaseUrl },
      environmentName: manifest.environmentName,
      spEntityIds: manifest.spEntityIds,
      allocationScope: manifest.allocationScope,
      ...(manifest.destinationUi === undefined ? {} : { destinationUi: manifest.destinationUi }),
      ...(manifest.authState === undefined ? {} : { authState: manifest.authState }),
      awsFlowRuntimeHmacSecret: config.flowHmacSecret,
      awsLookupReadKeys: config.lookupReadKeys,
    };
    loaded = await (input.loadTenant ?? loadActivatedAwsSamlTenant)(tenantInput);
    if (manifest.replicationWriter !== undefined) {
      loaded.runtime.env.AUTHRIM_REPLICATION_WRITER = canonicalRestoreJson(
        manifest.replicationWriter
      );
      loaded.runtime.env.AUTHRIM_REPLICATION_WRITER_SECRET = config.replicationWriterSecret;
    }
    signal.throwIfAborted();
    await rm(directory, { recursive: true });
    directory = undefined;
    return loaded;
  } catch {
    await loaded?.close().catch(() => undefined);
    throw new Error('aws_deployment_load_failed');
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
