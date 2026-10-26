import {
  selectedSyntheticDynamoState,
  type SyntheticAuthStateSelection,
} from '../rehearsal/selected-auth-state';
import { readSyntheticDynamoAuthStateSnapshot } from './selected-auth-state-snapshot';
import type { AwsTenantRuntime } from '../http-runtime';
import {
  runSyntheticSamlLoginProbe,
  type SyntheticSamlLoginProbeConfig,
  type SyntheticSamlLoginProbeReport,
} from '../rehearsal/saml-login-probe';
import {
  assertMaintenanceTls,
  createMaintenanceSqlClient,
  DATABASE_FAMILIES,
  type DatabaseFamily,
  type MaintenanceDatabase,
  type MaintenanceSqlClient,
  type MaintenanceSqlFactory,
} from './database';

const TENANT = 'tenant-a';
const ISSUER = 'https://tenant-a.example.test';
const SP = 'https://sp.example.test/entity';
const USER = 'user-tenant-a';
const MAX_COUNTER = 0xffffffff;

export interface SyntheticAwsAuthenticationRehearsalInput {
  load(this: void): Promise<{ runtime: AwsTenantRuntime; close(this: void): Promise<void> }>;
  databases: Record<DatabaseFamily, MaintenanceDatabase>;
  fixture: {
    manifest: { source: { tenantId: string; issuer: string } };
    environmentName: string;
    spEntityIds: readonly string[];
  };
  seed: unknown;
  authState?: SyntheticAuthStateSelection;
}

interface RehearsalDependencies {
  clientFactory?: MaintenanceSqlFactory;
  probe?: typeof runSyntheticSamlLoginProbe;
}

interface Snapshot {
  rowId: string;
  counter: number;
  sessions: number;
  completedAudits: number;
}

export interface SyntheticAwsAuthenticationRehearsalReport {
  syntheticOnly: true;
  passkeyCounter: { before: number; after: number };
  managedSessionCount: { before: number; after: number; created: 2 };
  completedFlowAuditCount: { before: number; after: number; created: 2 };
  runtimeReloads: 2;
  readyAfterReload: true;
  flows: SyntheticSamlLoginProbeReport[];
}

function check(value: unknown): asserts value {
  if (!value) throw new Error('aws_synthetic_authentication_rehearsal_invalid');
}

function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  check(typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value));
  const parsed = Number(value);
  check(Number.isSafeInteger(parsed) && parsed <= maximum);
  return parsed;
}

/** All identity and destination checks run before opening a database or loading the runtime. */
function parseProbe(
  input: SyntheticAwsAuthenticationRehearsalInput
): SyntheticSamlLoginProbeConfig {
  const seed = object(input.seed);
  const probe = object(seed.samlLoginProbe);
  const credential = object(probe.credential);
  const key = object(credential.privateJwk);
  check(
    probe.syntheticOnly === true &&
      probe.tenantId === TENANT &&
      probe.issuer === ISSUER &&
      probe.spEntityId === SP &&
      probe.userId === USER &&
      input.fixture.environmentName === 'aws-synthetic-rehearsal' &&
      input.fixture.manifest.source.tenantId === TENANT &&
      input.fixture.manifest.source.issuer === ISSUER &&
      input.fixture.spEntityIds.length === 1 &&
      input.fixture.spEntityIds[0] === SP &&
      typeof credential.id === 'string' &&
      /^[A-Za-z0-9_-]{43}$/u.test(credential.id) &&
      typeof probe.expectedCertificateDerSha256 === 'string' &&
      /^[a-f0-9]{64}$/u.test(probe.expectedCertificateDerSha256) &&
      key.kty === 'EC' &&
      key.crv === 'P-256'
  );
  for (const part of ['x', 'y', 'd']) {
    check(typeof key[part] === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(key[part]));
  }
  // Older fixture seed fields remain intact; if present, the added probe must agree with them.
  if (seed.softwarePasskeyCredentialId !== undefined)
    check(seed.softwarePasskeyCredentialId === credential.id);
  if (seed.softwarePasskeyPrivateJwk !== undefined) {
    const original = object(seed.softwarePasskeyPrivateJwk);
    for (const part of ['kty', 'crv', 'x', 'y', 'd']) check(original[part] === key[part]);
  }
  for (const family of DATABASE_FAMILIES) {
    const expected = `authrim_dr_rehearsal_${family}`;
    const database = input.databases[family];
    check(database.name === expected && database.user === expected);
    const url = new URL(database.connectionString);
    check(
      url.protocol === 'postgresql:' &&
        decodeURIComponent(url.pathname) === `/${expected}` &&
        decodeURIComponent(url.username) === expected &&
        url.searchParams.get('sslmode') === 'verify-full'
    );
  }
  return {
    tenantId: TENANT,
    issuer: ISSUER,
    spEntityId: SP,
    userId: USER,
    credential: {
      id: credential.id,
      privateJwk: {
        kty: 'EC',
        crv: 'P-256',
        x: key.x as string,
        y: key.y as string,
        d: key.d as string,
        key_ops: ['sign'],
        ext: true,
      },
    },
    expectedCertificateDerSha256: probe.expectedCertificateDerSha256,
  };
}

