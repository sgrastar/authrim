import { describe, expect, it, vi } from 'vitest';
import {
  managedPluginResourceName,
  PluginResourceReconciler,
  type PluginResourceReconcilerClients,
} from '../plugin-resource-reconciler';

const NOW = 1_800_000_000;
const FINGERPRINT = 'a'.repeat(64);

interface Statement {
  sql: string;
  values: unknown[];
}

function resource(overrides: Record<string, unknown> = {}) {
  return {
    plugin_resource_id: 'resource-a',
    environment_id: 'environment-a',
    operation_id: 'operation-a',
    plugin_installation_id: 'installation-a',
    tenant_id: 'tenant-a',
    resource_kind: 'kv_namespace',
    logical_resource_id: 'cache',
    lifecycle_mode: 'existing',
    provider_resource_id: 'namespace-a',
    provider_name: 'namespace-a',
    provider_create_state: 'not_started',
    provider_creation_date: null,
    provider_ownership_marker_key: null,
    provider_ownership_id: null,
    provider_identity_checkpointed_at: null,
    desired_spec_json: JSON.stringify({
      ownershipFingerprint: FINGERPRINT,
      ownership: 'external_reference',
      deleteProviderResource: false,
    }),
    status: 'pending',
    operation_status: 'queued',
    next_attempt_at: null,
    ...overrides,
  };
}

