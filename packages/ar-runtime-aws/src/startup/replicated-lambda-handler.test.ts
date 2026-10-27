import { expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { LambdaEvent } from 'hono/aws-lambda';
import { verifyReplicationRpc } from '@authrim/ar-lib-core/services/deployment-replication/transport';
import type { ReplicationGenerationLocation } from '../replication/generation-catalog';
import type { loadAwsSamlDeployment } from './aws-assets';
import {
  createReplicatedAwsSamlLambdaHandler,
  hasReplicationDiscoveryConfiguration,
} from './replicated-lambda-handler';

const DISCOVERY_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:discovery-abcdef';
const VERSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const G1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const G2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const environment = {
  AWS_REGION: 'ap-northeast-1',
  AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_ARN: DISCOVERY_ARN,
  AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_VERSION_ID: VERSION,
};
const configuration = {
  formatVersion: 1,
  endpoint: 'https://authority.example.test/replication/v1/rpc',
  credentialId: 'aws-writer',
  pairId: 'pair-a',
  tenantId: 'tenant-a',
  deploymentId: 'aws-a',
  writerSecret: 'a'.repeat(64),
  issuerOrigin: 'https://tenant-a.example.test',
  region: 'ap-northeast-1',
  bucket: 'authrim-generation-test',
  bucketOwner: '123456789012',
};
const event = {} as LambdaEvent;
function selection(epoch = 1, generationId = G1): ReplicationGenerationLocation {
  return {
    pairId: 'pair-a',
    tenantId: 'tenant-a',
    deploymentId: 'aws-a',
    generationId,
    epoch,
    location: {
      region: configuration.region,
      issuerOrigin: configuration.issuerOrigin,
      secretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:generation-abcdef',
      secretVersionId: VERSION,
      bucket: configuration.bucket,
      bucketOwner: configuration.bucketOwner,
      manifestKey: `generations/${generationId}/manifest.json`,
      manifestVersionId: 'immutable-manifest-version',
      manifestSha256: 'a'.repeat(64),
    },
  };
}
function deferred() {
  let resolve = () => undefined as void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let current = selection();
  const closes = new Map<string, ReturnType<typeof vi.fn>>();
  const reader = {
    getSecret: vi.fn(async () => ({
      arn: DISCOVERY_ARN,
      versionId: VERSION,
      value: JSON.stringify(configuration),
    })),
    getObject: vi.fn(),
    close: vi.fn(),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('expected canonical body');
    const raw = init.body;
    const headers = new Headers(init?.headers);
    expect(init?.redirect).toBe('error');
    expect(
      await verifyReplicationRpc(
        raw,
        headers.get('x-authrim-replication-signature') ?? '',
        configuration.writerSecret
      )
    ).toBe(true);
    expect(JSON.parse(raw)).toMatchObject({
      action: 'getServingGeneration',
      credentialId: 'aws-writer',
      payload: { pairId: 'pair-a', tenantId: 'tenant-a', deploymentId: 'aws-a' },
    });
    return Response.json(current);
  });
  const loadDeployment = vi.fn<typeof loadAwsSamlDeployment>(async ({ location }) => {
    const selected = structuredClone(current);
    expect(location).toEqual(selected.location);
    const close = vi.fn(async () => undefined);
    closes.set(selected.generationId, close);
    return {
      runtime: {
        tenantId: selected.tenantId,
        origin: configuration.issuerOrigin,
        env: {
          AUTHRIM_REPLICATION_WRITER: JSON.stringify({
            version: 1,
            endpoint: configuration.endpoint,
            credentialId: configuration.credentialId,
            pairId: selected.pairId,
            tenantId: selected.tenantId,
            deploymentId: selected.deploymentId,
            epoch: selected.epoch,
            generationId: selected.generationId,
          }),
          AUTHRIM_REPLICATION_WRITER_SECRET: configuration.writerSecret,
        } as Env,
        assertReady: vi.fn(async () => undefined),
      },
      authState: { config: { backend: 'postgresql' } },
      close,
    };
  });
  const createRuntime = vi.fn(
    (
      input: Parameters<
        NonNullable<Parameters<typeof createReplicatedAwsSamlLambdaHandler>[0]['createRuntime']>
      >[0]
    ) => ({
      handler: vi.fn(async () => ({
        statusCode: 200,
        headers: {},
        body: input.tenants[0].env.AUTHRIM_REPLICATION_WRITER ?? '',
        isBase64Encoded: false,
      })),
    })
  );
  return {
    environment,
    reader,
    fetch,
    loadDeployment,
    createRuntime,
    closes,
    setCurrent: (value: ReplicationGenerationLocation) => {
      current = value;
    },
  };
}

it('is opt-in and treats even a partial discovery configuration as configured', () => {
  expect(hasReplicationDiscoveryConfiguration({})).toBe(false);
  expect(
    hasReplicationDiscoveryConfiguration({ AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_ARN: '' })
  ).toBe(true);
});

it('checks current authority on every request, reuses one generation, and reads only the pinned discovery secret', async () => {
  const f = fixture();
  const runtime = createReplicatedAwsSamlLambdaHandler(f);
  const results = await Promise.all([runtime.handler(event), runtime.handler(event)]);
  expect(results.map((value) => value.statusCode)).toEqual([200, 200]);
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.loadDeployment).toHaveBeenCalledTimes(1);
  expect(f.reader.getSecret).toHaveBeenCalledTimes(1);
  expect(f.reader.getSecret.mock.calls[0]).toHaveLength(1);
  await runtime.close();
  expect(f.closes.get(G1)).toHaveBeenCalledTimes(1);
});

