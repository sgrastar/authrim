import { readFile } from 'node:fs/promises';
import type { PostgresQueryClient } from '../storage/postgres-transient-state';

/** AWS-only DDL applied when the selected schema has no AWS runtime objects yet. */
export const AWS_RUNTIME_SCHEMA_FILES = [
  'account-auth-schema.sql',
  'schema.sql',
  'rate-limit-schema.sql',
  'audit-schema.sql',
  'persistent-nameid-schema.sql',
  'authorization-code-schema.sql',
  'restore-activation-schema.sql',
] as const;

const TABLES = [
  'authrim_aws_account_auth_state',
  'authrim_aws_passkey_counters',
  'authrim_aws_transient_state',
  'authrim_aws_rate_limit_counters',
  'authrim_aws_audit_events',
  'authrim_aws_saml_persistent_nameids',
  'authrim_aws_authorization_codes',
  'authrim_aws_restore_activations',
] as const;

type SchemaFile = (typeof AWS_RUNTIME_SCHEMA_FILES)[number];
declare const AUTHRIM_AWS_BUNDLED: boolean;

async function readSchemaFile(file: SchemaFile): Promise<string> {
  const folder =
    typeof AUTHRIM_AWS_BUNDLED !== 'undefined' && AUTHRIM_AWS_BUNDLED
      ? './storage/'
      : '../storage/';
  return readFile(new URL(`${folder}${file}`, import.meta.url), 'utf8');
}

/**
 * Offline bootstrap for the experimental AWS state tables only. The selected schema may
 * contain Core/PII tables, but must not already contain AWS runtime tables or functions.
 * Apply Core/PII migrations and import tenant data through their separate tooling.
 * All statements run in one PostgreSQL simple query (one implicit transaction),
 * so a failure rolls back DDL without leaving the connection in an aborted BEGIN.
 */
export async function bootstrapFreshAwsRuntimeSchema(
  db: PostgresQueryClient,
  loadSql: (file: SchemaFile) => Promise<string> = readSchemaFile
): Promise<void> {
  const sources = await Promise.all(AWS_RUNTIME_SCHEMA_FILES.map((file) => loadSql(file)));
  if (sources.some((sql) => !sql.trim())) throw new Error('aws_runtime_schema_source_empty');
  const tableNames = TABLES.map((table) => `'${table}'`).join(', ');
  const preflight = `
    DO $authrim$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname IN (${tableNames})
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = current_schema()
          AND p.proname = 'authrim_aws_store_authorization_code'
      ) THEN
        RAISE EXCEPTION 'aws_runtime_schema_not_empty';
      END IF;
    END
    $authrim$;`;
  await db.query(`${preflight}\n${sources.join('\n')}`, []);
}

/** Check the installed AWS state shape before the Lambda runtime accepts requests. */
export async function assertAwsRuntimeSchemaReady(db: PostgresQueryClient): Promise<void> {
  const result = await db.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])`,
    [TABLES]
  );
  const columns = new Set(result.rows.map((row) => `${row.table_name}.${row.column_name}`));
  for (const [table, required] of [
    ['authrim_aws_account_auth_state', ['tenant_id', 'user_id', 'lifecycle', 'revoked_after_ms']],
    ['authrim_aws_passkey_counters', ['tenant_id', 'user_id', 'credential_id', 'counter']],
    ['authrim_aws_transient_state', ['tenant_id', 'kind', 'id', 'expires_at_ms']],
    ['authrim_aws_rate_limit_counters', ['scope_kind', 'scope_id', 'key_hash', 'request_count']],
    ['authrim_aws_audit_events', ['tenant_id', 'id', 'payload']],
    ['authrim_aws_saml_persistent_nameids', ['tenant_id', 'registry_key', 'value_json']],
    ['authrim_aws_authorization_codes', ['tenant_id', 'code_sha256', 'expires_at_ms']],
    ['authrim_aws_restore_activations', ['tenant_id', 'restore_id', 'status', 'evidence_sha256']],
  ] as const) {
    for (const column of required) {
      if (!columns.has(`${table}.${column}`)) throw new Error('aws_runtime_schema_incomplete');
    }
  }
}
