/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion -- mock call inspection */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolConfig } from 'pg';

const sm = vi.hoisted(() => ({
  ctor: vi.fn(),
  send: vi.fn(),
  destroy: vi.fn(),
  command: vi.fn(),
}));
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    constructor(o: unknown) {
      sm.ctor(o);
    }
    send(...a: unknown[]) {
      return sm.send(...a);
    }
    destroy() {
      sm.destroy();
    }
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {
      sm.command(input);
    }
  },
}));

import { createReplicationAuthorityRuntime } from './authority-lambda';

const ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:authority-abcdef';
const VERSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const env = {
  AWS_REGION: 'ap-northeast-1',
  AUTHRIM_REPLICATION_AUTHORITY_ACCOUNT_ID: '123456789012',
  AUTHRIM_REPLICATION_AUTHORITY_SECRET_ARN: ARN,
  AUTHRIM_REPLICATION_AUTHORITY_SECRET_VERSION_ID: VERSION,
};
const cred = {
  credentialId: 'controller-a',
  pairId: 'pair-a',
  tenantId: 'tenant-a',
  role: 'controller',
  secret: 'a'.repeat(64),
};
const config = {
  formatVersion: 1,
  databaseUrl: 'postgres://user:synthetic-password@db.example.test/authority?sslmode=verify-full',
  credentials: [cred],
};
const req = () =>
  new Request('https://authority.example.test/replication/v1/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

function pool() {
  return {
    connect: vi.fn(),
    query: vi.fn(),
    end: vi.fn(async () => undefined),
    on: vi.fn(),
  };
}
async function status(
  environment: Record<string, string | undefined>,
  secret: unknown = config,
  arn?: string,
  versionId?: string
) {
  const p = pool();
  const readSecret = vi.fn(async (_l?: unknown, _s?: unknown) => ({
    arn: arn ?? environment.AUTHRIM_REPLICATION_AUTHORITY_SECRET_ARN,
    versionId: versionId ?? environment.AUTHRIM_REPLICATION_AUTHORITY_SECRET_VERSION_ID,
    value: typeof secret === 'string' ? secret : JSON.stringify(secret),
  }));
  const createPool = vi.fn((_: PoolConfig) => p as any);
  const runtime = createReplicationAuthorityRuntime({ environment, readSecret, createPool });
  const r = await runtime.fetch(req());
  await runtime.close();
  return { status: r.status, readSecret, createPool, p };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('secret location validation', () => {
  it('accepts commercial, GovCloud and China partitions', async () => {
    const cases = [
      ['aws', 'ap-northeast-1'],
      ['aws-us-gov', 'us-gov-west-1'],
      ['aws-cn', 'cn-north-1'],
    ];
    for (const [partition, region] of cases) {
      const arn = `arn:${partition}:secretsmanager:${region}:123456789012:secret:authority-abcdef`;
      const r = await status({
        ...env,
        AWS_REGION: region,
        AUTHRIM_REPLICATION_AUTHORITY_SECRET_ARN: arn,
      });
      expect(r.status).toBe(409);
      expect(r.readSecret.mock.calls[0][0]).toEqual({ region, arn, versionId: VERSION });
    }
  });
  const rejected: Array<[string, Record<string, string | undefined>]> = [
    ['ARN prefix junk', { AUTHRIM_REPLICATION_AUTHORITY_SECRET_ARN: `x${ARN}` }],
    ['ARN suffix junk', { AUTHRIM_REPLICATION_AUTHORITY_SECRET_ARN: `${ARN}!` }],
    [
      'ARN unknown partition',
      { AUTHRIM_REPLICATION_AUTHORITY_SECRET_ARN: ARN.replace('arn:aws:', 'arn:aws-x:') },
    ],
    [
      'ARN wrong service',
      { AUTHRIM_REPLICATION_AUTHORITY_SECRET_ARN: ARN.replace('secretsmanager', 'kms') },
    ],
    [
      'ARN short account',
      { AUTHRIM_REPLICATION_AUTHORITY_SECRET_ARN: ARN.replace('123456789012', '12345678901') },
    ],
    ['missing ARN', { AUTHRIM_REPLICATION_AUTHORITY_SECRET_ARN: undefined }],
    ['missing region', { AWS_REGION: undefined }],
    ['ARN region mismatch', { AWS_REGION: 'ap-northeast-3' }],
    ['account mismatch', { AUTHRIM_REPLICATION_AUTHORITY_ACCOUNT_ID: '999999999999' }],
    ['missing account', { AUTHRIM_REPLICATION_AUTHORITY_ACCOUNT_ID: undefined }],
    ['missing version', { AUTHRIM_REPLICATION_AUTHORITY_SECRET_VERSION_ID: undefined }],
    ['short version', { AUTHRIM_REPLICATION_AUTHORITY_SECRET_VERSION_ID: 'a'.repeat(31) }],
    ['long version', { AUTHRIM_REPLICATION_AUTHORITY_SECRET_VERSION_ID: 'a'.repeat(65) }],
    [
      'version prefix junk',
      { AUTHRIM_REPLICATION_AUTHORITY_SECRET_VERSION_ID: `!${'a'.repeat(32)}` },
    ],
    [
      'version suffix junk',
      { AUTHRIM_REPLICATION_AUTHORITY_SECRET_VERSION_ID: `${'a'.repeat(32)}!` },
    ],
  ];
  for (const [name, over] of rejected) {
    it(`rejects ${name} before IO`, async () => {
      const r = await status({ ...env, ...over });
      expect(r.status).toBe(503);
      expect(r.readSecret).not.toHaveBeenCalled();
    });
  }
  const badRegions = [
    '1ap-northeast-1',
    'ap-northeast-12',
    'ap-1',
    'a-northeast-1',
    'apnortheast1',
    'AP-northeast-1',
  ];
  for (const region of badRegions) {
    it(`rejects region ${region} even when the ARN agrees`, async () => {
      const arn = `arn:aws:secretsmanager:${region}:123456789012:secret:authority-abcdef`;
      const r = await status({
        ...env,
        AWS_REGION: region,
        AUTHRIM_REPLICATION_AUTHORITY_SECRET_ARN: arn,
      });
      expect(r.status).toBe(503);
      expect(r.readSecret).not.toHaveBeenCalled();
    });
  }
  it('accepts multi-segment regions and version ids of 32 and 64 characters', async () => {
    for (const v of ['a'.repeat(32), 'B-'.repeat(32)]) {
      const r = await status({ ...env, AUTHRIM_REPLICATION_AUTHORITY_SECRET_VERSION_ID: v });
      expect(r.status).toBe(409);
    }
    const r = await status({
      ...env,
      AWS_REGION: 'us-gov-west-1',
      AUTHRIM_REPLICATION_AUTHORITY_SECRET_ARN:
        'arn:aws-us-gov:secretsmanager:us-gov-west-1:123456789012:secret:a/b_c+d=e.f@g-h',
    });
    expect(r.status).toBe(409);
  });
  it('snapshots the environment at construction', async () => {
    const e = { ...env } as Record<string, string | undefined>;
    const p = pool();
    const readSecret = vi.fn(async (_l?: unknown, _s?: unknown) => ({
      arn: ARN,
      versionId: VERSION,
      value: JSON.stringify(config),
    }));
    const runtime = createReplicationAuthorityRuntime({
      environment: e,
      readSecret,
      createPool: () => p,
    });
    e.AWS_REGION = 'us-east-1';
    expect((await runtime.fetch(req())).status).toBe(409);
    await runtime.close();
  });
});

describe('secret response validation', () => {
  it('requires the exact ARN and version in the response', async () => {
    expect((await status(env, config, `${ARN}x`)).status).toBe(503);
    expect((await status(env, config, undefined, 'b'.repeat(32))).status).toBe(503);
    expect((await status(env, config, '')).status).toBe(503);
  });
  it('rejects a missing secret string', async () => {
    const p = pool();
    const runtime = createReplicationAuthorityRuntime({
      environment: env,
      readSecret: async () => ({ arn: ARN, versionId: VERSION }),
      createPool: () => p,
    });
    expect((await runtime.fetch(req())).status).toBe(503);
  });
  it('enforces the 65536-byte secret limit on bytes, not characters', async () => {
    const json = JSON.stringify(config);
    const padTo = (n: number) => json + ' '.repeat(n - Buffer.byteLength(json));
    expect((await status(env, padTo(65_536))).status).toBe(409);
    expect((await status(env, padTo(65_537))).status).toBe(503);
    // multi-byte characters count as bytes: 32769 two-byte chars > limit even though < 65536 chars
    const multi = JSON.stringify({ ...config, pad: 'é'.repeat(32_769) });
    expect(multi.length).toBeLessThan(65_536);
    expect((await status(env, multi)).status).toBe(503);
  });
  it('requires exact top-level keys and formatVersion 1', async () => {
    expect((await status(env, { ...config, formatVersion: 2 })).status).toBe(503);
    expect((await status(env, { ...config, extra: 1 })).status).toBe(503);
    const { databaseUrl: _d, ...noUrl } = config;
    expect((await status(env, noUrl)).status).toBe(503);
    expect((await status(env, 'null')).status).toBe(503);
    expect((await status(env, 'not json')).status).toBe(503);
  });
  it('requires credentials to be a 1..128 element array', async () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...cred, credentialId: `cred-${i}` }));
    expect((await status(env, { ...config, credentials: many(1) })).status).toBe(409);
    expect((await status(env, { ...config, credentials: many(128) })).status).toBe(409);
    expect((await status(env, { ...config, credentials: many(129) })).status).toBe(503);
    expect((await status(env, { ...config, credentials: [] })).status).toBe(503);
    expect((await status(env, { ...config, credentials: 'x' })).status).toBe(503);
    expect((await status(env, { ...config, credentials: { length: 1 } })).status).toBe(503);
  });
  it('requires a TLS-verified database URL', async () => {
    const r = await status(env, { ...config, databaseUrl: 'postgres://u:p@h/db?sslmode=disable' });
    expect(r.status).toBe(503);
    expect(r.createPool).not.toHaveBeenCalled();
  });
  it('enforces exact credential key sets per role and scope', async () => {
    const writerT = { ...cred, role: 'writer', credentialId: 'w1', deploymentId: 'aws-a' };
    const { tenantId: _t, ...base } = cred;
    const ctrlE = { ...base, environmentId: 'env-a' };
    const writerE = { ...ctrlE, role: 'writer', credentialId: 'w2', deploymentId: 'aws-a' };
    for (const ok of [cred, writerT, ctrlE, writerE]) {
      expect((await status(env, { ...config, credentials: [ok] })).status).toBe(409);
    }
    const { deploymentId: _dw, ...writerTNoDep } = writerT;
    const { deploymentId: _de, ...writerENoDep } = writerE;
    const bads = [
      writerTNoDep,
      writerENoDep,
      { ...cred, deploymentId: 'aws-a' },
      { ...ctrlE, deploymentId: 'aws-a' },
      { ...cred, extra: 1 },
      { ...ctrlE, extra: 1 },
      { ...writerT, extra: 1 },
      { ...writerE, extra: 1 },
      { ...ctrlE, tenantId: 'tenant-a' },
      { ...writerT, environmentId: undefined, extra: 1 },
      null,
    ];
    for (const bad of bads) {
      const r = await status(env, { ...config, credentials: [bad] });
      expect(r.status).toBe(503);
    }
  });
});

