import { initializeDsqlEvaluationSchema } from './schema-evaluator';
import { createHash } from 'node:crypto';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../import/postgres-restore-table-contract';

export type DsqlIdentityTableName = 'users_core' | 'users_pii' | 'passkeys';
export type DsqlIdentitySchemaDatabase = Pick<DatabaseAdapter, 'execute' | 'queryOne'>;

/** This namespace is for synthetic capability evaluation, never a serving database. */
export function assertDsqlIdentitySchemaName(schema: string): void {
  if (!/^authrim_dsql_identity_[a-f0-9]{32}$/u.test(schema)) {
    throw new Error('dsql_identity_schema_invalid');
  }
}

export function dsqlIdentityTableName(schema: string, table: DsqlIdentityTableName): string {
  assertDsqlIdentitySchemaName(schema);
  if (!['users_core', 'users_pii', 'passkeys'].includes(table)) {
    throw new Error('dsql_identity_table_invalid');
  }
  return `"${schema}"."${table}"`;
}

// These definitions preserve the PostgreSQL baseline's columns and constraints.
// They are intentionally explicit: source migrations are neither executed nor rewritten.
// Core and PII share this disposable namespace only for capability evaluation;
// this is not the production isolation topology or a new migration stream.
const TABLE_DEFINITIONS: Readonly<Record<DsqlIdentityTableName, string>> = {
  users_core: `id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    phone_number_verified boolean DEFAULT false NOT NULL,
    email_domain_hash text,
    email_domain_hash_version integer DEFAULT 1 NOT NULL,
    password_hash text,
    is_active boolean DEFAULT true NOT NULL,
    user_type text DEFAULT 'end_user'::text NOT NULL,
    pii_partition text DEFAULT 'default'::text NOT NULL,
    pii_status text DEFAULT 'pending'::text NOT NULL,
    external_id text,
    status text DEFAULT 'active'::text NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    suspended_at bigint,
    suspended_until bigint,
    locked_at bigint,
    locked_until bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    last_login_at bigint,
    CONSTRAINT users_core_lifecycle_state_check CHECK ((lifecycle_state = ANY (ARRAY['invited'::text, 'pending_verification'::text, 'provisioning'::text, 'incomplete'::text, 'active'::text, 'dormant'::text, 'archived'::text, 'deprovisioned'::text]))),
    CONSTRAINT users_core_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'locked'::text]))),
    CONSTRAINT users_core_pkey PRIMARY KEY (id)`,
  users_pii: `id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    pii_class text DEFAULT 'PROFILE'::text NOT NULL,
    email text NOT NULL,
    email_blind_index text,
    phone_number text,
    name text,
    given_name text,
    family_name text,
    middle_name text,
    nickname text,
    preferred_username text,
    profile text,
    picture text,
    website text,
    gender text,
    birthdate text,
    locale text,
    zoneinfo text,
    address_formatted text,
    address_street_address text,
    address_locality text,
    address_region text,
    address_postal_code text,
    address_country text,
    declared_residence text,
    custom_attributes_json jsonb,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT users_pii_pkey PRIMARY KEY (id)`,
  passkeys: `id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    user_id text NOT NULL,
    credential_id text NOT NULL,
    public_key text NOT NULL,
    counter bigint DEFAULT 0 NOT NULL,
    transports text,
    device_name text,
    aaguid text,
    created_at bigint NOT NULL,
    last_used_at bigint,
    rp_id text,
    CONSTRAINT passkeys_pkey PRIMARY KEY (id),
    CONSTRAINT passkeys_unique_credential UNIQUE (tenant_id, credential_id)`,
};

