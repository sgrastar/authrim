import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({
  execa: execaMock,
}));

import {
  deleteEnvironment,
  deleteQueue,
  deleteQueueConsumer,
  deleteQueueConsumersForWorkers,
  detectEnvironments,
  filterKnownQueueNamesForEnvironment,
  getQueueConsumerWorkerNamesForDeletion,
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

  it('targets every environment Worker for queue consumer detachment', () => {
    expect(
      getQueueConsumerWorkerNamesForDeletion('test', [
        { name: 'test-ar-auth' },
        { name: 'test-ar-management' },
        { name: 'test-ar-token' },
      ])
    ).toEqual(['test-ar-auth', 'test-ar-management', 'test-ar-token']);
  });

  it('does not detach consumers from unrelated environment Workers', () => {
    expect(
      getQueueConsumerWorkerNamesForDeletion('test', [
        { name: 'prod-ar-management' },
        { name: 'test-ar-auth' },
      ])
    ).toEqual(['test-ar-auth']);
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

    expect(removed).toEqual([
      { queueName: 'test-audit-queue', workerName: 'test-ar-management' },
      { queueName: 'test-logging-delivery-queue', workerName: 'test-ar-management' },
    ]);
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
    const detachAuthIndex = wranglerCalls.findIndex((args) =>
      args.join(' ').includes('queues consumer worker remove test-audit-queue test-ar-auth')
    );
    const detachManagementIndex = wranglerCalls.findIndex((args) =>
      args.join(' ').includes('queues consumer worker remove test-audit-queue test-ar-management')
    );
    const deleteAuthIndex = wranglerCalls.findIndex((args) =>
      args.join(' ').includes('delete --name test-ar-auth --force')
    );
    const deleteQueueIndex = wranglerCalls.findIndex((args) =>
      args.join(' ').includes('queues delete test-audit-queue')
    );

    expect(detachAuthIndex).toBeGreaterThanOrEqual(0);
    expect(detachManagementIndex).toBeGreaterThanOrEqual(0);
    expect(deleteAuthIndex).toBeGreaterThan(detachAuthIndex);
    expect(deleteAuthIndex).toBeGreaterThan(detachManagementIndex);
    expect(deleteQueueIndex).toBeGreaterThan(deleteAuthIndex);
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
});

function mockCloudflareInventory(
  queues: Array<{ queue_name: string; queue_id: string }>,
  workers: Array<{ id: string }> = [],
  r2Buckets: Array<{ name: string }> = [],
  workerDeleteFailureName?: string,
  d1Databases: Array<{ name: string; uuid: string }> = []
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
        result = [];
      } else if (url.includes('/r2/buckets/') && init?.method === 'DELETE') {
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
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (key.startsWith('delete --name ')) {
      if (workerDeleteFailureName && key.includes(workerDeleteFailureName)) {
        return { exitCode: 1, stdout: '', stderr: 'permission denied' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (key.startsWith('d1 delete ')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (key === 'r2 bucket list' || key === 'pages project list') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (key.startsWith('queues delete ')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected wrangler args: ${args.join(' ')}`);
  });
}
