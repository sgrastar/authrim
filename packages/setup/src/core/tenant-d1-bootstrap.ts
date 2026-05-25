import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { webcrypto } from 'node:crypto';
import type { AuthrimConfig } from './config.js';
import type { AuthrimLock } from './lock.js';
import {
  buildInitialTenantBootstrapSql,
  createD1Database,
  executeD1Command,
  executeD1Migration,
  findMigrationsRoot,
  getKVKeyByNamespaceId,
  putKVKeyByNamespaceId,
  queryD1Rows,
  runD1Migrations,
  type D1CreateOptions,
} from './cloudflare.js';
import {
  buildTenantDatabaseAdminJobSql,
  buildTenantDatabaseSlotPlan,
  buildTenantDatabaseSlotPlans,
  buildTenantDatabaseRegistrySql,
  DEFAULT_TENANT_D1_PREALLOCATED_SLOTS,
  getLatestMigrationVersionFromDirectory,
  signTenantDatabaseRegistryResources,
  type TenantDatabaseRole,
  type TenantDatabaseRegistryResourceInput,
} from './tenant-database.js';

const TENANT_D1_STORAGE_PROFILE_ID = 'builtin:storage:tenant-d1';
const RUNTIME_REGISTRY_SNAPSHOT_VERSION = 1;
const RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM = 'Ed25519';
const RUNTIME_REGISTRY_SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;

type TenantD1BootstrapResource = TenantDatabaseRegistryResourceInput & {
  databaseName: string;
  binding: string;
  databaseId: string;
  schemaVersion: number;
};

type RuntimeRegistryPrivateJwk = {
  kty?: string;
  crv?: string;
  d?: string;
  kid?: string;
  [key: string]: unknown;
};

interface CountRow extends Record<string, unknown> {
  count: number | string;
}

export interface TenantD1BootstrapResult {
  success: boolean;
  skipped?: boolean;
  createdCount?: number;
  migratedCount?: number;
  publishedSnapshot?: boolean;
  updatedSlots?: number;
  error?: string;
}

type TenantD1DeploymentSlotState = 'pending_binding' | 'unavailable';

interface RuntimeSnapshotStore {
  tenantId: string;
  role: string;
  generation: number;
  runtimeGeneration: number;
  schemaVersion: number;
  shardGroup: string;
  shardIndex: number;
  shardCount: number;
  shardKeyStrategy: string;
  provider: string;
  driver: string;
  bindingRef: string | null;
  connectionRef: string | null;
  deploymentTarget: string | null;
  status: string;
  healthStatus: string;
  databaseId: string | null;
  databaseName: string | null;
  regionHint: string | null;
  jurisdiction: string | null;
}

interface RuntimeSnapshot {
  version: number;
  tenantId: string;
  snapshotScope: 'tenant';
  deploymentTarget: string;
  runtimeGeneration: number;
  storageProfileId: string;
  publishedAt: string;
  expiresAt: string;
  stores: RuntimeSnapshotStore[];
  metadata: {
    storeCount: number;
    roles: string[];
    signature: string | null;
    signatureKeyId: string | null;
    signatureAlgorithm?: string | null;
    signedAt?: string | null;
  };
}

function isTenantD1Profile(config: AuthrimConfig): boolean {
  return config.profiles?.defaults?.storage === TENANT_D1_STORAGE_PROFILE_ID;
}

function tenantIdForConfig(config: AuthrimConfig): string {
  return config.tenant?.name?.trim() || 'default';
}

function preallocatedSlotCountForConfig(config: AuthrimConfig): number {
  return config.tenantD1?.preallocatedSlots ?? DEFAULT_TENANT_D1_PREALLOCATED_SLOTS;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function countValue(row: CountRow | undefined): number {
  if (typeof row?.count === 'number') return row.count;
  if (typeof row?.count === 'string') return Number.parseInt(row.count, 10) || 0;
  return 0;
}

function databaseOptionsForRole(
  config: AuthrimConfig,
  role: TenantDatabaseRegistryResourceInput['role']
): D1CreateOptions | undefined {
  return role === 'tenant_core' ? config.database?.core : config.database?.pii;
}

function base64UrlEncode(input: ArrayBuffer): string {
  return Buffer.from(input).toString('base64url');
}

function canonicalizeJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('runtime_registry_snapshot_unsupported_canonical_json_value');
}

