/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion -- mock call inspection */
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { LambdaEvent } from 'hono/aws-lambda';
import {
  environmentGenerationDigest,
  type EnvironmentGenerationRecord,
} from '@authrim/ar-lib-core/services/deployment-replication/environment-authority';
import type { loadAwsSamlDeployment } from './aws-assets';
import {
  createReplicatedAwsSamlLambdaHandler,
  hasReplicationDiscoveryConfiguration,
} from './replicated-lambda-handler';

const ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:discovery-abcdef';
const VERSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const G1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const G2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const event = {} as LambdaEvent;
const env = {
  AWS_REGION: 'ap-northeast-1',
  AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_ARN: ARN,
  AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_VERSION_ID: VERSION,
};
const v1config = (): any => ({
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
});
function selection(epoch = 1, generationId = G1, over: Record<string, unknown> = {}): any {
  return {
    pairId: 'pair-a',
    tenantId: 'tenant-a',
    deploymentId: 'aws-a',
    generationId,
    epoch,
    location: {
      region: 'ap-northeast-1',
      issuerOrigin: 'https://tenant-a.example.test',
      secretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:generation-abcdef',
      secretVersionId: VERSION,
      bucket: 'authrim-generation-test',
      bucketOwner: '123456789012',
      manifestKey: `generations/${generationId}/manifest.json`,
      manifestVersionId: 'immutable-manifest-version',
      manifestSha256: 'a'.repeat(64),
    },
    ...over,
  };
}
function deferred() {
  let resolve = () => undefined as void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function v1fixture(options: { config?: any; discoveryValue?: string } = {}) {
  const config = options.config ?? v1config();
  let current: any = selection();
  const closes: any[] = [];
  const reader = {
    getSecret: vi.fn(async (_input: any) => ({
      arn: ARN,
      versionId: VERSION,
      value: options.discoveryValue ?? JSON.stringify(config),
    })),
    getObject: vi.fn(),
    close: vi.fn(),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(current));
  const patch: { writer?: (w: any) => void; runtime?: (r: any) => void; secret?: string } = {};
  const loadDeployment = vi.fn<typeof loadAwsSamlDeployment>(async () => {
    const selected = structuredClone(current);
    const close = vi.fn(async () => undefined);
    closes.push(close);
    const writer: any = {
      version: 1,
      endpoint: config.endpoint,
      credentialId: config.credentialId,
      pairId: selected.pairId,
      tenantId: selected.tenantId,
      deploymentId: selected.deploymentId,
      epoch: selected.epoch,
      generationId: selected.generationId,
    };
    patch.writer?.(writer);
    const runtime: any = {
      tenantId: selected.tenantId,
      origin: selected.location.issuerOrigin,
      env: {
        AUTHRIM_REPLICATION_WRITER: JSON.stringify(writer),
        AUTHRIM_REPLICATION_WRITER_SECRET: patch.secret ?? config.writerSecret,
      } as Env,
      assertReady: vi.fn(async () => undefined),
    };
    patch.runtime?.(runtime);
    return { runtime, authState: { config: { backend: 'postgresql' } }, close } as any;
  });
  const createRuntime = vi.fn((input: any) => ({
    handler: vi.fn(async () => ({
      statusCode: 200,
      headers: {},
      body: input.tenants[0].env.AUTHRIM_REPLICATION_WRITER ?? '',
      isBase64Encoded: false,
    })),
  }));
  return {
    environment: { ...env } as Record<string, string | undefined>,
    reader,
    fetch,
    loadDeployment,
    createRuntime,
    closes,
    patch,
    set: (value: any) => {
      current = value;
    },
  };
}
const make = (f: ReturnType<typeof v1fixture>) => createReplicatedAwsSamlLambdaHandler(f);

describe('unavailable response shape', () => {
  it('is an exact non-cacheable JSON 503', async () => {
    const f = v1fixture();
    f.fetch.mockRejectedValue(new Error('down'));
    const r = await make(f).handler(event);
    expect(r).toEqual({
      statusCode: 503,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: '{"error":"temporarily_unavailable"}',
      isBase64Encoded: false,
    });
  });
  it('closed handlers answer the same 503 without any IO', async () => {
    const f = v1fixture();
    const h = make(f);
    await h.close();
    const r = await h.handler(event);
    expect(r.statusCode).toBe(503);
    expect(r.body).toBe('{"error":"temporarily_unavailable"}');
    expect(f.reader.getSecret).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe('hasReplicationDiscoveryConfiguration', () => {
  it('is true when either variable is defined, false when neither', () => {
    expect(hasReplicationDiscoveryConfiguration({})).toBe(false);
    expect(hasReplicationDiscoveryConfiguration({ AWS_REGION: 'x' })).toBe(false);
    expect(
      hasReplicationDiscoveryConfiguration({ AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_ARN: 'x' })
    ).toBe(true);
    expect(
      hasReplicationDiscoveryConfiguration({
        AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_VERSION_ID: 'x',
      })
    ).toBe(true);
    expect(
      hasReplicationDiscoveryConfiguration({
        AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_ARN: undefined,
        AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_VERSION_ID: undefined,
      })
    ).toBe(false);
  });
});

describe('discovery secret reading', () => {
  it('reads exactly the pinned arn and version with a timeout signal', async () => {
    const f = v1fixture();
    const h = make(f);
    expect((await h.handler(event)).statusCode).toBe(200);
    const input = f.reader.getSecret.mock.calls[0][0];
    expect(input.arn).toBe(ARN);
    expect(input.versionId).toBe(VERSION);
    expect(input.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(input).sort()).toEqual(['arn', 'signal', 'versionId']);
    await h.close();
  });
  const envBad: Array<[string, Record<string, string | undefined>]> = [
    ['missing arn', { AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_ARN: undefined }],
    ['arn prefix junk', { AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_ARN: `x${ARN}` }],
    ['arn suffix junk', { AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_ARN: `${ARN}!` }],
    [
      'unknown partition',
      { AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_ARN: ARN.replace('arn:aws:', 'arn:aws-x:') },
    ],
    [
      'short account',
      { AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_ARN: ARN.replace('123456789012', '12345678901') },
    ],
    ['region mismatch', { AWS_REGION: 'ap-northeast-3' }],
    ['missing version', { AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_VERSION_ID: undefined }],
    ['short version', { AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_VERSION_ID: 'a'.repeat(31) }],
    ['long version', { AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_VERSION_ID: 'a'.repeat(65) }],
    [
      'version prefix junk',
      { AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_VERSION_ID: `!${'a'.repeat(32)}` },
    ],
    [
      'version suffix junk',
      { AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_VERSION_ID: `${'a'.repeat(32)}!` },
    ],
  ];
  for (const [name, over] of envBad) {
    it(`rejects ${name} before reading the secret`, async () => {
      const f = v1fixture();
      f.environment = { ...env, ...over };
      expect((await make(f).handler(event)).statusCode).toBe(503);
      expect(f.reader.getSecret).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    });
  }
  it('accepts a 64 character version id and GovCloud arns', async () => {
    const f = v1fixture();
    const v = 'A-'.repeat(32);
    f.environment = { ...env, AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_VERSION_ID: v };
    f.reader.getSecret.mockResolvedValue({
      arn: ARN,
      versionId: v,
      value: JSON.stringify(v1config()),
    });
    expect((await make(f).handler(event)).statusCode).toBe(200);
  });
  it('requires the returned secret to match arn and version exactly', async () => {
    for (const reply of [
      { arn: `${ARN}x`, versionId: VERSION },
      { arn: ARN, versionId: 'b'.repeat(32) },
    ]) {
      const f = v1fixture();
      f.reader.getSecret.mockResolvedValue({ ...reply, value: JSON.stringify(v1config()) });
      expect((await make(f).handler(event)).statusCode).toBe(503);
      expect(f.fetch).not.toHaveBeenCalled();
    }
    const f = v1fixture();
    f.reader.getSecret.mockResolvedValue({ arn: ARN, versionId: VERSION } as any);
    expect((await make(f).handler(event)).statusCode).toBe(503);
  });
  it('limits the secret to 65536 bytes (not characters)', async () => {
    const json = JSON.stringify(v1config());
    const pad = (n: number) => json + ' '.repeat(n - Buffer.byteLength(json));
    const ok = v1fixture({ discoveryValue: pad(65_536) });
    expect((await make(ok).handler(event)).statusCode).toBe(200);
    const big = v1fixture({ discoveryValue: pad(65_537) });
    expect((await make(big).handler(event)).statusCode).toBe(503);
    expect(big.fetch).not.toHaveBeenCalled();
    const multi = v1fixture({
      discoveryValue: JSON.stringify({ ...v1config(), pad: 'é'.repeat(32_769) }),
    });
    expect((await make(multi).handler(event)).statusCode).toBe(503);
  });
  const cfgBad: Array<[string, (c: any) => void]> = [
    ['extra key', (c) => (c.extra = 1)],
    ['missing key', (c) => delete c.pairId],
    ['formatVersion 3', (c) => (c.formatVersion = 3)],
    ['region differs from secret', (c) => (c.region = 'ap-northeast-3')],
    ['bucket owner differs from secret account', (c) => (c.bucketOwner = '999999999999')],
    ['bucket too short', (c) => (c.bucket = 'a')],
    ['bucket uppercase', (c) => (c.bucket = 'Bucket-name')],
    ['bucket double dot', (c) => (c.bucket = 'my..bucket')],
    ['bucket dot dash', (c) => (c.bucket = 'my.-bucket')],
    ['bucket dash dot', (c) => (c.bucket = 'my-.bucket')],
    ['bucket ip address', (c) => (c.bucket = '192.168.1.1')],
    ['bucket too long', (c) => (c.bucket = 'a'.repeat(64))],
    ['bucket leading dash', (c) => (c.bucket = '-bucket')],
    ['credential id', (c) => (c.credentialId = 'bad id')],
    ['pair id', (c) => (c.pairId = 'bad id')],
    ['deployment id', (c) => (c.deploymentId = 'bad id')],
    ['tenant id', (c) => (c.tenantId = 'bad id')],
    ['short writer secret', (c) => (c.writerSecret = 'short')],
    [
      'endpoint not https',
      (c) => (c.endpoint = 'http://authority.example.test/replication/v1/rpc'),
    ],
    ['endpoint path', (c) => (c.endpoint = 'https://authority.example.test/other')],
    ['issuer http', (c) => (c.issuerOrigin = 'http://tenant-a.example.test')],
    ['issuer path', (c) => (c.issuerOrigin = 'https://tenant-a.example.test/x')],
    ['issuer credentials', (c) => (c.issuerOrigin = 'https://u:p@tenant-a.example.test')],
    ['issuer username only', (c) => (c.issuerOrigin = 'https://u@tenant-a.example.test')],
    ['issuer not a url', (c) => (c.issuerOrigin = 'nope')],
  ];
  for (const [name, fn] of cfgBad) {
    it(`rejects discovery configuration with ${name}`, async () => {
      const c = v1config();
      fn(c);
      const f = v1fixture({ config: c });
      expect((await make(f).handler(event)).statusCode).toBe(503);
      expect(f.fetch).not.toHaveBeenCalled();
    });
  }
  it('retries discovery after a failure rather than caching it', async () => {
    const f = v1fixture();
    f.reader.getSecret.mockRejectedValueOnce(new Error('transient'));
    const h = make(f);
    expect((await h.handler(event)).statusCode).toBe(503);
    expect((await h.handler(event)).statusCode).toBe(200);
    expect(f.reader.getSecret).toHaveBeenCalledTimes(2);
    expect((await h.handler(event)).statusCode).toBe(200);
    expect(f.reader.getSecret).toHaveBeenCalledTimes(2);
    await h.close();
  });
  it('snapshots the environment at construction', async () => {
    const f = v1fixture();
    const h = make(f);
    f.environment.AUTHRIM_AWS_REPLICATION_DISCOVERY_SECRET_ARN = 'changed';
    expect((await h.handler(event)).statusCode).toBe(200);
    await h.close();
  });
  it('does not contact authority when closed while discovery is pending', async () => {
    const f = v1fixture();
    const gate = deferred();
    f.reader.getSecret.mockImplementation(async () => {
      await gate.promise;
      return { arn: ARN, versionId: VERSION, value: JSON.stringify(v1config()) };
    });
    const h = make(f);
    const pending = h.handler(event);
    const closing = h.close();
    gate.resolve();
    expect((await pending).statusCode).toBe(503);
    await closing;
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe('v1 authority selection checks', () => {
  it('uses the writer credentials and the serving-generation action', async () => {
    const f = v1fixture();
    const h = make(f);
    await h.handler(event);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const init = f.fetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.action).toBe('getServingGeneration');
    expect(body.credentialId).toBe('aws-writer');
    expect(body.payload).toEqual({ pairId: 'pair-a', tenantId: 'tenant-a', deploymentId: 'aws-a' });
    await h.close();
  });
  it('rejects selections for another pair, tenant, deployment or issuer without loading', async () => {
    const cases: Array<(s: any) => void> = [
      (s) => (s.pairId = 'pair-b'),
      (s) => (s.tenantId = 'tenant-b'),
      (s) => (s.deploymentId = 'cf-a'),
      (s) => (s.location.issuerOrigin = 'https://other.example.test'),
    ];
    for (const fn of cases) {
      const f = v1fixture();
      const s = selection();
      fn(s);
      f.set(s);
      expect((await make(f).handler(event)).statusCode).toBe(503);
      expect(f.loadDeployment).not.toHaveBeenCalled();
    }
  });
  it('rejects structurally invalid selections even when identity fields match', async () => {
    const f = v1fixture();
    f.set(selection(1, G1, { extra: 1 }));
    expect((await make(f).handler(event)).statusCode).toBe(503);
    expect(f.loadDeployment).not.toHaveBeenCalled();
  });
  it('rejects locations in another bucket owner even if internally consistent', async () => {
    const f = v1fixture();
    const s = selection();
    s.location.bucketOwner = '222222222222';
    s.location.secretArn =
      'arn:aws:secretsmanager:ap-northeast-1:222222222222:secret:generation-abcdef';
    f.set(s);
    expect((await make(f).handler(event)).statusCode).toBe(503);
    expect(f.loadDeployment).not.toHaveBeenCalled();
  });
  it('rejects locations in another region or bucket even if internally consistent', async () => {
    const f = v1fixture();
    const s = selection();
    s.location.bucket = 'other-bucket-name';
    f.set(s);
    expect((await make(f).handler(event)).statusCode).toBe(503);
    const g = v1fixture();
    const s2 = selection();
    s2.location.region = 'ap-northeast-3';
    s2.location.secretArn = s2.location.secretArn.replace('ap-northeast-1', 'ap-northeast-3');
    g.set(s2);
    expect((await make(g).handler(event)).statusCode).toBe(503);
    expect(f.loadDeployment).not.toHaveBeenCalled();
    expect(g.loadDeployment).not.toHaveBeenCalled();
  });
  it('rejects a lower epoch than already served and the same epoch with a different generation', async () => {
    const f = v1fixture();
    const h = make(f);
    f.set(selection(3, G1));
    expect((await h.handler(event)).statusCode).toBe(200);
    f.set(selection(2, G2));
    expect((await h.handler(event)).statusCode).toBe(503);
    f.set(selection(3, G2));
    expect((await h.handler(event)).statusCode).toBe(503);
    f.set(selection(3, G1));
    expect((await h.handler(event)).statusCode).toBe(200);
    expect(f.loadDeployment).toHaveBeenCalledTimes(1);
    await h.close();
  });
  it('retires the previous generation exactly when a higher epoch is selected', async () => {
    const f = v1fixture();
    const h = make(f);
    expect((await h.handler(event)).statusCode).toBe(200);
    f.set(selection(2, G2));
    expect((await h.handler(event)).statusCode).toBe(200);
    expect(f.closes[0]).toHaveBeenCalledTimes(1);
    expect(f.closes[1]).not.toHaveBeenCalled();
    await h.close();
    expect(f.closes[1]).toHaveBeenCalledTimes(1);
  });
});

describe('generation initialization', () => {
  const individually: Array<[string, (f: ReturnType<typeof v1fixture>) => void]> = [
    ['tenant id', (f) => (f.patch.runtime = (r) => (r.tenantId = 'tenant-z'))],
    ['origin', (f) => (f.patch.runtime = (r) => (r.origin = 'https://other.example.test'))],
    ['writer epoch', (f) => (f.patch.writer = (w) => (w.epoch = 9))],
    ['writer generation', (f) => (f.patch.writer = (w) => (w.generationId = 'other'))],
    [
      'writer endpoint',
      (f) => (f.patch.writer = (w) => (w.endpoint = 'https://x.example.test/replication/v1/rpc')),
    ],
    ['writer credential', (f) => (f.patch.writer = (w) => (w.credentialId = 'other'))],
    ['writer pair', (f) => (f.patch.writer = (w) => (w.pairId = 'other'))],
    ['writer tenant', (f) => (f.patch.writer = (w) => (w.tenantId = 'other'))],
    ['writer deployment', (f) => (f.patch.writer = (w) => (w.deploymentId = 'other'))],
    ['writer secret', (f) => (f.patch.secret = 'b'.repeat(64))],
  ];
  for (const [name, fn] of individually) {
    it(`rejects a loaded generation with a mismatched ${name} and closes it`, async () => {
      const f = v1fixture();
      fn(f);
      const h = make(f);
      expect((await h.handler(event)).statusCode).toBe(503);
      expect(f.createRuntime).not.toHaveBeenCalled();
      expect(f.closes[0]).toHaveBeenCalledTimes(1);
      await h.close();
    });
  }
  it('requires the loaded generation to pass its readiness check', async () => {
    const f = v1fixture();
    f.patch.runtime = (r) => r.assertReady.mockRejectedValue(new Error('not ready'));
    expect((await make(f).handler(event)).statusCode).toBe(503);
    expect(f.createRuntime).not.toHaveBeenCalled();
    expect(f.closes[0]).toHaveBeenCalledTimes(1);
  });
  it('passes the loader the exact location and reader', async () => {
    const f = v1fixture();
    await make(f).handler(event);
    const arg = f.loadDeployment.mock.calls[0][0] as any;
    expect(arg.location).toEqual(selection().location);
    expect(arg.reader).toBe(f.reader);
  });
  it('retries a failed initialization on a later request', async () => {
    const f = v1fixture();
    let fail = true;
    f.patch.runtime = (r) => {
      if (fail) r.assertReady.mockRejectedValue(new Error('not ready'));
    };
    const h = make(f);
    expect((await h.handler(event)).statusCode).toBe(503);
    fail = false;
    expect((await h.handler(event)).statusCode).toBe(200);
    expect(f.loadDeployment).toHaveBeenCalledTimes(2);
    await h.close();
  });
  it('passes the lambda event and context to the runtime handler', async () => {
    const f = v1fixture();
    const handler = vi.fn(async () => ({
      statusCode: 204,
      headers: {},
      body: '',
      isBase64Encoded: false,
    }));
    f.createRuntime.mockReturnValue({ handler });
    const h = make(f);
    const ctx = { awsRequestId: 'r' } as any;
    const ev = { rawPath: '/x' } as any;
    expect((await h.handler(ev, ctx)).statusCode).toBe(204);
    expect(handler).toHaveBeenCalledWith(ev, ctx);
    await h.close();
  });
  it('does not serve when closed or retired while a generation was initializing', async () => {
    const f = v1fixture();
    const gate = deferred();
    f.patch.runtime = (r) =>
      r.assertReady.mockImplementation(async () => {
        await gate.promise;
      });
    const h = make(f);
    const pending = h.handler(event);
    await vi.waitFor(() => expect(f.loadDeployment).toHaveBeenCalled());
    const closing = h.close();
    gate.resolve();
    expect((await pending).statusCode).toBe(503);
    await closing;
    expect(f.closes[0]).toHaveBeenCalledTimes(1);
    const handler = f.createRuntime.mock.results[0]?.value?.handler;
    if (handler) expect(handler).not.toHaveBeenCalled();
  });
  it('a request waiting on an old generation is rejected once a newer epoch is selected', async () => {
    const f = v1fixture();
    const gate = deferred();
    let first = true;
    f.patch.runtime = (r) => {
      if (first) {
        first = false;
        r.assertReady.mockImplementation(async () => {
          await gate.promise;
        });
      }
    };
    const h = make(f);
    const slow = h.handler(event);
    await vi.waitFor(() => expect(f.loadDeployment).toHaveBeenCalledTimes(1));
    f.set(selection(2, G2));
    expect((await h.handler(event)).statusCode).toBe(200);
    gate.resolve();
    expect((await slow).statusCode).toBe(503);
    await h.close();
    expect(f.closes[0]).toHaveBeenCalledTimes(1);
    expect(f.closes[1]).toHaveBeenCalledTimes(1);
  });
});

describe('close', () => {
  it('waits for every runtime to finish closing', async () => {
    const f = v1fixture();
    const gate = deferred();
    const h = make(f);
    await h.handler(event);
    f.closes[0].mockImplementation(async () => {
      await gate.promise;
    });
    let done = false;
    const closing = h.close().then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(false);
    gate.resolve();
    await closing;
    expect(done).toBe(true);
    expect(f.closes[0]).toHaveBeenCalledTimes(1);
  });
  it('closes all child runtimes even if one fails to close', async () => {
    const f = v1fixture();
    const h = make(f);
    await h.handler(event);
    f.closes[0].mockRejectedValue(new Error('close failed'));
    await expect(h.close()).resolves.toBeUndefined();
  });
  it('is idempotent', async () => {
    const f = v1fixture();
    const h = make(f);
    await h.handler(event);
    await h.close();
    await h.close();
    expect(f.closes[0]).toHaveBeenCalledTimes(1);
  });
});

// ---------- environment (formatVersion 2) ----------
const v2config = (over: Record<string, unknown> = {}): any => ({
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
  ...over,
});
async function v2fixture(
  options: { config?: any; issuers?: string[]; mutate?: (r: any) => void } = {}
) {
  const config = options.config ?? v2config();
  const issuers = options.issuers ?? ['https://a.example.test', 'https://b.example.test'];
  const children = ['tenant-a', 'tenant-b'].map((tenantId, i) => ({
    tenantId,
    restoreId: `00000000-0000-4000-8000-00000000000${i + 1}`,
    sourceEpoch: 1,
    sourceFenceRevision: 2,
    capturedAtMs: 100,
    verificationSha256: 'b'.repeat(64),
    location: {
      region: 'ap-northeast-1',
      issuerOrigin: issuers[i],
      secretArn: `arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:child${i}-abcdef`,
      secretVersionId: VERSION,
      bucket: 'generation-test',
      bucketOwner: '123456789012',
      manifestKey: `children/${tenantId}.json`,
      manifestVersionId: 'pinned-version',
      manifestSha256: 'c'.repeat(64),
    },
  }));
  const body: any = {
    formatVersion: 1,
    pairId: 'pair-a',
    environmentId: 'logical-source',
    sourceDeploymentId: 'cf-a',
    deploymentId: 'aws-a',
    generationId: 'aggregate-1',
    epoch: 2,
    sourceEpoch: 1,
    sourceFenceRevision: 2,
    sourceOperationId: 'operation-a',
    sourcePlanSha256: 'd'.repeat(64),
    inventory: {
      formatVersion: 1,
      environmentId: 'logical-source',
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
  options.mutate?.(body);
  const current: EnvironmentGenerationRecord = {
    ...body,
    digestSha256: await environmentGenerationDigest(body),
  };
  const closes = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
  const loadDeployment = vi.fn<typeof loadAwsSamlDeployment>(async ({ location }) => {
    const index = current.children.findIndex(
      (c) => c.location.manifestKey === location.manifestKey
    );
    const child = current.children[index];
    return {
      runtime: {
        tenantId: child.tenantId,
        origin: child.location.issuerOrigin,
        env: {
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
        assertReady: vi.fn(async () => undefined),
      },
      authState: { config: { backend: 'postgresql' } },
      close: closes[index],
    } as any;
  });
  const reader = {
    getSecret: vi.fn(async () => ({ arn: ARN, versionId: VERSION, value: JSON.stringify(config) })),
    getObject: vi.fn(),
    close: vi.fn(),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(current));
  const createRuntime = vi.fn((input: any) => ({
    handler: vi.fn(async () => ({
      statusCode: 200,
      body: JSON.stringify(input.tenants.map((t: any) => t.tenantId)),
      headers: {},
      isBase64Encoded: false,
    })),
  }));
  const handler = createReplicatedAwsSamlLambdaHandler({
    environment: env,
    reader,
    fetch,
    loadDeployment,
    createRuntime,
  });
  return { handler, fetch, loadDeployment, createRuntime, closes, reader, current };
}

describe('v2 discovery configuration', () => {
  const origins = (n: number) => Array.from({ length: n }, (_, i) => `https://t${i}.example.test`);
  it('accepts exactly 16 issuer origins in the discovery configuration (reaches authority)', async () => {
    const f = await v2fixture({ config: v2config({ issuerOrigins: origins(16) }) });
    await f.handler.handler(event);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects 0, 17, duplicate, non-array and unsafe origins before contacting authority', async () => {
    const cases: unknown[] = [
      [],
      origins(17),
      ['https://a.example.test', 'https://a.example.test'],
      'https://a.example.test',
      ['http://a.example.test'],
      ['https://a.example.test/path'],
      ['https://u:p@a.example.test'],
      ['https://u@a.example.test'],
    ];
    for (const issuerOrigins of cases) {
      const f = await v2fixture({ config: v2config({ issuerOrigins }) });
      expect((await f.handler.handler(event)).statusCode).toBe(503);
      expect(f.fetch).not.toHaveBeenCalled();
    }
  });
  it('requires the exact v2 key set and valid identifiers', async () => {
    for (const config of [
      { ...v2config(), tenantId: 'x' },
      (() => {
        const { environmentId: _e, ...rest } = v2config();
        return rest;
      })(),
      v2config({ environmentId: 'bad id' }),
      v2config({ issuerOrigin: 'https://a.example.test' }),
    ]) {
      const f = await v2fixture({ config });
      expect((await f.handler.handler(event)).statusCode).toBe(503);
      expect(f.fetch).not.toHaveBeenCalled();
    }
  });
});

describe('v2 environment authority selection', () => {
  it('serves a complete environment and asks for the environment serving generation', async () => {
    const f = await v2fixture();
    const r = await f.handler.handler(event);
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('["tenant-a","tenant-b"]');
    const body = JSON.parse((f.fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.action).toBe('environmentGetServingGeneration');
    expect(body.payload).toEqual({
      pairId: 'pair-a',
      environmentId: 'logical-source',
      deploymentId: 'aws-a',
    });
    await f.handler.close();
  });
  it('rejects generations for another pair, environment or deployment', async () => {
    for (const mutate of [
      (b: any) => (b.pairId = 'pair-b'),
      (b: any) => (b.environmentId = 'other-env'),
      (b: any) => {
        b.deploymentId = 'aws-b';
      },
    ]) {
      const f = await v2fixture({
        mutate: (b) => {
          mutate(b);
          if (b.environmentId !== 'logical-source') b.inventory.environmentId = b.environmentId;
        },
      });
      expect((await f.handler.handler(event)).statusCode).toBe(503);
      expect(f.loadDeployment).not.toHaveBeenCalled();
    }
  });
  it('rejects a changed digest', async () => {
    const f = await v2fixture();
    f.current.digestSha256 = 'f'.repeat(64);
    expect((await f.handler.handler(event)).statusCode).toBe(503);
    expect(f.loadDeployment).not.toHaveBeenCalled();
  });
  it('matches issuers as sets regardless of order on either side', async () => {
    const reversedConfig = await v2fixture({
      config: v2config({ issuerOrigins: ['https://b.example.test', 'https://a.example.test'] }),
    });
    expect((await reversedConfig.handler.handler(event)).statusCode).toBe(200);
    // tenant order and issuer order disagree on the generation side
    const inverted = await v2fixture({
      issuers: ['https://z.example.test', 'https://a.example.test'],
      config: v2config({ issuerOrigins: ['https://a.example.test', 'https://z.example.test'] }),
    });
    expect((await inverted.handler.handler(event)).statusCode).toBe(200);
    const invertedReversed = await v2fixture({
      issuers: ['https://z.example.test', 'https://a.example.test'],
      config: v2config({ issuerOrigins: ['https://z.example.test', 'https://a.example.test'] }),
    });
    expect((await invertedReversed.handler.handler(event)).statusCode).toBe(200);
  });
  it('rejects an issuer set that differs from the configured one', async () => {
    const f = await v2fixture({
      config: v2config({ issuerOrigins: ['https://a.example.test', 'https://c.example.test'] }),
    });
    expect((await f.handler.handler(event)).statusCode).toBe(503);
    expect(f.loadDeployment).not.toHaveBeenCalled();
    const g = await v2fixture({ config: v2config({ issuerOrigins: ['https://a.example.test'] }) });
    expect((await g.handler.handler(event)).statusCode).toBe(503);
  });
  it('rejects child locations outside the configured region, bucket or owner', async () => {
    for (const mutate of [
      (b: any) => (b.children[0].location.bucket = 'other-bucket'),
      (b: any) => {
        b.children[0].location.bucketOwner = '222222222222';
        b.children[0].location.secretArn = b.children[0].location.secretArn.replace(
          '123456789012',
          '222222222222'
        );
      },
      (b: any) => {
        b.children[0].location.region = 'ap-northeast-3';
        b.children[0].location.secretArn = b.children[0].location.secretArn.replace(
          'ap-northeast-1',
          'ap-northeast-3'
        );
      },
    ]) {
      const f = await v2fixture({ mutate });
      expect((await f.handler.handler(event)).statusCode).toBe(503);
      expect(f.loadDeployment).not.toHaveBeenCalled();
    }
  });
  it('closes already loaded children when a later child is rejected', async () => {
    const f = await v2fixture();
    const original = f.loadDeployment.getMockImplementation()!;
    f.loadDeployment.mockImplementation(async (input) => {
      const loaded = await original(input);
      if (input.location.manifestKey.endsWith('tenant-b.json'))
        (loaded.runtime.env as any).AUTHRIM_REPLICATION_WRITER_SECRET = 'z'.repeat(64);
      return loaded;
    });
    expect((await f.handler.handler(event)).statusCode).toBe(503);
    expect(f.createRuntime).not.toHaveBeenCalled();
    expect(f.closes[0]).toHaveBeenCalledTimes(1);
    expect(f.closes[1]).toHaveBeenCalledTimes(1);
  });
});
