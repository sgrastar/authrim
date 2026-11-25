import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { PluginAccountMetadataService } from '../account-metadata';
import type { PluginEgressContext, PluginRunnerEnv } from '../types';
import { must } from './helpers/mock-kit';
import {
  createD1,
  openCoreDatabase,
  openRunnerDatabase,
  type D1Options,
} from './helpers/sqlite-d1';

const SECRET = 'plugin-mutation-hmac-secret-with-32-chars';
const BINDING = 'TEST_TDB_USERS_JP_0001_CORE';
const CONTEXT: PluginEgressContext = {
  contractVersion: 1,
  tenantId: 'tenant-a',
  pluginInstallationId: 'installation-a',
  capability: 'notifier.send',
  requestId: 'request-a',
  executionScope: {
    accountId: 'account-a',
    bindingRef: BINDING,
    dataRole: 'tenant_core/users',
    residencyPartition: 'jp',
  },
};
const MUTATION = {
  operationId: 'operation-a',
  accountId: 'account-a',
  metadataKey: 'delivery.preference',
  value: { channel: 'email', enabled: true },
  expectedVersion: null,
};

let runner: DatabaseSync;
let tenant: DatabaseSync;
let tenantOptions: D1Options;
let runnerOptions: D1Options;
let tenantCalls: ReturnType<typeof createD1>['calls'];

function env(extra: Record<string, unknown> = {}): PluginRunnerEnv {
  const runnerD1 = createD1(runner, runnerOptions);
  const tenantD1 = createD1(tenant, tenantOptions);
  tenantCalls = tenantD1.calls;
  return {
    PLUGIN_RUNNER_DB: runnerD1.db,
    [BINDING]: tenantD1.db,
    PLUGIN_MUTATION_HMAC_KEY: SECRET,
    ...extra,
  } as unknown as PluginRunnerEnv;
}
const service = (now = 1_000, extra: Record<string, unknown> = {}) =>
  new PluginAccountMetadataService(env(extra), SECRET, () => now);
const write = (input: unknown = MUTATION, now = 1_000, context: unknown = CONTEXT) =>
  service(now).write(context as PluginEgressContext, input);
const metadata = () => tenant.prepare('SELECT * FROM plugin_account_metadata').all();
const mutations = () => tenant.prepare('SELECT * FROM plugin_account_metadata_mutations').all();

beforeEach(() => {
  runner = openRunnerDatabase();
  tenant = openCoreDatabase();
  tenantOptions = {};
  runnerOptions = {};
  runner.exec(
    `INSERT INTO plugin_runner_tenant_external_gates (tenant_id, allowed, generation, updated_at) VALUES ('tenant-a', 1, 1, 1);
     INSERT INTO plugin_runner_installations (installation_id, tenant_id, plugin_id, backend_kind, script_name, state, config_version, created_at, updated_at) VALUES ('installation-a', 'tenant-a', 'plugin-a', 'dynamic_worker', 'plugin-a', 'enabled', 1, 1, 1);
     INSERT INTO plugin_runner_approved_mutation_scopes (plugin_id, mutation_scope, approved_at) VALUES ('plugin-a', 'account.metadata.write', 1);
     INSERT INTO plugin_runner_installation_mutation_scopes (installation_id, mutation_scope, state, updated_at) VALUES ('installation-a', 'account.metadata.write', 'enabled', 1);`
  );
  tenant.exec(
    `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state, metadata_json, created_at, updated_at) VALUES ('account-a', 'tenant-a', 'human', 'active', '{}', 1, 1)`
  );
});

