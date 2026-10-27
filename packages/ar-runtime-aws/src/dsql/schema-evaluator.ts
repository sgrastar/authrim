import type { DsqlIdentitySchemaDatabase, DsqlIdentitySchemaOptions } from './identity-schema';

export interface DsqlEvaluationSchemaPlan {
  schema: string;
  tables: ReadonlyArray<{ name: string; sql: string }>;
  indexes: ReadonlyArray<{ name: string; table: string; unique: boolean; sql: string }>;
}

/** Autocommit only. The caller supplies a closed, explicit plan, not imported SQL. */
export async function initializeDsqlEvaluationSchema<Plan extends DsqlEvaluationSchemaPlan>(
  db: DsqlIdentitySchemaDatabase,
  plan: Plan,
  options: DsqlIdentitySchemaOptions,
  errorPrefix: string
): Promise<Plan> {
  const schema = plan.schema;
  function fail(reason: string): never {
    throw new Error(`${errorPrefix}_${reason}`);
  }
  const maxPolls = options.maxIndexPolls ?? 240;
  const interval = options.pollIntervalMs ?? 500;
  if (
    !Number.isInteger(maxPolls) ||
    maxPolls < 1 ||
    maxPolls > 600 ||
    !Number.isInteger(interval) ||
    interval < 0 ||
    interval > 5_000
  )
    fail('schema_poll_options_invalid');
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const progress = options.onProgress ?? (() => undefined);
  try {
    progress({ kind: 'schema', name: schema, status: 'attempted' });
    const created = await db.execute(`CREATE SCHEMA "${schema}"`);
    if (!created.success) fail('schema_create_failed');
    progress({ kind: 'schema', name: schema, status: 'created' });
    for (const table of plan.tables) {
      progress({ kind: 'table', name: table.name, status: 'attempted' });
      const result = await db.execute(table.sql);
      if (!result.success) fail('table_create_failed');
      progress({ kind: 'table', name: table.name, status: 'created' });
    }
    for (const index of plan.indexes) {
      progress({ kind: 'index', name: index.name, status: 'attempted' });
      const submitted = await db.queryOne<{ job_id: string }>(index.sql);
      if (
        !submitted ||
        typeof submitted.job_id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/u.test(submitted.job_id)
      ) {
        fail('index_job_missing');
      }
      const jobId = submitted.job_id;
      progress({ kind: 'index', name: index.name, status: 'created', jobId });
      let ready = false;
      for (let attempt = 0; attempt < maxPolls; attempt++) {
        const job = await db.queryOne<{
          job_id: string;
          status: string;
          job_type: string;
          object_name: string;
        }>('SELECT job_id, status, job_type, object_name FROM sys.jobs WHERE job_id = $1', [jobId]);
        if (
          !job ||
          job.job_id !== jobId ||
          job.job_type !== 'INDEX_BUILD' ||
          job.object_name !== `${schema}.${index.name}`
        )
          fail('index_job_invalid');
        if (job.status === 'failed') fail('index_build_failed');
        if (job.status === 'completed') {
          const catalog = await db.queryOne<{ is_valid: boolean; is_unique: boolean }>(
            `SELECT i.indisvalid AS is_valid, i.indisunique AS is_unique
               FROM pg_index i
               JOIN pg_class c ON c.oid = i.indexrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
               JOIN pg_class t ON t.oid = i.indrelid
              WHERE n.nspname = $1 AND c.relname = $2 AND t.relname = $3`,
            [schema, index.name, index.table]
          );
          if (!catalog || catalog.is_valid !== true || catalog.is_unique !== index.unique) {
            fail('index_catalog_invalid');
          }
          ready = true;
          progress({ kind: 'index', name: index.name, status: 'ready', jobId });
          break;
        }
        if (job.status !== 'submitted' && job.status !== 'processing') fail('index_status_invalid');
        if (attempt + 1 < maxPolls) await sleep(interval);
      }
      if (!ready) fail('index_wait_exhausted');
    }
    return plan;
  } catch (error) {
    // Do not copy SQL, job details, parameters, or driver messages into reports.
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[0-9A-Z]{5}$/u.test(error.code)
        ? error.code
        : undefined;
    const reason =
      error instanceof Error && new RegExp(`^${errorPrefix}_[a-z_]+$`, 'u').test(error.message)
        ? error.message
        : `${errorPrefix}_schema_initialization_failed`;
    throw Object.assign(new Error(reason), code ? { code } : {});
  }
}
