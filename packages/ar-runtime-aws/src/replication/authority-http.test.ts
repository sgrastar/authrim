import { expect, it, vi } from 'vitest';
import type {
  DeploymentAuthority,
  DeploymentAuthorityState,
  DeploymentSwitchOperation,
} from '@authrim/ar-lib-core/services/deployment-replication/authority';
import {
  replicationCanonicalJson,
  signReplicationRpc,
} from '@authrim/ar-lib-core/services/deployment-replication/transport';
import { createReplicationAuthorityHttp } from './authority-http';

const NOW = 1_800_000_000_000;
const secret = 'a'.repeat(64);
const identity = { pairId: 'pair-a', tenantId: 'tenant-a' };
const permit = {
  ...identity,
  deploymentId: 'aws-a',
  epoch: 1,
  generationId: 'generation-a',
  permitId: 'permit-a',
  operationDigest: 'b'.repeat(64),
};
const state: DeploymentAuthorityState = {
  ...identity,
  ownerDeploymentId: 'aws-a',
  selectedGenerationId: 'generation-a',
  epoch: 1,
  revision: 1,
  phase: 'active',
  activeOperationId: null,
  drainedAtMs: null,
  outstandingPermits: 0,
};
function fixture() {
  const unavailableOperation = async (): Promise<DeploymentSwitchOperation> => {
    throw new Error('private database diagnostic');
  };
  const authority = {
    initialize: vi.fn(async () => state),
    get: vi.fn(async () => state),
    enter: vi.fn(async () => permit),
    complete: vi.fn(async () => undefined),
    beginDrain: vi.fn(unavailableOperation),
    beginFailoverDrain: vi.fn(unavailableOperation),
    registerStandbyGeneration: vi.fn(async () => undefined),
    verifyFailoverGeneration: vi.fn(unavailableOperation),
    getOperation: vi.fn(unavailableOperation),
    verifyGeneration: vi.fn(unavailableOperation),
    promote: vi.fn(unavailableOperation),
  } satisfies DeploymentAuthority;
  const catalog = {
    register: vi.fn(async () => undefined),
    get: vi.fn(async () => ({
      ...identity,
      deploymentId: 'aws-a',
      generationId: 'generation-a',
      epoch: 1,
      location: {
        region: 'ap-northeast-1',
        issuerOrigin: 'https://tenant-a.example.test',
        secretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:generation-abcdef',
        secretVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        bucket: 'authrim-generation-test',
        bucketOwner: '123456789012',
        manifestKey: 'generations/generation-a/manifest.json',
        manifestVersionId: 'immutable-version',
        manifestSha256: 'a'.repeat(64),
      },
    })),
  };
  const http = createReplicationAuthorityHttp({
    authority,
    catalog,
    now: () => NOW,
    credentials: [
      { credentialId: 'controller', ...identity, role: 'controller', secret },
      { credentialId: 'writer', ...identity, deploymentId: 'aws-a', role: 'writer', secret },
    ],
  });
  return { authority, catalog, http };
}
async function signed(
  action: string,
  payload: unknown,
  credentialId = 'writer',
  timestamp = NOW,
  rawTransform?: (raw: string) => string
) {
  let body = replicationCanonicalJson({
    version: 1,
    credentialId,
    timestamp,
    requestId: 'request-a',
    action,
    payload,
  });
  if (rawTransform) body = rawTransform(body);
  return new Request('https://authority.example.test/replication/v1/rpc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Authrim-Replication-Signature': await signReplicationRpc(body, secret),
    },
    body,
  });
}

it('accepts only a signed own-deployment writer permit and preserves its exact response', async () => {
  const f = fixture();
  const response = await f.http(await signed('enter', permit));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(permit);
  expect(f.authority.enter).toHaveBeenCalledExactlyOnceWith(permit);
  expect(response.headers.get('cache-control')).toBe('no-store');
});

it.each([
  'initialize',
  'get',
  'beginDrain',
  'beginFailoverDrain',
  'registerStandbyGeneration',
  'verifyFailoverGeneration',
  'getOperation',
  'verifyGeneration',
  'promote',
  'registerGeneration',
])('writer cannot call controller action %s', async (action) => {
  const f = fixture();
  const response = await f.http(await signed(action, permit));
  expect(response.status).toBe(409);
  for (const operation of Object.values(f.authority)) expect(operation).not.toHaveBeenCalled();
  expect(f.catalog.register).not.toHaveBeenCalled();
});

it.each(['enter', 'complete'])('controller cannot impersonate a writer for %s', async (action) => {
  const f = fixture();
  expect((await f.http(await signed(action, permit, 'controller'))).status).toBe(409);
  expect(f.authority.enter).not.toHaveBeenCalled();
  expect(f.authority.complete).not.toHaveBeenCalled();
});

it.each([
  { ...permit, tenantId: 'tenant-b' },
  { ...permit, pairId: 'pair-b' },
  { ...permit, deploymentId: 'cf-a' },
])('does not let payload identities override server credential scope', async (payload) => {
  const f = fixture();
  expect((await f.http(await signed('enter', payload))).status).toBe(409);
  expect(f.authority.enter).not.toHaveBeenCalled();
});

it.each([NOW - 60_001, NOW + 60_001])(
  'rejects a signed request outside clock skew',
  async (timestamp) => {
    const f = fixture();
    expect((await f.http(await signed('enter', permit, 'writer', timestamp))).status).toBe(409);
    expect(f.authority.enter).not.toHaveBeenCalled();
  }
);

