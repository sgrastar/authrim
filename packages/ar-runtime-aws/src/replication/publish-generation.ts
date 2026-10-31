import { createHash } from 'node:crypto';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import {
  S3Client,
  GetBucketVersioningCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  type CreateSecretCommandOutput,
} from '@aws-sdk/client-secrets-manager';
import { canonicalRestoreJson, readPinnedRestoreFile } from '../import/restore-evidence';
import {
  parseAwsSamlDeploymentManifest,
  parseAwsSamlDeploymentSecrets,
  type AwsSamlDeploymentManifest,
  type AwsSamlDeploymentSecrets,
  type AwsS3ObjectPin,
} from '../startup/deployment-config';
import type { ReplicationConfiguration } from './plan';
import {
  assertReplicationGenerationLocation,
  type ReplicationGenerationLocation,
} from './generation-catalog';

export interface PublishReplicationGenerationInput {
  configuration: ReplicationConfiguration;
  generationId: string;
  epoch: number;
  manifest: Omit<AwsSamlDeploymentManifest, 'backup' | 'supplement'> & {
    backup: Omit<AwsSamlDeploymentManifest['backup'], 'parts'>;
  };
  secrets: AwsSamlDeploymentSecrets;
  parts: readonly { path: string; sha256: string; size: number }[];
  supplement: { path: string; sha256: string; size: number };
}