const INDEX_DEFINITIONS: readonly {
  name: string;
  table: DsqlIdentityTableName;
  unique: boolean;
  definition: string;
}[] = [
  {
    name: 'idx_users_core_domain_hash',
    table: 'users_core',
    unique: false,
    definition: '(tenant_id, email_domain_hash, email_domain_hash_version)',
  },
  {
    name: 'idx_users_core_external_id',
    table: 'users_core',
    unique: false,
    definition: '(tenant_id, external_id)',
  },
  {
    name: 'idx_users_core_status',
    table: 'users_core',
    unique: false,
    definition: '(tenant_id, status)',
  },
  {
    name: 'idx_users_core_tenant',
    table: 'users_core',
    unique: false,
    definition: '(tenant_id)',
  },
  {
    name: 'idx_users_core_tenant_active',
    table: 'users_core',
    unique: false,
    definition: '(tenant_id, is_active)',
  },
  {
    name: 'idx_users_pii_class',
    table: 'users_pii',
    unique: false,
    definition: '(tenant_id, pii_class)',
  },
  {
    name: 'idx_users_pii_email',
    table: 'users_pii',
    unique: true,
    definition: '(tenant_id, email_blind_index)',
  },
  {
    name: 'idx_users_pii_residence',
    table: 'users_pii',
    unique: false,
    definition: '(tenant_id, declared_residence)',
  },
  {
    name: 'idx_users_pii_tenant',
    table: 'users_pii',
    unique: false,
    definition: '(tenant_id)',
  },
  {
    name: 'idx_passkeys_credential',
    table: 'passkeys',
    unique: false,
    definition: '(tenant_id, credential_id)',
  },
  {
    name: 'idx_passkeys_routing_authority',
    table: 'passkeys',
    unique: false,
    definition: '(tenant_id, created_at, id) WHERE (rp_id IS NOT NULL)',
  },
  {
    name: 'idx_passkeys_user',
    table: 'passkeys',
    unique: false,
    definition: '(tenant_id, user_id)',
  },
];

export function createDsqlIdentitySchemaPlan(schema: string) {
  assertDsqlIdentitySchemaName(schema);
  const names = Object.keys(TABLE_DEFINITIONS) as DsqlIdentityTableName[];
  const contracts = names.map((name) => {
    const contract = POSTGRES_RESTORE_TABLE_CONTRACTS.find((item) => item.table === name);
    if (!contract) throw new Error('dsql_identity_contract_missing');
    return contract;
  });
  return {
    formatVersion: 1 as const,
    scope: 'identity-staging-experiment' as const,
    fullRuntimeReady: false as const,
    schema,
    sourceContractFingerprint: createHash('sha256')
      .update(JSON.stringify({ contracts, tables: TABLE_DEFINITIONS, indexes: INDEX_DEFINITIONS }))
      .digest('hex'),
    tables: names.map((name, index) => ({
      name,
      datasetId: contracts[index].datasetId,
      columns: [...contracts[index].columns],
      sql: `CREATE TABLE ${dsqlIdentityTableName(schema, name)} (${TABLE_DEFINITIONS[name]})`,
    })),
    indexes: INDEX_DEFINITIONS.map((index) => ({
      name: index.name,
      table: index.table,
      unique: index.unique,
      sql: `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ASYNC "${index.name}" ON ${dsqlIdentityTableName(schema, index.table)} ${index.definition}`,
    })),
  };
}

export type DsqlIdentitySchemaPlan = ReturnType<typeof createDsqlIdentitySchemaPlan>;
export type DsqlIdentitySchemaProgress = {
  kind: 'schema' | 'table' | 'index';
  name: string;
  status: 'attempted' | 'created' | 'ready';
  jobId?: string;
};

export interface DsqlIdentitySchemaOptions {
  /** Bounded per index; every poll is a fresh autocommit read. */
  maxIndexPolls?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Record confirmed and ambiguous ownership before caller-managed cleanup. */
  onProgress?: (progress: DsqlIdentitySchemaProgress) => void;
}

/**
 * The caller must pass an autocommit adapter, never an active transaction.
 * CREATE never uses IF NOT EXISTS: an occupied namespace is not ours to reuse.
 * No data, serving pointers, source migrations, or cleanup are changed here.
 *
 * AWS syntax and actual async status contracts:
 * https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-table-syntax-support.html
 * https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-create-index-async.html
 */
export async function initializeDsqlIdentitySchema(
  db: DsqlIdentitySchemaDatabase,
  schema: string,
  options: DsqlIdentitySchemaOptions = {}
): Promise<DsqlIdentitySchemaPlan> {
  const plan = createDsqlIdentitySchemaPlan(schema);
  return initializeDsqlEvaluationSchema(db, plan, options, 'dsql_identity');
}
