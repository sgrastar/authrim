/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- fakes and deliberately malformed inputs are intentionally untyped */
import { createHash, X509Certificate } from 'node:crypto';
import type { LambdaEvent } from 'hono/aws-lambda';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sourceSigningBundle } from './synthetic-fixture';

const mocks = vi.hoisted(() => ({
  clientCtor: vi.fn(),
  send: vi.fn(),
  commandCtor: vi.fn(),
  poolCtor: vi.fn(),
  poolQuery: vi.fn(),
  poolOn: vi.fn(),
  poolEnd: vi.fn(),
  storeCtor: vi.fn(),
  createSp: vi.fn(),
  dynamoClient: vi.fn(),
  destroy: vi.fn(),
  install: vi.fn(),
  markWarm: vi.fn(),
  assertTable: vi.fn(),
  assertSealed: vi.fn(),
  createStores: vi.fn(),
  tableName: vi.fn(),
  normalize: vi.fn(),
  selected: vi.fn(),
  spHandler: vi.fn(),
  state: { storeChallenge: vi.fn(), consumeChallenge: vi.fn() },
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    constructor(options: unknown) {
      mocks.clientCtor(options);
    }
    send = mocks.send;
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {
      mocks.commandCtor(input);
    }
  },
}));
vi.mock('pg', () => ({
  Pool: class {
    constructor(options: unknown) {
      mocks.poolCtor(options);
    }
    query = mocks.poolQuery;
    on = mocks.poolOn;
    end = mocks.poolEnd;
  },
}));
vi.mock('../storage/postgres-transient-state', () => ({
  PostgresTransientStateStore: class {
    constructor(public db: unknown) {
      mocks.storeCtor(db);
    }
  },
}));
vi.mock('./browser-sp', async (original) => ({
  ...(await original<typeof import('./browser-sp')>()),
  createSyntheticBrowserSp: mocks.createSp,
}));
vi.mock('./browser-sp-diagnostics', () => ({ installSyntheticSpStateDiagnostics: mocks.install }));
vi.mock('../storage/create-state-stores', () => ({ createAwsStateStores: mocks.createStores }));
vi.mock('../storage/dynamodb-state', () => ({ createDynamoStateClient: mocks.dynamoClient }));
vi.mock('../storage/auth-state-config', () => ({
  normalizeAwsAuthStateConfig: mocks.normalize,
  dynamoAuthStateTableName: mocks.tableName,
}));
vi.mock('../import/auth-state-restore', () => ({
  assertDynamoAuthStateTable: mocks.assertTable,
  assertDynamoAuthStateSealed: mocks.assertSealed,
}));
vi.mock('./selected-auth-state', () => ({ selectedSyntheticDynamoState: mocks.selected }));

const origin = 'https://abcdefghij.execute-api.ap-northeast-1.amazonaws.com';
const host = origin.slice(8);
const dbHost = 'browser-test.abc.ap-northeast-1.rds.amazonaws.com';
const ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:browser-sp/secret-AbCdEf';
const VERSION = 'a'.repeat(32);
const DB_URL = `postgresql://authrim_dr_browser_state:private-password@${dbHost}:5432/authrim_dr_browser_state?sslmode=verify-full`;
let baseConfig: Record<string, unknown>;

beforeAll(async () => {
  const signing = await sourceSigningBundle();
  baseConfig = {
    syntheticOnly: true,
    environmentName: 'aws-browser-rehearsal',
    origin,
    tenantId: 'tenant-a',
    certificatePem: signing.certificate,
    certificateDerSha256: createHash('sha256')
      .update(new X509Certificate(signing.certificate).raw)
      .digest('hex'),
  };
});

const secretValue = (extra: Record<string, unknown> = {}) => ({
  formatVersion: 1,
  ...baseConfig,
  stateDatabaseUrl: DB_URL,
  ...extra,
});
const event = (over: Record<string, unknown> = {}) =>
  ({
    version: '2.0',
    headers: { host },
    requestContext: { domainName: host, http: { sourceIp: '203.0.113.9' } },
    ...over,
  }) as unknown as LambdaEvent;