/** Immutable object and secret versions; publication does not grant the generation writer rights. */
export async function publishReplicationGeneration(
  input: PublishReplicationGenerationInput
): Promise<ReplicationGenerationLocation> {
  const artifacts = input.configuration.destination.artifacts;
  const sdkConfig = {
    region: artifacts.region,
    maxAttempts: 1,
    ignoreConfiguredEndpointUrls: true,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 60_000 },
  };
  let s3: S3Client | undefined;
  let secrets: SecretsManagerClient | undefined;
  let sts: STSClient | undefined;
  const signal = AbortSignal.timeout(300_000);
  try {
    if (
      input.parts.length !== input.manifest.backup.receipt.parts.length ||
      input.generationId !== input.manifest.evidence.restoreId ||
      !input.manifest.replicationWriter ||
      (input.manifest.replicationWriter.version === 1
        ? input.manifest.replicationWriter.generationId !== input.generationId
        : input.manifest.replicationWriter.restoreId !== input.generationId) ||
      input.manifest.replicationWriter.epoch !== input.epoch
    )
      throw new Error();
    // Resolve once: the identity check and all writes use the same credentials, even if the
    // ambient profile changes or its default provider would otherwise refresh during publication.
    const credentials = await fromNodeProviderChain({ clientConfig: sdkConfig })();
    const checkedConfig = { ...sdkConfig, credentials: { ...credentials } };
    sts = new STSClient(checkedConfig);
    const caller = await sts.send(new GetCallerIdentityCommand({}), { abortSignal: signal });
    if (caller.Account !== artifacts.bucketOwner || !/^\d{12}$/u.test(caller.Account))
      throw new Error();
    const s3Client = new S3Client(checkedConfig);
    s3 = s3Client;
    secrets = new SecretsManagerClient(checkedConfig);
    const versioning = await s3Client.send(
      new GetBucketVersioningCommand({
        Bucket: artifacts.bucket,
        ExpectedBucketOwner: artifacts.bucketOwner,
      }),
      { abortSignal: signal }
    );
    if (versioning.Status !== 'Enabled') throw new Error();
    const put = async (bytes: Uint8Array, label: string): Promise<AwsS3ObjectPin> => {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const key = `${artifacts.keyPrefix}/${input.generationId}/${label}-${sha256}`;
      let versionId: string | undefined;
      try {
        const created = await s3Client.send(
          new PutObjectCommand({
            Bucket: artifacts.bucket,
            ExpectedBucketOwner: artifacts.bucketOwner,
            Key: key,
            Body: bytes,
            ContentLength: bytes.byteLength,
            IfNoneMatch: '*',
            ServerSideEncryption: 'aws:kms',
            SSEKMSKeyId: artifacts.kmsKeyArn,
            ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
            ContentType: label.includes('json') ? 'application/json' : 'application/octet-stream',
          }),
          { abortSignal: signal }
        );
        versionId = created.VersionId;
      } catch {
        // Only exact existing content is a successful reconciliation; never overwrite a key.
        const existing = await s3Client.send(
          new GetObjectCommand({
            Bucket: artifacts.bucket,
            ExpectedBucketOwner: artifacts.bucketOwner,
            Key: key,
          }),
          { abortSignal: signal }
        );
        try {
          if (
            existing.ContentLength !== bytes.byteLength ||
            !existing.Body ||
            existing.ServerSideEncryption !== 'aws:kms' ||
            existing.SSEKMSKeyId !== artifacts.kmsKeyArn
          )
            throw new Error();
          const observed = await existing.Body.transformToByteArray();
          if (createHash('sha256').update(observed).digest('hex') !== sha256) throw new Error();
          versionId = existing.VersionId;
        } finally {
          if (
            existing.Body &&
            'destroy' in existing.Body &&
            typeof existing.Body.destroy === 'function'
          )
            existing.Body.destroy();
        }
      }
      if (!versionId || versionId === 'null') throw new Error();
      return { key, versionId, size: bytes.byteLength, sha256 };
    };
    const pins: AwsS3ObjectPin[] = [];
    for (let index = 0; index < input.parts.length; index++) {
      const part = input.parts[index];
      const expected = input.manifest.backup.receipt.parts[index];
      if (part.sha256 !== expected.sha256 || part.size !== expected.size) throw new Error();
      const bytes = await readPinnedRestoreFile(part.path, part.sha256, part.size);
      if (bytes.byteLength !== part.size) throw new Error();
      pins.push(await put(bytes, `part-${index}.authrim2`));
    }
    const supplementBytes = await readPinnedRestoreFile(
      input.supplement.path,
      input.supplement.sha256,
      input.supplement.size
    );
    if (supplementBytes.byteLength !== input.supplement.size) throw new Error();
    const supplement = await put(supplementBytes, 'supplement.json');
    const manifest: AwsSamlDeploymentManifest = {
      ...input.manifest,
      backup: { ...input.manifest.backup, parts: pins },
      supplement,
    };
    const manifestRaw = canonicalRestoreJson(manifest);
    parseAwsSamlDeploymentManifest(manifestRaw);
    const secretRaw = canonicalRestoreJson(input.secrets);
    parseAwsSamlDeploymentSecrets(secretRaw, input.configuration.pair.tenantId);
    const name = `${artifacts.secretNamePrefix}/${input.generationId}`;
    const secretArnPrefix = `arn:aws:secretsmanager:${artifacts.region}:${artifacts.bucketOwner}:secret:${name}-`;
    const isExpectedSecretArn = (arn: unknown): arn is string =>
      typeof arn === 'string' &&
      arn.startsWith(secretArnPrefix) &&
      /^[A-Za-z0-9]{6}$/u.test(arn.slice(secretArnPrefix.length));
    let secretArn: string | undefined;
    let created: CreateSecretCommandOutput | undefined;
    try {
      created = await secrets.send(
        new CreateSecretCommand({
          Name: name,
          ClientRequestToken: input.generationId,
          SecretString: secretRaw,
          KmsKeyId: artifacts.kmsKeyArn,
          Tags: [
            { Key: 'authrim:replication-pair', Value: input.configuration.pair.pairId },
            { Key: 'authrim:generation', Value: input.generationId },
          ],
        }),
        { abortSignal: signal }
      );
    } catch {
      const metadata = await secrets.send(new DescribeSecretCommand({ SecretId: name }), {
        abortSignal: signal,
      });
      // DescribeSecret may report the supplied full key ARN or its key ID. Aliases cannot prove
      // the immutable expected key without another lookup and are deliberately not adopted.
      if (
        !isExpectedSecretArn(metadata.ARN) ||
        metadata.Name !== name ||
        metadata.DeletedDate !== undefined ||
        (metadata.KmsKeyId !== artifacts.kmsKeyArn &&
          metadata.KmsKeyId !== artifacts.kmsKeyArn.split('/').at(-1))
      )
        throw new Error();
      const observed = await secrets.send(
        new GetSecretValueCommand({ SecretId: metadata.ARN, VersionId: input.generationId }),
        { abortSignal: signal }
      );
      if (
        observed.ARN !== metadata.ARN ||
        observed.SecretString !== secretRaw ||
        observed.VersionId !== input.generationId
      )
        throw new Error();
      secretArn = observed.ARN;
    }
    if (created) {
      if (
        !isExpectedSecretArn(created.ARN) ||
        created.Name !== name ||
        created.VersionId !== input.generationId
      )
        throw new Error();
      secretArn = created.ARN;
    }
    if (!secretArn) throw new Error();
    const manifestPin = await put(new TextEncoder().encode(manifestRaw), 'manifest.json');
    const value: ReplicationGenerationLocation = {
      pairId: input.configuration.pair.pairId,
      tenantId: input.configuration.pair.tenantId,
      deploymentId: input.configuration.destinationDeploymentId,
      generationId: input.generationId,
      epoch: input.epoch,
      location: {
        region: artifacts.region,
        issuerOrigin: input.configuration.source.identity.issuer,
        bucket: artifacts.bucket,
        bucketOwner: artifacts.bucketOwner,
        secretArn,
        secretVersionId: input.generationId,
        manifestKey: manifestPin.key,
        manifestVersionId: manifestPin.versionId,
        manifestSha256: manifestPin.sha256,
      },
    };
    assertReplicationGenerationLocation(value);
    return value;
  } catch {
    throw new Error('replication_generation_publication_failed');
  } finally {
    sts?.destroy();
    s3?.destroy();
    secrets?.destroy();
  }
}
