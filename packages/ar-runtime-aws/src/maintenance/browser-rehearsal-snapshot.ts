import {
  assertMaintenanceTls,
  createMaintenanceSqlClient,
  type MaintenanceDatabase,
  type MaintenanceSqlClient,
  type MaintenanceSqlFactory,
} from './database';

type BrowserTargets = Record<'core' | 'state', MaintenanceDatabase>;
export interface BrowserRehearsalSnapshot {
  corePasskeyCounter: number;
  statePasskeyCounter: number;
  managedSessionCount: number;
  completedFlowAuditCount: number;
  outstandingBrowserSpRequestCount: number;
  consumedBrowserSpRequestCount: number;
}
const TENANT = 'tenant-a';
const USER = 'user-tenant-a';

function check(value: unknown): asserts value {
  if (!value) throw new Error('browser_rehearsal_snapshot_invalid');
}

function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  check(typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value));
  const result = Number(value);
  check(Number.isSafeInteger(result) && result <= maximum);
  return result;
}

function validateTargets(targets: BrowserTargets): void {
  let host: string | undefined;
  for (const family of ['core', 'state'] as const) {
    const target = targets[family];
    const name = `authrim_dr_browser_${family}`;
    check(target.name === name && target.user === name);
    const url = new URL(target.connectionString);
    check(
      url.protocol === 'postgresql:' &&
        url.pathname === `/${name}` &&
        decodeURIComponent(url.username) === name &&
        url.password.length > 0 &&
        url.port === '5432' &&
        /^[a-z0-9.-]+\.rds\.amazonaws\.com$/u.test(url.hostname) &&
        !url.hash &&
        url.searchParams.get('sslmode') === 'verify-full' &&
        [...url.searchParams].length === 1 &&
        (host === undefined || host === url.hostname)
    );
    host = url.hostname;
  }
}

async function readOnly<T>(
  target: MaintenanceDatabase,
  factory: MaintenanceSqlFactory,
  read: (client: MaintenanceSqlClient) => Promise<T>
): Promise<T> {
  const client = factory(target.connectionString);
  try {
    await client.connect();
    await assertMaintenanceTls(client);
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const identity = await client.query<{ database: string; username: string }>(
      'SELECT current_database() AS database, current_user AS username'
    );
    check(
      identity.rows.length === 1 &&
        identity.rows[0].database === target.name &&
        identity.rows[0].username === target.user
    );
    const result = await read(client);
    await client.query('COMMIT');
    return result;
  } finally {
    await client.end();
  }
}

/** Observe only the fixed synthetic browser databases; no credential identifiers leave this helper. */
export async function readBrowserRehearsalSnapshot(
  targets: BrowserTargets,
  clientFactory: MaintenanceSqlFactory = createMaintenanceSqlClient
): Promise<BrowserRehearsalSnapshot> {
  try {
    validateTargets(targets);
    const core = await readOnly(targets.core, clientFactory, async (client) => {
      const passkey = await client.query<{ id: string; counter: string }>(
        `SELECT id, counter::text AS counter FROM passkeys WHERE tenant_id=$1 AND user_id=$2`,
        [TENANT, USER]
      );
      check(passkey.rows.length === 1 && /^[A-Za-z0-9._:-]{1,200}$/u.test(passkey.rows[0].id));
      const audits = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM flow_audit_events
          WHERE tenant_id=$1 AND user_id=$2 AND event_type='flow.interaction.completed'
            AND result='success'`,
        [TENANT, USER]
      );
      check(audits.rows.length === 1);
      return {
        rowId: passkey.rows[0].id,
        counter: count(passkey.rows[0].counter, 0xffffffff),
        audits: count(audits.rows[0].count),
      };
    });
    const state = await readOnly(targets.state, clientFactory, async (client) => {
      // The authority uses the Core row ID, not the WebAuthn credential ID.
      const passkey = await client.query<{ counter: string }>(
        `SELECT counter::text AS counter FROM authrim_aws_passkey_counters
          WHERE tenant_id=$1 AND user_id=$2 AND credential_id=$3`,
        [TENANT, USER, core.rowId]
      );
      check(passkey.rows.length === 1);
      const sessions = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM authrim_aws_transient_state
          WHERE tenant_id=$1 AND kind='session' AND payload->>'userId'=$2`,
        [TENANT, USER]
      );
      const requests = await client.query<{ outstanding: string; consumed: string }>(
        `SELECT count(*) FILTER (WHERE consumed_at_ms IS NULL AND
                  expires_at_ms > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)::text AS outstanding,
                count(*) FILTER (WHERE consumed_at_ms IS NOT NULL)::text AS consumed
          FROM authrim_aws_transient_state
          WHERE tenant_id=$1 AND kind='challenge' AND payload->>'userId'=$2
            AND payload->>'type'='synthetic-browser-sp' AND starts_with(id, 'browser-sp:_browser_')`,
        [TENANT, USER]
      );
      check(sessions.rows.length === 1 && requests.rows.length === 1);
      return {
        counter: count(passkey.rows[0].counter, 0xffffffff),
        sessions: count(sessions.rows[0].count),
        outstanding: count(requests.rows[0].outstanding),
        consumed: count(requests.rows[0].consumed),
      };
    });
    check(core.counter === state.counter);
    return {
      corePasskeyCounter: core.counter,
      statePasskeyCounter: state.counter,
      managedSessionCount: state.sessions,
      completedFlowAuditCount: core.audits,
      outstandingBrowserSpRequestCount: state.outstanding,
      consumedBrowserSpRequestCount: state.consumed,
    };
  } catch {
    throw new Error('aws_browser_rehearsal_snapshot_failed');
  }
}
