/** Statement consent writes: metadata snapshots and account-local atomic effects. */
import type { DatabaseAdapter } from '../db/adapter';
import {
  createStatementConsentD1Capability,
  type StatementConsentAtomicCapability,
  type StatementConsentPostgresProvider,
} from '../db/statement-consent-atomic';
import type { Env } from '../types/env';
import type { ConsentEvidence } from '../types/consent-statements';
import type { StatementConsentStores } from './statement-consent-stores';
import {
  applyStatementConsentTransition,
  STATEMENT_CONSENT_RECORD_COLUMNS,
  statementConsentHistoryId,
  type StatementConsentRawRecord,
  type StatementConsentRawHistory,
  type StatementConsentDefinitionSnapshot,
} from './statement-consent-transitions';

const DEFAULT_OPERATION_TTL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface StatementConsentWriteOptions {
  env?: Env;
  actor?: { id: string; type: string };
}

function hasPostgresCapability(
  db: DatabaseAdapter
): db is DatabaseAdapter & StatementConsentPostgresProvider {
  return (
    'statementConsentAtomicCapability' in db &&
    typeof db.statementConsentAtomicCapability === 'function'
  );
}

export function statementConsentAtomicCapability(
  db: DatabaseAdapter
): StatementConsentAtomicCapability {
  if (db.getType() === 'd1') return createStatementConsentD1Capability(db);
  if (db.getType() === 'postgres' && hasPostgresCapability(db)) {
    return db.statementConsentAtomicCapability();
  }
  // DSQL must never fall back to the old sequential writer.
  throw new Error('statement_consent_atomic_backend_unsupported');
}

async function operationTtl(env?: Env): Promise<number> {
  const configured: unknown = env && Reflect.get(env, 'STATEMENT_CONSENT_OPERATION_TTL_MS');
  const raw =
    configured ??
    (await env?.KV?.get('statement_consent_operation_ttl_ms')) ??
    DEFAULT_OPERATION_TTL_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('statement_consent_operation_ttl_invalid');
  return value;
}

interface GuardRow {
  account_id: string;
  physical_id: string;
  restore_epoch: string;
  mode: string;
  definition_generation: number | string;
  closed_generation: number | string;
}

/** A guard's identity is trusted only at creation on an already resolved account store. */
export async function ensureStatementConsentTenantGuard(
  account: DatabaseAdapter,
  tenantId: string,
  now = Date.now()
): Promise<GuardRow> {
  let guard = await account.queryOne<GuardRow>(
    "SELECT * FROM statement_consent_guards WHERE tenant_id=? AND scope_kind='tenant' AND scope_key=''",
    [tenantId],
    { consistencyClass: 'primary_required' }
  );
  if (!guard) {
    const existing = await account.queryOne<{ present: number }>(
      'SELECT 1 AS present FROM statement_consent_key_states WHERE tenant_id=? UNION ALL SELECT 1 AS present FROM statement_consent_operations WHERE tenant_id=? LIMIT 1',
      [tenantId, tenantId],
      { consistencyClass: 'primary_required' }
    );
    if (existing) throw new Error('statement_consent_restore_rebind_required');
    await account.execute(
      `INSERT INTO statement_consent_guards(tenant_id,scope_kind,scope_key,mode,account_id,physical_id,restore_epoch,created_at,updated_at)
       VALUES(?,'tenant','','enforced',?,?,?,?,?) ON CONFLICT(tenant_id,scope_kind,scope_key) DO NOTHING`,
      [tenantId, crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), now, now]
    );
    guard = await account.queryOne<GuardRow>(
      "SELECT * FROM statement_consent_guards WHERE tenant_id=? AND scope_kind='tenant' AND scope_key=''",
      [tenantId],
      { consistencyClass: 'primary_required' }
    );
  }
  if (
    !guard ||
    !guard.account_id ||
    !guard.physical_id ||
    !guard.restore_epoch ||
    guard.mode === 'closed'
  ) {
    throw new Error('statement_consent_restore_rebind_required');
  }
  return guard;
}

