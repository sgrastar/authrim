/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/only-throw-error */
import { describe, expect, it, vi } from 'vitest';
import type { AwsTenantRuntime } from '../http-runtime';
import type { SyntheticSamlLoginProbeReport } from '../rehearsal/saml-login-probe';

vi.mock('./selected-auth-state-snapshot', () => ({
  readSyntheticDynamoAuthStateSnapshot: vi.fn(),
}));

import { readSyntheticDynamoAuthStateSnapshot } from './selected-auth-state-snapshot';
import {
  runSyntheticAwsAuthenticationRehearsal,
  type SyntheticAwsAuthenticationRehearsalInput,
} from './authentication-rehearsal';
import { DATABASE_FAMILIES, type MaintenanceSqlClient } from './database';

type Input = SyntheticAwsAuthenticationRehearsalInput;
const CERTIFICATE = 'a'.repeat(64);
const CREDENTIAL = 'c'.repeat(43);
const KEY = { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43), d: 'd'.repeat(43) };
const PREFIX = 'aws_synthetic_authentication_rehearsal_failed';
const PROBE_STAGES = [
  'configuration',
  'metadata_certificate',
  'saml_request',
  'interaction_start',
  'bad-origin',
  'bad-signature',
  'passkey_login',
  'passkey_replay',
  'session',
  'interaction_complete',
  'saml_response',
  'signed_claims',
  'saml_replay',
];

function seed(): Record<string, unknown> {
  return {
    softwarePasskeyCredentialId: CREDENTIAL,
    softwarePasskeyPrivateJwk: { ...KEY },
    samlLoginProbe: {
      syntheticOnly: true,
      tenantId: 'tenant-a',
      issuer: 'https://tenant-a.example.test',
      spEntityId: 'https://sp.example.test/entity',
      userId: 'user-tenant-a',
      credential: { id: CREDENTIAL, privateJwk: { ...KEY } },
      expectedCertificateDerSha256: CERTIFICATE,
    },
  };
}
const probeOf = (value: Record<string, unknown>) =>
  value.samlLoginProbe as Record<string, unknown> & {
    credential: { id: unknown; privateJwk: Record<string, unknown> };
  };

function proof(counter: number): SyntheticSamlLoginProbeReport {
  return {
    counter,
    certificateDerSha256: CERTIFICATE,
    metadataCertificatePinned: true,
    signatureVerified: true,
    issuerVerified: true,
    audienceVerified: true,
    acsVerified: true,
    inResponseToVerified: true,
    nameIdVerified: true,
    attributeVerified: true,
    relayStateVerified: true,
    badSignatureRejected: true,
    badOriginRejected: true,
    passkeyReplayRejected: true,
    samlReplayRejected: true,
    replayRejected: true,
  };
}

interface State {
  coreCounter: string;
  authorityCounter: string;
  sessions: number;
  audits: number;
  tls: boolean;
  rowId: string;
}
interface Hooks {
  afterProbe?: (index: number, state: State) => void;
  onLoad?: (
    index: number,
    state: State
  ) => Partial<{
    tenantId: string;
    origin: string;
    assertReady: () => Promise<void>;
    fail: boolean;
  }> | void;
  override?: (sql: string, values: unknown[] | undefined) => object[] | undefined;
}
function world(
  initial: Partial<Record<string, string | number | boolean>> = {},
  hooks: Hooks = {}
) {
  const state = {
    coreCounter: '7',
    authorityCounter: '7',
    sessions: 3,
    audits: 4,
    tls: true,
    rowId: 'passkey-a',
    ...initial,
  } as State;
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const clients: MaintenanceSqlClient[] = [];
  const clientFactory = vi.fn((url: string): MaintenanceSqlClient => {
    const name = new URL(url).pathname.slice(1);
    const client: MaintenanceSqlClient = {
      connect: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        let rows: object[] = [];
        const custom = hooks.override?.(sql, values);
        if (custom) rows = custom;
        else if (sql.includes('FROM pg_stat_ssl')) rows = [{ ssl: state.tls }];
        else if (sql.includes('current_database()')) rows = [{ database: name, username: name }];
        else if (sql.includes('FROM passkeys'))
          rows = [{ id: state.rowId, counter: state.coreCounter }];
        else if (sql.includes('FROM flow_audit_events')) rows = [{ count: String(state.audits) }];
        else if (sql.includes('FROM authrim_aws_passkey_counters'))
          rows = [{ counter: state.authorityCounter }];
        else if (sql.includes('FROM authrim_aws_transient_state'))
          rows = [{ count: String(state.sessions) }];
        return { rows, rowCount: rows.length };
      }) as MaintenanceSqlClient['query'],
    };
    clients.push(client);
    return client;
  });
  let probeCalls = 0;
  const probe = vi.fn(async ({ counter }: { counter: number }) => {
    probeCalls += 1;
    state.coreCounter = String(counter);
    state.authorityCounter = String(counter);
    state.sessions += 1;
    state.audits += 1;
    hooks.afterProbe?.(probeCalls, state);
    return proof(counter);
  });
  return { state, queries, clients, clientFactory, probe };
}
type World = ReturnType<typeof world>;

