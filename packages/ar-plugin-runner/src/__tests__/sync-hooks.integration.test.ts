import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncHookService } from '../sync-hook-service';
import { DynamicWorkerSyncHookBackend } from '../sync-hooks';
import {
  StaticInProcessSyncHookRegistry,
  SyncHookBackendRouter,
} from '../sync-hook-backend-router';

type SqlValue = string | number | null | Uint8Array;
type WorkerFetchInit = Parameters<typeof globalThis.fetch>[1];
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[],
    private readonly beforeRun?: () => void
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async run() {
    this.beforeRun?.();
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class Session {
  constructor(
    private readonly database: DatabaseSync,
    private readonly beforeRun?: (sql: string) => void
  ) {}

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
          }),
          this.beforeRun ? () => this.beforeRun?.(sql) : undefined
        ),
    };
  }
}

function d1(database: DatabaseSync, beforeRun?: (sql: string) => void): D1Database {
  const session = new Session(database, beforeRun);
  return {
    prepare: (sql: string) => session.prepare(sql),
    withSession: () => session,
  } as unknown as D1Database;
}

const humanInput = {
  tenantId: 'tenant-a',
  pluginInstallationId: 'installation-a',
  requestId: 'request-a',
  action: 'login' as const,
  responseToken: 'browser-response-token',
  remoteIp: '203.0.113.7',
};

const syncCodeTarget = {
  pluginId: 'human-plugin',
  scriptName: 'human-plugin',
  codeObjectKey: 'plugins/human-plugin/bundle.json',
  codeSha256: 'b'.repeat(64),
  timeoutMs: 1_000,
  hostInterfaces: [],
  resources: [],
};

function dynamicBackend(
  fetch: (input: string, init?: WorkerFetchInit) => Promise<Response> = async () =>
    new Response(null, { status: 503 }),
  enabled = true
) {
  const loader = enabled
    ? ({
        get: (_id: string, callback: () => Promise<unknown>) => {
          const loaded = callback();
          return {
            getEntrypoint: () => ({
              fetch: async (input: string, init?: WorkerFetchInit) => {
                await loaded;
                return fetch(input, init);
              },
            }),
          };
        },
      } as never)
    : undefined;
  return new DynamicWorkerSyncHookBackend(
    loader,
    { resolve: async () => syncCodeTarget },
    {
      resolve: async () => ({
        compatibilityDate: '2026-07-30',
        mainModule: 'index.js',
        modules: { 'index.js': 'export default {}' },
        globalOutbound: null,
      }),
    },
    () => ({ fetch: vi.fn() }) as never
  );
}

describe('DynamicWorkerSyncHookBackend', () => {
  it('fails closed when the optional Worker Loader is unavailable', async () => {
    await expect(
      dynamicBackend(undefined, false).invoke({
        group: 'human-verification',
        target: {
          backendKind: 'dynamic_worker',
          scriptName: 'human-plugin',
          timeoutMs: 1_000,
        },
        payload: humanInput,
      })
    ).rejects.toThrow('plugin_sync_rejected');
  });

  it('uses a typed internal endpoint and accepts only a bounded exact result', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ decision: 'allow', reasonCode: 'verified' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const backend = dynamicBackend(fetch);

    await expect(
      backend.invoke({
        group: 'human-verification',
        target: {
          backendKind: 'dynamic_worker',
          scriptName: 'human-plugin',
          timeoutMs: 1_000,
        },
        payload: humanInput,
      })
    ).resolves.toEqual({ decision: 'allow', reasonCode: 'verified' });
    expect(fetch).toHaveBeenCalledWith(
      'https://authrim.invalid/internal/plugin-sync/human-verification',
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        body: JSON.stringify(humanInput),
      })
    );
  });

  it('rejects malformed, oversized, and transient responses with normalized codes', async () => {
    const invoke = (response: Response) =>
      dynamicBackend(async () => response).invoke({
        group: 'human-verification',
        target: {
          backendKind: 'dynamic_worker',
          scriptName: 'human-plugin',
          timeoutMs: 1_000,
        },
        payload: humanInput,
      });

    await expect(
      invoke(new Response(JSON.stringify({ decision: 'allow', reasonCode: 'ok', extra: true })))
    ).rejects.toThrow('plugin_sync_response_invalid');
    await expect(
      invoke(new Response(null, { status: 200, headers: { 'Content-Length': '20000' } }))
    ).rejects.toThrow('plugin_sync_response_too_large');
    await expect(
      invoke(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(16 * 1024));
              controller.enqueue(new Uint8Array([1]));
            },
          })
        )
      )
    ).rejects.toThrow('plugin_sync_response_too_large');
    await expect(invoke(new Response(null, { status: 503 }))).rejects.toThrow(
      'plugin_sync_transient_failure'
    );
  });
});

