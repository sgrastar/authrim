// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS, type AdminAuthContext } from '@authrim/ar-lib-core';
import { TenantBackupRequestStore } from '@authrim/ar-lib-core/services/tenant-portability/operation-request';
import type { TenantBackupImportAuthority } from '@authrim/ar-lib-core/services/tenant-portability/operation-request';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { createPhase8SqliteInspectionPolicies } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-references';
import type { PlannedInstalledSqliteDataset } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import type { SqliteDatasetInspectionPolicy } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { planPhase8InstalledSqliteResources } from '../tenant-backup-phase8-plan-loader';
import { createSqliteDatasetInspectorFactory } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import {
  ADMIN_ROLE_ASSIGNMENTS_DATASET,
  ADMIN_ROLES_DATASET,
  createTenantBackupRestoreAuthorityGuard,
  TENANT_SETTINGS_DOCUMENTS_DATASET,
  tenantBackupImportAuthority,
} from '../tenant-backup-restore-authority';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const REFUSED = 'backup_restore_authority_required';

function freshDatabase(family: 'core' | 'pii' | 'admin') {
  const database = new DatabaseSync(':memory:');
  const directory = `${root}migrations/${family}/d1`;
  for (const file of readdirSync(directory)
    .filter((name: string) => name.endsWith('.sql'))
    .sort())
    database.exec(
      readFileSync(`${directory}/${file}`, 'utf8')
        .replaceAll(
          '__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__',
          "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))"
        )
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
  return database;
}

function adapter(database: DatabaseSync) {
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return database.prepare(sql).all(...params) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
      return (database.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      return { success: true, rowsAffected: Number(database.prepare(sql).run(...params).changes) };
    },
  };
}

const selection = {
  settings: true,
  users: false,
  admin: true,
  artifacts: false,
  logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
};
const tenantAdmin = {
  userId: 'tenant-admin',
  tenantId: 'tenant-a',
  authMethod: 'session',
  actorType: 'human',
  roles: ['super_admin'],
  globalRoles: [],
  tenantScope: ['tenant-a'],
  permissions: ['*'],
  globalPermissions: [],
  hierarchyLevel: 100,
  globalHierarchyLevel: 0,
} as unknown as AdminAuthContext;
const platformOperator = {
  ...tenantAdmin,
  userId: 'platform-admin',
  globalRoles: ['super_admin'],
  tenantScope: ['*'],
  globalPermissions: ['*'],
  globalHierarchyLevel: 100,
} as unknown as AdminAuthContext;

let admin: DatabaseSync;
/** The validated `admin.admin_roles` rows of the bundle being restored. */
let bundleRoles: string[] = [];
let policies: Map<string, SqliteDatasetInspectionPolicy>;
let operations = 0;
/** The datasets planned from the installed schemas, which every test's databases share. */
let planned: PlannedInstalledSqliteDataset[];

// Planning reads the complete schema of three freshly migrated databases (about 0.7 s here, more
// than 5 s a test on a loaded CI runner), and only the schema, so it is done once for the file.
beforeAll(async () => {
  const databases = {
    core: freshDatabase('core'),
    pii: freshDatabase('pii'),
    admin: freshDatabase('admin'),
  };
  planned = await planPhase8InstalledSqliteResources(
    (Object.keys(databases) as (keyof typeof databases)[]).map((family) => ({
      resourceId: `${family}-db`,
      family,
      database: adapter(databases[family]),
    })),
    new AbortController().signal
  );
  for (const database of Object.values(databases)) database.close();
});

async function realPolicies() {
  return createPhase8SqliteInspectionPolicies(planned, {
    tenantKey: 'target-key',
    validateAdminEnvelope: async () => {},
    validatePhase8Envelope: async () => {},
    // As the frozen Admin mapping does: source admins become the approver's chosen targets.
    resolveAdminReference: async (_context, sourceAdminId) => `mapped-${sourceAdminId}`,
    resolvePluginReference: async (_context, id) => id,
    restoreHold: { write: async () => {}, verify: async () => {} },
  });
}

/** A stored import request of `authority` (or one recorded before authority was), as the route makes it. */
async function importRequest(authority: TenantBackupImportAuthority | null, tenantId = 'tenant-a') {
  const id = `operation-${++operations}`;
  await new TenantBackupRequestStore(adapter(admin)).create({
    id,
    tenantId,
    actorId: authority?.actorId ?? 'legacy-admin',
    idempotencyKey: id,
    intent: {
      version: 1,
      kind: 'import',
      source: { tenantId, issuer: 'https://tenant.example', productVersion: '0.4.2' },
      selection,
      inputs: [{ id: 'upload-a', digestSha256: 'aa'.repeat(32) }],
      ...(authority ? { authority } : {}),
    },
    now: 1,
  });
  return {
    lease: { tenantId, operationId: id, owner: 'worker', fencingToken: 1 },
  } as unknown as TenantBackupStepContext;
}

