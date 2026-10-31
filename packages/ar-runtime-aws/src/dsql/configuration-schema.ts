import { createHash } from 'node:crypto';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../import/postgres-restore-table-contract';
import type { DsqlIdentitySchemaDatabase, DsqlIdentitySchemaOptions } from './identity-schema';
import { initializeDsqlEvaluationSchema } from './schema-evaluator';

export type DsqlConfigurationTableName =
  | 'identity_providers'
  | 'flows'
  | 'flow_versions'
  | 'flow_assignments';
export function assertDsqlConfigurationSchemaName(schema: string): void {
  if (!/^authrim_dsql_configuration_[a-f0-9]{32}$/u.test(schema))
    throw new Error('dsql_configuration_schema_invalid');
}
export function dsqlConfigurationTableName(
  schema: string,
  name: DsqlConfigurationTableName
): string {
  assertDsqlConfigurationSchemaName(schema);
  if (!['identity_providers', 'flows', 'flow_versions', 'flow_assignments'].includes(name))
    throw new Error('dsql_configuration_table_invalid');
  return `"${schema}"."${name}"`;
}

// Explicit, reviewed snapshot of the existing PostgreSQL configuration contract.
// Neither migrations nor PostgreSQL's serving path are rewritten. Unsupported native
// DSQL constraints must fail initialization; they must never be stripped to pass a probe.
function tableDefinitions(schema: string): Record<DsqlConfigurationTableName, string> {
  return {
    identity_providers: `id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default'`,
    flows: `id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    client_id text,
    profile_id text,
    name text NOT NULL,
    description text,
    graph_definition text,
    compiled_plan text,
    version text DEFAULT '1.0.0'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_builtin boolean DEFAULT false NOT NULL,
    created_by text,
    created_at bigint NOT NULL,
    updated_by text,
    updated_at bigint NOT NULL,
    slug text,
    display_name text,
    kind text DEFAULT 'login'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    draft_editor_json text,
    draft_runtime_base_json text,
    published_version_id text,
    deleted_at bigint,
    template_id text,
CONSTRAINT flows_pkey PRIMARY KEY (id)`,
    flow_versions: `id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    flow_id text NOT NULL,
    version_number integer NOT NULL,
    schema_version text NOT NULL,
    runtime_snapshot_json text NOT NULL,
    editor_snapshot_json text,
    validation_result_json text NOT NULL,
    published_by text,
    published_at bigint NOT NULL,
    created_at bigint NOT NULL,
CONSTRAINT flow_versions_pkey PRIMARY KEY (id),
CONSTRAINT flow_versions_unique_version UNIQUE (tenant_id, flow_id, version_number),
CONSTRAINT flow_versions_flow_fk FOREIGN KEY (flow_id) REFERENCES ${dsqlConfigurationTableName(schema, 'flows')}(id) ON DELETE CASCADE`,
    flow_assignments: `id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    target_type text NOT NULL,
    target_id text,
    flow_kind text NOT NULL,
    flow_id text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT flow_assignments_target_id_check CHECK ((((target_type = 'tenant'::text) AND (target_id IS NULL)) OR ((target_type = ANY (ARRAY['oidc_client'::text, 'saml_sp'::text, 'credential_profile'::text])) AND (target_id IS NOT NULL)))),
    CONSTRAINT flow_assignments_target_type_check CHECK ((target_type = ANY (ARRAY['tenant'::text, 'oidc_client'::text, 'saml_sp'::text, 'credential_profile'::text]))),
CONSTRAINT flow_assignments_pkey PRIMARY KEY (id),
CONSTRAINT flow_assignments_flow_fk FOREIGN KEY (flow_id) REFERENCES ${dsqlConfigurationTableName(schema, 'flows')}(id) ON DELETE CASCADE`,
  };
}

