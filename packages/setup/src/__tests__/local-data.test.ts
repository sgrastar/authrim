import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const kvWrites = vi.hoisted(() => new Map<string, string>());

vi.mock('../core/cloudflare.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/cloudflare.js')>()),
  executeD1Command: vi.fn(async (_database: string, sql: string) => {
    const label = ['authrim_control_plane_shard_metadata', 'UPDATE control_tenant_shards'].find(
      (marker) => sql.includes(marker)
    );
    calls.push(`sql:${label ?? 'other'}`);
    return { stdout: '', stderr: '' };
  }),
  queryD1Rows: vi.fn(async () => []),
  getOptionalKVKeyByNamespaceId: vi.fn(async () => null),
  putKVKeyByNamespaceId: vi.fn(async (_namespace: string, key: string, value: string) => {
    calls.push(`kv:${key.split(':').slice(-2).join(':')}`);
    kvWrites.set(key, value);
  }),
  ensureInitialTenantInD1: vi.fn(async () => (calls.push('seed:tenant'), { success: true })),
  ensureInitialAdminRolesInD1: vi.fn(
    async () => (calls.push('seed:admin-roles'), { success: true })
  ),
  seedDefaultCanonicalCatalog: vi.fn(async () => (calls.push('seed:catalog'), { success: true })),
  seedRuntimeProfiles: vi.fn(async () => (calls.push('seed:profiles'), { success: true })),
}));
vi.mock('../core/control-plane-bootstrap.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/control-plane-bootstrap.js')>()),
  publishInitialControlPlaneRuntimeSnapshot: vi.fn(
    async (input: { target?: unknown; snapshotTtlSeconds?: number }) => {
      calls.push(
        `publish:runtime-snapshot:ttl=${input.snapshotTtlSeconds}:local=${!!input.target}`
      );
      return { success: true };
    }
  ),
}));
vi.mock('../core/control-bootstrap-handoff.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/control-bootstrap-handoff.js')>()),
  registerInitialControlTopology: vi.fn(async () => (calls.push('control:topology'), {})),
}));
vi.mock('../core/control-key-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/control-key-state.js')>()),
  initializeControlKeyState: vi.fn(async () => (calls.push('control:key-state'), {})),
}));
vi.mock('../core/control-worker-inventory.js', () => ({
  compileControlWorkerInventoryFromArtifacts: vi.fn(
    async () => (calls.push('control:inventory-compile'), [])
  ),
  registerControlWorkerInventory: vi.fn(async () => (calls.push('control:inventory'), {})),
}));
vi.mock('../core/migration-release-publication.js', () => ({
  publishAndActivateMigrationRelease: vi.fn(async () => (calls.push('control:release'), {})),
}));
vi.mock('../core/notification-provider-bootstrap.js', () => ({
  ensureLocalLogNotificationConfiguration: vi.fn(
    async () => (calls.push('seed:notifications'), {})
  ),
}));

import { generateAllSecrets, saveKeysToDirectory } from '../core/keys.js';
import { buildLocalConfig, buildLocalLock } from '../core/local/environment.js';
import { getLocalEnvironmentPaths } from '../core/local/paths.js';
import {
  buildLocalControlActivationSql,
  buildLocalMigrationScript,
  loadLocalRelease,
  localSignedStateNeedsRefresh,
  seedLocalEnvironment,
  streamForLocalBinding,
} from '../core/local/data.js';
import { buildInitialControlPlaneResourcePlans } from '../core/control-plane-bootstrap.js';

const repoRoot = resolve(process.cwd(), '../..');

