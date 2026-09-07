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
  listPagesProjects,
  parseQueueRows,
} from '../core/cloudflare.js';
import {
  CONTROL_TOKEN_CLEANUP_CREDENTIAL_UNAUTHORIZED,
  ControlTokenCleanupManualActionError,
} from '../core/control-token-manual-action.js';

const TEST_R2_CREATION_DATE = '2026-08-31T00:00:00.000Z';
const TEST_R2_OWNERSHIP_ID = '11111111-1111-4111-8111-111111111111';
const TEST_R2_OWNERSHIP_MARKER_KEY =
  '__authrim_setup__/ownership-v1-11111111-1111-4111-8111-111111111111.json';

function exactOwnedR2(name: string) {
  return {
    name,
    creationDate: TEST_R2_CREATION_DATE,
    ownershipMarkerKey: TEST_R2_OWNERSHIP_MARKER_KEY,
    ownershipId: TEST_R2_OWNERSHIP_ID,
  };
}

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

  it('deletes a Queue using its immutable ID through the Cloudflare API', async () => {
    mockCloudflareInventory([]);

    await expect(deleteQueue('queue-id')).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/queues/queue-id',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('treats already-absent D1 and Queue resources as idempotent deletion success', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ success: false }),
    });

    await expect(deleteD1Database('database-id')).resolves.toBe(true);
    await expect(deleteQueue('queue-id')).resolves.toBe(true);
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

  it('starts independent advisory inventories concurrently for the Web environment list', async () => {
    mockCloudflareInventory([]);
    const inventoryFetch = fetchMock.getMockImplementation();
    if (!inventoryFetch) throw new Error('inventory mock was not initialized');
    let releaseInventories!: () => void;
    const inventoryGate = new Promise<void>((resolve) => {
      releaseInventories = resolve;
    });
    const startedInventories = new Set<string>();
    fetchMock.mockImplementation(
      async (input: string | URL | Request, init?: { method?: string }) => {
        const url = String(input);
        const resource = [
          '/workers/scripts',
          '/d1/database?',
          '/storage/kv/namespaces',
          '/queues?',
          '/r2/buckets?',
          '/pages/projects?',
        ].find((candidate) => url.includes(candidate));
        if (resource && (init?.method ?? 'GET') === 'GET') {
          startedInventories.add(resource);
          await inventoryGate;
        }
        return inventoryFetch(input, init);
      }
    );

    const detection = detectEnvironments();
    await vi.waitFor(() => expect(startedInventories.size).toBe(6));
    releaseInventories();

    await expect(detection).resolves.toEqual([]);
  });

  it('detects KV-only environments before a fresh provisioning mutation', async () => {
    mockCloudflareInventory([], [], [], undefined, [], 0, undefined, [], undefined, {}, [
      { title: 'test-AUTHRIM_CONFIG', id: 'kv-config' },
    ]);

    await expect(detectEnvironments()).resolves.toEqual([
      {
        env: 'test',
        workers: [],
        d1: [],
        kv: [{ name: 'test-AUTHRIM_CONFIG', id: 'kv-config' }],
        queues: [],
        r2: [],
        pages: [],
      },
    ]);
  });

  it('detects each Control-managed dynamic storage type for a fresh-name collision', async () => {
    const dynamicD1 = {
      name: 'test-authrim-tenant-core-default-default-db-a1b2c3d4',
      uuid: 'dynamic-d1',
    };
    const dynamicKV = { title: `authrim-test-${'a'.repeat(32)}-kv`, id: 'dynamic-kv' };
    const dynamicR2 = {
      name: `authrim-test-${'b'.repeat(32)}-r2`,
      creation_date: TEST_R2_CREATION_DATE,
    };

    mockCloudflareInventory(
      [],
      [],
      [dynamicR2],
      undefined,
      [dynamicD1],
      0,
      undefined,
      [],
      undefined,
      {},
      [dynamicKV]
    );
    await expect(
      detectEnvironments(undefined, {
        requiredResources: ['D1 databases', 'KV namespaces', 'R2 buckets'],
        includeControlManagedResourcesForEnvironment: 'test',
      })
    ).resolves.toEqual([
      {
        env: 'test',
        workers: [],
        d1: [{ name: dynamicD1.name, id: dynamicD1.uuid }],
        kv: [{ name: dynamicKV.title, id: dynamicKV.id }],
        queues: [],
        r2: [{ name: dynamicR2.name, creationDate: TEST_R2_CREATION_DATE }],
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

  it('retries a transient Queue inventory outage before deleting by immutable ID', async () => {
    mockCloudflareInventory([{ queue_name: 'test-audit-queue', queue_id: 'queue-test' }]);
    const inventoryFetch = fetchMock.getMockImplementation();
    const inventoryExeca = execaMock.getMockImplementation();
    if (!inventoryFetch || !inventoryExeca) throw new Error('inventory mock was not initialized');
    let queueApiFailures = 14;
    let queueWranglerFailures = 2;
    fetchMock.mockImplementation(
      async (input: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
        if (String(input).includes('/queues?') && queueApiFailures > 0) {
          queueApiFailures -= 1;
          throw new Error('temporary Queue API network failure');
        }
        return inventoryFetch(input, init);
      }
    );
    execaMock.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (args.slice(1).join(' ') === 'queues list' && queueWranglerFailures > 0) {
        queueWranglerFailures -= 1;
        throw new Error('temporary Wrangler Queue inventory failure');
      }
      return inventoryExeca(command, args, options);
    });
    const progress: string[] = [];

    const result = await deleteEnvironment({
      env: 'test',
      environmentKnownLocally: true,
      deleteWorkers: false,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      knownQueueResources: [{ name: 'test-audit-queue', id: 'queue-test' }],
      onProgress: (message) => progress.push(message),
    });

    expect(result).toMatchObject({
      success: true,
      deleted: { queues: ['test-audit-queue'] },
    });
    expect(progress).toContain('Queues deletion preflight failed; retrying (2/2)...');
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith('/queues/queue-test') &&
          (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(true);
    expect(
      execaMock.mock.calls.some(([, args]) =>
        (args as string[]).join(' ').includes('queues delete test-audit-queue')
      )
    ).toBe(false);
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
        r2: [{ name: 'test-plugin-bundles', creationDate: TEST_R2_CREATION_DATE }],
        pages: [],
      },
    ]);
  });

  it('detects and counts a Pages-only legacy environment', async () => {
    mockCloudflareInventory(
      [],
      [],
      [],
      undefined,
      [],
      0,
      undefined,
      [],
      undefined,
      {},
      [],
      [{ name: 'test-ar-admin-ui' }, { name: 'test-ar-login-ui' }]
    );

    await expect(detectEnvironments()).resolves.toEqual([
      {
        env: 'test',
        workers: [],
        d1: [],
        kv: [],
        queues: [],
        r2: [],
        pages: [
          {
            name: 'test-ar-admin-ui',
            id: 'test-ar-admin-ui-provider-id',
            createdOn: TEST_R2_CREATION_DATE,
            domains: [],
          },
          {
            name: 'test-ar-login-ui',
            id: 'test-ar-login-ui-provider-id',
            createdOn: TEST_R2_CREATION_DATE,
            domains: [],
          },
        ],
      },
    ]);
  });

  it('fails closed when required Pages inventory output is unrecognizable', async () => {
    mockCloudflareInventory(
      [],
      [],
      [],
      undefined,
      [],
      0,
      undefined,
      [],
      undefined,
      {},
      [],
      [{ name: 'unexpected successful output' }]
    );

    await expect(
      detectEnvironments(undefined, { requiredResources: ['Pages projects'] })
    ).rejects.toBeInstanceOf(EnvironmentInventoryUnavailableError);
  });

  it('accepts name-only Wrangler Pages inventory when the target environment has no project', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock.mockRejectedValue(new Error('temporary Pages API failure'));
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: `
        │ Project Name    │ Project Domains             │ Git Provider │ Last Modified │
        │ authrim-website │ authrim-website.pages.dev   │ Yes          │ 1 week ago    │
      `,
      stderr: '',
    });

    await expect(
      listPagesProjects({
        strictOutput: true,
        requireIdentity: true,
        requireIdentityForEnvironment: 'conformance',
      })
    ).resolves.toEqual([{ name: 'authrim-website' }]);
  });

  it('still blocks name-only Wrangler Pages inventory for the target environment', async () => {
    process.env.CLOUDFLARE_API_TOKEN = 'test-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    fetchMock.mockRejectedValue(new Error('temporary Pages API failure'));
    execaMock.mockResolvedValue({
      exitCode: 0,
      stdout: `
        │ Project Name              │ Project Domains                         │ Git Provider │ Last Modified │
        │ conformance-ar-admin-ui   │ conformance-ar-admin-ui.pages.dev       │ No           │ 1 week ago    │
      `,
      stderr: '',
    });

    await expect(
      listPagesProjects({
        strictOutput: true,
        requireIdentity: true,
        requireIdentityForEnvironment: 'conformance',
      })
    ).rejects.toThrow('Pages project inventory failed through both');
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
      knownR2Resources: [exactOwnedR2('test-diagnostic-logs')],
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

  it('never declares a partial resource selection to be an empty environment', async () => {
    mockCloudflareInventory([], [], []);

    const result = await deleteEnvironment({
      env: 'test',
      environmentKnownLocally: true,
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
      completion: 'complete',
      environmentEmpty: false,
    });
  });

  it('reconciles Setup-created multi-tenant DNS before declaring full deletion empty', async () => {
    mockCloudflareInventory([], [], []);
    const inventoryFetch = fetchMock.getMockImplementation();
    const operationId = '44444444-4444-4444-8444-444444444444';
    const marker = `Authrim Setup managed DNS ownership ${operationId}`;
    let dnsPresent = true;
    fetchMock.mockImplementation(
      async (input: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
        const url = String(input);
        if (url.includes('/zones/zone-123/dns_records')) {
          if (init?.method === 'DELETE') {
            dnsPresent = false;
            return { ok: true, status: 200, json: async () => ({ success: true, result: {} }) };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              result: dnsPresent
                ? [
                    {
                      id: 'dns-record-1',
                      type: 'CNAME',
                      name: '*.test.example.com',
                      content: 'test.example.com',
                      proxied: true,
                      ttl: 1,
                      comment: marker,
                    },
                  ]
                : [],
            }),
          };
        }
        if (!inventoryFetch) throw new Error(`unexpected request: ${url}`);
        return inventoryFetch(input, init);
      }
    );

    const result = await deleteEnvironment({
      env: 'test',
      environmentKnownLocally: true,
      knownDnsOwnership: {
        tenant_wildcard: {
          role: 'tenant_wildcard',
          state: 'managed',
          action: 'created',
          operationId,
          zoneId: 'zone-123',
          recordId: 'dns-record-1',
          name: '*.test.example.com',
          target: 'test.example.com',
          marker,
          previous: null,
          updatedAt: new Date().toISOString(),
        },
      },
      dnsCleanupRequired: true,
      queueConsumerDetachPropagationDelayMs: 0,
      workerDeletePropagationDelayMs: 0,
      postDeleteVerificationAttempts: 1,
      postDeleteVerificationDelayMs: 0,
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: true,
      completion: 'complete',
      environmentEmpty: true,
      postDeleteVerification: 'verified_empty',
      deleted: { dns: ['*.test.example.com'] },
      manualDns: [],
    });
  });

  it('finishes an empty environment while leaving never-recorded DNS for manual review', async () => {
    mockCloudflareInventory([]);
    const progress: string[] = [];

    const result = await deleteEnvironment({
      env: 'test',
      environmentKnownLocally: true,
      dnsCleanupRequired: true,
      requiredDnsRoles: ['tenant_wildcard'],
      postDeleteVerificationAttempts: 1,
      postDeleteVerificationDelayMs: 0,
      onProgress: (message) => progress.push(message),
    });

    expect(result).toMatchObject({
      success: true,
      completion: 'manual_action_required',
      environmentEmpty: true,
      postDeleteVerification: 'verified_empty',
      deleted: { dns: [] },
      manualDns: [
        {
          role: 'tenant_wildcard',
          name: '(tenant_wildcard)',
          reason: 'dns_ownership_evidence_missing',
        },
      ],
      errors: [],
    });
    expect(result.manualDns).toHaveLength(1);
    expect(progress).toContain(
      '⚠️ DNS ownership was never recorded. Setup will leave untracked DNS unchanged and continue deleting the environment.'
    );
    expect(progress).toContain('  ⚠️ Untracked DNS was left unchanged for manual review.');
    expect(progress).not.toContain(
      '⚠️ DNS ownership preflight failed. No Cloudflare environment resource was deleted.'
    );
  });

  it('finalizes an empty environment when only unrelated name-only Pages projects exist', async () => {
    mockCloudflareInventory([]);
    const inventoryFetch = fetchMock.getMockImplementation();
    const inventoryExeca = execaMock.getMockImplementation();
    if (!inventoryFetch || !inventoryExeca) throw new Error('inventory mock was not initialized');
    fetchMock.mockImplementation(
      async (input: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
        if (String(input).includes('/pages/projects')) {
          throw new Error('temporary Pages API failure');
        }
        return inventoryFetch(input, init);
      }
    );
    execaMock.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (args.slice(1).join(' ') === 'pages project list') {
        return {
          exitCode: 0,
          stdout:
            '│ Project Name    │ Project Domains           │ Git Provider │ Last Modified │\n' +
            '│ authrim-website │ authrim-website.pages.dev │ Yes          │ 1 week ago    │',
          stderr: '',
        };
      }
      return inventoryExeca(command, args, options);
    });

    const result = await deleteEnvironment({
      env: 'test',
      environmentKnownLocally: true,
      dnsCleanupRequired: true,
      requiredDnsRoles: ['tenant_wildcard'],
      postDeleteVerificationAttempts: 1,
      postDeleteVerificationDelayMs: 0,
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: true,
      completion: 'manual_action_required',
      environmentEmpty: true,
      postDeleteVerification: 'verified_empty',
      errors: [],
    });
  });

  it('still blocks deletion when a lock-recorded DNS identity no longer matches', async () => {
    mockCloudflareInventory([]);
    const inventoryFetch = fetchMock.getMockImplementation();
    const operationId = '44444444-4444-4444-8444-444444444444';
    const marker = `Authrim Setup managed DNS ownership ${operationId}`;
    fetchMock.mockImplementation(
      async (input: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
        const url = String(input);
        if (url.includes('/zones/zone-123/dns_records')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              result: [
                {
                  id: 'replacement-record',
                  type: 'CNAME',
                  name: '*.test.example.com',
                  content: 'operator.example.com',
                  proxied: true,
                  ttl: 1,
                },
              ],
            }),
          };
        }
        if (!inventoryFetch) throw new Error(`unexpected request: ${url}`);
        return inventoryFetch(input, init);
      }
    );
    const progress: string[] = [];

    const result = await deleteEnvironment({
      env: 'test',
      environmentKnownLocally: true,
      knownDnsOwnership: {
        tenant_wildcard: {
          role: 'tenant_wildcard',
          state: 'managed',
          action: 'created',
          operationId,
          zoneId: 'zone-123',
          recordId: 'dns-record-1',
          name: '*.test.example.com',
          target: 'test.example.com',
          marker,
          previous: null,
          updatedAt: new Date().toISOString(),
        },
      },
      dnsCleanupRequired: true,
      requiredDnsRoles: ['tenant_wildcard'],
      postDeleteVerificationAttempts: 1,
      postDeleteVerificationDelayMs: 0,
      onProgress: (message) => progress.push(message),
    });

    expect(result).toMatchObject({
      success: true,
      completion: 'manual_action_required',
      environmentEmpty: false,
      postDeleteVerification: 'not_required',
      manualDns: [
        {
          role: 'tenant_wildcard',
          reason: expect.stringContaining('dns_managed_record_identity_mismatch'),
        },
      ],
    });
    expect(progress).toContain(
      '⚠️ DNS ownership preflight failed. No Cloudflare environment resource was deleted.'
    );
    expect(progress).not.toContain(
      '⚠️ DNS ownership was never recorded. Setup will leave untracked DNS unchanged and continue deleting the environment.'
    );
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
      knownR2Resources: [exactOwnedR2('test-diagnostic-logs')],
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
      knownD1Resources: [{ name: 'test-authrim-core-db', id: 'core-id' }],
      knownR2Resources: [exactOwnedR2('test-diagnostic-logs')],
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

    const detachCalls = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input).includes('/queues/') &&
        String(input).includes('/consumers/') &&
        (init as { method?: string } | undefined)?.method === 'DELETE'
    );
    expect(detachCalls).toHaveLength(1);
    expect(String(detachCalls[0]?.[0])).toContain(
      '/queues/queue-test/consumers/consumer-queue-test'
    );
    expect(String(detachCalls[0]?.[0])).not.toContain('queue-prod');
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
      knownR2Resources: [exactOwnedR2('test-plugin-bundles')],
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
      knownQueueResources: [{ name: 'test-audit-queue', id: 'queue-audit' }],
      onProgress: () => {},
    });

    expect(result.success).toBe(true);
    expect(result.deleted.queues).toEqual(['test-audit-queue']);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith('/queues/queue-audit') &&
          (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(false);
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
      knownWorkerResources: [
        {
          name: 'test-ar-management',
          cloudflareScriptTag: 'test-ar-management-original-tag',
        },
      ],
      queueConsumerDetachPropagationDelayMs: 0,
      workerDeletePropagationDelayMs: 0,
      onProgress: () => {},
    });

    expect(result.success).toBe(true);
    expect(result.deleted.workers).toEqual(['test-ar-auth', 'test-ar-management']);
    const wranglerCalls = execaMock.mock.calls.map(([, args]) => (args as string[]).join(' '));
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes('/queues/queue-audit/consumers/consumer-queue-audit') &&
          (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(false);
    expect(wranglerCalls).not.toContain('wrangler delete --name test-ar-management --force');
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

  it('completes a deletion retry when lock-recorded D1, KV, and Queues are already absent', async () => {
    mockCloudflareInventory([], [], [], undefined, [], 0, undefined, [
      'test-authrim-core-db',
      'test-audit-queue',
    ]);

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: false,
      deleteD1: true,
      deleteKV: true,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      knownD1Resources: [{ name: 'test-authrim-core-db', id: 'core-id' }],
      knownKVResources: [{ name: 'test-AUTHRIM_CONFIG', id: 'kv-config' }],
      knownQueueResources: [{ name: 'test-audit-queue', id: 'queue-audit' }],
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: true,
      completion: 'complete',
      environmentEmpty: false,
      errors: [],
      deleted: {
        d1: ['test-authrim-core-db'],
        kv: ['test-AUTHRIM_CONFIG'],
        queues: ['test-audit-queue'],
      },
    });
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(false);
  });

  it('does not fall back to deleting an absent lock resource by name without its immutable ID', async () => {
    mockCloudflareInventory([]);

    const result = await deleteEnvironment({
      env: 'test',
      environmentKnownLocally: true,
      deleteWorkers: false,
      deleteD1: true,
      deleteKV: false,
      deleteQueues: false,
      deleteR2: false,
      deletePages: false,
      knownD1Names: ['test-authrim-core-db'],
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: false,
      deleted: { d1: [] },
      errors: [expect.stringContaining('name-only deletion is not allowed')],
    });
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(false);
  });

  it('fails closed before every mutation when a lock-recorded D1 name has a replacement ID', async () => {
    mockCloudflareInventory(
      [{ queue_name: 'test-audit-queue', queue_id: 'queue-audit' }],
      [{ id: 'test-ar-management' }],
      [],
      undefined,
      [{ name: 'test-authrim-core-db', uuid: 'replacement-core-id' }]
    );

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: true,
      deleteD1: true,
      deleteKV: false,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      knownD1Resources: [{ name: 'test-authrim-core-db', id: 'original-core-id' }],
      knownQueueResources: [{ name: 'test-audit-queue', id: 'queue-audit' }],
      queueConsumerDetachPropagationDelayMs: 0,
      workerDeletePropagationDelayMs: 0,
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: false,
      deleted: { workers: [], d1: [], queues: [] },
      errors: [expect.stringContaining('immutable ID changed')],
    });
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(false);
    expect(
      execaMock.mock.calls.some(([, args]) =>
        /queues consumer worker remove|delete --name/u.test((args as string[]).join(' '))
      )
    ).toBe(false);
  });

  it('fails closed before every mutation when a lock-recorded KV name has a replacement ID', async () => {
    mockCloudflareInventory([], [], [], undefined, [], 0, undefined, [], undefined, {}, [
      { title: 'test-AUTHRIM_CONFIG', id: 'replacement-kv-id' },
    ]);

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: false,
      deleteD1: false,
      deleteKV: true,
      deleteQueues: false,
      deleteR2: false,
      deletePages: false,
      knownKVResources: [{ name: 'test-AUTHRIM_CONFIG', id: 'original-kv-id' }],
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: false,
      deleted: { kv: [] },
      errors: [expect.stringContaining('immutable ID changed')],
    });
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(false);
  });

  it('fails closed before detach when a lock-recorded Queue name has a replacement ID', async () => {
    mockCloudflareInventory(
      [{ queue_name: 'test-audit-queue', queue_id: 'replacement-queue-id' }],
      [{ id: 'test-ar-management' }]
    );

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: true,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      knownQueueResources: [{ name: 'test-audit-queue', id: 'original-queue-id' }],
      queueConsumerDetachPropagationDelayMs: 0,
      workerDeletePropagationDelayMs: 0,
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: false,
      deleted: { workers: [], queues: [] },
      errors: [expect.stringContaining('immutable ID changed')],
    });
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(false);
    expect(
      execaMock.mock.calls.some(([, args]) =>
        /queues consumer worker remove|delete --name/u.test((args as string[]).join(' '))
      )
    ).toBe(false);
  });

  it('fails closed before every mutation when a lock-recorded Worker has a replacement tag', async () => {
    mockCloudflareInventory(
      [{ queue_name: 'test-audit-queue', queue_id: 'queue-audit' }],
      [{ id: 'test-ar-management', tag: 'replacement-worker-tag' }],
      [],
      undefined,
      [{ name: 'test-authrim-core-db', uuid: 'core-id' }]
    );

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: true,
      deleteD1: true,
      deleteKV: false,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      knownWorkerResources: [
        { name: 'test-ar-management', cloudflareScriptTag: 'original-worker-tag' },
      ],
      knownD1Resources: [{ name: 'test-authrim-core-db', id: 'core-id' }],
      knownQueueResources: [{ name: 'test-audit-queue', id: 'queue-audit' }],
      queueConsumerDetachPropagationDelayMs: 0,
      workerDeletePropagationDelayMs: 0,
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: false,
      deleted: { workers: [], d1: [], queues: [] },
      errors: [expect.stringContaining('immutable script tag changed')],
    });
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(false);
    expect(
      execaMock.mock.calls.some(([, args]) =>
        (args as string[]).join(' ').includes('delete --name test-ar-management')
      )
    ).toBe(false);
  });

  it('fails closed with zero mutations when Worker inventory contains a duplicate immutable tag', async () => {
    mockCloudflareInventory(
      [{ queue_name: 'test-audit-queue', queue_id: 'queue-audit' }],
      [
        { id: 'test-ar-auth', tag: 'duplicate-worker-tag' },
        { id: 'test-ar-management', tag: 'duplicate-worker-tag' },
      ]
    );

    await expect(
      deleteEnvironment({
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
      })
    ).rejects.toBeInstanceOf(EnvironmentInventoryUnavailableError);

    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(false);
    expect(
      execaMock.mock.calls.some(([, args]) =>
        /queues consumer worker remove|delete --name/u.test((args as string[]).join(' '))
      )
    ).toBe(false);
  });

  it('deletes a Worker only after its exact immutable tag is rechecked', async () => {
    mockCloudflareInventory([], [{ id: 'test-ar-auth', tag: 'owned-worker-tag' }]);

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: true,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: false,
      deleteR2: false,
      deletePages: false,
      knownWorkerResources: [{ name: 'test-ar-auth', cloudflareScriptTag: 'owned-worker-tag' }],
      workerDeletePropagationDelayMs: 0,
      onProgress: () => {},
    });

    expect(result).toMatchObject({ success: true, deleted: { workers: ['test-ar-auth'] } });
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/workers/scripts'))
    ).toHaveLength(3);
    expect(
      execaMock.mock.calls.some(([, args]) =>
        (args as string[]).join(' ').includes('delete --name test-ar-auth --force')
      )
    ).toBe(true);
  });

  it('treats an exact lock-recorded Worker that is already absent as an idempotent retry', async () => {
    mockCloudflareInventory([]);

    const result = await deleteEnvironment({
      env: 'test',
      environmentKnownLocally: true,
      deleteWorkers: true,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: false,
      deleteR2: false,
      deletePages: false,
      knownWorkerResources: [
        { name: 'test-ar-auth', cloudflareScriptTag: 'already-deleted-worker-tag' },
      ],
      workerDeletePropagationDelayMs: 0,
      onProgress: () => {},
    });

    expect(result).toMatchObject({ success: true, deleted: { workers: ['test-ar-auth'] } });
    expect(
      execaMock.mock.calls.some(([, args]) =>
        (args as string[]).join(' ').includes('delete --name test-ar-auth')
      )
    ).toBe(false);
  });

  it('durably backfills a legacy Worker tag only after its active Version ID matches', async () => {
    const versionId = '11111111-1111-4111-8111-111111111111';
    mockCloudflareInventory(
      [],
      [{ id: 'test-ar-auth', tag: 'verified-worker-tag' }],
      [],
      undefined,
      [],
      0,
      undefined,
      [],
      undefined,
      {},
      [],
      [],
      { 'test-ar-auth': versionId }
    );
    const persistBackfill = vi.fn(async () => {});

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: true,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: false,
      deleteR2: false,
      deletePages: false,
      knownWorkerResources: [{ name: 'test-ar-auth', cloudflareVersionId: versionId }],
      onWorkerIdentityBackfill: persistBackfill,
      workerDeletePropagationDelayMs: 0,
      onProgress: () => {},
    });

    expect(result.success).toBe(true);
    expect(persistBackfill).toHaveBeenCalledWith([
      {
        name: 'test-ar-auth',
        cloudflareVersionId: versionId,
        cloudflareScriptTag: 'verified-worker-tag',
      },
    ]);
  });

  it('backfills a pending Worker tag after its uploaded Version exists without active deployment', async () => {
    const versionId = '11111111-1111-4111-8111-111111111111';
    mockCloudflareInventory(
      [],
      [{ id: 'test-ar-auth', tag: 'verified-worker-tag' }],
      [],
      undefined,
      [],
      0,
      undefined,
      [],
      undefined,
      {},
      [],
      [],
      { 'test-ar-auth': versionId }
    );
    const persistBackfill = vi.fn(async () => {});

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: true,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: false,
      deleteR2: false,
      deletePages: false,
      knownWorkerResources: [
        {
          name: 'test-ar-auth',
          cloudflareVersionId: versionId,
          cloudflareVersionState: 'uploaded',
        },
      ],
      onWorkerIdentityBackfill: persistBackfill,
      workerDeletePropagationDelayMs: 0,
      onProgress: () => {},
    });

    expect(result.success).toBe(true);
    expect(persistBackfill).toHaveBeenCalledWith([
      {
        name: 'test-ar-auth',
        cloudflareVersionId: versionId,
        cloudflareScriptTag: 'verified-worker-tag',
      },
    ]);
    const wranglerCalls = execaMock.mock.calls.map(([, args]) => (args as string[]).join(' '));
    expect(wranglerCalls).toContain(
      `wrangler versions view ${versionId} --name test-ar-auth --json`
    );
    expect(wranglerCalls).not.toContain('wrangler deployments list --name test-ar-auth');
  });

  it('fails with zero mutations when a legacy Worker active Version ID no longer matches', async () => {
    const lockedVersionId = '11111111-1111-4111-8111-111111111111';
    const replacementVersionId = '22222222-2222-4222-8222-222222222222';
    mockCloudflareInventory(
      [],
      [{ id: 'test-ar-auth', tag: 'replacement-worker-tag' }],
      [],
      undefined,
      [],
      0,
      undefined,
      [],
      undefined,
      {},
      [],
      [],
      { 'test-ar-auth': replacementVersionId }
    );

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: true,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: false,
      deleteR2: false,
      deletePages: false,
      knownWorkerResources: [{ name: 'test-ar-auth', cloudflareVersionId: lockedVersionId }],
      workerDeletePropagationDelayMs: 0,
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: false,
      deleted: { workers: [] },
      errors: [expect.stringContaining('active Version ID does not match')],
    });
    expect(
      execaMock.mock.calls.some(([, args]) =>
        (args as string[]).join(' ').includes('delete --name test-ar-auth')
      )
    ).toBe(false);
  });

  it('restores exact Queue consumers and preserves storage on a pre-delete Worker tag race', async () => {
    mockCloudflareInventory(
      [{ queue_name: 'test-audit-queue', queue_id: 'queue-audit' }],
      [{ id: 'test-ar-management', tag: 'owned-worker-tag' }],
      [],
      undefined,
      [{ name: 'test-authrim-core-db', uuid: 'core-id' }]
    );
    const defaultFetch = fetchMock.getMockImplementation();
    let workerReads = 0;
    fetchMock.mockImplementation(async (input: string | URL | Request, init) => {
      const url = String(input);
      if (url.includes('/workers/scripts')) {
        workerReads += 1;
        if (workerReads >= 3) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              result: [{ id: 'test-ar-management', tag: 'replacement-worker-tag' }],
              result_info: { page: 1, total_pages: 1 },
            }),
          };
        }
      }
      if (!defaultFetch) throw new Error('missing default Cloudflare fetch mock');
      return defaultFetch(input, init);
    });

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: true,
      deleteD1: true,
      deleteKV: false,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      knownWorkerResources: [
        { name: 'test-ar-management', cloudflareScriptTag: 'owned-worker-tag' },
      ],
      knownD1Resources: [{ name: 'test-authrim-core-db', id: 'core-id' }],
      knownQueueResources: [{ name: 'test-audit-queue', id: 'queue-audit' }],
      queueConsumerDetachPropagationDelayMs: 0,
      workerDeletePropagationDelayMs: 0,
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: false,
      deleted: { workers: [], d1: [], queues: [] },
      errors: [expect.stringContaining('immutable script tag changed')],
    });
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes('/queues/queue-audit/consumers/consumer-queue-audit') &&
          (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith('/queues/queue-audit/consumers') &&
          (init as { method?: string } | undefined)?.method === 'POST'
      )
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith('/d1/database/core-id') &&
          (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith('/queues/queue-audit') &&
          (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(false);
  });

  it('uses the verified Queue and Worker tuple when Cloudflare omits the optional consumer ID', async () => {
    mockCloudflareInventory(
      [{ queue_name: 'test-audit-queue', queue_id: 'queue-audit' }],
      [{ id: 'test-ar-management', tag: 'owned-worker-tag' }]
    );
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input: string | URL | Request, init) => {
      const url = String(input);
      if (
        url.endsWith('/queues/queue-audit/consumers') &&
        (init as { method?: string } | undefined)?.method !== 'POST'
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: [
              {
                type: 'worker',
                // Wrangler 4.x normalizes this live Queue API response from script/service,
                // while the current public API schema also documents script_name.
                script: 'test-ar-management',
                queue_name: 'test-audit-queue',
                settings: { batch_size: 10 },
              },
            ],
            result_info: { page: 1, total_pages: 1 },
          }),
        };
      }
      if (!defaultFetch) throw new Error('missing default Cloudflare fetch mock');
      return defaultFetch(input, init);
    });

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: true,
      deleteD1: false,
      deleteKV: false,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      knownWorkerResources: [
        { name: 'test-ar-management', cloudflareScriptTag: 'owned-worker-tag' },
      ],
      knownQueueResources: [{ name: 'test-audit-queue', id: 'queue-audit' }],
      queueConsumerDetachPropagationDelayMs: 0,
      workerDeletePropagationDelayMs: 0,
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: true,
      deleted: { workers: ['test-ar-management'], queues: ['test-audit-queue'] },
    });
    expect(
      execaMock.mock.calls.some(([, args]) =>
        (args as string[])
          .join(' ')
          .includes('queues consumer worker remove test-audit-queue test-ar-management')
      )
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes('/queues/queue-audit/consumers/') &&
          (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith('/queues/queue-audit') &&
          (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(true);
  });

  it('deletes exact lock-recorded D1, KV, and Queue IDs through REST', async () => {
    mockCloudflareInventory(
      [{ queue_name: 'test-audit-queue', queue_id: 'queue-audit' }],
      [],
      [],
      undefined,
      [{ name: 'test-authrim-core-db', uuid: 'core-id' }],
      0,
      undefined,
      [],
      undefined,
      {},
      [{ title: 'test-AUTHRIM_CONFIG', id: 'kv-config' }]
    );

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: false,
      deleteD1: true,
      deleteKV: true,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      knownD1Resources: [{ name: 'test-authrim-core-db', id: 'core-id' }],
      knownKVResources: [{ name: 'test-AUTHRIM_CONFIG', id: 'kv-config' }],
      knownQueueResources: [{ name: 'test-audit-queue', id: 'queue-audit' }],
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: true,
      deleted: {
        d1: ['test-authrim-core-db'],
        kv: ['test-AUTHRIM_CONFIG'],
        queues: ['test-audit-queue'],
      },
    });
    const deleteUrls = fetchMock.mock.calls
      .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE')
      .map(([input]) => String(input));
    expect(deleteUrls).toEqual([
      expect.stringMatching(/\/d1\/database\/core-id$/u),
      expect.stringMatching(/\/storage\/kv\/namespaces\/kv-config$/u),
      expect.stringMatching(/\/queues\/queue-audit$/u),
    ]);
  });

  it('runs Control token cleanup after provider inventory but before the first D1 deletion', async () => {
    mockCloudflareInventory([], [], [], undefined, [
      { name: 'test-authrim-control-db', uuid: 'control-id' },
    ]);
    const beforeD1Deletion = vi.fn(
      async (context: { observedD1Resources: ReadonlyArray<{ id: string; name: string }> }) => {
        expect(context.observedD1Resources).toEqual([
          { id: 'control-id', name: 'test-authrim-control-db' },
        ]);
        expect(
          fetchMock.mock.calls.some(
            ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE'
          )
        ).toBe(false);
      }
    );

    const result = await deleteEnvironment({
      env: 'test',
      environmentKnownLocally: true,
      deleteWorkers: false,
      deleteD1: true,
      deleteKV: false,
      deleteQueues: false,
      deleteR2: false,
      deletePages: false,
      beforeD1Deletion,
      onProgress: () => {},
    });

    expect(result.success).toBe(true);
    expect(result.deleted.d1).toEqual(['test-authrim-control-db']);
    expect(beforeD1Deletion).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith('/d1/database/control-id') &&
          (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(true);
  });

  it('fails closed before every D1 deletion when Control token cleanup is incomplete', async () => {
    mockCloudflareInventory([]);
    const beforeD1Deletion = vi.fn(
      async (context: { observedD1Resources: ReadonlyArray<{ id: string; name: string }> }) => {
        expect(context.observedD1Resources).toEqual([]);
        throw new Error('control_token_cleanup_revocation_retry_exhausted');
      }
    );

    const result = await deleteEnvironment({
      env: 'test',
      environmentKnownLocally: true,
      deleteWorkers: false,
      deleteD1: true,
      deleteKV: false,
      deleteQueues: false,
      deleteR2: false,
      deletePages: false,
      knownD1Resources: [
        { name: 'test-authrim-control-db', id: 'control-id' },
        { name: 'test-authrim-core-db', id: 'core-id' },
      ],
      beforeD1Deletion,
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: false,
      deleted: { d1: [] },
      errors: [expect.stringContaining('control_token_cleanup_revocation_retry_exhausted')],
    });
    expect(beforeD1Deletion).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(false);
  });

  it('continues verified storage deletion when token-edit authorization requires manual cleanup', async () => {
    mockCloudflareInventory(
      [{ queue_name: 'test-audit-queue', queue_id: 'queue-audit' }],
      [],
      [],
      undefined,
      [
        { name: 'test-authrim-control-db', uuid: 'control-id' },
        { name: 'test-authrim-core-db', uuid: 'core-id' },
      ],
      0,
      undefined,
      [],
      undefined,
      {},
      [{ title: 'test-AUTHRIM_CONFIG', id: 'kv-config' }]
    );
    const progress: string[] = [];
    const targetTokenIds = ['1'.repeat(32), '2'.repeat(32)];
    const beforeD1Deletion = vi.fn(async () => {
      throw new ControlTokenCleanupManualActionError({
        reason: CONTROL_TOKEN_CLEANUP_CREDENTIAL_UNAUTHORIZED,
        targetTokenIds,
        tokenOwnership: 'account',
      });
    });

    const result = await deleteEnvironment({
      env: 'test',
      environmentKnownLocally: true,
      deleteWorkers: false,
      deleteD1: true,
      deleteKV: true,
      deleteQueues: true,
      deleteR2: false,
      deletePages: false,
      knownD1Resources: [
        { name: 'test-authrim-control-db', id: 'control-id' },
        { name: 'test-authrim-core-db', id: 'core-id' },
      ],
      knownKVResources: [{ name: 'test-AUTHRIM_CONFIG', id: 'kv-config' }],
      knownQueueResources: [{ name: 'test-audit-queue', id: 'queue-audit' }],
      beforeD1Deletion,
      onProgress: (message) => progress.push(message),
    });

    expect(result).toMatchObject({
      success: true,
      completion: 'manual_action_required',
      deleted: {
        d1: ['test-authrim-control-db', 'test-authrim-core-db'],
        kv: ['test-AUTHRIM_CONFIG'],
        queues: ['test-audit-queue'],
      },
      manualControlTokens: [
        {
          reason: CONTROL_TOKEN_CLEANUP_CREDENTIAL_UNAUTHORIZED,
          targetTokenIds,
          tokenOwnership: 'account',
        },
      ],
      errors: [],
    });
    expect(beforeD1Deletion).toHaveBeenCalledOnce();
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.stringContaining('verified resource deletion will continue'),
        expect.stringContaining(`Exact account token ID: ${targetTokenIds[0]}`),
        expect.stringContaining(`Exact account token ID: ${targetTokenIds[1]}`),
      ])
    );
  });

  it('continues deletion with manual token review when Control D1 and its checkpoint are absent', async () => {
    mockCloudflareInventory([]);
    const progress: string[] = [];
    const beforeD1Deletion = vi.fn(async () => {
      throw new Error(
        'control_token_cleanup_checkpoint_required_for_missing_control_database_manual_recovery_required'
      );
    });

    const result = await deleteEnvironment({
      env: 'test',
      environmentKnownLocally: true,
      deleteWorkers: true,
      deleteD1: true,
      deleteKV: true,
      deleteQueues: true,
      deleteR2: true,
      deletePages: true,
      beforeD1Deletion,
      onProgress: (message) => progress.push(message),
    });

    expect(result).toMatchObject({
      success: true,
      completion: 'manual_action_required',
      environmentEmpty: true,
      postDeleteVerification: 'verified_empty',
      errors: [],
      manualControlTokens: [
        {
          reason:
            'control_token_cleanup_checkpoint_required_for_missing_control_database_manual_recovery_required',
        },
      ],
    });
    expect(beforeD1Deletion).toHaveBeenCalledOnce();
    expect(progress).toEqual(
      expect.arrayContaining([expect.stringContaining('left unchanged for manual review')])
    );
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

  it('completes current-resource deletion when unobserved legacy Pages inventory is unavailable', async () => {
    mockCloudflareInventory([]);
    const defaultFetch = fetchMock.getMockImplementation();
    const defaultExeca = execaMock.getMockImplementation();
    fetchMock.mockImplementation(async (input: string | URL | Request, init) => {
      if (String(input).includes('/pages/projects?')) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ success: false }),
        };
      }
      if (!defaultFetch) throw new Error('missing default Cloudflare fetch mock');
      return defaultFetch(input, init);
    });
    execaMock.mockImplementation(async (command: string, args: string[], options) => {
      if (args.slice(1).join(' ') === 'pages project list') {
        return { exitCode: 1, stdout: '', stderr: 'Pages command unavailable' };
      }
      if (!defaultExeca) throw new Error('missing default Wrangler mock');
      return defaultExeca(command, args, options);
    });
    const progress: string[] = [];

    const result = await deleteEnvironment({
      env: 'test',
      environmentKnownLocally: true,
      finalizeEnvironment: true,
      deleteWorkers: true,
      deleteD1: true,
      deleteKV: true,
      deleteQueues: true,
      deleteR2: true,
      deletePages: false,
      onProgress: (message) => progress.push(message),
    });

    expect(result).toMatchObject({
      success: true,
      completion: 'complete',
      environmentEmpty: true,
      postDeleteVerification: 'verified_empty',
      errors: [],
    });
    expect(progress).toEqual(
      expect.arrayContaining([expect.stringContaining('Could not scan Pages projects')])
    );
  });

  it('does not let finalization bypass a lock-recorded legacy Pages identity', async () => {
    await expect(
      deleteEnvironment({
        env: 'test',
        environmentKnownLocally: true,
        finalizeEnvironment: true,
        deleteWorkers: true,
        deleteD1: true,
        deleteKV: true,
        deleteQueues: true,
        deleteR2: true,
        deletePages: false,
        knownPagesResources: [
          {
            name: 'test-ar-admin-ui',
            id: 'pages-provider-id',
            createdOn: TEST_R2_CREATION_DATE,
          },
        ],
        onProgress: () => {},
      })
    ).rejects.toThrow(
      'Lock-recorded Pages projects must remain selected during final environment deletion'
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('fails retryably when strict post-delete readback still finds a Cloudflare resource', async () => {
    mockCloudflareInventory(
      [],
      [],
      [],
      undefined,
      [],
      0,
      undefined,
      [],
      undefined,
      {},
      [],
      [{ name: 'test-ar-admin-ui' }]
    );
    const progress: string[] = [];

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: true,
      deleteD1: true,
      deleteKV: true,
      deleteQueues: true,
      deleteR2: true,
      deletePages: true,
      knownPagesResources: [
        {
          name: 'test-ar-admin-ui',
          id: 'test-ar-admin-ui-provider-id',
          createdOn: TEST_R2_CREATION_DATE,
        },
      ],
      postDeleteVerificationAttempts: 2,
      postDeleteVerificationDelayMs: 0,
      onProgress: (message) => progress.push(message),
    });

    expect(result).toMatchObject({
      success: false,
      completion: 'failed',
      environmentEmpty: false,
      retryable: true,
      postDeleteVerification: 'resources_remaining',
      deleted: { pages: ['test-ar-admin-ui'] },
      errors: [expect.stringContaining('retry deletion')],
    });
    expect(progress).toContain('  ⏳ Cloudflare still reports environment resources (attempt 2/2)');
  });

  it('fails retryably when strict post-delete inventory readback is unavailable', async () => {
    mockCloudflareInventory([]);
    let workerInventoryReads = 0;
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input: string | URL | Request, init) => {
      const url = String(input);
      if (url.includes('/workers/scripts')) {
        workerInventoryReads += 1;
        // Environment deletion performs both a broad inventory and a final exact-identity
        // preflight. Make only the post-delete verification reads unavailable.
        if (workerInventoryReads > 2) {
          return {
            ok: false,
            status: 503,
            json: async () => ({ success: false }),
          };
        }
      }
      if (!defaultFetch) throw new Error('missing default Cloudflare fetch mock');
      return defaultFetch(input, init);
    });

    const result = await deleteEnvironment({
      env: 'test',
      environmentKnownLocally: true,
      deleteWorkers: true,
      deleteD1: true,
      deleteKV: true,
      deleteQueues: true,
      deleteR2: true,
      deletePages: true,
      postDeleteVerificationAttempts: 2,
      postDeleteVerificationDelayMs: 0,
      onProgress: () => {},
    });

    expect(result).toMatchObject({
      success: false,
      completion: 'failed',
      environmentEmpty: false,
      retryable: true,
      postDeleteVerification: 'inventory_unavailable',
      errors: [expect.stringContaining('Cloudflare API returned HTTP 503')],
    });
    expect(result.errors.join('\n')).not.toContain('No resources were deleted');
    expect(workerInventoryReads).toBe(8);
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
    const deletedD1Ids = fetchMock.mock.calls
      .filter(
        ([input, init]) =>
          String(input).includes('/d1/database/') &&
          (init as { method?: string } | undefined)?.method === 'DELETE'
      )
      .map(([input]) => String(input).split('/').at(-1));
    expect(deletedD1Ids).toEqual([
      'control',
      'bootstrap-default',
      'bootstrap-users',
      'bootstrap-pii',
      'dynamic',
    ]);
  });

  it('deletes a strict-pattern Control-managed dynamic KV by its snapshot ID', async () => {
    const dynamicName = `authrim-test-${'a'.repeat(32)}-kv`;
    mockCloudflareInventory([], [], [], undefined, [], 0, undefined, [], undefined, {}, [
      { title: dynamicName, id: 'dynamic-kv-id' },
      { title: `authrim-prod-${'b'.repeat(32)}-kv`, id: 'other-kv-id' },
      { title: 'authrim-test-customer-cache', id: 'unrelated-kv-id' },
    ]);

    const result = await deleteEnvironment({
      env: 'test',
      deleteWorkers: false,
      deleteD1: false,
      deleteKV: true,
      deleteQueues: false,
      deleteR2: false,
      deletePages: false,
      onProgress: () => {},
    });

    expect(result.deleted.kv).toEqual([dynamicName]);
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toEqual([
      [
        expect.stringMatching(/\/storage\/kv\/namespaces\/dynamic-kv-id$/u),
        expect.objectContaining({ method: 'DELETE' }),
      ],
    ]);
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
    const deleteAuthIndex = wranglerCalls.findIndex((args) =>
      args.join(' ').includes('delete --name test-ar-auth --force')
    );
    const deleteManagementIndex = wranglerCalls.findIndex((args) =>
      args.join(' ').includes('delete --name test-ar-management --force')
    );
    const queueDeleteFetchIndex = fetchMock.mock.calls.findIndex(
      ([input, init]) =>
        String(input).endsWith('/queues/queue-audit') &&
        (init as { method?: string } | undefined)?.method === 'DELETE'
    );
    const queueDeleteInvocation = fetchMock.mock.invocationCallOrder[queueDeleteFetchIndex];
    const detachFetchIndex = fetchMock.mock.calls.findIndex(
      ([input, init]) =>
        String(input).includes('/queues/queue-audit/consumers/consumer-queue-audit') &&
        (init as { method?: string } | undefined)?.method === 'DELETE'
    );
    const detachInvocation = fetchMock.mock.invocationCallOrder[detachFetchIndex];
    const authDeleteExecaIndex = execaMock.mock.calls.findIndex(([, args]) =>
      (args as string[]).join(' ').includes('delete --name test-ar-auth --force')
    );
    const authDeleteInvocation = execaMock.mock.invocationCallOrder[authDeleteExecaIndex];
    const managementDeleteExecaIndex = execaMock.mock.calls.findIndex(([, args]) =>
      (args as string[]).join(' ').includes('delete --name test-ar-management --force')
    );
    const managementDeleteInvocation =
      execaMock.mock.invocationCallOrder[managementDeleteExecaIndex];

    expect(detachFetchIndex).toBeGreaterThanOrEqual(0);
    expect(deleteAuthIndex).toBeGreaterThanOrEqual(0);
    expect(deleteManagementIndex).toBeGreaterThan(deleteAuthIndex);
    expect(authDeleteInvocation).toBeGreaterThan(detachInvocation);
    expect(queueDeleteInvocation).toBeGreaterThan(managementDeleteInvocation);
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
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith('/queues/queue-audit/consumers') &&
          (init as { method?: string } | undefined)?.method === 'POST'
      )
    ).toBe(true);
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
      knownD1Resources: [{ name: 'test-authrim-core-db', id: 'core-id' }],
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
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith('/queues/queue-audit/consumers') &&
          (init as { method?: string } | undefined)?.method === 'POST'
      )
    ).toBe(true);
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
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith('/queues/queue-audit/consumers') &&
          (init as { method?: string } | undefined)?.method === 'POST'
      )
    ).toBe(true);
  });

  it('preserves local recovery state after a partial retry removes its final selected resource', async () => {
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

    expect(result).toMatchObject({ success: true, environmentEmpty: false });
    expect(progress).toContain(
      "✅ Selected resources for 'test' deleted; remaining environment preserved"
    );
  });
});

