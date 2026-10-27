import { expect, it, vi } from 'vitest';
import { Pool, type PoolConfig } from 'pg';
import { createReplicationAuthorityRuntime } from './authority-lambda';

const ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:authority-abcdef';
const VERSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const environment = {
  AWS_REGION: 'ap-northeast-1',
  AUTHRIM_REPLICATION_AUTHORITY_ACCOUNT_ID: '123456789012',
  AUTHRIM_REPLICATION_AUTHORITY_SECRET_ARN: ARN,
  AUTHRIM_REPLICATION_AUTHORITY_SECRET_VERSION_ID: VERSION,
};
const configuration = {
  formatVersion: 1,
  databaseUrl: 'postgres://user:synthetic-password@db.example.test/authority?sslmode=verify-full',
  credentials: [
    {
      credentialId: 'controller-a',
      pairId: 'pair-a',
      tenantId: 'tenant-a',
      role: 'controller',
      secret: 'a'.repeat(64),
    },
  ],
};
const request = () =>
  new Request('https://authority.example.test/replication/v1/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

function fixture(secret: unknown = configuration) {
  const pool = new Pool({ connectionString: configuration.databaseUrl });
  const connect = vi.spyOn(pool, 'connect');
  const end = vi.spyOn(pool, 'end');
  const on = vi.spyOn(pool, 'on');
  const createPool = vi.fn((_options: PoolConfig) => pool);
  const readSecret = vi.fn(async () => ({
    arn: ARN,
    versionId: VERSION,
    value: JSON.stringify(secret),
  }));
  return { createPool, readSecret, connect, end, on };
}

it('loads the exact secret version once, uses bounded TLS PG, and never initializes a schema', async () => {
  const f = fixture();
  const runtime = createReplicationAuthorityRuntime({ environment, ...f });
  const responses = await Promise.all([runtime.fetch(request()), runtime.fetch(request())]);
  expect(responses.map((response) => response.status)).toEqual([409, 409]);
  expect(f.readSecret).toHaveBeenCalledTimes(1);
  const [pin, signal] = f.readSecret.mock.calls[0] as unknown as [unknown, AbortSignal];
  expect(pin).toEqual({ region: 'ap-northeast-1', arn: ARN, versionId: VERSION });
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(f.createPool).toHaveBeenCalledExactlyOnceWith({
    connectionString: configuration.databaseUrl,
    max: 4,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 10_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: true,
  });
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.on.mock.calls[0]?.[0]).toBe('error');
  await runtime.close();
  expect(f.end).toHaveBeenCalledTimes(1);
});

it('does not load credentials for unrelated routes or GET requests', async () => {
  const f = fixture();
  const runtime = createReplicationAuthorityRuntime({ environment, ...f });
  for (const input of [
    new Request('https://authority.example.test/replication/v1/rpc'),
    new Request('https://authority.example.test/other', { method: 'POST' }),
    new Request('https://authority.example.test/replication/v1/rpc?leak=1', { method: 'POST' }),
  ])
    expect((await runtime.fetch(input)).status).toBe(404);
  expect(f.readSecret).not.toHaveBeenCalled();
});

it.each([
  { AUTHRIM_REPLICATION_AUTHORITY_SECRET_VERSION_ID: 'AWSCURRENT' },
  { AUTHRIM_REPLICATION_AUTHORITY_ACCOUNT_ID: '222222222222' },
  { AWS_REGION: 'us-east-1' },
])('rejects unpinned or conflicting deployment secret locations before IO', async (override) => {
  const f = fixture();
  const runtime = createReplicationAuthorityRuntime({
    environment: { ...environment, ...override },
    ...f,
  });
  expect((await runtime.fetch(request())).status).toBe(503);
  expect(f.readSecret).not.toHaveBeenCalled();
});

it.each([
  { arn: `${ARN}-other`, versionId: VERSION },
  { arn: ARN, versionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
])('rejects a secret response from a different ARN or version', async (pin) => {
  const f = fixture();
  f.readSecret.mockResolvedValue({ ...pin, value: JSON.stringify(configuration) });
  const runtime = createReplicationAuthorityRuntime({ environment, ...f });
  expect((await runtime.fetch(request())).status).toBe(503);
  expect(f.createPool).not.toHaveBeenCalled();
});

it.each([
  { ...configuration, databaseUrl: configuration.databaseUrl.replace('verify-full', 'disable') },
  { ...configuration, credentials: [] },
  { ...configuration, credentials: [{ ...configuration.credentials[0], secret: 'short' }] },
  { ...configuration, credentials: [{ ...configuration.credentials[0], role: 'admin' }] },
  { ...configuration, credentials: [{ ...configuration.credentials[0], deploymentId: 'aws-a' }] },
  { ...configuration, credentials: [{ ...configuration.credentials[0], role: 'writer' }] },
  { ...configuration, credentials: [...configuration.credentials, ...configuration.credentials] },
  { ...configuration, unexpected: true },
])(
  'rejects invalid TLS or scoped credential configuration without querying the DB',
  async (secret) => {
    const f = fixture(secret);
    const runtime = createReplicationAuthorityRuntime({ environment, ...f });
    const result = await runtime.fetch(request());
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: 'replication_authority_unavailable' });
    expect(f.connect).not.toHaveBeenCalled();
    if (f.createPool.mock.calls.length) expect(f.end).toHaveBeenCalledTimes(1);
  }
);

it('redacts a startup failure and permits only a new bounded read on the next request', async () => {
  const f = fixture();
  f.readSecret.mockRejectedValueOnce(new Error('private database and credentials'));
  const runtime = createReplicationAuthorityRuntime({ environment, ...f });
  const result = await runtime.fetch(request());
  expect(result.status).toBe(503);
  expect(await result.text()).not.toContain('private database');
  expect((await runtime.fetch(request())).status).toBe(409);
  expect(f.readSecret).toHaveBeenCalledTimes(2);
  await runtime.close();
});

it('loads explicit environment-scoped service credentials without using a tenant identity', async () => {
  const { tenantId: _tenant, ...controller } = configuration.credentials[0];
  const secret = {
    ...configuration,
    credentials: [
      { ...controller, environmentId: 'environment-a' },
      {
        ...controller,
        credentialId: 'env-writer',
        environmentId: 'environment-a',
        role: 'writer',
        deploymentId: 'aws-a',
      },
    ],
  };
  const f = fixture(secret);
  const runtime = createReplicationAuthorityRuntime({ environment, ...f });
  expect((await runtime.fetch(request())).status).toBe(409);
  expect(f.createPool).toHaveBeenCalledOnce();
  expect(f.connect).not.toHaveBeenCalled();
  await runtime.close();
});
it.each([{ environmentId: 'environment-a' }, { tenantId: undefined }])(
  'rejects ambiguous or missing authority credential scope %#',
  async (override) => {
    const f = fixture({
      ...configuration,
      credentials: [{ ...configuration.credentials[0], ...override }],
    });
    const runtime = createReplicationAuthorityRuntime({ environment, ...f });
    expect((await runtime.fetch(request())).status).toBe(503);
    expect(f.connect).not.toHaveBeenCalled();
    await runtime.close();
  }
);
