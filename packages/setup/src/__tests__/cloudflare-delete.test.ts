import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));
const prepareLogArchiveDeletionMock = vi.hoisted(() => vi.fn());
vi.mock('../core/log-archive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/log-archive.js')>()),
  prepareLogArchiveDeletion: prepareLogArchiveDeletionMock,
}));
import {
  deleteEnvironment,
  type DeleteOptions,
  filterControlManagedD1ForEnvironment,
  filterControlManagedKVForEnvironment,
  filterControlManagedR2ForEnvironment,
  getObjectCatalogR2BucketName,
  parseR2BucketRows,
  parseD1RowsFromWranglerJson,
  parseObjectCatalogR2RowsFromWranglerJson,
} from '../core/cloudflare.js';

describe('Cloudflare environment deletion helpers', () => {
  it('maps object catalog R2 bindings to environment bucket names', () => {
    expect(getObjectCatalogR2BucketName('single', 'SENSITIVE_DETAILS')).toBe(
      'single-sensitive-details'
    );
    expect(getObjectCatalogR2BucketName('single', 'LOG_ARCHIVE')).toBe('single-log-archive');
    expect(getObjectCatalogR2BucketName('single', 'UNKNOWN')).toBeNull();
  });

  it('parses object catalog rows from wrangler D1 JSON output', () => {
    const rows = parseObjectCatalogR2RowsFromWranglerJson(
      JSON.stringify([
        {
          results: [
            { bucket_binding: 'SENSITIVE_DETAILS', object_key: 'approval/a.json' },
            { bucket_binding: 'EXPORT_ARTIFACTS', object_key: 'exports/b.zip' },
            { bucket_binding: null, object_key: 'ignored' },
            { bucket_binding: 'IMPORT_ARTIFACTS', object_key: 123 },
          ],
        },
      ])
    );

    expect(rows).toEqual([
      { bucketBinding: 'SENSITIVE_DETAILS', objectKey: 'approval/a.json' },
      { bucketBinding: 'EXPORT_ARTIFACTS', objectKey: 'exports/b.zip' },
    ]);
  });

  it('parses R2 bucket rows from JSON and legacy wrangler output', () => {
    expect(parseR2BucketRows(JSON.stringify([{ name: 'prod-public-assets' }]))).toEqual([
      { name: 'prod-public-assets' },
    ]);
    expect(parseR2BucketRows('name: prod-diagnostic-logs\nprod-import-artifacts\n')).toEqual([
      { name: 'prod-diagnostic-logs' },
      { name: 'prod-import-artifacts' },
    ]);
  });

  it('parses generic D1 rows from wrangler JSON output', () => {
    // Wrangler reports one entry per statement, each with `success`. An entry without it is not
    // evidence that the query ran, so it is not read (see d1-query-output-parser.test.ts).
    const rows = parseD1RowsFromWranglerJson<{ state: string; count: number }>(
      JSON.stringify([
        {
          success: true,
          results: [
            { state: 'available', count: 2 },
            { state: 'assigned', count: 1 },
          ],
        },
      ])
    );

    expect(rows).toEqual([
      { state: 'available', count: 2 },
      { state: 'assigned', count: 1 },
    ]);
  });

  it('selects only exact Control-managed resources for the requested environment', () => {
    expect(
      filterControlManagedD1ForEnvironment('test', [
        { name: 'authrim-test-core-default-default-a1b2c3d4', uuid: 'shared' },
        { name: 'authrim-test-core-users-default-tenant-a-a1b2c3d4', uuid: 'exclusive' },
        { name: 'test-authrim-tenant-core-users-jp-db-a1b2c3d4', uuid: 'new-exclusive' },
        { name: 'test-authrim-tenant-core-default-default-db-a1b2c3d4', uuid: 'new-default' },
        { name: 'test-authrim-tenant-default-bootstrap-db', uuid: 'bootstrap-default' },
        { name: 'test-authrim-tenant-users-bootstrap-db', uuid: 'bootstrap-users' },
        { name: 'test-authrim-tenant-pii-bootstrap-db', uuid: 'bootstrap-pii' },
        { name: `authrim-test-${'a'.repeat(32)}-d1`, uuid: 'plugin' },
        { name: `test-authrim-${'b'.repeat(32)}-d1`, uuid: 'new-plugin' },
        { name: 'test-authrim-tenant-lookup-bootstrap-db', uuid: 'bootstrap-near-miss' },
        { name: 'other-authrim-tenant-default-bootstrap-db', uuid: 'other-bootstrap' },
        { name: 'authrim-test-unrelated-a1b2c3d4', uuid: 'unrelated' },
        { name: 'authrim-other-core-default-default-a1b2c3d4', uuid: 'other' },
      ])
    ).toEqual([
      { name: 'authrim-test-core-default-default-a1b2c3d4', uuid: 'shared' },
      { name: 'authrim-test-core-users-default-tenant-a-a1b2c3d4', uuid: 'exclusive' },
      { name: 'test-authrim-tenant-core-users-jp-db-a1b2c3d4', uuid: 'new-exclusive' },
      { name: 'test-authrim-tenant-core-default-default-db-a1b2c3d4', uuid: 'new-default' },
      { name: 'test-authrim-tenant-default-bootstrap-db', uuid: 'bootstrap-default' },
      { name: 'test-authrim-tenant-users-bootstrap-db', uuid: 'bootstrap-users' },
      { name: 'test-authrim-tenant-pii-bootstrap-db', uuid: 'bootstrap-pii' },
      { name: `authrim-test-${'a'.repeat(32)}-d1`, uuid: 'plugin' },
      { name: `test-authrim-${'b'.repeat(32)}-d1`, uuid: 'new-plugin' },
    ]);

    expect(
      filterControlManagedKVForEnvironment('test', [
        { title: `authrim-test-${'a'.repeat(32)}-kv`, id: 'legacy-plugin-kv' },
        { title: `test-authrim-${'b'.repeat(32)}-kv`, id: 'plugin-kv' },
        { title: `authrim-other-${'b'.repeat(32)}-kv`, id: 'other-kv' },
        { title: 'authrim-test-not-owned-kv', id: 'unrelated-kv' },
      ])
    ).toEqual([
      { title: `authrim-test-${'a'.repeat(32)}-kv`, id: 'legacy-plugin-kv' },
      { title: `test-authrim-${'b'.repeat(32)}-kv`, id: 'plugin-kv' },
    ]);

    expect(
      filterControlManagedR2ForEnvironment('test', [
        { name: `authrim-test-${'a'.repeat(32)}-r2` },
        { name: `test-authrim-${'c'.repeat(32)}-r2` },
        { name: `authrim-other-${'c'.repeat(32)}-r2` },
        { name: 'authrim-test-not-owned-r2' },
      ])
    ).toEqual([
      { name: `authrim-test-${'a'.repeat(32)}-r2` },
      { name: `test-authrim-${'c'.repeat(32)}-r2` },
    ]);
  });
});