function fixture(
  input: {
    row?: ReturnType<typeof resource>;
    claim?: { fencing_token: number; attempt_count: number } | null;
    currentStatus?: string | null;
    collision?: boolean;
  } = {}
) {
  const row = input.row ?? resource();
  const statements: Statement[] = [];
  const batches: Statement[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          const statement = { sql, values };
          statements.push(statement);
          return {
            sql,
            values,
            async all() {
              return { results: [row] };
            },
            async first() {
              if (sql.includes('RETURNING fencing_token')) {
                return input.claim === undefined
                  ? { fencing_token: 7, attempt_count: 3 }
                  : input.claim;
              }
              if (sql.includes('SELECT status FROM control_plugin_desired_resources')) {
                return input.currentStatus === undefined
                  ? { status: 'pending' }
                  : input.currentStatus === null
                    ? null
                    : { status: input.currentStatus };
              }
              if (sql.includes('SELECT plugin_resource_id FROM control_plugin_desired_resources')) {
                return input.collision ? { plugin_resource_id: 'resource-b' } : null;
              }
              return null;
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(entries: Statement[]) {
      batches.push(entries);
      return entries.map(() => ({ meta: { changes: 1 } }));
    },
  } as unknown as D1Database;
  const clients = {
    d1: {
      getD1Database: vi.fn(),
      listD1Databases: vi.fn(),
      createD1Database: vi.fn(),
      updateD1Database: vi.fn(),
    },
    kv: {
      listKvNamespaces: vi.fn(async () => [{ id: 'namespace-a', title: 'namespace-a' }]),
      createKvNamespace: vi.fn(),
    },
    r2: {
      listR2Buckets: vi.fn(),
      createR2Bucket: vi.fn(),
    },
  } as unknown as PluginResourceReconcilerClients;
  return {
    db,
    clients,
    statements,
    batches,
    reconciler: new PluginResourceReconciler(db, clients, () => NOW),
  };
}

function statement(statements: Statement[], text: string): Statement {
  const found = statements.find((entry) => entry.sql.includes(text));
  if (!found) throw new Error(`Expected SQL statement: ${text}`);
  return found;
}

describe('PluginResourceReconciler failure and ownership guards', () => {
  it('blocks an invalid desired spec without calling a provider or recording a step', async () => {
    const harness = fixture({ row: resource({ desired_spec_json: '{private-token:abc}' }) });

    await expect(harness.reconciler.reconcile()).resolves.toBe(1);

    expect(harness.clients.kv.listKvNamespaces).not.toHaveBeenCalled();
    expect(harness.clients.d1.getD1Database).not.toHaveBeenCalled();
    expect(harness.batches).toHaveLength(1);
    const writes = harness.batches[0];
    expect(statement(writes, 'SET status = ?, updated_at = ?').values[0]).toBe('failed');
    expect(writes.some((entry) => entry.sql.includes('UPDATE control_operation_steps'))).toBe(
      false
    );
    expect(statement(writes, 'SET status = ?, next_attempt_at = ?').values.slice(0, 4)).toEqual([
      'blocked',
      null,
      'plugin_resource_desired_spec_invalid',
      'plugin_resource_desired_spec_invalid',
    ]);
    const audit = statement(writes, "'plugin.resource.provider.failed'");
    expect(JSON.stringify(audit.values)).toContain('plugin_resource_desired_spec_invalid');
    expect(JSON.stringify(audit.values)).not.toContain('private-token');
  });

  it('releases a stale claim without provider calls or a success assertion', async () => {
    const harness = fixture({ currentStatus: 'ready' });

    await expect(harness.reconciler.reconcile()).resolves.toBe(0);

    expect(harness.clients.kv.listKvNamespaces).not.toHaveBeenCalled();
    expect(harness.batches).toHaveLength(0);
    expect(statement(harness.statements, 'SET lock_owner = NULL').values).toEqual([
      NOW,
      'operation-a',
      'environment-a',
      7,
    ]);
  });

  it('does not act when another reconciler has already claimed the operation', async () => {
    const harness = fixture({ claim: null });

    await expect(harness.reconciler.reconcile()).resolves.toBe(0);

    expect(harness.clients.kv.listKvNamespaces).not.toHaveBeenCalled();
    expect(harness.batches).toHaveLength(0);
    expect(
      harness.statements.some((entry) => entry.sql.includes('SELECT status FROM control_plugin'))
    ).toBe(false);
  });

  it('retries a provider outage with a redacted error and bounded backoff', async () => {
    const harness = fixture();
    vi.mocked(harness.clients.kv.listKvNamespaces).mockRejectedValue(
      Object.assign(new Error('token=secret-value'), { status: 503 })
    );

    await expect(harness.reconciler.reconcile()).resolves.toBe(1);

    const writes = harness.batches[0];
    expect(statement(writes, 'SET status = ?, updated_at = ?').values[0]).toBe('pending');
    expect(statement(writes, 'SET status = ?, next_attempt_at = ?').values.slice(0, 4)).toEqual([
      'waiting_retry',
      NOW + 120,
      'plugin_resource_provider_request_failed',
      'plugin_resource_provider_request_failed',
    ]);
    const audit = statement(writes, "'plugin.resource.provider.failed'");
    expect(JSON.stringify(audit.values)).not.toContain('secret-value');
    expect(JSON.stringify(audit.values)).toContain('plugin_resource_provider_request_failed');
  });

  it('blocks provider permission failures as operator action with no retry', async () => {
    const harness = fixture();
    vi.mocked(harness.clients.kv.listKvNamespaces).mockRejectedValue(
      Object.assign(new Error('token=secret-value'), { status: 403 })
    );

    await expect(harness.reconciler.reconcile()).resolves.toBe(1);

    const writes = harness.batches[0];
    expect(statement(writes, 'SET status = ?, updated_at = ?').values[0]).toBe('failed');
    expect(statement(writes, 'SET status = ?, next_attempt_at = ?').values.slice(0, 4)).toEqual([
      'blocked',
      null,
      'operator_action_required',
      'operator_action_required',
    ]);
  });

  it('refuses to create a managed R2 bucket without the ownership-marker executor', async () => {
    const harness = fixture({
      row: resource({
        resource_kind: 'r2_bucket',
        lifecycle_mode: 'managed',
        provider_resource_id: null,
        provider_name: null,
        desired_spec_json: JSON.stringify({
          ownershipFingerprint: FINGERPRINT,
          ownership: 'authrim_managed',
          deleteProviderResource: true,
        }),
      }),
    });

    await expect(harness.reconciler.reconcile()).resolves.toBe(1);

    expect(harness.clients.r2.createR2Bucket).not.toHaveBeenCalled();
    expect(statement(harness.batches[0], 'SET status = ?, next_attempt_at = ?').values[2]).toBe(
      'operator_action_required'
    );
  });

  it('blocks a provider identity already owned by another resource', async () => {
    const harness = fixture({ collision: true });

    await expect(harness.reconciler.reconcile()).resolves.toBe(1);

    expect(harness.clients.kv.listKvNamespaces).toHaveBeenCalledTimes(1);
    expect(statement(harness.statements, 'SELECT plugin_resource_id FROM').values).toEqual([
      'environment-a',
      'kv_namespace',
      'resource-a',
      'namespace-a',
      'namespace-a',
    ]);
    expect(statement(harness.batches[0], 'SET status = ?, next_attempt_at = ?').values[2]).toBe(
      'plugin_resource_provider_already_claimed'
    );
    expect(harness.batches[0].some((entry) => entry.sql.includes('provider.ready'))).toBe(false);
  });

  it('rejects a managed D1 identity that lacks its durable creation checkpoint', async () => {
    const harness = fixture({
      row: resource({
        resource_kind: 'd1',
        lifecycle_mode: 'managed',
        provider_resource_id: 'database-a',
        provider_name: managedPluginResourceName('environment-a', FINGERPRINT, 'd1'),
        provider_create_state: 'identified',
        provider_identity_checkpointed_at: null,
        desired_spec_json: JSON.stringify({
          ownershipFingerprint: FINGERPRINT,
          ownership: 'authrim_managed',
          deleteProviderResource: true,
        }),
      }),
    });

    await expect(harness.reconciler.reconcile()).resolves.toBe(1);

    expect(harness.clients.d1.getD1Database).not.toHaveBeenCalled();
    expect(harness.clients.d1.createD1Database).not.toHaveBeenCalled();
    expect(statement(harness.batches[0], 'SET status = ?, next_attempt_at = ?').values[2]).toBe(
      'plugin_resource_provider_checkpoint_invalid'
    );
  });

  it('disables D1 read replication and verifies the same checkpointed identity before success', async () => {
    const name = managedPluginResourceName('environment-a', FINGERPRINT, 'd1');
    const harness = fixture({
      row: resource({
        resource_kind: 'd1',
        lifecycle_mode: 'managed',
        provider_resource_id: 'database-a',
        provider_name: name,
        provider_create_state: 'identified',
        provider_identity_checkpointed_at: NOW - 10,
        desired_spec_json: JSON.stringify({
          ownershipFingerprint: FINGERPRINT,
          ownership: 'authrim_managed',
          deleteProviderResource: true,
        }),
      }),
    });
    vi.mocked(harness.clients.d1.getD1Database)
      .mockResolvedValueOnce({
        uuid: 'database-a',
        name,
        read_replication: { mode: 'auto' },
      } as never)
      .mockResolvedValueOnce({
        uuid: 'database-a',
        name,
        read_replication: { mode: 'disabled' },
      } as never);

    await expect(harness.reconciler.reconcile()).resolves.toBe(1);

    expect(harness.clients.d1.getD1Database).toHaveBeenCalledTimes(2);
    expect(harness.clients.d1.createD1Database).not.toHaveBeenCalled();
    expect(harness.clients.d1.updateD1Database).toHaveBeenCalledExactlyOnceWith('database-a', {
      read_replication: { mode: 'disabled' },
    });
    expect(harness.batches[0].some((entry) => entry.sql.includes('provider.ready'))).toBe(true);
    expect(harness.batches[0].some((entry) => entry.sql.includes('provider.failed'))).toBe(false);
  });

  it('rejects a reflected D1 identity that changes after replication is disabled', async () => {
    const name = managedPluginResourceName('environment-a', FINGERPRINT, 'd1');
    const harness = fixture({
      row: resource({
        resource_kind: 'd1',
        lifecycle_mode: 'managed',
        provider_resource_id: 'database-a',
        provider_name: name,
        provider_create_state: 'identified',
        provider_identity_checkpointed_at: NOW - 10,
        desired_spec_json: JSON.stringify({
          ownershipFingerprint: FINGERPRINT,
          ownership: 'authrim_managed',
          deleteProviderResource: true,
        }),
      }),
    });
    vi.mocked(harness.clients.d1.getD1Database)
      .mockResolvedValueOnce({
        uuid: 'database-a',
        name,
        read_replication: { mode: 'disabled' },
      } as never)
      .mockResolvedValueOnce({
        uuid: 'database-b',
        name,
        read_replication: { mode: 'disabled' },
      } as never);

    await expect(harness.reconciler.reconcile()).resolves.toBe(1);

    expect(harness.clients.d1.updateD1Database).not.toHaveBeenCalled();
    expect(harness.batches[0].some((entry) => entry.sql.includes('provider.ready'))).toBe(false);
    expect(statement(harness.batches[0], 'SET status = ?, next_attempt_at = ?').values[2]).toBe(
      'plugin_resource_provider_reflection_mismatch'
    );
  });

  it('does not adopt an R2 reference with mismatched ID and name', async () => {
    const harness = fixture({
      row: resource({
        resource_kind: 'r2_bucket',
        provider_resource_id: 'bucket-id',
        provider_name: 'bucket-name',
      }),
    });

    await expect(harness.reconciler.reconcile()).resolves.toBe(1);

    expect(harness.clients.r2.listR2Buckets).not.toHaveBeenCalled();
    expect(statement(harness.batches[0], 'SET status = ?, next_attempt_at = ?').values[2]).toBe(
      'plugin_resource_existing_identity_mismatch'
    );
  });

  it('resets an issued D1 checkpoint after a definite rate-limit rejection and retries later', async () => {
    const harness = fixture({
      row: resource({
        resource_kind: 'd1',
        lifecycle_mode: 'managed',
        provider_resource_id: null,
        provider_name: null,
        desired_spec_json: JSON.stringify({
          ownershipFingerprint: FINGERPRINT,
          ownership: 'authrim_managed',
          deleteProviderResource: true,
        }),
      }),
    });
    vi.mocked(harness.clients.d1.listD1Databases).mockResolvedValue([]);
    vi.mocked(harness.clients.d1.createD1Database).mockRejectedValue(
      Object.assign(new Error('provider details are private'), { status: 429 })
    );

    await expect(harness.reconciler.reconcile()).resolves.toBe(1);

    expect(harness.clients.d1.createD1Database).toHaveBeenCalledTimes(1);
    expect(
      harness.statements.some((entry) => entry.sql.includes("SET provider_create_state = 'issued'"))
    ).toBe(true);
    expect(
      harness.statements.some((entry) =>
        entry.sql.includes("SET provider_create_state = 'not_started'")
      )
    ).toBe(true);
    expect(harness.clients.d1.getD1Database).not.toHaveBeenCalled();
    expect(
      statement(harness.batches[0], 'SET status = ?, next_attempt_at = ?').values.slice(0, 3)
    ).toEqual(['waiting_retry', NOW + 120, 'plugin_resource_provider_request_failed']);
  });

  it('does not checkpoint a managed D1 creation with no provider UUID', async () => {
    const harness = fixture({
      row: resource({
        resource_kind: 'd1',
        lifecycle_mode: 'managed',
        provider_resource_id: null,
        provider_name: null,
        desired_spec_json: JSON.stringify({
          ownershipFingerprint: FINGERPRINT,
          ownership: 'authrim_managed',
          deleteProviderResource: true,
        }),
      }),
    });
    vi.mocked(harness.clients.d1.listD1Databases).mockResolvedValue([]);
    vi.mocked(harness.clients.d1.createD1Database).mockResolvedValue({
      uuid: '',
      name: managedPluginResourceName('environment-a', FINGERPRINT, 'd1'),
    });

    await expect(harness.reconciler.reconcile()).resolves.toBe(1);

    expect(
      harness.statements.some((entry) =>
        entry.sql.includes("SET provider_create_state = 'identified'")
      )
    ).toBe(false);
    expect(harness.clients.d1.getD1Database).not.toHaveBeenCalled();
    expect(statement(harness.batches[0], 'SET status = ?, next_attempt_at = ?').values[2]).toBe(
      'plugin_resource_create_outcome_ambiguous'
    );
  });
});
