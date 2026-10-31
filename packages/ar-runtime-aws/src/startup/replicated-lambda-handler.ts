import {
  assertEnvironmentGenerationRecord,
  verifyEnvironmentGenerationDigest,
  type EnvironmentGenerationRecord,
} from '@authrim/ar-lib-core/services/deployment-replication/environment-authority';
import { MAX_REPLICATION_ENVIRONMENT_TENANTS } from '@authrim/ar-lib-core/services/deployment-replication/environment-inventory';
import {
  parseAwsSamlDeploymentLocation,
  type AwsSamlDeploymentLocation,
} from './deployment-config';
import type { LambdaContext, LambdaEvent } from 'hono/aws-lambda';
import {
  assertReplicationIdentifier,
  assertReplicationSecret,
  createReplicationRpcClient,
  replicationCanonicalJson,
  replicationEndpoint,
} from '@authrim/ar-lib-core/services/deployment-replication/transport';
import { parseReplicationWriterConfiguration } from '@authrim/ar-lib-core/services/deployment-replication/writer';
import {
  assertReplicationGenerationLocation,
  type ReplicationGenerationLocation,
} from '../replication/generation-catalog';
import { createAwsSamlRuntime } from '../http-runtime';
import { loadAwsSamlDeployment, type AwsAssetReader } from './aws-assets';

interface DiscoveryCommon {
  endpoint: string;
  credentialId: string;
  pairId: string;
  deploymentId: string;
  writerSecret: string;
  region: string;
  bucket: string;
  bucketOwner: string;
}

type DiscoveryConfiguration = DiscoveryCommon &
  (
    | { formatVersion: 1; tenantId: string; issuerOrigin: string }
    | { formatVersion: 2; environmentId: string; issuerOrigins: string[] }
  );
type SelectedGeneration = {
  epoch: number;
  generationId: string;
  key: string;
  children: Array<{ tenantId: string; restoreId: string; location: AwsSamlDeploymentLocation }>;
};

interface ReplicatedHandlerInput {
  environment: Readonly<Record<string, string | undefined>>;
  reader: AwsAssetReader;
  loadDeployment?: typeof loadAwsSamlDeployment;
  /** Test transport; production uses the shared signed HTTPS client. */
  fetch?: typeof fetch;
  createRuntime?: (
    input: Parameters<typeof createAwsSamlRuntime>[0]
  ) => Pick<ReturnType<typeof createAwsSamlRuntime>, 'handler'>;
}

type ReadyGeneration = {
  loaded: { close(): Promise<void> };
  handler: ReturnType<typeof createAwsSamlRuntime>['handler'];
};
interface CacheEntry {
  ready: Promise<ReadyGeneration>;
  references: number;
  retired: boolean;
  closing: boolean;
  closed: Promise<void>;
  finishClose(): void;
}

function unavailable() {
  return {
    statusCode: 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ error: 'temporarily_unavailable' }),
    isBase64Encoded: false,
  };
}

export function hasReplicationDiscoveryConfiguration(
  environment: ReplicatedHandlerInput['environment']
): boolean {
  return (
    environment.AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_ARN !== undefined ||
    environment.AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_VERSION_ID !== undefined
  );
}

async function readDiscovery(input: ReplicatedHandlerInput): Promise<DiscoveryConfiguration> {
  const arn = input.environment.AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_ARN;
  const versionId = input.environment.AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_VERSION_ID;
  const parsed =
    typeof arn === 'string'
      ? /^arn:(aws|aws-us-gov|aws-cn):secretsmanager:([a-z0-9-]+):(\d{12}):secret:([A-Za-z0-9/_+=.@-]+)$/u.exec(
          arn
        )
      : null;
  if (
    !parsed ||
    parsed[2] !== input.environment.AWS_REGION ||
    typeof versionId !== 'string' ||
    !/^[A-Za-z0-9-]{32,64}$/u.test(versionId)
  )
    throw new Error();
  const secret = await input.reader.getSecret({
    arn: parsed[0],
    versionId,
    signal: AbortSignal.timeout(15_000),
  });
  if (
    secret.arn !== parsed[0] ||
    secret.versionId !== versionId ||
    typeof secret.value !== 'string' ||
    new TextEncoder().encode(secret.value).byteLength > 65_536
  )
    throw new Error();
  const value = JSON.parse(secret.value) as DiscoveryConfiguration;
  if (
    !value ||
    Object.keys(value).sort().join(',') !==
      (value.formatVersion === 2
        ? 'bucket,bucketOwner,credentialId,deploymentId,endpoint,environmentId,formatVersion,issuerOrigins,pairId,region,writerSecret'
        : 'bucket,bucketOwner,credentialId,deploymentId,endpoint,formatVersion,issuerOrigin,pairId,region,tenantId,writerSecret') ||
    ![1, 2].includes(value.formatVersion) ||
    value.region !== parsed[2] ||
    value.bucketOwner !== parsed[3] ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(value.bucket) ||
    /\.\.|\.-|-\./u.test(value.bucket) ||
    /^\d+\.\d+\.\d+\.\d+$/u.test(value.bucket)
  )
    throw new Error();
  for (const id of [
    value.credentialId,
    value.pairId,
    value.deploymentId,
    value.formatVersion === 1 ? value.tenantId : value.environmentId,
  ])
    assertReplicationIdentifier(id);
  assertReplicationSecret(value.writerSecret);
  replicationEndpoint(value.endpoint);
  const origins = value.formatVersion === 1 ? [value.issuerOrigin] : value.issuerOrigins;
  if (
    !Array.isArray(origins) ||
    origins.length < 1 ||
    origins.length > MAX_REPLICATION_ENVIRONMENT_TENANTS ||
    new Set(origins).size !== origins.length
  )
    throw new Error();
  for (const origin of origins) {
    const issuer = new URL(origin);
    if (
      issuer.protocol !== 'https:' ||
      issuer.origin !== origin ||
      issuer.username ||
      issuer.password
    )
      throw new Error();
  }
  return value;
}

