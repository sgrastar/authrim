import { readFileSync } from 'node:fs';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import type { PreparedStatement } from '../../db/adapter';
import type { StatementConsentAtomicCapability } from '../../db/statement-consent-atomic';
import { statementConsentHistoryId } from '../statement-consent-transitions';
import type {
  StatementConsentTransition,
  StatementConsentRawRecord,
  StatementConsentRawHistory,
} from '../statement-consent-transitions';

const SCHEMA_FIXTURE = new URL('./fixtures/statement-consent-step-a/', import.meta.url);

/** Test fixtures only: these drafts are not installed or imported by production code. */
export function stepASchema(dialect: 'd1' | 'postgresql'): string {
  return readFileSync(new URL(`statement-consent-step-a.${dialect}.sql`, SCHEMA_FIXTURE), 'utf8');
}

export function stepAD1Statements(): string[] {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL('statement-consent-step-a.d1.statements.json', SCHEMA_FIXTURE), 'utf8')
  );
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry): entry is string => typeof entry === 'string')
  ) {
    throw new Error('statement_consent_d1_fixture_invalid');
  }
  return parsed;
}

// The existing SQLite fixture uses Node 20 declarations. Validate only the real runtime
// methods this fixture needs; do not substitute an ambient module or a fake database.
interface ConsentFixtureDatabase {
  exec(sql: string): void;
  close(): void;
  function(name: string, callback: (value: unknown) => number): void;
}
function isConsentFixtureDatabase(value: unknown): value is ConsentFixtureDatabase {
  return (
    typeof value === 'object' &&
    value !== null &&
    'exec' in value &&
    typeof value.exec === 'function' &&
    'close' in value &&
    typeof value.close === 'function' &&
    'function' in value &&
    typeof value.function === 'function'
  );
}

/** Actual installed Core schema; only the atomic transport is the existing SQLite test adapter. */
export function transitionFixture() {
  const fixture = sqliteAdapter('core');
  const db: unknown = fixture.db;
  if (!isConsentFixtureDatabase(db)) throw new Error('actual_sqlite_fixture_methods_missing');
  db.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=OFF;');
  const capability: StatementConsentAtomicCapability = {
    dialect: 'd1',
    readOperation: (sql, params) =>
      fixture.adapter.queryOne<unknown>(sql, params, { consistencyClass: 'primary_required' }),
    async executeStatementConsentBatch(statements) {
      await fixture.adapter.batch([...statements]);
    },
  };
  async function seed(tenant = 'tenant-a', mode: 'disabled' | 'enforced' = 'enforced') {
    await fixture.adapter.execute(
      `INSERT INTO consent_statements(id,tenant_id,slug,created_at,updated_at) VALUES(?,?,?,?,?)`,
      [`statement-${tenant}`, tenant, `statement-${tenant}`, 1, 1]
    );
    await fixture.adapter.execute(
      `INSERT INTO consent_statement_versions(id,tenant_id,statement_id,version,effective_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
      [`version-${tenant}`, tenant, `statement-${tenant}`, '20261025', 1, 'active', 1, 1]
    );
    for (const [kind, key] of [
      ['tenant', ''],
      ['statement', `statement-${tenant}`],
    ]) {
      await fixture.adapter.execute(
        `INSERT INTO statement_consent_guards(tenant_id,scope_kind,scope_key,mode,account_id,physical_id,restore_epoch,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
        [tenant, kind, key, mode, `account-${tenant}`, 'physical-source', 'epoch-source', 1, 1]
      );
    }
    await fixture.adapter.execute(
      `INSERT INTO statement_consent_key_states(tenant_id,user_id,statement_id,account_id,physical_id,restore_epoch,revision,withdrawal_generation,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        tenant,
        `user-${tenant}`,
        `statement-${tenant}`,
        `account-${tenant}`,
        'physical-source',
        'epoch-source',
        0,
        0,
        1,
      ]
    );
  }
  async function rows(
    table:
      | 'user_consent_records'
      | 'consent_item_history'
      | 'statement_consent_operations'
      | 'statement_consent_key_states'
  ) {
    return fixture.adapter.query<Record<string, unknown>>(
      `SELECT * FROM ${table} ORDER BY tenant_id`
    );
  }
  return { ...fixture, db, capability, seed, rows, close: () => db.close() };
}

export function transitionInput(
  tenant = 'tenant-a',
  operationId = 'a'.repeat(64),
  now = Date.now()
): StatementConsentTransition {
  const after: StatementConsentRawRecord = {
    id: `record-${tenant}`,
    tenant_id: tenant,
    user_id: `user-${tenant}`,
    statement_id: `statement-${tenant}`,
    version_id: `version-${tenant}`,
    version: '20261025',
    status: 'granted',
    granted_at: now,
    withdrawn_at: null,
    expires_at: null,
    client_id: 'client',
    ip_address_hash: 'hashed-ip-marker',
    user_agent: 'ua-marker',
    receipt_id: null,
    created_at: now,
    updated_at: now,
    retain_until: null,
    consent_settings_snapshot_at: now,
    record_retention_days_snapshot: 0,
    reconsent_interval_days_snapshot: null,
    content_hash: 'b'.repeat(64),
  };
  const history: StatementConsentRawHistory = {
    id: statementConsentHistoryId(tenant, operationId),
    tenant_id: tenant,
    user_id: after.user_id,
    statement_id: after.statement_id,
    action: 'granted',
    version_before: null,
    version_after: after.version,
    status_before: null,
    status_after: 'granted',
    ip_address_hash: after.ip_address_hash,
    user_agent: after.user_agent,
    client_id: after.client_id,
    metadata_json: null,
    created_at: now,
    version_id_before: null,
    version_id_after: after.version_id,
    granted_at: now,
    withdrawn_at: null,
    expires_at: null,
    retain_until: null,
    consent_settings_snapshot_at: now,
    record_retention_days_snapshot: 0,
    reconsent_interval_days_snapshot: null,
    content_hash_after: after.content_hash,
  };
  return {
    definition: {
      tenant_id: tenant,
      statement_id: after.statement_id,
      version_id: after.version_id,
      version: after.version,
      content_hash: after.content_hash,
      definition_generation: 0,
      is_active: 1,
      version_status: 'active',
    },
    operationId,
    actor: { id: `user-${tenant}`, type: 'user' },
    owner: {
      tenantId: tenant,
      userId: after.user_id,
      accountId: `account-${tenant}`,
      statementId: after.statement_id,
      physicalId: 'physical-source',
      restoreEpoch: 'epoch-source',
    },
    expected: {
      revision: 0,
      withdrawalGeneration: 0,
      definitionGeneration: 0,
      closedGeneration: 0,
    },
    action: 'grant',
    issuedAt: now - 1_000,
    expiresAt: now + 600_000,
    effectAt: now,
    before: null,
    after,
    history,
    noop: false,
  };
}

export function copyStatement(statement: PreparedStatement): PreparedStatement {
  return { sql: statement.sql, ...(statement.params ? { params: [...statement.params] } : {}) };
}