function createSnapshotSigningPayload(snapshot: RuntimeSnapshot): Uint8Array {
  const signingSnapshot: RuntimeSnapshot = {
    ...snapshot,
    metadata: {
      ...snapshot.metadata,
      signature: null,
      signatureKeyId: null,
      signatureAlgorithm: null,
      signedAt: null,
    },
  };
  return new TextEncoder().encode(canonicalizeJson(signingSnapshot));
}

async function signSnapshot(
  snapshot: RuntimeSnapshot,
  keysDir: string,
  signedAt: string
): Promise<RuntimeSnapshot> {
  const privateJwkText = await readFile(
    join(keysDir, 'tenant_runtime_registry_signing_private.jwk.json'),
    'utf-8'
  );
  const privateJwk = JSON.parse(privateJwkText) as RuntimeRegistryPrivateJwk;
  const keyIdFromFile = await readFile(
    join(keysDir, 'tenant_runtime_registry_signing_key_id.txt'),
    'utf-8'
  ).catch(() => '');
  const keyId = keyIdFromFile.trim() || privateJwk.kid || null;
  if (
    privateJwk.kty !== 'OKP' ||
    privateJwk.crv !== 'Ed25519' ||
    typeof privateJwk.d !== 'string'
  ) {
    throw new Error('runtime_registry_snapshot_signing_key_must_be_ed25519_private_jwk');
  }
  if (!keyId) {
    throw new Error('runtime_registry_snapshot_signing_key_id_required');
  }

  const cryptoKey = await webcrypto.subtle.importKey(
    'jwk',
    privateJwk,
    RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM,
    false,
    ['sign']
  );
  const signature = await webcrypto.subtle.sign(
    RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM,
    cryptoKey,
    createSnapshotSigningPayload(snapshot)
  );

  return {
    ...snapshot,
    metadata: {
      ...snapshot.metadata,
      signature: base64UrlEncode(signature),
      signatureKeyId: keyId,
      signatureAlgorithm: RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM,
      signedAt,
    },
  };
}

function buildSnapshotKey(tenantId: string, deploymentTarget = 'default'): string {
  return `tenant:${tenantId}:runtime-registry:snapshot:tenant:${deploymentTarget}`;
}

function buildGenerationKey(tenantId: string, deploymentTarget = 'default'): string {
  return `tenant:${tenantId}:runtime-registry:generation:tenant:${deploymentTarget}`;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function buildRuntimeSnapshot(input: {
  tenantId: string;
  storageProfileId: string;
  resources: TenantD1BootstrapResource[];
  now?: Date;
}): RuntimeSnapshot {
  const now = input.now ?? new Date();
  const publishedAt = now.toISOString();
  const expiresAt = addSeconds(now, RUNTIME_REGISTRY_SNAPSHOT_TTL_SECONDS).toISOString();
  const runtimeGeneration = 1;
  const stores: RuntimeSnapshotStore[] = input.resources.map((resource) => ({
    tenantId: input.tenantId,
    role: resource.role,
    generation: resource.generation,
    runtimeGeneration,
    schemaVersion: resource.schemaVersion,
    shardGroup: 'default',
    shardIndex: 0,
    shardCount: 1,
    shardKeyStrategy: 'none',
    provider: 'd1',
    driver: 'd1',
    bindingRef: resource.binding,
    connectionRef: null,
    deploymentTarget: null,
    status: 'active',
    healthStatus: 'active',
    databaseId: resource.databaseId,
    databaseName: resource.databaseName,
    regionHint: null,
    jurisdiction: null,
  }));

  return {
    version: RUNTIME_REGISTRY_SNAPSHOT_VERSION,
    tenantId: input.tenantId,
    snapshotScope: 'tenant',
    deploymentTarget: 'default',
    runtimeGeneration,
    storageProfileId: input.storageProfileId,
    publishedAt,
    expiresAt,
    stores,
    metadata: {
      storeCount: stores.length,
      roles: Array.from(new Set(stores.map((store) => store.role))).sort(),
      signature: null,
      signatureKeyId: null,
      signatureAlgorithm: null,
      signedAt: null,
    },
  };
}

async function executeAdminSql(input: {
  adminDbName: string;
  tenantId: string;
  sql: string;
}): Promise<void> {
  const sqlPath = join(
    tmpdir(),
    `authrim-initial-tenant-d1-${input.tenantId.replace(/[^A-Za-z0-9_-]+/g, '-')}-${Date.now()}.sql`
  );
  await writeFile(sqlPath, input.sql, 'utf-8');
  try {
    const result = await executeD1Migration(input.adminDbName, sqlPath);
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to write initial tenant database registry rows');
    }
  } finally {
    await unlink(sqlPath).catch(() => {});
  }
}