function guarded() {
  const guard = createTenantBackupRestoreAuthorityGuard({
    database: adapter(admin),
    loadBundleRoles: async () => bundleRoles,
  });
  return new Map(
    guard
      .wrap([
        policies.get(TENANT_SETTINGS_DOCUMENTS_DATASET)!,
        policies.get(ADMIN_ROLE_ASSIGNMENTS_DATASET)!,
        policies.get(ADMIN_ROLES_DATASET)!,
      ])
      .map((policy) => [policy.dataset.id, policy])
  );
}

const settingsRow = (category: string, scopeType = 'tenant') =>
  JSON.stringify({
    tenant_id: ['text', 'tenant-a'],
    scope_type: ['text', scopeType],
    scope_id: ['text', scopeType === 'tenant' ? 'tenant-a' : 'client-a'],
    category: ['text', category],
    document_json: ['text', '{"institution.scopes":["other-university.example"]}'],
  });
const assignmentRow = (scopeType: string, roleId: string) =>
  JSON.stringify({
    id: ['text', `assignment-${scopeType}-${roleId}`],
    tenant_id: ['text', 'tenant-a'],
    admin_user_id: ['text', 'source-admin'],
    admin_role_id: ['text', roleId],
    scope_type: ['text', scopeType],
    scope_id: scopeType === 'tenant' ? ['text', 'tenant-a'] : ['null', null],
  });

/** Validation admission, then the restore's write and verification of the same row. */
async function restore(
  datasetId: string,
  context: TenantBackupStepContext,
  rowJson: string
): Promise<string> {
  const policy = guarded().get(datasetId)!;
  await policy.admitRow!.admit(context, rowJson);
  const written = await policy.restoreTransform!.transform(context, rowJson, 'write');
  await policy.restoreTransform!.transform(context, rowJson, 'verify');
  return written;
}

beforeEach(async () => {
  bundleRoles = [];
  admin = freshDatabase('admin');
  policies = new Map((await realPolicies()).map((policy) => [policy.dataset.id, policy]));
  // What the shared Admin database already holds: the platform's own global super_admin, an
  // institution document the platform set for this provisioning tenant, and a custom role the
  // bundle restored earlier in the sequence.
  admin.exec(`
    INSERT INTO admin_users(id,tenant_id,email,name,password_hash,is_active,status,created_at,updated_at)
    VALUES ('platform-admin','default','platform@example.test','Platform','x',1,'active',1,1);
    INSERT INTO admin_role_assignments(id,tenant_id,admin_user_id,admin_role_id,scope_type,scope_id,assigned_by,created_at)
    VALUES ('platform-assignment','default','platform-admin','role_super_admin','global',NULL,'setup',1);
    INSERT INTO tenant_settings_documents(
      tenant_id,scope_type,scope_id,category,document_json,version,revision,projection_state,updated_at
    ) VALUES ('tenant-a','tenant','tenant-a','institution','{}','sha256:${'c'.repeat(16)}',1,'pending',1);
    INSERT INTO admin_roles(id,tenant_id,name,display_name,permissions_json,hierarchy_level,role_type,is_system,created_at,updated_at)
    VALUES ('restored-operator','tenant-a','operator','Operator','["*"]',10,'custom',0,1,1);
  `);
});
afterEach(() => admin.close());

describe('what an import requester may grant', () => {
  it('records no platform-only settings or global Admin authority for a tenant-only super_admin', () => {
    expect(tenantBackupImportAuthority(tenantAdmin, 'tenant-admin')).toEqual({
      actorId: 'tenant-admin',
      platformSettingsCategories: [],
      globalAdmin: { permitted: false, hierarchyLevel: 0 },
    });
  });

  it('records the institution settings and the global level of a platform operator', () => {
    expect(tenantBackupImportAuthority(platformOperator, 'platform-admin')).toEqual({
      actorId: 'platform-admin',
      platformSettingsCategories: ['institution'],
      globalAdmin: { permitted: true, hierarchyLevel: 100 },
    });
  });

  it('records no global Admin authority without the global wildcard', () => {
    const globalAdmin = {
      ...platformOperator,
      globalRoles: ['admin'],
      globalPermissions: [ADMIN_PERMISSIONS.BACKUPS_IMPORT],
      globalHierarchyLevel: 80,
    } as unknown as AdminAuthContext;
    expect(tenantBackupImportAuthority(globalAdmin, 'platform-admin').globalAdmin).toEqual({
      permitted: false,
      hierarchyLevel: 0,
    });
  });
});