export interface StatementConsentDefinition extends StatementConsentDefinitionSnapshot {
  closed_generation: number;
  record_retention_days: number | null;
  reconsent_interval_days: number | null;
  withdrawal_allowed: boolean;
}

const optionalNumber = (value: unknown): number | null => (value == null ? null : Number(value));

export async function readStatementConsentRecord(
  account: DatabaseAdapter,
  tenantId: string,
  userId: string,
  statementId: string
): Promise<StatementConsentRawRecord | null> {
  const row = await account.queryOne<StatementConsentRawRecord>(
    'SELECT * FROM user_consent_records WHERE tenant_id=? AND user_id=? AND statement_id=?',
    [tenantId, userId, statementId],
    { consistencyClass: 'primary_required' }
  );
  if (!row) return null;
  const normalized = { ...row };
  // node-postgres returns BIGINT as strings. Never let a string enter projections or arithmetic.
  for (const column of STATEMENT_CONSENT_RECORD_COLUMNS) {
    if (column.endsWith('_at') || column.endsWith('_until') || column.endsWith('_days_snapshot')) {
      Object.assign(normalized, { [column]: optionalNumber(row[column]) });
    } else if (row[column] === undefined) Object.assign(normalized, { [column]: null });
  }
  return normalized;
}

/** A single metadata query captures version, document hash, settings and generation together. */
export async function readStatementConsentDefinition(
  metadata: DatabaseAdapter,
  tenantId: string,
  statementId: string,
  versionId?: string
): Promise<StatementConsentDefinition | null> {
  const row = await metadata.queryOne<
    StatementConsentDefinition & { withdrawal_allowed: number | boolean | null }
  >(
    `SELECT d.tenant_id,d.id AS statement_id,v.id AS version_id,v.version,v.content_hash,
       d.definition_generation,d.closed_generation,CASE WHEN d.retired_at IS NOT NULL THEN 0 ELSE d.is_active END AS is_active,v.status AS version_status,
       d.record_retention_days,d.reconsent_interval_days,d.withdrawal_allowed
     FROM consent_statements d JOIN consent_statement_versions v ON v.statement_id=d.id AND v.tenant_id=d.tenant_id
     WHERE d.tenant_id=? AND d.id=? AND ${versionId ? 'v.id=?' : 'v.is_current=1'}`,
    versionId ? [tenantId, statementId, versionId] : [tenantId, statementId],
    { consistencyClass: 'primary_required' }
  );
  return row
    ? {
        ...row,
        is_active: Number(row.is_active),
        content_hash: row.content_hash ?? null,
        definition_generation: Number(row.definition_generation),
        closed_generation: Number(row.closed_generation),
        record_retention_days: optionalNumber(row.record_retention_days),
        reconsent_interval_days: optionalNumber(row.reconsent_interval_days),
        withdrawal_allowed: row.withdrawal_allowed == null || Number(row.withdrawal_allowed) !== 0,
      }
    : null;
}