function buildTenantDatabaseSlotsSql(input: {
  lock: AuthrimLock;
  env: string;
  slotCount: number;
  assignedTenantId: string;
  assignedSlotNumber: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const statements: string[] = [];
  const protectedStates = "'assigned', 'reserved', 'reset_required', 'retired'";
  for (const slot of buildTenantDatabaseSlotPlans({ env: input.env, slots: input.slotCount })) {
    const core = slot.resources.find((resource) => resource.role === 'tenant_core');
    const pii = slot.resources.find((resource) => resource.role === 'tenant_pii');
    if (!core || !pii) {
      throw new Error(`tenant_database_slot_plan_missing_roles:${slot.slotId}`);
    }
    const lockedCore = input.lock.d1[core.binding];
    const lockedPii = input.lock.d1[pii.binding];
    if (!lockedCore || !lockedPii) {
      throw new Error(`tenant_database_slot_lock_missing:${slot.slotId}`);
    }
    const state = slot.slotNumber === input.assignedSlotNumber ? 'assigned' : 'available';
    const assignedTenantId =
      slot.slotNumber === input.assignedSlotNumber ? sqlString(input.assignedTenantId) : 'NULL';
    const assignedAt = slot.slotNumber === input.assignedSlotNumber ? String(now) : 'NULL';
    statements.push(`INSERT INTO tenant_database_slots (
  slot_id, slot_number, core_binding_ref, pii_binding_ref,
  core_database_name, pii_database_name, core_database_id, pii_database_id,
  state, assigned_tenant_id, reserved_by, reserved_at, assigned_at, created_at, updated_at
) VALUES (
  '${slot.slotId}', ${slot.slotNumber}, '${core.binding}', '${pii.binding}',
  '${lockedCore.name}', '${lockedPii.name}', '${lockedCore.id}', '${lockedPii.id}',
  '${state}', ${assignedTenantId}, NULL, NULL, ${assignedAt}, ${now}, ${now}
) ON CONFLICT(slot_id) DO UPDATE SET
  core_binding_ref = excluded.core_binding_ref,
  pii_binding_ref = excluded.pii_binding_ref,
  core_database_name = excluded.core_database_name,
  pii_database_name = excluded.pii_database_name,
  core_database_id = excluded.core_database_id,
  pii_database_id = excluded.pii_database_id,
  state = CASE
    WHEN tenant_database_slots.state IN (${protectedStates})
    THEN tenant_database_slots.state
    ELSE excluded.state
  END,
  assigned_tenant_id = CASE
    WHEN tenant_database_slots.state IN (${protectedStates})
    THEN tenant_database_slots.assigned_tenant_id
    ELSE excluded.assigned_tenant_id
  END,
  reserved_by = CASE
    WHEN tenant_database_slots.state IN (${protectedStates})
    THEN tenant_database_slots.reserved_by
    ELSE excluded.reserved_by
  END,
  reserved_at = CASE
    WHEN tenant_database_slots.state IN (${protectedStates})
    THEN tenant_database_slots.reserved_at
    ELSE excluded.reserved_at
  END,
  assigned_at = CASE
    WHEN tenant_database_slots.state IN (${protectedStates})
    THEN tenant_database_slots.assigned_at
    ELSE excluded.assigned_at
  END,
  updated_at = excluded.updated_at;`);
  }
  return statements.join('\n\n');
}

export function buildTenantDatabaseSlotDeploymentStateSql(input: {
  lock: AuthrimLock;
  env: string;
  slotCount: number;
  state: TenantD1DeploymentSlotState;
  stage: string;
  errorCode?: string | null;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const statements: string[] = [];
  const protectedStates = "'assigned', 'reserved', 'reset_required', 'retired'";
  const stateSql = sqlString(input.state);
  const stageSql = sqlString(input.stage);
  const errorCodeSql = input.errorCode ? sqlString(input.errorCode.slice(0, 500)) : 'NULL';

  for (const slot of buildTenantDatabaseSlotPlans({ env: input.env, slots: input.slotCount })) {
    const core = slot.resources.find((resource) => resource.role === 'tenant_core');
    const pii = slot.resources.find((resource) => resource.role === 'tenant_pii');
    if (!core || !pii) {
      throw new Error(`tenant_database_slot_plan_missing_roles:${slot.slotId}`);
    }
    const lockedCore = input.lock.d1[core.binding];
    const lockedPii = input.lock.d1[pii.binding];
    if (!lockedCore || !lockedPii) {
      throw new Error(`tenant_database_slot_lock_missing:${slot.slotId}`);
    }
    const slotIdSql = sqlString(slot.slotId);
    const auditIdSql = sqlString(`tenant-d1-slot:${input.stage}:${slot.slotId}:${now}`);

    statements.push(`INSERT INTO tenant_database_slots (
  slot_id, slot_number, core_binding_ref, pii_binding_ref,
  core_database_name, pii_database_name, core_database_id, pii_database_id,
  state, assigned_tenant_id, reserved_by, reserved_at, assigned_at, created_at, updated_at
) VALUES (
  ${slotIdSql}, ${slot.slotNumber}, ${sqlString(core.binding)}, ${sqlString(pii.binding)},
  ${sqlString(lockedCore.name)}, ${sqlString(lockedPii.name)}, ${sqlString(lockedCore.id)}, ${sqlString(lockedPii.id)},
  ${stateSql}, NULL, NULL, NULL, NULL, ${now}, ${now}
) ON CONFLICT(slot_id) DO UPDATE SET
  core_binding_ref = excluded.core_binding_ref,
  pii_binding_ref = excluded.pii_binding_ref,
  core_database_name = excluded.core_database_name,
  pii_database_name = excluded.pii_database_name,
  core_database_id = excluded.core_database_id,
  pii_database_id = excluded.pii_database_id,
  state = CASE
    WHEN tenant_database_slots.state IN (${protectedStates})
    THEN tenant_database_slots.state
    ELSE excluded.state
  END,
  assigned_tenant_id = CASE
    WHEN tenant_database_slots.state IN (${protectedStates})
    THEN tenant_database_slots.assigned_tenant_id
    ELSE NULL
  END,
  reserved_by = CASE
    WHEN tenant_database_slots.state IN (${protectedStates})
    THEN tenant_database_slots.reserved_by
    ELSE NULL
  END,
  reserved_at = CASE
    WHEN tenant_database_slots.state IN (${protectedStates})
    THEN tenant_database_slots.reserved_at
    ELSE NULL
  END,
  assigned_at = CASE
    WHEN tenant_database_slots.state IN (${protectedStates})
    THEN tenant_database_slots.assigned_at
    ELSE NULL
  END,
  updated_at = excluded.updated_at;

INSERT INTO tenant_database_slot_audit_events (
  id, tenant_id, slot_id, stage, actor, result, error_code, request_id, metadata_json, created_at
) VALUES (
  ${auditIdSql}, NULL, ${slotIdSql}, ${stageSql}, 'setup', 'failed', ${errorCodeSql}, NULL,
  ${sqlString(JSON.stringify({ state: input.state }))}, ${now}
) ON CONFLICT(id) DO NOTHING;`);
  }

  return statements.join('\n\n');
}

function registryResourceFromSlot(input: {
  lock: AuthrimLock;
  env: string;
  slotNumber: number;
  role: TenantDatabaseRole;
  generation: number;
  schemaVersion: number;
}): TenantD1BootstrapResource {
  const slot = buildTenantDatabaseSlotPlan({ env: input.env, slotNumber: input.slotNumber });
  const resource = slot.resources.find((candidate) => candidate.role === input.role);
  if (!resource) {
    throw new Error(`tenant_database_slot_role_missing:${slot.slotId}:${input.role}`);
  }
  const locked = input.lock.d1[resource.binding];
  if (!locked) {
    throw new Error(`tenant_database_slot_binding_missing:${resource.binding}`);
  }
  return {
    role: resource.role,
    databaseName: locked.name,
    binding: resource.binding,
    generation: input.generation,
    databaseId: locked.id,
    schemaVersion: input.schemaVersion,
    status: 'active',
  };
}

async function verifyInitialTenantD1Bootstrap(input: {
  adminDbName: string;
  runtimeRegistryNamespaceId: string;
  tenantId: string;
  slotId: string;
  coreDatabaseName: string;
}): Promise<void> {
  const tenantIdSql = sqlString(input.tenantId);
  const slotIdSql = sqlString(input.slotId);
  const [slotRow] = await queryD1Rows<CountRow>(
    input.adminDbName,
    `SELECT COUNT(*) AS count
       FROM tenant_database_slots
      WHERE slot_id = ${slotIdSql}
        AND state = 'assigned'
        AND assigned_tenant_id = ${tenantIdSql};`
  );
  if (countValue(slotRow) !== 1) {
    throw new Error('initial_tenant_d1_slot_assignment_verification_failed');
  }

  const [pointerRow] = await queryD1Rows<CountRow>(
    input.adminDbName,
    `SELECT COUNT(*) AS count
       FROM tenant_database_active_pointers
      WHERE tenant_id = ${tenantIdSql}
        AND role IN ('tenant_core', 'tenant_pii')
        AND status = 'active';`
  );
  if (countValue(pointerRow) !== 2) {
    throw new Error('initial_tenant_d1_active_pointer_verification_failed');
  }

  const [tenantRow] = await queryD1Rows<CountRow>(
    input.coreDatabaseName,
    `SELECT COUNT(*) AS count
       FROM tenants
      WHERE id = ${tenantIdSql}
        AND is_active = 1;`
  );
  if (countValue(tenantRow) !== 1) {
    throw new Error('initial_tenant_d1_core_tenant_verification_failed');
  }

  const snapshotText = await getKVKeyByNamespaceId(
    input.runtimeRegistryNamespaceId,
    buildSnapshotKey(input.tenantId)
  );
  const snapshot = JSON.parse(snapshotText) as Partial<RuntimeSnapshot>;
  if (
    snapshot.tenantId !== input.tenantId ||
    snapshot.storageProfileId !== TENANT_D1_STORAGE_PROFILE_ID ||
    !Array.isArray(snapshot.stores) ||
    snapshot.stores.length < 2
  ) {
    throw new Error('initial_tenant_d1_runtime_snapshot_smoke_failed');
  }
}

export async function ensureInitialTenantD1Resources(input: {
  env: string;
  config: AuthrimConfig;
  lock: AuthrimLock;
  rootDir: string;
  onProgress?: (message: string) => void;
}): Promise<TenantD1BootstrapResult> {
  if (!isTenantD1Profile(input.config)) {
    return { success: true, skipped: true };
  }

  const slotCount = preallocatedSlotCountForConfig(input.config);
  const slotPlans = buildTenantDatabaseSlotPlans({ env: input.env, slots: slotCount });
  let createdCount = 0;

  try {
    input.onProgress?.(`🔧 Ensuring preallocated tenant D1 slots exist (${slotCount} slots)...`);
    for (const slot of slotPlans) {
      for (const resource of slot.resources) {
        const existing = input.lock.d1[resource.binding];
        if (existing) {
          input.onProgress?.(`  ✓ ${resource.binding} already locked`);
          continue;
        }
        const database = await createD1Database(
          resource.databaseName,
          databaseOptionsForRole(input.config, resource.role)
        );
        input.lock.d1[resource.binding] = {
          id: database.id,
          name: database.name,
        };
        createdCount += 1;
        input.onProgress?.(`  ✓ ${resource.binding} -> ${database.name}`);
      }
    }

    const migrationsRoot = await findMigrationsRoot(input.rootDir, input.onProgress);
    if (!migrationsRoot.path) {
      throw new Error(
        `Migrations directory not found. Searched: ${migrationsRoot.searchPaths.join(', ')}`
      );
    }

    for (const slot of slotPlans) {
      for (const resource of slot.resources) {
        const locked = input.lock.d1[resource.binding];
        if (!locked) {
          throw new Error(`tenant_d1_slot_binding_missing:${resource.binding}`);
        }
        const migrationPath =
          resource.role === 'tenant_core' ? migrationsRoot.path : join(migrationsRoot.path, 'pii');
        const result = await runD1Migrations(locked.name, migrationPath, input.onProgress);
        if (!result.success) {
          throw new Error(
            `${resource.role} tenant D1 migration failed for ${resource.binding}: ${result.error}`
          );
        }
      }
    }

    const initialSlot = buildTenantDatabaseSlotPlan({ env: input.env, slotNumber: 1 });
    const initialCore = initialSlot.resources.find((resource) => resource.role === 'tenant_core');
    const initialCoreDatabase = initialCore ? input.lock.d1[initialCore.binding]?.name : undefined;
    if (!initialCoreDatabase) {
      throw new Error('initial_tenant_d1_slot_core_missing');
    }
    input.onProgress?.(`🔧 Ensuring initial tenant exists in ${initialCoreDatabase}...`);
    await executeD1Command(initialCoreDatabase, buildInitialTenantBootstrapSql(input.config));

    return {
      success: true,
      createdCount,
      migratedCount: slotPlans.reduce((count, slot) => count + slot.resources.length, 0),
    };
  } catch (error) {
    return {
      success: false,
      createdCount,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function markTenantD1SlotsDeploymentState(input: {
  env: string;
  config: AuthrimConfig;
  lock: AuthrimLock;
  state: TenantD1DeploymentSlotState;
  stage: string;
  errorCode?: string | null;
  onProgress?: (message: string) => void;
}): Promise<TenantD1BootstrapResult> {
  if (!isTenantD1Profile(input.config)) {
    return { success: true, skipped: true };
  }

  const adminDbName = input.lock.d1.DB_ADMIN?.name;
  if (!adminDbName) {
    return { success: false, error: 'DB_ADMIN is missing from the lock file' };
  }

  try {
    const slotCount = preallocatedSlotCountForConfig(input.config);
    input.onProgress?.(
      `Marking tenant D1 slots ${input.state} after ${input.stage} (${slotCount} slots)...`
    );
    await executeAdminSql({
      adminDbName,
      tenantId: tenantIdForConfig(input.config),
      sql: buildTenantDatabaseSlotDeploymentStateSql({
        lock: input.lock,
        env: input.env,
        slotCount,
        state: input.state,
        stage: input.stage,
        errorCode: input.errorCode,
      }),
    });
    return { success: true, updatedSlots: slotCount };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function publishInitialTenantD1RuntimeSnapshot(input: {
  env: string;
  config: AuthrimConfig;
  lock: AuthrimLock;
  rootDir: string;
  keysDir: string;
  onProgress?: (message: string) => void;
}): Promise<TenantD1BootstrapResult> {
  if (!isTenantD1Profile(input.config)) {
    return { success: true, skipped: true };
  }

  const tenantId = tenantIdForConfig(input.config);
  const adminDbName = input.lock.d1.DB_ADMIN?.name;
  const runtimeRegistryNamespaceId = input.lock.kv.TENANT_RUNTIME_REGISTRY?.id;
  if (!adminDbName) {
    return { success: false, error: 'DB_ADMIN is missing from the lock file' };
  }
  if (!runtimeRegistryNamespaceId) {
    return { success: false, error: 'TENANT_RUNTIME_REGISTRY KV is missing from the lock file' };
  }

  try {
    const slotCount = preallocatedSlotCountForConfig(input.config);
    const migrationsRoot = await findMigrationsRoot(input.rootDir, input.onProgress);
    if (!migrationsRoot.path) {
      throw new Error(
        `Migrations directory not found. Searched: ${migrationsRoot.searchPaths.join(', ')}`
      );
    }
    const migrationsRootPath = migrationsRoot.path;

    const assignedSlotNumber = 1;
    const coreSchemaVersion = getLatestMigrationVersionFromDirectory(migrationsRootPath);
    const piiSchemaVersion = getLatestMigrationVersionFromDirectory(
      join(migrationsRootPath, 'pii')
    );
    const resources: TenantD1BootstrapResource[] = [
      registryResourceFromSlot({
        lock: input.lock,
        env: input.env,
        slotNumber: assignedSlotNumber,
        role: 'tenant_core',
        generation: 1,
        schemaVersion: coreSchemaVersion,
      }),
      registryResourceFromSlot({
        lock: input.lock,
        env: input.env,
        slotNumber: assignedSlotNumber,
        role: 'tenant_pii',
        generation: 1,
        schemaVersion: piiSchemaVersion,
      }),
    ];
    const registryResources = signTenantDatabaseRegistryResources({
      tenantId,
      signatureConfig: null,
      resources,
    });
    const registrySql = buildTenantDatabaseRegistrySql({
      tenantId,
      tenantSlug: tenantId,
      resources: registryResources,
      activate: true,
      activePointerMode: 'preserve_existing_generation',
    });
    const jobSql = buildTenantDatabaseAdminJobSql({
      jobId: `initial-tenant-d1-bootstrap:${tenantId}:1`,
      tenantId,
      jobType: 'tenant-database/provision',
      status: 'completed',
      createdBy: 'setup',
      progress: {
        total: resources.length,
        processed: resources.length,
        succeeded: resources.length,
        failed: 0,
        stage: 'activated',
      },
      config: {
        env: input.env,
        tenant_slug: tenantId,
        generation: 1,
        activate: true,
        source: 'initial_setup',
      },
      result: {
        resources: resources.map((resource) => ({
          role: resource.role,
          database_name: resource.databaseName,
          binding: resource.binding,
          database_id: resource.databaseId,
          schema_version: resource.schemaVersion,
        })),
      },
    });

    input.onProgress?.(`🔧 Publishing initial tenant D1 runtime snapshot (${tenantId})...`);
    await executeAdminSql({
      adminDbName,
      tenantId,
      sql: `${buildTenantDatabaseSlotsSql({
        lock: input.lock,
        env: input.env,
        slotCount,
        assignedTenantId: tenantId,
        assignedSlotNumber,
      })}\n\n${registrySql}\n\n${jobSql}`,
    });

    const signedAt = new Date().toISOString();
    const snapshot = await signSnapshot(
      buildRuntimeSnapshot({
        tenantId,
        storageProfileId: TENANT_D1_STORAGE_PROFILE_ID,
        resources,
        now: new Date(signedAt),
      }),
      input.keysDir,
      signedAt
    );
    const generation = {
      runtimeGeneration: snapshot.runtimeGeneration,
      publishedAt: snapshot.publishedAt,
      expiresAt: snapshot.expiresAt,
    };
    await putKVKeyByNamespaceId(
      runtimeRegistryNamespaceId,
      buildSnapshotKey(tenantId),
      JSON.stringify(snapshot),
      { expirationTtl: RUNTIME_REGISTRY_SNAPSHOT_TTL_SECONDS }
    );
    await putKVKeyByNamespaceId(
      runtimeRegistryNamespaceId,
      buildGenerationKey(tenantId),
      JSON.stringify(generation),
      { expirationTtl: RUNTIME_REGISTRY_SNAPSHOT_TTL_SECONDS }
    );

    input.onProgress?.(`🔎 Verifying initial tenant D1 bootstrap (${tenantId})...`);
    await verifyInitialTenantD1Bootstrap({
      adminDbName,
      runtimeRegistryNamespaceId,
      tenantId,
      slotId: buildTenantDatabaseSlotPlan({ env: input.env, slotNumber: assignedSlotNumber })
        .slotId,
      coreDatabaseName: resources.find((resource) => resource.role === 'tenant_core')!.databaseName,
    });

    input.onProgress?.(`  ✅ Initial tenant D1 runtime snapshot published: ${tenantId}`);
    return {
      success: true,
      publishedSnapshot: true,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
