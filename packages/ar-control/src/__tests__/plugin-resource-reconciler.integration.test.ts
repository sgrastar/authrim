import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  managedPluginResourceName,
  PluginResourceReconciler,
  type PluginResourceReconcilerClients,
} from '../plugin-resource-reconciler';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FINGERPRINT = 'a'.repeat(64);

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(
      this.statement,
      values.map((value) => {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          value === null ||
          value instanceof Uint8Array
        ) {
          return value;
        }
        throw new Error('unsupported_test_sqlite_value');
      })
    );
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new PreparedStatement(database.prepare(sql));
    },
    async batch(statements: BoundStatement[]) {
      database.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function unavailable(): never {
  throw new Error('unexpected_resource_class_client');
}

function clients(
  overrides: Partial<PluginResourceReconcilerClients> = {}
): PluginResourceReconcilerClients {
  return {
    d1: {
      listD1Databases: unavailable,
      getD1Database: unavailable,
      createD1Database: unavailable,
      updateD1Database: unavailable,
      deleteD1Database: unavailable,
      queryD1: unavailable,
      queryD1Batch: unavailable,
      rawD1: unavailable,
      importD1: unavailable,
    },
    kv: {
      listKvNamespaces: unavailable,
      createKvNamespace: unavailable,
      deleteKvNamespace: unavailable,
    },
    r2: {
      listR2Buckets: unavailable,
      createR2Bucket: unavailable,
      deleteR2Bucket: unavailable,
    },
    ...overrides,
  } as PluginResourceReconcilerClients;
}

describe('PluginResourceReconciler', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/control/001_0_4_0_control_baseline.sql'), 'utf8')
    );
    database.exec(`
      INSERT INTO control_environments (
        environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
      ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1);
    `);
  });

  afterEach(() => database.close());

  function insertResource(input: {
    kind: 'd1' | 'kv_namespace' | 'r2_bucket';
    lifecycle?: 'managed' | 'existing';
    providerId?: string;
    providerName?: string;
    fingerprint?: string;
    resourceId?: string;
  }) {
    const fingerprint = input.fingerprint ?? FINGERPRINT;
    const resourceId = input.resourceId ?? 'plugin-resource-v1-a';
    const lifecycle = input.lifecycle ?? 'managed';
    const operationId = `op-${resourceId}`;
    const stepPrefix = `plugin_resource_${fingerprint.slice(0, 20)}`;
    database
      .prepare(
        `INSERT INTO control_operations (
           operation_id, environment_id, operation_kind, idempotency_key, status,
           requested_by_type, attempt_count, created_at, updated_at
         ) VALUES (?, 'test', 'provision_plugin_resources', ?, 'queued', 'admin', 0, 1, 1)`
      )
      .run(operationId, operationId);
    for (const [suffix, order, status] of [
      ['provider', 0, 'queued'],
      ['migration', 10, input.kind === 'd1' ? 'queued' : 'skipped'],
      ['binding', 20, 'queued'],
    ] as const) {
      database
        .prepare(
          `INSERT INTO control_operation_steps (
             operation_id, step_key, display_order, status, updated_at
           ) VALUES (?, ?, ?, ?, 1)`
        )
        .run(operationId, `${stepPrefix}_${suffix}`, order, status);
    }
    database
      .prepare(
        `INSERT INTO control_plugin_desired_resources (
           plugin_resource_id, environment_id, operation_id, plugin_installation_id,
           tenant_id, resource_kind, logical_resource_id, binding_name, lifecycle_mode,
           provider_resource_id, provider_name, injection_policy_json,
           desired_spec_json, status, updated_at
         ) VALUES (?, 'test', ?, 'installation-a', 'tenant-a', ?, 'state', 'PLUGIN_STATE',
           ?, ?, ?, '{}', ?, 'pending', 1)`
      )
      .run(
        resourceId,
        operationId,
        input.kind,
        lifecycle,
        input.providerId ?? null,
        input.providerName ?? null,
        JSON.stringify({
          ownershipFingerprint: fingerprint,
          ownership: lifecycle === 'managed' ? 'authrim_managed' : 'external_reference',
          deleteProviderResource: lifecycle === 'managed',
        })
      );
    return { operationId, resourceId, stepPrefix, fingerprint };
  }

  it('creates and reflects a deterministic managed KV namespace through only the KV client', async () => {
    const inserted = insertResource({ kind: 'kv_namespace' });
    const namespaces: Array<{ id: string; title: string }> = [];
    const create = vi.fn(async (title: string) => {
      const namespace = { id: 'kv-a', title };
      namespaces.push(namespace);
      return namespace;
    });
    const reconciler = new PluginResourceReconciler(
      d1(database),
      clients({
        kv: {
          listKvNamespaces: vi.fn(async () => [...namespaces]),
          createKvNamespace: create,
          deleteKvNamespace: unavailable,
        },
      }),
      () => 100
    );

    await expect(reconciler.reconcile()).resolves.toBe(1);

    const expectedName = managedPluginResourceName('test', inserted.fingerprint, 'kv_namespace');
    expect(create).toHaveBeenCalledWith(expectedName);
    expect(
      database
        .prepare(
          `SELECT provider_create_state, provider_resource_id, provider_name,
                  provider_identity_checkpointed_at, status
             FROM control_plugin_desired_resources`
        )
        .get()
    ).toEqual({
      provider_create_state: 'identified',
      provider_resource_id: 'kv-a',
      provider_name: expectedName,
      provider_identity_checkpointed_at: 100,
      status: 'ready',
    });
    expect(
      database
        .prepare(
          `SELECT status, observed_resource_id FROM control_operation_steps WHERE step_key = ?`
        )
        .get(`${inserted.stepPrefix}_provider`)
    ).toEqual({ status: 'succeeded', observed_resource_id: 'kv-a' });
  });

  it('resumes a managed D1 only from its checkpointed UUID', async () => {
    const inserted = insertResource({ kind: 'd1' });
    const expectedName = managedPluginResourceName('test', inserted.fingerprint, 'd1');
    database
      .prepare(
        `UPDATE control_plugin_desired_resources
            SET provider_create_state = 'identified', provider_resource_id = 'exact-database-id',
                provider_name = ?, provider_identity_checkpointed_at = 50
          WHERE plugin_resource_id = ?`
      )
      .run(expectedName, inserted.resourceId);
    const list = vi.fn();
    const create = vi.fn();
    const get = vi.fn(async (databaseId: string) => ({
      uuid: databaseId,
      name: expectedName,
      read_replication: { mode: 'disabled' as const },
    }));
    const reconciler = new PluginResourceReconciler(
      d1(database),
      clients({
        d1: {
          ...clients().d1,
          listD1Databases: list,
          createD1Database: create,
          getD1Database: get,
        },
      }),
      () => 100
    );

    await expect(reconciler.reconcile()).resolves.toBe(1);

    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith('exact-database-id');
    expect(database.prepare(`SELECT status FROM control_plugin_desired_resources`).get()).toEqual({
      status: 'ready',
    });
  });

  it('rolls the success and failure projections back when the provider step disappears', async () => {
    const inserted = insertResource({ kind: 'd1' });
    const expectedName = managedPluginResourceName('test', inserted.fingerprint, 'd1');
    database
      .prepare(
        `UPDATE control_plugin_desired_resources
            SET provider_create_state = 'identified', provider_resource_id = 'exact-database-id',
                provider_name = ?, provider_identity_checkpointed_at = 50
          WHERE plugin_resource_id = ?`
      )
      .run(expectedName, inserted.resourceId);
    const reconciler = new PluginResourceReconciler(
      d1(database),
      clients({
        d1: {
          ...clients().d1,
          listD1Databases: vi.fn(),
          createD1Database: vi.fn(),
          getD1Database: vi.fn(async (databaseId: string) => {
            database
              .prepare(
                `DELETE FROM control_operation_steps
                  WHERE operation_id = ? AND step_key = ?`
              )
              .run(inserted.operationId, `${inserted.stepPrefix}_provider`);
            return {
              uuid: databaseId,
              name: expectedName,
              read_replication: { mode: 'disabled' as const },
            };
          }),
        },
      }),
      () => 100
    );

    await expect(reconciler.reconcile()).rejects.toThrow(
      'plugin_resource_provider_projection_mismatch'
    );
    expect(
      database
        .prepare(
          `SELECT status, provider_create_state, provider_resource_id
             FROM control_plugin_desired_resources`
        )
        .get()
    ).toEqual({
      status: 'pending',
      provider_create_state: 'identified',
      provider_resource_id: 'exact-database-id',
    });
    expect(
      database
        .prepare(
          `SELECT status, lock_owner, fencing_token FROM control_operations
            WHERE operation_id = ?`
        )
        .get(inserted.operationId)
    ).toEqual({
      status: 'running',
      lock_owner: 'plugin-resource-reconciler',
      fencing_token: 1,
    });
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM control_audit_events WHERE operation_id = ?`)
        .get(inserted.operationId)
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM control_plugin_provider_projection_assertions`)
        .get()
    ).toEqual({ count: 0 });
  });

  it('rejects an unowned same-name namespace instead of adopting it', async () => {
    const inserted = insertResource({ kind: 'kv_namespace' });
    const expectedName = managedPluginResourceName('test', inserted.fingerprint, 'kv_namespace');
    const create = vi.fn();
    const reconciler = new PluginResourceReconciler(
      d1(database),
      clients({
        kv: {
          listKvNamespaces: vi.fn(async () => [{ id: 'unowned-id', title: expectedName }]),
          createKvNamespace: create,
          deleteKvNamespace: unavailable,
        },
      }),
      () => 100
    );

    await expect(reconciler.reconcile()).resolves.toBe(1);

    expect(create).not.toHaveBeenCalled();
    expect(
      database.prepare(`SELECT status, last_error_code FROM control_operations`).get()
    ).toEqual({
      status: 'blocked',
      last_error_code: 'plugin_resource_provider_name_conflict',
    });
  });

  it('blocks an ambiguous managed namespace response without creating a duplicate', async () => {
    const inserted = insertResource({ kind: 'kv_namespace' });
    const expectedName = managedPluginResourceName('test', inserted.fingerprint, 'kv_namespace');
    const namespaces: Array<{ id: string; title: string }> = [];
    const create = vi.fn(async (title: string) => {
      namespaces.push({ id: 'kv-created-before-response-loss', title });
      throw new Error('response_lost');
    });
    const reconciler = new PluginResourceReconciler(
      d1(database),
      clients({
        kv: {
          listKvNamespaces: vi.fn(async () => [...namespaces]),
          createKvNamespace: create,
          deleteKvNamespace: unavailable,
        },
      }),
      () => 100
    );

    await reconciler.reconcile();
    await expect(reconciler.reconcile()).resolves.toBe(0);

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(expectedName);
    expect(
      database
        .prepare(
          `SELECT provider_create_state, provider_resource_id, status
             FROM control_plugin_desired_resources`
        )
        .get()
    ).toEqual({ provider_create_state: 'issued', provider_resource_id: null, status: 'failed' });
    expect(
      database.prepare(`SELECT status, last_error_code FROM control_operations`).get()
    ).toEqual({
      status: 'blocked',
      last_error_code: 'plugin_resource_create_outcome_ambiguous',
    });
  });

  it('blocks an ambiguous managed D1 response without creating a duplicate', async () => {
    const inserted = insertResource({ kind: 'd1' });
    const expectedName = managedPluginResourceName('test', inserted.fingerprint, 'd1');
    const databases: Array<{
      uuid: string;
      name: string;
      read_replication: { mode: 'disabled' };
    }> = [];
    const create = vi.fn(async ({ name }: { name: string }) => {
      databases.push({
        uuid: 'd1-created-before-response-loss',
        name,
        read_replication: { mode: 'disabled' },
      });
      throw new Error('response_lost');
    });
    const reconciler = new PluginResourceReconciler(
      d1(database),
      clients({
        d1: {
          listD1Databases: vi.fn(async () => [...databases]),
          createD1Database: create,
          getD1Database: vi.fn(async (databaseId: string) => {
            const reflected = databases.find((candidate) => candidate.uuid === databaseId);
            if (!reflected) throw new Error('not_found');
            return reflected;
          }),
          updateD1Database: vi.fn(),
          deleteD1Database: unavailable,
          queryD1: unavailable,
          queryD1Batch: unavailable,
          rawD1: unavailable,
          importD1: unavailable,
        },
      }),
      () => 100
    );

    await expect(reconciler.reconcile()).resolves.toBe(1);
    await expect(reconciler.reconcile()).resolves.toBe(0);

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ name: expectedName });
    expect(
      database
        .prepare(
          `SELECT provider_create_state, provider_resource_id, status
             FROM control_plugin_desired_resources`
        )
        .get()
    ).toEqual({ provider_create_state: 'issued', provider_resource_id: null, status: 'failed' });
  });

  it('hands managed R2 creation to Setup before any provider request', async () => {
    insertResource({ kind: 'r2_bucket' });
    const list = vi.fn(async () => []);
    const create = vi.fn(async (name: string) => ({ name }));
    const reconciler = new PluginResourceReconciler(
      d1(database),
      clients({
        r2: {
          listR2Buckets: list,
          createR2Bucket: create,
          deleteR2Bucket: unavailable,
        },
      }),
      () => 100
    );

    await expect(reconciler.reconcile()).resolves.toBe(1);

    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(
      database
        .prepare(
          `SELECT provider_create_state, provider_resource_id, status
             FROM control_plugin_desired_resources`
        )
        .get()
    ).toEqual({
      provider_create_state: 'not_started',
      provider_resource_id: null,
      status: 'failed',
    });
    expect(
      database.prepare(`SELECT status, last_error_code FROM control_operations`).get()
    ).toEqual({
      status: 'blocked',
      last_error_code: 'operator_action_required',
    });
  });

  it('blocks an existing-resource name mismatch without mutating or deleting the provider', async () => {
    insertResource({
      kind: 'kv_namespace',
      lifecycle: 'existing',
      providerId: 'kv-existing',
      providerName: 'expected-name',
    });
    const deleteNamespace = vi.fn();
    const reconciler = new PluginResourceReconciler(
      d1(database),
      clients({
        kv: {
          listKvNamespaces: vi.fn(async () => [{ id: 'kv-existing', title: 'different-name' }]),
          createKvNamespace: vi.fn(),
          deleteKvNamespace: deleteNamespace,
        },
      }),
      () => 100
    );

    await reconciler.reconcile();

    expect(deleteNamespace).not.toHaveBeenCalled();
    expect(database.prepare(`SELECT status FROM control_plugin_desired_resources`).get()).toEqual({
      status: 'failed',
    });
    expect(
      database.prepare(`SELECT status, last_error_code FROM control_operations`).get()
    ).toEqual({ status: 'blocked', last_error_code: 'plugin_resource_existing_identity_mismatch' });
  });

  it('hands a missing resource-class token to the setup operator without retrying', async () => {
    const inserted = insertResource({ kind: 'kv_namespace' });
    const reconciler = new PluginResourceReconciler(
      d1(database),
      clients({
        kv: {
          listKvNamespaces: vi.fn(async () => {
            throw new Error('cloudflare_kv_token_required_for:kv.namespace.list');
          }),
          createKvNamespace: vi.fn(),
          deleteKvNamespace: vi.fn(),
        },
      }),
      () => 100
    );

    await expect(reconciler.reconcile()).resolves.toBe(1);

    expect(database.prepare(`SELECT status FROM control_plugin_desired_resources`).get()).toEqual({
      status: 'failed',
    });
    expect(
      database
        .prepare(`SELECT status, next_attempt_at, last_error_code FROM control_operations`)
        .get()
    ).toEqual({
      status: 'blocked',
      next_attempt_at: null,
      last_error_code: 'operator_action_required',
    });
    expect(
      database
        .prepare(
          `SELECT status, next_attempt_at, last_error_code
             FROM control_operation_steps WHERE step_key = ?`
        )
        .get(`${inserted.stepPrefix}_provider`)
    ).toEqual({
      status: 'blocked',
      next_attempt_at: null,
      last_error_code: 'operator_action_required',
    });
  });

  it('hands a rejected resource-class token to the setup operator without credential fallback', async () => {
    insertResource({ kind: 'r2_bucket' });
    const rejected = Object.assign(new Error('cloudflare_api_error:r2.bucket.list:403'), {
      status: 403,
    });
    const reconciler = new PluginResourceReconciler(
      d1(database),
      clients({
        r2: {
          listR2Buckets: vi.fn(async () => {
            throw rejected;
          }),
          createR2Bucket: vi.fn(),
          deleteR2Bucket: vi.fn(),
        },
      }),
      () => 100
    );

    await expect(reconciler.reconcile()).resolves.toBe(1);

    expect(
      database.prepare(`SELECT status, last_error_code FROM control_operations`).get()
    ).toEqual({ status: 'blocked', last_error_code: 'operator_action_required' });
    expect(
      database
        .prepare(
          `SELECT redacted_payload_json FROM control_audit_events
            WHERE event_type = 'plugin.resource.provider.failed'`
        )
        .get()
    ).toEqual({
      redacted_payload_json: JSON.stringify({
        code: 'operator_action_required',
        kind: 'r2_bucket',
      }),
    });
  });

  it('keeps D1 non-active after deterministic creation because migration and binding remain', async () => {
    const inserted = insertResource({ kind: 'd1' });
    const expectedName = managedPluginResourceName('test', inserted.fingerprint, 'd1');
    const update = vi.fn(async () => ({
      uuid: 'db-a',
      name: expectedName,
      read_replication: { mode: 'disabled' as const },
    }));
    const reconciler = new PluginResourceReconciler(
      d1(database),
      clients({
        d1: {
          ...clients().d1,
          listD1Databases: vi.fn(async () => []),
          createD1Database: vi.fn(async () => ({
            uuid: 'db-a',
            name: expectedName,
            read_replication: { mode: 'auto' as const },
          })),
          updateD1Database: update,
          getD1Database: vi.fn(async () => ({
            uuid: 'db-a',
            name: expectedName,
            read_replication: { mode: 'disabled' as const },
          })),
        },
      }),
      () => 100
    );

    await reconciler.reconcile();

    expect(update).toHaveBeenCalledWith('db-a', { read_replication: { mode: 'disabled' } });
    expect(database.prepare(`SELECT status FROM control_plugin_desired_resources`).get()).toEqual({
      status: 'ready',
    });
    expect(
      database
        .prepare(`SELECT status FROM control_operation_steps WHERE step_key = ?`)
        .get(`${inserted.stepPrefix}_migration`)
    ).toEqual({ status: 'queued' });
  });

  it('serializes concurrent reconciliation and never creates the same provider resource twice', async () => {
    insertResource({ kind: 'kv_namespace' });
    const namespaces: Array<{ id: string; title: string }> = [];
    const create = vi.fn(async (title: string) => {
      await Promise.resolve();
      const namespace = { id: 'kv-a', title };
      namespaces.push(namespace);
      return namespace;
    });
    const api = clients({
      kv: {
        listKvNamespaces: vi.fn(async () => [...namespaces]),
        createKvNamespace: create,
        deleteKvNamespace: unavailable,
      },
    });
    const first = new PluginResourceReconciler(d1(database), api, () => 100);
    const second = new PluginResourceReconciler(d1(database), api, () => 100);

    await Promise.all([first.reconcile(), second.reconcile()]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(database.prepare(`SELECT status FROM control_plugin_desired_resources`).get()).toEqual({
      status: 'ready',
    });
  });
});