function request(hooks: Hooks = {}, getState: () => State = () => world().state) {
  let loads = 0;
  const closes: Array<ReturnType<typeof vi.fn>> = [];
  const runtimes: Array<{ assertReady: ReturnType<typeof vi.fn> }> = [];
  const value: Input = {
    databases: Object.fromEntries(
      DATABASE_FAMILIES.map((family) => {
        const name = `authrim_dr_rehearsal_${family}`;
        return [
          family,
          {
            name,
            user: name,
            password: 'private-password',
            connectionString: `postgresql://${name}:private-password@db.example/${name}?sslmode=verify-full`,
          },
        ];
      })
    ) as Input['databases'],
    fixture: {
      manifest: { source: { tenantId: 'tenant-a', issuer: 'https://tenant-a.example.test' } },
      environmentName: 'aws-synthetic-rehearsal',
      spEntityIds: ['https://sp.example.test/entity'],
    },
    seed: seed(),
    load: vi.fn(async () => {
      loads += 1;
      const change = hooks.onLoad?.(loads, getState()) ?? {};
      if (change.fail) throw new Error('private load failure');
      const assertReady = vi.fn(change.assertReady ?? (async () => undefined));
      runtimes.push({ assertReady });
      const close = vi.fn(async () => undefined);
      closes.push(close);
      return {
        runtime: {
          tenantId: change.tenantId ?? 'tenant-a',
          origin: change.origin ?? 'https://tenant-a.example.test',
          env: {},
          assertReady,
        } as unknown as AwsTenantRuntime,
        close,
      };
    }),
  };
  return { value, closes, runtimes };
}

async function stageOf(
  stage: string,
  options: {
    mutate?: (value: Input) => void;
    state?: Partial<Record<string, string | number | boolean>>;
    hooks?: Hooks;
    probe?: (w: World) => (args: { counter: number }) => Promise<SyntheticSamlLoginProbeReport>;
  } = {}
) {
  const hooks = options.hooks ?? {};
  const holder: { w?: World } = {};
  const req = request(hooks, () => (holder.w as World).state);
  options.mutate?.(req.value);
  const w = world(options.state, hooks);
  holder.w = w;
  const probe = options.probe ? vi.fn(options.probe(w)) : w.probe;
  await expect(
    runSyntheticAwsAuthenticationRehearsal(req.value, { clientFactory: w.clientFactory, probe })
  ).rejects.toMatchObject({ message: `${PREFIX}:${stage}` });
  return { req, w };
}

