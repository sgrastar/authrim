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
  const overrides = new Map<string, { status?: number; result?: unknown }>();
  const loseResponse = new Set<string>();
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
    if (override)
      return new Response(
        JSON.stringify({ success: (override.status ?? 200) < 400, result: override.result }),
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
        result = { id: 'catalog-id', name: `${accountId}_${archive.bucketName}`, status: 'active' };
        remote.set(catalogPath, result as Record<string, unknown>);
      } else if (method === 'POST' && path.endsWith('/disable')) {
        remote.get(catalogPath)!.status = 'inactive';
        result = null;
      } else if (method === 'POST' && path.split('?')[0].endsWith('/delete')) {
        remote.delete(catalogPath);
        result = null;
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
    prepareScheduledTable,
    loadArchiveTable,
  };
  return {
    archive,
    remote,
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

  it('refuses a missing Paid subscription or insufficient credential permissions without resource mutations', async () => {
    implemented.push('pipeline');
    const free = fixture('pipeline');
    free.overrides.set('subscriptions', { result: [] });
    await expect(provisionLogArchive(free.options)).rejects.toThrow('workers_paid_required');
    expect(free.calls.some((call) => call.method !== 'GET')).toBe(false);
    const unreadable = fixture('pipeline');
    unreadable.overrides.set('subscriptions', { status: 403 });
    const progress: string[] = [];
    await expect(
      preflightLogArchive({ ...unreadable.options, onProgress: (m) => progress.push(m) })
    ).resolves.toBeUndefined();
    expect(progress.join('\n')).toContain('Workers Paid could not be confirmed');
    const unauthorized = fixture('pipeline');
    unauthorized.overrides.set('subscriptions', { status: 401 });
    await expect(preflightLogArchive(unauthorized.options)).resolves.toBeUndefined();
    const unavailable = fixture('pipeline');
    unavailable.overrides.set('subscriptions', { status: 500 });
    await expect(preflightLogArchive(unavailable.options)).rejects.toThrow('request_failed');
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

  it('requires an explicitly usable subscription state instead of accepting cancelled or unknown states', async () => {
    implemented.push('pipeline');
    for (const state of ['Cancelled', 'Expired', 'Failed', 'AwaitingPayment', 'Trial', undefined]) {
      const f = fixture('pipeline');
      f.overrides.set('subscriptions', { result: [{ rate_plan: { id: 'WORKERS_PAID' }, state }] });
      await expect(provisionLogArchive(f.options)).rejects.toThrow('workers_paid_required');
      expect(f.calls.some((call) => call.method !== 'GET')).toBe(false);
    }
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