describe('settings only the platform may change for a tenant', () => {
  it('refuses a tenant-only requester the bundle institution document at validation and restore', async () => {
    const context = await importRequest(tenantBackupImportAuthority(tenantAdmin, 'tenant-admin'));
    const policy = guarded().get(TENANT_SETTINGS_DOCUMENTS_DATASET)!;
    for (const row of [settingsRow('institution'), settingsRow('institution', 'client')]) {
      await expect(policy.admitRow!.admit(context, row)).rejects.toThrow(REFUSED);
      await expect(policy.restoreTransform!.transform(context, row, 'write')).rejects.toThrow(
        REFUSED
      );
    }
  });

  it('restores the other settings, beside an institution document the platform already set', async () => {
    const context = await importRequest(tenantBackupImportAuthority(tenantAdmin, 'tenant-admin'));
    const row = settingsRow('security');
    expect(await restore(TENANT_SETTINGS_DOCUMENTS_DATASET, context, row)).toBe(row);
  });

  it('keeps the institution settings in a platform operator DR restore', async () => {
    const context = await importRequest(
      tenantBackupImportAuthority(platformOperator, 'platform-admin')
    );
    const row = settingsRow('institution');
    expect(await restore(TENANT_SETTINGS_DOCUMENTS_DATASET, context, row)).toBe(row);
  });

  it('grants nothing to a request recorded before authority was', async () => {
    const context = await importRequest(null);
    const policy = guarded().get(TENANT_SETTINGS_DOCUMENTS_DATASET)!;
    await expect(policy.admitRow!.admit(context, settingsRow('institution'))).rejects.toThrow(
      REFUSED
    );
    await expect(policy.admitRow!.admit(context, settingsRow('security'))).resolves.toBeUndefined();
  });

  it('refuses a settings row whose category cannot be read', async () => {
    const context = await importRequest(
      tenantBackupImportAuthority(platformOperator, 'platform-admin')
    );
    const policy = guarded().get(TENANT_SETTINGS_DOCUMENTS_DATASET)!;
    await expect(
      policy.admitRow!.admit(context, JSON.stringify({ category: ['integer', '1'] }))
    ).rejects.toThrow(REFUSED);
  });
});

describe('global Admin role assignments', () => {
  it('refuses a tenant-only requester a global assignment at validation and restore', async () => {
    const context = await importRequest(tenantBackupImportAuthority(tenantAdmin, 'tenant-admin'));
    const policy = guarded().get(ADMIN_ROLE_ASSIGNMENTS_DATASET)!;
    const row = assignmentRow('global', 'role_super_admin');
    await expect(policy.admitRow!.admit(context, row)).rejects.toThrow(REFUSED);
    await expect(policy.restoreTransform!.transform(context, row, 'write')).rejects.toThrow(
      REFUSED
    );
  });

  it('restores tenant assignments beside the platform global assignment already there', async () => {
    const context = await importRequest(tenantBackupImportAuthority(tenantAdmin, 'tenant-admin'));
    const written = await restore(
      ADMIN_ROLE_ASSIGNMENTS_DATASET,
      context,
      assignmentRow('tenant', 'role_super_admin')
    );
    // The Admin mapping still applies before the check.
    expect(JSON.parse(written).admin_user_id).toEqual(['text', 'mapped-source-admin']);
  });

  it('keeps global assignments of roles below a platform operator in a DR restore', async () => {
    const context = await importRequest(
      tenantBackupImportAuthority(platformOperator, 'platform-admin')
    );
    for (const roleId of ['role_admin', 'restored-operator'])
      expect(
        JSON.parse(
          await restore(ADMIN_ROLE_ASSIGNMENTS_DATASET, context, assignmentRow('global', roleId))
        ).admin_role_id
      ).toEqual(['text', roleId]);
  });

  it('lets a super_admin requester restore a global super_admin assignment, and audits it', async () => {
    const context = await importRequest(
      tenantBackupImportAuthority(platformOperator, 'platform-admin')
    );
    const row = assignmentRow('global', 'role_super_admin');
    const policy = guarded().get(ADMIN_ROLE_ASSIGNMENTS_DATASET)!;
    await restore(ADMIN_ROLE_ASSIGNMENTS_DATASET, context, row);
    // A retried write records it once; verification records nothing.
    await policy.restoreTransform!.transform(context, row, 'write');
    const audits = admin
      .prepare(
        `SELECT tenant_id,admin_user_id,action,resource_type,resource_id,result,severity,metadata_json
         FROM admin_audit_log WHERE action='tenant_backup.global_admin_assignment_restored'`
      )
      .all() as Record<string, string>[];
    expect(audits).toHaveLength(1);
    expect({ ...audits[0], metadata_json: JSON.parse(audits[0].metadata_json) }).toEqual({
      tenant_id: 'tenant-a',
      admin_user_id: 'platform-admin',
      action: 'tenant_backup.global_admin_assignment_restored',
      resource_type: 'admin_role_assignment',
      resource_id: 'assignment-global-role_super_admin',
      result: 'success',
      severity: 'critical',
      metadata_json: {
        operationId: (context as { lease: { operationId: string } }).lease.operationId,
        requesterLevel: 100,
        assignmentId: 'assignment-global-role_super_admin',
        adminUserId: 'mapped-source-admin',
        sourceAdminUserId: 'source-admin',
        roleId: 'role_super_admin',
        roleName: 'super_admin',
        roleLevel: 100,
        scopeType: 'global',
        scopeId: null,
      },
    });
  });

  it('refuses a global admin below super_admin a global super_admin assignment', async () => {
    // The global wildcard through a lower role: may restore global assignments up to its level.
    const lower = {
      ...platformOperator,
      globalRoles: ['wildcard_operator'],
      globalHierarchyLevel: 90,
    } as unknown as AdminAuthContext;
    const context = await importRequest(tenantBackupImportAuthority(lower, 'platform-admin'));
    const policy = guarded().get(ADMIN_ROLE_ASSIGNMENTS_DATASET)!;
    const above = assignmentRow('global', 'role_super_admin');
    await expect(policy.admitRow!.admit(context, above)).resolves.toBeUndefined();
    await expect(policy.restoreTransform!.transform(context, above, 'write')).rejects.toThrow(
      REFUSED
    );
    await restore(ADMIN_ROLE_ASSIGNMENTS_DATASET, context, assignmentRow('global', 'role_admin'));
    // A global admin without the wildcard may restore none.
    const withoutWildcard = await importRequest(
      tenantBackupImportAuthority(
        {
          ...platformOperator,
          globalRoles: ['admin'],
          globalPermissions: ['admin:users:*'],
          globalHierarchyLevel: 80,
        } as unknown as AdminAuthContext,
        'platform-admin'
      )
    );
    await expect(
      policy.admitRow!.admit(withoutWildcard, assignmentRow('global', 'role_viewer'))
    ).rejects.toThrow(REFUSED);
    // Nothing refused was audited.
    expect(
      admin
        .prepare(
          "SELECT count(*) AS n FROM admin_audit_log WHERE resource_id='assignment-global-role_super_admin'"
        )
        .get().n
    ).toBe(0);
  });

  it('refuses a global assignment of an unknown role and writes nothing when the audit fails', async () => {
    const context = await importRequest(
      tenantBackupImportAuthority(platformOperator, 'platform-admin')
    );
    const policy = guarded().get(ADMIN_ROLE_ASSIGNMENTS_DATASET)!;
    const unknown = assignmentRow('global', 'missing-role');
    await expect(policy.admitRow!.admit(context, unknown)).resolves.toBeUndefined();
    await expect(policy.restoreTransform!.transform(context, unknown, 'write')).rejects.toThrow(
      REFUSED
    );
    const failing = createTenantBackupRestoreAuthorityGuard({
      database: {
        ...adapter(admin),
        // The audit entry cannot be written (the statement returns no row).
        queryOne: async <T>(sql: string, params?: unknown[]) =>
          sql.includes('INSERT INTO admin_audit_log')
            ? null
            : adapter(admin).queryOne<T>(sql, params),
      } as never,
      loadBundleRoles: async () => [],
    }).wrap([policies.get(ADMIN_ROLE_ASSIGNMENTS_DATASET)!])[0];
    await expect(
      failing.restoreTransform!.transform(context, assignmentRow('global', 'role_admin'), 'write')
    ).rejects.toThrow('backup_restore_authority_audit_failed');
  });

  it('refuses a role of another tenant', async () => {
    admin.exec(`
      INSERT INTO admin_roles(id,tenant_id,name,display_name,permissions_json,hierarchy_level,role_type,is_system,created_at,updated_at)
      VALUES ('other-tenant-role','tenant-b','low','Low','["*"]',1,'custom',0,1,1);
    `);
    const context = await importRequest(
      tenantBackupImportAuthority(platformOperator, 'platform-admin')
    );
    const policy = guarded().get(ADMIN_ROLE_ASSIGNMENTS_DATASET)!;
    await expect(
      policy.restoreTransform!.transform(
        context,
        assignmentRow('global', 'other-tenant-role'),
        'write'
      )
    ).rejects.toThrow(REFUSED);
  });
});