describe('probe configuration validation', () => {
  const cases: Array<[string, (value: Input) => void]> = [
    ['seed null', (v) => void (v.seed = null)],
    ['seed string', (v) => void (v.seed = 'text')],
    ['seed array carrying a valid probe', (v) => void (v.seed = Object.assign([], seed()))],
    [
      'probe array carrying valid fields',
      (v) => void (v.seed = { samlLoginProbe: Object.assign([], probeOf(seed())) }),
    ],
    [
      'credential array carrying valid fields',
      (v) => {
        const s = seed();
        probeOf(s).credential = Object.assign([], probeOf(s).credential);
        v.seed = s;
      },
    ],
    [
      'private key array carrying valid fields',
      (v) => {
        const s = seed();
        probeOf(s).credential.privateJwk = Object.assign([], KEY) as never;
        v.seed = s;
      },
    ],
    ['probe missing', (v) => void (v.seed = {})],
    ['probe null', (v) => void (v.seed = { samlLoginProbe: null })],
    ['syntheticOnly false', (v) => void (probeOf(v.seed as never).syntheticOnly = false)],
    ['syntheticOnly truthy string', (v) => void (probeOf(v.seed as never).syntheticOnly = 'true')],
    ['tenant', (v) => void (probeOf(v.seed as never).tenantId = 'tenant-b')],
    ['issuer', (v) => void (probeOf(v.seed as never).issuer = 'https://other.example.test')],
    [
      'sp entity',
      (v) => void (probeOf(v.seed as never).spEntityId = 'https://sp.example.test/other'),
    ],
    ['user', (v) => void (probeOf(v.seed as never).userId = 'someone')],
    ['environment', (v) => void (v.fixture.environmentName = 'aws-browser-rehearsal')],
    ['source tenant', (v) => void (v.fixture.manifest.source.tenantId = 'tenant-b')],
    [
      'source issuer',
      (v) => void (v.fixture.manifest.source.issuer = 'https://other.example.test'),
    ],
    ['no SP', (v) => void (v.fixture.spEntityIds = [])],
    [
      'two SPs',
      (v) =>
        void (v.fixture.spEntityIds = [
          'https://sp.example.test/entity',
          'https://sp.example.test/x',
        ]),
    ],
    ['other SP', (v) => void (v.fixture.spEntityIds = ['https://sp.example.test/other'])],
    ['credential id number', (v) => void (probeOf(v.seed as never).credential.id = 5)],
    ['credential id short', (v) => void (probeOf(v.seed as never).credential.id = 'c'.repeat(42))],
    ['credential id long', (v) => void (probeOf(v.seed as never).credential.id = 'c'.repeat(44))],
    [
      'credential id prefixed',
      (v) => void (probeOf(v.seed as never).credential.id = `!${CREDENTIAL}`),
    ],
    [
      'credential id suffixed',
      (v) => void (probeOf(v.seed as never).credential.id = `${CREDENTIAL}!`),
    ],
    ['certificate number', (v) => void (probeOf(v.seed as never).expectedCertificateDerSha256 = 1)],
    [
      'certificate short',
      (v) => void (probeOf(v.seed as never).expectedCertificateDerSha256 = 'a'.repeat(63)),
    ],
    [
      'certificate long',
      (v) => void (probeOf(v.seed as never).expectedCertificateDerSha256 = 'a'.repeat(65)),
    ],
    [
      'certificate uppercase',
      (v) => void (probeOf(v.seed as never).expectedCertificateDerSha256 = 'A'.repeat(64)),
    ],
    [
      'certificate prefixed',
      (v) => void (probeOf(v.seed as never).expectedCertificateDerSha256 = `g${CERTIFICATE}`),
    ],
    [
      'certificate suffixed',
      (v) => void (probeOf(v.seed as never).expectedCertificateDerSha256 = `${CERTIFICATE}g`),
    ],
    ['key type', (v) => void (probeOf(v.seed as never).credential.privateJwk.kty = 'RSA')],
    ['key curve', (v) => void (probeOf(v.seed as never).credential.privateJwk.crv = 'P-384')],
    ...(['x', 'y', 'd'] as const).flatMap(
      (part): Array<[string, (v: Input) => void]> => [
        [
          `key ${part} number`,
          (v) => void (probeOf(v.seed as never).credential.privateJwk[part] = 1),
        ],
        [
          `key ${part} short`,
          (v) => void (probeOf(v.seed as never).credential.privateJwk[part] = 'k'.repeat(42)),
        ],
        [
          `key ${part} long`,
          (v) => void (probeOf(v.seed as never).credential.privateJwk[part] = 'k'.repeat(44)),
        ],
        [
          `key ${part} prefixed`,
          (v) => void (probeOf(v.seed as never).credential.privateJwk[part] = `!${'k'.repeat(43)}`),
        ],
        [
          `key ${part} suffixed`,
          (v) => void (probeOf(v.seed as never).credential.privateJwk[part] = `${'k'.repeat(43)}!`),
        ],
        [
          `original key ${part} differs`,
          (v) =>
            void ((
              v.seed as never as Record<string, Record<string, unknown>>
            ).softwarePasskeyPrivateJwk[part] = 'q'.repeat(43)),
        ],
      ]
    ),
    [
      'original key type differs',
      (v) =>
        void ((
          v.seed as never as Record<string, Record<string, unknown>>
        ).softwarePasskeyPrivateJwk.kty = 'OKP'),
    ],
    [
      'original key curve differs',
      (v) =>
        void ((
          v.seed as never as Record<string, Record<string, unknown>>
        ).softwarePasskeyPrivateJwk.crv = 'P-384'),
    ],
    [
      'original key not an object',
      (v) => void ((v.seed as Record<string, unknown>).softwarePasskeyPrivateJwk = 'text'),
    ],
    [
      'original credential id differs',
      (v) =>
        void ((v.seed as Record<string, unknown>).softwarePasskeyCredentialId = 'd'.repeat(43)),
    ],
    ...DATABASE_FAMILIES.flatMap(
      (family): Array<[string, (v: Input) => void]> => [
        [`${family} name`, (v) => void (v.databases[family].name = 'production')],
        [`${family} user`, (v) => void (v.databases[family].user = 'postgres')],
        [
          `${family} protocol`,
          (v) =>
            void (v.databases[family].connectionString = v.databases[
              family
            ].connectionString.replace('postgresql:', 'postgres:')),
        ],
        [
          `${family} path`,
          (v) =>
            void (v.databases[family].connectionString = v.databases[
              family
            ].connectionString.replace(`/authrim_dr_rehearsal_${family}?`, '/other?')),
        ],
        [
          `${family} username`,
          (v) =>
            void (v.databases[family].connectionString = v.databases[
              family
            ].connectionString.replace(`//authrim_dr_rehearsal_${family}:`, '//other:')),
        ],
        [
          `${family} sslmode`,
          (v) =>
            void (v.databases[family].connectionString = v.databases[
              family
            ].connectionString.replace('verify-full', 'require')),
        ],
        [
          `${family} missing sslmode`,
          (v) =>
            void (v.databases[family].connectionString = v.databases[
              family
            ].connectionString.replace('?sslmode=verify-full', '')),
        ],
      ]
    ),
  ];
  it.each(cases)(
    'rejects %s in the configuration stage before any database or runtime use',
    async (_label, mutate) => {
      const { req, w } = await stageOf('configuration', { mutate });
      expect(w.clientFactory).not.toHaveBeenCalled();
      expect(req.value.load).not.toHaveBeenCalled();
      expect(w.probe).not.toHaveBeenCalled();
    }
  );
  it('accepts a seed that has no original passkey fields', async () => {
    const req = request();
    delete (req.value.seed as Record<string, unknown>).softwarePasskeyCredentialId;
    delete (req.value.seed as Record<string, unknown>).softwarePasskeyPrivateJwk;
    const w = world();
    await expect(
      runSyntheticAwsAuthenticationRehearsal(req.value, {
        clientFactory: w.clientFactory,
        probe: w.probe,
      })
    ).resolves.toMatchObject({ syntheticOnly: true });
  });
  it('rejects an invalid auth-state selection in the configuration stage', async () => {
    const { w } = await stageOf('configuration', {
      mutate: (v) => {
        v.authState = {
          config: { backend: 'postgresql' },
          receipt: { tenantId: 'tenant-a' },
        } as never;
      },
    });
    expect(w.clientFactory).not.toHaveBeenCalled();
  });
});

