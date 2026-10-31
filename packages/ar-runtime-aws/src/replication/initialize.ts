import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { canonicalRestoreJson, restoreEvidenceDigest } from '../import/restore-evidence';

declare const AUTHRIM_AWS_BUNDLED: boolean;
const FILES = [
  'authority-schema.sql',
  'generation-catalog-schema.sql',
  'journal-schema.sql',
  'environment-authority-schema.sql',
] as const;

export async function readReplicationAuthoritySchema() {
  const sources = await Promise.all(
    FILES.map(async (name) => {
      const root =
        typeof AUTHRIM_AWS_BUNDLED !== 'undefined' && AUTHRIM_AWS_BUNDLED ? './replication/' : './';
      return { name, sql: await readFile(new URL(`${root}${name}`, import.meta.url), 'utf8') };
    })
  );
  return { sources, digest: restoreEvidenceDigest(sources) };
}

export interface ReplicationAuthorityBootstrapRoles {
  serviceRole: string;
  journalRole: string;
}

export function assertReplicationAuthorityBootstrapRoles(
  value: unknown
): asserts value is ReplicationAuthorityBootstrapRoles {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'journalRole,serviceRole'
  )
    throw new Error('replication_bootstrap_roles_invalid');
  const roles = value as ReplicationAuthorityBootstrapRoles;
  if (
    [roles.serviceRole, roles.journalRole].some(
      (role) =>
        typeof role !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/u.test(role) || role.startsWith('pg_')
    ) ||
    roles.serviceRole === roles.journalRole
  )
    throw new Error('replication_bootstrap_roles_invalid');
}

async function assertBootstrapRoles(
  client: PoolClient,
  roles: ReplicationAuthorityBootstrapRoles
): Promise<void> {
  const actor = await client.query<{ username: string; owner: string }>(
    'SELECT current_user AS username,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()'
  );
  if (
    actor.rows.length !== 1 ||
    actor.rows[0].username !== actor.rows[0].owner ||
    [roles.serviceRole, roles.journalRole].includes(actor.rows[0].username)
  )
    throw new Error('replication_bootstrap_owner_required');
  const schemaOwner = await client.query<{ owner: string }>(
    "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='public'"
  );
  if (
    schemaOwner.rows.length !== 1 ||
    ![actor.rows[0].username, 'pg_database_owner'].includes(schemaOwner.rows[0].owner)
  )
    throw new Error('replication_bootstrap_schema_owner_invalid');
  const found = await client.query<{ rolname: string; safe: boolean }>(
    `
    SELECT r.rolname,(r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb
      AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolinherit
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)) AS safe
    FROM pg_roles r WHERE r.rolname=ANY($1::text[])`,
    [[roles.serviceRole, roles.journalRole]]
  );
  if (found.rows.length !== 2 || found.rows.some((row) => row.safe !== true))
    throw new Error('replication_bootstrap_roles_unsafe');
}

async function grantBootstrapRoles(
  client: PoolClient,
  roles: ReplicationAuthorityBootstrapRoles
): Promise<void> {
  const database = await client.query<{ name: string }>('SELECT current_database() AS name');
  const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  const service = quote(roles.serviceRole);
  const journal = quote(roles.journalRole);
  const databaseName = quote(database.rows[0].name);
  await client.query(`REVOKE ALL ON DATABASE ${databaseName} FROM PUBLIC`);
  await client.query(`REVOKE ALL ON DATABASE ${databaseName} FROM ${service},${journal}`);
  await client.query(`REVOKE ALL ON SCHEMA public FROM ${service},${journal}`);
  await client.query(`GRANT CONNECT ON DATABASE ${databaseName} TO ${service},${journal}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${service},${journal}`);
  await client.query(`GRANT SELECT,INSERT,UPDATE ON TABLE
    authrim_replication_authorities,authrim_replication_permits,authrim_replication_operations,
    authrim_replication_generation_locations,authrim_replication_environment_authorities,authrim_replication_environment_permits,authrim_replication_environment_operations TO ${service}`);
  await client.query(
    `GRANT SELECT,INSERT ON TABLE authrim_replication_members,authrim_replication_standby_generations,authrim_replication_environment_reservations,authrim_replication_environment_generations TO ${service}`
  );
  await client.query(
    `GRANT SELECT,INSERT,UPDATE ON TABLE authrim_replication_journal,authrim_replication_environment_journal TO ${journal}`
  );
}