const roleRow = (name: string, level = 1) =>
  JSON.stringify({
    id: ['text', `bundle-role-${name}`],
    tenant_id: ['text', 'tenant-a'],
    name: ['text', name],
    permissions_json: ['text', '["*"]'],
    hierarchy_level: ['integer', String(level)],
    is_system: ['integer', '0'],
    inherits_from: ['null', null],
  });

describe('Admin roles named like a system role', () => {
  const admitted = async (context: TenantBackupStepContext, rowJson: string) => {
    const policy = guarded().get(ADMIN_ROLES_DATASET)!;
    await policy.admitRow!.admit(context, rowJson);
    await policy.restoreTransform!.transform(context, rowJson, 'write');
  };

  it('refuses a tenant-only requester a low-level role named super_admin or another reserved name', async () => {
    const context = await importRequest(tenantBackupImportAuthority(tenantAdmin, 'tenant-admin'));
    const policy = guarded().get(ADMIN_ROLES_DATASET)!;
    for (const name of ['super_admin', 'admin', 'tenant_admin']) {
      await expect(policy.admitRow!.admit(context, roleRow(name)), name).rejects.toThrow(REFUSED);
      await expect(
        policy.restoreTransform!.transform(context, roleRow(name), 'write'),
        name
      ).rejects.toThrow(REFUSED);
    }
    await admitted(context, roleRow('operator'));
  });

  it('refuses a wildcard global admin below super_admin a role named super_admin', async () => {
    const lower = {
      ...platformOperator,
      globalRoles: ['wildcard_operator'],
      globalHierarchyLevel: 90,
    } as unknown as AdminAuthContext;
    const context = await importRequest(tenantBackupImportAuthority(lower, 'platform-admin'));
    const policy = guarded().get(ADMIN_ROLES_DATASET)!;
    await expect(policy.admitRow!.admit(context, roleRow('super_admin'))).rejects.toThrow(REFUSED);
    // A system name at or below its own level is kept.
    await admitted(context, roleRow('admin'));
  });

  it('keeps system-named roles in a super_admin DR restore', async () => {
    const context = await importRequest(
      tenantBackupImportAuthority(platformOperator, 'platform-admin')
    );
    for (const name of ['super_admin', 'tenant_admin', 'operator'])
      await admitted(context, roleRow(name, 100));
  });
});

