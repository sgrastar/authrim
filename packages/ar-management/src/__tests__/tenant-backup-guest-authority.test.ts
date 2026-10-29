import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type { GuestPiiDeletedMarker } from '@authrim/ar-lib-core/services/guest-pii-erasure';
import type { SqliteDatasetInspectionPolicy } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { TenantBackupRestoreHoldStore } from '@authrim/ar-lib-core/services/tenant-portability/restore-hold-store';
import {
  createTenantBackupGuestAuthority,
  type GuestRestoreAuthoritySource,
} from '../tenant-backup-guest-authority';

const databases: SQLiteDatabase[] = [];
function db() {
  const value = new DatabaseSync(':memory:');
  databases.push(value);
  return value;
}
afterEach(() => {
  for (const value of databases.splice(0)) value.close();
});
function adapter(database: SQLiteDatabase): DatabaseAdapter {
  const value: DatabaseAdapter = {
    async query<T>(sql: string, params: unknown[] = []) {
      return database.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (database.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      return {
        success: true,
        rowsAffected: Number(database.prepare(sql).run(...(params as SQLInputValue[])).changes),
      };
    },
    async batch(statements: { sql: string; params?: unknown[] }[]) {
      database.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements)
          result.push(await value.execute(statement.sql, statement.params));
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    transaction: vi.fn(),
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'd1' }),
    getType: () => 'd1',
    close: async () => {},
  } satisfies DatabaseAdapter;
  return value;
}
const context = {
  lease: { tenantId: 'tenant-a', operationId: 'import-a', owner: 'worker', fencingToken: 2 },
  operation: { kind: 'import', state: 'running' },
  signal: new AbortController().signal,
} as TenantBackupStepContext;
const planDigest = 'a'.repeat(64);
function marker(user: string) {
  return {
    schema_version: 1,
    tenant_id: 'tenant-a',
    user_id: user,
    account_id: `account-${user}`,
    account_route_generation: 1,
    state: 'deleted',
    revision: 3,
    operation_id: null,
    boundary_id: null,
    source_started_at_ms: null,
    permit_table: null,
    permit_keys_json: null,
  } as const;
}
function portable(value: Record<string, unknown>) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        entry === null
          ? ['null', null]
          : typeof entry === 'number'
            ? ['integer', String(entry)]
            : ['text', entry],
      ])
    )
  );
}
function fixture() {
  const core = db(),
    pii = db(),
    admin = db();
  core.exec(`CREATE TABLE guest_core_mutation_epoch(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL);INSERT INTO guest_core_mutation_epoch VALUES(1,0);
    CREATE TABLE identity_accounts(id TEXT PRIMARY KEY,tenant_id TEXT,legacy_user_id TEXT,account_type TEXT,lifecycle_state TEXT,registration_state TEXT,account_route_generation INTEGER,deleted_at INTEGER,directory_publication_state TEXT,primary_subject_id TEXT);
    CREATE TABLE guest_account_lifecycle(tenant_id TEXT,user_id TEXT,phase TEXT,revision INTEGER,upgrade_finalized_at INTEGER,deletion_operation_id TEXT,deletion_route_json TEXT,deletion_started_at_ms INTEGER,deleted_at INTEGER);`);
  core.exec(
    'CREATE TABLE identity_subjects(id TEXT PRIMARY KEY,tenant_id TEXT,subject_type TEXT,lifecycle_state TEXT,primary_account_id TEXT,deleted_at INTEGER)'
  );
  core.exec(
    "CREATE TABLE profiles(id TEXT PRIMARY KEY,tenant_id TEXT,subject_id TEXT,profile_type TEXT DEFAULT 'person',lifecycle_state TEXT DEFAULT 'active',deleted_at INTEGER)"
  );
  pii.exec(`CREATE TABLE guest_pii_mutation_epoch(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL);INSERT INTO guest_pii_mutation_epoch VALUES(1,0);
    CREATE TABLE guest_pii_erasure_markers(schema_version INTEGER NOT NULL,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,account_id TEXT NOT NULL,account_route_generation INTEGER NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,operation_id TEXT,boundary_id TEXT,source_started_at_ms INTEGER,permit_table TEXT,permit_keys_json TEXT,PRIMARY KEY(tenant_id,user_id),UNIQUE(tenant_id,account_id));`);
  admin.exec(
    `CREATE TABLE tenant_backup_restored_holds(operation_id TEXT,tenant_id TEXT,dataset_id TEXT,record_id TEXT,reason TEXT,source_row_sha256 TEXT,payload_encrypted TEXT,payload_key_version INTEGER,created_at INTEGER,PRIMARY KEY(operation_id,dataset_id,record_id));`
  );
  let calls = 0;
  const counted = (database: SQLiteDatabase): DatabaseAdapter => {
    const base = adapter(database);
    return {
      ...base,
      query: async <T>(
        sql: string,
        params?: unknown[],
        options?: Parameters<DatabaseAdapter['query']>[2]
      ) => {
        calls++;
        return base.query<T>(sql, params, options);
      },
      queryOne: async <T>(
        sql: string,
        params?: unknown[],
        options?: Parameters<DatabaseAdapter['queryOne']>[2]
      ) => {
        calls++;
        return base.queryOne<T>(sql, params, options);
      },
    };
  };
  const source: GuestRestoreAuthoritySource = {
    environmentId: 'test',
    issuer: 'https://tenant.example',
    inventoryDigest: 'b'.repeat(64),
    resources: [
      { id: 'core', family: 'core', database: counted(core) },
      { id: 'pii', family: 'pii', database: counted(pii) },
    ],
  };
  const store = new TenantBackupRestoreHoldStore(adapter(admin));
  let live = true;
  const authorize = vi.fn(async () => {
    if (!live) throw new Error('lease_lost');
  });
  const apply = vi.fn(
    async (
      _context: TenantBackupStepContext,
      _planDigest: string,
      _markers: readonly GuestPiiDeletedMarker[]
    ) => {}
  );
  const sourcePort = vi.fn(async () => source);
  const authority = createTenantBackupGuestAuthority({
    source: sourcePort,
    authorize,
    apply,
    save: (ctx, witness) =>
      store.writeGuestCurrentDenyWitness({
        witness,
        encryptionKey: 'c'.repeat(64),
        keyVersion: 1,
        now: 10,
        authorize: () => authorize(),
      }),
    load: (ctx, digest, assertCurrentSource) =>
      store.readGuestCurrentDenyWitness({
        tenantId: ctx.lease.tenantId,
        operationId: ctx.lease.operationId,
        planDigest: digest,
        encryptionKey: 'c'.repeat(64),
        keyVersion: 1,
        authorize: () => authorize(),
        assertCurrentSource,
      }),
  });
  const account = {
    id: 'account-live',
    tenant_id: 'tenant-a',
    legacy_user_id: 'live',
    account_type: 'person',
    lifecycle_state: 'active',
    registration_state: 'registered',
    account_route_generation: 1,
    deleted_at: null,
    directory_publication_state: 'active',
  };
  const insertAccount = () =>
    core
      .prepare(
        `INSERT INTO identity_accounts(id,tenant_id,legacy_user_id,account_type,lifecycle_state,registration_state,account_route_generation,deleted_at,directory_publication_state) VALUES(?,?,?,?,?,?,?,?,?)`
      )
      .run(...Object.values(account));
  const insertMarker = (user: string) =>
    pii
      .prepare('INSERT INTO guest_pii_erasure_markers VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(...Object.values(marker(user)));
  const policy = (id: string, columns: readonly string[] = []) =>
    authority.wrap([
      {
        dataset: { id, kind: 'users' },
        schema: { columns },
        restoreTransform: undefined,
      } as unknown as SqliteDatasetInspectionPolicy,
    ])[0];
  return {
    core,
    pii,
    admin,
    source,
    authority,
    store,
    apply,
    authorize,
    sourcePort,
    account,
    insertAccount,
    insertMarker,
    policy,
    calls: () => calls,
    setLive: (value: boolean) => {
      live = value;
    },
  };
}

it('rejects a fabricated registered account against an empty current source before any target write', async () => {
  const f = fixture(),
    policy = f.policy('core.identity_accounts');
  await expect(policy.admitRow!.prepareRows!(context, [portable(f.account)])).rejects.toThrow(
    'authority_unavailable'
  );
  expect(f.apply).not.toHaveBeenCalled();
});
it('bulk admits positive primary owners and rejects current accepted Guest state even without any PII marker', async () => {
  const f = fixture();
  f.insertAccount();
  const policy = f.policy('core.identity_accounts'),
    json = portable(f.account);
  await expect(policy.admitRow!.prepareRows!(context, [json])).resolves.toBeUndefined();
  f.core
    .prepare(
      'INSERT INTO guest_account_lifecycle(tenant_id,user_id,phase,revision,upgrade_finalized_at) VALUES(?,?,?,?,?)'
    )
    .run('tenant-a', 'live', 'deleting', 4, null);
  await expect(policy.restoreTransform!.transform(context, json, 'write')).rejects.toThrow(
    'current_source_held'
  );
  expect(f.pii.prepare('SELECT count(*) AS n FROM guest_pii_erasure_markers').get()).toEqual({
    n: 0,
  });
});
it('rejects owner generation changes, duplicate physical owners and newly denied PII', async () => {
  const f = fixture();
  f.insertAccount();
  await expect(
    f
      .policy('core.identity_accounts')
      .admitRow!.admit(context, portable({ ...f.account, account_route_generation: 0 }))
  ).rejects.toThrow();
  f.source.resources.push({ ...f.source.resources[0], id: 'duplicate' });
  await expect(
    f.policy('core.identity_accounts').admitRow!.admit(context, portable(f.account))
  ).rejects.toThrow('authority_unavailable');
  f.source.resources.pop();
  f.insertMarker('live');
  await expect(
    f
      .policy('pii.users_pii')
      .admitRow!.admit(context, portable({ id: 'live', tenant_id: 'tenant-a' }))
  ).rejects.toThrow('authority_unavailable');
});
it('copies all current denial pages, encrypts a complete witness, and excludes it from user held counts', async () => {
  const f = fixture();
  for (let i = 0; i < 33; i++) f.insertMarker(`user-${String(i).padStart(2, '0')}`);
  let cursor: string | null = null,
    done = false,
    pages = 0;
  while (!done) {
    const result = await f.authority.page(context, planDigest, cursor);
    cursor = result.cursor;
    done = result.done;
    pages++;
  }
  expect(pages).toBe(3);
  expect(f.apply.mock.calls.map((value) => value[2].length)).toEqual([16, 16, 1]);
  const witness = await f.authority.ready(context, planDigest);
  expect(witness.markerCount).toBe(33);
  expect(witness.epochs).toEqual([
    { family: 'core', resourceId: 'core', revision: 0 },
    { family: 'pii', resourceId: 'pii', revision: 0 },
  ]);
  expect(await f.store.summaries('tenant-a', 'import-a')).toEqual([]);
  expect(
    String(
      (
        f.admin.prepare('SELECT payload_encrypted FROM tenant_backup_restored_holds').get() as
          | { payload_encrypted: string }
          | undefined
      )?.payload_encrypted
    )
  ).not.toContain('https://tenant.example');
});
it('requires replanning instead of finishing from a changed denial collection', async () => {
  const f = fixture();
  for (let i = 0; i < 17; i++) f.insertMarker(`user-${i}`);
  const first = await f.authority.page(context, planDigest, null);
  expect(first.done).toBe(false);
  f.insertMarker('new-before-cursor');
  f.pii.exec('UPDATE guest_pii_mutation_epoch SET revision=revision+1');
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(f.authority.page(context, planDigest, first.cursor)).rejects.toThrow(
      'current_source_changed_replan_required'
    );
  expect(f.apply.mock.calls.map((call) => call[2].length)).toEqual([16]);
  await expect(f.authority.ready(context, planDigest)).rejects.toThrow();
});
it('explicitly stops an unpublished 33-marker collection after a Core epoch change', async () => {
  const f = fixture();
  for (let i = 0; i < 33; i++) f.insertMarker(`user-${String(i).padStart(2, '0')}`);
  const first = await f.authority.page(context, planDigest, null);
  f.core.exec('UPDATE guest_core_mutation_epoch SET revision=revision+1');
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(f.authority.page(context, planDigest, first.cursor)).rejects.toThrow(
      'current_source_changed_replan_required'
    );
  expect(f.apply.mock.calls.map((call) => call[2].length)).toEqual([16]);
  await expect(f.authority.ready(context, planDigest)).rejects.toThrow();
});
it('rechecks Core epochs, inventory and operation leases rather than trusting a saved witness', async () => {
  const f = fixture();
  await f.authority.page(context, planDigest, null);
  f.core.exec('UPDATE guest_core_mutation_epoch SET revision=revision+1');
  await expect(f.authority.ready(context, planDigest)).rejects.toThrow('current_source_changed');
  f.core.exec('UPDATE guest_core_mutation_epoch SET revision=0');
  f.source.inventoryDigest = 'd'.repeat(64);
  await expect(f.authority.ready(context, planDigest)).rejects.toThrow('current_source_changed');
  f.setLive(false);
  await expect(f.authority.ready(context, planDigest)).rejects.toThrow('lease_lost');
});
it('refuses pending erasure rather than treating it as a complete terminal-only set', async () => {
  const f = fixture();
  f.insertMarker('erasing');
  f.pii.exec("UPDATE guest_pii_erasure_markers SET state='erasing'");
  await expect(f.authority.page(context, planDigest, null)).rejects.toThrow('current_source_held');
});
it('requires historical markers to match current positive denial authority exactly', async () => {
  const f = fixture();
  f.insertMarker('gone');
  const policy = f.policy('pii.guest_pii_erasure_markers');
  await expect(policy.admitRow!.admit(context, portable(marker('gone')))).resolves.toBeUndefined();
  await expect(
    policy.admitRow!.admit(context, portable({ ...marker('gone'), revision: 2 }))
  ).rejects.toThrow('authority_unavailable');
  await expect(policy.admitRow!.admit(context, portable(marker('invented')))).rejects.toThrow(
    'authority_unavailable'
  );
  expect(policy.restoreAllowsAdditionalRows).toBe(true);
  expect(policy.restoreDisposition).toBe('reference_only');
});

it('bounds 500 restored owners to one bulk preflight and live batch fences with zero per-row SQL', async () => {
  const f = fixture(),
    rows: string[] = [];
  for (let i = 0; i < 500; i++) {
    const value = { ...f.account, id: `account-${i}`, legacy_user_id: `user-${i}` };
    f.core
      .prepare(
        'INSERT INTO identity_accounts(id,tenant_id,legacy_user_id,account_type,lifecycle_state,registration_state,account_route_generation,deleted_at,directory_publication_state) VALUES(?,?,?,?,?,?,?,?,?)'
      )
      .run(...Object.values(value));
    rows.push(portable(value));
  }
  const policy = f.policy('core.identity_accounts'),
    transform = policy.restoreTransform!;
  await transform.prepareRows!(context, rows, 'write');
  const before = f.calls();
  for (const row of rows) await transform.transform(context, row, 'write');
  expect(f.calls()).toBe(before);
  await transform.assertPreparedRows!(context);
  await transform.assertPreparedRows!(context);
  expect(f.calls()).toBeLessThanOrEqual(transform.statementsPerBatch!);
  expect(transform.statementsPerRow).toBe(0);
  expect(transform.statementsPerBatch).toBe(128);
  f.core.exec('UPDATE guest_core_mutation_epoch SET revision=revision+1');
  await expect(transform.assertPreparedRows!(context)).rejects.toThrow('current_source_changed');
});

it.each([
  ['core.passkeys', 'user_id'],
  ['core.totp_credentials', 'user_id'],
  ['core.totp_backup_codes', 'user_id'],
  ['core.guest_devices', 'user_id'],
  ['core.device_secrets', 'user_id'],
  ['core.device_installations', 'user_id'],
  ['core.subject_account_links', 'account_id'],
  ['core.identity_bindings', 'account_id'],
  ['pii.linked_identities', 'user_id'],
  ['pii.pairwise_subject_identifiers', 'user_id'],
  ['pii.guest_upgrade_operations', 'user_id'],
  ['pii.identity_identifier_replacement_operations', 'account_id'],
  ['pii.external_identifier_unlink_operations', 'user_id'],
])(
  'rejects an isolated %s raw row against an empty current owner, even when canonical account datasets were omitted',
  async (id, field) => {
    const f = fixture(),
      policy = f.policy(id, [field, 'tenant_id']);
    expect(policy.admitRow).toBeDefined();
    await expect(
      policy.admitRow!.prepareRows!(context, [
        portable({ [field]: 'erased-user', tenant_id: 'tenant-a', state: 'completed' }),
      ])
    ).rejects.toThrow('authority_unavailable');
    expect(f.apply).not.toHaveBeenCalled();
  }
);

it('distinguishes PII runtime-user values from shared organization/provider values', async () => {
  const f = fixture(),
    policy = f.policy('pii.identity_sensitive_values', ['owner_type', 'owner_id', 'tenant_id']);
  await expect(
    policy.admitRow!.admit(
      context,
      portable({ tenant_id: 'tenant-a', owner_type: 'runtime_user', owner_id: 'erased-user' })
    )
  ).rejects.toThrow('authority_unavailable');
  for (const owner_type of ['organization', 'provider'])
    await expect(
      policy.admitRow!.admit(
        context,
        portable({ tenant_id: 'tenant-a', owner_type, owner_id: 'shared-owned' })
      )
    ).resolves.toBeUndefined();
  f.core.exec(
    "INSERT INTO identity_subjects VALUES('org-subject','tenant-a','organization','active',NULL,NULL);INSERT INTO profiles(id,tenant_id,subject_id) VALUES('org-profile','tenant-a','org-subject')"
  );
  await expect(
    policy.admitRow!.admit(
      context,
      portable({ tenant_id: 'tenant-a', owner_type: 'profile', owner_id: 'org-profile' })
    )
  ).resolves.toBeUndefined();
  await expect(
    policy.admitRow!.admit(
      context,
      portable({ tenant_id: 'tenant-a', owner_type: 'profile', owner_id: 'unknown-profile' })
    )
  ).rejects.toThrow('authority_unavailable');
});

it('restores a current shared subject with two active canonical owners and keeps deleted-owner history from becoming authority', async () => {
  const f = fixture();
  const subject = {
    id: 'shared-subject',
    tenant_id: 'tenant-a',
    subject_type: 'person',
    lifecycle_state: 'active',
    primary_account_id: 'account-one',
    deleted_at: null,
  };
  f.core
    .prepare('INSERT INTO identity_subjects VALUES(?,?,?,?,?,?)')
    .run(...Object.values(subject));
  for (const [id, user, state] of [
    ['account-one', 'user-one', 'active'],
    ['account-two', 'user-two', 'active'],
    ['deleted-account', 'deleted-user', 'deleted'],
  ])
    f.core
      .prepare(
        'INSERT INTO identity_accounts(id,tenant_id,legacy_user_id,account_type,lifecycle_state,registration_state,account_route_generation,deleted_at,directory_publication_state,primary_subject_id) VALUES(?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        id,
        'tenant-a',
        user,
        'person',
        state,
        'registered',
        1,
        state === 'deleted' ? 5 : null,
        'active',
        'shared-subject'
      );
  const policy = f.policy('core.identity_subjects', ['id', 'primary_account_id']);
  await expect(policy.admitRow!.admit(context, portable(subject))).resolves.toBeUndefined();
  await expect(
    policy.admitRow!.admit(context, portable({ ...subject, primary_account_id: 'deleted-account' }))
  ).rejects.toThrow('authority_unavailable');
  f.core.exec("UPDATE identity_subjects SET primary_account_id='deleted-account'");
  await expect(
    policy.admitRow!.admit(context, portable({ ...subject, primary_account_id: 'deleted-account' }))
  ).rejects.toThrow('authority_unavailable');
});

it.each([
  "UPDATE identity_subjects SET lifecycle_state='deleted' WHERE id='subject-live'",
  "UPDATE identity_subjects SET primary_account_id='different-account' WHERE id='subject-live'",
  "UPDATE profiles SET subject_id='different-subject' WHERE id='profile-live'",
  "UPDATE profiles SET lifecycle_state='deleted',deleted_at=100 WHERE id='profile-live'",
])(
  'invalidates prepared and activation authority when a critical parent changes through the actual migration SQL: %s',
  async (mutation) => {
    const f = fixture();
    f.insertAccount();
    f.core.exec(
      "UPDATE identity_accounts SET primary_subject_id='subject-live';INSERT INTO identity_subjects VALUES('subject-live','tenant-a','person','active','account-live',NULL);INSERT INTO profiles(id,tenant_id,subject_id) VALUES('profile-live','tenant-a','subject-live')"
    );
    const migration = readFileSync(
      new URL('../../../../migrations/core/d1/034_guest_erasure_admission.sql', import.meta.url),
      'utf8'
    );
    const triggers = migration
      .split(/\n(?=CREATE TRIGGER )/u)
      .filter((value) =>
        /^CREATE TRIGGER trg_guest_core_(?:subject|profile)_(?:insert|update|delete)_epoch\b/u.test(
          value
        )
      );
    expect(triggers).toHaveLength(6);
    f.core.exec(triggers.join('\n'));
    const policy = f.policy('pii.identity_sensitive_values', [
      'owner_type',
      'owner_id',
      'tenant_id',
    ]);
    const json = portable({
      tenant_id: 'tenant-a',
      owner_type: 'profile',
      owner_id: 'profile-live',
    });
    await policy.restoreTransform!.prepareRows!(context, [json], 'write');
    await f.authority.page(context, planDigest, null);
    expect(await f.authority.ready(context, planDigest)).toBeDefined();
    f.core.exec(mutation);
    await expect(policy.restoreTransform!.assertPreparedRows!(context)).rejects.toThrow(
      'current_source_changed'
    );
    await expect(f.authority.ready(context, planDigest)).rejects.toThrow('current_source_changed');
  }
);

it('does not accept a snapshot profile parent or lifecycle that differs from its current primary owner', async () => {
  const f = fixture();
  f.insertAccount();
  f.core.exec(
    "UPDATE identity_accounts SET primary_subject_id='subject-live';INSERT INTO identity_subjects VALUES('subject-live','tenant-a','person','active','account-live',NULL);INSERT INTO profiles(id,tenant_id,subject_id) VALUES('profile-live','tenant-a','subject-live')"
  );
  const profile = {
    id: 'profile-live',
    tenant_id: 'tenant-a',
    subject_id: 'subject-live',
    profile_type: 'person',
    lifecycle_state: 'active',
    deleted_at: null,
  };
  const policy = f.policy('core.profiles', [
    'id',
    'tenant_id',
    'subject_id',
    'profile_type',
    'lifecycle_state',
    'deleted_at',
  ]);
  await expect(policy.admitRow!.admit(context, portable(profile))).resolves.toBeUndefined();
  await expect(
    policy.admitRow!.admit(context, portable({ ...profile, subject_id: 'different-subject' }))
  ).rejects.toThrow('authority_unavailable');
  await expect(
    policy.admitRow!.admit(context, portable({ ...profile, lifecycle_state: 'deleted' }))
  ).rejects.toThrow('authority_unavailable');
});