async function readOnly<T>(
  database: MaintenanceDatabase,
  factory: MaintenanceSqlFactory,
  read: (client: MaintenanceSqlClient) => Promise<T>
): Promise<T> {
  const client = factory(database.connectionString);
  try {
    await client.connect();
    await assertMaintenanceTls(client);
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const identity = await client.query<{ database: string; username: string }>(
      'SELECT current_database() AS database, current_user AS username'
    );
    check(
      identity.rows.length === 1 &&
        identity.rows[0].database === database.name &&
        identity.rows[0].username === database.user
    );
    const result = await read(client);
    await client.query('COMMIT');
    return result;
  } finally {
    // Disconnect also rolls back a failed read-only transaction.
    await client.end();
  }
}

async function snapshot(
  input: SyntheticAwsAuthenticationRehearsalInput,
  probe: SyntheticSamlLoginProbeConfig,
  factory: MaintenanceSqlFactory
): Promise<Snapshot> {
  const core = await readOnly(input.databases.core, factory, async (client) => {
    const passkeys = await client.query<{ id: string; counter: string }>(
      `SELECT id, counter::text AS counter FROM passkeys
        WHERE tenant_id=$1 AND user_id=$2 AND credential_id=$3`,
      [TENANT, USER, probe.credential.id]
    );
    check(passkeys.rows.length === 1 && /^[A-Za-z0-9._:-]{1,200}$/u.test(passkeys.rows[0].id));
    const audits = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM flow_audit_events
        WHERE tenant_id=$1 AND user_id=$2 AND event_type='flow.interaction.completed'
          AND result='success'`,
      [TENANT, USER]
    );
    check(audits.rows.length === 1);
    return {
      rowId: passkeys.rows[0].id,
      counter: count(passkeys.rows[0].counter, MAX_COUNTER),
      completedAudits: count(audits.rows[0].count),
    };
  });
  const dynamo = selectedSyntheticDynamoState(input.authState);
  const state = dynamo
    ? await readSyntheticDynamoAuthStateSnapshot({ ...dynamo, passkeyRowId: core.rowId })
    : await readOnly(input.databases.state, factory, async (client) => {
        const counters = await client.query<{ counter: string }>(
          `SELECT counter::text AS counter FROM authrim_aws_passkey_counters
        WHERE tenant_id=$1 AND user_id=$2 AND credential_id=$3`,
          [TENANT, USER, core.rowId]
        );
        check(counters.rows.length === 1);
        const sessions = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM authrim_aws_transient_state
        WHERE tenant_id=$1 AND kind='session' AND payload->>'userId'=$2`,
          [TENANT, USER]
        );
        check(sessions.rows.length === 1);
        return {
          counter: count(counters.rows[0].counter, MAX_COUNTER),
          sessions: count(sessions.rows[0].count),
        };
      });
  check(core.counter === state.counter);
  return { ...core, sessions: state.sessions };
}

function assertProgress(before: Snapshot, after: Snapshot, increments: number): void {
  check(
    after.rowId === before.rowId &&
      after.counter === before.counter + increments &&
      after.sessions === before.sessions + increments &&
      after.completedAudits === before.completedAudits + increments
  );
}

