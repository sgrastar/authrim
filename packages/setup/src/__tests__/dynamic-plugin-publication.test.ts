import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateDynamicPluginVersionDigest,
  publishDynamicPluginWorkerBundles,
} from '../core/dynamic-plugin-publication.js';
import type { AggregatedExternalCapabilitySource } from '../core/external-capabilities.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const roots: string[] = [];

function source(path: string, bytes: Uint8Array): AggregatedExternalCapabilitySource {
  const codeSha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    sourceKind: 'plugin_manifest',
    sourceId: 'plugin-a',
    sourceManifestPath: 'authrim.plugin-worker-capabilities.json',
    sourceManifestHash: 'a'.repeat(64),
    capabilityManifestDigest: 'b'.repeat(64),
    provenance: null,
    pluginPolicy: {
      backend: 'dynamic_worker',
      resourceScope: 'tenant',
      visibility: 'tenant',
      capabilities: [],
      credentials: [
        {
          configKey: 'apiKey',
          required: true,
          destinationHost: 'api.example.com',
          injectionKind: 'bearer',
          injectionName: 'Authorization',
        },
      ],
      egressAllowedHosts: [{ kind: 'exact', host: 'api.example.com' }],
      hostInterfaces: [],
      resources: [],
      workerArtifact: {
        sourceBundlePath: path,
        codeSha256,
        codeObjectKey: `plugins/plugin-a/${codeSha256}.json`,
        size: bytes.byteLength,
      },
    },
    workers: [],
  };
}

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(
      resolve(REPO_ROOT, 'migrations/plugin-runner/d1/001_0_4_0_plugin_runner_baseline.sql'),
      'utf8'
    )
  );
  return db;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Dynamic plugin publication', () => {
  it('uploads exact bytes and idempotently reflects a published release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'authrim-dynamic-plugin-'));
    roots.push(root);
    const bytes = new TextEncoder().encode('{"pluginId":"plugin-a"}');
    await writeFile(join(root, 'bundle.json'), bytes);
    const plugin = source('bundle.json', bytes);
    const db = database();
    const upload = vi.fn(async () => undefined);
    const verifyBucketOwnership = vi.fn(async () => undefined);
    const execute = vi.fn(async (_name: string, sql: string) => {
      db.exec(sql);
      return { stdout: '', stderr: '' };
    });
    const query = vi.fn(
      async <T extends Record<string, unknown>>(_name: string, sql: string) =>
        db.prepare(sql).all() as T[]
    );

    const first = await publishDynamicPluginWorkerBundles({
      baseDir: root,
      enabled: true,
      sources: [plugin],
      bucketName: 'test-plugin-bundles',
      pluginRunnerDatabaseId: 'plugin-runner-id',
      now: 100,
      upload,
      verifyBucketOwnership,
      execute,
      query,
    });
    const second = await publishDynamicPluginWorkerBundles({
      baseDir: root,
      enabled: true,
      sources: [plugin],
      bucketName: 'test-plugin-bundles',
      pluginRunnerDatabaseId: 'plugin-runner-id',
      now: 101,
      upload,
      verifyBucketOwnership,
      execute,
      query,
    });

    expect(first).toEqual(second);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(verifyBucketOwnership).toHaveBeenCalledTimes(4);
    expect(upload.mock.calls[0]?.[0]).toMatchObject({
      bucketName: 'test-plugin-bundles',
      objectKey: plugin.pluginPolicy?.workerArtifact?.codeObjectKey,
      contentType: 'application/json',
    });
    expect(Array.from(upload.mock.calls[0]?.[0].bytes ?? [])).toEqual(Array.from(bytes));
    expect(execute).toHaveBeenCalledWith('plugin-runner-id', expect.any(String));
    expect(query).toHaveBeenCalledWith('plugin-runner-id', expect.any(String));
    expect(
      db
        .prepare(
          `SELECT plugin_id, version_digest, code_sha256, code_object_key,
                  source_manifest_hash, capability_manifest_digest, state, published_at, updated_at
           FROM plugin_runner_dynamic_worker_releases`
        )
        .get()
    ).toEqual({
      plugin_id: 'plugin-a',
      version_digest: first.published[0]?.versionDigest,
      code_sha256: plugin.pluginPolicy?.workerArtifact?.codeSha256,
      code_object_key: plugin.pluginPolicy?.workerArtifact?.codeObjectKey,
      source_manifest_hash: 'a'.repeat(64),
      capability_manifest_digest: 'b'.repeat(64),
      state: 'published',
      published_at: 100,
      updated_at: 101,
    });
    expect(
      db
        .prepare(
          `SELECT active_version_digest, state
             FROM plugin_runner_dynamic_worker_manifests WHERE plugin_id = 'plugin-a'`
        )
        .get()
    ).toEqual({
      active_version_digest: first.published[0]?.versionDigest,
      state: 'active',
    });
    expect(
      db
        .prepare(
          `SELECT version_digest, config_key, required, destination_host,
                  injection_kind, injection_name
             FROM plugin_runner_dynamic_worker_credential_slots`
        )
        .get()
    ).toEqual({
      version_digest: first.published[0]?.versionDigest,
      config_key: 'apiKey',
      required: 1,
      destination_host: 'api.example.com',
      injection_kind: 'bearer',
      injection_name: 'Authorization',
    });
    db.close();
  });

  it('changes the immutable plugin version when policy changes without changing code', () => {
    const common = {
      codeSha256: 'a'.repeat(64),
      capabilityManifestDigest: 'b'.repeat(64),
    };
    const first = calculateDynamicPluginVersionDigest({
      ...common,
      policy: { backend: 'dynamic_worker', egressAllowedHosts: ['api.example.com'] },
    });
    const second = calculateDynamicPluginVersionDigest({
      ...common,
      policy: { backend: 'dynamic_worker', egressAllowedHosts: ['api2.example.com'] },
    });
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).not.toBe(first);
  });

  it('fails before upload when disabled or bytes changed after discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'authrim-dynamic-plugin-'));
    roots.push(root);
    const path = join(root, 'bundle.json');
    const bytes = new TextEncoder().encode('{"pluginId":"plugin-a"}');
    await writeFile(path, bytes);
    const plugin = source('bundle.json', bytes);
    const upload = vi.fn(async () => undefined);

    await expect(
      publishDynamicPluginWorkerBundles({
        baseDir: root,
        enabled: false,
        sources: [plugin],
        upload,
      })
    ).rejects.toThrow('dynamic_plugin_worker_capability_disabled');
    await expect(
      publishDynamicPluginWorkerBundles({
        baseDir: root,
        enabled: true,
        sources: [plugin],
        bucketName: 'test-plugin-bundles',
        upload,
      })
    ).rejects.toThrow('dynamic_plugin_worker_database_id_missing');
    await writeFile(path, '{"pluginId":"plugin-b"}');
    await expect(
      publishDynamicPluginWorkerBundles({
        baseDir: root,
        enabled: true,
        sources: [plugin],
        bucketName: 'test-plugin-bundles',
        pluginRunnerDatabaseId: 'plugin-runner-id',
        upload,
      })
    ).rejects.toThrow('dynamic_plugin_worker_bundle_changed_after_discovery');
    expect(upload).not.toHaveBeenCalled();
  });

  it('reconciles an execute response loss by replaying the content-addressed publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'authrim-dynamic-plugin-'));
    roots.push(root);
    const bytes = new TextEncoder().encode('{"pluginId":"plugin-a"}');
    await writeFile(join(root, 'bundle.json'), bytes);
    const plugin = source('bundle.json', bytes);
    const db = database();
    let responseLost = true;
    const execute = vi.fn(async (_name: string, sql: string) => {
      db.exec(sql);
      if (responseLost) {
        responseLost = false;
        throw new Error('response_lost');
      }
      return { stdout: '', stderr: '' };
    });
    const query = async <T extends Record<string, unknown>>(_name: string, sql: string) =>
      db.prepare(sql).all() as T[];
    const input = {
      baseDir: root,
      enabled: true,
      sources: [plugin],
      bucketName: 'test-plugin-bundles',
      pluginRunnerDatabaseId: 'plugin-runner-id',
      now: 100,
      upload: vi.fn(async () => undefined),
      execute,
      query,
    };

    await expect(publishDynamicPluginWorkerBundles(input)).rejects.toThrow('response_lost');
    await expect(publishDynamicPluginWorkerBundles(input)).resolves.toMatchObject({
      published: [{ pluginId: 'plugin-a' }],
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM plugin_runner_dynamic_worker_releases`).get()
    ).toEqual({ count: 1 });
    db.close();
  });

  it('keeps an interrupted policy replacement non-runnable until an exact retry completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'authrim-dynamic-plugin-'));
    roots.push(root);
    const bytes = new TextEncoder().encode('{"pluginId":"plugin-a"}');
    await writeFile(join(root, 'bundle.json'), bytes);
    const plugin = source('bundle.json', bytes);
    const db = database();
    let interrupt = true;
    const execute = vi.fn(async (_name: string, sql: string) => {
      if (interrupt) {
        interrupt = false;
        const activation = sql.lastIndexOf('UPDATE plugin_runner_dynamic_worker_manifests');
        expect(activation).toBeGreaterThan(0);
        db.exec(sql.slice(0, activation));
        throw new Error('policy_projection_interrupted');
      }
      db.exec(sql);
      return { stdout: '', stderr: '' };
    });
    const query = async <T extends Record<string, unknown>>(_name: string, sql: string) =>
      db.prepare(sql).all() as T[];
    const input = {
      baseDir: root,
      enabled: true,
      sources: [plugin],
      bucketName: 'test-plugin-bundles',
      pluginRunnerDatabaseId: 'plugin-runner-id',
      now: 100,
      upload: vi.fn(async () => undefined),
      execute,
      query,
    };

    await expect(publishDynamicPluginWorkerBundles(input)).rejects.toThrow(
      'policy_projection_interrupted'
    );
    expect(
      db
        .prepare(
          `SELECT state FROM plugin_runner_dynamic_worker_manifests WHERE plugin_id = 'plugin-a'`
        )
        .get()
    ).toEqual({ state: 'staging' });
    await expect(publishDynamicPluginWorkerBundles(input)).resolves.toMatchObject({
      published: [{ pluginId: 'plugin-a' }],
    });
    expect(
      db
        .prepare(
          `SELECT state FROM plugin_runner_dynamic_worker_manifests WHERE plugin_id = 'plugin-a'`
        )
        .get()
    ).toEqual({ state: 'active' });
    db.close();
  });
});
