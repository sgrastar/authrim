import { expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { LambdaEvent } from 'hono/aws-lambda';
import {
  environmentGenerationDigest,
  type EnvironmentGenerationRecord,
} from '@authrim/ar-lib-core/services/deployment-replication/environment-authority';
import { createReplicatedAwsSamlLambdaHandler } from './replicated-lambda-handler';
import type { loadAwsSamlDeployment } from './aws-assets';
const ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:discovery-abcdef';
const VERSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const config = {
  formatVersion: 2,
  endpoint: 'https://authority.example.test/replication/v1/rpc',
  credentialId: 'aws-writer',
  pairId: 'pair-a',
  environmentId: 'logical-source',
  deploymentId: 'aws-a',
  writerSecret: 'a'.repeat(64),
  issuerOrigins: ['https://a.example.test', 'https://b.example.test'],
  region: 'ap-northeast-1',
  bucket: 'generation-test',
  bucketOwner: '123456789012',
};
async function fixture() {
  const children = ['tenant-a', 'tenant-b'].map((tenantId, i) => ({
    tenantId,
    restoreId: `00000000-0000-4000-8000-00000000000${i + 1}`,
    sourceEpoch: 1,
    sourceFenceRevision: 2,
    capturedAtMs: 100,
    verificationSha256: 'b'.repeat(64),
    location: {
      region: config.region,
      issuerOrigin: config.issuerOrigins[i],
      secretArn: `arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:child${i}-abcdef`,
      secretVersionId: VERSION,
      bucket: config.bucket,
      bucketOwner: config.bucketOwner,
      manifestKey: `children/${tenantId}.json`,
      manifestVersionId: 'pinned-version',
      manifestSha256: 'c'.repeat(64),
    },
  }));
  const body: Omit<EnvironmentGenerationRecord, 'digestSha256'> = {
    formatVersion: 1,
    pairId: config.pairId,
    environmentId: config.environmentId,
    sourceDeploymentId: 'cf-a',
    deploymentId: config.deploymentId,
    generationId: 'aggregate-1',
    epoch: 2,
    sourceEpoch: 1,
    sourceFenceRevision: 2,
    sourceOperationId: 'operation-a',
    sourcePlanSha256: 'd'.repeat(64),
    inventory: {
      formatVersion: 1,
      environmentId: config.environmentId,
      sourceDeploymentId: 'cf-a',
      sourceEpoch: 1,
      sourceFenceRevision: 2,
      capturedAtMs: 100,
      sourceReceiptSha256: 'e'.repeat(64),
      complete: true,
      tenants: children.map((c) => ({
        tenantId: c.tenantId,
        issuer: c.location.issuerOrigin,
        lifecycle: 'active',
      })),
    },
    children,
  };
  let current: EnvironmentGenerationRecord = {
    ...body,
    digestSha256: await environmentGenerationDigest(body),
  };
  const closes = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
  const readiness = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
  const load = vi.fn<typeof loadAwsSamlDeployment>(async ({ location }) => {
    const index = current.children.findIndex(
      (c) => c.location.manifestKey === location.manifestKey
    );
    const child = current.children[index];
    return {
      runtime: {
        tenantId: child.tenantId,
        origin: child.location.issuerOrigin,
        env: {
          AUTHRIM_ENVIRONMENT_NAME: 'physical-aws',
          AUTHRIM_REPLICATION_WRITER: JSON.stringify({
            version: 2,
            endpoint: config.endpoint,
            credentialId: config.credentialId,
            pairId: config.pairId,
            environmentId: config.environmentId,
            deploymentId: config.deploymentId,
            epoch: current.epoch,
            generationId: current.generationId,
            tenantId: child.tenantId,
            restoreId: child.restoreId,
          }),
          AUTHRIM_REPLICATION_WRITER_SECRET: config.writerSecret,
        } as Env,
        assertReady: readiness[index],
      },
      authState: { config: { backend: 'postgresql' } },
      close: closes[index],
    };
  });
  const reader = {
    getSecret: vi.fn(async () => ({ arn: ARN, versionId: VERSION, value: JSON.stringify(config) })),
    getObject: vi.fn(),
    close: vi.fn(),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('expected canonical body');
    const envelope = JSON.parse(init.body) as { action: string; payload: unknown };
    expect(envelope.action).toBe('environmentGetServingGeneration');
    expect(envelope.payload).toEqual({
      pairId: config.pairId,
      environmentId: config.environmentId,
      deploymentId: config.deploymentId,
    });
    return Response.json(current);
  });
  const createRuntime = vi.fn((input: { tenants: readonly { tenantId: string }[] }) => ({
    handler: vi.fn(async () => ({
      statusCode: 200,
      body: JSON.stringify(input.tenants.map((t) => t.tenantId)),
      headers: {},
      isBase64Encoded: false,
    })),
  }));
  const handler = createReplicatedAwsSamlLambdaHandler({
    environment: {
      AWS_REGION: config.region,
      AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_ARN: ARN,
      AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_VERSION_ID: VERSION,
    },
    reader,
    fetch,
    loadDeployment: load,
    createRuntime,
  });
  return {
    handler,
    load,
    fetch,
    reader,
    createRuntime,
    closes,
    readiness,
    current,
    setCurrent: (value: EnvironmentGenerationRecord) => {
      current = value;
    },
  };
}
it('loads all exact children before publishing one composite runtime and closes all on shutdown', async () => {
  const f = await fixture();
  const response = await f.handler.handler({} as LambdaEvent);
  expect(response.statusCode).toBe(200);
  expect(response.body).toBe('["tenant-a","tenant-b"]');
  expect(f.load).toHaveBeenCalledTimes(2);
  expect(f.readiness[0]).toHaveBeenCalledOnce();
  expect(f.readiness[1]).toHaveBeenCalledOnce();
  expect(f.createRuntime).toHaveBeenCalledOnce();
  await f.handler.close();
  for (const close of f.closes) expect(close).toHaveBeenCalledOnce();
});
it('never publishes a partial environment when a later child fails readiness', async () => {
  const f = await fixture();
  f.readiness[1].mockRejectedValue(new Error('not-ready'));
  expect((await f.handler.handler({} as LambdaEvent)).statusCode).toBe(503);
  expect(f.createRuntime).not.toHaveBeenCalled();
  await f.handler.close();
  for (const close of f.closes) expect(close).toHaveBeenCalledOnce();
});
it.each([
  'missing-child',
  'wrong-bucket',
  'wrong-digest',
  'new-issuer',
  'wrong-environment',
  'stale-epoch',
])('fails closed for %s without cached fallback', async (kind) => {
  const f = await fixture();
  expect((await f.handler.handler({} as LambdaEvent)).statusCode).toBe(200);
  const current = structuredClone(f.current);
  if (kind === 'missing-child') current.children.pop();
  if (kind === 'wrong-bucket') current.children[0].location.bucket = 'other-bucket';
  if (kind === 'wrong-digest') current.digestSha256 = 'f'.repeat(64);
  if (kind === 'new-issuer') {
    current.children[0].location.issuerOrigin = 'https://evil.example.test';
    current.inventory.tenants[0].issuer = 'https://evil.example.test';
  }
  if (kind === 'wrong-environment') current.environmentId = 'other';
  if (kind === 'stale-epoch') current.epoch = 1;
  if (kind !== 'wrong-digest') {
    const { digestSha256: _digest, ...body } = current;
    current.digestSha256 = await environmentGenerationDigest(body);
  }
  f.setCurrent(current);
  expect((await f.handler.handler({} as LambdaEvent)).statusCode).toBe(503);
  expect(f.createRuntime).toHaveBeenCalledOnce();
  await f.handler.close();
});
it('rejects an orphan restored child even with the correct aggregate generation ID', async () => {
  const f = await fixture();
  const original = f.load.getMockImplementation();
  if (!original) throw new Error();
  f.load.mockImplementation(async (input) => {
    const loaded = await original(input);
    const writer = JSON.parse(loaded.runtime.env.AUTHRIM_REPLICATION_WRITER ?? '{}') as Record<
      string,
      unknown
    >;
    loaded.runtime.env.AUTHRIM_REPLICATION_WRITER = JSON.stringify({
      ...writer,
      restoreId: 'orphan-restore',
    });
    return loaded;
  });
  expect((await f.handler.handler({} as LambdaEvent)).statusCode).toBe(503);
  expect(f.createRuntime).not.toHaveBeenCalled();
  await f.handler.close();
});
