/**
 * The tenant gate for external plugin code (plugin_runner_tenant_external_gates) is where
 * `plugin.enabled` is enforced: whatever state an external installation is in and however it got
 * there, nothing external is resolved for execution unless the tenant's gate is open. Built-in
 * (in_process) installations never depend on the gate. No row means closed.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { WorkerLoader } from '@cloudflare/workers-types';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D1AccountEventInstallationResolver } from '../account-event-installations';
import { D1PluginDispatchLimiter } from '../dispatch-limiter';
import { DynamicWorkerPluginBackend } from '../dynamic-worker-backend';
import { D1TenantExternalGateStore } from '../external-gate';
import { DynamicWorkerSyncHookBackend } from '../sync-hooks';
import { D1PluginInstallationResolver } from '../installations';
import {
  PluginHookOutboxDispatcher,
  type ClaimedPluginHook,
  type PluginHookOutboxStore,
} from '../outbox';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const V = 'a'.repeat(64);

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

class Session {
  constructor(private readonly database: DatabaseSync) {}

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
}

function d1(database: DatabaseSync): D1Database {
  const session = new Session(database);
  return {
    prepare: (sql: string) => session.prepare(sql),
    withSession: () => session,
  } as unknown as D1Database;
}

const lifecycle = 'hook.account.lifecycle';
const POLICY_JSON = JSON.stringify({
  backend: 'dynamic_worker',
  resourceScope: 'tenant',
  visibility: 'tenant',
  capabilities: [{ name: lifecycle }],
  credentials: [],
  egressAllowedHosts: [],
  hostInterfaces: [],
  resources: [],
});

describe('the tenant gate for external plugin code', () => {
  let database: DatabaseSync;
  let gates: D1TenantExternalGateStore;
  let installations: D1PluginInstallationResolver;

  const closeGate = (tenantId = 'tenant-a') => gates.set({ tenantId, allowed: false });
  // Opens from the generation just read, as ar-management does.
  const openGate = async (tenantId = 'tenant-a') =>
    gates.set({
      tenantId,
      allowed: true,
      ifGeneration: (await gates.get(tenantId)).generation,
    });
  const target = (installationId: string, tenantId = 'tenant-a') => ({
    tenantId,
    pluginInstallationId: installationId,
    capability: lifecycle,
  });

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    for (const migration of [
      '001_0_4_0_plugin_runner_baseline.sql',
      '007_tenant_external_plugin_gates.sql',
    ]) {
      database.exec(
        readFileSync(resolve(REPO_ROOT, 'migrations/plugin-runner/d1', migration), 'utf8')
      );
    }
    // An external installation, enabled and complete, and a built-in one, in tenant-a; and an
    // external one in tenant-b. No gate row exists yet.
    database.exec(
      `INSERT INTO plugin_runner_installations (
         installation_id, tenant_id, plugin_id, backend_kind, script_name,
         state, config_version, created_at, updated_at
       ) VALUES
         ('external-a', 'tenant-a', 'external-plugin', 'dynamic_worker', 'external-plugin',
          'enabled', 1, 1, 1),
         ('external-b', 'tenant-b', 'external-plugin', 'dynamic_worker', 'external-plugin',
          'enabled', 1, 1, 1),
         ('builtin-a', 'tenant-a', 'builtin-plugin', 'in_process', NULL,
          'enabled', 1, 1, 1);
       INSERT INTO plugin_runner_dynamic_worker_releases (
         plugin_id, version_digest, code_sha256, code_object_key, source_manifest_hash,
         capability_manifest_digest, policy_json, state, published_at, updated_at
       ) VALUES (
         'external-plugin', '${V}', '${'b'.repeat(64)}',
         'plugins/external-plugin/${'b'.repeat(64)}.json', '${'c'.repeat(64)}',
         '${'d'.repeat(64)}', '${POLICY_JSON}', 'published', 1, 1
       );
       INSERT INTO plugin_runner_dynamic_worker_manifests (
         plugin_id, active_version_digest, state, updated_at
       ) VALUES ('external-plugin', '${V}', 'active', 1);
       INSERT INTO plugin_runner_dynamic_worker_artifacts (
         artifact_id, installation_id, plugin_id, version_digest, state, activated_at, updated_at
       ) VALUES
         ('artifact-a', 'external-a', 'external-plugin', '${V}', 'active', 1, 1),
         ('artifact-b', 'external-b', 'external-plugin', '${V}', 'active', 1, 1);
       INSERT INTO plugin_runner_dynamic_worker_hook_policies (
         plugin_id, version_digest, capability, timeout_ms, failure_policy, max_attempts,
         async_retry_budget_seconds, circuit_breaker_threshold,
         circuit_breaker_cooldown_seconds, updated_at
       ) VALUES (
         'external-plugin', '${V}', '${lifecycle}', 1000, 'retry_async', 3, 86400, 2, 60, 1
       ), (
         'external-plugin', '${V}', 'human_verification.verify', 1000, 'fail_closed', 1, 60, 2, 60, 1
       );
       INSERT INTO plugin_runner_hook_policies (
         plugin_id, capability, timeout_ms, failure_policy, max_attempts,
         circuit_breaker_threshold, circuit_breaker_cooldown_seconds, updated_at
       ) VALUES ('builtin-plugin', '${lifecycle}', 1000, 'retry_async', 3, 2, 60, 1);`
    );
    gates = new D1TenantExternalGateStore(d1(database), () => 100);
    installations = new D1PluginInstallationResolver(d1(database));
  });

  afterEach(() => database.close());

  describe('the gate itself', () => {
    it('is closed for a tenant without a row', async () => {
      await expect(gates.get('tenant-a')).resolves.toEqual({
        tenantId: 'tenant-a',
        allowed: false,
        generation: 0,
      });
    });

    it('advances the generation on every close and every real open, and not on an open that changes nothing', async () => {
      await expect(openGate()).resolves.toMatchObject({ allowed: true, generation: 1 });
      await expect(openGate()).resolves.toMatchObject({ allowed: true, generation: 1 });
      await expect(closeGate()).resolves.toMatchObject({ allowed: false, generation: 2 });
      // A close always counts, even on a closed gate: it must invalidate any open decided earlier.
      await expect(closeGate()).resolves.toMatchObject({ allowed: false, generation: 3 });
      await expect(openGate()).resolves.toMatchObject({ allowed: true, generation: 4 });
      await expect(gates.get('tenant-a')).resolves.toMatchObject({ allowed: true, generation: 4 });
    });

    it('closing a tenant without a row creates a closed row', async () => {
      await expect(closeGate()).resolves.toEqual({
        tenantId: 'tenant-a',
        allowed: false,
        generation: 1,
      });
    });

    it('refuses an open decided on a generation that a close has since moved on', async () => {
      // The opener reads generation 0 (no row) and the saved setting, a turn-off closes the
      // gate, and only then the opener's open arrives.
      const read = (await gates.get('tenant-a')).generation;
      await closeGate();

      await expect(
        gates.set({ tenantId: 'tenant-a', allowed: true, ifGeneration: read })
      ).rejects.toThrow('plugin_dynamic_external_gate_generation_conflict');
      await expect(gates.get('tenant-a')).resolves.toMatchObject({ allowed: false, generation: 1 });
    });

    it('refuses a stale open after an open and a close, and after another open', async () => {
      await openGate();
      const stale = (await gates.get('tenant-a')).generation; // 1
      await closeGate(); // 2
      await expect(
        gates.set({ tenantId: 'tenant-a', allowed: true, ifGeneration: stale })
      ).rejects.toThrow('plugin_dynamic_external_gate_generation_conflict');
      await openGate(); // 3
      await closeGate(); // 4
      await expect(
        gates.set({ tenantId: 'tenant-a', allowed: true, ifGeneration: 2 })
      ).rejects.toThrow('plugin_dynamic_external_gate_generation_conflict');
      await expect(gates.get('tenant-a')).resolves.toMatchObject({ allowed: false });
    });

    it('requires the generation to open, and refuses one with a close', async () => {
      await expect(gates.set({ tenantId: 'tenant-a', allowed: true })).rejects.toThrow(
        'plugin_dynamic_external_gate_input_invalid'
      );
      await expect(
        gates.set({ tenantId: 'tenant-a', allowed: true, ifGeneration: -1 })
      ).rejects.toThrow('plugin_dynamic_external_gate_input_invalid');
      await expect(
        gates.set({ tenantId: 'tenant-a', allowed: false, ifGeneration: 0 })
      ).rejects.toThrow('plugin_dynamic_external_gate_input_invalid');
    });

    it('is per tenant', async () => {
      await openGate('tenant-b');
      await expect(gates.get('tenant-a')).resolves.toMatchObject({ allowed: false });
      await expect(gates.get('tenant-b')).resolves.toMatchObject({ allowed: true });
    });

    it('rejects a malformed tenant id or value, and the table refuses anything but 0 and 1', async () => {
      await expect(gates.set({ tenantId: '../x', allowed: true, ifGeneration: 0 })).rejects.toThrow(
        'plugin_dynamic_external_gate_input_invalid'
      );
      await expect(
        gates.set({ tenantId: 'tenant-a', allowed: 'yes' as unknown as boolean, ifGeneration: 0 })
      ).rejects.toThrow('plugin_dynamic_external_gate_input_invalid');
      expect(() =>
        database.exec(
          `INSERT INTO plugin_runner_tenant_external_gates VALUES ('tenant-c', 2, 1, 1)`
        )
      ).toThrow();
    });
  });

  describe('an enabled external installation is resolved only while its tenant gate is open', () => {
    it('resolves the installation to execute (code, policy, backend)', async () => {
      await expect(installations.resolve(target('external-a'))).resolves.toBeNull();
      await expect(installations.resolveBackend(target('external-a'))).resolves.toBeNull();
      // No row at all is "never written" (retried); a closed row is final.
      await expect(installations.resolveDispatchPolicy(target('external-a'))).rejects.toThrow(
        'plugin_gate_uninitialized'
      );
      await closeGate();
      await expect(installations.resolveDispatchPolicy(target('external-a'))).rejects.toThrow(
        'plugin_policy_unavailable'
      );

      await openGate();
      await expect(installations.resolve(target('external-a'))).resolves.toMatchObject({
        pluginId: 'external-plugin',
      });
      await expect(installations.resolveBackend(target('external-a'))).resolves.toMatchObject({
        backendKind: 'dynamic_worker',
      });
      await expect(
        installations.resolveDispatchPolicy(target('external-a'))
      ).resolves.toMatchObject({
        pluginId: 'external-plugin',
      });

      await closeGate();
      await expect(installations.resolve(target('external-a'))).resolves.toBeNull();
      await expect(installations.resolveBackend(target('external-a'))).resolves.toBeNull();
      await expect(installations.resolveDispatchPolicy(target('external-a'))).rejects.toThrow(
        'plugin_policy_unavailable'
      );
    });

    it("is not opened by another tenant's gate", async () => {
      await openGate('tenant-b');
      await expect(installations.resolve(target('external-a'))).resolves.toBeNull();
      await expect(installations.resolve(target('external-b', 'tenant-b'))).resolves.toMatchObject({
        pluginId: 'external-plugin',
      });
    });

    it('does not matter how the installation got enabled: the state is not the permission', async () => {
      // A restore, a rollout or an enable that raced the turn-off all leave `enabled` behind.
      await closeGate();
      database.exec(
        `UPDATE plugin_runner_installations SET state = 'disabled' WHERE installation_id = 'external-a'`
      );
      database.exec(
        `UPDATE plugin_runner_installations SET state = 'enabled' WHERE installation_id = 'external-a'`
      );
      await expect(installations.resolve(target('external-a'))).resolves.toBeNull();
      await openGate();
      await expect(installations.resolve(target('external-a'))).resolves.not.toBeNull();
    });
  });

  describe('built-in installations never depend on the gate', () => {
    it('are resolved with no gate row, an open gate and a closed gate', async () => {
      for (const arrange of [async () => undefined, openGate, closeGate]) {
        await arrange();
        await expect(installations.resolveBackend(target('builtin-a'))).resolves.toMatchObject({
          pluginId: 'builtin-plugin',
          backendKind: 'in_process',
        });
        await expect(
          installations.resolveDispatchPolicy(target('builtin-a'))
        ).resolves.toMatchObject({
          pluginId: 'builtin-plugin',
        });
      }
    });
  });

  describe('hook targets of an account event', () => {
    const resolver = () => new D1AccountEventInstallationResolver(d1(database));
    const resolveTargets = async () =>
      (await resolver().resolve({ tenantId: 'tenant-a', eventType: 'account.created' })).map(
        (entry) => entry.installationId
      );

    it('include the external installation only while the gate is open', async () => {
      await expect(resolveTargets()).resolves.toEqual(['builtin-a']);
      await openGate();
      await expect(resolveTargets()).resolves.toEqual(['builtin-a', 'external-a']);
      await closeGate();
      await expect(resolveTargets()).resolves.toEqual(['builtin-a']);
    });
  });

  describe('the dispatch limiter', () => {
    const lease = (installationId: string) => ({
      installationId,
      tenantId: 'tenant-a',
      capability: lifecycle,
      concurrencyCap: 2,
      ratePerMinute: 30,
      now: 1_000,
    });

    it('grants no lease to an external installation while the gate is closed', async () => {
      const limiter = new D1PluginDispatchLimiter(d1(database));
      await expect(limiter.acquire(lease('external-a'))).resolves.toBeNull();
      await expect(limiter.acquire(lease('builtin-a'))).resolves.not.toBeNull();
      await openGate();
      await expect(limiter.acquire(lease('external-a'))).resolves.not.toBeNull();
    });
  });

  describe('a hook that was queued before the gate closed', () => {
    function claimed(installationId: string): ClaimedPluginHook {
      return {
        outboxId: `outbox-${installationId}`,
        attemptNo: 1,
        claimOwner: 'runner-a',
        claimToken: 'claim-a',
        leaseUntil: 130,
        createdAt: 1,
        providerStartedAt: 1,
        invocation: {
          pluginInstallationId: installationId,
          tenantId: 'tenant-a',
          capability: lifecycle,
          eventType: 'account.created',
          eventVersion: 1,
          idempotencyKey: 'event-a',
          payload: {
            tenantId: 'tenant-a',
            accountId: 'account-a',
            eventType: 'account.created',
            eventVersion: 1,
          },
        },
      };
    }

    function dispatcher(installationId: string) {
      const claim = claimed(installationId);
      const fail = vi.fn(
        async (
          _claim: ClaimedPluginHook,
          input: { retryable: boolean }
        ): Promise<'waiting_retry' | 'dead_letter'> =>
          input.retryable ? 'waiting_retry' : 'dead_letter'
      );
      const store = {
        claimNext: vi.fn(async () => claim),
        claimReference: vi.fn(),
        succeed: vi.fn(async () => undefined),
        fail,
      } satisfies PluginHookOutboxStore;
      const invoke = vi.fn(async () => undefined);
      return {
        run: () =>
          new PluginHookOutboxDispatcher(
            store,
            { invoke },
            installations,
            new D1PluginDispatchLimiter(d1(database))
          ).processOne({ ownerId: 'runner-a', now: 1_000 }),
        invoke,
        fail,
        store,
      };
    }

    it('is not executed while the gate is closed, even though its installation is enabled', async () => {
      await closeGate();
      const external = dispatcher('external-a');

      await expect(external.run()).resolves.toBe('dead_letter');

      expect(external.invoke).not.toHaveBeenCalled();
      expect(external.fail).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ errorCode: 'plugin_policy_unavailable', retryable: false })
      );
    });

    it('is executed once the gate is open, and not after it closes again', async () => {
      await openGate();
      const open = dispatcher('external-a');
      await expect(open.run()).resolves.toBe('succeeded');
      expect(open.invoke).toHaveBeenCalledTimes(1);

      await closeGate();
      const closed = dispatcher('external-a');
      await expect(closed.run()).resolves.toBe('dead_letter');
      expect(closed.invoke).not.toHaveBeenCalled();
    });

    it('is executed for a built-in installation whatever the gate says', async () => {
      await closeGate();
      const builtin = dispatcher('builtin-a');
      await expect(builtin.run()).resolves.toBe('succeeded');
      expect(builtin.invoke).toHaveBeenCalledTimes(1);
    });
  });

  describe('the gate is checked again right before an external Worker is launched', () => {
    const workerCode = {
      compatibilityDate: '2026-07-30',
      mainModule: 'index.js',
      modules: { 'index.js': 'export default {}' },
      globalOutbound: null,
    };

    /** A Worker Loader that answers 204 and counts launches. */
    function loader() {
      const get = vi.fn(() => ({
        getEntrypoint: () => ({
          fetch: async () =>
            new Response(JSON.stringify({ decision: 'allow', reasonCode: 'ok' }), {
              status: 200,
            }),
        }),
      }));
      return { get } as unknown as WorkerLoader & { get: typeof get };
    }

    /** Code fetching that takes long enough for the tenant to turn external plugins off. */
    function slowCode(onFetched: () => Promise<unknown>) {
      return { resolve: vi.fn(async () => (await onFetched(), workerCode)) };
    }

    const hookInput = {
      pluginInstallationId: 'external-a',
      tenantId: 'tenant-a',
      capability: lifecycle,
      eventType: 'account.created',
      eventVersion: 1,
      idempotencyKey: 'event-a',
      payload: {
        tenantId: 'tenant-a',
        accountId: 'account-a',
        eventType: 'account.created',
        eventVersion: 1,
      },
    } as never;

    it('launches nothing, and does not retry, when the gate closes while the code is fetched (async hook)', async () => {
      await openGate();
      const workers = loader();
      const backend = new DynamicWorkerPluginBackend(
        workers,
        installations,
        slowCode(() => closeGate()),
        (() => ({})) as never
      );

      await expect(backend.invoke(hookInput)).rejects.toThrow('plugin_hook_provider_rejected');
      expect(workers.get).not.toHaveBeenCalled();
    });

    it('launches when the gate stays open', async () => {
      await openGate();
      const workers = loader();
      const backend = new DynamicWorkerPluginBackend(
        workers,
        installations,
        slowCode(async () => undefined),
        (() => ({})) as never
      );
      // The mock Worker answers 200, which a hook does not accept: the launch is what is checked.
      await backend.invoke(hookInput).catch(() => undefined);
      expect(workers.get).toHaveBeenCalledTimes(1);
    });

    it('launches nothing when the gate closes while the code is fetched (sync hook)', async () => {
      await openGate();
      const workers = loader();
      const backend = new DynamicWorkerSyncHookBackend(
        workers,
        installations,
        slowCode(() => closeGate()),
        (() => ({})) as never
      );

      await expect(
        backend.invoke({
          group: 'human-verification',
          target: { backendKind: 'dynamic_worker', scriptName: 'external-plugin', timeoutMs: 1000 },
          payload: {
            tenantId: 'tenant-a',
            pluginInstallationId: 'external-a',
            requestId: 'request-a',
            action: 'login',
            responseToken: 'token',
          },
        })
      ).rejects.toThrow('plugin_sync_rejected');
      expect(workers.get).not.toHaveBeenCalled();
    });
  });

  describe('the candidates of the periodic reconciliation', () => {
    const list = async (input: { limit?: number; after?: string | null } = {}) =>
      (await gates.listCandidates(input)).map(
        (c) => `${c.tenantId}:${c.allowed ? 'open' : 'closed'}:${c.generation}`
      );

    it('lists an enabled external installation without a gate row, as closed', async () => {
      await expect(list()).resolves.toEqual(['tenant-a:closed:0', 'tenant-b:closed:0']);
    });

    it('lists every open gate, whether or not an installation is behind it', async () => {
      await openGate('tenant-c');
      await openGate('tenant-a');
      await expect(list()).resolves.toEqual([
        'tenant-a:open:1',
        'tenant-b:closed:0',
        'tenant-c:open:1',
      ]);
    });

    it('lists a closed gate only while an enabled external installation is behind it', async () => {
      await closeGate('tenant-a');
      await closeGate('tenant-z');
      database.exec(
        `UPDATE plugin_runner_installations SET state = 'disabled' WHERE installation_id = 'external-b'`
      );
      // tenant-a: closed row, enabled external installation. tenant-b: its installation is off.
      // tenant-z: closed row, nothing behind it.
      await expect(list()).resolves.toEqual(['tenant-a:closed:1']);
    });

    it('does not list a tenant that has only built-in installations', async () => {
      database.exec(
        `UPDATE plugin_runner_installations SET state = 'disabled' WHERE backend_kind = 'dynamic_worker'`
      );
      await expect(list()).resolves.toEqual([]);
    });

    it('lists a tenant once, with its open gate, even when several installations are behind it', async () => {
      database.exec(
        `INSERT INTO plugin_runner_installations (
           installation_id, tenant_id, plugin_id, backend_kind, script_name,
           state, config_version, created_at, updated_at
         ) VALUES ('external-a2', 'tenant-a', 'external-plugin-2', 'dynamic_worker',
                   'external-plugin-2', 'enabled', 1, 1, 1)`
      );
      await expect(list()).resolves.toEqual(['tenant-a:closed:0', 'tenant-b:closed:0']);
      await openGate('tenant-a');
      await expect(list()).resolves.toEqual(['tenant-a:open:1', 'tenant-b:closed:0']);
    });

    it('pages by tenant id with a limit and an after cursor', async () => {
      await openGate('tenant-c');
      await openGate('tenant-d');
      const first = await gates.listCandidates({ limit: 2 });
      expect(first.map((c) => c.tenantId)).toEqual(['tenant-a', 'tenant-b']);
      const second = await gates.listCandidates({ limit: 2, after: 'tenant-b' });
      expect(second.map((c) => c.tenantId)).toEqual(['tenant-c', 'tenant-d']);
      await expect(list({ after: 'tenant-d' })).resolves.toEqual([]);
    });

    it('rejects a limit out of range and a malformed cursor', async () => {
      await expect(gates.listCandidates({ limit: 0 })).rejects.toThrow(
        'plugin_dynamic_external_gate_input_invalid'
      );
      await expect(gates.listCandidates({ limit: 201 })).rejects.toThrow(
        'plugin_dynamic_external_gate_input_invalid'
      );
      await expect(gates.listCandidates({ after: '../x' })).rejects.toThrow(
        'plugin_dynamic_external_gate_input_invalid'
      );
    });

    it('looks enabled external installations up through the partial index', () => {
      const plan = database
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT installation.tenant_id FROM plugin_runner_installations installation
            WHERE installation.backend_kind = 'dynamic_worker' AND installation.state = 'enabled'
              AND installation.tenant_id > ''`
        )
        .all() as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join('\n')).toContain(
        'idx_plugin_runner_installations_backend_state_tenant'
      );
    });
  });

  describe('a gate that was never written is told from one that was closed', () => {
    const policy = () => installations.resolveDispatchPolicy(target('external-a'));

    it('is retryable without a row, and final with a closed row', async () => {
      await expect(policy()).rejects.toThrow('plugin_gate_uninitialized');
      await closeGate();
      await expect(policy()).rejects.toThrow('plugin_policy_unavailable');
      await openGate();
      await expect(policy()).resolves.toMatchObject({ pluginId: 'external-plugin' });
    });

    it('is not mistaken for uninitialized when the installation itself is off or built in', async () => {
      database.exec(
        `UPDATE plugin_runner_installations SET state = 'disabled' WHERE installation_id = 'external-a'`
      );
      await expect(policy()).rejects.toThrow('plugin_policy_unavailable');
      await expect(installations.resolveDispatchPolicy(target('builtin-a'))).resolves.toMatchObject(
        { pluginId: 'builtin-plugin' }
      );
    });

    it('keeps a queued hook for retry until the gate is written, then runs it', async () => {
      const claim = {
        outboxId: 'outbox-1',
        attemptNo: 1,
        claimOwner: 'runner-a',
        claimToken: 'claim-a',
        leaseUntil: 130,
        createdAt: 1,
        providerStartedAt: 1,
        invocation: {
          pluginInstallationId: 'external-a',
          tenantId: 'tenant-a',
          capability: lifecycle,
          eventType: 'account.created',
          eventVersion: 1,
          idempotencyKey: 'event-a',
          payload: {
            tenantId: 'tenant-a',
            accountId: 'account-a',
            eventType: 'account.created',
            eventVersion: 1,
          },
        },
      };
      const fail = vi.fn(
        async (
          _claim: ClaimedPluginHook,
          input: { retryable: boolean }
        ): Promise<'waiting_retry' | 'dead_letter'> =>
          input.retryable ? 'waiting_retry' : 'dead_letter'
      );
      const store = {
        claimNext: vi.fn(async () => claim),
        claimReference: vi.fn(),
        succeed: vi.fn(async () => undefined),
        fail,
      } satisfies PluginHookOutboxStore;
      const invoke = vi.fn(async () => undefined);
      const run = () =>
        new PluginHookOutboxDispatcher(
          store,
          { invoke },
          installations,
          new D1PluginDispatchLimiter(d1(database))
        ).processOne({ ownerId: 'runner-a', now: 1_000 });

      // The scheduler ran before anything wrote the gate: retried, not dead-lettered.
      await expect(run()).resolves.toBe('waiting_retry');
      expect(fail).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ errorCode: 'plugin_gate_uninitialized', retryable: true })
      );
      expect(invoke).not.toHaveBeenCalled();

      // The reconciliation opens the gate; the retry runs.
      await openGate();
      await expect(run()).resolves.toBe('succeeded');
      expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('does not retry a sync hook for an uninitialized gate (it is refused as before)', async () => {
      const workers = { get: vi.fn() } as unknown as WorkerLoader;
      const backend = new DynamicWorkerSyncHookBackend(
        workers,
        installations,
        { resolve: vi.fn() } as never,
        (() => ({})) as never
      );
      await expect(
        backend.invoke({
          group: 'human-verification',
          target: { backendKind: 'dynamic_worker', scriptName: 'external-plugin', timeoutMs: 1000 },
          payload: {
            tenantId: 'tenant-a',
            pluginInstallationId: 'external-a',
            requestId: 'request-a',
            action: 'login',
            responseToken: 'token',
          },
        })
      ).rejects.toThrow('plugin_sync_transient_failure');
      expect((workers as unknown as { get: ReturnType<typeof vi.fn> }).get).not.toHaveBeenCalled();
    });
  });
});