describe('local migration scripts', () => {
  it('applies a whole stream, records every file and leaves no unrendered tokens', async () => {
    const release = await loadLocalRelease(repoRoot);
    const script = await buildLocalMigrationScript({
      migrationsRoot: release.migrationsRoot,
      manifest: release.manifest,
      streamId: 'core-d1',
    });
    expect(script).not.toContain('__AUTHRIM_NOW_');

    const database = new DatabaseSync(':memory:');
    database.exec(script);
    const files = release.manifest.streams.find((stream) => stream.id === 'core-d1')!.files;
    const recorded = database
      .prepare('SELECT filename, checksum FROM authrim_migrations ORDER BY filename')
      .all() as Array<{ filename: string; checksum: string }>;
    expect(recorded).toEqual(
      files.map((file) => ({ filename: file.path, checksum: file.checksum }))
    );
    expect(
      (
        database.prepare("SELECT COUNT(*) AS n FROM tenants WHERE id = 'default'").get() as {
          n: number;
        }
      ).n
    ).toBe(1);
    database.close();
  });

  it('orders files exactly as the release manifest does', async () => {
    const release = await loadLocalRelease(repoRoot);
    const script = await buildLocalMigrationScript({
      migrationsRoot: release.migrationsRoot,
      manifest: release.manifest,
      streamId: 'lookup-d1',
    });
    const files = release.manifest.streams.find((stream) => stream.id === 'lookup-d1')!.files;
    const positions = files.map((file) => script.indexOf(`'${file.path}'`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('maps every local database to its release stream', async () => {
    const release = await loadLocalRelease(repoRoot);
    const lock = buildLocalLock('local');
    const plans = buildInitialControlPlaneResourcePlans({
      env: 'local',
      lock,
      release: release.manifest,
      releaseDraft: release.draft,
    });
    const streams = Object.fromEntries(
      Object.keys(lock.d1).map((binding) => [binding, streamForLocalBinding(binding, plans)])
    );
    expect(streams).toEqual({
      DB: 'core-d1',
      DB_PII: 'pii-d1',
      DB_ADMIN: 'admin-d1',
      CONTROL_DB: 'control-d1',
      LOOKUP_DB: 'lookup-d1',
      PLUGIN_RUNNER_DB: 'plugin-runner-d1',
      LOCAL_TDB_DEFAULT_BOOTSTRAP_CORE: 'core-d1',
      LOCAL_TDB_USERS_BOOTSTRAP_CORE: 'core-d1',
      LOCAL_TDB_PII_BOOTSTRAP_PII: 'pii-d1',
    });
    expect(() => streamForLocalBinding('NOPE', plans)).toThrow();
  });
});

describe('local Control activation', () => {
  it('is valid SQL against the Control schema and is idempotent', async () => {
    const release = await loadLocalRelease(repoRoot);
    const database = new DatabaseSync(':memory:');
    database.exec(
      await buildLocalMigrationScript({
        migrationsRoot: release.migrationsRoot,
        manifest: release.manifest,
        streamId: 'control-d1',
      })
    );
    const sql = buildLocalControlActivationSql('local', 1_000);
    database.exec(sql);
    database.exec(sql);
    database.close();
  });

  it('activates shards, makes them capacity-eligible and accepts the handoff', () => {
    const sql = buildLocalControlActivationSql('local', 1_000);
    expect(sql).toContain("UPDATE control_tenant_shards SET status = 'active'");
    expect(sql).toContain("'healthy', 'eligible'");
    expect(sql).toContain("SET state = 'accepted'");
    expect(sql).toContain("SET lifecycle_state = 'active'");
  });
});

describe('local log notification routing', () => {
  it('routes email, sms and push to one installation per tenant, and platform too', async () => {
    const actual = await vi.importActual<
      typeof import('../core/notification-provider-bootstrap.js')
    >('../core/notification-provider-bootstrap.js');
    const config = buildLocalConfig({ env: 'local' });
    const lock = buildLocalLock('local');
    const database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(
        join(repoRoot, 'migrations/plugin-runner/d1/001_0_4_0_plugin_runner_baseline.sql'),
        'utf8'
      )
    );
    const writes = new Map<string, string>();
    const input = {
      environmentId: 'local',
      config,
      lock,
      now: 1_000,
      execute: (async (_database: string, sql: string) => {
        database.exec(sql);
        return { stdout: '', stderr: '' };
      }) as never,
      query: (async (_database: string, sql: string) => database.prepare(sql).all()) as never,
      putKv: (async (_ns: string, key: string, value: string) => {
        writes.set(key, value);
      }) as never,
    };
    const first = await actual.ensureLocalLogNotificationConfiguration(input);
    const second = await actual.ensureLocalLogNotificationConfiguration(input);

    expect(first.providerId).toBe('notifier-log');
    expect(second.namespaces).toEqual(['authrim-platform', 'default']);
    expect(
      database
        .prepare(
          `SELECT tenant_id, channel, state FROM plugin_runner_notification_route_sets
            ORDER BY tenant_id, channel`
        )
        .all()
    ).toEqual(
      ['authrim-platform', 'default'].flatMap((tenant_id) =>
        ['email', 'push', 'sms'].map((channel) => ({ tenant_id, channel, state: 'enabled' }))
      )
    );
    expect(
      database
        .prepare(
          'SELECT tenant_id, plugin_id, backend_kind FROM plugin_runner_installations ORDER BY tenant_id'
        )
        .all()
    ).toEqual([
      { tenant_id: 'authrim-platform', plugin_id: 'notifier-log', backend_kind: 'in_process' },
      { tenant_id: 'default', plugin_id: 'notifier-log', backend_kind: 'in_process' },
    ]);
    expect(writes.get('plugins:enabled:notifier-log')).toBe('true');
    expect(JSON.parse(writes.get('settings:tenant:default:email-settings')!)).toMatchObject({
      providerOrder: ['notifier-log'],
    });
    database.close();
  });

  it('keeps the initial Cloudflare bootstrap on email only', async () => {
    const source = await readFile(
      resolve(process.cwd(), 'src/core/notification-provider-bootstrap.ts'),
      'utf8'
    );
    // The log provider is a separate exported function; the Cloudflare one never selects it.
    expect(source).toMatch(/function providerId\(config: AuthrimConfig\)[\s\S]*?default:/u);
    expect(
      source.slice(
        source.indexOf('function providerId'),
        source.indexOf('async function operationId')
      )
    ).not.toContain('notifier-log');
  });
});

describe('local seed order', () => {
  const root = join(process.cwd(), `.test-local-seed-${Date.now()}`);
  const paths = getLocalEnvironmentPaths(root, 'local');

  beforeAll(async () => {
    mkdirSync(root, { recursive: true });
    await saveKeysToDirectory(generateAllSecrets('local-key'), { targetDir: paths.keys });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('follows the Cloudflare order: shard identity, Control, seeds, notifications, signed state', async () => {
    calls.length = 0;
    const config = buildLocalConfig({ env: 'local' });
    const release = await loadLocalRelease(repoRoot);
    await seedLocalEnvironment({
      env: 'local',
      config,
      lock: buildLocalLock('local'),
      paths: { ...paths, rootDir: repoRoot },
      release,
    });

    const first = (label: string): number => calls.findIndex((call) => call.startsWith(label));
    const order = [
      'sql:authrim_control_plane_shard_metadata',
      'control:release',
      'control:inventory',
      'control:key-state',
      'control:topology',
      'sql:UPDATE control_tenant_shards',
      'seed:tenant',
      'seed:admin-roles',
      'seed:catalog',
      'seed:profiles',
      'seed:notifications',
      'publish:runtime-snapshot',
      'kv:plugin-runner-registry:snapshot',
      'kv:lookup-shard-registry:snapshot',
      'kv:lookup-hmac-key-state:snapshot',
      'kv:setup:token',
    ];
    const positions = order.map(first);
    expect(
      positions.every((position) => position >= 0),
      JSON.stringify(calls)
    ).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // Three tenant shard identities, one per bootstrap D1.
    expect(
      calls.filter((call) => call === 'sql:authrim_control_plane_shard_metadata')
    ).toHaveLength(3);
  });

  it('signs the runtime registry for a week and the Lookup state before it can expire', async () => {
    expect(calls).toContain('publish:runtime-snapshot:ttl=604800:local=true');
    expect(kvWrites.get('setup:token')).toBeTruthy();
    for (const key of [
      'environment:local:lookup-shard-registry:snapshot',
      'environment:local:lookup-hmac-key-state:snapshot',
      'environment:local:plugin-runner-registry:snapshot',
    ]) {
      expect(kvWrites.get(key), key).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/u);
    }
  });

  it('asks for a refresh once the signed state is old enough to lapse', async () => {
    const stamp = join(paths.root, 'signed-at');
    const now = 1_000_000;
    expect(await localSignedStateNeedsRefresh({ ...paths, root: join(root, 'missing') }, now)).toBe(
      true
    );
    await writeFile(stamp, `${now - 60}\n`);
    expect(await localSignedStateNeedsRefresh(paths, now)).toBe(false);
    // Older than half the plugin-runner registry's 24 hour limit.
    await writeFile(stamp, `${now - 13 * 60 * 60}\n`);
    expect(await localSignedStateNeedsRefresh(paths, now)).toBe(true);
  });
});
