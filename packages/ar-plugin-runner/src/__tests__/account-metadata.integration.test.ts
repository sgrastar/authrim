import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_ACCOUNT_METADATA_URL, PluginAccountMetadataService } from '../account-metadata';
import type { PluginEgressContext, PluginRunnerEnv } from '../types';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SECRET = 'plugin-account-metadata-test-secret';

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[] = []
  ) {}

  bind(...values: unknown[]) {
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

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.values) as T[] };
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class Session {
  private loseNextBatchResponse: boolean;

  constructor(
    private readonly database: DatabaseSync,
    loseNextBatchResponse = false
  ) {
    this.loseNextBatchResponse = loseNextBatchResponse;
  }

  prepare(sql: string) {
    return new BoundStatement(this.database.prepare(sql));
  }

  async batch(statements: BoundStatement[]) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec('COMMIT');
      if (this.loseNextBatchResponse) {
        this.loseNextBatchResponse = false;
        throw new Error('simulated_response_loss');
      }
      return results;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function d1(database: DatabaseSync, loseNextBatchResponse = false): D1Database {
  const session = new Session(database, loseNextBatchResponse);
  return {
    prepare: (sql: string) => session.prepare(sql),
    withSession: () => session,
    batch: (statements: BoundStatement[]) => session.batch(statements),
  } as unknown as D1Database;
}

const context: PluginEgressContext = {
  contractVersion: 1,
  tenantId: 'tenant-a',
  pluginInstallationId: 'installation-a',
  capability: 'notifier.send',
  requestId: 'request-a',
  executionScope: {
    accountId: 'account-a',
    bindingRef: 'TDB_USERS_JP_0001_CORE',
    dataRole: 'tenant_core/users',
    residencyPartition: 'jp',
  },
};

const mutation = {
  operationId: 'operation-a',
  accountId: 'account-a',
  metadataKey: 'delivery.preference',
  value: { channel: 'email', enabled: true },
  expectedVersion: null,
};

describe('PluginAccountMetadataService', () => {
  let runnerDatabase: DatabaseSync;
  let tenantDatabase: DatabaseSync;

  beforeEach(() => {
    runnerDatabase = new DatabaseSync(':memory:');
    tenantDatabase = new DatabaseSync(':memory:');
    runnerDatabase.exec('PRAGMA foreign_keys = ON');
    tenantDatabase.exec('PRAGMA foreign_keys = ON');
    for (const migrationName of [
      '001_plugin_runner.sql',
      '002_registry_installations_and_config.sql',
    ]) {
      runnerDatabase.exec(
        readFileSync(resolve(REPO_ROOT, 'migrations/plugin-runner', migrationName), 'utf8')
      );
    }
    tenantDatabase.exec(
      `CREATE TABLE identity_accounts (
         id TEXT PRIMARY KEY,
         tenant_id TEXT NOT NULL,
         account_type TEXT NOT NULL,
         lifecycle_state TEXT NOT NULL DEFAULT 'active',
         metadata_json TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       );`
    );
    tenantDatabase.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/034_plugin_account_metadata.sql'), 'utf8')
    );
    runnerDatabase.exec(
      `INSERT INTO plugin_runner_installations (
         installation_id, tenant_id, plugin_id, backend_kind, script_name,
         state, config_version, created_at, updated_at
       ) VALUES (
         'installation-a', 'tenant-a', 'plugin-a', 'dynamic_worker', 'plugin-a',
         'enabled', 1, 1, 1
       );
       INSERT INTO plugin_runner_approved_mutation_scopes (
         plugin_id, mutation_scope, approved_at
       ) VALUES ('plugin-a', 'account.metadata.write', 1);
       INSERT INTO plugin_runner_installation_mutation_scopes (
         installation_id, mutation_scope, state, updated_at
       ) VALUES ('installation-a', 'account.metadata.write', 'enabled', 1);`
    );
    tenantDatabase.exec(
      `INSERT INTO identity_accounts (
         id, tenant_id, account_type, lifecycle_state, metadata_json, created_at, updated_at
       ) VALUES (
         'account-a', 'tenant-a', 'human', 'active', '{"owned":"by-authrim"}', 1, 1
       );`
    );
  });

  afterEach(() => {
    runnerDatabase.close();
    tenantDatabase.close();
  });

  function environment(loseNextBatchResponse = false): PluginRunnerEnv {
    return {
      PLUGIN_RUNNER_DB: d1(runnerDatabase),
      TDB_USERS_JP_0001_CORE: d1(tenantDatabase, loseNextBatchResponse),
      AUTHRIM_PLUGIN_EGRESS_CONTEXT: context,
      PLUGIN_ENCRYPTION_KEY: SECRET,
      PLUGIN_MUTATION_HMAC_KEY: SECRET,
    } as unknown as PluginRunnerEnv;
  }

  it('writes only plugin-namespaced metadata and immutable redacted audit context', async () => {
    const result = await new PluginAccountMetadataService(environment(), SECRET, () => 1_000).write(
      context,
      mutation
    );

    expect(result).toEqual({
      operationId: 'operation-a',
      accountId: 'account-a',
      metadataKey: 'delivery.preference',
      version: 1,
    });
    expect(
      tenantDatabase
        .prepare(
          `SELECT tenant_id, account_id, plugin_id, plugin_installation_id,
                  metadata_key, value_json, version
             FROM plugin_account_metadata`
        )
        .get()
    ).toEqual({
      tenant_id: 'tenant-a',
      account_id: 'account-a',
      plugin_id: 'plugin-a',
      plugin_installation_id: 'installation-a',
      metadata_key: 'delivery.preference',
      value_json: '{"channel":"email","enabled":true}',
      version: 1,
    });
    expect(tenantDatabase.prepare(`SELECT metadata_json FROM identity_accounts`).get()).toEqual({
      metadata_json: '{"owned":"by-authrim"}',
    });
    const audit = tenantDatabase.prepare(`SELECT * FROM plugin_account_metadata_audit`).get() as
      | Record<string, unknown>
      | undefined;
    expect(audit).toMatchObject({
      actor_type: 'plugin',
      mutation_scope: 'account.metadata.write',
      data_role: 'tenant_core/users',
      residency_partition: 'jp',
      capability: 'notifier.send',
    });
    expect(JSON.stringify(audit)).not.toContain('email');
    expect(() =>
      tenantDatabase.exec(`UPDATE plugin_account_metadata_audit SET request_id = 'tampered'`)
    ).toThrow('plugin_account_metadata_audit_immutable');
    expect(() =>
      tenantDatabase.exec(`UPDATE plugin_account_metadata_mutations SET request_id = 'tampered'`)
    ).toThrow('plugin_account_metadata_mutation_immutable');
  });

  it('adopts response loss and canonical idempotent retries but rejects changed reuse', async () => {
    const service = new PluginAccountMetadataService(environment(true), SECRET, () => 1_000);
    await expect(service.write(context, mutation)).resolves.toMatchObject({ version: 1 });
    await expect(
      new PluginAccountMetadataService(environment(), SECRET, () => 1_001).write(context, {
        ...mutation,
        value: { enabled: true, channel: 'email' },
      })
    ).resolves.toMatchObject({ version: 1 });
    await expect(
      new PluginAccountMetadataService(environment(), SECRET, () => 1_002).write(context, {
        ...mutation,
        value: { enabled: false, channel: 'email' },
      })
    ).rejects.toThrow('plugin_data_idempotency_conflict');
    expect(
      tenantDatabase.prepare(`SELECT COUNT(*) AS count FROM plugin_account_metadata_audit`).get()
    ).toEqual({ count: 1 });
  });

  it('keeps mutation idempotency independent from plugin credential encryption rotation', async () => {
    const beforeRotation = environment();
    await new PluginAccountMetadataService(beforeRotation, undefined, () => 1_000).write(
      context,
      mutation
    );

    const afterRotation = {
      ...environment(),
      PLUGIN_ENCRYPTION_KEY: 'rotated-plugin-encryption-secret-value',
    };
    await expect(
      new PluginAccountMetadataService(afterRotation, undefined, () => 2_000).write(
        context,
        mutation
      )
    ).resolves.toMatchObject({ version: 1 });
    expect(
      tenantDatabase
        .prepare(`SELECT fingerprint_key_id FROM plugin_account_metadata_mutations`)
        .get()
    ).toEqual({ fingerprint_key_id: 'mutation-v1' });
  });

  it('fails closed when the dedicated mutation HMAC key is unavailable', () => {
    expect(
      () =>
        new PluginAccountMetadataService({
          ...environment(),
          PLUGIN_MUTATION_HMAC_KEY: '',
        })
    ).toThrow('plugin_data_hmac_key_invalid');
  });

  it('uses optimistic versions and does not create audit evidence for a rejected write', async () => {
    const service = new PluginAccountMetadataService(environment(), SECRET, () => 1_000);
    await service.write(context, mutation);
    await expect(
      service.write(context, { ...mutation, operationId: 'operation-b', expectedVersion: 1 })
    ).resolves.toMatchObject({ version: 2 });
    await expect(
      service.write(context, { ...mutation, operationId: 'operation-c', expectedVersion: 1 })
    ).rejects.toThrow('plugin_data_version_conflict');
    expect(
      tenantDatabase.prepare(`SELECT COUNT(*) AS count FROM plugin_account_metadata_audit`).get()
    ).toEqual({ count: 2 });
  });

  it('fails closed for tenant, role, account lifecycle, and approval boundary violations', async () => {
    const service = new PluginAccountMetadataService(environment(), SECRET, () => 1_000);
    await expect(
      service.write(
        {
          ...context,
          executionScope: {
            accountId: 'account-a',
            bindingRef: 'TDB_USERS_JP_0001_CORE',
            dataRole: 'tenant_core/default',
            residencyPartition: 'jp',
          },
        },
        mutation
      )
    ).rejects.toThrow('plugin_data_scope_denied');
    await expect(service.write({ ...context, tenantId: 'tenant-b' }, mutation)).rejects.toThrow(
      'plugin_data_scope_denied'
    );
    await expect(
      service.write(
        {
          ...context,
          executionScope: {
            accountId: 'account-b',
            bindingRef: 'TDB_USERS_JP_0001_CORE',
            dataRole: 'tenant_core/users',
            residencyPartition: 'jp',
          },
        },
        mutation
      )
    ).rejects.toThrow('plugin_data_scope_denied');
    tenantDatabase.exec(`UPDATE identity_accounts SET lifecycle_state = 'disabled'`);
    await expect(service.write(context, mutation)).rejects.toThrow(
      'plugin_data_account_unavailable'
    );
    tenantDatabase.exec(`UPDATE identity_accounts SET lifecycle_state = 'active'`);
    runnerDatabase.exec(`UPDATE plugin_runner_installation_mutation_scopes SET state = 'disabled'`);
    await expect(service.write(context, mutation)).rejects.toThrow('plugin_data_scope_denied');
    expect(
      tenantDatabase.prepare(`SELECT COUNT(*) AS count FROM plugin_account_metadata`).get()
    ).toEqual({ count: 0 });
  });

  it('exposes only the fixed PUT JSON contract to a Dynamic Worker', async () => {
    const service = new PluginAccountMetadataService(environment(), SECRET, () => 1_000);
    const response = await service.handle(
      new Request(PLUGIN_ACCOUNT_METADATA_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mutation),
      })
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ version: 1 });
    await expect(
      service.handle(
        new Request(PLUGIN_ACCOUNT_METADATA_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      )
    ).rejects.toThrow('plugin_data_method_denied');
  });

  it('cancels an undeclared oversized mutation request before parsing or writing', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request(PLUGIN_ACCOUNT_METADATA_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    } as never);

    await expect(
      new PluginAccountMetadataService(environment(), SECRET, () => 1_000).handle(request)
    ).rejects.toThrow('plugin_data_input_invalid');
    expect(cancelled).toBe(true);
    expect(
      tenantDatabase.prepare(`SELECT COUNT(*) AS count FROM plugin_account_metadata`).get()
    ).toEqual({ count: 0 });
  });
});