describe('Admin roles that an existing global assignment leads to', () => {
  // A tenant role assigned globally names a parent that no longer exists; a bundle role taking
  // that id would pass what it inherits (here super_admin's "*") to every tenant.
  beforeEach(() => {
    admin.exec(`
      INSERT INTO admin_users(id,tenant_id,email,name,password_hash,is_active,status,created_at,updated_at)
      VALUES ('global-operator','tenant-a','operator@example.test','Operator','x',1,'active',1,1);
      INSERT INTO admin_roles(id,tenant_id,name,display_name,permissions_json,hierarchy_level,role_type,is_system,created_at,updated_at,inherits_from)
      VALUES ('existing-global','tenant-a','helpdesk','Helpdesk','[]',10,'custom',0,1,1,'gone-parent');
      INSERT INTO admin_role_assignments(id,tenant_id,admin_user_id,admin_role_id,scope_type,scope_id,assigned_by,created_at)
      VALUES ('existing-global-assignment','tenant-a','global-operator','existing-global','global',NULL,'platform-admin',1);
    `);
  });
  const parentRow = JSON.stringify({
    id: ['text', 'gone-parent'],
    tenant_id: ['text', 'tenant-a'],
    name: ['text', 'helper'],
    permissions_json: ['text', '[]'],
    hierarchy_level: ['integer', '1'],
    is_system: ['integer', '0'],
    inherits_from: ['text', 'role_super_admin'],
  });

  it('refuses a tenant-only requester or a lower global admin the missing parent', async () => {
    const lower = {
      ...platformOperator,
      globalRoles: ['wildcard_operator'],
      globalHierarchyLevel: 90,
    } as unknown as AdminAuthContext;
    for (const requester of [
      tenantBackupImportAuthority(tenantAdmin, 'tenant-admin'),
      tenantBackupImportAuthority(lower, 'platform-admin'),
    ]) {
      const context = await importRequest(requester);
      const policy = guarded().get(ADMIN_ROLES_DATASET)!;
      await expect(policy.admitRow!.admit(context, parentRow)).rejects.toThrow(REFUSED);
      await expect(policy.restoreTransform!.transform(context, parentRow, 'write')).rejects.toThrow(
        REFUSED
      );
    }
  });

  it('keeps it in a super_admin DR restore, and leaves unreached roles to the tenant', async () => {
    const platform = await importRequest(
      tenantBackupImportAuthority(platformOperator, 'platform-admin')
    );
    const policy = guarded().get(ADMIN_ROLES_DATASET)!;
    await policy.admitRow!.admit(platform, parentRow);
    const tenant = await importRequest(tenantBackupImportAuthority(tenantAdmin, 'tenant-admin'));
    await policy.admitRow!.admit(tenant, parentRow.replace('"gone-parent"', '"unreached-role"'));
  });
});

