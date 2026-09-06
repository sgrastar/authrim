export const MIGRATION_SCHEMA_FAMILIES = [
  'core',
  'pii',
  'admin',
  'control',
  'lookup',
  'plugin_runner',
] as const;

export type MigrationSchemaFamily = (typeof MIGRATION_SCHEMA_FAMILIES)[number];

export const MIGRATION_MANIFEST_DIALECTS = ['sqlite', 'postgresql'] as const;
export type MigrationManifestDialect = (typeof MIGRATION_MANIFEST_DIALECTS)[number];

export const MIGRATION_TARGET_KINDS = ['cloudflare-d1', 'postgresql-connection'] as const;
export type MigrationTargetKind = (typeof MIGRATION_TARGET_KINDS)[number];

export const MIGRATION_LOGICAL_ROLES = [
  'core',
  'tenant_core',
  'pii',
  'tenant_pii',
  'admin',
  'control',
  'lookup',
  'plugin_runner',
  'custom',
  'policy',
] as const;

export type MigrationLogicalRole = (typeof MIGRATION_LOGICAL_ROLES)[number];

export function isMigrationLogicalRole(value: unknown): value is MigrationLogicalRole {
  return (
    typeof value === 'string' && (MIGRATION_LOGICAL_ROLES as readonly string[]).includes(value)
  );
}

export const MIGRATION_STREAM_IDS = [
  'core-d1',
  'pii-d1',
  'admin-d1',
  'control-d1',
  'lookup-d1',
  'plugin-runner-d1',
  'core-postgresql',
  'pii-postgresql',
] as const;

export type MigrationStreamId = (typeof MIGRATION_STREAM_IDS)[number];
export type ControlManagedMigrationStreamId = 'core-d1' | 'pii-d1' | 'lookup-d1';
export type ControlManagedMigrationDataRole =
  | 'tenant_core/default'
  | 'tenant_core/users'
  | 'tenant_pii'
  | 'lookup';

export interface MigrationStreamContract {
  id: MigrationStreamId;
  schemaFamily: MigrationSchemaFamily;
  dialect: MigrationManifestDialect;
  targetKind: MigrationTargetKind;
  logicalRoles: readonly MigrationLogicalRole[];
  directory: string;
}

export const MIGRATION_STREAM_CONTRACTS: readonly MigrationStreamContract[] = [
  {
    id: 'core-d1',
    schemaFamily: 'core',
    dialect: 'sqlite',
    targetKind: 'cloudflare-d1',
    logicalRoles: ['core', 'tenant_core'],
    directory: 'core/d1',
  },
  {
    id: 'pii-d1',
    schemaFamily: 'pii',
    dialect: 'sqlite',
    targetKind: 'cloudflare-d1',
    logicalRoles: ['pii', 'tenant_pii'],
    directory: 'pii/d1',
  },
  {
    id: 'admin-d1',
    schemaFamily: 'admin',
    dialect: 'sqlite',
    targetKind: 'cloudflare-d1',
    logicalRoles: ['admin'],
    directory: 'admin/d1',
  },
  {
    id: 'control-d1',
    schemaFamily: 'control',
    dialect: 'sqlite',
    targetKind: 'cloudflare-d1',
    logicalRoles: ['control'],
    directory: 'control/d1',
  },
  {
    id: 'lookup-d1',
    schemaFamily: 'lookup',
    dialect: 'sqlite',
    targetKind: 'cloudflare-d1',
    logicalRoles: ['lookup'],
    directory: 'lookup/d1',
  },
  {
    id: 'plugin-runner-d1',
    schemaFamily: 'plugin_runner',
    dialect: 'sqlite',
    targetKind: 'cloudflare-d1',
    logicalRoles: ['plugin_runner'],
    directory: 'plugin-runner/d1',
  },
  {
    id: 'core-postgresql',
    schemaFamily: 'core',
    dialect: 'postgresql',
    targetKind: 'postgresql-connection',
    logicalRoles: ['core', 'custom', 'policy'],
    directory: 'core/postgresql',
  },
  {
    id: 'pii-postgresql',
    schemaFamily: 'pii',
    dialect: 'postgresql',
    targetKind: 'postgresql-connection',
    logicalRoles: ['pii'],
    directory: 'pii/postgresql',
  },
] as const;

const CONTRACT_BY_ID = new Map(
  MIGRATION_STREAM_CONTRACTS.map((contract) => [contract.id, contract])
);

export function isMigrationStreamId(value: unknown): value is MigrationStreamId {
  return typeof value === 'string' && CONTRACT_BY_ID.has(value as MigrationStreamId);
}

export function migrationStreamContract(streamId: MigrationStreamId): MigrationStreamContract {
  const contract = CONTRACT_BY_ID.get(streamId);
  if (!contract) throw new Error(`migration_stream_unknown:${streamId}`);
  return contract;
}

export function resolveMigrationStreamId(input: {
  logicalRole: MigrationLogicalRole;
  targetKind: MigrationTargetKind;
}): MigrationStreamId | null {
  const candidates = MIGRATION_STREAM_CONTRACTS.filter(
    (contract) =>
      contract.targetKind === input.targetKind && contract.logicalRoles.includes(input.logicalRole)
  );
  if (candidates.length > 1) {
    throw new Error(`migration_stream_role_ambiguous:${input.logicalRole}:${input.targetKind}`);
  }
  return candidates[0]?.id ?? null;
}

export function requireMigrationStreamId(input: {
  logicalRole: MigrationLogicalRole;
  targetKind: MigrationTargetKind;
}): MigrationStreamId {
  const streamId = resolveMigrationStreamId(input);
  if (!streamId) {
    throw new Error(`migration_stream_role_not_found:${input.logicalRole}:${input.targetKind}`);
  }
  return streamId;
}

export function migrationStreamIdForControlDataRole(
  dataRole: ControlManagedMigrationDataRole
): ControlManagedMigrationStreamId {
  if (dataRole === 'tenant_pii') return 'pii-d1';
  if (dataRole === 'lookup') return 'lookup-d1';
  if (dataRole === 'tenant_core/default' || dataRole === 'tenant_core/users') return 'core-d1';
  throw new Error(`control_migration_data_role_unsupported:${String(dataRole)}`);
}

export function migrationRendererDialect(dialect: MigrationManifestDialect): 'sqlite' | 'postgres' {
  if (dialect === 'sqlite') return 'sqlite';
  if (dialect === 'postgresql') return 'postgres';
  throw new Error(`migration_manifest_dialect_unsupported:${String(dialect)}`);
}
