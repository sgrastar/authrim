import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';

const { implemented } = vi.hoisted(() => ({ implemented: [] as Array<'pipeline' | 'scheduled'> }));
vi.mock('@authrim/ar-lib-logging/iceberg/capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-logging/iceberg/capabilities')>()),
  LOG_ARCHIVE_IMPLEMENTED_MODES: implemented,
}));
import { createDefaultConfig, parseConfig } from '../core/config.js';
import {
  assertLogArchiveImplemented,
  createLogArchiveConfig,
  LogArchiveConfigSchema,
} from '../core/log-archive-config.js';
import {
  LogArchiveApi,
  LogArchiveApiError,
  LOG_ARCHIVE_SCHEMA_DIGEST,
  planLogArchive,
  preflightLogArchive,
  prepareLogArchiveDeletion,
  provisionLogArchive,
} from '../core/log-archive.js';
import {
  loadIssuedLogArchiveAccountId,
  loadLogArchiveSecrets,
  publishLogArchiveSecrets,
  stageLogArchiveSecrets,
} from '../core/log-archive-secrets.js';
import { generateWranglerConfig, toToml } from '../core/wrangler.js';
import {
  beginOrResumeProvisioningIntent,
  recordProvisioningResourceCreateIssued,
} from '../core/provisioning-intent.js';
import type { ProvisioningResourceCheckpoint } from '../core/provisioning-intent.js';
import { getSecretNamesForWorker } from '../core/secrets.js';
import { LOG_ARCHIVE_ICEBERG_SCHEMA } from '@authrim/ar-lib-logging/iceberg/schema';
import type { IcebergLoadedTable } from '@authrim/ar-lib-logging/iceberg';
import { deployWorker, deployWorkerGradually } from '../core/deploy.js';
import { getHtmlTemplate } from '../web/ui.js';

const accountId = 'a'.repeat(32);
const tokenRead = 'fake-read-token';
const tokenWrite = 'fake-write-token';
const tokenSink = 'fake-sink-token';
const directories: string[] = [];