async function schemaDigest(client: PoolClient): Promise<string> {
  // Include every user namespace, not just expected table names. A new trigger, policy,
  // function, grant or unrelated object is drift even when columns and indexes are unchanged.
  const result = await client.query<{ kind: string; name: string; definition: string }>(`
    WITH namespaces AS (
      SELECT * FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'
    ), relations AS (
      SELECT c.*,n.nspname FROM pg_class c JOIN namespaces n ON n.oid=c.relnamespace
    )
    SELECT 'namespace' AS kind, n.nspname AS name,
      jsonb_build_array(pg_get_userbyid(n.nspowner),n.nspacl::text)::text AS definition FROM namespaces n
    UNION ALL
    SELECT 'database', 'current', jsonb_build_array(pg_get_userbyid(datdba),datacl::text)::text
      FROM pg_database WHERE datname=current_database()
    UNION ALL
    SELECT 'relation', c.nspname||'.'||c.relname,
      jsonb_build_array(c.relkind,c.relpersistence,pg_get_userbyid(c.relowner),c.relacl::text,
        c.relrowsecurity,c.relforcerowsecurity,c.relreplident,c.reloptions,
        CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,true) ELSE NULL END)::text FROM relations c
    UNION ALL
    SELECT 'column', c.nspname||'.'||c.relname||'.'||a.attname,
      jsonb_build_array(format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,
        a.attacl::text,a.attoptions,a.attcollation::regcollation::text,pg_get_expr(d.adbin,d.adrelid))::text
      FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE a.attnum>0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'constraint', n.nspname||'.'||k.conrelid::regclass::text||'.'||k.contypid::regtype::text||'.'||k.conname,
      jsonb_build_array(pg_get_constraintdef(k.oid),k.convalidated,k.condeferrable,k.condeferred)::text
      FROM pg_constraint k JOIN namespaces n ON n.oid=k.connamespace
    UNION ALL
    SELECT 'index', i.schemaname||'.'||i.indexname, i.indexdef FROM pg_indexes i JOIN namespaces n ON n.nspname=i.schemaname
    UNION ALL
    SELECT 'trigger', c.nspname||'.'||c.relname||'.'||t.tgname,
      jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled)::text FROM pg_trigger t JOIN relations c ON c.oid=t.tgrelid
    UNION ALL
    SELECT 'policy', c.nspname||'.'||c.relname||'.'||p.polname,
      jsonb_build_array(p.polcmd,p.polpermissive,p.polroles::text,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid))::text
      FROM pg_policy p JOIN relations c ON c.oid=p.polrelid
    UNION ALL
    SELECT 'rule', c.nspname||'.'||c.relname||'.'||r.rulename, pg_get_ruledef(r.oid)
      FROM pg_rewrite r JOIN relations c ON c.oid=r.ev_class
    UNION ALL
    SELECT 'routine', n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
      jsonb_build_array(p.prokind,pg_get_userbyid(p.proowner),p.proacl::text,p.proconfig,p.prosecdef,
        p.provolatile,p.proisstrict,p.proleakproof,p.prosrc,p.probin,
        CASE WHEN p.prokind<>'a' THEN pg_get_functiondef(p.oid) ELSE NULL END)::text
      FROM pg_proc p JOIN namespaces n ON n.oid=p.pronamespace
    UNION ALL
    SELECT 'type', n.nspname||'.'||t.typname,
      jsonb_build_array(t.typtype,pg_get_userbyid(t.typowner),t.typacl::text,t.typnotnull,t.typdefault,
        (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid))::text
      FROM pg_type t JOIN namespaces n ON n.oid=t.typnamespace
    UNION ALL
    SELECT 'sequence', c.nspname||'.'||c.relname,
      jsonb_build_array(s.seqtypid::regtype::text,s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle)::text
      FROM pg_sequence s JOIN relations c ON c.oid=s.seqrelid
    UNION ALL
    SELECT 'default_acl', pg_get_userbyid(a.defaclrole)||'.'||coalesce(n.nspname,'*')||'.'||a.defaclobjtype::text,
      a.defaclacl::text FROM pg_default_acl a LEFT JOIN pg_namespace n ON n.oid=a.defaclnamespace
    UNION ALL
    SELECT 'extension', e.extname, jsonb_build_array(e.extversion,n.nspname,pg_get_userbyid(e.extowner))::text
      FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
    UNION ALL
    SELECT 'event_trigger', e.evtname,
      jsonb_build_array(e.evtevent,pg_get_userbyid(e.evtowner),e.evtfoid::regprocedure::text,e.evtenabled,e.evttags)::text FROM pg_event_trigger e
    UNION ALL
    SELECT 'foreign_server', s.srvname, jsonb_build_array(s.srvtype,s.srvversion,s.srvoptions,s.srvacl::text)::text FROM pg_foreign_server s
    ORDER BY 1,2,3`);
  if (result.rows.length < 30 || result.rows.length > 1000)
    throw new Error('replication_schema_invalid');
  return restoreEvidenceDigest(result.rows);
}

