import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({
  execa: execaMock,
}));

import {
  deleteD1Database,
  deleteEnvironment,
  deleteQueue,
  deleteQueueConsumer,
  deleteQueueConsumersForWorkers,
  detectEnvironments,
  EnvironmentInventoryUnavailableError,
  filterKnownQueueNamesForEnvironment,
  filterKnownWorkerNamesForEnvironment,
  getQueueConsumerWorkerNamesForDeletion,
  listD1Databases,
  parseQueueRows,
} from '../core/cloudflare.js';

describe('Cloudflare Queue deletion helpers', () => {
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  beforeEach(() => {
    execaMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    if (originalApiToken === undefined) {
      delete process.env.CLOUDFLARE_API_TOKEN;
    } else {
      process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
    }
    if (originalAccountId === undefined) {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    } else {
      process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    }
    vi.unstubAllGlobals();
  });

  it('targets only the configured management Queue consumer Worker', () => {
    expect(
      getQueueConsumerWorkerNamesForDeletion('test', [
        { name: 'test-ar-auth' },
        { name: 'test-ar-management' },
        { name: 'test-ar-token' },
      ])
    ).toEqual(['test-ar-management']);
  });

  it('does not detach consumers from unrelated environment Workers', () => {
    expect(
      getQueueConsumerWorkerNamesForDeletion('test', [
        { name: 'prod-ar-management' },
        { name: 'test-ar-auth' },
      ])
    ).toEqual([]);
  });

  it('filters lock-recorded queues to the requested environment', () => {
    expect(
      filterKnownQueueNamesForEnvironment('test', [
        'test-audit-queue',
        'test-logging-delivery-critical-queue',
        'prod-audit-queue',
        'test-unrelated-queue',
      ])
    ).toEqual(['test-audit-queue', 'test-logging-delivery-critical-queue']);
  });

  it('filters lock-recorded Workers to the requested environment', () => {
    expect(
      filterKnownWorkerNamesForEnvironment('test', [
        'test-ar-auth',
        'test-ar-management',
        'prod-ar-auth',
        'test-unrelated-worker',
      ])
    ).toEqual(['test-ar-auth', 'test-ar-management']);
  });

  it('parses Queue names from Wrangler table output', () => {
    expect(
      parseQueueRows(`
        ┌──────────────────────┬──────────────┐
        │ Name                 │ Created      │
        ├──────────────────────┼──────────────┤
        │ test-audit-queue     │ 2026-08-05   │
        └──────────────────────┴──────────────┘
      `)
    ).toEqual([{ name: 'test-audit-queue' }]);
  });

  it('removes a Queue Worker consumer using Wrangler before Worker deletion', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    await expect(deleteQueueConsumer('test-audit-queue', 'test-ar-management')).resolves.toBe(true);

    expect(execaMock).toHaveBeenCalledWith(
      'npx',
      [
        'wrangler',
        'queues',
        'consumer',
        'worker',
        'remove',
        'test-audit-queue',
        'test-ar-management',
      ],
      expect.objectContaining({
        reject: false,
        timeout: 30000,
      })
    );
  });

  it('detaches every environment Queue from the target consumer Worker', async () => {
    execaMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const removed = await deleteQueueConsumersForWorkers(
      [{ name: 'test-audit-queue' }, { name: 'test-logging-delivery-queue' }],
      ['test-ar-management']
    );

    expect(removed).toEqual({
      removed: [
        { queueName: 'test-audit-queue', workerName: 'test-ar-management' },
        { queueName: 'test-logging-delivery-queue', workerName: 'test-ar-management' },
      ],
      errors: [],
    });
    expect(execaMock.mock.calls.map(([, args]) => args)).toEqual([
      [
        'wrangler',
        'queues',
        'consumer',
        'worker',
        'remove',
        'test-audit-queue',
        'test-ar-management',
      ],
      [
        'wrangler',
        'queues',
        'consumer',
        'worker',
        'remove',
        'test-logging-delivery-queue',
        'test-ar-management',
      ],
    ]);
  });

  it('preserves the actual Queue consumer detach failure', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'authentication expired',
    });
    const progress: string[] = [];

    const summary = await deleteQueueConsumersForWorkers(
      [{ name: 'test-audit-queue' }],
      ['test-ar-management'],
      (message) => progress.push(message)
    );

    expect(summary.removed).toEqual([]);
    expect(summary.errors).toEqual([expect.stringContaining('authentication expired')]);
    expect(progress).toContainEqual(expect.stringContaining('authentication expired'));
    expect(progress).not.toContainEqual(expect.stringContaining('not attached or already removed'));
  });

  it('treats an already-unattached Queue consumer as an idempotent no-op', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'The queue does not have a consumer for this script',
    });

    await expect(
      deleteQueueConsumersForWorkers([{ name: 'test-audit-queue' }], ['test-ar-management'])
    ).resolves.toEqual({ removed: [], errors: [] });
  });

  it('reads every API page even when Cloudflare returns fewer rows than requested', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      name: `database-${index}`,
      uuid: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
    }));
    const secondPage = [{ name: 'database-20', uuid: '00000000-0000-0000-0000-000000000020' }];
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get('page') ?? '1');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: page === 1 ? firstPage : secondPage,
          result_info: {
            count: page === 1 ? 20 : 1,
            page,
            per_page: 20,
            total_count: 21,
            total_pages: 2,
          },
        }),
      };
    });

    await expect(listD1Databases()).resolves.toHaveLength(21);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('deletes a Queue using Wrangler', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    await expect(deleteQueue('test-audit-queue')).resolves.toBe(true);

    expect(execaMock).toHaveBeenCalledWith(
      'npx',
      ['wrangler', 'queues', 'delete', 'test-audit-queue'],
      expect.objectContaining({
        reject: false,
        timeout: 30000,
      })
    );
  });

  it('treats already-absent D1 and Queue resources as idempotent deletion success', async () => {
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'The requested resource does not exist',
    });

    await expect(deleteD1Database('test-authrim-core-db')).resolves.toBe(true);
    await expect(deleteQueue('test-audit-queue')).resolves.toBe(true);
  });

  it('detects queue-only environments so orphan Queues can be deleted', async () => {
    mockCloudflareInventory([{ queue_name: 'test-audit-queue', queue_id: 'queue-audit' }]);

    await expect(detectEnvironments()).resolves.toEqual([
      {
        env: 'test',
        workers: [],
        d1: [],
        kv: [],
        queues: [{ name: 'test-audit-queue', id: 'queue-audit' }],
        r2: [],
        pages: [],
      },
    ]);
  });

  it('detects a plugin-runner-only environment so an interrupted delete can resume', async () => {
    mockCloudflareInventory([], [{ id: 'test-ar-plugin-runner' }]);

    await expect(detectEnvironments()).resolves.toEqual([
      {
        env: 'test',
        workers: [{ name: 'test-ar-plugin-runner' }],
        d1: [],
        kv: [],
        queues: [],
        r2: [],
        pages: [],
      },
    ]);
  });

  it('retries Worker inventory and fails closed before deleting any resource', async () => {
    mockCloudflareInventory([{ queue_name: 'test-audit-queue', queue_id: 'queue-audit' }]);
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/user/tokens/verify')) {
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      if (url.includes('/workers/scripts')) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ success: false }),
        };
      }
      throw new Error(`unexpected inventory URL: ${url}`);
    });
    const progress: string[] = [];

    await expect(
      deleteEnvironment({
        env: 'test',
        deleteWorkers: true,
        deleteD1: false,
        deleteKV: false,
        deleteQueues: true,
        deleteR2: false,
        deletePages: false,
        onProgress: (message) => progress.push(message),
      })
    ).rejects.toBeInstanceOf(EnvironmentInventoryUnavailableError);

    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/workers/scripts'))
    ).toHaveLength(3);
    expect(progress).toContain('Worker inventory check failed; retrying (2/3)...');
    expect(progress).toContain('Worker inventory check failed; retrying (3/3)...');
    expect(execaMock.mock.calls.some(([, args]) => (args as string[])[1] === 'delete')).toBe(false);
    expect(execaMock.mock.calls.some(([, args]) => (args as string[])[1] === 'd1')).toBe(false);
  });

  it('detects R2-only environments including an orphan plugin bundle bucket', async () => {
    mockCloudflareInventory([], [], [{ name: 'test-plugin-bundles' }]);

    await expect(detectEnvironments()).resolves.toEqual([
      {
        env: 'test',
        workers: [],
        d1: [],
        kv: [],
        queues: [],
        r2: [{ name: 'test-plugin-bundles' }],
        pages: [],
      },
    ]);
  });

  it('does not adopt an R2-only bucket outside the Authrim inventory suffixes', async () => {
    mockCloudflareInventory([], [], [{ name: 'test-customer-backups' }]);

    await expect(detectEnvironments()).resolves.toEqual([]);
  });

  it('classifies a large R2 bucket as a manual action rather than a deletion error', async () => {
    mockCloudflareInventory([], [], [{ name: 'test-diagnostic-logs' }], undefined, [], 2_000);

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: false,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: false,
      deleteR2: true,
      deletePages: false,
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: true,
      completion: 'manual_action_required',
      environmentEmpty: false,
      errors: [],
      manualR2: [{ bucketName: 'test-diagnostic-logs', objectCount: 2_000 }],
    });
  });

  it('preserves the provider error when an R2 bucket deletion actually fails', async () => {
    mockCloudflareInventory(
      [],
      [],
      [{ name: 'test-diagnostic-logs' }],
      undefined,
      [],
      0,
      'permission denied by Cloudflare'
    );

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: false,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: false,
      deleteR2: true,
      deletePages: false,
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: false,
      completion: 'failed',
      manualR2: [],
      errors: [expect.stringContaining('permission denied by Cloudflare')],
    });
  });

  it('preserves D1 object catalog data when R2 deletion fails', async () => {
    mockCloudflareInventory(
      [],
      [],
      [{ name: 'test-diagnostic-logs' }],
      undefined,
      [],
      0,
      'permission denied by Cloudflare'
    );
    const progress: string[] = [];

    const result = await deleteEnvironment({
      env: 'test',
      environmentKnownLocally: true,
      deleteWorkers: false,
      deleteD1: true,
      deleteKV: false,
      deleteQueues: false,
      deleteR2: true,
      deletePages: false,
      knownD1Names: ['test-authrim-core-db'],
      onProgress: (message) => progress.push(message),
    });

    expect(result.success).toBe(false);
    expect(result.deleted.d1).toEqual([]);
    expect(
      execaMock.mock.calls.some(([, args]) =>
        (args as string[]).join(' ').startsWith('wrangler d1 delete ')
      )
    ).toBe(false);
    expect(progress).toContain(
      '  ⚠️ The R2 object catalog was preserved so the deletion can be retried safely.'
    );
  });

  it('does not probe Queue consumers belonging to another environment', async () => {
    mockCloudflareInventory(
      [
        { queue_name: 'test-audit-queue', queue_id: 'queue-test' },
        { queue_name: 'prod-audit-queue', queue_id: 'queue-prod' },
      ],
      [{ id: 'test-ar-management' }]
    );

    await deleteEnvironment({
      env: 'test',
      deleteWorkers: true,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      queueConsumerDetachPropagationDelayMs: 0,
      workerDeletePropagationDelayMs: 0,
      onProgress: () => {},
    });

    const detachCalls = execaMock.mock.calls
      .map(([, args]) => (args as string[]).join(' '))
      .filter((args) => args.includes('queues consumer worker remove'));
    expect(detachCalls).toEqual([
      'wrangler queues consumer worker remove test-audit-queue test-ar-management',
    ]);
  });

  it('deletes an R2-only environment through the API without querying a missing D1 catalog', async () => {
    mockCloudflareInventory([], [], [{ name: 'test-plugin-bundles' }]);

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: false,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: false,
      deleteR2: true,
      deletePages: false,
      onProgress: () => {},
    });

    expect(result.success).toBe(true);
    expect(result.deleted.r2).toEqual(['test-plugin-bundles']);
    expect(execaMock.mock.calls.some(([, args]) => (args as string[]).includes('execute'))).toBe(
      false
    );
  });

  it('deletes lock-recorded Queues even when environment detection finds no Workers or D1', async () => {
    mockCloudflareInventory([]);

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: false,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      knownQueueNames: ['test-audit-queue', 'prod-audit-queue'],
      onProgress: () => {},
    });

    expect(result.success).toBe(true);
    expect(result.deleted.queues).toEqual(['test-audit-queue']);
    expect(execaMock.mock.calls.map(([, args]) => args)).toContainEqual([
      'wrangler',
      'queues',
      'delete',
      'test-audit-queue',
    ]);
  });

  it('unions lock-recorded Workers with remote inventory before detaching and deleting', async () => {
    mockCloudflareInventory(
      [{ queue_name: 'test-audit-queue', queue_id: 'queue-audit' }],
      [{ id: 'test-ar-auth' }]
    );

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: true,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      knownWorkerNames: ['test-ar-management', 'prod-ar-management'],
      queueConsumerDetachPropagationDelayMs: 0,
      workerDeletePropagationDelayMs: 0,
      onProgress: () => {},
    });

    expect(result.success).toBe(true);
    expect(result.deleted.workers).toEqual(['test-ar-auth', 'test-ar-management']);
    const wranglerCalls = execaMock.mock.calls.map(([, args]) => (args as string[]).join(' '));
    expect(wranglerCalls).toContain(
      'wrangler queues consumer worker remove test-audit-queue test-ar-management'
    );
    expect(wranglerCalls).toContain('wrangler delete --name test-ar-management --force');
    expect(wranglerCalls.some((call) => call.includes('prod-ar-management'))).toBe(false);
  });

  it('preserves the Wrangler detail when Queue deletion is rejected', async () => {
    mockCloudflareInventory(
      [{ queue_name: 'test-audit-queue', queue_id: 'queue-audit' }],
      [],
      [],
      undefined,
      [],
      0,
      undefined,
      [],
      'producer bindings remain'
    );
    const progress: string[] = [];

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: false,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      onProgress: (message) => progress.push(message),
    });

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining('producer bindings remain')]);
    expect(progress).toContainEqual(expect.stringContaining('producer bindings remain'));
  });

  it('completes a deletion retry when lock-recorded D1 and Queues are already absent', async () => {
    mockCloudflareInventory([], [], [], undefined, [], 0, undefined, [
      'test-authrim-core-db',
      'test-audit-queue',
    ]);

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: false,
      deleteD1: true,
      deleteKV: false,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      knownD1Names: ['test-authrim-core-db'],
      knownQueueNames: ['test-audit-queue'],
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: true,
      completion: 'complete',
      environmentEmpty: true,
      errors: [],
      deleted: {
        d1: ['test-authrim-core-db'],
        queues: ['test-audit-queue'],
      },
    });
  });

  it('completes a local cleanup retry when the operation lock remains after remote deletion', async () => {
    mockCloudflareInventory([]);

    const result = await deleteEnvironment({
      env: 'test',
      environmentKnownLocally: true,
      deleteWorkers: true,
      deleteD1: true,
      deleteKV: true,
      deleteQueues: true,
      deleteR2: true,
      deletePages: true,
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: true,
      completion: 'complete',
      environmentEmpty: true,
      errors: [],
      deleted: {
        workers: [],
        d1: [],
        kv: [],
        queues: [],
        r2: [],
        pages: [],
      },
    });
  });

  it('does not report an environment empty while an unselected resource remains', async () => {
    mockCloudflareInventory(
      [{ queue_name: 'test-audit-queue', queue_id: 'queue-audit' }],
      [],
      [],
      undefined,
      [{ name: 'test-authrim-core-db', uuid: 'core-db' }]
    );

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: false,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: true,
      environmentEmpty: false,
      deleted: { queues: ['test-audit-queue'], d1: [] },
    });
  });

  it('deletes only exact environment-owned D1 databases discovered from remote inventory', async () => {
    mockCloudflareInventory([], [], [], undefined, [
      { name: 'test-authrim-control-db', uuid: 'control' },
      { name: 'test-authrim-tenant-default-bootstrap-db', uuid: 'bootstrap-default' },
      { name: 'test-authrim-tenant-users-bootstrap-db', uuid: 'bootstrap-users' },
      { name: 'test-authrim-tenant-pii-bootstrap-db', uuid: 'bootstrap-pii' },
      { name: 'test-authrim-tenant-core-default-default-db-a1b2c3d4', uuid: 'dynamic' },
      { name: 'test-authrim-customer-backups', uuid: 'unrelated' },
      { name: 'prod-authrim-tenant-default-bootstrap-db', uuid: 'other-environment' },
    ]);

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: false,
      deleteD1: true,
      deleteKV: false,
      deleteQueues: false,
      deleteR2: false,
      deletePages: false,
      onProgress: () => {},
    });

    expect(result.success).toBe(true);
    expect(result.deleted.d1).toEqual([
      'test-authrim-control-db',
      'test-authrim-tenant-default-bootstrap-db',
      'test-authrim-tenant-users-bootstrap-db',
      'test-authrim-tenant-pii-bootstrap-db',
      'test-authrim-tenant-core-default-default-db-a1b2c3d4',
    ]);
    const deletedD1Names = execaMock.mock.calls
      .map(([, args]) => args as string[])
      .filter((args) => args[0] === 'wrangler' && args[1] === 'd1' && args[2] === 'delete')
      .map((args) => args[3]);
    expect(deletedD1Names).toEqual(result.deleted.d1);
  });

  it('detaches Queues before Worker deletion and deletes Queues last', async () => {
    mockCloudflareInventory(
      [{ queue_name: 'test-audit-queue', queue_id: 'queue-audit' }],
      [{ id: 'test-ar-auth' }, { id: 'test-ar-management' }]
    );

    const resourceProgress: Array<{ current: number; total: number }> = [];
    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: true,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      queueConsumerDetachPropagationDelayMs: 0,
      workerDeletePropagationDelayMs: 0,
      onProgress: () => {},
      onResourceProgress: (progress) => resourceProgress.push(progress),
    });

    expect(result.success).toBe(true);
    expect(result.deleted.workers).toEqual(['test-ar-auth', 'test-ar-management']);
    expect(result.deleted.queues).toEqual(['test-audit-queue']);
    expect(resourceProgress).toEqual([
      { current: 0, total: 3 },
      { current: 1, total: 3 },
      { current: 2, total: 3 },
      { current: 3, total: 3 },
    ]);

    const wranglerCalls = execaMock.mock.calls
      .map(([, args]) => args as string[])
      .filter((args) => args[0] === 'wrangler');
    const detachManagementIndex = wranglerCalls.findIndex((args) =>
      args.join(' ').includes('queues consumer worker remove test-audit-queue test-ar-management')
    );
    const deleteAuthIndex = wranglerCalls.findIndex((args) =>
      args.join(' ').includes('delete --name test-ar-auth --force')
    );
    const deleteManagementIndex = wranglerCalls.findIndex((args) =>
      args.join(' ').includes('delete --name test-ar-management --force')
    );
    const deleteQueueIndex = wranglerCalls.findIndex((args) =>
      args.join(' ').includes('queues delete test-audit-queue')
    );

    expect(detachManagementIndex).toBeGreaterThanOrEqual(0);
    expect(deleteAuthIndex).toBeGreaterThan(detachManagementIndex);
    expect(deleteManagementIndex).toBeGreaterThan(deleteAuthIndex);
    expect(deleteQueueIndex).toBeGreaterThan(deleteManagementIndex);
  });

  it('reports a Worker deletion failure instead of declaring the environment deleted', async () => {
    mockCloudflareInventory([], [{ id: 'test-ar-router' }], [], 'test-ar-router');
    const progress: string[] = [];

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: true,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: false,
      deleteR2: false,
      deletePages: false,
      workerDeletePropagationDelayMs: 0,
      onProgress: (message) => progress.push(message),
    });

    expect(result.success).toBe(false);
    expect(result.deleted.workers).toEqual([]);
    expect(result.errors).toEqual([
      expect.stringContaining('Failed to delete Worker: test-ar-router'),
    ]);
    expect(progress).toContainEqual(expect.stringContaining('❌ test-ar-router'));
    expect(
      execaMock.mock.calls.filter(([, args]) =>
        (args as string[]).join(' ').includes('delete --name test-ar-router --force')
      )
    ).toHaveLength(3);
  });

  it('restores detached consumers and stops before Worker deletion when another detach fails', async () => {
    mockCloudflareInventory(
      [
        { queue_name: 'test-audit-queue', queue_id: 'queue-audit' },
        { queue_name: 'test-logging-delivery-queue', queue_id: 'queue-logging' },
      ],
      [{ id: 'test-ar-management' }],
      [],
      undefined,
      [],
      0,
      undefined,
      [],
      undefined,
      {
        detach: {
          match: 'test-logging-delivery-queue test-ar-management',
          error: 'Cloudflare authentication expired',
        },
      }
    );
    const progress: string[] = [];

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: true,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      queueConsumerDetachPropagationDelayMs: 0,
      workerDeletePropagationDelayMs: 0,
      onProgress: (message) => progress.push(message),
    });

    expect(result.success).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('authentication expired'));
    const wranglerCalls = execaMock.mock.calls.map(([, args]) => (args as string[]).join(' '));
    expect(wranglerCalls).toContain(
      'wrangler queues consumer worker add test-audit-queue test-ar-management'
    );
    expect(wranglerCalls.some((call) => call.includes('delete --name test-ar-management'))).toBe(
      false
    );
    expect(wranglerCalls.some((call) => call.startsWith('wrangler queues delete '))).toBe(false);
    expect(progress).toContain(
      '  ⚠️ Stopping before deleting Workers because Queue consumers could not be detached safely.'
    );
  });

  it('stops before deleting bound storage and Queues when a Worker cannot be deleted', async () => {
    mockCloudflareInventory(
      [{ queue_name: 'test-audit-queue', queue_id: 'queue-audit' }],
      [{ id: 'test-ar-management' }],
      [],
      'test-ar-management'
    );
    const progress: string[] = [];

    const result = await deleteEnvironment({
      env: 'test',
      environmentKnownLocally: true,
      deleteWorkers: true,
      deleteD1: true,
      deleteKV: false,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      knownD1Names: ['test-authrim-core-db'],
      queueConsumerDetachPropagationDelayMs: 0,
      workerDeletePropagationDelayMs: 0,
      onProgress: (message) => progress.push(message),
    });

    expect(result.success).toBe(false);
    expect(result.deleted).toMatchObject({
      workers: [],
      d1: [],
      queues: [],
    });
    expect(progress).toContain(
      '  ⚠️ Stopping before deleting bound storage and Queues because Worker deletion is incomplete.'
    );
    expect(progress).toContain(
      '  ⚠️ Resolve the Worker error, then retry the environment deletion.'
    );
    const wranglerCalls = execaMock.mock.calls.map(([, args]) => (args as string[]).join(' '));
    expect(wranglerCalls.some((call) => call.startsWith('wrangler d1 delete '))).toBe(false);
    expect(wranglerCalls.some((call) => call.startsWith('wrangler queues delete '))).toBe(false);
    expect(wranglerCalls).toContain(
      'wrangler queues consumer worker add test-audit-queue test-ar-management'
    );
  });

  it('keeps the management consumer available when an earlier Worker deletion fails', async () => {
    mockCloudflareInventory(
      [{ queue_name: 'test-audit-queue', queue_id: 'queue-audit' }],
      [{ id: 'test-ar-auth' }, { id: 'test-ar-management' }],
      [],
      'test-ar-auth'
    );

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: true,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      queueConsumerDetachPropagationDelayMs: 0,
      workerDeletePropagationDelayMs: 0,
      onProgress: () => {},
    });

    expect(result.success).toBe(false);
    const wranglerCalls = execaMock.mock.calls.map(([, args]) => (args as string[]).join(' '));
    expect(wranglerCalls.some((call) => call.includes('delete --name test-ar-management'))).toBe(
      false
    );
    expect(wranglerCalls).toContain(
      'wrangler queues consumer worker add test-audit-queue test-ar-management'
    );
  });

  it('reports the environment empty when a partial retry removes its final resource', async () => {
    mockCloudflareInventory([], [{ id: 'test-ar-auth' }]);
    const progress: string[] = [];

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: true,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: false,
      deleteR2: false,
      deletePages: false,
      workerDeletePropagationDelayMs: 0,
      onProgress: (message) => progress.push(message),
    });

    expect(result).toMatchObject({ success: true, environmentEmpty: true });
    expect(progress).toContain("✅ Environment 'test' deleted successfully!");
  });
});