it('rejects a noncanonical body even when its signature is correct', async () => {
  const f = fixture();
  expect(
    (await f.http(await signed('enter', permit, 'writer', NOW, (raw) => `${raw}\n`))).status
  ).toBe(409);
  expect(f.authority.enter).not.toHaveBeenCalled();
});

it('rejects invalid signatures, oversized bodies and unknown credentials without private diagnostics', async () => {
  const f = fixture();
  const request = await signed('enter', permit);
  request.headers.set('x-authrim-replication-signature', 'c'.repeat(64));
  const responses = [
    await f.http(request),
    await f.http(await signed('enter', permit, 'unknown')),
    await f.http(
      new Request('https://authority.example.test/replication/v1/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'x'.repeat(65_537),
      })
    ),
  ];
  for (const response of responses) {
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'replication_request_rejected' });
  }
  expect(f.authority.enter).not.toHaveBeenCalled();
});

it('uses scoped current ownership to resolve serving generation and denies standby or draining state', async () => {
  const f = fixture();
  const payload = { ...identity, deploymentId: 'aws-a' };
  expect((await f.http(await signed('getServingGeneration', payload))).status).toBe(200);
  expect(f.catalog.get).toHaveBeenCalledExactlyOnceWith({
    ...payload,
    epoch: 1,
    generationId: 'generation-a',
  });
  for (const override of [{ ownerDeploymentId: 'cf-a' }, { phase: 'draining' as const }]) {
    f.authority.get.mockResolvedValueOnce({ ...state, ...override });
    expect((await f.http(await signed('getServingGeneration', payload))).status).toBe(409);
  }
  expect(f.catalog.get).toHaveBeenCalledTimes(1);
});

it('keeps schema initialization outside HTTP handling and redacts backing failures', async () => {
  const f = fixture();
  const result = await f.http(
    await signed('beginDrain', { ...identity, operationId: 'switch-a' }, 'controller')
  );
  expect(result.status).toBe(409);
  expect(await result.text()).not.toContain('private database');
  expect(f.authority.initialize).not.toHaveBeenCalled();
});

const generation = {
  generationId: 'generation-b',
  sourceDeploymentId: 'cf-a',
  destinationDeploymentId: 'aws-a',
  sourceEpoch: 1,
  sourceFenceRevision: 1,
  capturedAtMs: NOW - 1000,
  manifestSha256: 'c'.repeat(64),
  verificationSha256: 'd'.repeat(64),
};
const acceptedDataLoss = {
  sourceSyncOperationId: 'sync-a',
  sourceSyncPlanSha256: 'e'.repeat(64),
  maximumSnapshotAgeMs: 60_000,
  acceptedAtMs: NOW,
};
const failover: DeploymentSwitchOperation = {
  ...identity,
  operationId: 'failover-a',
  sourceDeploymentId: 'cf-a',
  destinationDeploymentId: 'aws-a',
  expectedEpoch: 1,
  expectedRevision: 1,
  kind: 'failover',
  acceptedDataLoss,
  state: 'verified',
  drainRevision: 2,
  drainedAtMs: NOW,
  generation,
  promotedEpoch: null,
};

it('forwards controller failover evidence exactly without promoting or contacting the source', async () => {
  const f = fixture();
  f.authority.verifyFailoverGeneration.mockResolvedValueOnce(failover);
  const proof = { generation, acceptedDataLoss };
  const operation = { ...identity, operationId: failover.operationId };
  const response = await f.http(
    await signed('verifyFailoverGeneration', { ...operation, proof }, 'controller')
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(failover);
  expect(f.authority.verifyFailoverGeneration).toHaveBeenCalledExactlyOnceWith(operation, proof);
  expect(f.authority.promote).not.toHaveBeenCalled();
  expect(f.authority.beginDrain).not.toHaveBeenCalled();
});

it('registers a controller-approved standby receipt without admitting any writer', async () => {
  const f = fixture();
  const standby = {
    ...identity,
    sourceSyncOperationId: acceptedDataLoss.sourceSyncOperationId,
    sourceSyncPlanSha256: acceptedDataLoss.sourceSyncPlanSha256,
    generation,
  };
  const response = await f.http(await signed('registerStandbyGeneration', standby, 'controller'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ registered: true });
  expect(f.authority.registerStandbyGeneration).toHaveBeenCalledExactlyOnceWith(standby);
  expect(f.authority.enter).not.toHaveBeenCalled();
  expect(f.authority.promote).not.toHaveBeenCalled();
});

it.each([
  { ...identity, operationId: 'failover-a', proof: { generation, acceptedDataLoss }, force: true },
  {
    ...identity,
    tenantId: 'tenant-b',
    operationId: 'failover-a',
    proof: { generation, acceptedDataLoss },
  },
  {
    ...identity,
    pairId: 'pair-b',
    operationId: 'failover-a',
    proof: { generation, acceptedDataLoss },
  },
])(
  'rejects failover scope overrides or a force field before invoking the authority',
  async (payload) => {
    const f = fixture();
    expect(
      (await f.http(await signed('verifyFailoverGeneration', payload, 'controller'))).status
    ).toBe(409);
    expect(f.authority.verifyFailoverGeneration).not.toHaveBeenCalled();
  }
);
