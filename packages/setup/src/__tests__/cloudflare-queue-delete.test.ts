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

  it('targets the management Worker for queue consumer detachment', () => {
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

  it('removes a Queue Worker consumer using Wrangler before Worker deletion', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    await expect(deleteQueueConsumer('test-audit-queue', 'test-ar-management')).resolves.toBe(true);

    expect(execaMock).toHaveBeenCalledWith(
      'npx',
      ['wrangler', 'queues', 'consumer', 'remove', 'test-audit-queue', 'test-ar-management'],
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
      ['wrangler', 'queues', 'consumer', 'remove', 'test-audit-queue', 'test-ar-management'],
      [
        'wrangler',
        'queues',
        'consumer',
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
});

function mockCloudflareInventory(queues: Array<{ queue_name: string; queue_id: string }>): void {
  process.env.CLOUDFLARE_API_TOKEN = 'test-token';
  process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';

  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: [] }),
  });

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
    if (key === 'r2 bucket list' || key === 'pages project list') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (key.startsWith('queues delete ')) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected wrangler args: ${args.join(' ')}`);
  });
}
