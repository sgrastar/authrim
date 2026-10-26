import { describe, expect, it, vi } from 'vitest';
import type { AwsTenantRuntime } from '../http-runtime';
import type { SyntheticSamlLoginProbeReport } from '../rehearsal/saml-login-probe';
import {
  runSyntheticAwsAuthenticationRehearsal,
  type SyntheticAwsAuthenticationRehearsalInput,
} from './authentication-rehearsal';
import { DATABASE_FAMILIES, type MaintenanceSqlClient } from './database';

const CERTIFICATE = 'a'.repeat(64);
const CREDENTIAL = 'c'.repeat(43);
const PRIVATE_KEY = {
  kty: 'EC',
  crv: 'P-256',
  x: 'x'.repeat(43),
  y: 'y'.repeat(43),
  d: 'd'.repeat(43),
};

function input(): SyntheticAwsAuthenticationRehearsalInput {
  return {
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
    ) as SyntheticAwsAuthenticationRehearsalInput['databases'],
    fixture: {
      manifest: { source: { tenantId: 'tenant-a', issuer: 'https://tenant-a.example.test' } },
      environmentName: 'aws-synthetic-rehearsal',
      spEntityIds: ['https://sp.example.test/entity'],
    },
    seed: {
      backupPassphrase: 'private-backup-password',
      softwarePasskeyCredentialId: CREDENTIAL,
      softwarePasskeyPrivateJwk: PRIVATE_KEY,
      samlLoginProbe: {
        syntheticOnly: true,
        tenantId: 'tenant-a',
        issuer: 'https://tenant-a.example.test',
        spEntityId: 'https://sp.example.test/entity',
        userId: 'user-tenant-a',
        credential: { id: CREDENTIAL, privateJwk: PRIVATE_KEY },
        expectedCertificateDerSha256: CERTIFICATE,
      },
    },
    load: vi.fn(async () => ({
      runtime: {
        tenantId: 'tenant-a',
        origin: 'https://tenant-a.example.test',
        env: {},
        assertReady: vi.fn(async () => undefined),
      } as unknown as AwsTenantRuntime,
      close: vi.fn(async () => undefined),
    })),
  };
}

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

function world() {
  const state = {
    coreCounter: '7',
    authorityCounter: '7',
    sessions: 3,
    audits: 4,
    tls: true,
    rowId: 'passkey-a',
    missingAuthority: false,
  };
  const clients: MaintenanceSqlClient[] = [];
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const clientFactory = vi.fn((connectionString: string): MaintenanceSqlClient => {
    const name = new URL(connectionString).pathname.slice(1);
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      let rows: object[] = [];
      if (sql.includes('FROM pg_stat_ssl')) rows = [{ ssl: state.tls }];
      else if (sql.includes('current_database()')) rows = [{ database: name, username: name }];
      else if (sql.includes('FROM passkeys')) {
        expect(values).toEqual(['tenant-a', 'user-tenant-a', CREDENTIAL]);
        rows = [{ id: state.rowId, counter: state.coreCounter }];
      } else if (sql.includes('FROM flow_audit_events')) rows = [{ count: String(state.audits) }];
      else if (sql.includes('FROM authrim_aws_passkey_counters')) {
        // Durable authority is indexed by Core row ID, never the raw WebAuthn credential ID.
        expect(values).toEqual(['tenant-a', 'user-tenant-a', state.rowId]);
        rows = state.missingAuthority ? [] : [{ counter: state.authorityCounter }];
      } else if (sql.includes('FROM authrim_aws_transient_state'))
        rows = [{ count: String(state.sessions) }];
      return { rows, rowCount: rows.length };
    }) as MaintenanceSqlClient['query'];
    const client = {
      connect: vi.fn(async () => undefined),
      query,
      end: vi.fn(async () => undefined),
    };
    clients.push(client);
    return client;
  });
  const probe = vi.fn(async ({ counter }: { counter: number }) => {
    state.coreCounter = String(counter);
    state.authorityCounter = String(counter);
    state.sessions += 1;
    state.audits += 1;
    return proof(counter);
  });
  return { state, clients, queries, clientFactory, probe };
}

