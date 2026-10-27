import type { Client } from 'pg';
import type { PostgresRestoreTableContract } from './postgres-restore-table-contract';

interface ProjectionTrigger {
  table: string;
  trigger: string;
}

/** Only derived-row INSERT effects whose complete source dataset is being restored. */
const projectionTriggers: readonly {
  output: string;
  triggers: readonly ProjectionTrigger[];
}[] = [
  {
    output: 'core.lookup_retention_policies',
    triggers: [{ table: 'tenants', trigger: 'trg_tenants_lookup_retention_policy_insert' }],
  },
  {
    output: 'core.account_legal_hold_states',
    triggers: [
      { table: 'identity_accounts', trigger: 'trg_identity_accounts_legal_hold_state_insert' },
      { table: 'legal_holds', trigger: 'trg_legal_holds_projection_state_insert' },
    ],
  },
  {
    output: 'core.account_webhook_outbox',
    triggers: [
      { table: 'identity_accounts', trigger: 'account_webhook_created_insert' },
      { table: 'profiles', trigger: 'account_webhook_profiles_insert' },
      {
        table: 'profile_attribute_values',
        trigger: 'account_webhook_profile_attribute_values_insert',
      },
      { table: 'contact_points', trigger: 'account_webhook_contact_points_insert' },
      { table: 'user_custom_fields', trigger: 'account_webhook_user_custom_fields_insert' },
    ],
  },
  {
    output: 'core.service_group_inputs',
    triggers: [
      'identity_accounts',
      'user_custom_fields',
      'user_roles',
      'service_group_manual',
      'contact_points',
    ]
      .map((table) => ({ table, trigger: `sg_${table}_insert` }))
      .concat([{ table: 'service_group_write_boundaries', trigger: 'sg_write_boundary_insert' }]),
  },
  {
    output: 'pii.service_group_inputs',
    triggers: [
      { table: 'identity_sensitive_values', trigger: 'sg_identity_sensitive_values_insert' },
      { table: 'service_group_write_boundaries', trigger: 'sg_write_boundary_insert' },
    ],
  },
];

/** Transactional ALTERs on an empty, isolated staging DB; never disables constraints or guards. */
export async function suspendSnapshotProjectionTriggers(
  client: Client,
  specs: readonly PostgresRestoreTableContract[]
): Promise<readonly ProjectionTrigger[]> {
  const datasets = new Set(specs.map((spec) => spec.datasetId));
  const tables = new Set(specs.map((spec) => spec.table));
  const selected = projectionTriggers.flatMap((entry) =>
    datasets.has(entry.output) ? entry.triggers.filter((item) => tables.has(item.table)) : []
  );
  for (const item of selected) {
    const actual = await client.query<{ tgenabled: string; tgisinternal: boolean }>(
      `SELECT t.tgenabled,t.tgisinternal FROM pg_trigger t
       JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname=$1 AND t.tgname=$2`,
      [item.table, item.trigger]
    );
    if (actual.rows.length !== 1 || actual.rows[0].tgenabled !== 'O' || actual.rows[0].tgisinternal)
      throw new Error('aws_postgres_restore_trigger_invalid');
    await client.query(`ALTER TABLE "${item.table}" DISABLE TRIGGER "${item.trigger}"`);
  }
  return selected;
}

export async function restoreSnapshotProjectionTriggers(
  client: Client,
  triggers: readonly ProjectionTrigger[]
): Promise<void> {
  for (const item of triggers)
    await client.query(`ALTER TABLE "${item.table}" ENABLE TRIGGER "${item.trigger}"`);
}