beforeEach(() => {
  implemented.length = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function fixture(mode: 'pipeline' | 'scheduled') {
  const archive = createLogArchiveConfig('demo', mode);
  const remote = new Map<string, Record<string, unknown>>();
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  const overrides = new Map<
    string,
    { status?: number; result?: unknown; errors?: unknown; raw?: string }
  >();
  const loseResponse = new Set<string>();
  const staleEntries: {
    namespaces?: Array<{ name: string[]; createdAt: string }>;
    tables?: Record<string, Array<{ name: string; createdAt: string; updatedAt: string }>>;
  } = {};
  const permissionGroups = [
    { id: 'catalog-read', name: 'Workers R2 Data Catalog Read' },
    { id: 'sql-read', name: 'Workers R2 SQL Read' },
    { id: 'catalog-write', name: 'Workers R2 Data Catalog Write' },
    { id: 'r2-write', name: 'Workers R2 Storage Write' },
    { id: 'r2-read', name: 'Workers R2 Storage Read' },
  ];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
    const path = String(url).split(`/accounts/${accountId}/`)[1];
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ path, method, body });
    const override = overrides.get(path);
    if (override?.raw !== undefined) return new Response(override.raw, { status: override.status });
    if (override)
      return new Response(
        JSON.stringify({
          success: (override.status ?? 200) < 400,
          result: override.result,
          ...(override.errors === undefined ? {} : { errors: override.errors }),
        }),
        { status: override.status ?? 200 }
      );
    let result: unknown;
    if (path === 'subscriptions') result = [{ rate_plan: { id: 'WORKERS_PAID' }, state: 'Paid' }];
    else if (path.startsWith('tokens/permission_groups')) result = permissionGroups;
    else if (path === 'tokens/verify')
      result = {
        id:
          new Headers(init?.headers).get('authorization') === `Bearer ${tokenRead}`
            ? 'read-id'
            : new Headers(init?.headers).get('authorization') === `Bearer ${tokenWrite}`
              ? 'write-id'
              : 'sink-id',
        status: 'active',
      };
    else if (path === 'tokens/read-id' || path === 'tokens/write-id' || path === 'tokens/sink-id')
      result = {
        policies: [
          {
            effect: 'allow',
            resources: { [`com.cloudflare.api.account.${accountId}`]: '*' },
            permission_groups: permissionGroups.filter((group) =>
              group.id.endsWith(path === 'tokens/read-id' ? 'read' : 'write')
            ),
          },
        ],
      };
    else if (path.startsWith('basin-catalog/')) {
      const catalogPath = `basin-catalog/${archive.bucketName}`;
      if (path.endsWith('/maintenance-configs')) {
        if (method === 'POST') {
          result = {
            compaction: body!.compaction,
            snapshot_expiration: {
              ...(body!.snapshot_expiration as object),
              next_eligible_at: null,
            },
          };
          remote.set(path, result as Record<string, unknown>);
        } else
          result = {
            maintenance_config: remote.get(path) ?? {
              snapshot_expiration: {
                state: 'enabled',
                next_eligible_at: '2026-10-28T00:00:00Z',
                max_snapshot_age: '30d',
                min_snapshots_to_keep: 5,
              },
            },
          };
      } else if (method === 'POST' && path.endsWith('/enable')) {
        // Re-enabling a disabled catalog brings the same catalog (and its entries) back.
        const existing = remote.get(catalogPath);
        result = existing
          ? Object.assign(existing, { status: 'active' })
          : { id: 'catalog-id', name: `${accountId}_${archive.bucketName}`, status: 'active' };
        remote.set(catalogPath, result as Record<string, unknown>);
      } else if (method === 'POST' && path.endsWith('/disable')) {
        remote.get(catalogPath)!.status = 'inactive';
        result = { ...remote.get(catalogPath)! };
      } else if (method === 'GET' && path === catalogPath) {
        // Cloudflare answers 404 for both: 40401 when missing, 40402 when disabled.
        const existing = remote.get(catalogPath);
        if (!existing || existing.status === 'inactive')
          return new Response(
            JSON.stringify({
              success: false,
              result: null,
              errors: [
                existing
                  ? { code: 40402, message: 'Warehouse inactive' }
                  : { code: 40401, message: 'Warehouse not found' },
              ],
            }),
            { status: 404 }
          );
        result = existing;
      } else if (method === 'POST' && path.split('?')[0].endsWith('/delete')) {
        remote.delete(catalogPath);
        result = null;
      } else if (
        path.startsWith(`${catalogPath}/namespaces`) &&
        remote.get(catalogPath)?.status === 'inactive'
      ) {
        // Listings answer only while the catalog is active.
        return new Response(
          JSON.stringify({
            success: false,
            result: null,
            errors: [{ code: 40402, message: 'Warehouse inactive' }],
          }),
          { status: 404 }
        );
      } else if (path.split('?')[0] === `${catalogPath}/namespaces`) {
        const parent = new URL(`https://example.invalid/${path}`).searchParams.get('parent') ?? '';
        const listed = (staleEntries.namespaces ?? []).filter(
          (entry) => entry.name.slice(0, -1).join('\u001f') === parent
        );
        result = {
          namespaces: listed.map((entry) => entry.name),
          details: listed.map((entry) => ({ namespace: entry.name, created_at: entry.createdAt })),
        };
      } else if (
        path.startsWith(`${catalogPath}/namespaces/`) &&
        path.split('?')[0].endsWith('/tables')
      ) {
        const namespace = decodeURIComponent(
          path.split('?')[0].slice(`${catalogPath}/namespaces/`.length, -'/tables'.length)
        );
        const tables = staleEntries.tables?.[namespace] ?? [];
        result = {
          identifiers: tables.map((table) => ({
            namespace: namespace.split('\u001f'),
            name: table.name,
          })),
          details: tables.map((table) => ({
            identifier: { namespace: namespace.split('\u001f'), name: table.name },
            created_at: table.createdAt,
            updated_at: table.updatedAt,
          })),
        };
      } else result = remote.get(path);
    } else if (path.startsWith('pipelines/v1/')) {
      if (method === 'POST') {
        result = { ...body, id: `${path.split('/').at(-1)}-id` };
        remote.set(
          `${path}/${(result as Record<string, unknown>).id}`,
          result as Record<string, unknown>
        );
      } else if (method === 'DELETE') {
        remote.delete(path);
        result = null;
      } else if (path.includes('?'))
        result = [...remote.entries()]
          .filter(
            ([key, value]) =>
              key.startsWith(path.split('?')[0]) &&
              value.name === new URL(`https://example.invalid/${path}`).searchParams.get('name')
          )
          .map(([, value]) => value);
      else result = remote.get(path);
    }
    if (method === 'POST' && loseResponse.has(path)) throw new Error('simulated response loss');
    return new Response(
      JSON.stringify(result === undefined ? { success: false } : { success: true, result }),
      { status: result === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;
  const checkpoints: Record<string, ProvisioningResourceCheckpoint> = {};
  const checkpoint = vi.fn(async (resource: ProvisioningResourceCheckpoint) => {
    checkpoints[`${resource.kind}:${resource.binding}`] = resource;
  });
  const assertBucketOwned = vi.fn(async () => undefined);
  const prepareScheduledTable = vi.fn(async () => undefined);
  const physicalSchema = structuredClone(LOG_ARCHIVE_ICEBERG_SCHEMA);
  if (mode === 'pipeline')
    physicalSchema.fields.push({ id: 100, name: '__ingest_ts', type: 'timestamp', required: true });
  const metadata: IcebergLoadedTable['metadata'] = {
    'format-version': 2,
    'table-uuid': 'bba2d8f7-861e-4b6e-9df1-48faea8ae805',
    location: `s3://${archive.bucketName}/${archive.namespace}/${archive.tableName}`,
    'last-sequence-number': 0,
    'last-updated-ms': 1793000000000,
    'last-column-id': mode === 'pipeline' ? 100 : 20,
    'current-schema-id': 0,
    schemas: [physicalSchema],
    'default-spec-id': 0,
    'partition-specs': [
      {
        'spec-id': 0,
        fields:
          mode === 'pipeline'
            ? [{ 'source-id': 100, 'field-id': 1000, name: '__ingest_ts_day', transform: 'day' }]
            : [],
      },
    ],
    'last-partition-id': 1000,
    'sort-orders': [{ 'order-id': 0, fields: [] }],
    'default-sort-order-id': 0,
  };
  const loadArchiveTable = vi.fn(async () => ({
    metadata,
    metadataLocation: `${metadata.location}/metadata/00000.json`,
  }));
  const options = {
    environment: 'demo',
    archive,
    api: new LogArchiveApi(accountId, 'setup-control-token', fetcher),
    catalogReadToken: tokenRead,
    catalogWriteToken: tokenWrite,
    ...(mode === 'pipeline' ? { catalogSinkToken: tokenSink } : {}),
    checkpoints,
    checkpoint,
    assertBucketOwned,
    bucketCreationDate: '2026-11-08T01:31:19.733Z' as string | undefined,
    prepareScheduledTable,
    loadArchiveTable,
  };
  return {
    archive,
    remote,
    staleEntries,
    calls,
    fetcher,
    checkpoints,
    options,
    checkpoint,
    prepareScheduledTable,
    assertBucketOwned,
    overrides,
    loseResponse,
    metadata,
    loadArchiveTable,
  };
}

describe('log archive setup contract', () => {
  it('commits the visible mode only after email validation and preserves the browser environment', async () => {
    implemented.push('pipeline', 'scheduled');
    const html = getHtmlTemplate();
    const start = html.indexOf("document.getElementById('btn-continue-email').addEventListener");
    const end = html.indexOf('// Modal handlers', start);
    const nodes = new Map<
      string,
      {
        value: string;
        checked: boolean;
        disabled: boolean;
        textContent: string;
        classList: { remove: ReturnType<typeof vi.fn> };
        addEventListener: (event: string, callback: () => Promise<void>) => void;
      }
    >();
    let click: (() => Promise<void>) | undefined;
    const node = (id: string) => {
      if (!nodes.has(id))
        nodes.set(id, {
          value: '',
          checked: false,
          disabled: false,
          textContent: '',
          classList: { remove: vi.fn() },
          addEventListener: (_event, callback) => {
            click = callback;
          },
        });
      return nodes.get(id)!;
    };
    let emailChoice = 'cloudflare';
    const config: {
      env: string;
      features: { queue: { enabled: boolean } };
      logging?: { archive: ReturnType<typeof createLogArchiveConfig> };
    } = { env: 'demo', features: { queue: { enabled: false } } };
    const api = vi.fn(async (_path: string, request: { body: string }) => ({
      success: true,
      archive: createLogArchiveConfig('demo', JSON.parse(request.body).mode),
    }));
    const alerts = vi.fn();
    const context = vm.createContext({
      config,
      api,
      alert: alerts,
      confirm: () => true,
      t: (value: string) => value,
      document: { getElementById: node, querySelector: () => ({ value: emailChoice }) },
    });
    vm.runInContext(html.slice(start, end), context);
    node('log-archive-mode').value = 'pipeline';
    await click!();
    expect(alerts).toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    expect(config.logging).toBeUndefined();
    emailChoice = 'later';
    node('log-archive-mode').value = 'scheduled';
    node('log-archive-retention').value = '7';
    node('log-archive-read-token').value = tokenRead;
    node('log-archive-write-token').value = tokenWrite;
    await click!();
    expect(api).toHaveBeenCalledTimes(1);
    expect(JSON.parse(api.mock.calls[0][1].body)).toMatchObject({
      environment: 'demo',
      mode: 'scheduled',
      dbRetentionDays: 7,
    });
    expect(config.logging!.archive.mode).toBe('scheduled');
    expect(config.features.queue.enabled).toBe(false);
    expect(node('log-archive-mode').disabled).toBe(true);
  });

  it('allows an unselected draft but refuses operational use and hides unfinished choices', () => {
    expect(createDefaultConfig('demo').logging).toBeUndefined();
    expect(() => assertLogArchiveImplemented(undefined)).toThrow('mode_required');
    expect(getHtmlTemplate()).not.toContain('id="log-archive-options"');
    expect(() => assertLogArchiveImplemented(createLogArchiveConfig('demo', 'scheduled'))).toThrow(
      'not_implemented'
    );
  });

  it('keeps a generation stable through parsing and rejects contradictory options', () => {
    const archive = createLogArchiveConfig('demo', 'scheduled');
    const config = createDefaultConfig('demo');
    config.logging = { archive };
    expect(parseConfig(config).logging!.archive).toEqual(archive);
    expect(archive.dbRetentionDays).toBe(7);
    expect(LogArchiveConfigSchema.safeParse({ ...archive, streamId: 'foreign' }).success).toBe(
      false
    );
    expect(LogArchiveConfigSchema.safeParse({ ...archive, mode: 'unknown' }).success).toBe(false);
    expect(
      LogArchiveConfigSchema.safeParse({ ...archive, activatedAt: '2026-10-27T00:00:00Z' }).success
    ).toBe(false);
    config.features.r2.enabled = false;
    expect(() => parseConfig(config)).toThrow('requires R2');
  });

  it('requires durable queues for pipeline mode and no DB retention field', () => {
    const archive = createLogArchiveConfig('demo', 'pipeline');
    const config = createDefaultConfig('demo');
    config.logging = { archive };
    expect(() => parseConfig(config)).toThrow('durable');
    config.features.queue.enabled = true;
    expect(parseConfig(config).logging!.archive).toEqual(archive);
    expect(LogArchiveConfigSchema.safeParse({ ...archive, dbRetentionDays: 7 }).success).toBe(
      false
    );
  });

  it('does not activate a table which already contains snapshots', async () => {
    implemented.push('scheduled');
    const f = fixture('scheduled');
    f.metadata['current-snapshot-id'] = 1;
    await expect(provisionLogArchive(f.options)).rejects.toThrow('initial_table_not_empty');
  });

  it('rejects an owned table response redirected to a different bucket', async () => {
    implemented.push('scheduled');
    const f = fixture('scheduled');
    f.metadata.location = 's3://foreign-bucket/authrim/table';
    await expect(provisionLogArchive(f.options)).rejects.toThrow('location');
  });

  it('rejects mode omission on single-worker deploys before a provider operation', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.test-log-setup-'));
    directories.push(directory);
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(directory, 'packages/ar-auth'), { recursive: true });
    await writeFile(join(directory, 'packages/ar-auth/wrangler.toml'), 'name = "demo-ar-auth"\n');
    const options = { rootDir: directory, env: 'demo', dryRun: true };
    await expect(deployWorker('ar-auth', options)).rejects.toThrow('mode_required');
    await expect(deployWorkerGradually('ar-auth', options, { stages: [100] })).rejects.toThrow(
      'mode_required'
    );
  });

  it('plans scheduled resources without a hidden Pipeline, network request or secret', () => {
    const plan = planLogArchive('demo', createLogArchiveConfig('demo', 'scheduled'));
    expect(plan.resources.map((resource) => resource.kind)).toEqual(['r2', 'catalog']);
    expect(plan.streamBody).toBeUndefined();
    expect(plan.schemaDigest).toBe(LOG_ARCHIVE_SCHEMA_DIGEST);
    expect(JSON.stringify(plan)).not.toContain(tokenWrite);
  });

  it('stops unsupported modes before any provider request', async () => {
    const f = fixture('pipeline');
    await expect(provisionLogArchive(f.options)).rejects.toThrow('not_implemented');
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.assertBucketOwned).not.toHaveBeenCalled();
    const config = createDefaultConfig('demo');
    config.logging = { archive: f.archive };
    expect(() => generateWranglerConfig('ar-auth', config, { d1: {}, kv: {} })).toThrow(
      'not_implemented'
    );
  });

  it('creates private structured ingestion and resumes by immutable IDs without duplicate creates', async () => {
    implemented.push('pipeline');
    const f = fixture('pipeline');
    const result = await provisionLogArchive(f.options);
    expect(result.mode).toBe('pipeline');
    expect(result.stream?.id).toBe('streams-id');
    const stream = f.calls.find(
      (call) => call.method === 'POST' && call.path.endsWith('/streams')
    )!.body!;
    expect(stream.http).toEqual({ enabled: false, authentication: true });
    expect(stream.worker_binding).toEqual({ enabled: true });
    const sink = f.calls.find(
      (call) => call.method === 'POST' && call.path.endsWith('/sinks')
    )!.body!;
    expect(sink.format).toEqual({ type: 'parquet', compression: 'zstd' });
    expect(sink.type).toBe('r2_data_catalog');
    expect(JSON.stringify(result)).not.toContain(tokenWrite);
    expect(JSON.stringify(f.checkpoints)).not.toContain(tokenWrite);
    expect(JSON.stringify(f.checkpoints)).not.toContain(tokenSink);
    const checkpoints = structuredClone(f.checkpoints);
    expect(checkpoints['sink:LOG_ARCHIVE_SINK'].configurationDigest).toMatch(/^[a-f0-9]{64}$/u);
    const creates = f.calls.filter((call) => call.method === 'POST').length;
    await expect(provisionLogArchive(f.options)).resolves.toMatchObject({
      ...result,
      activation: { ...result.activation, checkedAt: expect.any(String) },
    });
    expect(f.checkpoints).toEqual(checkpoints);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(creates);
    expect(f.prepareScheduledTable).not.toHaveBeenCalled();
  });

  it('creates scheduled tables using the direct writer and never calls the Pipeline API', async () => {
    implemented.push('scheduled');
    const f = fixture('scheduled');
    const result = await provisionLogArchive(f.options);
    expect(result.stream).toBeUndefined();
    expect(f.prepareScheduledTable).toHaveBeenCalledExactlyOnceWith({
      catalogUri: `https://catalog.cloudflarestorage.com/${accountId}/demo-log-archive`,
      warehouse: `${accountId}_demo-log-archive`,
    });
    expect(f.calls.some((call) => call.path.startsWith('pipelines/'))).toBe(false);
    expect(f.calls.some((call) => call.path === 'subscriptions')).toBe(false);
  });

  it('rejects an existing unowned Stream and an ambiguous create checkpoint', async () => {
    implemented.push('pipeline');
    const f = fixture('pipeline');
    const stream = planLogArchive('demo', f.archive).resources.find(
      (resource) => resource.kind === 'stream'
    )!;
    f.remote.set('pipelines/v1/streams/foreign', { id: 'foreign', name: stream.name });
    await expect(provisionLogArchive(f.options)).rejects.toThrow('without_ownership');
    expect(f.calls.some((call) => call.method === 'POST' && call.path.endsWith('/streams'))).toBe(
      false
    );
    f.checkpoints['stream:LOG_ARCHIVE_STREAM'] = { ...stream, state: 'create_issued' };
    await expect(provisionLogArchive(f.options)).rejects.toThrow('checkpoint_identity_changed');
  });

  it('rejects mutated schemas on resume before a new mutation', async () => {
    implemented.push('pipeline');
    const f = fixture('pipeline');
    await provisionLogArchive(f.options);
    f.remote.get('pipelines/v1/streams/streams-id')!.schema = { fields: [] };
    const before = f.calls.filter((call) => call.method === 'POST').length;
    await expect(provisionLogArchive(f.options)).rejects.toThrow('schema_or_ingress');
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(before);
  });

  it('preflights all deletion identities before deleting and supports retrying an interrupted deletion', async () => {
    implemented.push('pipeline');
    const f = fixture('pipeline');
    const result = await provisionLogArchive(f.options);
    f.remote.get('pipelines/v1/sinks/sinks-id')!.name = 'foreign';
    await expect(prepareLogArchiveDeletion(result, f.options.api)).rejects.toThrow(
      'ownership_mismatch'
    );
    expect(f.calls.some((call) => call.method === 'DELETE')).toBe(false);
    f.remote.get('pipelines/v1/sinks/sinks-id')!.name = result.sink!.name;
    const action = await prepareLogArchiveDeletion(result, f.options.api);
    await action();
    expect(
      f.calls.filter((call) => call.method === 'DELETE').map((call) => call.path.split('/')[2])
    ).toEqual(['pipelines', 'sinks', 'streams']);
    await expect(
      (await prepareLogArchiveDeletion(result, f.options.api))()
    ).resolves.toBeUndefined();
  });

  it('does not judge the plan beforehand, and refuses insufficient credential permissions without resource mutations', async () => {
    implemented.push('pipeline');
    // Whatever billing says, or fails to say, setup does not look at it: Cloudflare decides.
    for (const override of [
      { result: [] },
      { result: [{ rate_plan: { id: 'r2_paid' }, state: 'Paid' }] },
      { status: 403 },
      { status: 401 },
      { status: 500 },
    ]) {
      const f = fixture('pipeline');
      f.overrides.set('subscriptions', override);
      await expect(preflightLogArchive(f.options)).resolves.toBeUndefined();
      expect(f.calls.some((call) => call.path === 'subscriptions')).toBe(false);
    }
    const denied = fixture('pipeline');
    denied.overrides.set('tokens/permission_groups?scope=com.cloudflare.api.account', {
      status: 403,
    });
    await expect(provisionLogArchive(denied.options)).rejects.toThrow('permission_or_subscription');
    expect(denied.calls.some((call) => call.method !== 'GET')).toBe(false);
    const broad = fixture('pipeline');
    broad.overrides.set('tokens/read-id', {
      result: {
        policies: [
          {
            effect: 'allow',
            resources: { [`com.cloudflare.api.account.${accountId}`]: '*' },
            permission_groups: [{ id: 'catalog-read' }, { id: 'sql-read' }, { id: 'r2-write' }],
          },
        ],
      },
    });
    await expect(provisionLogArchive(broad.options)).rejects.toThrow('not_read_only');
    expect(broad.calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  it('can confirm token activity without reading token policies the login cannot inspect', async () => {
    const f = fixture('scheduled');
    f.overrides.set('tokens/permission_groups?scope=com.cloudflare.api.account', { status: 403 });
    f.overrides.set('tokens/read-id', { status: 403 });
    f.overrides.set('tokens/write-id', { status: 403 });
    await expect(
      f.options.api.verifyCatalogCredentials(tokenRead, tokenWrite, undefined, {
        inspectPolicies: false,
      })
    ).resolves.toBeUndefined();
    expect(f.calls.map((call) => call.path)).toEqual(['tokens/verify', 'tokens/verify']);
    await expect(f.options.api.verifyCatalogCredentials(tokenRead, tokenWrite)).rejects.toThrow(
      'permission_or_subscription'
    );
    await expect(
      f.options.api.verifyCatalogCredentials(tokenRead, tokenRead, undefined, {
        inspectPolicies: false,
      })
    ).rejects.toThrow('distinct_catalog_token_ids');
  });

  it('skips the policy read in deploy preflight only for tokens Setup issued for this account', async () => {
    implemented.push('scheduled');
    const f = fixture('scheduled');
    f.overrides.set('tokens/permission_groups?scope=com.cloudflare.api.account', { status: 403 });
    await expect(preflightLogArchive(f.options)).rejects.toThrow('permission_or_subscription');
    await expect(
      preflightLogArchive({ ...f.options, catalogPolicyVerified: true })
    ).resolves.toBeUndefined();
    // The issuance evidence, not the caller's say-so, decides who may skip.
    const directory = await mkdtemp(join(process.cwd(), '.test-log-setup-'));
    directories.push(directory);
    const secrets = { readToken: tokenRead, writeToken: tokenWrite };
    expect(await loadIssuedLogArchiveAccountId(directory, 'demo', 'scheduled')).toBeUndefined();
    await stageLogArchiveSecrets(directory, 'demo', secrets, { accountId, mode: 'scheduled' });
    expect(await loadIssuedLogArchiveAccountId(directory, 'demo', 'scheduled')).toBeUndefined();
    await stageLogArchiveSecrets(directory, 'demo', secrets, {
      accountId,
      mode: 'scheduled',
      issuance: {
        readTokenId: '2'.repeat(32),
        writeTokenId: '3'.repeat(32),
        bootstrapTokenId: 'b'.repeat(32),
        bootstrapTokenFingerprint: 'f'.repeat(64),
      },
    });
    expect(await loadIssuedLogArchiveAccountId(directory, 'demo', 'scheduled')).toBe(accountId);
    expect(await loadIssuedLogArchiveAccountId(directory, 'demo', 'pipeline')).toBeUndefined();
    vi.stubEnv('LOG_ARCHIVE_CATALOG_READ_TOKEN', 'override-read');
    expect(await loadIssuedLogArchiveAccountId(directory, 'demo', 'scheduled')).toBeUndefined();
    vi.unstubAllEnvs();
    await writeFile(
      join(directory, '.authrim/demo/pending-log-archive-secrets.json'),
      JSON.stringify({ readToken: 'swapped', writeToken: tokenWrite }),
      { mode: 0o600 }
    );
    expect(await loadIssuedLogArchiveAccountId(directory, 'demo', 'scheduled')).toBeUndefined();
  });

  describe('a refusal says which step Cloudflare refused and what it said', () => {
    const refusal = async (
      path: string,
      override: { status?: number; errors?: unknown; raw?: string },
      method = 'GET'
    ) => {
      const f = fixture('pipeline');
      f.overrides.set(path, { status: 403, ...override });
      return f.options.api.request(path, method, method === 'GET' ? undefined : {}).then(
        () => {
          throw new Error('expected a refusal');
        },
        (error: unknown) => error as LogArchiveApiError
      );
    };

    it('names the step, the HTTP status and Cloudflare’s code and message', async () => {
      const error = await refusal(
        'pipelines/v1/streams',
        {
          errors: [{ code: 1234, message: 'Workers Paid plan is required' }],
        },
        'POST'
      );
      expect(error.code).toBe('log_archive_permission_or_subscription_required');
      expect(error.status).toBe(403);
      expect(error.message).toContain('log_archive_permission_or_subscription_required');
      expect(error.message).toContain('step pipeline_stream');
      expect(error.message).toContain('HTTP 403');
      expect(error.message).toContain('code 1234: Workers Paid plan is required');
    });

    it('tells the steps apart', async () => {
      const step = async (path: string, method = 'GET') =>
        (await refusal(path, { errors: [{ code: 10000 }] }, method)).detail?.step;
      expect(await step('tokens/verify')).toBe('token_verify');
      expect(await step('tokens/permission_groups?scope=x')).toBe('token_permission_groups');
      expect(await step('tokens/read-id')).toBe('token_policy_read');
      expect(await step('basin-catalog/bucket')).toBe('catalog_read');
      expect(await step('basin-catalog/bucket/enable', 'POST')).toBe('catalog_enable');
      expect(await step('basin-catalog/bucket/namespaces/n/tables/t/maintenance-configs')).toBe(
        'table_maintenance'
      );
      expect(await step('pipelines/v1/sinks', 'POST')).toBe('pipeline_sink');
      expect(await step('pipelines/v1/pipelines', 'POST')).toBe('pipeline_pipeline');
    });

    it('keeps the code but not the text for the step that carries a credential', async () => {
      const error = await refusal(
        'pipelines/v1/sinks',
        {
          errors: [{ code: 7003, message: `bad token ${tokenWrite}` }],
        },
        'POST'
      );
      expect(error.message).toContain('code 7003');
      expect(error.message).not.toContain('bad token');
      expect(error.message).not.toContain(tokenWrite);
    });

    it('redacts token-like runs and bounds the text of other steps', async () => {
      const error = await refusal(
        'basin-catalog/bucket/enable',
        {
          errors: [
            { code: 1, message: `token ${'A'.repeat(40)} is not allowed\n${'x '.repeat(300)}` },
          ],
        },
        'POST'
      );
      expect(error.message).toContain('[redacted]');
      expect(error.message).not.toContain('A'.repeat(24));
      expect(error.message).not.toContain('\n');
      expect(error.message.length).toBeLessThan(400);
    });

    it('removes the request’s own credentials whatever their length or alphabet', async () => {
      // Short, and base64 with `+ / =`: neither looks like the long runs the patterns catch.
      const f = fixture('pipeline');
      const short = 'abc123';
      const base64ish = 'Abc+/0123=';
      const api = new LogArchiveApi(accountId, short, f.fetcher);
      f.overrides.set('pipelines/v1/streams', {
        status: 403,
        errors: [{ code: 1, message: `rejected ${short} and ${base64ish} for a${short}b` }],
      });
      const error = await api
        .request('pipelines/v1/streams', 'POST', { config: { token: base64ish } })
        .catch((reason: unknown) => reason as LogArchiveApiError);
      expect(error.message).toContain('[redacted]');
      expect(error.message).not.toContain(short);
      expect(error.message).not.toContain(base64ish);
    });

    it('drops the message when a credential is split by whitespace, and keeps one that is whole', async () => {
      const f = fixture('pipeline');
      const secret = 'abc123XYZ789';
      const api = new LogArchiveApi(accountId, secret, f.fetcher);
      const refuse = async (message: string) => {
        f.overrides.set('basin-catalog/bucket', { status: 403, errors: [{ code: 5, message }] });
        return (await api.request('basin-catalog/bucket').catch((e: unknown) => e)) as Error;
      };
      for (const message of [
        `bad ${secret.slice(0, 6)}\n${secret.slice(6)}`,
        `bad ${secret.slice(0, 6)}  ${secret.slice(6)}`,
      ]) {
        const error = await refuse(message);
        expect(error.message).toContain('code 5');
        expect(error.message).not.toContain('bad');
        expect(error.message).not.toContain('abc123');
        expect(error.message).not.toContain('XYZ789');
      }
      const whole = await refuse(`bad ${secret} here`);
      expect(whole.message).toContain('bad [redacted] here');
    });

    it('finds a split credential even when a shorter credential sits inside it', async () => {
      const f = fixture('pipeline');
      const api = new LogArchiveApi(accountId, 'abc123', f.fetcher);
      f.overrides.set('tokens/verify', {
        status: 403,
        errors: [{ code: 5, message: 'bad abc123\nXYZ789 here' }],
      });
      const error = (await api
        .request('tokens/verify', 'GET', undefined, 'abc123XYZ789')
        .catch((e: unknown) => e)) as Error;
      expect(error.message).toContain('code 5');
      expect(error.message).not.toContain('XYZ789');
      expect(error.message).not.toContain('bad');
      // The same with a one-character credential inside the longer one.
      const tiny = new LogArchiveApi(accountId, 'a', f.fetcher);
      const other = (await tiny
        .request('tokens/verify', 'GET', undefined, 'abc123XYZ789')
        .catch((e: unknown) => e)) as Error;
      expect(other.message).not.toContain('XYZ789');
    });

    it('drops the message when any copy of a credential is split, even if another is whole', async () => {
      const secret = 'abc123XYZ789';
      const f = fixture('pipeline');
      const api = new LogArchiveApi(accountId, secret, f.fetcher);
      const refuse = async (message: string) => {
        f.overrides.set('basin-catalog/bucket', { status: 403, errors: [{ code: 5, message }] });
        return (await api.request('basin-catalog/bucket').catch((e: unknown) => e)) as Error;
      };
      const mixed = await refuse(`first ${secret} then abc123\nXYZ789 again`);
      expect(mixed.message).toContain('code 5');
      expect(mixed.message).not.toContain('first');
      expect(mixed.message).not.toContain('XYZ789');
      // Separators other than whitespace, and zero-width or control characters.
      for (const message of [
        'bad abc123-.-XYZ789',
        'bad abc123, XYZ789',
        'bad abc123\u200bXYZ789',
        'bad abc123\u0000XYZ789',
        'bad abc\u200b123XYZ789',
      ]) {
        const error = await refuse(message);
        expect(error.message).toContain('code 5');
        expect(error.message).not.toContain('bad');
        expect(error.message).not.toContain('XYZ789');
      }
      // A whole copy alone is redacted, and the rest of the message is kept.
      expect((await refuse(`ok ${secret} and ${secret}`)).message).toContain(
        'ok [redacted] and [redacted]'
      );
    });

    it('drops a message that carries control or zero-width characters even with no credential', async () => {
      const error = await refusal('basin-catalog/bucket', {
        errors: [{ code: 6, message: 'looks\u200bfine' }],
      });
      expect(error.message).toContain('code 6');
      expect(error.message).not.toContain('looks');
    });

    it('finds split credentials that have no letters or digits', async () => {
      const f = fixture('pipeline');
      const refuse = async (credential: string, message: string) => {
        const api = new LogArchiveApi(accountId, credential, f.fetcher);
        f.overrides.set('basin-catalog/bucket', { status: 403, errors: [{ code: 5, message }] });
        return (await api.request('basin-catalog/bucket').catch((e: unknown) => e)) as Error;
      };
      for (const [credential, message] of [
        ['+/=+/=', 'bad +/ =+ /='],
        ['秘密鍵', 'bad 秘 密 鍵'],
        ['秘密鍵', 'bad 秘\n密鍵'],
      ]) {
        const error = await refuse(credential, message);
        expect(error.message).toContain('code 5');
        expect(error.message).not.toContain('bad');
      }
      // Whole, they are replaced and the rest of the message is kept.
      expect((await refuse('秘密鍵', 'bad 秘密鍵 here')).message).toContain('bad [redacted] here');
      expect((await refuse('+/=+/=', 'bad +/=+/= here')).message).toContain('bad [redacted] here');
    });

    it('drops the message when a replacement would join its neighbours into a credential', async () => {
      const f = fixture('pipeline');
      const api = new LogArchiveApi(accountId, 'abc123', f.fetcher);
      f.overrides.set('tokens/verify', {
        status: 403,
        errors: [{ code: 5, message: 'bad prefixabc123suffix here' }],
      });
      // `prefix[redacted]suffix` is not a credential, but with the sink-style token below it would
      // be: the second credential is what the joined text spells once the first is replaced.
      const error = (await api
        .request('tokens/verify', 'GET', undefined, 'prefix[redacted]suffix')
        .catch((e: unknown) => e)) as Error;
      expect(error.message).toContain('code 5');
      expect(error.message).not.toContain('prefix');
      expect(error.message).not.toContain('bad');
    });

    it('shows Cloudflare’s text only for steps that are listed as safe', async () => {
      // A step that is not recognised shows codes only, as does the sink.
      const unknown = await refusal('some/new/endpoint', {
        errors: [{ code: 9, message: 'detail' }],
      });
      expect(unknown.message).toContain('step cloudflare_api');
      expect(unknown.message).toContain('code 9');
      expect(unknown.message).not.toContain('detail');
      const listed = await refusal('basin-catalog/bucket', {
        errors: [{ code: 9, message: 'detail' }],
      });
      expect(listed.message).toContain('code 9: detail');
    });

    it('removes bearer values and JWT-shaped values, however short their segments', async () => {
      const error = await refusal('tokens/verify', {
        errors: [{ code: 1, message: 'bad Authorization: Bearer s3cret and eyJh.eyJz.sig' }],
      });
      expect(error.message).not.toContain('s3cret');
      expect(error.message).not.toContain('eyJh.eyJz.sig');
      expect(error.message).toContain('Bearer [redacted]');
    });

    it('drops a very long message whole, quickly, and keeps the code', async () => {
      const started = performance.now();
      const error = await refusal(
        'pipelines/v1/streams',
        {
          errors: [{ code: 77, message: 'X'.repeat(200_000) }],
        },
        'POST'
      );
      expect(performance.now() - started).toBeLessThan(1000);
      expect(error.message).toContain('code 77');
      expect(error.message).not.toContain('XXXX');
      // A message at the limit is still read and redacted.
      const bounded = await refusal(
        'pipelines/v1/streams',
        {
          errors: [{ code: 78, message: `denied ${'Y'.repeat(30)}` }],
        },
        'POST'
      );
      expect(bounded.message).toContain('denied [redacted]');
    });

    it('treats a body that is not an object as a refusal with no details', async () => {
      for (const raw of ['null', '"nope"', '7', '[]']) {
        const error = await refusal('pipelines/v1/streams', { raw }, 'POST');
        expect(error).toBeInstanceOf(LogArchiveApiError);
        expect(error.code).toBe('log_archive_permission_or_subscription_required');
        expect(error.message).toContain('step pipeline_stream, HTTP 403');
      }
    });

    it('still names the step when Cloudflare sent no usable body or errors', async () => {
      const noErrors = await refusal('pipelines/v1/streams', {}, 'POST');
      expect(noErrors.message).toContain('step pipeline_stream, HTTP 403');
      expect(noErrors.message).not.toContain('Cloudflare:');
      const garbage = await refusal('pipelines/v1/streams', { raw: '<html>', status: 502 }, 'POST');
      expect(garbage.code).toBe('log_archive_cloudflare_response_invalid');
      expect(garbage.message).toContain('step pipeline_stream');
      const malformed = await refusal(
        'pipelines/v1/streams',
        {
          errors: [null, 'x', { code: 'nope', message: 5 }],
        },
        'POST'
      );
      expect(malformed.message).toContain('step pipeline_stream, HTTP 403');
    });

    it('keeps a 404 as the plain resource-not-found signal that callers branch on', async () => {
      const f = fixture('pipeline');
      f.overrides.set('basin-catalog/bucket', { status: 404 });
      await expect(f.options.api.request('basin-catalog/bucket')).rejects.toMatchObject({
        status: 404,
        code: 'log_archive_resource_not_found',
        message: 'log_archive_resource_not_found',
      });
    });
  });

  it('records a definite Catalog rejection so permission repair can resume the same owned plan', async () => {
    implemented.push('scheduled');
    const f = fixture('scheduled');
    const path = `basin-catalog/${f.archive.bucketName}/enable`;
    f.overrides.set(path, { status: 403 });
    await expect(provisionLogArchive(f.options)).rejects.toThrow('permission_or_subscription');
    expect(f.checkpoints['catalog:LOG_ARCHIVE_CATALOG'].state).toBe('create_rejected');
    f.overrides.delete(path);
    await expect(provisionLogArchive(f.options)).resolves.toMatchObject({ mode: 'scheduled' });
  });

  it('removes a Catalog left by an earlier bucket of the same name and enables a new one', async () => {
    implemented.push('scheduled');
    const f = fixture('scheduled');
    const catalogPath = `basin-catalog/${f.archive.bucketName}`;
    f.remote.set(catalogPath, {
      id: 'old-catalog-id',
      name: `${accountId}_${f.archive.bucketName}`,
      status: 'active',
    });
    f.staleEntries.namespaces = [
      { name: ['authrim'], createdAt: '2026-10-31T11:59:19.573666+00:00' },
      { name: ['authrim', 'nested'], createdAt: '2026-10-31T12:00:00+00:00' },
    ];
    f.staleEntries.tables = {
      authrim: [
        {
          name: 'logs_v1_old',
          createdAt: '2026-10-31T11:59:20.254561+00:00',
          updatedAt: '2026-10-31T16:41:58.433576+00:00',
        },
      ],
    };
    await expect(provisionLogArchive(f.options)).resolves.toMatchObject({
      mode: 'scheduled',
      catalog: { id: 'catalog-id' },
    });
    const posts = f.calls
      .filter((call) => call.method === 'POST' && call.path.startsWith(catalogPath))
      .map((call) => call.path.slice(catalogPath.length));
    expect(posts.slice(0, 3)).toEqual(['/disable', '/delete?force=true', '/enable']);
    expect(
      f.calls.some((call) => call.path.startsWith(`${catalogPath}/namespaces/authrim%1Fnested/`))
    ).toBe(true);
    expect(f.checkpoints['catalog:LOG_ARCHIVE_CATALOG']).toMatchObject({
      id: 'catalog-id',
      state: 'created',
    });
  });

  it('leaves an unrecorded Catalog untouched unless every entry predates the owned bucket', async () => {
    implemented.push('scheduled');
    const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => {
        f.staleEntries.namespaces = [{ name: ['authrim'], createdAt: '2026-11-08T02:00:00Z' }];
      },
      (f) => {
        f.staleEntries.namespaces = [{ name: ['authrim'], createdAt: '2026-10-31T00:00:00Z' }];
        f.staleEntries.tables = {
          authrim: [
            { name: 't', createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-11-08T02:00:00Z' },
          ],
        };
      },
      (f) => {
        f.options.bucketCreationDate = undefined;
      },
      (f) => {
        f.staleEntries.namespaces = [{ name: ['authrim'], createdAt: '0' }];
      },
      (f) => {
        f.staleEntries.namespaces = [{ name: ['authrim'], createdAt: '2026-10-31T00:00:00Z' }];
        f.overrides.set(
          `basin-catalog/${f.archive.bucketName}/namespaces/authrim/tables?page_size=1000&return_details=true`,
          {
            result: {
              identifiers: [{ namespace: ['authrim'], name: 'new_table' }],
              details: [
                {
                  identifier: { namespace: ['authrim'], name: 'old_table' },
                  created_at: '2026-10-31T00:00:00Z',
                  updated_at: '2026-10-31T00:00:00Z',
                },
              ],
            },
          }
        );
      },
      (f) => {
        f.overrides.set(
          `basin-catalog/${f.archive.bucketName}/namespaces?page_size=1000&return_details=true`,
          { result: { namespaces: [['authrim']] } }
        );
      },
    ];
    for (const prepare of cases) {
      const f = fixture('scheduled');
      f.remote.set(`basin-catalog/${f.archive.bucketName}`, {
        id: 'foreign',
        name: `${accountId}_${f.archive.bucketName}`,
        status: 'active',
      });
      prepare(f);
      await expect(provisionLogArchive(f.options)).rejects.toThrow(
        'log_archive_catalog_ownership_unproven'
      );
      expect(f.calls.some((call) => call.method === 'POST')).toBe(false);
    }
  });

  it('re-enables a disabled leftover Catalog only to inventory it, then removes it', async () => {
    implemented.push('scheduled');
    const f = fixture('scheduled');
    const catalogPath = `basin-catalog/${f.archive.bucketName}`;
    f.remote.set(catalogPath, {
      id: 'old-catalog-id',
      name: `${accountId}_${f.archive.bucketName}`,
      status: 'inactive',
    });
    f.staleEntries.namespaces = [{ name: ['authrim'], createdAt: '2026-10-31T00:00:00Z' }];
    await expect(provisionLogArchive(f.options)).resolves.toMatchObject({
      catalog: { id: 'catalog-id' },
    });
    const posts = f.calls
      .filter((call) => call.method === 'POST' && call.path.startsWith(catalogPath))
      .map((call) => call.path.slice(catalogPath.length));
    expect(posts.slice(0, 4)).toEqual(['/enable', '/disable', '/delete?force=true', '/enable']);
  });

  it('treats a 200 answer with status inactive like a 40402 disabled Catalog', async () => {
    implemented.push('scheduled');
    const f = fixture('scheduled');
    const catalogPath = `basin-catalog/${f.archive.bucketName}`;
    f.remote.set(catalogPath, {
      id: 'old-catalog-id',
      name: `${accountId}_${f.archive.bucketName}`,
      status: 'inactive',
    });
    f.staleEntries.namespaces = [{ name: ['authrim'], createdAt: '2026-10-31T00:00:00Z' }];
    f.overrides.set(catalogPath, { result: { ...f.remote.get(catalogPath)! } });
    const enable = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      // Only the first read sees the 200 + inactive form; later reads follow the remote state.
      if (String(url).endsWith(`/${catalogPath}/enable`)) f.overrides.delete(catalogPath);
      return enable(url, init);
    });
    await expect(provisionLogArchive(f.options)).resolves.toMatchObject({
      catalog: { id: 'catalog-id' },
    });
    const posts = f.calls
      .filter((call) => call.method === 'POST' && call.path.startsWith(catalogPath))
      .map((call) => call.path.slice(catalogPath.length));
    expect(posts.slice(0, 4)).toEqual(['/enable', '/disable', '/delete?force=true', '/enable']);
    expect(
      f.calls.findIndex((call) => call.path.startsWith(`${catalogPath}/namespaces`))
    ).toBeGreaterThan(f.calls.findIndex((call) => call.path === `${catalogPath}/enable`));
  });

  it('accepts a 204 disable answer only once the catalog reads back named, inactive and the same', async () => {
    implemented.push('scheduled');
    const seed = (f: ReturnType<typeof fixture>) => {
      f.remote.set(`basin-catalog/${f.archive.bucketName}`, {
        id: 'old-catalog-id',
        name: `${accountId}_${f.archive.bucketName}`,
        status: 'active',
      });
      f.staleEntries.namespaces = [{ name: ['authrim'], createdAt: '2026-10-31T00:00:00Z' }];
      const original = f.fetcher.getMockImplementation()!;
      f.fetcher.mockImplementation(async (url, init) => {
        const response = await original(url, init);
        // Cloudflare may answer the disable with 204 and no body.
        return String(url).endsWith('/disable') ? new Response(null, { status: 204 }) : response;
      });
      return original;
    };
    const namedReadBack = (f: ReturnType<typeof fixture>) => {
      const original = f.fetcher.getMockImplementation()!;
      const catalogPath = `basin-catalog/${f.archive.bucketName}`;
      f.fetcher.mockImplementation(async (url, init) => {
        const response = await original(url, init);
        const remote = f.remote.get(catalogPath);
        // The 200 form of an inactive catalog, which still names it.
        if (
          String(url).endsWith(`/${catalogPath}`) &&
          (init?.method ?? 'GET') === 'GET' &&
          remote?.status === 'inactive'
        )
          return new Response(JSON.stringify({ success: true, result: { ...remote } }), {
            status: 200,
          });
        return response;
      });
    };
    const ok = fixture('scheduled');
    seed(ok);
    namedReadBack(ok);
    await expect(provisionLogArchive(ok.options)).resolves.toMatchObject({
      catalog: { id: 'catalog-id' },
    });
    expect(ok.calls.some((call) => call.path.endsWith('/delete?force=true'))).toBe(true);
    // The 40402 read-back names no catalog: it proves nothing, so nothing is deleted.
    const unnamed = fixture('scheduled');
    seed(unnamed);
    await expect(provisionLogArchive(unnamed.options)).rejects.toThrow(
      'log_archive_catalog_ownership_unproven'
    );
    expect(unnamed.calls.some((call) => call.path.includes('/delete'))).toBe(false);
    const swapped = fixture('scheduled');
    const original = seed(swapped);
    const catalogPath = `basin-catalog/${swapped.archive.bucketName}`;
    let disabledOnce = false;
    swapped.fetcher.mockImplementation(async (url, init) => {
      if (
        disabledOnce &&
        String(url).endsWith(`/${catalogPath}`) &&
        (init?.method ?? 'GET') === 'GET'
      )
        // The 200 form of an inactive catalog, now naming a different catalog.
        return new Response(
          JSON.stringify({
            success: true,
            result: { ...swapped.remote.get(catalogPath)!, id: 'someone-else' },
          }),
          { status: 200 }
        );
      const response = await original(url, init);
      if (!String(url).endsWith('/disable')) return response;
      disabledOnce = true;
      return new Response(null, { status: 204 });
    });
    await expect(provisionLogArchive(swapped.options)).rejects.toThrow(
      'log_archive_catalog_ownership_unproven'
    );
    expect(swapped.calls.some((call) => call.path.includes('/delete'))).toBe(false);
  });

  it('puts a disabled unrecorded Catalog back when its entries are not all older', async () => {
    implemented.push('scheduled');
    const f = fixture('scheduled');
    const catalogPath = `basin-catalog/${f.archive.bucketName}`;
    f.remote.set(catalogPath, {
      id: 'foreign',
      name: `${accountId}_${f.archive.bucketName}`,
      status: 'inactive',
    });
    f.staleEntries.namespaces = [{ name: ['authrim'], createdAt: '2026-11-08T02:00:00Z' }];
    await expect(provisionLogArchive(f.options)).rejects.toThrow(
      'log_archive_catalog_ownership_unproven'
    );
    expect(f.remote.get(catalogPath)).toMatchObject({ id: 'foreign', status: 'inactive' });
    expect(f.calls.some((call) => call.path.includes('/delete'))).toBe(false);
    expect(f.checkpoints['catalog:LOG_ARCHIVE_CATALOG']).toBeUndefined();
  });

  it('puts a disabled leftover back when the inventory enable answer is lost', async () => {
    implemented.push('scheduled');
    const f = fixture('scheduled');
    const catalogPath = `basin-catalog/${f.archive.bucketName}`;
    f.remote.set(catalogPath, {
      id: 'foreign',
      name: `${accountId}_${f.archive.bucketName}`,
      status: 'inactive',
    });
    f.loseResponse.add(`${catalogPath}/enable`);
    await expect(provisionLogArchive(f.options)).rejects.toThrow('response loss');
    expect(f.remote.get(catalogPath)).toMatchObject({ id: 'foreign', status: 'inactive' });
    expect(f.calls.some((call) => call.path.includes('/delete'))).toBe(false);
    f.loseResponse.clear();
    f.staleEntries.namespaces = [{ name: ['authrim'], createdAt: '2026-11-08T02:00:00Z' }];
    f.overrides.set(`${catalogPath}/disable`, { status: 503 });
    await expect(provisionLogArchive(f.options)).rejects.toThrow(
      'log_archive_catalog_restore_failed_disable_it_manually'
    );
    expect(f.calls.some((call) => call.path.includes('/delete'))).toBe(false);
  });

  it('never force-deletes without a matching disable answer or a known catalog state', async () => {
    implemented.push('scheduled');
    const seed = (f: ReturnType<typeof fixture>) =>
      f.remote.set(`basin-catalog/${f.archive.bucketName}`, {
        id: 'old',
        name: `${accountId}_${f.archive.bucketName}`,
        status: 'active',
      });
    const noId = fixture('scheduled');
    seed(noId);
    noId.overrides.set(`basin-catalog/${noId.archive.bucketName}/disable`, { result: {} });
    await expect(provisionLogArchive(noId.options)).rejects.toThrow(
      'log_archive_catalog_ownership_unproven'
    );
    expect(noId.calls.some((call) => call.path.includes('/delete'))).toBe(false);
    const unknown = fixture('scheduled');
    unknown.overrides.set(`basin-catalog/${unknown.archive.bucketName}`, {
      status: 404,
      errors: [{ code: 40499 }],
    });
    await expect(provisionLogArchive(unknown.options)).rejects.toThrow(
      'log_archive_catalog_state_unknown'
    );
    expect(unknown.calls.some((call) => call.method === 'POST')).toBe(false);
    const calendar = fixture('scheduled');
    seed(calendar);
    calendar.staleEntries.namespaces = [{ name: ['authrim'], createdAt: '2026-02-30T00:00:00Z' }];
    await expect(provisionLogArchive(calendar.options)).rejects.toThrow(
      'log_archive_catalog_ownership_unproven'
    );
    expect(calendar.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('replaces an empty unrecorded Catalog, which holds no table to lose', async () => {
    implemented.push('scheduled');
    const f = fixture('scheduled');
    f.remote.set(`basin-catalog/${f.archive.bucketName}`, {
      id: 'empty',
      name: `${accountId}_${f.archive.bucketName}`,
      status: 'active',
    });
    await expect(provisionLogArchive(f.options)).resolves.toMatchObject({
      catalog: { id: 'catalog-id' },
    });
  });

  it('still refuses a recorded Catalog that changed, and a lost enable response', async () => {
    implemented.push('scheduled');
    const disabled = fixture('scheduled');
    await provisionLogArchive(disabled.options);
    disabled.remote.get(`basin-catalog/${disabled.archive.bucketName}`)!.status = 'inactive';
    const posts = disabled.calls.filter((call) => call.method === 'POST').length;
    await expect(provisionLogArchive(disabled.options)).rejects.toThrow(
      'log_archive_recorded_catalog_inactive'
    );
    expect(disabled.calls.filter((call) => call.method === 'POST')).toHaveLength(posts);
    const lost = fixture('scheduled');
    const identity = planLogArchive('demo', lost.archive).resources.find(
      (resource) => resource.kind === 'catalog'
    )!;
    lost.checkpoints['catalog:LOG_ARCHIVE_CATALOG'] = { ...identity, state: 'create_issued' };
    lost.remote.set(`basin-catalog/${lost.archive.bucketName}`, {
      id: 'catalog-id',
      name: `${accountId}_${lost.archive.bucketName}`,
      status: 'active',
    });
    await expect(provisionLogArchive(lost.options)).rejects.toThrow(
      'log_archive_catalog_ownership_unproven'
    );
    expect(lost.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('keeps draft secret recipients minimal until the archive path is selected', () => {
    expect(getSecretNamesForWorker('ar-policy')).not.toContain('OBJECT_ENCRYPTION_ROOT_KEY');
    expect(getSecretNamesForWorker('ar-policy')).not.toContain('LOG_ARCHIVE_CONTENT_HMAC_KEY');
    expect(getSecretNamesForWorker('ar-policy', { logArchive: true })).toEqual(
      expect.arrayContaining(['OBJECT_ENCRYPTION_ROOT_KEY', 'LOG_ARCHIVE_CONTENT_HMAC_KEY'])
    );
    expect(getSecretNamesForWorker('ar-management')).not.toContain(
      'LOG_ARCHIVE_CATALOG_WRITE_TOKEN'
    );
    expect(getSecretNamesForWorker('ar-management', { logArchive: true })).toEqual(
      expect.arrayContaining(['LOG_ARCHIVE_CATALOG_READ_TOKEN', 'LOG_ARCHIVE_CATALOG_WRITE_TOKEN'])
    );
    expect(getSecretNamesForWorker('ar-discovery', { logArchive: true })).toEqual(
      getSecretNamesForWorker('ar-discovery')
    );
  });

  it('retains an ambiguous create checkpoint when the provider commits but the response is lost', async () => {
    implemented.push('pipeline');
    const f = fixture('pipeline');
    f.loseResponse.add('pipelines/v1/streams');
    await expect(provisionLogArchive(f.options)).rejects.toThrow('response loss');
    expect(f.checkpoints['stream:LOG_ARCHIVE_STREAM'].state).toBe('create_issued');
    const created = f.calls.filter(
      (call) => call.method === 'POST' && call.path.endsWith('/streams')
    ).length;
    await expect(provisionLogArchive(f.options)).rejects.toThrow('ambiguous_create');
    expect(
      f.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/streams'))
    ).toHaveLength(created);
  });

  it('preserves owned resource checkpoints while the provider initializes the table', async () => {
    implemented.push('pipeline');
    const f = fixture('pipeline');
    const path = `basin-catalog/${f.archive.bucketName}/namespaces/${f.archive.namespace}/tables/${f.archive.tableName}/maintenance-configs`;
    f.overrides.set(path, { status: 404 });
    await expect(provisionLogArchive({ ...f.options, readinessTimeoutMs: 0 })).rejects.toThrow(
      'initialization_pending'
    );
    expect(f.checkpoints['pipeline:LOG_ARCHIVE_PIPELINE'].state).toBe('created');
    const creations = f.calls.filter(
      (call) => call.method === 'POST' && call.path.startsWith('pipelines/')
    ).length;
    f.overrides.delete(path);
    await expect(provisionLogArchive(f.options)).resolves.toMatchObject({
      activation: { basis: 'new_owned_empty_table' },
    });
    expect(
      f.calls.filter((call) => call.method === 'POST' && call.path.startsWith('pipelines/'))
    ).toHaveLength(creations);
  });

  it('does not claim readiness when the provider still schedules snapshot expiration', async () => {
    implemented.push('scheduled');
    const f = fixture('scheduled');
    f.overrides.set(
      `basin-catalog/${f.archive.bucketName}/namespaces/${f.archive.namespace}/tables/${f.archive.tableName}/maintenance-configs`,
      {
        result: {
          maintenance_config: {
            compaction: { state: 'enabled', target_size_mb: '64' },
            snapshot_expiration: { state: 'enabled', next_eligible_at: '2026-10-28T00:00:00Z' },
          },
        },
      }
    );
    await expect(provisionLogArchive(f.options)).rejects.toThrow(
      'snapshot_expiration_not_disabled'
    );
    expect(f.calls.some((call) => call.path.startsWith('pipelines/'))).toBe(false);
  });

  it('does not activate when the provider ignores the owned table compaction policy', async () => {
    implemented.push('scheduled');
    const f = fixture('scheduled');
    f.overrides.set(
      `basin-catalog/${f.archive.bucketName}/namespaces/${f.archive.namespace}/tables/${f.archive.tableName}/maintenance-configs`,
      {
        result: {
          maintenance_config: {
            compaction: { state: 'disabled', target_size_mb: '128' },
            snapshot_expiration: { state: 'disabled', next_eligible_at: null },
          },
        },
      }
    );
    await expect(provisionLogArchive(f.options)).rejects.toThrow('compaction_not_enabled');
  });

  it('binds internal staging to lib-core without distributing Admin DB to policy', async () => {
    implemented.push('scheduled');
    const f = fixture('scheduled');
    const locked = await provisionLogArchive(f.options);
    const config = createDefaultConfig('demo');
    config.logging = { archive: f.archive };
    config.cloudflare.accountId = accountId;
    config.components.adminUi = false;
    const ids = {
      d1: { DB_ADMIN: { id: 'admin-id', name: 'demo-authrim-admin-db' } },
      kv: {},
      logArchive: locked,
    };
    const core = generateWranglerConfig('ar-lib-core', config, ids);
    expect(core.d1_databases).toContainEqual({
      binding: 'DB_ADMIN',
      database_id: 'admin-id',
      database_name: 'demo-authrim-admin-db',
    });
    expect(core.services?.some((service) => service.binding === 'LOG_ARCHIVE_WRITER')).not.toBe(
      true
    );
    const policy = generateWranglerConfig('ar-policy', config, ids);
    expect(policy.d1_databases?.some((database) => database.binding === 'DB_ADMIN')).not.toBe(true);
    expect(policy.services).toContainEqual({
      binding: 'LOG_ARCHIVE_WRITER',
      service: 'demo-ar-lib-core',
      entrypoint: 'LogArchiveWriteEntrypoint',
      props: { caller: 'ar-policy', audience: 'authrim-log-archive-v1', environmentId: 'demo' },
    });
    expect(policy.pipelines).toBeUndefined();
    expect(policy.vars.AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT).toBe(f.archive.activatedAt);
    const wrong = {
      ...ids,
      logArchive: { ...locked, catalogUri: 'https://example.invalid/catalog' },
    };
    expect(() => generateWranglerConfig('ar-policy', config, wrong)).toThrow(
      'configuration_mismatch'
    );
  });

  it('rejects silently replacing the credential of an immutable existing Sink', async () => {
    implemented.push('pipeline');
    const f = fixture('pipeline');
    await provisionLogArchive(f.options);
    const mutations = f.calls.filter((call) => call.method !== 'GET').length;
    await expect(
      provisionLogArchive({ ...f.options, catalogSinkToken: 'replacement-sink-token' })
    ).rejects.toThrow('checkpoint_identity_changed');
    expect(f.calls.filter((call) => call.method !== 'GET')).toHaveLength(mutations);
  });

  it('serializes the supported stream binding with the current stream field', () => {
    const config = {
      name: 'worker',
      main: 'src/index.ts',
      compatibility_date: '2026-10-27',
      compatibility_flags: [],
      workers_dev: false,
      vars: {},
      pipelines: [{ binding: 'LOG_ARCHIVE_STREAM', stream: 'stream-id' }],
    };
    expect(toToml(config, 'demo')).toContain(
      '[[env.demo.pipelines]]\nbinding = "LOG_ARCHIVE_STREAM"\nstream = "stream-id"'
    );
    expect(toToml(config)).toContain('[[pipelines]]');
  });

  it('requires the original HMAC key when both its file and metadata are lost after provisioning started', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.test-log-setup-'));
    directories.push(directory);
    const keys = join(directory, 'keys');
    await mkdir(keys, { recursive: true, mode: 0o700 });
    await writeFile(join(keys, 'object_encryption_root_key.txt'), 'ab'.repeat(32), { mode: 0o600 });
    await stageLogArchiveSecrets(directory, 'demo', {
      readToken: tokenRead,
      writeToken: tokenWrite,
      sinkToken: tokenSink,
    });
    await publishLogArchiveSecrets(directory, 'demo', keys, 'pipeline');
    await rm(join(keys, 'log_archive_content_hmac_key.txt'));
    await rm(join(keys, 'metadata.json'), { force: true });
    const attempt = await beginOrResumeProvisioningIntent({
      baseDir: directory,
      environment: 'demo',
      accountId,
      resourceSpec: {},
    });
    await recordProvisioningResourceCreateIssued({
      baseDir: directory,
      environment: 'demo',
      expectedIntentId: attempt.intent.id,
      resource: { kind: 'catalog', binding: 'LOG_ARCHIVE_CATALOG', name: 'demo-log-archive' },
    });
    await expect(publishLogArchiveSecrets(directory, 'demo', keys, 'pipeline')).rejects.toThrow(
      'missing_restore_original'
    );
    await expect(readFile(join(keys, 'log_archive_content_hmac_key.txt'))).rejects.toThrow();
  });

  it('publishes read and maintenance tokens while keeping the Pipeline Sink token out of Worker key files', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.test-log-setup-'));
    directories.push(directory);
    const keys = join(directory, 'keys');
    await mkdir(keys, { recursive: true, mode: 0o700 });
    await writeFile(join(keys, 'object_encryption_root_key.txt'), 'ab'.repeat(32), { mode: 0o600 });
    await stageLogArchiveSecrets(directory, 'demo', {
      readToken: tokenRead,
      writeToken: tokenWrite,
      sinkToken: tokenSink,
    });
    await publishLogArchiveSecrets(directory, 'demo', keys, 'pipeline');
    expect(await readFile(join(keys, 'log_archive_catalog_read_token.txt'), 'utf8')).toBe(
      `${tokenRead}\n`
    );
    expect(await readFile(join(keys, 'log_archive_catalog_write_token.txt'), 'utf8')).toBe(
      `${tokenWrite}\n`
    );
    await expect(stat(join(keys, 'log_archive_catalog_sink_token.txt'))).rejects.toThrow();
    const contentKey = await readFile(join(keys, 'log_archive_content_hmac_key.txt'), 'utf8');
    expect(contentKey).toMatch(/^[a-f0-9]{64}$/u);
    await publishLogArchiveSecrets(directory, 'demo', keys, 'pipeline');
    expect(await readFile(join(keys, 'log_archive_content_hmac_key.txt'), 'utf8')).toBe(contentKey);
    expect(await loadLogArchiveSecrets(directory, 'demo', keys)).toEqual({
      readToken: tokenRead,
      writeToken: tokenWrite,
      sinkToken: tokenSink,
    });
    expect(
      (await stat(join(directory, '.authrim/demo/pending-log-archive-secrets.json'))).mode & 0o777
    ).toBe(0o600);
  });
});