describe('runtime behaviour', () => {
  it('returns a fixed 404 without IO for foreign routes', async () => {
    const p = pool();
    const readSecret = vi.fn();
    const runtime = createReplicationAuthorityRuntime({
      environment: env,
      readSecret,
      createPool: () => p,
    });
    const r = await runtime.fetch(new Request('https://x.test/other', { method: 'POST' }));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not_found' });
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(readSecret).not.toHaveBeenCalled();
  });
  it('503 responses are fixed and no-store', async () => {
    const runtime = createReplicationAuthorityRuntime({
      environment: env,
      readSecret: async () => {
        throw new Error('boom');
      },
    });
    const r = await runtime.fetch(req());
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'replication_authority_unavailable' });
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
  it('the pool error handler swallows idle errors', async () => {
    const r = await status(env);
    const handler = r.p.on.mock.calls.find((c) => c[0] === 'error')![1] as () => unknown;
    expect(handler()).toBeUndefined();
  });
  it('closes the pool when HTTP construction fails, even if end rejects', async () => {
    const p = pool();
    p.end.mockRejectedValue(new Error('end failed'));
    const runtime = createReplicationAuthorityRuntime({
      environment: env,
      readSecret: async () => ({
        arn: ARN,
        versionId: VERSION,
        value: JSON.stringify({ ...config, credentials: [cred, cred] }),
      }),
      createPool: () => p,
    });
    const r = await runtime.fetch(req());
    expect(r.status).toBe(503);
    expect(p.end).toHaveBeenCalledTimes(1);
    await runtime.close();
    expect(p.end).toHaveBeenCalledTimes(1);
  });
  it('close ends the pool once and allows a fresh load afterwards', async () => {
    const p = pool();
    const readSecret = vi.fn(async (_l?: unknown, _s?: unknown) => ({
      arn: ARN,
      versionId: VERSION,
      value: JSON.stringify(config),
    }));
    const runtime = createReplicationAuthorityRuntime({
      environment: env,
      readSecret,
      createPool: () => p,
    });
    await runtime.fetch(req());
    await runtime.close();
    expect(p.end).toHaveBeenCalledTimes(1);
    await runtime.close();
    expect(p.end).toHaveBeenCalledTimes(1);
    await runtime.fetch(req());
    expect(readSecret).toHaveBeenCalledTimes(2);
    await runtime.close();
  });
  it('close tolerates a failed load', async () => {
    const runtime = createReplicationAuthorityRuntime({
      environment: env,
      readSecret: async () => {
        throw new Error('x');
      },
    });
    await runtime.fetch(req());
    await expect(runtime.close()).resolves.toBeUndefined();
  });
  it('passes an abort signal that times out to readSecret', async () => {
    const r = await status(env);
    const signal = r.readSecret.mock.calls[0][1] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });
});