const setEnv = (over: Record<string, string | undefined> = {}) => {
  const env = {
    AUTHRIM_AWS_BROWSER_SP_ENABLED: 'synthetic-only',
    AUTHRIM_AWS_BROWSER_SP_ORIGIN: origin,
    AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: ARN,
    AUTHRIM_AWS_BROWSER_SP_SECRET_VERSION_ID: VERSION,
    AUTHRIM_AWS_BROWSER_SP_DB_HOST: dbHost,
    AWS_REGION: 'ap-northeast-1',
    ...over,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(key, undefined);
    else vi.stubEnv(key, value);
  }
};
const load = async () => {
  vi.resetModules();
  return import('./browser-sp-lambda');
};
const okSecret = (config: unknown = secretValue()) => ({
  ARN,
  VersionId: VERSION,
  SecretString: JSON.stringify(config),
});
const UNAVAILABLE = {
  statusCode: 503,
  body: 'temporarily_unavailable',
  headers: { 'cache-control': 'no-store' },
  isBase64Encoded: false,
};
const UNTRUSTED = {
  statusCode: 400,
  body: 'untrusted_ingress',
  headers: { 'cache-control': 'no-store' },
  isBase64Encoded: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  setEnv();
  mocks.send.mockResolvedValue(okSecret());
  mocks.poolQuery.mockResolvedValue({
    rows: [
      { database: 'authrim_dr_browser_state', username: 'authrim_dr_browser_state', ssl: true },
    ],
  });
  mocks.poolEnd.mockResolvedValue(undefined);
  mocks.spHandler.mockResolvedValue({ statusCode: 200, body: 'sp' });
  mocks.createSp.mockImplementation(() => ({ handler: mocks.spHandler }));
  mocks.normalize.mockReturnValue({ backend: 'postgresql' });
  mocks.selected.mockReturnValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('synthetic browser SP lambda ingress gate (mutation hardening)', () => {
  it('answers untrusted ingress with the exact fixed response and never initialises', async () => {
    const { handler } = await load();
    const bad: Array<[string, LambdaEvent, Record<string, string | undefined>?]> = [
      ['disabled', event(), { AUTHRIM_AWS_BROWSER_SP_ENABLED: 'true' }],
      ['unset', event(), { AUTHRIM_AWS_BROWSER_SP_ENABLED: undefined }],
      ['origin unset', event(), { AUTHRIM_AWS_BROWSER_SP_ORIGIN: undefined }],
      ['origin http', event(), { AUTHRIM_AWS_BROWSER_SP_ORIGIN: origin.replace('https', 'http') }],
      [
        'origin short id',
        event(),
        { AUTHRIM_AWS_BROWSER_SP_ORIGIN: origin.replace('abcdefghij', 'abc') },
      ],
      ['origin suffix', event(), { AUTHRIM_AWS_BROWSER_SP_ORIGIN: `${origin}/x` }],
      ['origin prefix', event(), { AUTHRIM_AWS_BROWSER_SP_ORIGIN: `x${origin}` }],
      [
        'origin uppercase id',
        event(),
        { AUTHRIM_AWS_BROWSER_SP_ORIGIN: origin.replace('abcdefghij', 'ABCDEFGHIJ') },
      ],
      ['no version', { requestContext: event().requestContext, headers: { host } } as never],
      ['version 1.0', event({ version: '1.0' })],
      ['no http', event({ requestContext: { domainName: host } })],
      [
        'domain',
        event({ requestContext: { domainName: 'x.example', http: { sourceIp: '203.0.113.9' } } }),
      ],
      ['host header', event({ headers: { host: 'x.example' } })],
      [
        'source ip',
        event({ requestContext: { domainName: host, http: { sourceIp: 'not-an-ip' } } }),
      ],
    ];
    for (const [name, evt, env] of bad) {
      setEnv(env);
      expect(await handler(evt), name).toEqual(UNTRUSTED);
    }
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.createSp).not.toHaveBeenCalled();
  });

  it('accepts IPv4 and IPv6 sources and compares host without the scheme', async () => {
    const { handler } = await load();
    for (const sourceIp of ['203.0.113.9', '2001:db8::1']) {
      expect(
        await handler(event({ requestContext: { domainName: host, http: { sourceIp } } }))
      ).toEqual({ statusCode: 200, body: 'sp' });
    }
  });
});