describe('SyncHookBackendRouter', () => {
  const unavailableDynamicBackend = dynamicBackend(undefined, false);

  it('invokes only the exact registered in-process capability and validates its result', async () => {
    const handler = vi.fn(async () => ({ decision: 'allow', reasonCode: 'verified' }));
    const router = new SyncHookBackendRouter(
      unavailableDynamicBackend,
      new StaticInProcessSyncHookRegistry(
        new Map([['human-plugin:human_verification.verify', handler]])
      )
    );

    await expect(
      router.invoke({
        group: 'human-verification',
        target: { backendKind: 'in_process', pluginId: 'human-plugin', timeoutMs: 1_000 },
        payload: humanInput,
      })
    ).resolves.toEqual({ decision: 'allow', reasonCode: 'verified' });
    expect(handler).toHaveBeenCalledWith(humanInput, expect.any(AbortSignal));

    await expect(
      new SyncHookBackendRouter(
        unavailableDynamicBackend,
        new StaticInProcessSyncHookRegistry(
          new Map([
            [
              'human-plugin:human_verification.verify',
              async () => ({ decision: 'allow', reasonCode: 'verified', extra: true }),
            ],
          ])
        )
      ).invoke({
        group: 'human-verification',
        target: { backendKind: 'in_process', pluginId: 'human-plugin', timeoutMs: 1_000 },
        payload: humanInput,
      })
    ).rejects.toThrow('plugin_sync_response_invalid');
  });

  it('rejects unregistered handlers and bounds in-process execution time', async () => {
    await expect(
      new SyncHookBackendRouter(
        unavailableDynamicBackend,
        new StaticInProcessSyncHookRegistry()
      ).invoke({
        group: 'human-verification',
        target: { backendKind: 'in_process', pluginId: 'human-plugin', timeoutMs: 1_000 },
        payload: humanInput,
      })
    ).rejects.toThrow('plugin_sync_rejected');

    const neverCompletes = async (_payload: unknown, signal: AbortSignal): Promise<never> =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    await expect(
      new SyncHookBackendRouter(
        unavailableDynamicBackend,
        new StaticInProcessSyncHookRegistry(
          new Map([['human-plugin:human_verification.verify', neverCompletes]])
        )
      ).invoke({
        group: 'human-verification',
        target: { backendKind: 'in_process', pluginId: 'human-plugin', timeoutMs: 1 },
        payload: humanInput,
      })
    ).rejects.toThrow('plugin_sync_transient_failure');
  });
});