const INDEX_DEFINITIONS = [
  {
    table: 'identity_providers',
    name: 'idx_identity_providers_type',
    unique: false,
    definition: '(provider_type)',
  },
  {
    table: 'identity_providers',
    name: 'idx_identity_providers_saml_entity_id',
    unique: true,
    definition:
      "(\n    tenant_id,\n    provider_type,\n    (CASE\n      WHEN config_json IS JSON THEN\n        CASE\n          WHEN jsonb_typeof(config_json::jsonb -> 'entityId') = 'string'\n            THEN config_json::jsonb ->> 'entityId'\n        END\n    END)\n  )\n  WHERE provider_type IN ('saml_idp', 'saml_sp')",
  },
  {
    table: 'flows',
    name: 'idx_flows_runtime_kind_status',
    unique: false,
    definition: '(tenant_id, kind, status)',
  },
  {
    table: 'flows',
    name: 'idx_flows_runtime_slug',
    unique: true,
    definition: '(tenant_id, slug) WHERE (deleted_at IS NULL)',
  },
  {
    table: 'flows',
    name: 'idx_flows_template_id',
    unique: false,
    definition: '(tenant_id, template_id)',
  },
  {
    table: 'flow_versions',
    name: 'idx_flow_versions_lookup',
    unique: false,
    definition: '(tenant_id, flow_id, version_number)',
  },
  {
    table: 'flow_versions',
    name: 'idx_flow_versions_published',
    unique: false,
    definition: '(tenant_id, flow_id, published_at)',
  },
  {
    table: 'flow_assignments',
    name: 'idx_flow_assignments_flow',
    unique: false,
    definition: '(tenant_id, flow_id)',
  },
  {
    table: 'flow_assignments',
    name: 'idx_flow_assignments_target',
    unique: true,
    definition: '(tenant_id, target_type, target_id, flow_kind) WHERE (target_id IS NOT NULL)',
  },
  {
    table: 'flow_assignments',
    name: 'idx_flow_assignments_target_unique',
    unique: true,
    definition: '(tenant_id, target_type, target_id, flow_kind) WHERE (target_id IS NOT NULL)',
  },
  {
    table: 'flow_assignments',
    name: 'idx_flow_assignments_tenant_default',
    unique: true,
    definition:
      "(tenant_id, flow_kind) WHERE ((target_type = 'tenant'::text) AND (target_id IS NULL))",
  },
  {
    table: 'flow_assignments',
    name: 'idx_flow_assignments_tenant_default_unique',
    unique: true,
    definition:
      "(tenant_id, flow_kind) WHERE ((target_type = 'tenant'::text) AND (target_id IS NULL))",
  },
] as const;

export function createDsqlConfigurationSchemaPlan(schema: string) {
  assertDsqlConfigurationSchemaName(schema);
  const definitions = tableDefinitions(schema);
  const names = Object.keys(definitions) as DsqlConfigurationTableName[];
  const contracts = names.map((name) => {
    const contract = POSTGRES_RESTORE_TABLE_CONTRACTS.find((item) => item.table === name);
    if (!contract) throw new Error('dsql_configuration_contract_missing');
    return contract;
  });
  // Schema names cannot affect the reusable schema contract digest.
  const canonicalDefinitions = tableDefinitions(`authrim_dsql_configuration_${'0'.repeat(32)}`);
  return {
    formatVersion: 1 as const,
    scope: 'configuration-staging-experiment' as const,
    fullRuntimeReady: false as const,
    schema,
    sourceContractFingerprint: createHash('sha256')
      .update(
        JSON.stringify({ contracts, tables: canonicalDefinitions, indexes: INDEX_DEFINITIONS })
      )
      .digest('hex'),
    tables: names.map((name, index) => ({
      name,
      datasetId: contracts[index].datasetId,
      columns: [...contracts[index].columns],
      sql: `CREATE TABLE ${dsqlConfigurationTableName(schema, name)} (${definitions[name]})`,
    })),
    indexes: INDEX_DEFINITIONS.map((index) => ({
      name: index.name,
      table: index.table,
      unique: index.unique,
      sql: `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ASYNC "${index.name}" ON ${dsqlConfigurationTableName(schema, index.table)} ${index.definition}`,
    })),
  };
}
export type DsqlConfigurationSchemaPlan = ReturnType<typeof createDsqlConfigurationSchemaPlan>;
export async function initializeDsqlConfigurationSchema(
  db: DsqlIdentitySchemaDatabase,
  schema: string,
  options: DsqlIdentitySchemaOptions = {}
): Promise<DsqlConfigurationSchemaPlan> {
  return initializeDsqlEvaluationSchema(
    db,
    createDsqlConfigurationSchemaPlan(schema),
    options,
    'dsql_configuration'
  );
}