describe('synthetic browser SP lambda initialisation (mutation hardening)', () => {
  it('reads the pinned secret with a bounded client and builds the PostgreSQL-backed SP', async () => {
    const { handler } = await load();
    const context = { awsRequestId: 'r' } as never;
    const evt = event();
    expect(await handler(evt, context)).toEqual({ statusCode: 200, body: 'sp' });
    expect(mocks.clientCtor).toHaveBeenCalledWith({
      region: 'ap-northeast-1',
      maxAttempts: 2,
      ignoreConfiguredEndpointUrls: true,
      requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
    });
    expect(mocks.commandCtor).toHaveBeenCalledWith({ SecretId: ARN, VersionId: VERSION });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ input: expect.anything() }), {
      abortSignal: expect.any(AbortSignal),
    });
    expect(mocks.poolCtor).toHaveBeenCalledWith({
      connectionString: DB_URL,
      max: 2,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
    });
    expect(mocks.poolOn).toHaveBeenCalledWith('error', expect.any(Function));
    expect(() => mocks.poolOn.mock.calls[0][1](new Error('secret'))).not.toThrow();
    const sql = mocks.poolQuery.mock.calls[0][0] as string;
    expect(sql).toContain('current_database() AS database');
    expect(sql).toContain('current_user AS username');
    expect(sql).toContain('pg_stat_ssl');
    expect(mocks.storeCtor).toHaveBeenCalledTimes(1);
    const dbArg = mocks.storeCtor.mock.calls[0][0] as {
      query: (s: string, v: unknown[]) => unknown;
    };
    mocks.poolQuery.mockResolvedValueOnce('delegated');
    expect(await dbArg.query('SELECT 1', [1])).toBe('delegated');
    expect(mocks.poolQuery).toHaveBeenLastCalledWith('SELECT 1', [1]);
    expect(mocks.createSp).toHaveBeenCalledTimes(1);
    const input = mocks.createSp.mock.calls[0][0];
    expect(input.config).toMatchObject({ origin, tenantId: 'tenant-a' });
    expect(input.store).toMatchObject({ db: dbArg });
    expect(mocks.spHandler).toHaveBeenCalledWith(evt, context);
  });

  it('initialises once, shares in-flight work and reuses the SDK client', async () => {
    const { handler } = await load();
    const [a, b] = await Promise.all([handler(event()), handler(event())]);
    expect(a).toEqual(b);
    await handler(event());
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.createSp).toHaveBeenCalledTimes(1);
    expect(mocks.spHandler).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['AWS_REGION', { AWS_REGION: 'us-east-1' }],
    ['AWS_REGION unset', { AWS_REGION: undefined }],
    ['ARN unset', { AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: undefined }],
    [
      'ARN partition',
      { AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: ARN.replace('arn:aws:', 'arn:aws-cn:') },
    ],
    [
      'ARN region',
      { AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: ARN.replace('ap-northeast-1', 'us-east-1') },
    ],
    [
      'ARN account',
      { AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: ARN.replace('123456789012', '12345678901a') },
    ],
    [
      'ARN account short',
      { AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: ARN.replace('123456789012', '12345678901') },
    ],
    [
      'ARN account long',
      { AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: ARN.replace('123456789012', '1234567890123') },
    ],
    ['ARN service', { AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: ARN.replace('secretsmanager', 'ssm') }],
    ['ARN empty name', { AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: ARN.split('secret:')[0] + 'secret:' }],
    ['ARN bad char', { AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: `${ARN}!` }],
    ['ARN prefix', { AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: `x${ARN}` }],
    ['version unset', { AUTHRIM_AWS_BROWSER_SP_SECRET_VERSION_ID: undefined }],
    ['version short', { AUTHRIM_AWS_BROWSER_SP_SECRET_VERSION_ID: 'a'.repeat(31) }],
    ['version long', { AUTHRIM_AWS_BROWSER_SP_SECRET_VERSION_ID: 'a'.repeat(65) }],
    ['version bad char', { AUTHRIM_AWS_BROWSER_SP_SECRET_VERSION_ID: `${'a'.repeat(31)}_` }],
    ['version trailing', { AUTHRIM_AWS_BROWSER_SP_SECRET_VERSION_ID: `${'a'.repeat(32)}\n!` }],
  ])('refuses to read the secret when %s', async (_name, env) => {
    const { handler } = await load();
    setEnv(env);
    expect(await handler(event())).toEqual(UNAVAILABLE);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.clientCtor).not.toHaveBeenCalled();
  });

  it('accepts boundary version identifiers and ARN name characters', async () => {
    const { handler } = await load();
    setEnv({
      AUTHRIM_AWS_BROWSER_SP_SECRET_VERSION_ID: `${'A'.repeat(32)}`,
      AUTHRIM_AWS_BROWSER_SP_SECRET_ARN: `${ARN.split('secret:')[0]}secret:a/b_c+d=e.f@g-h`,
    });
    mocks.send.mockResolvedValue({
      ARN: `${ARN.split('secret:')[0]}secret:a/b_c+d=e.f@g-h`,
      VersionId: 'A'.repeat(32),
      SecretString: JSON.stringify(secretValue()),
    });
    expect((await handler(event())).statusCode).toBe(200);
    vi.resetModules();
    const again = await load();
    setEnv({ AUTHRIM_AWS_BROWSER_SP_SECRET_VERSION_ID: 'b'.repeat(64) });
    mocks.send.mockResolvedValue(okSecret());
    mocks.send.mockResolvedValue({
      ARN,
      VersionId: 'b'.repeat(64),
      SecretString: JSON.stringify(secretValue()),
    });
    expect((await again.handler(event())).statusCode).toBe(200);
  });

  it.each([
    ['ARN differs', { ARN: `${ARN}x` }],
    ['version differs', { VersionId: 'b'.repeat(32) }],
    ['no string', { SecretString: undefined }],
    ['empty string', { SecretString: '' }],
    [
      'oversized string',
      { SecretString: ' '.repeat(64 * 1024 + 1) + JSON.stringify(secretValue()) },
    ],
    ['not json', { SecretString: '{bad' }],
    ['wrong shape', { SecretString: JSON.stringify({ formatVersion: 1 }) }],
  ])('rejects a secret response where %s', async (_name, patch) => {
    const { handler } = await load();
    mocks.send.mockResolvedValue({ ...okSecret(), ...patch });
    expect(await handler(event())).toEqual(UNAVAILABLE);
    expect(mocks.createSp).not.toHaveBeenCalled();
    expect(mocks.poolCtor).not.toHaveBeenCalled();
  });

  it('accepts a secret exactly 64 KiB long', async () => {
    const { handler } = await load();
    const json = JSON.stringify(secretValue());
    mocks.send.mockResolvedValue({
      ...okSecret(),
      SecretString: json + ' '.repeat(64 * 1024 - json.length),
    });
    expect((await handler(event())).statusCode).toBe(200);
  });

  it('retries initialisation after a failure instead of caching it', async () => {
    const { handler } = await load();
    mocks.send.mockRejectedValueOnce(new Error('boom'));
    expect(await handler(event())).toEqual(UNAVAILABLE);
    expect((await handler(event())).statusCode).toBe(200);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.clientCtor).toHaveBeenCalledTimes(1);
    // a failing handler also resets the cache
    mocks.spHandler.mockRejectedValueOnce(new Error('handler failed'));
    expect(await handler(event())).toEqual(UNAVAILABLE);
    expect((await handler(event())).statusCode).toBe(200);
    expect(mocks.send).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['no row', { rows: [] }],
    [
      'two rows',
      {
        rows: [
          { database: 'authrim_dr_browser_state', username: 'authrim_dr_browser_state', ssl: true },
          { database: 'authrim_dr_browser_state', username: 'authrim_dr_browser_state', ssl: true },
        ],
      },
    ],
    [
      'database',
      { rows: [{ database: 'other', username: 'authrim_dr_browser_state', ssl: true }] },
    ],
    ['user', { rows: [{ database: 'authrim_dr_browser_state', username: 'other', ssl: true }] }],
    [
      'no tls',
      {
        rows: [
          {
            database: 'authrim_dr_browser_state',
            username: 'authrim_dr_browser_state',
            ssl: false,
          },
        ],
      },
    ],
    [
      'unknown tls',
      {
        rows: [
          { database: 'authrim_dr_browser_state', username: 'authrim_dr_browser_state', ssl: null },
        ],
      },
    ],
    [
      'truthy tls',
      {
        rows: [
          {
            database: 'authrim_dr_browser_state',
            username: 'authrim_dr_browser_state',
            ssl: 'yes',
          },
        ],
      },
    ],
  ])('rejects the database identity check: %s', async (_name, result) => {
    const { handler } = await load();
    mocks.poolQuery.mockResolvedValue(result);
    expect(await handler(event())).toEqual(UNAVAILABLE);
    expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
    expect(mocks.createSp).not.toHaveBeenCalled();
  });

  it('closes the pool when the identity query fails, even if closing also fails', async () => {
    const { handler } = await load();
    mocks.poolQuery.mockRejectedValue(new Error('x'));
    mocks.poolEnd.mockRejectedValue(new Error('end failed'));
    expect(await handler(event())).toEqual(UNAVAILABLE);
    expect(mocks.poolEnd).toHaveBeenCalledTimes(1);
  });

  describe('DynamoDB-backed state', () => {
    const dynamo = {
      target: { region: 'ap-northeast-1', namespace: 'ns-1', tableName: 'tbl' },
      receipt: { source: { issuer: origin }, tenantId: 'tenant-a' },
    };
    const authState = { config: { backend: 'dynamodb' }, receipt: { id: 'r' } };
    const dynamoSecret = () => {
      const { stateDatabaseUrl: _omit, ...rest } = secretValue({ authState });
      return rest;
    };
    beforeEach(() => {
      mocks.normalize.mockReturnValue({ backend: 'dynamodb' });
      mocks.selected.mockReturnValue(dynamo);
      mocks.send.mockResolvedValue(okSecret(dynamoSecret()));
      mocks.dynamoClient.mockReturnValue({ destroy: mocks.destroy });
      mocks.install.mockReturnValue(mocks.markWarm);
      mocks.assertTable.mockResolvedValue(undefined);
      mocks.assertSealed.mockResolvedValue(undefined);
      mocks.tableName.mockReturnValue('derived-table');
      mocks.createStores.mockReturnValue({ state: mocks.state });
      mocks.state.storeChallenge.mockResolvedValue(true);
      mocks.state.consumeChallenge.mockResolvedValue({ userId: 'u' });
    });

    it('verifies the sealed table, warms diagnostics and gates every state operation on readiness', async () => {
      const { handler } = await load();
      expect((await handler(event())).statusCode).toBe(200);
      expect(mocks.normalize).toHaveBeenCalledWith(authState.config, {
        accountId: '123456789012',
        region: 'ap-northeast-1',
      });
      expect(mocks.dynamoClient).toHaveBeenCalledWith({ region: 'ap-northeast-1' });
      expect(mocks.install).toHaveBeenCalledWith(
        expect.objectContaining({ destroy: mocks.destroy })
      );
      const stateClient = mocks.dynamoClient.mock.results[0].value;
      expect(mocks.assertTable).toHaveBeenCalledWith(stateClient, dynamo.target);
      expect(mocks.assertSealed).toHaveBeenCalledTimes(1);
      expect(mocks.assertSealed).toHaveBeenCalledWith({ ...dynamo, client: stateClient });
      expect(mocks.markWarm).toHaveBeenCalledTimes(1);
      expect(mocks.tableName).toHaveBeenCalledWith(dynamo.target);
      expect(mocks.createStores).toHaveBeenCalledWith({
        backend: 'dynamodb',
        client: stateClient,
        tableName: 'derived-table',
        namespace: 'ns-1',
      });
      expect(mocks.poolCtor).not.toHaveBeenCalled();
      const store = mocks.createSp.mock.calls[0][0].store;
      const challenge = { tenantId: 't', id: 'i' };
      expect(await store.storeChallenge(challenge)).toBe(true);
      expect(mocks.assertSealed).toHaveBeenCalledTimes(2);
      expect(mocks.state.storeChallenge).toHaveBeenCalledWith(challenge);
      expect(await store.consumeChallenge(challenge)).toEqual({ userId: 'u' });
      expect(mocks.assertSealed).toHaveBeenCalledTimes(3);
      expect(mocks.state.consumeChallenge).toHaveBeenCalledWith(challenge);
      mocks.assertSealed.mockRejectedValue(new Error('unsealed'));
      await expect(store.storeChallenge(challenge)).rejects.toThrow('unsealed');
      await expect(store.consumeChallenge(challenge)).rejects.toThrow('unsealed');
      expect(mocks.state.storeChallenge).toHaveBeenCalledTimes(1);
      expect(mocks.state.consumeChallenge).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['table check', () => mocks.assertTable.mockRejectedValue(new Error('x'))],
      ['sealed check', () => mocks.assertSealed.mockRejectedValue(new Error('x'))],
      [
        'store creation',
        () =>
          mocks.createStores.mockImplementation(() => {
            throw new Error('x');
          }),
      ],
      [
        'SP creation',
        () =>
          mocks.createSp.mockImplementation(() => {
            throw new Error('x');
          }),
      ],
    ])('destroys the client when %s fails', async (_name, arrange) => {
      const { handler } = await load();
      arrange();
      expect(await handler(event())).toEqual(UNAVAILABLE);
      expect(mocks.destroy).toHaveBeenCalledTimes(1);
      expect(mocks.markWarm).toHaveBeenCalledTimes(
        _name === 'table check' || _name === 'sealed check' ? 0 : 1
      );
    });
  });
});