/** Explicit setup action, limited to a dedicated empty database or its exact verified installation. */
export async function initializeReplicationAuthorityDatabase(
  pool: Pick<Pool, 'connect'>,
  expectedSourceSha256: string,
  bootstrap?: ReplicationAuthorityBootstrapRoles
): Promise<{ schemaSha256: string }> {
  if (bootstrap !== undefined) assertReplicationAuthorityBootstrapRoles(bootstrap);
  const roles = bootstrap === undefined ? undefined : structuredClone(bootstrap);
  const rolesJson = roles === undefined ? null : canonicalRestoreJson(roles);
  const { sources, digest } = await readReplicationAuthoritySchema();
  if (digest !== expectedSourceSha256) throw new Error('replication_schema_source_changed');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('authrim:replication:schema',0))"
    );
    const tls = await client.query<{ ssl: boolean }>(
      'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'
    );
    if (tls.rows[0]?.ssl !== true) throw new Error('replication_database_tls_required');
    await client.query('SET LOCAL search_path TO public');
    if (roles) await assertBootstrapRoles(client, roles);
    const prior = await client.query<{ present: boolean }>(
      "SELECT to_regclass('public.authrim_replication_schema') IS NOT NULL AS present"
    );
    if (prior.rows[0]?.present) {
      const receipt = await client.query<{
        source_sha256: string;
        schema_sha256: string;
        bootstrap_json: string | null;
      }>(
        'SELECT source_sha256,schema_sha256,bootstrap_json FROM public.authrim_replication_schema'
      );
      const actual = await schemaDigest(client);
      if (
        receipt.rows.length !== 1 ||
        receipt.rows[0].source_sha256 !== digest ||
        receipt.rows[0].bootstrap_json !== rolesJson ||
        receipt.rows[0].schema_sha256 !== actual
      )
        throw new Error('replication_schema_changed');
      await client.query('COMMIT');
      return { schemaSha256: actual };
    }
    const objects = await client.query<{ count: string }>(`
      SELECT (
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') +
        (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') +
        (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') +
        (SELECT count(*) FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public','information_schema')) +
        (SELECT count(*) FROM pg_default_acl) + (SELECT count(*) FROM pg_event_trigger) +
        (SELECT count(*) FROM pg_extension WHERE extname<>'plpgsql') + (SELECT count(*) FROM pg_foreign_server)
      )::text AS count`);
    if (objects.rows[0]?.count !== '0') throw new Error('replication_database_not_empty');
    await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await client.query(sources.map((source) => source.sql).join('\n'));
    await client.query(
      'CREATE TABLE authrim_replication_schema (source_sha256 text NOT NULL, schema_sha256 text NOT NULL, bootstrap_json text)'
    );
    if (roles) await grantBootstrapRoles(client, roles);
    const actual = await schemaDigest(client);
    await client.query('INSERT INTO authrim_replication_schema VALUES ($1,$2,$3)', [
      digest,
      actual,
      rolesJson,
    ]);
    await client.query('COMMIT');
    return { schemaSha256: actual };
  } catch {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new Error('replication_authority_initialization_failed');
  } finally {
    client.release(true);
  }
}