describe('isolated synthetic AWS authentication rehearsal', () => {
  it('authenticates twice across closed runtimes and confirms durable counters, sessions and audits', async () => {
    const request = input();
    const originalSeed = JSON.stringify(request.seed);
    const fake = world();
    const events: string[] = [];
    request.load = vi.fn(async () => {
      events.push('load');
      return {
        runtime: {
          tenantId: 'tenant-a',
          origin: 'https://tenant-a.example.test',
          env: {},
          assertReady: vi.fn(async () => {
            events.push('ready');
          }),
        } as unknown as AwsTenantRuntime,
        close: vi.fn(async () => {
          events.push('close');
        }),
      };
    });
    const report = await runSyntheticAwsAuthenticationRehearsal(request, fake);
    expect(report).toMatchObject({
      passkeyCounter: { before: 7, after: 9 },
      managedSessionCount: { before: 3, after: 5, created: 2 },
      completedFlowAuditCount: { before: 4, after: 6, created: 2 },
      runtimeReloads: 2,
      readyAfterReload: true,
    });
    expect(report.flows).toEqual([proof(8), proof(9)]);
    expect(events).toEqual([
      'load',
      'ready',
      'close',
      'load',
      'ready',
      'close',
      'load',
      'ready',
      'close',
    ]);
    expect(JSON.stringify(request.seed)).toBe(originalSeed);
    expect(JSON.stringify(report)).not.toMatch(
      /private-password|private-backup-password|credential/
    );
    expect(fake.queries.filter(({ sql }) => sql.startsWith('BEGIN'))).toHaveLength(8);
    for (const query of fake.queries)
      expect(query.sql).not.toMatch(/INSERT|UPDATE|DELETE|DROP|TRUNCATE/u);
    for (const client of fake.clients) expect(client.end).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'non-synthetic environment',
      (value: ReturnType<typeof input>) => {
        value.fixture.environmentName = 'production';
      },
    ],
    [
      'wrong source tenant',
      (value: ReturnType<typeof input>) => {
        value.fixture.manifest.source.tenantId = 'real-customer';
      },
    ],
    [
      'extra SP',
      (value: ReturnType<typeof input>) => {
        value.fixture.spEntityIds = [...value.fixture.spEntityIds, 'https://real.example/sp'];
      },
    ],
    [
      'production database',
      (value: ReturnType<typeof input>) => {
        value.databases.core.name = 'production_core';
      },
    ],
    [
      'different URI database',
      (value: ReturnType<typeof input>) => {
        value.databases.core.connectionString = value.databases.core.connectionString.replace(
          '/authrim_dr_rehearsal_core?',
          '/other?'
        );
      },
    ],
    [
      'unverified TLS',
      (value: ReturnType<typeof input>) => {
        value.databases.state.connectionString = value.databases.state.connectionString.replace(
          'verify-full',
          'require'
        );
      },
    ],
    [
      'missing probe',
      (value: ReturnType<typeof input>) => {
        value.seed = {};
      },
    ],
    [
      'wrong original credential',
      (value: ReturnType<typeof input>) => {
        (value.seed as Record<string, unknown>).softwarePasskeyCredentialId = 'different';
      },
    ],
  ])('rejects %s before opening a database or loading runtime', async (_label, mutate) => {
    const request = input();
    mutate(request);
    const fake = world();
    await expect(runSyntheticAwsAuthenticationRehearsal(request, fake)).rejects.toThrow(
      'aws_synthetic_authentication_rehearsal_failed'
    );
    expect(fake.clientFactory).not.toHaveBeenCalled();
    expect(request.load).not.toHaveBeenCalled();
    expect(fake.probe).not.toHaveBeenCalled();
  });

  it.each([
    ['counter disagreement', { authorityCounter: '8' }],
    ['overflow on second login', { coreCounter: '4294967294', authorityCounter: '4294967294' }],
    ['negative counter', { coreCounter: '-1', authorityCounter: '-1' }],
    ['malformed counter', { coreCounter: '1e2', authorityCounter: '1e2' }],
    ['missing authority record', { missingAuthority: true }],
    ['plaintext connection', { tls: false }],
  ])('rejects %s before authentication', async (_label, change) => {
    const request = input();
    const fake = world();
    Object.assign(fake.state, change);
    await expect(runSyntheticAwsAuthenticationRehearsal(request, fake)).rejects.toThrow(
      'aws_synthetic_authentication_rehearsal_failed'
    );
    expect(request.load).not.toHaveBeenCalled();
    expect(fake.probe).not.toHaveBeenCalled();
    for (const client of fake.clients) expect(client.end).toHaveBeenCalledOnce();
  });

  it.each(['coreCounter', 'sessions', 'audits'] as const)(
    'detects missing %s persistence and closes runtime',
    async (field) => {
      const request = input();
      const fake = world();
      const loaded = await request.load();
      request.load = vi.fn(async () => loaded);
      const goodProbe = fake.probe;
      const probe = vi.fn(async (args: { counter: number }) => {
        const before = fake.state[field];
        const result = await goodProbe(args);
        Object.assign(fake.state, { [field]: before });
        return result;
      });
      await expect(
        runSyntheticAwsAuthenticationRehearsal(request, { ...fake, probe })
      ).rejects.toThrow('aws_synthetic_authentication_rehearsal_failed');
      expect(loaded.close).toHaveBeenCalledOnce();
      expect(request.load).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ['private-key-cookie-assertion', 'probe_1'],
    ['aws_synthetic_saml_probe_failed:signed_claims', 'probe_1:signed_claims'],
    ['aws_synthetic_saml_probe_failed:private_secret', 'probe_1'],
  ])('redacts probe error %s while closing the loaded runtime', async (message, stage) => {
    const request = input();
    const loaded = await request.load();
    request.load = vi.fn(async () => loaded);
    const fake = world();
    const probe = vi.fn(async () => {
      throw new Error(message);
    });
    await expect(
      runSyntheticAwsAuthenticationRehearsal(request, { ...fake, probe })
    ).rejects.toThrow(`aws_synthetic_authentication_rehearsal_failed:${stage}`);
    expect(loaded.close).toHaveBeenCalledOnce();
  });

  it('returns only fixed proof fields even if a helper accidentally adds sensitive data', async () => {
    const fake = world();
    const probe = vi.fn(async (args: { counter: number }) => ({
      ...(await fake.probe(args)),
      privateCookie: 'sensitive-test-value',
    }));
    const report = await runSyntheticAwsAuthenticationRehearsal(input(), { ...fake, probe });
    expect(JSON.stringify(report)).not.toContain('sensitive-test-value');
  });

  it('rejects an incomplete verification proof', async () => {
    const fake = world();
    const probe = vi.fn(
      async (args: { counter: number }) =>
        ({
          ...(await fake.probe(args)),
          signatureVerified: false,
        }) as unknown as SyntheticSamlLoginProbeReport
    );
    await expect(
      runSyntheticAwsAuthenticationRehearsal(input(), { ...fake, probe })
    ).rejects.toThrow('aws_synthetic_authentication_rehearsal_failed:probe_1');
  });
});