describe('parseSyntheticBrowserSpSecret authState handling (mutation hardening)', () => {
  const dynamo = {
    target: { region: 'ap-northeast-1', namespace: 'n', tableName: 't' },
    receipt: { source: { issuer: origin }, tenantId: 'tenant-a' },
  };
  const withAuth = (auth: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const { stateDatabaseUrl: _omit, ...rest } = secretValue({ authState: auth, ...extra });
    return extra.stateDatabaseUrl === undefined && !('stateDatabaseUrl' in extra)
      ? rest
      : { ...rest, ...extra };
  };
  const aws = { accountId: '123456789012', region: 'ap-northeast-1' };

  it('accepts a DynamoDB selection only when every pin matches', async () => {
    const { parseSyntheticBrowserSpSecret } = await load();
    mocks.normalize.mockReturnValue({ backend: 'dynamodb' });
    const auth = { config: { backend: 'dynamodb' }, receipt: { r: 1 } };
    mocks.selected.mockReturnValue(dynamo);
    expect(parseSyntheticBrowserSpSecret(withAuth(auth), origin, dbHost, aws)).toMatchObject({
      origin,
    });
    expect(mocks.normalize).toHaveBeenCalledWith(auth.config, aws);
    expect(mocks.selected).toHaveBeenCalledWith(auth);
    const reject = (value: unknown) =>
      expect(() => parseSyntheticBrowserSpSecret(value, origin, dbHost, aws)).toThrow(
        'synthetic_browser_sp_configuration_invalid'
      );
    mocks.selected.mockReturnValue(undefined);
    reject(withAuth(auth));
    mocks.selected.mockReturnValue(dynamo);
    reject(withAuth(auth, { stateDatabaseUrl: DB_URL }));
    mocks.selected.mockReturnValue({
      ...dynamo,
      receipt: { ...dynamo.receipt, source: { issuer: 'https://x.example' } },
    });
    reject(withAuth(auth));
    mocks.selected.mockReturnValue({
      ...dynamo,
      receipt: { ...dynamo.receipt, tenantId: 'tenant-b' },
    });
    reject(withAuth(auth));
    mocks.selected.mockReturnValue(dynamo);
    reject(withAuth({ ...auth, extra: 1 }));
    reject(withAuth({ config: auth.config }));
    reject(withAuth({ receipt: auth.receipt }));
    mocks.normalize.mockImplementation(() => {
      throw new Error('bad config');
    });
    reject(withAuth(auth));
  });

  it('accepts a non-DynamoDB selection only as a lone config plus the isolated database', async () => {
    const { parseSyntheticBrowserSpSecret } = await load();
    mocks.normalize.mockReturnValue({ backend: 'postgresql' });
    const ok = secretValue({ authState: { config: { backend: 'postgresql' } } });
    expect(parseSyntheticBrowserSpSecret(ok, origin, dbHost, aws).stateDatabaseUrl).toBe(DB_URL);
    expect(mocks.selected).not.toHaveBeenCalled();
    const reject = (value: unknown) =>
      expect(() => parseSyntheticBrowserSpSecret(value, origin, dbHost, aws)).toThrow(
        'synthetic_browser_sp_configuration_invalid'
      );
    reject(secretValue({ authState: { config: {}, receipt: {} } }));
    reject(secretValue({ authState: { receipt: {} } }));
    reject(secretValue({ authState: {} }));
    const { stateDatabaseUrl: _omit, ...noUrl } = ok;
    reject(noUrl);
  });

  it('pins the database host shape and key set', async () => {
    const { parseSyntheticBrowserSpSecret } = await load();
    const run = (value: unknown, expectedHost = dbHost) =>
      parseSyntheticBrowserSpSecret(value, origin, expectedHost);
    expect(run(secretValue()).origin).toBe(origin);
    for (const badHost of [
      'db.example.com',
      'x.rds.amazonaws.com.evil.com',
      'Upper.rds.amazonaws.com',
      '.rds.amazonaws.com',
      'a/b.rds.amazonaws.com',
    ])
      expect(() =>
        run(secretValue({ stateDatabaseUrl: DB_URL.replace(dbHost, badHost) }), badHost)
      ).toThrow('synthetic_browser_sp_configuration_invalid');
    for (const bad of [
      null,
      'text',
      [],
      { ...secretValue(), formatVersion: 2 },
      { ...secretValue(), stateDatabaseUrl: 5 },
      secretValue({ stateDatabaseUrl: DB_URL.replace('postgresql:', 'postgres:') }),
      secretValue({ stateDatabaseUrl: DB_URL.replace(':5432', ':5433') }),
      secretValue({
        stateDatabaseUrl: DB_URL.replace('authrim_dr_browser_state:private', 'other:private'),
      }),
      secretValue({ stateDatabaseUrl: DB_URL.replace('/authrim_dr_browser_state?', '/other?') }),
      secretValue({ stateDatabaseUrl: DB_URL.replace(':private-password', '') }),
      secretValue({ stateDatabaseUrl: `${DB_URL}#frag` }),
      secretValue({ stateDatabaseUrl: `${DB_URL}&application_name=x` }),
      secretValue({ stateDatabaseUrl: DB_URL.replace('sslmode=verify-full', 'sslmode=require') }),
      secretValue({ stateDatabaseUrl: 'not a url' }),
      secretValue({ extra: 1 }),
      (() => {
        const { certificatePem: _c, ...rest } = secretValue() as Record<string, unknown>;
        return rest;
      })(),
    ])
      expect(() => run(bad)).toThrow('synthetic_browser_sp_configuration_invalid');
  });
});