function mockCloudflareInventory(
  queues: Array<{ queue_name: string; queue_id: string }>,
  workers: Array<{ id: string; tag?: string }> = [],
  r2Buckets: Array<{ name: string; creation_date?: string }> = [],
  workerDeleteFailureName?: string,
  d1Databases: Array<{ name: string; uuid: string }> = [],
  r2ObjectCount = 0,
  r2DeleteFailure?: string,
  alreadyAbsentDeletes: string[] = [],
  queueDeleteFailure?: string,
  queueConsumerFailures: {
    detach?: { match: string; error: string };
    restore?: { match: string; error: string };
  } = {},
  kvNamespaces: Array<{ title: string; id: string }> = [],
  pagesProjects: Array<{ name: string; id?: string; created_on?: string }> = [],
  workerDeploymentVersionIds: Record<string, string> = {}
): void {
  process.env.CLOUDFLARE_API_TOKEN = 'test-token';
  process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
  const liveR2Buckets = new Set(r2Buckets.map((bucket) => bucket.name));
  const exactR2Buckets = r2Buckets.map((bucket) => ({
    ...bucket,
    creation_date: bucket.creation_date ?? TEST_R2_CREATION_DATE,
  }));
  const exactPagesProjects = pagesProjects.map((project) => ({
    name: project.name,
    id: project.id ?? `${project.name}-provider-id`,
    created_on: project.created_on ?? TEST_R2_CREATION_DATE,
    domains: [],
  }));

  fetchMock.mockImplementation(
    async (input: string | URL | Request, init?: { method?: string }) => {
      const url = typeof input === 'string' ? input : input.toString();
      let result: unknown = workers.map((worker) => ({
        ...worker,
        tag: worker.tag ?? `${worker.id}-immutable-tag`,
      }));
      if (url.includes('/d1/database?')) {
        result = d1Databases;
      } else if (url.includes('/storage/kv/namespaces') && init?.method !== 'DELETE') {
        result = kvNamespaces;
      } else if (url.includes('/queues?')) {
        result = queues.map((queue) => ({ name: queue.queue_name, id: queue.queue_id }));
      } else if (/\/queues\/[^/?]+\/consumers(?:\/[^/?]+)?$/u.test(url)) {
        const parts = new URL(url).pathname.split('/');
        const queueIndex = parts.lastIndexOf('queues');
        const queueId = decodeURIComponent(parts[queueIndex + 1] ?? '');
        const queueName = queues.find((queue) => queue.queue_id === queueId)?.queue_name ?? queueId;
        const method = init?.method ?? 'GET';
        if (method === 'GET') {
          result = workers.some((worker) => worker.id === 'test-ar-management')
            ? [
                {
                  consumer_id: `consumer-${queueId}`,
                  type: 'worker',
                  script_name: 'test-ar-management',
                  queue_name: queueName,
                  settings: { batch_size: 10 },
                },
              ]
            : [];
        } else if (method === 'DELETE') {
          if (
            queueConsumerFailures.detach &&
            `${queueName} test-ar-management`.includes(queueConsumerFailures.detach.match)
          ) {
            return {
              ok: false,
              status: 403,
              json: async () => ({
                success: false,
                errors: [{ message: queueConsumerFailures.detach?.error }],
              }),
            };
          }
          result = {};
        } else if (method === 'POST') {
          if (
            queueConsumerFailures.restore &&
            `${queueName} test-ar-management`.includes(queueConsumerFailures.restore.match)
          ) {
            return {
              ok: false,
              status: 403,
              json: async () => ({
                success: false,
                errors: [{ message: queueConsumerFailures.restore?.error }],
              }),
            };
          }
          result = {};
        }
      } else if (url.includes('/r2/buckets?')) {
        result = {
          buckets: exactR2Buckets.filter((bucket) => liveR2Buckets.has(bucket.name)),
        };
      } else if (
        /\/r2\/buckets\/[^/?]+$/u.test(new URL(url).pathname) &&
        init?.method !== 'DELETE'
      ) {
        const bucketName = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
        const bucket = exactR2Buckets.find(
          (candidate) => candidate.name === bucketName && liveR2Buckets.has(candidate.name)
        );
        if (!bucket) {
          return { ok: false, status: 404, json: async () => ({ success: false }) };
        }
        result = bucket;
      } else if (url.includes('/r2/buckets/') && url.includes('/objects?')) {
        const prefix = new URL(url).searchParams.get('prefix');
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            success: true,
            result: prefix
              ? prefix === TEST_R2_OWNERSHIP_MARKER_KEY
                ? [{ key: TEST_R2_OWNERSHIP_MARKER_KEY }]
                : []
              : [
                  ...Array.from({ length: r2ObjectCount }, (_, index) => ({
                    key: `item-${index}`,
                  })),
                  { key: TEST_R2_OWNERSHIP_MARKER_KEY },
                ],
            result_info: { is_truncated: false },
          }),
        };
      } else if (
        url.includes(`/objects/${TEST_R2_OWNERSHIP_MARKER_KEY}`) &&
        init?.method !== 'DELETE'
      ) {
        const bucketName = decodeURIComponent(
          new URL(url).pathname.split('/r2/buckets/')[1]!.split('/objects/')[0]!
        );
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            bucketName,
            ownershipId: TEST_R2_OWNERSHIP_ID,
          })
        );
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(bytes.byteLength) }),
          arrayBuffer: async () => bytes.buffer,
        };
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
        if (!url.includes('/objects/')) {
          liveR2Buckets.delete(decodeURIComponent(new URL(url).pathname.split('/').at(-1)!));
        }
        result = {};
      } else if (url.includes('/pages/projects?')) {
        result = exactPagesProjects;
      } else if (/\/pages\/projects\/[^/?]+$/u.test(new URL(url).pathname)) {
        const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
        const project = exactPagesProjects.find((candidate) => candidate.name === name);
        if (!project) {
          return { ok: false, status: 404, json: async () => ({ success: false }) };
        }
        result = project;
      } else if (init?.method === 'DELETE' && url.includes('/d1/database/')) {
        const databaseId = decodeURIComponent(url.split('/').at(-1) ?? '');
        const databaseName = d1Databases.find((database) => database.uuid === databaseId)?.name;
        if (
          alreadyAbsentDeletes.includes(databaseId) ||
          (databaseName ? alreadyAbsentDeletes.includes(databaseName) : false)
        ) {
          return { ok: false, status: 404, json: async () => ({ success: false }) };
        }
        result = {};
      } else if (init?.method === 'DELETE' && /\/queues\/[^/?]+$/u.test(url)) {
        const queueId = decodeURIComponent(url.split('/').at(-1) ?? '');
        const queueName = queues.find((queue) => queue.queue_id === queueId)?.queue_name;
        if (queueDeleteFailure) {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              success: false,
              errors: [{ message: queueDeleteFailure }],
            }),
          };
        }
        if (
          alreadyAbsentDeletes.includes(queueId) ||
          (queueName ? alreadyAbsentDeletes.includes(queueName) : false)
        ) {
          return { ok: false, status: 404, json: async () => ({ success: false }) };
        }
        result = {};
      } else if (init?.method === 'DELETE' && url.includes('/storage/kv/namespaces/')) {
        result = {};
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result,
          ...(Array.isArray(result)
            ? {
                result_info: {
                  page: 1,
                  per_page: Math.max(result.length, 1),
                  count: result.length,
                  total_count: result.length,
                  total_pages: 1,
                },
              }
            : {}),
        }),
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
    if (key === 'd1 list --json') {
      return { exitCode: 0, stdout: '[]', stderr: '' };
    }
    if (key === 'kv namespace list') {
      return { exitCode: 0, stdout: JSON.stringify(kvNamespaces), stderr: '' };
    }
    if (key === 'queues list') {
      return { exitCode: 0, stdout: JSON.stringify(queues), stderr: '' };
    }
    if (key.startsWith('deployments list --name ')) {
      const workerName = key.slice('deployments list --name '.length);
      const versionId = workerDeploymentVersionIds[workerName];
      if (!versionId) {
        return { exitCode: 1, stdout: '', stderr: 'Worker does not exist [code: 10007]' };
      }
      return {
        exitCode: 0,
        stdout:
          `Created: 2026-08-31T00:00:00.000Z\n` +
          `Author: test@example.com\n` +
          `Source: Upload\n` +
          `Version(s): (100%) ${versionId}\n`,
        stderr: '',
      };
    }
    if (key.startsWith('versions view ')) {
      const match = key.match(/^versions view (\S+) --name (\S+) --json$/u);
      const versionId = match?.[1];
      const workerName = match?.[2];
      if (!versionId || !workerName || workerDeploymentVersionIds[workerName] !== versionId) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `Worker version ${versionId ?? 'unknown'} not found`,
        };
      }
      return { exitCode: 0, stdout: JSON.stringify({ id: versionId }), stderr: '' };
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
    if (key === 'r2 bucket list') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (key === 'pages project list') {
      return {
        exitCode: 0,
        stdout: pagesProjects.map((project) => project.name).join('\n'),
        stderr: '',
      };
    }
    if (key.startsWith('pages project delete ')) {
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