function safeProof(result: SyntheticSamlLoginProbeReport): SyntheticSamlLoginProbeReport {
  const flags = [
    'metadataCertificatePinned',
    'signatureVerified',
    'issuerVerified',
    'audienceVerified',
    'acsVerified',
    'inResponseToVerified',
    'nameIdVerified',
    'attributeVerified',
    'relayStateVerified',
    'badSignatureRejected',
    'badOriginRejected',
    'passkeyReplayRejected',
    'samlReplayRejected',
    'replayRejected',
  ] as const;
  for (const flag of flags) check(result[flag] === true);
  return {
    counter: result.counter,
    certificateDerSha256: result.certificateDerSha256,
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

/**
 * Exercises the restored synthetic tenant through real authentication handlers. Only the probe
 * writes state; observations use TLS and read-only transactions. Nothing is reset or reimported.
 */
export async function runSyntheticAwsAuthenticationRehearsal(
  input: SyntheticAwsAuthenticationRehearsalInput,
  dependencies: RehearsalDependencies = {}
): Promise<SyntheticAwsAuthenticationRehearsalReport> {
  let stage = 'configuration';
  try {
    const probe = parseProbe(input);
    selectedSyntheticDynamoState(input.authState);
    const factory = dependencies.clientFactory ?? createMaintenanceSqlClient;
    const runProbe = dependencies.probe ?? runSyntheticSamlLoginProbe;
    stage = 'snapshot_before';
    const before = await snapshot(input, probe, factory);
    stage = 'counter_capacity';
    check(before.counter <= MAX_COUNTER - 2);
    const flows: SyntheticSamlLoginProbeReport[] = [];
    let after = before;
    for (let index = 1; index <= 2; index += 1) {
      stage = `load_${index}`;
      const loaded = await input.load();
      try {
        stage = `ready_${index}`;
        check(loaded.runtime.tenantId === TENANT && loaded.runtime.origin === ISSUER);
        await loaded.runtime.assertReady();
        stage = `probe_${index}`;
        const result = await runProbe({
          runtime: loaded.runtime,
          probe,
          counter: before.counter + index,
        });
        check(
          result.counter === before.counter + index &&
            result.certificateDerSha256 === probe.expectedCertificateDerSha256
        );
        flows.push(safeProof(result));
        stage = `snapshot_${index}`;
        after = await snapshot(input, probe, factory);
        stage = `progress_${index}`;
        assertProgress(before, after, index);
      } finally {
        await loaded.close();
      }
    }
    stage = 'load_final';
    const reloaded = await input.load();
    try {
      stage = 'ready_final';
      check(reloaded.runtime.tenantId === TENANT && reloaded.runtime.origin === ISSUER);
      await reloaded.runtime.assertReady();
      stage = 'snapshot_final';
      const persisted = await snapshot(input, probe, factory);
      stage = 'progress_final';
      assertProgress(after, persisted, 0);
    } finally {
      await reloaded.close();
    }
    return {
      syntheticOnly: true,
      passkeyCounter: { before: before.counter, after: after.counter },
      managedSessionCount: { before: before.sessions, after: after.sessions, created: 2 },
      completedFlowAuditCount: {
        before: before.completedAudits,
        after: after.completedAudits,
        created: 2,
      },
      runtimeReloads: 2,
      readyAfterReload: true,
      flows,
    };
  } catch (error) {
    // Never return driver errors, source rows, cookies, assertions, or fixture private keys.
    const probeStages = new Set([
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
    ]);
    const helperStage =
      error instanceof Error ? error.message.replace(/^aws_synthetic_saml_probe_failed:/u, '') : '';
    if (
      (stage === 'probe_1' || stage === 'probe_2') &&
      error instanceof Error &&
      error.message.startsWith('aws_synthetic_saml_probe_failed:') &&
      probeStages.has(helperStage)
    )
      stage = `${stage}:${helperStage}`;
    throw new Error(`aws_synthetic_authentication_rehearsal_failed:${stage}`);
  }
}