describe('global assignments of roles defined by the bundle', () => {
  const bundleRole = (id: string, level: number, parent: string | null) =>
    JSON.stringify({
      id: ['text', id],
      tenant_id: ['text', 'tenant-a'],
      name: ['text', id],
      permissions_json: ['text', '[]'],
      hierarchy_level: ['integer', String(level)],
      is_system: ['integer', '0'],
      inherits_from: parent ? ['text', parent] : ['null', null],
    });

  it('judges a role not written yet by its bundle definition (one execution batch)', async () => {
    bundleRoles = [bundleRole('bundle-new', 50, null)];
    const context = await importRequest(
      tenantBackupImportAuthority(platformOperator, 'platform-admin')
    );
    await restore(ADMIN_ROLE_ASSIGNMENTS_DATASET, context, assignmentRow('global', 'bundle-new'));
    expect(
      JSON.parse(
        (
          admin
            .prepare(
              "SELECT metadata_json FROM admin_audit_log WHERE resource_id='assignment-global-bundle-new'"
            )
            .get() as { metadata_json: string }
        ).metadata_json
      ).roleLevel
    ).toBe(50);
  });

  it('refuses, while the restore can still be cleaned up, a low role inheriting super_admin', async () => {
    bundleRoles = [bundleRole('bundle-low', 1, 'role_super_admin')];
    const lower = {
      ...platformOperator,
      globalRoles: ['wildcard_operator'],
      globalHierarchyLevel: 90,
    } as unknown as AdminAuthContext;
    const context = await importRequest(tenantBackupImportAuthority(lower, 'platform-admin'));
    const policies = guarded();
    // The role itself is not reached by any assignment before the restore: it is admitted.
    await policies.get(ADMIN_ROLES_DATASET)!.admitRow!.admit(context, bundleRoles[0]);
    await policies
      .get(ADMIN_ROLES_DATASET)!
      .restoreTransform!.transform(context, bundleRoles[0], 'write');
    // Its global assignment is judged with the role's whole chain, as it is written.
    await expect(
      policies
        .get(ADMIN_ROLE_ASSIGNMENTS_DATASET)!
        .restoreTransform!.transform(context, assignmentRow('global', 'bundle-low'), 'write')
    ).rejects.toThrow(REFUSED);
  });

  it('does not refuse a role on final verification once the bundle assignments exist', async () => {
    bundleRoles = [bundleRole('bundle-mid', 60, null)];
    const context = await importRequest(
      tenantBackupImportAuthority(platformOperator, 'platform-admin')
    );
    // After restore_other_stores the import cannot be cleaned up: its own global assignment is
    // now in the database, and verification of the role must give the answer the write gave.
    admin.exec(`
      INSERT INTO admin_roles(id,tenant_id,name,display_name,permissions_json,hierarchy_level,role_type,is_system,created_at,updated_at)
      VALUES ('bundle-mid','tenant-a','bundle-mid','Mid','[]',60,'custom',0,1,1);
      INSERT INTO admin_users(id,tenant_id,email,name,password_hash,is_active,status,created_at,updated_at)
      VALUES ('restored-global','tenant-a','restored-global@example.test','R','x',1,'active',1,1);
      INSERT INTO admin_role_assignments(id,tenant_id,admin_user_id,admin_role_id,scope_type,scope_id,assigned_by,created_at)
      VALUES ('restored-global-assignment','tenant-a','restored-global','bundle-mid','global',NULL,'x',1);
    `);
    const tenantOnly = await importRequest(
      tenantBackupImportAuthority(tenantAdmin, 'tenant-admin')
    );
    for (const requester of [context, tenantOnly])
      await expect(
        guarded()
          .get(ADMIN_ROLES_DATASET)!
          .restoreTransform!.transform(requester, bundleRoles[0], 'verify')
      ).resolves.toBe(bundleRoles[0]);
  });
});

describe('role chains and system roles the restore itself brings', () => {
  const chainRole = (
    id: string,
    level: number,
    parent: string | null,
    tenant = 'tenant-a',
    system = 0
  ) =>
    JSON.stringify({
      id: ['text', id],
      tenant_id: ['text', tenant],
      name: ['text', id],
      permissions_json: ['text', '[]'],
      hierarchy_level: ['integer', String(level)],
      is_system: ['integer', String(system)],
      inherits_from: parent ? ['text', parent] : ['null', null],
    });

  it('refuses a chain longer than it judges instead of judging part of it', async () => {
    bundleRoles = Array.from({ length: 70 }, (_, index) =>
      chainRole(`link-${index}`, 1, index === 69 ? 'role_super_admin' : `link-${index + 1}`)
    );
    const lower = {
      ...platformOperator,
      globalRoles: ['wildcard_operator'],
      globalHierarchyLevel: 90,
    } as unknown as AdminAuthContext;
    const context = await importRequest(tenantBackupImportAuthority(lower, 'platform-admin'));
    await expect(
      guarded()
        .get(ADMIN_ROLE_ASSIGNMENTS_DATASET)!
        .restoreTransform!.transform(context, assignmentRow('global', 'link-0'), 'write')
    ).rejects.toThrow(REFUSED);
  });

  it('judges a platform-tenant restore by the bundle system roles, the same on write and verify', async () => {
    const context = await importRequest(
      tenantBackupImportAuthority(platformOperator, 'platform-admin'),
      'default'
    );
    const policy = guarded().get(ADMIN_ROLES_DATASET)!;
    // A system role above the requester, new to the environment: refused before anything is
    // written, at validation.
    const above = chainRole('new-system', 101, null, 'default', 1);
    bundleRoles = [above];
    await expect(policy.admitRow!.admit(context, above)).rejects.toThrow(REFUSED);
    await expect(policy.restoreTransform!.transform(context, above, 'write')).rejects.toThrow(
      REFUSED
    );
    // The platform's own super_admin, as the bundle has it: kept, and verification after the
    // restore wrote it gives the same answer.
    const superAdmin = JSON.stringify({
      ...JSON.parse(chainRole('role_super_admin', 100, null, 'default', 1)),
      name: ['text', 'super_admin'],
    });
    bundleRoles = [superAdmin];
    const fresh = guarded().get(ADMIN_ROLES_DATASET)!;
    await fresh.admitRow!.admit(context, superAdmin);
    await fresh.restoreTransform!.transform(context, superAdmin, 'write');
    await fresh.restoreTransform!.transform(context, superAdmin, 'verify');
  });

  it('restores ordinary roles and tenant assignments without reading the bundle roles', async () => {
    const context = await importRequest(tenantBackupImportAuthority(tenantAdmin, 'tenant-admin'));
    const local = new Map(
      createTenantBackupRestoreAuthorityGuard({
        database: adapter(admin),
        loadBundleRoles: async () => {
          throw new Error('bundle roles read');
        },
      })
        .wrap([policies.get(ADMIN_ROLES_DATASET)!, policies.get(ADMIN_ROLE_ASSIGNMENTS_DATASET)!])
        .map((policy) => [policy.dataset.id, policy])
    );
    await local
      .get(ADMIN_ROLES_DATASET)!
      .restoreTransform!.transform(context, chainRole('ordinary', 5, null), 'write');
    await local
      .get(ADMIN_ROLE_ASSIGNMENTS_DATASET)!
      .restoreTransform!.transform(context, assignmentRow('tenant', 'ordinary'), 'write');
  });
});

