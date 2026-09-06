import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1NotificationProviderOrderStore } from '../notification-provider-order';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return {
      success: true,
      results: this.statement.all(...this.values) as T[],
      meta: { changes: 0 },
    };
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
    loseNextBatchResponse: boolean
  ) {
    this.loseNextBatchResponse = loseNextBatchResponse;
  }

  prepare(sql: string) {
    const statement = this.database.prepare(sql);
    return {
      bind: (...values: unknown[]) =>
        new BoundStatement(
          statement,
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
        ),
    };
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
  } as unknown as D1Database;
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    operationId: 'provider-order-operation-a',
    tenantId: 'tenant-a',
    channel: 'email',
    expectedConfigVersion: 0,
    installationIds: ['installation-resend', 'installation-cloudflare'],
    ...overrides,
  };
}

describe('D1NotificationProviderOrderStore', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    for (const migration of ['001_0_4_0_plugin_runner_baseline.sql']) {
      database.exec(
        readFileSync(resolve(REPO_ROOT, 'migrations/plugin-runner/d1', migration), 'utf8')
      );
    }
    database.exec(
      `INSERT INTO plugin_runner_installations (
         installation_id, tenant_id, plugin_id, backend_kind, script_name,
         state, config_version, created_at, updated_at
       ) VALUES
         ('installation-resend', 'tenant-a', 'notifier-resend', 'in_process', NULL,
          'enabled', 1, 1, 1),
         ('installation-cloudflare', 'tenant-a', 'notifier-cloudflare', 'in_process', NULL,
          'enabled', 1, 1, 1),
         ('installation-other-tenant', 'tenant-b', 'notifier-resend', 'in_process', NULL,
          'enabled', 1, 1, 1),
         ('installation-disabled', 'tenant-a', 'notifier-disabled', 'dynamic_worker',
          'notifier-disabled', 'disabled', 1, 1, 1);`
    );
  });

  afterEach(() => database.close());

  it('materializes and resolves only the explicit provider order', async () => {
    const store = new D1NotificationProviderOrderStore(d1(database), () => 1_000);
    await expect(store.replace(request())).resolves.toEqual({
      tenantId: 'tenant-a',
      channel: 'email',
      configVersion: 1,
      state: 'enabled',
      installationIds: ['installation-resend', 'installation-cloudflare'],
    });
    await expect(store.resolve({ tenantId: 'tenant-a', channel: 'email' })).resolves.toEqual({
      tenantId: 'tenant-a',
      channel: 'email',
      configVersion: 1,
      state: 'enabled',
      installationIds: ['installation-resend', 'installation-cloudflare'],
    });
  });

  it('persists an explicit empty order as disabled without provider inference', async () => {
    const store = new D1NotificationProviderOrderStore(d1(database), () => 1_000);
    await expect(store.replace(request({ installationIds: [] }))).resolves.toMatchObject({
      configVersion: 1,
      state: 'disabled',
      installationIds: [],
    });
    await expect(store.resolve({ tenantId: 'tenant-a', channel: 'email' })).resolves.toMatchObject({
      state: 'disabled',
      installationIds: [],
    });
  });

  it('adopts an exact committed mutation after response loss', async () => {
    const input = request();
    const lossy = new D1NotificationProviderOrderStore(d1(database, true), () => 1_000);
    await expect(lossy.replace(input)).resolves.toMatchObject({ configVersion: 1 });
    await expect(lossy.replace(input)).resolves.toMatchObject({ configVersion: 1 });
  });

  it('rejects operation reuse, stale versions, duplicates, and implicit installations', async () => {
    const store = new D1NotificationProviderOrderStore(d1(database), () => 1_000);
    await store.replace(request());
    await expect(
      store.replace(
        request({ installationIds: ['installation-cloudflare', 'installation-resend'] })
      )
    ).rejects.toThrow('plugin_notification_provider_order_idempotency_conflict');
    await expect(
      store.replace(request({ operationId: 'provider-order-operation-b' }))
    ).rejects.toThrow('plugin_notification_provider_order_version_conflict');
    await expect(
      store.replace(
        request({
          operationId: 'provider-order-operation-c',
          expectedConfigVersion: 1,
          installationIds: ['installation-resend', 'installation-resend'],
        })
      )
    ).rejects.toThrow('plugin_notification_provider_order_input_invalid');
  });

  it.each(['installation-other-tenant', 'installation-disabled'])(
    'rolls back a route containing unavailable installation %s',
    async (installationId) => {
      const store = new D1NotificationProviderOrderStore(d1(database), () => 1_000);
      await expect(store.replace(request({ installationIds: [installationId] }))).rejects.toThrow(
        'plugin_notification_provider_order_batch_failed'
      );
      expect(
        database
          .prepare(`SELECT COUNT(*) AS count FROM plugin_runner_notification_route_sets`)
          .get()
      ).toEqual({ count: 0 });
    }
  );

  it('fails closed when a materialized installation is later disabled', async () => {
    const store = new D1NotificationProviderOrderStore(d1(database), () => 1_000);
    await store.replace(request());
    database
      .prepare(
        `UPDATE plugin_runner_installations SET state = 'disabled' WHERE installation_id = ?`
      )
      .run('installation-resend');
    await expect(store.resolve({ tenantId: 'tenant-a', channel: 'email' })).rejects.toThrow(
      'plugin_notification_provider_order_reflection_invalid'
    );
  });

  it('requires an explicit route set instead of falling back to enabled installations', async () => {
    const store = new D1NotificationProviderOrderStore(d1(database), () => 1_000);
    await expect(store.resolve({ tenantId: 'tenant-a', channel: 'email' })).rejects.toThrow(
      'plugin_notification_provider_order_unavailable'
    );
  });
});