describe('SyncHookService circuit breaker', () => {
  let database: DatabaseSync;
  let now: number;
  let responses: Array<Response | Error>;
  let fetch: ReturnType<typeof vi.fn<(input: string, init?: WorkerFetchInit) => Promise<Response>>>;
  let service: SyncHookService;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    for (const migration of ['001_pre_1_0_plugin_runner_baseline.sql']) {
      database.exec(
        readFileSync(resolve(REPO_ROOT, 'migrations/plugin-runner', migration), 'utf8')
      );
    }
    database.exec(
      `INSERT INTO plugin_runner_installations (
         installation_id, tenant_id, plugin_id, backend_kind, script_name,
         state, config_version, created_at, updated_at
       ) VALUES (
         'installation-a', 'tenant-a', 'human-plugin', 'dynamic_worker', 'human-plugin',
         'enabled', 1, 1, 1
       );
       INSERT INTO plugin_runner_dynamic_worker_releases (
         plugin_id, version_digest, code_sha256, code_object_key, source_manifest_hash,
         capability_manifest_digest, policy_json, state, published_at, updated_at
       ) VALUES (
         'human-plugin', '${'a'.repeat(64)}', '${'b'.repeat(64)}',
         'plugins/human-plugin/${'b'.repeat(64)}.json', '${'c'.repeat(64)}',
         '${'d'.repeat(64)}', '{}', 'published', 1, 1
       );
       INSERT INTO plugin_runner_dynamic_worker_manifests (
         plugin_id, active_version_digest, state, updated_at
       ) VALUES ('human-plugin', '${'a'.repeat(64)}', 'active', 1);
       INSERT INTO plugin_runner_dynamic_worker_artifacts (
         artifact_id, installation_id, plugin_id, version_digest,
         state, activated_at, updated_at
       ) VALUES (
         'human-artifact-a', 'installation-a', 'human-plugin', '${'a'.repeat(64)}',
         'active', 1, 1
       );
       INSERT INTO plugin_runner_dynamic_worker_hook_policies (
         plugin_id, version_digest, capability, timeout_ms, failure_policy, max_attempts,
         async_retry_budget_seconds, circuit_breaker_threshold,
         circuit_breaker_cooldown_seconds, updated_at
       ) VALUES (
         'human-plugin', '${'a'.repeat(64)}', 'human_verification.verify',
         1000, 'fail_closed', 1, 60, 2, 60, 1
       );
       INSERT INTO plugin_runner_hook_policies (
         plugin_id, capability, timeout_ms, failure_policy, max_attempts,
         circuit_breaker_threshold, circuit_breaker_cooldown_seconds, updated_at
       ) VALUES (
         'human-plugin', 'human_verification.verify', 1000, 'fail_closed', 1, 2, 60, 1
       );`
    );
    now = 1_000;
    responses = [];
    fetch = vi.fn(async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return (
        response ??
        new Response(JSON.stringify({ decision: 'allow', reasonCode: 'verified' }), {
          status: 200,
        })
      );
    });
    service = new SyncHookService(d1(database), dynamicBackend(fetch), () => now);
  });

  afterEach(() => database.close());

  it('records success without leaving an open breaker', async () => {
    await expect(service.runHumanVerification(humanInput)).resolves.toEqual({
      decision: 'allow',
      reasonCode: 'verified',
    });
    expect(
      database
        .prepare(
          `SELECT state, failure_count, retry_after, probe_token
             FROM plugin_runner_circuit_breakers`
        )
        .get()
    ).toEqual({ state: 'closed', failure_count: 0, retry_after: null, probe_token: null });
  });

  it('routes an in-process installation through the same policy and breaker state', async () => {
    database.exec(
      `UPDATE plugin_runner_installations
          SET backend_kind = 'in_process', script_name = NULL
        WHERE installation_id = 'installation-a'`
    );
    const handler = vi.fn(async () => ({ decision: 'allow', reasonCode: 'verified' }));
    service = new SyncHookService(
      d1(database),
      new SyncHookBackendRouter(
        dynamicBackend(fetch),
        new StaticInProcessSyncHookRegistry(
          new Map([['human-plugin:human_verification.verify', handler]])
        )
      ),
      () => now
    );

    await expect(service.runHumanVerification(humanInput)).resolves.toEqual({
      decision: 'allow',
      reasonCode: 'verified',
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      database.prepare(`SELECT state, failure_count FROM plugin_runner_circuit_breakers`).get()
    ).toEqual({ state: 'closed', failure_count: 0 });
  });

  it('does not record a provider failure when success bookkeeping is unavailable', async () => {
    let breakerWrites = 0;
    service = new SyncHookService(
      d1(database, (sql) => {
        if (!sql.includes('INSERT INTO plugin_runner_circuit_breakers')) return;
        breakerWrites += 1;
        throw new Error('d1_response_lost');
      }),
      dynamicBackend(fetch),
      () => now
    );

    await expect(service.runHumanVerification(humanInput)).resolves.toEqual({
      decision: 'deny',
      reasonCode: 'plugin_unavailable',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(breakerWrites).toBe(1);
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM plugin_runner_circuit_breakers`).get()
    ).toEqual({ count: 0 });
  });

  it('opens at the fixed threshold, suppresses calls, then closes after one recovery probe', async () => {
    responses.push(new Error('network detail'), new Response(null, { status: 503 }));
    await expect(service.runHumanVerification(humanInput)).resolves.toEqual({
      decision: 'deny',
      reasonCode: 'plugin_unavailable',
    });
    await expect(service.runHumanVerification(humanInput)).resolves.toEqual({
      decision: 'deny',
      reasonCode: 'plugin_unavailable',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      database
        .prepare(`SELECT state, failure_count, retry_after FROM plugin_runner_circuit_breakers`)
        .get()
    ).toEqual({ state: 'open', failure_count: 2, retry_after: 1060 });

    await expect(service.runHumanVerification(humanInput)).resolves.toEqual({
      decision: 'deny',
      reasonCode: 'plugin_unavailable',
    });
    expect(fetch).toHaveBeenCalledTimes(2);

    now = 1_060;
    await expect(service.runHumanVerification(humanInput)).resolves.toMatchObject({
      decision: 'allow',
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      database
        .prepare(
          `SELECT state, failure_count, retry_after, probe_token
             FROM plugin_runner_circuit_breakers`
        )
        .get()
    ).toEqual({ state: 'closed', failure_count: 0, retry_after: null, probe_token: null });
  });

  it('fails before dispatch for a cross-tenant installation lookup', async () => {
    await expect(
      service.runHumanVerification({ ...humanInput, tenantId: 'tenant-b' })
    ).resolves.toEqual({ decision: 'deny', reasonCode: 'plugin_unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a weakened sync failure policy and returns the fixed safe deny', async () => {
    database.exec(
      `UPDATE plugin_runner_dynamic_worker_hook_policies
          SET failure_policy = 'fail_open'
        WHERE plugin_id = 'human-plugin' AND capability = 'human_verification.verify'`
    );

    await expect(service.runHumanVerification(humanInput)).resolves.toEqual({
      decision: 'deny',
      reasonCode: 'plugin_unavailable',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