/** Bootstrap revision zero, then let the native batch compare the complete before image. */
export async function writeStatementConsentDecision(
  stores: StatementConsentStores,
  tenantId: string,
  userId: string,
  statementId: string,
  decision: 'granted' | 'denied',
  definition: StatementConsentDefinition,
  before: StatementConsentRawRecord | null,
  evidence: ConsentEvidence,
  ipHash: string | undefined,
  options: StatementConsentWriteOptions = {}
): Promise<void> {
  const capability = statementConsentAtomicCapability(stores.account);
  const now = Date.now();
  const withdraw = decision === 'denied' && before?.status === 'granted';
  if (withdraw && !definition.withdrawal_allowed) return;
  if (decision === 'denied' && before?.status === 'denied') return;
  const noop =
    decision === 'granted' &&
    before?.status === 'granted' &&
    before.version_id === definition.version_id &&
    before.content_hash === definition.content_hash;
  const tenant = await ensureStatementConsentTenantGuard(stores.account, tenantId, now);
  await stores.account.execute(
    `INSERT INTO statement_consent_guards(tenant_id,scope_kind,scope_key,mode,account_id,definition_generation,closed_generation,physical_id,restore_epoch,created_at,updated_at)
     VALUES(?,'statement',?,'enforced',?,?,?,?,?,?,?) ON CONFLICT(tenant_id,scope_kind,scope_key) DO NOTHING`,
    [
      tenantId,
      statementId,
      tenant.account_id,
      definition.definition_generation,
      definition.closed_generation,
      tenant.physical_id,
      tenant.restore_epoch,
      now,
      now,
    ]
  );
  await stores.account.execute(
    `INSERT INTO statement_consent_key_states(tenant_id,user_id,statement_id,account_id,physical_id,restore_epoch,revision,withdrawal_generation,updated_at)
     VALUES(?,?,?,?,?,?,0,0,?) ON CONFLICT(tenant_id,user_id,statement_id) DO NOTHING`,
    [
      tenantId,
      userId,
      statementId,
      tenant.account_id,
      tenant.physical_id,
      tenant.restore_epoch,
      now,
    ]
  );
  const key = await stores.account.queryOne<{
    revision: number | string;
    withdrawal_generation: number | string;
    account_id: string;
    physical_id: string;
    restore_epoch: string;
  }>(
    'SELECT * FROM statement_consent_key_states WHERE tenant_id=? AND user_id=? AND statement_id=?',
    [tenantId, userId, statementId],
    { consistencyClass: 'primary_required' }
  );
  if (
    !key ||
    key.account_id !== tenant.account_id ||
    key.physical_id !== tenant.physical_id ||
    key.restore_epoch !== tenant.restore_epoch
  ) {
    throw new Error('statement_consent_restore_rebind_required');
  }
  const operationId =
    crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const retention = {
    consent_settings_snapshot_at: now,
    record_retention_days_snapshot: definition.record_retention_days,
    reconsent_interval_days_snapshot: definition.reconsent_interval_days,
    retain_until:
      definition.record_retention_days === null
        ? null
        : now + definition.record_retention_days * DAY_MS,
  };
  const after: StatementConsentRawRecord =
    noop && before
      ? { ...before }
      : {
          id: before?.id ?? crypto.randomUUID(),
          tenant_id: tenantId,
          user_id: userId,
          statement_id: statementId,
          version_id: withdraw && before ? before.version_id : definition.version_id,
          version: withdraw && before ? before.version : definition.version,
          content_hash: withdraw && before ? before.content_hash : definition.content_hash,
          status: withdraw ? 'withdrawn' : decision,
          granted_at: decision === 'granted' ? now : (before?.granted_at ?? null),
          withdrawn_at: withdraw ? now : null,
          expires_at: withdraw
            ? (before?.expires_at ?? null)
            : decision === 'granted' &&
                definition.reconsent_interval_days !== null &&
                definition.reconsent_interval_days > 0
              ? now + definition.reconsent_interval_days * DAY_MS
              : null,
          client_id: evidence.client_id ?? before?.client_id ?? null,
          ip_address_hash: ipHash ?? null,
          user_agent: evidence.user_agent ?? null,
          receipt_id: before?.receipt_id ?? null,
          created_at: before?.created_at ?? now,
          updated_at: now,
          ...retention,
        };
  const history: StatementConsentRawHistory | null = noop
    ? null
    : {
        id: statementConsentHistoryId(tenantId, operationId),
        tenant_id: tenantId,
        user_id: userId,
        statement_id: statementId,
        action: withdraw
          ? 'withdrawn'
          : decision === 'denied'
            ? 'denied'
            : before?.status === 'granted' && before.version < after.version
              ? 'version_upgraded'
              : 'granted',
        version_before: before?.version ?? null,
        version_after: after.version,
        version_id_before: before?.version_id ?? null,
        version_id_after: after.version_id,
        status_before: before?.status ?? null,
        status_after: after.status,
        granted_at: after.granted_at,
        withdrawn_at: after.withdrawn_at,
        expires_at: after.expires_at,
        content_hash_after: after.content_hash,
        ip_address_hash: after.ip_address_hash,
        user_agent: after.user_agent,
        client_id: after.client_id,
        metadata_json:
          options.actor?.type === 'admin'
            ? JSON.stringify({ initiated_by: 'admin', actor_id: options.actor.id })
            : null,
        created_at: now,
        ...retention,
      };
  const ttl = await operationTtl(options.env);
  const result = await applyStatementConsentTransition(capability, {
    operationId,
    actor: options.actor ?? { id: userId, type: 'user' },
    owner: {
      tenantId,
      userId,
      statementId,
      accountId: tenant.account_id,
      physicalId: tenant.physical_id,
      restoreEpoch: tenant.restore_epoch,
    },
    expected: {
      revision: Number(key.revision),
      withdrawalGeneration: Number(key.withdrawal_generation),
      definitionGeneration: definition.definition_generation,
      closedGeneration: definition.closed_generation,
    },
    definition: {
      ...definition,
      version_id: after.version_id,
      version: after.version,
      content_hash: after.content_hash,
    },
    action: withdraw ? 'withdraw' : decision === 'granted' ? 'grant' : 'deny',
    // Bound clock skew by the same configured lifetime; the expiry stays tied to this request.
    issuedAt: Math.max(0, now - ttl),
    expiresAt: now + ttl,
    effectAt: now,
    before,
    after,
    history,
    noop: Boolean(noop),
  });
  if (result.outcome === 'rejected') throw new Error('statement_consent_transition_rejected');
}