describe('default Secrets Manager reader', () => {
  it('pins ARN and version, reuses one client and destroys it on close', async () => {
    sm.send.mockResolvedValue({ ARN, VersionId: VERSION, SecretString: JSON.stringify(config) });
    const p = pool();
    const runtime = createReplicationAuthorityRuntime({
      environment: env,
      createPool: () => p,
    });
    expect((await runtime.fetch(req())).status).toBe(409);
    expect(sm.ctor).toHaveBeenCalledTimes(1);
    expect(sm.ctor).toHaveBeenCalledWith({
      region: 'ap-northeast-1',
      maxAttempts: 2,
      ignoreConfiguredEndpointUrls: true,
      requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
    });
    expect(sm.command).toHaveBeenCalledWith({ SecretId: ARN, VersionId: VERSION });
    const [command, options] = sm.send.mock.calls[0];
    expect(command.input).toEqual({ SecretId: ARN, VersionId: VERSION });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    await runtime.close();
    expect(sm.destroy).toHaveBeenCalledTimes(1);
    expect(p.end).toHaveBeenCalledTimes(1);
  });
  it('reuses the client across reloads after a failed first load', async () => {
    sm.send.mockRejectedValueOnce(new Error('x'));
    sm.send.mockResolvedValue({ ARN, VersionId: VERSION, SecretString: JSON.stringify(config) });
    const runtime = createReplicationAuthorityRuntime({
      environment: env,
      createPool: () => pool(),
    });
    expect((await runtime.fetch(req())).status).toBe(503);
    expect((await runtime.fetch(req())).status).toBe(409);
    expect(sm.ctor).toHaveBeenCalledTimes(1);
    await runtime.close();
  });
});

describe('module level lambda handler', () => {
  it('exports a Lambda handler that answers unknown routes with 404', async () => {
    vi.resetModules();
    const mod = await import('./authority-lambda');
    const event = {
      version: '2.0',
      routeKey: '$default',
      rawPath: '/nope',
      rawQueryString: '',
      headers: {},
      requestContext: {
        accountId: '1',
        apiId: 'a',
        domainName: 'x.test',
        domainPrefix: 'x',
        requestId: 'r',
        routeKey: '$default',
        stage: '$default',
        time: '',
        timeEpoch: 0,
        http: {
          method: 'POST',
          path: '/nope',
          protocol: 'HTTP/1.1',
          sourceIp: '1.1.1.1',
          userAgent: 't',
        },
      },
      isBase64Encoded: false,
    };
    const result: any = await (mod.handler as any)(event, {});
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ error: 'not_found' });
  });
});