describe('the cost and value range of the checks', () => {
  it('reads the database a fixed number of times for a slice of hundreds of ordinary rows', async () => {
    // An existing global grant makes every role row ask whether it is reached.
    admin.exec(`
      INSERT INTO admin_users(id,tenant_id,email,name,password_hash,is_active,status,created_at,updated_at)
      VALUES ('global-operator','tenant-a','operator@example.test','Operator','x',1,'active',1,1);
      INSERT INTO admin_role_assignments(id,tenant_id,admin_user_id,admin_role_id,scope_type,scope_id,assigned_by,created_at)
      VALUES ('existing-global-assignment','tenant-a','global-operator','role_admin','global',NULL,'platform-admin',1);
    `);
    const context = await importRequest(tenantBackupImportAuthority(tenantAdmin, 'tenant-admin'));
    let queries = 0;
    const counted = adapter(admin);
    const database = {
      query: async <T>(sql: string, params?: unknown[]) => (
        queries++,
        counted.query<T>(sql, params)
      ),
      queryOne: async <T>(sql: string, params?: unknown[]) => (
        queries++,
        counted.queryOne<T>(sql, params)
      ),
      execute: async (sql: string, params?: unknown[]) => (queries++, counted.execute(sql, params)),
    };
    const wrapped = new Map(
      createTenantBackupRestoreAuthorityGuard({ database, loadBundleRoles: async () => [] })
        .wrap(
          [...policies.values()].filter(({ dataset }) =>
            [
              ADMIN_ROLES_DATASET,
              ADMIN_ROLE_ASSIGNMENTS_DATASET,
              TENANT_SETTINGS_DOCUMENTS_DATASET,
            ].includes(dataset.id)
          )
        )
        .map((policy) => [policy.dataset.id, policy])
    );
    for (let index = 0; index < 600; index++) {
      const role = roleRow(`ordinary-${index}`, 5);
      await wrapped.get(ADMIN_ROLES_DATASET)!.admitRow!.admit(context, role);
      await wrapped.get(ADMIN_ROLES_DATASET)!.restoreTransform!.transform(context, role, 'write');
      await wrapped
        .get(ADMIN_ROLE_ASSIGNMENTS_DATASET)!
        .admitRow!.admit(context, assignmentRow('tenant', `ordinary-${index}`));
      await wrapped
        .get(TENANT_SETTINGS_DOCUMENTS_DATASET)!
        .admitRow!.admit(context, settingsRow('security', 'client'));
    }
    expect(queries).toBeLessThanOrEqual(8);
  });

  it('reads the database about once per global assignment for hundreds of them', async () => {
    const context = await importRequest(
      tenantBackupImportAuthority(platformOperator, 'platform-admin')
    );
    let queries = 0;
    const counted = adapter(admin);
    const database = {
      query: async <T>(sql: string, params?: unknown[]) => (
        queries++,
        counted.query<T>(sql, params)
      ),
      queryOne: async <T>(sql: string, params?: unknown[]) => (
        queries++,
        counted.queryOne<T>(sql, params)
      ),
      execute: async (sql: string, params?: unknown[]) => (queries++, counted.execute(sql, params)),
    };
    const policy = createTenantBackupRestoreAuthorityGuard({
      database,
      loadBundleRoles: async () => [],
    }).wrap([policies.get(ADMIN_ROLE_ASSIGNMENTS_DATASET)!])[0];
    for (let index = 0; index < 300; index++) {
      const row = JSON.stringify({
        ...JSON.parse(assignmentRow('global', 'role_admin')),
        id: ['text', `global-${index}`],
      });
      await policy.restoreTransform!.transform(context, row, 'write');
    }
    // The audit entry of each, plus a fixed few (authority, the role, the bundle roles).
    expect(queries).toBeLessThanOrEqual(300 + 5);
  });

  it('takes fractional and missing role levels as the Admin repositories do', async () => {
    const context = await importRequest(tenantBackupImportAuthority(tenantAdmin, 'tenant-admin'));
    const policy = guarded().get(ADMIN_ROLES_DATASET)!;
    for (const level of [
      ['real', '1.5'],
      ['null', null],
      ['integer', '7'],
    ] as const) {
      const row = JSON.stringify({ ...JSON.parse(roleRow('ordinary')), hierarchy_level: level });
      await policy.admitRow!.admit(context, row);
      await policy.restoreTransform!.transform(context, row, 'write');
    }
    for (const level of [
      ['text', '5'],
      ['real', 'NaN'],
      ['integer', ''],
    ] as const)
      await expect(
        policy.admitRow!.admit(
          context,
          JSON.stringify({ ...JSON.parse(roleRow('super_admin')), hierarchy_level: level })
        )
      ).rejects.toThrow(REFUSED);
    // A stored role with a fractional or missing level is a valid global assignment target.
    admin.exec(`
      INSERT INTO admin_roles(id,tenant_id,name,display_name,permissions_json,hierarchy_level,role_type,is_system,created_at,updated_at)
      VALUES ('fraction-role','tenant-a','fraction','F','[]',1.5,'custom',0,1,1),
        ('null-role','tenant-a','nolevel','N','[]',NULL,'custom',0,1,1);
    `);
    const platform = await importRequest(
      tenantBackupImportAuthority(platformOperator, 'platform-admin')
    );
    for (const roleId of ['fraction-role', 'null-role'])
      await restore(ADMIN_ROLE_ASSIGNMENTS_DATASET, platform, assignmentRow('global', roleId));
  });
});