it('returns 503 for standby/unreachable authority even with a warm successful runtime', async () => {
  const f = fixture();
  const runtime = createReplicatedAwsSamlLambdaHandler(f);
  expect((await runtime.handler(event)).statusCode).toBe(200);
  f.fetch.mockResolvedValueOnce(
    Response.json({ error: 'replication_request_rejected' }, { status: 409 })
  );
  expect((await runtime.handler(event)).statusCode).toBe(503);
  f.fetch.mockRejectedValueOnce(new Error('private server error'));
  expect((await runtime.handler(event)).statusCode).toBe(503);
  const created = f.createRuntime.mock.results[0];
  if (created.type !== 'return') throw new Error('expected initialized runtime');
  expect(created.value.handler).toHaveBeenCalledTimes(1);
  await runtime.close();
});

it.each(['tenant', 'deployment', 'bucket', 'owner', 'issuer', 'region'] as const)(
  'rejects a selected generation for another %s before loading it',
  async (field) => {
    const f = fixture();
    const selected = selection();
    if (field === 'tenant') selected.tenantId = 'tenant-b';
    if (field === 'deployment') selected.deploymentId = 'cf-a';
    if (field === 'bucket') selected.location.bucket = 'other-bucket';
    if (field === 'owner') selected.location.bucketOwner = '222222222222';
    if (field === 'issuer') selected.location.issuerOrigin = 'https://other.example.test';
    if (field === 'region') selected.location.region = 'us-east-1';
    f.setCurrent(selected);
    expect((await createReplicatedAwsSamlLambdaHandler(f).handler(event)).statusCode).toBe(503);
    expect(f.loadDeployment).not.toHaveBeenCalled();
  }
);

it('rejects wrong discovery version or partial settings before querying authority', async () => {
  const f = fixture();
  f.reader.getSecret.mockResolvedValueOnce({
    arn: DISCOVERY_ARN,
    versionId: G2,
    value: JSON.stringify(configuration),
  });
  expect((await createReplicatedAwsSamlLambdaHandler(f).handler(event)).statusCode).toBe(503);
  const partial = {
    ...f,
    environment: { ...environment, AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_VERSION_ID: undefined },
  };
  expect((await createReplicatedAwsSamlLambdaHandler(partial).handler(event)).statusCode).toBe(503);
  expect(f.fetch).not.toHaveBeenCalled();
});

it('rejects a manifest writer epoch or secret that differs from current authority', async () => {
  for (const changeSecret of [false, true]) {
    const f = fixture();
    const original = f.loadDeployment.getMockImplementation();
    if (!original) throw new Error('fixture');
    f.loadDeployment.mockImplementation(async (input) => {
      const loaded = await original(input);
      if (changeSecret) loaded.runtime.env.AUTHRIM_REPLICATION_WRITER_SECRET = 'b'.repeat(64);
      else
        loaded.runtime.env.AUTHRIM_REPLICATION_WRITER = JSON.stringify({
          ...(JSON.parse(loaded.runtime.env.AUTHRIM_REPLICATION_WRITER ?? '') as object),
          epoch: 2,
        });
      return loaded;
    });
    const runtime = createReplicatedAwsSamlLambdaHandler(f);
    expect((await runtime.handler(event)).statusCode).toBe(503);
    expect(f.createRuntime).not.toHaveBeenCalled();
    expect(f.closes.get(G1)).toHaveBeenCalledTimes(1);
    await runtime.close();
  }
});

it('switches to new immutable location and rejects a late old authority result without fallback', async () => {
  const f = fixture();
  const runtime = createReplicatedAwsSamlLambdaHandler(f);
  expect((await runtime.handler(event)).statusCode).toBe(200);
  f.setCurrent(selection(2, G2));
  const promoted = await runtime.handler(event);
  expect(promoted.statusCode).toBe(200);
  expect(JSON.parse(promoted.body)).toMatchObject({ generationId: G2, epoch: 2 });
  expect(f.closes.get(G1)).toHaveBeenCalledTimes(1);
  f.setCurrent(selection());
  expect((await runtime.handler(event)).statusCode).toBe(503);
  expect(f.loadDeployment).toHaveBeenCalledTimes(2);
  await runtime.close();
});

it('waits for existing in-flight requests before retiring their runtime or closing the cache', async () => {
  const f = fixture();
  const entered = deferred();
  const finish = deferred();
  f.createRuntime.mockImplementation((input) => ({
    handler: vi.fn(async () => {
      const writer = JSON.parse(input.tenants[0].env.AUTHRIM_REPLICATION_WRITER ?? '') as {
        generationId: string;
      };
      if (writer.generationId === G1) {
        entered.resolve();
        await finish.promise;
      }
      return { statusCode: 200, headers: {}, body: writer.generationId, isBase64Encoded: false };
    }),
  }));
  const runtime = createReplicatedAwsSamlLambdaHandler(f);
  const first = runtime.handler(event);
  await entered.promise;
  f.setCurrent(selection(2, G2));
  expect((await runtime.handler(event)).statusCode).toBe(200);
  expect(f.closes.get(G1)).not.toHaveBeenCalled();
  const closing = runtime.close();
  expect((await runtime.handler(event)).statusCode).toBe(503);
  expect(f.closes.get(G1)).not.toHaveBeenCalled();
  finish.resolve();
  expect((await first).statusCode).toBe(200);
  await closing;
  expect(f.closes.get(G1)).toHaveBeenCalledTimes(1);
  expect(f.closes.get(G2)).toHaveBeenCalledTimes(1);
});