// Like the Queue deletion fake, serve provider inventory and marker bytes through the existing
// REST transport. Mutations remove rows so the final strict inventory can verify completion.
describe('R2 deletion ownership adoption', () => {
  const ownershipId = '11111111-1111-4111-8111-111111111111';
  const markerKey = `__authrim_setup__/ownership-v1-${ownershipId}.json`;
  const candidate = {
    name: 'test-public-assets',
    creationDate: '2026-08-31T00:00:00.000Z',
    ownershipMarkerKey: markerKey,
    ownershipId,
    binding: 'PUBLIC_ASSETS',
    environment: 'test',
  };
  let markers: string[];
  let payload: Record<string, unknown>;
  let unreadable: boolean;
  let expireCredentialsOnMarkerRead: boolean;
  let dnsMismatch: boolean;
  let dnsReads: number;
  let workers: Array<{ id: string; tag: string }>;
  let queues: Array<{ name: string; id: string }>;
  let mutations: string[];
  let prefixReads: string[];
  let buckets: string[];
  let d1: Array<{ name: string; uuid: string }>;
  const options = (): DeleteOptions => ({
    env: 'test',
    deletePages: true,
    knownD1Resources: [{ name: 'test-authrim-core-db', id: 'core-id' }],
    onProgress: () => {},
    postDeleteVerificationDelayMs: 0,
  });

  beforeEach(() => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test-token');
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '0123456789abcdef0123456789abcdef');
    markers = [markerKey];
    payload = {
      version: 1,
      bucketName: candidate.name,
      ownershipId,
      binding: candidate.binding,
      environment: 'test',
    };
    unreadable = false;
    expireCredentialsOnMarkerRead = false;
    dnsMismatch = false;
    dnsReads = 0;
    workers = [];
    queues = [];
    prepareLogArchiveDeletionMock.mockReset().mockResolvedValue(async () => {});
    mutations = [];
    prefixReads = [];
    buckets = [candidate.name];
    d1 = [{ name: 'test-authrim-core-db', uuid: 'core-id' }];
    execaMock.mockReset().mockImplementation(async (_command: string, args: string[]) => {
      if (args.slice(1).join(' ') === 'whoami')
        return { exitCode: 0, stdout: 'Account ID: 0123456789abcdef0123456789abcdef', stderr: '' };
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: globalThis.RequestInit) => {
        const url = new URL(input);
        const path = url.pathname;
        let result: unknown = [];
        if (init?.method && init.method !== 'GET') {
          mutations.push(`${init.method} ${path}`);
          if (
            path.endsWith('/r2/buckets/' + candidate.name) ||
            path.endsWith('/r2/buckets/test-log-archive')
          )
            buckets = [];
          if (path.endsWith('/d1/database/core-id')) d1 = [];
          return new Response(JSON.stringify({ success: true, result: {} }));
        }
        if (path.endsWith('/r2/buckets')) {
          result = {
            buckets: buckets.map((name) => ({ name, creation_date: candidate.creationDate })),
          };
        } else if (buckets.some((name) => path.endsWith('/r2/buckets/' + name))) {
          if (!buckets.length) return new Response('{}', { status: 404 });
          result = { name: path.split('/').at(-1), creation_date: candidate.creationDate };
        } else if (path.endsWith('/objects')) {
          const prefix = url.searchParams.get('prefix');
          if (prefix) prefixReads.push(prefix);
          result = markers
            .filter((key) => !prefix || key.startsWith(prefix))
            .map((key) => ({ key }));
        } else if (path.includes('/objects/')) {
          if (expireCredentialsOnMarkerRead) vi.stubEnv('CLOUDFLARE_API_TOKEN', '');
          return unreadable
            ? new Response('{}', { status: 403 })
            : new Response(JSON.stringify(payload));
        } else if (path.endsWith('/workers/scripts')) result = workers;
        else if (path.endsWith('/queues')) result = queues;
        else if (path.endsWith('/consumers'))
          return new Response(
            JSON.stringify({ success: false, errors: [{ message: 'consumer inventory denied' }] }),
            { status: 403 }
          );
        else if (path.includes('/dns_records')) {
          dnsReads++;
          result = dnsMismatch
            ? [
                {
                  id: 'replacement',
                  type: 'CNAME',
                  name: '*.test.example.com',
                  content: 'other.example.com',
                  proxied: true,
                  ttl: 1,
                },
              ]
            : [];
        } else if (path.endsWith('/d1/database')) result = d1;
        return new Response(
          JSON.stringify({
            success: true,
            result,
            result_info: {
              page: 1,
              total_pages: 1,
              total_count: Array.isArray(result) ? result.length : 0,
              is_truncated: false,
            },
          })
        );
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reports a verified unpinned candidate and deletes nothing without opt-in', async () => {
    const confirm = vi.fn();
    const persist = vi.fn();
    const result = await deleteEnvironment({
      ...options(),
      onR2OwnershipAdoption: confirm,
      onR2OwnershipAdoptionPersist: persist,
    });
    expect(result).toMatchObject({ success: false, adoptionCandidates: [candidate] });
    expect(result.errors.join(' ')).toContain('--adopt-r2-ownership');
    expect(confirm).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(mutations).toEqual([]);
  });

  it('persists confirmed ownership before deleting the bucket and other resources', async () => {
    const persisted: unknown[] = [];
    const persist = vi.fn(async (rows) => {
      expect(mutations).toEqual([]);
      persisted.push(...rows);
    });
    const confirm = vi.fn(async () => true);
    const result = await deleteEnvironment({
      ...options(),
      adoptR2Ownership: true,
      onR2OwnershipAdoption: confirm,
      onR2OwnershipAdoptionPersist: persist,
    });
    expect(result).toMatchObject({
      success: true,
      environmentEmpty: true,
      deleted: { r2: [candidate.name], d1: ['test-authrim-core-db'] },
    });
    expect(confirm).toHaveBeenCalledWith([candidate]);
    expect(persisted).toEqual([candidate]);
    expect(persist).toHaveBeenCalledOnce();
    // Discovery, then normal pinned-marker preflight on fresh inventory.
    expect(prefixReads).toContain(markerKey);
  });

  it.each([
    'environment',
    'binding',
    'missing',
    'multiple',
    'unreadable',
    'version',
    'ownershipId',
    'bucketName',
    'malformed-key',
  ])('preserves all resources for an invalid marker: %s', async (kind) => {
    if (kind === 'missing') markers = [];
    else if (kind === 'multiple') markers.push(markerKey.replace('11111111-', '22222222-'));
    else if (kind === 'unreadable') unreadable = true;
    else if (kind === 'malformed-key') markers = ['__authrim_setup__/ownership-v1-invalid.json'];
    else payload[kind] = kind === 'version' ? 2 : 'other';
    const confirm = vi.fn(async () => true);
    const persist = vi.fn();
    const result = await deleteEnvironment({
      ...options(),
      adoptR2Ownership: true,
      onR2OwnershipAdoption: confirm,
      onR2OwnershipAdoptionPersist: persist,
    });
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('manually in Cloudflare');
    expect(prefixReads).toContain('__authrim_setup__/ownership-v1-');
    expect(confirm).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(mutations).toEqual([]);
  });

  it('aborts before provider mutations when persisting the lock fails', async () => {
    const persist = vi.fn(async () => {
      throw new Error('disk full');
    });
    const result = await deleteEnvironment({
      ...options(),
      adoptR2Ownership: true,
      onR2OwnershipAdoption: async () => true,
      onR2OwnershipAdoptionPersist: persist,
    });
    expect(persist).toHaveBeenCalledWith([candidate]);
    expect(result.errors.join(' ')).toContain('disk full');
    expect(mutations).toEqual([]);
  });

  it.each([false, 'abort'] as const)(
    'does not persist or delete when confirmation returns %s',
    async (answer) => {
      const persist = vi.fn();
      const confirm = vi.fn(async () => answer);
      await deleteEnvironment({
        ...options(),
        adoptR2Ownership: true,
        onR2OwnershipAdoption: confirm,
        onR2OwnershipAdoptionPersist: persist,
      });
      expect(confirm).toHaveBeenCalledWith([candidate]);
      expect(persist).not.toHaveBeenCalled();
      expect(mutations).toEqual([]);
    }
  );

  it('blocks adoption when another resource has a conflicting immutable identity', async () => {
    const confirm = vi.fn(async () => true);
    const persist = vi.fn();
    const result = await deleteEnvironment({
      ...options(),
      adoptR2Ownership: true,
      knownD1Resources: [{ name: 'test-authrim-core-db', id: 'replacement-id' }],
      onR2OwnershipAdoption: confirm,
      onR2OwnershipAdoptionPersist: persist,
    });
    expect(prefixReads).toContain('__authrim_setup__/ownership-v1-');
    expect(result.success).toBe(false);
    expect(result.adoptionCandidates).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(mutations).toEqual([]);
  });

  it('requires a durable lock writer even after explicit confirmation', async () => {
    const confirm = vi.fn(async () => true);
    const result = await deleteEnvironment({
      ...options(),
      adoptR2Ownership: true,
      onR2OwnershipAdoption: confirm,
    });
    expect(confirm).toHaveBeenCalledWith([candidate]);
    expect(result.errors.join(' ')).toContain('lock writer is unavailable');
    expect(mutations).toEqual([]);
  });

  it('requires confirmation even when the adoption flag is set', async () => {
    const persist = vi.fn();
    const result = await deleteEnvironment({
      ...options(),
      adoptR2Ownership: true,
      onR2OwnershipAdoptionPersist: persist,
    });
    expect(result.adoptionCandidates).toEqual([candidate]);
    expect(persist).not.toHaveBeenCalled();
    expect(mutations).toEqual([]);
  });

  it('rechecks the marker after saving adoption before deleting any resource', async () => {
    const persist = vi.fn(async () => {
      payload.environment = 'other';
    });
    const result = await deleteEnvironment({
      ...options(),
      adoptR2Ownership: true,
      onR2OwnershipAdoption: async () => true,
      onR2OwnershipAdoptionPersist: persist,
    });
    expect(persist).toHaveBeenCalledWith([candidate]);
    expect(result.errors.join(' ')).toContain('ownership marker is missing or invalid');
    expect(mutations).toEqual([]);
  });

  const dnsOwnership = {
    tenant_wildcard: {
      role: 'tenant_wildcard' as const,
      state: 'managed' as const,
      action: 'created' as const,
      operationId: 'dns-op',
      zoneId: 'zone-id',
      recordId: 'record-id',
      name: '*.test.example.com',
      target: 'test.example.com',
      marker: 'setup-marker',
      previous: null,
      updatedAt: '2026-08-31T00:00:00.000Z',
    },
  };

  it.each(['DNS', 'Log Archive', 'credentials', 'Queue consumers'] as const)(
    'does not confirm or persist pending R2 adoption when %s preflight fails',
    async (blocker) => {
      const confirm = vi.fn(async () => true);
      const persist = vi.fn();
      const extra: Partial<DeleteOptions> = {};
      if (blocker === 'DNS') {
        dnsMismatch = true;
        extra.knownDnsOwnership = dnsOwnership;
      }
      if (blocker === 'Log Archive') {
        extra.knownLogArchiveResource = { bucketName: 'test-log-archive' } as NonNullable<
          DeleteOptions['knownLogArchiveResource']
        >;
        extra.knownR2Resources = [
          { ...candidate, name: 'test-log-archive', binding: 'LOG_ARCHIVE' },
        ];
        prepareLogArchiveDeletionMock.mockRejectedValue(
          new Error('log_archive_deletion_ownership_mismatch')
        );
      }
      if (blocker === 'credentials') expireCredentialsOnMarkerRead = true;
      if (blocker === 'Queue consumers') {
        workers = [{ id: 'test-ar-management', tag: 'owned-tag' }];
        queues = [{ name: 'test-audit-queue', id: 'queue-id' }];
        extra.knownWorkerResources = [
          { name: 'test-ar-management', cloudflareScriptTag: 'owned-tag' },
        ];
        extra.knownQueueResources = queues;
      }
      const result = await deleteEnvironment({
        ...options(),
        ...extra,
        adoptR2Ownership: true,
        onR2OwnershipAdoption: confirm,
        onR2OwnershipAdoptionPersist: persist,
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(mutations).toEqual([]);
      expect(result).toMatchObject({ adoptionCandidates: [candidate], adoptionReady: false });
      if (blocker === 'DNS')
        expect(result.manualDns).toEqual([
          expect.objectContaining({
            reason: expect.stringContaining('dns_managed_record_identity_mismatch'),
          }),
        ]);
      else
        expect(result.errors.join(' ')).toContain(
          blocker === 'Log Archive'
            ? 'log_archive_deletion_ownership_mismatch'
            : blocker === 'Queue consumers'
              ? 'consumer inventory denied'
              : 'credentials are unavailable'
        );
    }
  );

  it('preflights an unpinned Log Archive bucket before confirmation and again after saving', async () => {
    buckets = ['test-log-archive'];
    payload.bucketName = 'test-log-archive';
    payload.binding = 'LOG_ARCHIVE';
    const logCandidate = { ...candidate, name: 'test-log-archive', binding: 'LOG_ARCHIVE' };
    const events: string[] = [];
    prepareLogArchiveDeletionMock.mockImplementation(async () => {
      events.push('archive-preflight');
      expect(mutations).toEqual([]);
      return async () => {
        expect(dnsReads).toBeGreaterThanOrEqual(2);
        events.push('archive-delete');
      };
    });
    const result = await deleteEnvironment({
      ...options(),
      adoptR2Ownership: true,
      knownLogArchiveResource: { bucketName: 'test-log-archive' } as NonNullable<
        DeleteOptions['knownLogArchiveResource']
      >,
      knownDnsOwnership: dnsOwnership,
      onR2OwnershipAdoption: async (rows) => {
        expect(rows).toEqual([logCandidate]);
        expect(events).toEqual(['archive-preflight']);
        expect(dnsReads).toBe(1);
        events.push('confirm');
        return true;
      },
      onR2OwnershipAdoptionPersist: async () => {
        expect(mutations).toEqual([]);
        events.push('save');
      },
    });
    expect(result.success).toBe(true);
    expect(events).toEqual([
      'archive-preflight',
      'confirm',
      'save',
      'archive-preflight',
      'archive-delete',
    ]);
    expect(result.deleted.r2).toEqual(['test-log-archive']);
  });

  it('compares an empty rediscovery before any mutation when the caller confirmed candidates', async () => {
    buckets = [];
    const confirm = vi.fn(async () => false);
    const persist = vi.fn();
    const result = await deleteEnvironment({
      ...options(),
      adoptR2Ownership: true,
      expectR2OwnershipAdoption: true,
      onR2OwnershipAdoption: confirm,
      onR2OwnershipAdoptionPersist: persist,
    });
    expect(confirm).toHaveBeenCalledWith([]);
    expect(persist).not.toHaveBeenCalled();
    expect(mutations).toEqual([]);
    expect(result).toMatchObject({ success: false, adoptionCandidates: [] });
  });

  it('does not adopt any candidates when another environment bucket is unverified', async () => {
    buckets.push('test-import-artifacts');
    const confirm = vi.fn(async () => true);
    const persist = vi.fn();
    const result = await deleteEnvironment({
      ...options(),
      adoptR2Ownership: true,
      onR2OwnershipAdoption: confirm,
      onR2OwnershipAdoptionPersist: persist,
    });
    expect(prefixReads).toContain('__authrim_setup__/ownership-v1-');
    expect(result.success).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(mutations).toEqual([]);
  });
});