function mockCloudflareInventory(
  queues: Array<{ queue_name: string; queue_id: string }>,
  workers: Array<{ id: string }> = [],
  r2Buckets: Array<{ name: string }> = [],
  workerDeleteFailureName?: string,
  d1Databases: Array<{ name: string; uuid: string }> = [],
  r2ObjectCount = 0,
  r2DeleteFailure?: string,
  alreadyAbsentDeletes: string[] = [],
  queueDeleteFailure?: string,
  queueConsumerFailures: {
    detach?: { match: string; error: string };
    restore?: { match: string; error: string };
  } = {}
): void {
  process.env.CLOUDFLARE_API_TOKEN = 'test-token';
  process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';

  fetchMock.mockImplementation(
    async (input: string | URL | Request, init?: { method?: string }) => {
      const url = typeof input === 'string' ? input : input.toString();
      let result: unknown = workers;
      if (url.includes('/d1/database?')) {
        result = d1Databases;
      } else if (url.includes('/r2/buckets?')) {
        result = { buckets: r2Buckets };
      } else if (url.includes('/r2/buckets/') && url.includes('/objects?')) {
        result = Array.from({ length: r2ObjectCount }, (_, index) => ({ key: `item-${index}` }));
      } else if (url.includes('/r2/buckets/') && init?.method === 'DELETE') {
        if (r2DeleteFailure) {
          return {
            ok: false,
            status: 403,
            json: async () => ({
              success: false,
              errors: [{ message: r2DeleteFailure }],
            }),
          };
        }
        result = {};
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result }),
      };
    }
  );

  execaMock.mockImplementation(async (_command: string, args: string[]) => {
    const wranglerArgs = args.slice(1);
    const key = wranglerArgs.join(' ');
    if (key === 'whoami') {
      return {
        exitCode: 0,
        stdout:
          'You are logged in as test@example.com\nAccount ID: 0123456789abcdef0123456789abcdef',
        stderr: '',
      };
    }
    if (key === 'd1 list --json' || key === 'kv namespace list') {
      return { exitCode: 0, stdout: '[]', stderr: '' };
    }
    if (key === 'queues list') {
      return { exitCode: 0, stdout: JSON.stringify(queues), stderr: '' };
    }
    if (key.startsWith('queues consumer worker remove ')) {
      if (queueConsumerFailures.detach && key.includes(queueConsumerFailures.detach.match)) {
        return { exitCode: 1, stdout: '', stderr: queueConsumerFailures.detach.error };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (key.startsWith('queues consumer worker add ')) {
      if (queueConsumerFailures.restore && key.includes(queueConsumerFailures.restore.match)) {
        return { exitCode: 1, stdout: '', stderr: queueConsumerFailures.restore.error };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (key.startsWith('delete --name ')) {
      if (workerDeleteFailureName && key.includes(workerDeleteFailureName)) {
        return { exitCode: 1, stdout: '', stderr: 'permission denied' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (key.startsWith('d1 delete ')) {
      if (alreadyAbsentDeletes.some((name) => key.includes(name))) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'The requested resource does not exist',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (key === 'r2 bucket list' || key === 'pages project list') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (key.startsWith('queues delete ')) {
      if (queueDeleteFailure) {
        return { exitCode: 1, stdout: '', stderr: queueDeleteFailure };
      }
      if (alreadyAbsentDeletes.some((name) => key.includes(name))) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'The requested resource does not exist',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected wrangler args: ${args.join(' ')}`);
  });
}