describe('the critical audit of a restored global assignment', () => {
  it('refuses the assignment when another row already holds the audit id', async () => {
    const context = await importRequest(
      tenantBackupImportAuthority(platformOperator, 'platform-admin')
    );
    const operationId = (context as { lease: { operationId: string } }).lease.operationId;
    // As a bundle with audit rows could restore it before the assignment.
    admin
      .prepare(
        `INSERT INTO admin_audit_log(id,tenant_id,action,result,severity,created_at)
         VALUES (?,'tenant-a','unrelated.event','success','info',1)`
      )
      .run(`tenant-backup-global-grant:${operationId}:assignment-global-role_admin`);
    const policy = guarded().get(ADMIN_ROLE_ASSIGNMENTS_DATASET)!;
    await expect(
      policy.restoreTransform!.transform(context, assignmentRow('global', 'role_admin'), 'write')
    ).rejects.toThrow('backup_restore_authority_audit_failed');
  });
});

describe('policy wrapping', () => {
  it('builds wrapped policies the installed inspector accepts', async () => {
    const manifest = {
      formatVersion: 1 as const,
      bundleId: 'ab'.repeat(16),
      source: { tenantId: 'tenant-a', issuer: 'https://tenant.example', productVersion: '0.4.2' },
      snapshotId: 'snapshot',
      boundaryUnixMs: 10,
      inventoryDigestSha256: '12'.repeat(32),
      selection,
      datasets: [...guarded().values()].map((policy) => policy.dataset),
    };
    for (const policy of guarded().values())
      await expect(
        createSqliteDatasetInspectorFactory(policy)(policy.dataset, manifest),
        policy.dataset.id
      ).resolves.toBeDefined();
  });

  it('pins the guard into the guarded datasets and leaves the others alone', () => {
    const guard = createTenantBackupRestoreAuthorityGuard({
      database: adapter(admin),
      loadBundleRoles: async () => bundleRoles,
    });
    const wrapped = new Map(
      guard.wrap([...policies.values()]).map((policy) => [policy.dataset.id, policy])
    );
    expect(wrapped.get(TENANT_SETTINGS_DOCUMENTS_DATASET)?.admitRow?.id).toBe(
      'restore-authority-v1:admin.tenant_settings_documents'
    );
    expect(wrapped.get(ADMIN_ROLE_ASSIGNMENTS_DATASET)?.restoreTransform?.id).toBe(
      `${policies.get(ADMIN_ROLE_ASSIGNMENTS_DATASET)!.restoreTransform!.id}.restore-authority-v1`
    );
    const others = [...wrapped.values()].filter(
      ({ dataset }) =>
        ![
          TENANT_SETTINGS_DOCUMENTS_DATASET,
          ADMIN_ROLE_ASSIGNMENTS_DATASET,
          ADMIN_ROLES_DATASET,
        ].includes(dataset.id)
    );
    expect(others.length).toBeGreaterThan(100);
    expect(others.every((policy) => policy === policies.get(policy.dataset.id))).toBe(true);
  });

  it('counts the audit entry of an assignment row in the restore statement budget', () => {
    const wrapped = guarded();
    const base = (id: string) => policies.get(id)!.restoreTransform?.statementsPerRow ?? 0;
    // The frozen-mapping lookup of `admin_user_id`, then the critical audit entry.
    expect(base(ADMIN_ROLE_ASSIGNMENTS_DATASET)).toBe(1);
    expect(wrapped.get(ADMIN_ROLE_ASSIGNMENTS_DATASET)!.restoreTransform!.statementsPerRow).toBe(2);
    // The other guards read only what they cache for the slice.
    for (const id of [TENANT_SETTINGS_DOCUMENTS_DATASET, ADMIN_ROLES_DATASET])
      expect(wrapped.get(id)!.restoreTransform!.statementsPerRow).toBe(base(id));
  });
});