describe('probe request and report', () => {
  it('hands the runtime, the normalized probe configuration and the next counter to the probe', async () => {
    const req = request();
    const w = world();
    const report = await runSyntheticAwsAuthenticationRehearsal(req.value, {
      clientFactory: w.clientFactory,
      probe: w.probe,
    });
    expect(w.probe).toHaveBeenCalledTimes(2);
    const expectedProbe = {
      tenantId: 'tenant-a',
      issuer: 'https://tenant-a.example.test',
      spEntityId: 'https://sp.example.test/entity',
      userId: 'user-tenant-a',
      credential: {
        id: CREDENTIAL,
        privateJwk: { ...KEY, key_ops: ['sign'], ext: true },
      },
      expectedCertificateDerSha256: CERTIFICATE,
    };
    expect(w.probe.mock.calls[0][0]).toEqual({
      runtime: expect.objectContaining({ tenantId: 'tenant-a' }),
      probe: expectedProbe,
      counter: 8,
    });
    expect(w.probe.mock.calls[1][0]).toMatchObject({ probe: expectedProbe, counter: 9 });
    expect(report).toStrictEqual({
      syntheticOnly: true,
      passkeyCounter: { before: 7, after: 9 },
      managedSessionCount: { before: 3, after: 5, created: 2 },
      completedFlowAuditCount: { before: 4, after: 6, created: 2 },
      runtimeReloads: 2,
      readyAfterReload: true,
      flows: [proof(8), proof(9)],
    });
    for (const runtime of req.runtimes) expect(runtime.assertReady).toHaveBeenCalledOnce();
    expect(req.closes).toHaveLength(3);
    for (const close of req.closes) expect(close).toHaveBeenCalledOnce();
  });
  it('runs every observation in a read-only repeatable-read transaction and commits it', async () => {
    const req = request();
    const w = world({}, {});
    await runSyntheticAwsAuthenticationRehearsal(req.value, {
      clientFactory: w.clientFactory,
      probe: w.probe,
    });
    const sql = w.queries.map((query) => query.sql);
    expect(sql.filter((text) => text.startsWith('BEGIN'))).toEqual(
      Array(8).fill('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    );
    expect(sql.filter((text) => text === 'COMMIT')).toHaveLength(8);
    expect(w.queries.find((query) => query.sql.includes('current_database()'))?.sql).toBe(
      'SELECT current_database() AS database, current_user AS username'
    );
    const audits = w.queries.find((query) => query.sql.includes('FROM flow_audit_events'));
    expect(audits?.values).toEqual(['tenant-a', 'user-tenant-a']);
    const sessions = w.queries.find((query) =>
      query.sql.includes('FROM authrim_aws_transient_state')
    );
    expect(sessions?.values).toEqual(['tenant-a', 'user-tenant-a']);
  });
  it('accepts multi-digit counters and the largest counter that still allows two logins', async () => {
    const req = request();
    const w = world({
      coreCounter: '4294967293',
      authorityCounter: '4294967293',
      sessions: 30,
      audits: 12,
    });
    const report = await runSyntheticAwsAuthenticationRehearsal(req.value, {
      clientFactory: w.clientFactory,
      probe: w.probe,
    });
    expect(report.passkeyCounter).toEqual({ before: 4294967293, after: 4294967295 });
    expect(report.managedSessionCount.before).toBe(30);
    expect(report.completedFlowAuditCount.before).toBe(12);
  });
  it('reads the Dynamo selected authority through the Core row id and never the SQL mirror', async () => {
    const config = {
      backend: 'dynamodb',
      region: 'ap-northeast-1',
      tableArn: 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/test-auth-state',
      namespace: '00000000-0000-4000-8000-000000000000',
    };
    const selectedReceipt = {
      tenantId: 'tenant-a',
      source: { tenantId: 'tenant-a', issuer: 'https://tenant-a.example.test' },
      authState: config,
    };
    const req = request();
    req.value.authState = { config, receipt: selectedReceipt } as never;
    const w = world();
    vi.mocked(readSyntheticDynamoAuthStateSnapshot).mockReset();
    vi.mocked(readSyntheticDynamoAuthStateSnapshot).mockImplementation(async () => ({
      counter: Number(w.state.coreCounter),
      sessions: w.state.sessions,
      outstanding: 0,
      consumed: 0,
    }));
    const report = await runSyntheticAwsAuthenticationRehearsal(req.value, {
      clientFactory: w.clientFactory,
      probe: w.probe,
    });
    expect(report.managedSessionCount).toEqual({ before: 3, after: 5, created: 2 });
    expect(vi.mocked(readSyntheticDynamoAuthStateSnapshot)).toHaveBeenCalledTimes(4);
    expect(vi.mocked(readSyntheticDynamoAuthStateSnapshot).mock.calls[0][0]).toEqual({
      target: config,
      receipt: selectedReceipt,
      passkeyRowId: 'passkey-a',
    });
    expect(w.queries.some((query) => query.sql.includes('authrim_aws_'))).toBe(false);
    expect(w.clientFactory).toHaveBeenCalledTimes(4);
  });
});

describe('stage reporting', () => {
  it('reports snapshot_before for a plaintext connection and releases the clients', async () => {
    const { w } = await stageOf('snapshot_before', { state: { tls: false } });
    for (const client of w.clients) expect(client.end).toHaveBeenCalledOnce();
  });
  it.each([
    [
      'database mismatch',
      (sql: string) =>
        sql.includes('current_database()')
          ? [{ database: 'production', username: 'authrim_dr_rehearsal_core' }]
          : undefined,
    ],
    [
      'user mismatch',
      (sql: string) =>
        sql.includes('current_database()')
          ? [{ database: 'authrim_dr_rehearsal_core', username: 'postgres' }]
          : undefined,
    ],
    [
      'two identities',
      (sql: string) =>
        sql.includes('current_database()')
          ? [
              { database: 'authrim_dr_rehearsal_core', username: 'authrim_dr_rehearsal_core' },
              { database: 'authrim_dr_rehearsal_core', username: 'authrim_dr_rehearsal_core' },
            ]
          : undefined,
    ],
    [
      'two passkey rows',
      (sql: string) =>
        sql.includes('FROM passkeys')
          ? [
              { id: 'a', counter: '7' },
              { id: 'a', counter: '7' },
            ]
          : undefined,
    ],
    [
      'passkey id with space',
      (sql: string) => (sql.includes('FROM passkeys') ? [{ id: 'a b', counter: '7' }] : undefined),
    ],
    [
      'overlong passkey id',
      (sql: string) =>
        sql.includes('FROM passkeys') ? [{ id: 'a'.repeat(201), counter: '7' }] : undefined,
    ],
    [
      'two audit rows',
      (sql: string) =>
        sql.includes('flow_audit_events') ? [{ count: '4' }, { count: '4' }] : undefined,
    ],
    [
      'two authority rows',
      (sql: string) =>
        sql.includes('authrim_aws_passkey_counters')
          ? [{ counter: '7' }, { counter: '7' }]
          : undefined,
    ],
    [
      'two session rows',
      (sql: string) =>
        sql.includes('authrim_aws_transient_state') ? [{ count: '3' }, { count: '3' }] : undefined,
    ],
    [
      'unsafe audit count',
      (sql: string) =>
        sql.includes('flow_audit_events') ? [{ count: '9007199254740993' }] : undefined,
    ],
    [
      'leading zero session count',
      (sql: string) =>
        sql.includes('authrim_aws_transient_state') ? [{ count: '03' }] : undefined,
    ],
    [
      'numeric session count',
      (sql: string) => (sql.includes('authrim_aws_transient_state') ? [{ count: 3 }] : undefined),
    ],
  ])('rejects %s while taking the first snapshot', async (_label, override) => {
    await stageOf('snapshot_before', { hooks: { override: (sql) => override(sql) } });
  });
  it('rejects a Core counter that is already at the maximum in the capacity stage', async () => {
    const { req } = await stageOf('counter_capacity', {
      state: { coreCounter: '4294967295', authorityCounter: '4294967295' },
    });
    expect(req.value.load).not.toHaveBeenCalled();
  });
  it('rejects a counter without room for two logins in the capacity stage', async () => {
    await stageOf('counter_capacity', {
      state: { coreCounter: '4294967294', authorityCounter: '4294967294' },
    });
  });
  it.each([1, 2, 3])('reports load failure of runtime load %i', async (index) => {
    const stage = index === 3 ? 'load_final' : `load_${index}`;
    await stageOf(stage, { hooks: { onLoad: (n) => (n === index ? { fail: true } : undefined) } });
  });
  it.each([
    [1, 'ready_1'],
    [2, 'ready_2'],
    [3, 'ready_final'],
  ])('reports readiness failures of runtime load %i as %s', async (index, stage) => {
    for (const change of [
      { tenantId: 'tenant-b' },
      { origin: 'https://other.example.test' },
      {
        assertReady: async () => {
          throw new Error('not ready');
        },
      },
    ]) {
      const { req } = await stageOf(stage, {
        hooks: { onLoad: (n) => (n === index ? change : undefined) },
      });
      expect(req.closes[index - 1]).toHaveBeenCalledOnce();
    }
  });
  it.each([
    ['counter', (index: number) => proof(index + 100)],
    [
      'certificate',
      (index: number) => ({ ...proof(7 + index), certificateDerSha256: 'b'.repeat(64) }),
    ],
    ['proof flag', (index: number) => ({ ...proof(7 + index), replayRejected: false })],
  ])('rejects a probe result with a bad %s in the probe stage', async (_label, result) => {
    for (const index of [1, 2]) {
      let calls = 0;
      const { req } = await stageOf(`probe_${index}`, {
        probe: (w) => async (args) => {
          calls += 1;
          if (calls === index) return result(index) as SyntheticSamlLoginProbeReport;
          return w.probe(args);
        },
      });
      expect(req.closes[index - 1]).toHaveBeenCalledOnce();
    }
  });
  it.each(PROBE_STAGES)('annotates the sanitized probe stage %s', async (helper) => {
    for (const index of [1, 2]) {
      let calls = 0;
      await stageOf(`probe_${index}:${helper}`, {
        probe: (w) => async (args) => {
          calls += 1;
          if (calls === index) throw new Error(`aws_synthetic_saml_probe_failed:${helper}`);
          return w.probe(args);
        },
      });
    }
  });
  it.each([
    ['an unknown probe stage', new Error('aws_synthetic_saml_probe_failed:private_secret')],
    ['a bare stage name without the helper prefix', new Error('signed_claims')],
    ['a prefixed message', new Error('note aws_synthetic_saml_probe_failed:signed_claims')],
    ['a non-error value', 'aws_synthetic_saml_probe_failed:signed_claims'],
  ])('does not annotate %s', async (_label, thrown) => {
    await stageOf('probe_1', {
      probe: () => async () => {
        throw thrown;
      },
    });
  });
  it('never appends the helper stage to a failure outside the probe stage', async () => {
    await stageOf('ready_1', {
      hooks: {
        onLoad: (n) =>
          n === 1
            ? {
                assertReady: async () => {
                  throw new Error('aws_synthetic_saml_probe_failed:signed_claims');
                },
              }
            : undefined,
      },
    });
  });
  it('reports snapshot failures after each probe', async () => {
    for (const index of [1, 2])
      await stageOf(`snapshot_${index}`, {
        hooks: { afterProbe: (n, state) => void (n === index && (state.tls = false)) },
      });
  });
  it('reports the final snapshot stage when the persisted state cannot be read', async () => {
    await stageOf('snapshot_final', {
      hooks: { onLoad: (n, state) => void (n === 3 && (state.tls = false)) },
    });
  });
});

describe('progress verification', () => {
  type Change = (state: State) => void;
  const changes: Array<[string, Change]> = [
    ['row id', (state) => void (state.rowId = 'passkey-b')],
    [
      'counter',
      (state) => {
        state.coreCounter = String(Number(state.coreCounter) + 1);
        state.authorityCounter = state.coreCounter;
      },
    ],
    ['sessions', (state) => void (state.sessions += 1)],
    ['audits', (state) => void (state.audits += 1)],
  ];
  it.each(changes)('detects a wrong %s after each probe', async (_label, change) => {
    for (const index of [1, 2]) {
      const req = request();
      const hooks: Hooks = {
        afterProbe: (n, state) => {
          if (n === index) change(state);
        },
      };
      const w = world({}, hooks);
      await expect(
        runSyntheticAwsAuthenticationRehearsal(req.value, {
          clientFactory: w.clientFactory,
          probe: w.probe,
        })
      ).rejects.toThrow(new RegExp(`^${PREFIX}:progress_${index}$`, 'u'));
      expect(req.closes[index - 1]).toHaveBeenCalledOnce();
    }
  });
  it.each(changes)('detects %s drift after the final reload', async (_label, change) => {
    const holder: { w?: World } = {};
    const req = request(
      {
        onLoad: (n, state) => {
          if (n === 3) change(state);
        },
      },
      () => (holder.w as World).state
    );
    const w = world();
    holder.w = w;
    await expect(
      runSyntheticAwsAuthenticationRehearsal(req.value, {
        clientFactory: w.clientFactory,
        probe: w.probe,
      })
    ).rejects.toThrow(new RegExp(`^${PREFIX}:progress_final$`, 'u'));
    expect(req.closes[2]).toHaveBeenCalledOnce();
  });
});
