import type { DatabaseAdapter } from '../db/adapter';
import { assertGuestErasureBackend } from './guest-erasure-backend';

const PRIMARY = { consistencyClass: 'primary_required' } as const;
const unavailable = (): never => {
  throw new Error('guest_core_admission_unavailable');
};
const SOURCE_TABLES = [
  'passkeys',
  'guest_devices',
  'totp_credentials',
  'totp_backup_codes',
  'identity_accounts',
] as const;
const EVENTS = ['insert', 'update', 'delete'] as const;
interface SqliteTriggerProfile {
  table: string;
  timing: 'before' | 'after';
  event: (typeof EVENTS)[number];
}
function d1TriggerProfile(): Readonly<Record<string, SqliteTriggerProfile>> {
  const profile: Record<string, SqliteTriggerProfile> = {
    trg_guest_core_hold_insert: { table: 'legal_holds', timing: 'before', event: 'insert' },
    trg_guest_core_boundary_hold_insert: {
      table: 'guest_account_lifecycle',
      timing: 'before',
      event: 'insert',
    },
    trg_guest_core_boundary_hold_update: {
      table: 'guest_account_lifecycle',
      timing: 'before',
      event: 'update',
    },
    trg_guest_core_lifecycle_insert: {
      table: 'guest_account_lifecycle',
      timing: 'before',
      event: 'insert',
    },
    trg_guest_core_lifecycle_delete: {
      table: 'guest_account_lifecycle',
      timing: 'before',
      event: 'delete',
    },
    trg_guest_core_lifecycle_monotone: {
      table: 'guest_account_lifecycle',
      timing: 'before',
      event: 'update',
    },
    trg_guest_core_lifecycle_receipt: {
      table: 'guest_account_lifecycle',
      timing: 'before',
      event: 'update',
    },
    trg_guest_core_lifecycle_epoch: {
      table: 'guest_account_lifecycle',
      timing: 'after',
      event: 'update',
    },
  };
  for (const table of SOURCE_TABLES)
    for (const event of EVENTS)
      profile[`trg_guest_core_${table}_${event}`] = { table, timing: 'before', event };
  for (const [kind, table] of [
    ['owner', 'identity_accounts'],
    ['hold', 'legal_holds'],
    ['subject', 'identity_subjects'],
    ['profile', 'profiles'],
  ] as const)
    for (const event of EVENTS)
      profile[`trg_guest_core_${kind}_${event}_epoch`] = { table, timing: 'after', event };
  return profile;
}
const D1_TRIGGERS = d1TriggerProfile();
const D1_VIEWS = ['guest_core_erasure_started', 'guest_core_erasure_permit_rows'] as const;
const PG_TRIGGERS: Readonly<Record<string, { table: string; function: string; type: number }>> = {
  trg_guest_core_passkeys: {
    table: 'passkeys',
    function: 'authrim_guest_core_source_guard',
    type: 31,
  },
  trg_guest_core_devices: {
    table: 'guest_devices',
    function: 'authrim_guest_core_source_guard',
    type: 31,
  },
  trg_guest_core_accounts: {
    table: 'identity_accounts',
    function: 'authrim_guest_core_source_guard',
    type: 31,
  },
  trg_guest_core_subjects: {
    table: 'identity_subjects',
    function: 'authrim_guest_core_parent_epoch_guard',
    type: 31,
  },
  trg_guest_core_profiles: {
    table: 'profiles',
    function: 'authrim_guest_core_parent_epoch_guard',
    type: 31,
  },
  trg_guest_core_boundary: {
    table: 'guest_account_lifecycle',
    function: 'authrim_guest_core_boundary_guard',
    type: 31,
  },
  trg_guest_core_hold: {
    table: 'legal_holds',
    function: 'authrim_guest_core_hold_guard',
    type: 23,
  },
};
async function assertPgPhysicalContext(db: DatabaseAdapter): Promise<void> {
  if (db.getType() !== 'postgres') return;
  const tables = [
    'passkeys',
    'guest_devices',
    'identity_accounts',
    'identity_subjects',
    'profiles',
    'guest_account_lifecycle',
    'guest_deletion_audit_outbox',
    'account_legal_hold_states',
    'legal_holds',
    'guest_core_mutation_epoch',
  ];
  const names = tables.map((name) => `'${name}'`).join(',');
  const row = await db.queryOne<{ valid: boolean }>(
    `SELECT current_schema()='public' AND current_setting('session_replication_role')='origin'
      AND bool_and(COALESCE(to_regclass(name)=to_regclass('public.'||name),FALSE)) AS valid
      FROM unnest(ARRAY[${names}]) names(name)`,
    [],
    PRIMARY
  );
  if (row?.valid !== true) unavailable();
}
async function assertSchema(db: DatabaseAdapter): Promise<void> {
  if (db.getType() === 'd1') {
    const names = [...Object.keys(D1_TRIGGERS), ...D1_VIEWS];
    const rows = await db.query<{
      name: string;
      type: string;
      tbl_name: string;
      sql: string | null;
    }>(
      `SELECT name,type,tbl_name,CASE WHEN length(CAST(sql AS BLOB))<=65536 THEN sql ELSE NULL END AS sql FROM sqlite_schema WHERE name IN (${names.map(() => '?').join(',')})`,
      names,
      PRIMARY
    );
    if (rows.length !== names.length) unavailable();
    for (const name of names) {
      const matches = rows.filter((row) => row.name === name);
      if (matches.length !== 1) unavailable();
      const row = matches[0],
        profile = D1_TRIGGERS[name];
      if (!row.sql) return unavailable();
      if (!profile) {
        if (row.type !== 'view') unavailable();
        continue;
      }
      const normalized = row.sql.toLowerCase().replace(/\s+/gu, ' ');
      const head = new RegExp(
        `^create trigger ${name} ${profile.timing} ${profile.event}(?: of [a-z_, ]+)? on ${profile.table}(?: |$)`,
        'u'
      );
      if (row.type !== 'trigger' || row.tbl_name !== profile.table || !head.test(normalized))
        unavailable();
    }
  } else {
    const unsupported = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('totp_credentials','totp_backup_codes')",
      [],
      PRIMARY
    );
    if (unsupported.length) unavailable();
    const names = Object.keys(PG_TRIGGERS);
    const rows = await db.query<{
      name: string;
      table_name: string;
      function_name: string;
      function_namespace: string;
      type: number;
      enabled: string;
    }>(
      `SELECT trigger.tgname AS name,relation.relname AS table_name,procedure.proname AS function_name,procedure_namespace.nspname AS function_namespace,trigger.tgtype AS type,trigger.tgenabled AS enabled
       FROM pg_trigger trigger JOIN pg_class relation ON relation.oid=trigger.tgrelid
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace JOIN pg_proc procedure ON procedure.oid=trigger.tgfoid JOIN pg_namespace procedure_namespace ON procedure_namespace.oid=procedure.pronamespace
       WHERE namespace.nspname=current_schema() AND NOT trigger.tgisinternal AND trigger.tgname IN (${names.map(() => '?').join(',')})`,
      names,
      PRIMARY
    );
    if (rows.length !== names.length) unavailable();
    for (const name of names) {
      const profile = PG_TRIGGERS[name],
        found = rows.filter((row) => row.name === name);
      if (
        found.length !== 1 ||
        found[0].table_name !== profile.table ||
        found[0].function_name !== profile.function ||
        found[0].function_namespace !== 'public' ||
        Number(found[0].type) !== profile.type ||
        found[0].enabled !== 'O'
      )
        unavailable();
    }
  }
  // Naming an absent progress column must fail even when no task exists yet.
  await db.query(
    'SELECT execution_progress_json FROM guest_deletion_audit_outbox LIMIT 0',
    [],
    PRIMARY
  );
}
/** Fresh verified physical connection only; share schema work for one bounded invocation, never globally. */
export function createGuestCoreErasureAdmissionGuard(db: DatabaseAdapter): () => Promise<void> {
  let schema: Promise<void> | undefined;
  return async () => {
    assertGuestErasureBackend(db);
    await assertPgPhysicalContext(db);
    schema ??= assertSchema(db);
    await schema;
    const epoch = await db.queryOne<{ revision: number | string }>(
      'SELECT revision FROM guest_core_mutation_epoch WHERE id=1',
      [],
      PRIMARY
    );
    if (!epoch || !Number.isSafeInteger(Number(epoch.revision)) || Number(epoch.revision) < 0)
      unavailable();
  };
}
export async function assertGuestCoreErasureAdmission(db: DatabaseAdapter): Promise<void> {
  await createGuestCoreErasureAdmissionGuard(db)();
}