/** Admin withdrawal also works for retained evidence whose definition has disappeared. */
export async function withdrawStatementConsent(
  stores: StatementConsentStores,
  tenantId: string,
  userId: string,
  statementId: string,
  options: StatementConsentWriteOptions
): Promise<'withdrawn' | 'missing' | 'not_granted' | 'withdrawal_forbidden'> {
  const before = await readStatementConsentRecord(stores.account, tenantId, userId, statementId);
  if (!before) return 'missing';
  if (before.status !== 'granted') return 'not_granted';
  const settings = await stores.metadata.queryOne<{
    definition_generation: number | string;
    closed_generation: number | string;
    withdrawal_allowed: number | string | null;
    record_retention_days: number | string | null;
    reconsent_interval_days: number | string | null;
  }>(
    'SELECT definition_generation,closed_generation,withdrawal_allowed,record_retention_days,reconsent_interval_days FROM consent_statements WHERE tenant_id=? AND id=?',
    [tenantId, statementId],
    { consistencyClass: 'primary_required' }
  );
  if (settings?.withdrawal_allowed != null && Number(settings.withdrawal_allowed) === 0)
    return 'withdrawal_forbidden';
  const projected = settings
    ? null
    : await stores.account.queryOne<GuardRow>(
        "SELECT * FROM statement_consent_guards WHERE tenant_id=? AND scope_kind='statement' AND scope_key=?",
        [tenantId, statementId],
        { consistencyClass: 'primary_required' }
      );
  await writeStatementConsentDecision(
    stores,
    tenantId,
    userId,
    statementId,
    'denied',
    {
      tenant_id: tenantId,
      statement_id: statementId,
      version_id: before.version_id,
      version: before.version,
      content_hash: before.content_hash,
      is_active: 0,
      version_status: 'archived',
      definition_generation: Number(
        settings?.definition_generation ?? projected?.definition_generation ?? 0
      ),
      closed_generation: Number(settings?.closed_generation ?? projected?.closed_generation ?? 0),
      record_retention_days: optionalNumber(settings?.record_retention_days),
      reconsent_interval_days: optionalNumber(settings?.reconsent_interval_days),
      withdrawal_allowed: true,
    },
    before,
    {},
    undefined,
    options
  );
  return 'withdrawn';
}