describe('versions and idempotency', () => {
  it('creates version one and records the mutation and audit evidence', async () => {
    await expect(write()).resolves.toEqual({
      operationId: 'operation-a',
      accountId: 'account-a',
      metadataKey: 'delivery.preference',
      version: 1,
    });
    expect(metadata()).toEqual([
      {
        tenant_id: 'tenant-a',
        account_id: 'account-a',
        plugin_id: 'plugin-a',
        plugin_installation_id: 'installation-a',
        metadata_key: 'delivery.preference',
        value_json: '{"channel":"email","enabled":true}',
        version: 1,
        created_at: 1_000,
        updated_at: 1_000,
      },
    ]);
    expect(mutations()).toMatchObject([
      {
        tenant_id: 'tenant-a',
        plugin_installation_id: 'installation-a',
        operation_id: 'operation-a',
        plugin_id: 'plugin-a',
        account_id: 'account-a',
        metadata_key: 'delivery.preference',
        fingerprint_key_id: 'mutation-v1',
        request_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown,
        result_version: 1,
        request_id: 'request-a',
        capability: 'notifier.send',
        data_role: 'tenant_core/users',
        residency_partition: 'jp',
        applied_at: 1_000,
      },
    ]);
    expect(tenant.prepare('SELECT * FROM plugin_account_metadata_audit').all()).toMatchObject([
      {
        tenant_id: 'tenant-a',
        plugin_installation_id: 'installation-a',
        operation_id: 'operation-a',
        plugin_id: 'plugin-a',
        account_id: 'account-a',
        metadata_key: 'delivery.preference',
        result_version: 1,
        actor_type: 'plugin',
        request_id: 'request-a',
        capability: 'notifier.send',
        mutation_scope: 'account.metadata.write',
        data_role: 'tenant_core/users',
        residency_partition: 'jp',
        created_at: 1_000,
      },
    ]);
  });
  it('updates against the expected version and moves the row to the writing installation', async () => {
    await write();
    await expect(
      write({ ...MUTATION, operationId: 'operation-b', expectedVersion: 1, value: { n: 2 } }, 2_000)
    ).resolves.toMatchObject({ version: 2 });
    expect(metadata()).toMatchObject([
      { value_json: '{"n":2}', version: 2, created_at: 1_000, updated_at: 2_000 },
    ]);
    expect(mutations()).toHaveLength(2);
  });
  it('refuses a create over an existing key and an update against the wrong version', async () => {
    await write();
    await expect(write({ ...MUTATION, operationId: 'operation-b' })).rejects.toThrow(
      /^plugin_data_version_conflict$/u
    );
    await expect(
      write({ ...MUTATION, operationId: 'operation-c', expectedVersion: 2 })
    ).rejects.toThrow(/^plugin_data_version_conflict$/u);
    await expect(
      write({
        ...MUTATION,
        operationId: 'operation-d',
        metadataKey: 'absent.key',
        expectedVersion: 1,
      })
    ).rejects.toThrow(/^plugin_data_version_conflict$/u);
    expect(mutations()).toHaveLength(1);
  });
  it('keeps keys of different plugins and accounts apart', async () => {
    await write();
    await expect(
      write({ ...MUTATION, operationId: 'operation-b', metadataKey: 'other.key' })
    ).resolves.toMatchObject({
      version: 1,
    });
    expect(metadata()).toHaveLength(2);
  });
  it('returns the stored result for an identical retry and never writes twice', async () => {
    await write();
    await expect(write(MUTATION, 5_000)).resolves.toMatchObject({ version: 1 });
    expect(mutations()).toHaveLength(1);
    expect(metadata()).toMatchObject([{ updated_at: 1_000 }]);
  });
  it.each([
    ['another value', { value: { channel: 'sms' } }],
    ['another expected version', { expectedVersion: 3 }],
  ])('refuses a retry with %s under the same operation id', async (_label, over) => {
    await write();
    await expect(write({ ...MUTATION, ...over })).rejects.toThrow(
      /^plugin_data_idempotency_conflict$/u
    );
  });
  it('detects a stored mutation that belongs to another key, account or plugin', async () => {
    await write();
    for (const [column, value] of [
      ['metadata_key', 'tampered.key'],
      ['account_id', 'account-z'],
      ['plugin_id', 'plugin-z'],
    ] as const) {
      const original = must(mutations()[0]) as Record<string, string>;
      runnerOptions = {};
      tenantOptions = {
        intercept: (call) =>
          call.kind === 'first' && call.sql.includes('FROM plugin_account_metadata_mutations')
            ? { value: { ...original, [column]: value } }
            : undefined,
      };
      await expect(write()).rejects.toThrow(/^plugin_data_idempotency_conflict$/u);
    }
  });
  it('refuses a stored mutation fingerprinted with an unknown key id', async () => {
    await write();
    const original = must(mutations()[0]) as Record<string, string>;
    tenantOptions = {
      intercept: (call) =>
        call.kind === 'first' && call.sql.includes('FROM plugin_account_metadata_mutations')
          ? { value: { ...original, fingerprint_key_id: 'mutation-v0' } }
          : undefined,
    };
    await expect(write()).rejects.toThrow(/^plugin_data_idempotency_key_unavailable$/u);
  });
  it.each([
    ['a short fingerprint', (value: string) => value.slice(0, 63)],
    ['a long fingerprint', (value: string) => `${value}0`],
    [
      'a flipped last digit',
      (value: string) => `${value.slice(0, 63)}${value.endsWith('0') ? '1' : '0'}`,
    ],
    [
      'a flipped first digit',
      (value: string) => `${value.startsWith('0') ? '1' : '0'}${value.slice(1)}`,
    ],
  ])('refuses %s', async (_label, mutate) => {
    await write();
    const original = must(mutations()[0]) as Record<string, string>;
    tenantOptions = {
      intercept: (call) =>
        call.kind === 'first' && call.sql.includes('FROM plugin_account_metadata_mutations')
          ? {
              value: {
                ...original,
                request_fingerprint: mutate(String(original.request_fingerprint)),
              },
            }
          : undefined,
    };
    await expect(write()).rejects.toThrow(/^plugin_data_idempotency_conflict$/u);
  });
  it('binds the fingerprint to the secret', async () => {
    await write();
    await expect(
      new PluginAccountMetadataService(
        env(),
        'another-secret-value-with-at-least-32-characters',
        () => 1_000
      ).write(CONTEXT, MUTATION)
    ).rejects.toThrow(/^plugin_data_idempotency_conflict$/u);
  });
  it('reads numeric strings for versions and refuses unreadable ones', async () => {
    await write();
    const original = must(mutations()[0]) as Record<string, unknown>;
    for (const [version, ok] of [
      ['1', true],
      ['x', false],
      [0, false],
      [1.5, false],
    ] as const) {
      tenantOptions = {
        intercept: (call) =>
          call.kind === 'first' && call.sql.includes('FROM plugin_account_metadata_mutations')
            ? { value: { ...original, result_version: version } }
            : undefined,
      };
      if (ok) await expect(write()).resolves.toMatchObject({ version: 1 });
      else await expect(write()).rejects.toThrow(/^plugin_data_state_invalid$/u);
    }
  });
  it('refuses an unreadable current version', async () => {
    await write();
    tenantOptions = {
      intercept: (call) =>
        call.kind === 'first' && call.sql.includes('FROM plugin_account_metadata\n')
          ? { value: { version: 'x' } }
          : undefined,
    };
    await expect(
      write({ ...MUTATION, operationId: 'operation-b', expectedVersion: 1 })
    ).rejects.toThrow(/^plugin_data_state_invalid$/u);
  });
  describe('lost or failed batches', () => {
    it('adopts a batch that committed although its response was lost', async () => {
      tenantOptions = {
        afterBatch: () => {
          throw new Error('response_lost');
        },
      };
      await expect(write()).resolves.toMatchObject({ version: 1 });
      expect(mutations()).toHaveLength(1);
    });
    it('reports a failed write when nothing committed', async () => {
      tenantOptions = {
        intercept: (call) => {
          if (call.kind === 'batch') throw new Error('d1_down');
          return undefined;
        },
      };
      await expect(write()).rejects.toThrow(/^plugin_data_write_failed$/u);
      expect(metadata()).toEqual([]);
    });
    it('reports a conflict when the batch ran but left no mutation behind', async () => {
      tenantOptions = {
        intercept: (call) =>
          call.kind === 'batch'
            ? { value: [{ success: true, results: [], meta: { changes: 0 } }] }
            : undefined,
      };
      await expect(write()).rejects.toThrow(/^plugin_data_version_conflict$/u);
    });
    it('writes the metadata, mutation and audit rows as one batch of three statements', async () => {
      await write();
      expect(tenantCalls.filter((c) => c.kind === 'batch')).toHaveLength(1);
      const batch = must(tenantCalls.find((c) => c.kind === 'batch'));
      expect(batch.sql.split('\n;\n')).toHaveLength(3);
    });
  });
});