/** Every request resolves current authority; an unavailable or standby result never serves cached data. */
export function createReplicatedAwsSamlLambdaHandler(input: ReplicatedHandlerInput) {
  const environment = { ...input.environment };
  let discovery: Promise<DiscoveryConfiguration> | undefined;
  let closed = false;
  let highestEpoch = 0;
  let selectionKey: string | undefined;
  const entries = new Map<string, CacheEntry>();

  const release = (key: string, entry: CacheEntry) => {
    if (!entry.retired || entry.references !== 0 || entry.closing) return;
    entry.closing = true;
    void entry.ready
      .then(async (ready) => {
        await ready.loaded.close();
      })
      .catch(() => undefined)
      .finally(() => {
        if (entries.get(key) === entry) entries.delete(key);
        entry.finishClose();
      });
  };

  const initialize = async (
    selected: SelectedGeneration,
    config: DiscoveryConfiguration
  ): Promise<ReadyGeneration> => {
    const children: Awaited<ReturnType<typeof loadAwsSamlDeployment>>[] = [];
    try {
      // Sequential and bounded: each tenant has its own credentials, three SQL pools and state namespace.
      for (const child of selected.children) {
        const loaded = await (input.loadDeployment ?? loadAwsSamlDeployment)({
          location: child.location,
          reader: input.reader,
        });
        children.push(loaded);
        const writer = parseReplicationWriterConfiguration(
          loaded.runtime.env.AUTHRIM_REPLICATION_WRITER ?? ''
        );
        const expected = {
          version: config.formatVersion,
          endpoint: config.endpoint,
          credentialId: config.credentialId,
          pairId: config.pairId,
          ...(config.formatVersion === 1
            ? { tenantId: config.tenantId }
            : {
                environmentId: config.environmentId,
                tenantId: child.tenantId,
                restoreId: child.restoreId,
              }),
          deploymentId: config.deploymentId,
          generationId: selected.generationId,
          epoch: selected.epoch,
        };
        if (
          loaded.runtime.tenantId !== child.tenantId ||
          loaded.runtime.origin !== child.location.issuerOrigin ||
          replicationCanonicalJson(writer) !== replicationCanonicalJson(expected) ||
          loaded.runtime.env.AUTHRIM_REPLICATION_WRITER_SECRET !== config.writerSecret
        )
          throw new Error();
        await loaded.runtime.assertReady();
      }
      const runtime = (input.createRuntime ?? createAwsSamlRuntime)({
        tenants: children.map((child) => child.runtime),
      });
      return {
        loaded: {
          async close() {
            await Promise.all(children.map((child) => child.close()));
          },
        },
        handler: runtime.handler,
      };
    } catch {
      await Promise.allSettled(children.map((child) => child.close()));
      throw new Error('aws_replication_generation_load_failed');
    }
  };

  const handler = async (event: LambdaEvent, context?: LambdaContext) => {
    if (closed) return unavailable();
    let entry: CacheEntry | undefined;
    let key = '';
    try {
      discovery ??= readDiscovery({ ...input, environment }).catch((error: unknown) => {
        discovery = undefined;
        throw error;
      });
      const config = await discovery;
      if (closed) return unavailable();
      const rpc = createReplicationRpcClient({
        endpoint: config.endpoint,
        credentialId: config.credentialId,
        secret: config.writerSecret,
        fetch: input.fetch,
      });
      let selected: SelectedGeneration;
      if (config.formatVersion === 1) {
        const value = (await rpc('getServingGeneration', {
          pairId: config.pairId,
          tenantId: config.tenantId,
          deploymentId: config.deploymentId,
        })) as ReplicationGenerationLocation;
        assertReplicationGenerationLocation(value);
        if (
          value.pairId !== config.pairId ||
          value.tenantId !== config.tenantId ||
          value.deploymentId !== config.deploymentId ||
          value.location.issuerOrigin !== config.issuerOrigin
        )
          throw new Error();
        selected = {
          epoch: value.epoch,
          generationId: value.generationId,
          key: replicationCanonicalJson(value),
          children: [
            { tenantId: value.tenantId, restoreId: value.generationId, location: value.location },
          ],
        };
      } else {
        const value = (await rpc('environmentGetServingGeneration', {
          pairId: config.pairId,
          environmentId: config.environmentId,
          deploymentId: config.deploymentId,
        })) as EnvironmentGenerationRecord;
        assertEnvironmentGenerationRecord(value);
        await verifyEnvironmentGenerationDigest(value);
        if (
          value.pairId !== config.pairId ||
          value.environmentId !== config.environmentId ||
          value.deploymentId !== config.deploymentId ||
          value.children.length > MAX_REPLICATION_ENVIRONMENT_TENANTS ||
          replicationCanonicalJson(value.inventory.tenants.map((row) => row.issuer).sort()) !==
            replicationCanonicalJson([...config.issuerOrigins].sort())
        )
          throw new Error();
        selected = {
          epoch: value.epoch,
          generationId: value.generationId,
          key: replicationCanonicalJson(value),
          children: value.children.map((child) => ({
            tenantId: child.tenantId,
            restoreId: child.restoreId,
            location: child.location,
          })),
        };
      }
      for (const child of selected.children) {
        const location = child.location;
        const normalized = parseAwsSamlDeploymentLocation({
          AWS_REGION: location.region,
          AUTHRIM_AWS_ISSUER_ORIGIN: location.issuerOrigin,
          AUTHRIM_AWS_RUNTIME_SECRET_ARN: location.secretArn,
          AUTHRIM_AWS_RUNTIME_SECRET_VERSION_ID: location.secretVersionId,
          AUTHRIM_AWS_MANIFEST_BUCKET: location.bucket,
          AUTHRIM_AWS_BUCKET_OWNER: location.bucketOwner,
          AUTHRIM_AWS_MANIFEST_KEY: location.manifestKey,
          AUTHRIM_AWS_MANIFEST_VERSION_ID: location.manifestVersionId,
          AUTHRIM_AWS_MANIFEST_SHA256: location.manifestSha256,
        });
        if (
          replicationCanonicalJson(normalized) !== replicationCanonicalJson(location) ||
          location.region !== config.region ||
          location.bucket !== config.bucket ||
          location.bucketOwner !== config.bucketOwner
        )
          throw new Error();
      }
      if (selected.epoch < highestEpoch || closed) throw new Error();
      key = selected.key;
      if (selected.epoch === highestEpoch && selectionKey !== key) throw new Error();
      if (selected.epoch > highestEpoch) {
        highestEpoch = selected.epoch;
        selectionKey = key;
        for (const [previousKey, previous] of entries) {
          if (previousKey !== key) {
            previous.retired = true;
            release(previousKey, previous);
          }
        }
      }
      entry = entries.get(key);
      if (!entry) {
        let finishClose = () => undefined as void;
        const completed = new Promise<void>((resolveClosed) => {
          finishClose = resolveClosed;
        });
        entry = {
          ready: initialize(selected, config),
          references: 0,
          retired: false,
          closing: false,
          closed: completed,
          finishClose,
        };
        entries.set(key, entry);
      }
      entry.references++;
      let ready: ReadyGeneration;
      try {
        ready = await entry.ready;
      } catch {
        entry.retired = true;
        throw new Error();
      }
      if (closed || entry.retired || key !== selectionKey) return unavailable();
      return await ready.handler(event, context);
    } catch {
      return unavailable();
    } finally {
      if (entry) {
        entry.references--;
        release(key, entry);
      }
    }
  };

  const close = async () => {
    closed = true;
    for (const [key, entry] of entries) {
      entry.retired = true;
      release(key, entry);
    }
    await Promise.all([...entries.values()].map((entry) => entry.closed));
  };
  return { handler, close };
}
