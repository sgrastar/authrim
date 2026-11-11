import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CloudflareControlApiError,
  type CloudflareWorkerBinding,
  type CloudflareWorkerDeployment,
  type CloudflareWorkerSettings,
} from '@authrim/ar-lib-core/control-plane';
import { ServiceSiteBindingService } from '../service-site-binding';
import { D1ServiceSiteBindingRepository } from '../service-site-binding-repository';
import { ServiceSiteBindingReconciler } from '../service-site-binding-reconciler';

type SqlValue = string | number | null | Uint8Array;

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ROUTER = 'test-ar-router';

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

  bind(...values: unknown[]) {
    return new BoundStatement(this.statement, values as SqlValue[]);
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => new PreparedStatement(database.prepare(sql)),
    async batch(statements: BoundStatement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

/** A stand-in for the Cloudflare Worker settings API of the router script. */
class FakeRouterProvider {
  bindings: CloudflareWorkerBinding[] = [
    { name: 'SETTINGS', type: 'kv_namespace', namespace_id: 'kv-1' },
    { name: 'DB', type: 'd1', id: 'd1-1' },
    { name: 'ROUTER_FLAG', type: 'plain_text', text: 'on' },
  ];
  deployments: CloudflareWorkerDeployment[] = [];
  scripts = ['my-site', 'other-site'];
  /** Extra binding the provider adds when it applies a PATCH, to simulate a bad reflection. */
  injectOnPatch: CloudflareWorkerBinding | null = null;
  private sequence = 0;

  constructor() {
    this.deploy();
  }

  private deploy(): void {
    this.sequence += 1;
    this.deployments.unshift({
      id: `deployment-${this.sequence}`,
      created_on: new Date(Date.UTC(2026, 7, 1, 0, 0, this.sequence)).toISOString(),
      source: 'api',
      strategy: 'percentage',
      versions: [{ percentage: 100, version_id: `version-${this.sequence}` }],
    });
  }

  getWorkerSettings = vi.fn(
    async (_name: string): Promise<CloudflareWorkerSettings> => ({
      bindings: structuredClone(this.bindings),
      compatibility_date: '2026-01-01',
    })
  );

  patchWorkerSettings = vi.fn(
    async (_name: string, patch: CloudflareWorkerSettings): Promise<CloudflareWorkerSettings> => {
      const current = new Map(this.bindings.map((binding) => [binding.name, binding]));
      this.bindings = (patch.bindings ?? []).map((binding) => {
        if (binding.type !== 'inherit') return structuredClone(binding);
        const existing = current.get(binding.name);
        if (!existing) throw new Error(`inherit_of_missing_binding:${binding.name}`);
        return existing;
      });
      if (this.injectOnPatch) this.bindings.push(this.injectOnPatch);
      this.deploy();
      return this.getWorkerSettings(_name);
    }
  );

  /** Simulates a provider that has not yet listed the newest deployment. */
  hideNewestDeployment = false;
  listWorkerDeployments = vi.fn(async (_name: string) =>
    structuredClone(this.hideNewestDeployment ? this.deployments.slice(1) : this.deployments)
  );
  listWorkerScripts = vi.fn(async () => this.scripts.map((id) => ({ id })));
}

function seed(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO control_environments (
      environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
    ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1);
    INSERT INTO control_operations (
      operation_id, environment_id, operation_kind, idempotency_key, status,
      requested_by_type, attempt_count, created_at, started_at, completed_at, updated_at
    ) VALUES ('bootstrap-test', 'test', 'bootstrap', 'bootstrap', 'succeeded', 'setup', 1, 1, 1, 1, 1);
    INSERT INTO control_desired_worker_inventory (
      environment_id, worker_script_name, package_name, deployment_target,
      capability_manifest_digest, source_manifest_path, source_manifest_hash,
      generated_artifact_hash, source_kind, source_reference,
      registered_by_operation_id, registered_by, registered_at
    ) VALUES (
      'test', '${ROUTER}', '@authrim/ar-router', '${ROUTER}', '${'d'.repeat(64)}',
      'packages/ar-router/authrim.worker-capabilities.json',
      '${'e'.repeat(64)}', '${'f'.repeat(64)}', 'core_manifest',
      '@authrim/ar-router', 'bootstrap-test', 'setup', 1
    );
  `);
}

describe('service site binding', () => {
  let database: DatabaseSync;
  let now: number;
  let nextId: number;
  let provider: FakeRouterProvider;
  let service: ServiceSiteBindingService;
  let reconciler: ServiceSiteBindingReconciler;

  const request = (
    desiredState: 'attached' | 'detached',
    workerName: string | null,
    key = `key-${(nextId += 1)}`
  ) =>
    service.request('test', {
      desiredState,
      workerName,
      idempotencyKey: key,
      requestedById: 'admin-1',
    });
  const row = () =>
    database
      .prepare('SELECT * FROM control_service_site_bindings WHERE environment_id = ?')
      .get('test') as Record<string, unknown>;
  const operation = (id: string) =>
    database.prepare('SELECT * FROM control_operations WHERE operation_id = ?').get(id) as Record<
      string,
      unknown
    >;
  const leases = () =>
    database.prepare('SELECT COUNT(*) AS count FROM control_worker_deployment_leases').get() as {
      count: number;
    };
  const settled = async (maxPasses = 12) => {
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const state = row()?.state;
      if (state !== 'pending' && state !== 'settings_patched' && state !== 'rollback_required') {
        return;
      }
      now += 70;
      await reconciler.reconcile();
    }
  };
  const bindingNames = () => provider.bindings.map((binding) => binding.name);

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    for (const file of ['001_0_5_0_control_baseline.sql', '003_service_site_binding.sql']) {
      database.exec(readFileSync(resolve(REPO_ROOT, 'migrations/control/d1', file), 'utf8'));
    }
    seed(database);
    now = 1_000;
    nextId = 0;
    provider = new FakeRouterProvider();
    const db = d1(database);
    service = new ServiceSiteBindingService(
      db,
      () => now,
      () => `id-${(nextId += 1)}`
    );
    reconciler = new ServiceSiteBindingReconciler(
      new D1ServiceSiteBindingRepository(db),
      provider,
      () => now
    );
  });

  describe('request validation', () => {
    it('reports no attachment before any request', async () => {
      await expect(service.getStatus('test')).resolves.toMatchObject({
        state: 'none',
        desiredState: 'detached',
        attachedWorkerName: null,
        operationId: null,
      });
    });

    it.each(['', 'Has Space', 'UPPER', '-leading', 'trailing-', 'a'.repeat(64), 'dot.name', null])(
      'rejects the Worker name %j',
      async (name) => {
        await expect(request('attached', name as string)).rejects.toThrow(
          'invalid_service_site_binding_request'
        );
      }
    );

    it('requires a null Worker name for a detach', async () => {
      await expect(request('detached', 'my-site')).rejects.toThrow(
        'invalid_service_site_binding_request'
      );
    });

    it.each(['ar-auth', 'test-ar-auth', 'test-ar-router'])(
      'refuses to bind to the Authrim Worker %s',
      async (name) => {
        await expect(request('attached', name)).rejects.toThrow('service_site_worker_reserved');
      }
    );

    it('refuses a Worker that is registered in the desired inventory', async () => {
      database.exec(`
        INSERT INTO control_desired_worker_inventory (
          environment_id, worker_script_name, package_name, deployment_target,
          capability_manifest_digest, source_manifest_path, source_manifest_hash,
          generated_artifact_hash, source_kind, source_reference,
          registered_by_operation_id, registered_by, registered_at
        ) VALUES ('test', 'custom-registered', '@authrim/ar-token', 'custom-registered',
          '${'d'.repeat(64)}', 'packages/ar-token/authrim.worker-capabilities.json',
          '${'e'.repeat(64)}', '${'f'.repeat(64)}', 'core_manifest', '@authrim/ar-token',
          'bootstrap-test', 'setup', 1)
      `);
      await expect(request('attached', 'custom-registered')).rejects.toThrow(
        'service_site_worker_reserved'
      );
    });

    it('needs the router in the desired inventory', async () => {
      database.exec(`UPDATE control_desired_worker_inventory SET status = 'disabled'`);
      await expect(request('attached', 'my-site')).rejects.toThrow(
        'service_site_router_not_in_inventory'
      );
    });

    it('needs an active environment', async () => {
      database.exec(`UPDATE control_environments SET lifecycle_state = 'disabled'`);
      await expect(request('attached', 'my-site')).rejects.toThrow(
        'service_site_environment_not_active'
      );
    });
  });

  describe('requests and idempotency', () => {
    it('stores the desired state as pending and replays an identical key', async () => {
      const first = await request('attached', 'my-site', 'same-key');
      expect(first).toMatchObject({
        state: 'pending',
        desiredState: 'attached',
        desiredWorkerName: 'my-site',
      });
      await expect(request('attached', 'my-site', 'same-key')).resolves.toEqual(first);
      await expect(request('attached', 'other-site', 'same-key')).rejects.toThrow(
        'service_site_idempotency_conflict'
      );
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM control_operations').get()
      ).toMatchObject({ count: 2 });
    });

    it('refuses a second change while one is running', async () => {
      await request('attached', 'my-site');
      await expect(request('attached', 'other-site')).rejects.toThrow(
        'service_site_change_in_progress'
      );
      await expect(request('detached', null)).rejects.toThrow('service_site_change_in_progress');
    });

    it('does nothing for a request that matches the settled state', async () => {
      await request('attached', 'my-site');
      await settled();
      const before = row();
      await expect(request('attached', 'my-site')).resolves.toMatchObject({ state: 'succeeded' });
      expect(row()).toEqual(before);
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM control_operations').get()
      ).toMatchObject({ count: 2 });
    });
  });

  describe('attach', () => {
    it('adds the service binding, keeps every other binding and settles after stabilisation', async () => {
      const status = await request('attached', 'my-site');
      await expect(reconciler.reconcile()).resolves.toMatchObject({ attempted: 1, deferred: 1 });
      expect(row()).toMatchObject({ state: 'settings_patched', binding_name: 'SERVICE_SITE' });
      expect(provider.patchWorkerSettings).toHaveBeenCalledTimes(1);
      const patch = provider.patchWorkerSettings.mock.calls[0][1];
      expect(patch.bindings).toEqual([
        { name: 'SETTINGS', type: 'inherit', version_id: 'latest' },
        { name: 'DB', type: 'inherit', version_id: 'latest' },
        { name: 'ROUTER_FLAG', type: 'inherit', version_id: 'latest' },
        { name: 'SERVICE_SITE', type: 'service', service: 'my-site' },
      ]);
      expect(provider.bindings.slice(0, 3)).toEqual([
        { name: 'SETTINGS', type: 'kv_namespace', namespace_id: 'kv-1' },
        { name: 'DB', type: 'd1', id: 'd1-1' },
        { name: 'ROUTER_FLAG', type: 'plain_text', text: 'on' },
      ]);
      // Not due until the stabilisation interval has passed.
      await expect(reconciler.reconcile()).resolves.toMatchObject({ attempted: 0 });
      now += 31;
      await expect(reconciler.reconcile()).resolves.toMatchObject({ succeeded: 1 });
      expect(row()).toMatchObject({
        state: 'succeeded',
        attached_worker_name: 'my-site',
        last_error_code: null,
      });
      expect(operation(status.operationId!)).toMatchObject({ status: 'succeeded' });
      expect(leases().count).toBe(0);
      expect(
        database
          .prepare(`SELECT event_type, outcome FROM control_audit_events WHERE operation_id = ?`)
          .all(status.operationId)
      ).toEqual([{ event_type: 'service_site.attached', outcome: 'succeeded' }]);
      await expect(service.getStatus('test')).resolves.toMatchObject({
        state: 'succeeded',
        attachedWorkerName: 'my-site',
      });
    });

    it("uses the router's SERVICE_SITE_BINDING variable as the binding name", async () => {
      provider.bindings.push({ name: 'SERVICE_SITE_BINDING', type: 'plain_text', text: 'MY_SITE' });
      await request('attached', 'my-site');
      await settled();
      expect(row()).toMatchObject({ state: 'succeeded', binding_name: 'MY_SITE' });
      expect(provider.bindings.find((binding) => binding.name === 'MY_SITE')).toEqual({
        name: 'MY_SITE',
        type: 'service',
        service: 'my-site',
      });
    });

    it('re-points an existing service binding and keeps the earlier one for rollback', async () => {
      provider.bindings.push({ name: 'SERVICE_SITE', type: 'service', service: 'old-site' });
      await request('attached', 'my-site');
      await reconciler.reconcile();
      expect(JSON.parse(row().previous_binding_json as string)).toEqual({
        name: 'SERVICE_SITE',
        type: 'service',
        service: 'old-site',
      });
      expect(provider.bindings.find((binding) => binding.name === 'SERVICE_SITE')).toMatchObject({
        service: 'my-site',
      });
    });

    it('does not patch when the router already has the requested binding', async () => {
      provider.bindings.push({ name: 'SERVICE_SITE', type: 'service', service: 'my-site' });
      await request('attached', 'my-site');
      await settled();
      expect(row()).toMatchObject({ state: 'succeeded', attached_worker_name: 'my-site' });
      expect(provider.patchWorkerSettings).not.toHaveBeenCalled();
    });

    it('blocks without patching when the binding name belongs to another binding type', async () => {
      provider.bindings.push({ name: 'SERVICE_SITE', type: 'kv_namespace', namespace_id: 'kv-9' });
      const status = await request('attached', 'my-site');
      await reconciler.reconcile();
      expect(row()).toMatchObject({
        state: 'blocked',
        last_error_code: 'service_site_binding_name_conflict',
      });
      expect(operation(status.operationId!)).toMatchObject({ status: 'blocked' });
      expect(provider.patchWorkerSettings).not.toHaveBeenCalled();
      expect(leases().count).toBe(0);
    });

    it('blocks when the Worker does not exist', async () => {
      await request('attached', 'missing-site');
      await reconciler.reconcile();
      expect(row()).toMatchObject({
        state: 'blocked',
        last_error_code: 'service_site_worker_not_found',
      });
      expect(provider.patchWorkerSettings).not.toHaveBeenCalled();
    });

    it('lets a blocked change be requested again', async () => {
      await request('attached', 'missing-site');
      await reconciler.reconcile();
      provider.scripts.push('missing-site');
      await request('attached', 'missing-site');
      await settled();
      expect(row()).toMatchObject({ state: 'succeeded', generation: 2 });
    });

    it('rolls back when the reflected settings differ from the request', async () => {
      provider.injectOnPatch = { name: 'INJECTED', type: 'plain_text', text: 'x' };
      const status = await request('attached', 'my-site');
      await reconciler.reconcile();
      expect(row()).toMatchObject({
        state: 'rollback_required',
        last_error_code: 'control_worker_settings_preservation_failed',
      });
      provider.injectOnPatch = null;
      provider.bindings = provider.bindings.filter((binding) => binding.name !== 'INJECTED');
      now += 5;
      await reconciler.reconcile();
      expect(row()).toMatchObject({ state: 'rolled_back', attached_worker_name: null });
      expect(bindingNames()).not.toContain('SERVICE_SITE');
      expect(operation(status.operationId!)).toMatchObject({
        status: 'blocked',
        last_error_code: 'service_site_binding_rolled_back',
      });
      expect(leases().count).toBe(0);
    });

    it('keeps the change blocked when other bindings are still damaged after the rollback', async () => {
      provider.injectOnPatch = { name: 'INJECTED', type: 'plain_text', text: 'x' };
      await request('attached', 'my-site');
      await reconciler.reconcile();
      provider.injectOnPatch = null;
      await reconciler.reconcile();
      expect(row()).toMatchObject({
        state: 'blocked',
        last_error_code: 'service_site_rollback_failed',
      });
      expect(bindingNames()).not.toContain('SERVICE_SITE');
    });

    it('blocks the rollback when a pre-existing binding was lost', async () => {
      provider.injectOnPatch = { name: 'INJECTED', type: 'plain_text', text: 'x' };
      await request('attached', 'my-site');
      await reconciler.reconcile();
      provider.injectOnPatch = null;
      provider.bindings = provider.bindings.filter(
        (binding) => binding.name !== 'INJECTED' && binding.name !== 'ROUTER_FLAG'
      );
      await reconciler.reconcile();
      expect(row()).toMatchObject({
        state: 'blocked',
        last_error_code: 'service_site_rollback_failed',
      });
    });

    it('restores the earlier binding when it rolls back a re-point', async () => {
      provider.bindings.push({ name: 'SERVICE_SITE', type: 'service', service: 'old-site' });
      provider.injectOnPatch = { name: 'INJECTED', type: 'plain_text', text: 'x' };
      await request('attached', 'my-site');
      await reconciler.reconcile();
      provider.injectOnPatch = null;
      provider.bindings = provider.bindings.filter((binding) => binding.name !== 'INJECTED');
      await reconciler.reconcile();
      expect(row()).toMatchObject({ state: 'rolled_back', attached_worker_name: 'old-site' });
      expect(provider.bindings.find((binding) => binding.name === 'SERVICE_SITE')).toMatchObject({
        service: 'old-site',
      });
    });

    it('blocks the rollback when a newer deployment replaced the patched one', async () => {
      provider.injectOnPatch = { name: 'INJECTED', type: 'plain_text', text: 'x' };
      await request('attached', 'my-site');
      await reconciler.reconcile();
      provider.injectOnPatch = null;
      provider.deployments.unshift({
        id: 'deployment-external',
        created_on: '2026-08-02T00:00:00.000Z',
        source: 'wrangler',
        strategy: 'percentage',
        versions: [{ percentage: 100, version_id: 'version-external' }],
      });
      await reconciler.reconcile();
      expect(row()).toMatchObject({
        state: 'blocked',
        last_error_code: 'service_site_newer_deployment_detected',
      });
    });

    it('retries a failed PATCH without losing the change', async () => {
      provider.patchWorkerSettings.mockRejectedValueOnce(
        new CloudflareControlApiError('workers.settings.patch', 503)
      );
      await request('attached', 'my-site');
      await reconciler.reconcile();
      expect(row()).toMatchObject({
        state: 'pending',
        last_error_code: 'control_worker_settings_request_failed',
      });
      await settled();
      expect(row()).toMatchObject({ state: 'succeeded', attached_worker_name: 'my-site' });
      expect(provider.bindings.find((binding) => binding.name === 'SERVICE_SITE')).toMatchObject({
        service: 'my-site',
      });
    });

    it('blocks on a provider rejection', async () => {
      provider.patchWorkerSettings.mockRejectedValueOnce(
        new CloudflareControlApiError('workers.settings.patch', 400)
      );
      await request('attached', 'my-site');
      await reconciler.reconcile();
      expect(row()).toMatchObject({
        state: 'blocked',
        last_error_code: 'control_worker_settings_request_rejected',
      });
      expect(leases().count).toBe(0);
    });

    it('blocks when the binding disappears before the change settles', async () => {
      await request('attached', 'my-site');
      await reconciler.reconcile();
      provider.bindings = provider.bindings.filter((binding) => binding.name !== 'SERVICE_SITE');
      now += 31;
      await reconciler.reconcile();
      expect(row()).toMatchObject({
        state: 'blocked',
        last_error_code: 'service_site_binding_reflection_mismatch',
      });
    });

    it('waits while another operation holds the router lease', async () => {
      database.exec(`
        INSERT INTO control_worker_deployment_leases (
          environment_id, worker_script_name, owner_operation_id, fencing_token,
          lease_expires_at, expected_source_version_id, mutation_started, updated_at
        ) VALUES ('test', '${ROUTER}', 'bootstrap-test', 1, ${now + 600}, 'version-1', 0, ${now})
      `);
      await request('attached', 'my-site');
      await expect(reconciler.reconcile()).resolves.toMatchObject({ deferred: 1 });
      expect(row()).toMatchObject({
        state: 'pending',
        last_error_code: 'control_worker_deployment_lease_busy',
      });
      expect(provider.patchWorkerSettings).not.toHaveBeenCalled();
    });

    it('does nothing while provider mutation is unavailable', async () => {
      const idle = new ServiceSiteBindingReconciler(
        new D1ServiceSiteBindingRepository(d1(database)),
        provider,
        () => now,
        false
      );
      await request('attached', 'my-site');
      await expect(idle.reconcile()).resolves.toMatchObject({ attempted: 0 });
      expect(provider.getWorkerSettings).not.toHaveBeenCalled();
      expect(row()).toMatchObject({ state: 'pending' });
    });
  });

  describe('detach', () => {
    async function attach(): Promise<void> {
      await request('attached', 'my-site');
      await settled();
      expect(row()).toMatchObject({ state: 'succeeded' });
      provider.patchWorkerSettings.mockClear();
    }

    it('removes only the service binding and keeps the others', async () => {
      await attach();
      const status = await request('detached', null);
      await reconciler.reconcile();
      expect(row()).toMatchObject({ state: 'settings_patched' });
      expect(provider.patchWorkerSettings.mock.calls[0][1].bindings).toEqual([
        { name: 'SETTINGS', type: 'inherit', version_id: 'latest' },
        { name: 'DB', type: 'inherit', version_id: 'latest' },
        { name: 'ROUTER_FLAG', type: 'inherit', version_id: 'latest' },
      ]);
      now += 31;
      await reconciler.reconcile();
      expect(row()).toMatchObject({
        state: 'succeeded',
        desired_state: 'detached',
        attached_worker_name: null,
      });
      expect(bindingNames()).toEqual(['SETTINGS', 'DB', 'ROUTER_FLAG']);
      expect(operation(status.operationId!)).toMatchObject({ status: 'succeeded' });
      expect(
        database
          .prepare(`SELECT event_type FROM control_audit_events WHERE operation_id = ?`)
          .all(status.operationId)
      ).toEqual([{ event_type: 'service_site.detached' }]);
      expect(leases().count).toBe(0);
    });

    it('succeeds without a PATCH when the router has no such binding', async () => {
      await request('detached', null);
      await reconciler.reconcile();
      expect(row()).toMatchObject({ state: 'succeeded', attached_worker_name: null });
      expect(provider.patchWorkerSettings).not.toHaveBeenCalled();
    });

    it('is idempotent once detached', async () => {
      await request('detached', null);
      await reconciler.reconcile();
      const before = row();
      await expect(request('detached', null)).resolves.toMatchObject({ state: 'succeeded' });
      expect(row()).toEqual(before);
    });

    it('removes a binding written outside Control, as long as it is a service binding', async () => {
      provider.bindings.push({ name: 'SERVICE_SITE', type: 'service', service: 'legacy-site' });
      await request('detached', null);
      await settled();
      expect(row()).toMatchObject({ state: 'succeeded' });
      expect(bindingNames()).not.toContain('SERVICE_SITE');
    });

    it('re-adds the earlier binding when the detach does not reflect as requested', async () => {
      await attach();
      provider.injectOnPatch = { name: 'INJECTED', type: 'plain_text', text: 'x' };
      await request('detached', null);
      await reconciler.reconcile();
      expect(row()).toMatchObject({ state: 'rollback_required' });
      provider.injectOnPatch = null;
      provider.bindings = provider.bindings.filter((binding) => binding.name !== 'INJECTED');
      await reconciler.reconcile();
      expect(row()).toMatchObject({ state: 'rolled_back', attached_worker_name: 'my-site' });
      expect(provider.bindings.find((binding) => binding.name === 'SERVICE_SITE')).toMatchObject({
        service: 'my-site',
      });
    });

    it('settles a detach whose deployment shows up only on a later pass', async () => {
      await attach();
      const original = provider.patchWorkerSettings.getMockImplementation()!;
      provider.patchWorkerSettings.mockImplementationOnce(async (name, patch) => {
        const applied = await original(name, patch);
        provider.hideNewestDeployment = true;
        return applied;
      });
      await request('detached', null);
      await reconciler.reconcile();
      expect(row()).toMatchObject({
        state: 'pending',
        last_error_code: 'control_worker_patch_propagating',
      });
      provider.hideNewestDeployment = false;
      await settled();
      expect(row()).toMatchObject({ state: 'succeeded' });
      expect(provider.patchWorkerSettings).toHaveBeenCalledTimes(1);
      expect(bindingNames()).toEqual(['SETTINGS', 'DB', 'ROUTER_FLAG']);
    });

    it('settles a detach whose PATCH response was lost', async () => {
      await attach();
      const original = provider.patchWorkerSettings.getMockImplementation()!;
      provider.patchWorkerSettings.mockImplementationOnce(async (name, patch) => {
        const applied = await original(name, patch);
        void applied;
        throw new CloudflareControlApiError('workers.settings.patch', 504);
      });
      await request('detached', null);
      await settled();
      expect(row()).toMatchObject({ state: 'succeeded' });
      expect(provider.patchWorkerSettings).toHaveBeenCalledTimes(1);
      expect(bindingNames()).toEqual(['SETTINGS', 'DB', 'ROUTER_FLAG']);
    });
  });
});
