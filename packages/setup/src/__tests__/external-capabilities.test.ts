import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateExternalCapabilities,
  loadPluginWorkerCapabilityManifests,
  loadProjectExtensionCapabilityManifest,
  parseExtensionCapabilityManifest,
  parsePluginWorkerCapabilityManifest,
} from '../core/external-capabilities.js';

const roots: string[] = [];

function extensionManifest() {
  return {
    schemaVersion: 1,
    extensionId: 'example.custom-worker',
    owner: 'Example team',
    source: 'packages/custom-worker',
    scope: 'tenant',
    reason: 'Connect the application BFF to tenant-scoped Authrim capabilities.',
    workers: [
      {
        scriptName: 'example-custom-worker',
        bindings: [
          {
            name: 'TENANT_PROFILE_READER',
            capability: 'tenant.profile.read',
            scope: 'tenant',
            reason: 'Read the active tenant profile.',
          },
        ],
        services: [
          {
            name: 'AUTHRIM_SERVICE',
            capability: 'authrim.service.call',
            scope: 'tenant',
            reason: 'Call the narrow Authrim service interface.',
          },
        ],
        secrets: [
          {
            name: 'CUSTOM_PROVIDER_API_KEY',
            capability: 'custom_provider.call',
            scope: 'tenant',
            reason: 'Authenticate to the configured provider.',
          },
        ],
      },
    ],
  };
}

function pluginManifest(pluginId = 'example.notifier') {
  return {
    schemaVersion: 1,
    pluginId,
    backend: 'dynamic_worker',
    workerBundle: { path: 'worker.bundle.json' },
    resourceScope: 'tenant',
    visibility: 'tenant',
    bindings: [
      {
        name: 'NOTIFIER_ACCESS',
        interface: 'authrim.account_metadata.v1',
        scope: 'tenant',
      },
    ],
    resources: [],
    capabilities: [
      {
        name: 'notifier.email',
        execution: 'async',
        failurePolicy: 'retry_async',
        timeoutMs: 5_000,
        mutationScopes: ['notifier.send', 'account.metadata.write'],
        asyncOutbox: {
          enabled: true,
          succeededRetentionDays: 7,
          deadLetterRetentionDays: 90,
        },
      },
      {
        name: 'human_verification.example',
        execution: 'sync',
        failurePolicy: 'fail_closed',
        timeoutMs: 2_000,
        mutationScopes: ['human_verification.verify'],
        asyncOutbox: {
          enabled: false,
          succeededRetentionDays: 7,
          deadLetterRetentionDays: 90,
        },
      },
    ],
    credentials: [
      {
        configKey: 'apiKey',
        required: true,
        destinationHost: 'api.example.com',
        injectionKind: 'bearer',
        injectionName: 'Authorization',
      },
    ],
    egressAllowedHosts: [
      { kind: 'exact', host: 'api.example.com' },
      { kind: 'suffix_wildcard', suffix: '*.hooks.example.com' },
    ],
  };
}

function pluginBundle(pluginId: string) {
  return {
    schemaVersion: 1,
    pluginId,
    compatibilityDate: '2026-07-31',
    compatibilityFlags: [],
    mainModule: 'index.js',
    modules: { 'index.js': 'export default { fetch() { return new Response(null); } };' },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('external capability manifests', () => {
  it('parses and aggregates an explicit extension without secret values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'authrim-extension-capability-'));
    roots.push(root);
    const path = join(root, 'authrim.extension-capabilities.json');
    await writeFile(path, JSON.stringify(extensionManifest()));

    const compiled = await loadProjectExtensionCapabilityManifest({ baseDir: root });
    const aggregate = aggregateExternalCapabilities({ extension: compiled });

    expect(compiled.sourceManifestPath).toBe('authrim.extension-capabilities.json');
    expect(compiled.sourceManifestHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(aggregate).toEqual([
      expect.objectContaining({
        sourceKind: 'extension_manifest',
        sourceId: 'example.custom-worker',
        workers: [
          expect.objectContaining({
            workerReference: 'example-custom-worker',
            scriptName: 'example-custom-worker',
            bindings: expect.arrayContaining([
              expect.objectContaining({ name: 'CUSTOM_PROVIDER_API_KEY', kind: 'secret' }),
              expect.objectContaining({ name: 'AUTHRIM_SERVICE', kind: 'service' }),
            ]),
          }),
        ],
      }),
    ]);
    expect(JSON.stringify(aggregate)).not.toContain('secretValue');
  });

  it('does not let an extension weaken core Worker or Cloudflare token policy', () => {
    const coreWorker = extensionManifest();
    coreWorker.workers[0].scriptName = 'test-ar-auth';
    expect(() => parseExtensionCapabilityManifest(coreWorker)).toThrow(
      'extension_core_worker_forbidden'
    );

    const token = extensionManifest();
    token.workers[0].secrets[0].name = 'CLOUDFLARE_WORKERS_API_TOKEN';
    expect(() => parseExtensionCapabilityManifest(token)).toThrow(
      'extension_cloudflare_token_forbidden'
    );

    const scopeEscalation = extensionManifest();
    scopeEscalation.workers[0].bindings[0].scope = 'platform';
    expect(() => parseExtensionCapabilityManifest(scopeEscalation)).toThrow(
      'extension_request_exceeds_manifest_scope'
    );
  });

  it('accepts typed plugin interfaces and consistent sync/async policies', () => {
    const parsed = parsePluginWorkerCapabilityManifest(pluginManifest());
    const aggregate = aggregateExternalCapabilities({
      plugins: [
        {
          manifest: parsed,
          sourceManifestPath: 'plugins/example/authrim.plugin-worker-capabilities.json',
          sourceManifestHash: 'a'.repeat(64),
          capabilityManifestDigest: 'b'.repeat(64),
          dynamicWorkerArtifact: {
            sourceBundlePath: 'plugins/example/worker.bundle.json',
            codeSha256: 'c'.repeat(64),
            codeObjectKey: `plugins/example.notifier/${'c'.repeat(64)}.json`,
            size: 128,
          },
        },
      ],
    });

    expect(aggregate[0]).toEqual(
      expect.objectContaining({
        sourceKind: 'plugin_manifest',
        sourceId: 'example.notifier',
        workers: [
          {
            workerReference: 'plugin:example.notifier',
            scriptName: null,
            bindings: [
              {
                name: 'NOTIFIER_ACCESS',
                kind: 'plugin_interface',
                capability: 'authrim.account_metadata.v1',
                scope: 'tenant',
                reason: null,
              },
            ],
          },
        ],
        pluginPolicy: expect.objectContaining({
          backend: 'dynamic_worker',
          visibility: 'tenant',
          capabilities: expect.arrayContaining([
            expect.objectContaining({ name: 'notifier.email', failurePolicy: 'retry_async' }),
          ]),
          credentials: [
            {
              configKey: 'apiKey',
              required: true,
              destinationHost: 'api.example.com',
              injectionKind: 'bearer',
              injectionName: 'Authorization',
            },
          ],
          egressAllowedHosts: expect.arrayContaining([{ kind: 'exact', host: 'api.example.com' }]),
        }),
      })
    );
  });

  it('rejects raw data bindings, token bindings, and inconsistent execution policy', () => {
    for (const name of ['DB_ADMIN', 'TDB_USERS_0001_CORE', 'CLOUDFLARE_D1_API_TOKEN']) {
      const manifest = pluginManifest();
      manifest.bindings[0].name = name;
      expect(() => parsePluginWorkerCapabilityManifest(manifest)).toThrow(
        name.startsWith('CLOUDFLARE')
          ? 'plugin_cloudflare_token_forbidden'
          : 'plugin_raw_data_binding_forbidden'
      );
    }

    const inconsistent = pluginManifest();
    inconsistent.capabilities[0].failurePolicy = 'fail_open';
    expect(() => parsePluginWorkerCapabilityManifest(inconsistent)).toThrow(
      'plugin_execution_policy_inconsistent'
    );

    const unknownInterface = pluginManifest();
    unknownInterface.bindings[0].interface = 'example.unregistered.v1';
    expect(() => parsePluginWorkerCapabilityManifest(unknownInterface)).toThrow(
      'plugin_host_interface_unknown'
    );

    const missingCapability = pluginManifest();
    missingCapability.capabilities[0].mutationScopes = ['notifier.send'];
    expect(() => parsePluginWorkerCapabilityManifest(missingCapability)).toThrow(
      'plugin_host_interface_capability_missing'
    );
  });

  it('accepts managed resources and permits existing-resource selection only when declared', () => {
    const manifest = {
      ...pluginManifest(),
      resources: [
        {
          schemaVersion: 1,
          logicalResourceId: 'plugin-state',
          binding: 'PLUGIN_STATE',
          kind: 'd1',
          scope: 'tenant',
          access: 'read_write',
          provisioning: { defaultMode: 'managed', allowExisting: true },
          migrationStream: 'plugin/example.notifier/state' as string | null,
        },
      ],
    };
    expect(parsePluginWorkerCapabilityManifest(manifest).resources).toEqual(manifest.resources);

    manifest.resources[0].migrationStream = null;
    expect(() => parsePluginWorkerCapabilityManifest(manifest)).toThrow(
      'plugin_resource_migration_stream_invalid'
    );
  });

  it('does not allow a custom manifest to replace a built-in plugin identity', () => {
    expect(() => parsePluginWorkerCapabilityManifest(pluginManifest('notifier-resend'))).toThrow(
      'plugin_reserved_id_forbidden'
    );
  });

  it('requires a local bundle only for Dynamic Worker manifests', () => {
    const missing = pluginManifest() as ReturnType<typeof pluginManifest> & {
      workerBundle?: { path: string };
    };
    delete missing.workerBundle;
    expect(() => parsePluginWorkerCapabilityManifest(missing)).toThrow(
      'plugin_worker_bundle_required'
    );

    const inProcess = pluginManifest();
    inProcess.backend = 'in_process';
    expect(() => parsePluginWorkerCapabilityManifest(inProcess)).toThrow(
      'plugin_worker_bundle_forbidden'
    );

    const traversal = pluginManifest();
    traversal.workerBundle.path = '../worker.bundle.json';
    expect(() => parsePluginWorkerCapabilityManifest(traversal)).toThrow(
      'plugin_worker_bundle_path_invalid'
    );
  });

  it('allows owned public hosts but rejects broad, local, IP, and ambiguous IDNA egress', () => {
    expect(() => parsePluginWorkerCapabilityManifest(pluginManifest())).not.toThrow();
    for (const entry of [
      { kind: 'suffix_wildcard', suffix: '*.com' },
      { kind: 'suffix_wildcard', suffix: '*.co.uk' },
      { kind: 'suffix_wildcard', suffix: '*.github.io' },
      { kind: 'exact', host: 'localhost' },
      { kind: 'exact', host: '127.0.0.1' },
      { kind: 'exact', host: 'metadata.google.internal' },
      { kind: 'exact', host: 'xn--bcher-kva.example' },
      { kind: 'exact', host: 'api.example.com.' },
    ]) {
      const manifest = pluginManifest() as ReturnType<typeof pluginManifest> & {
        egressAllowedHosts: Array<Record<string, string>>;
      };
      manifest.egressAllowedHosts = [entry];
      expect(() => parsePluginWorkerCapabilityManifest(manifest)).toThrow(
        'plugin_egress_host_not_approved'
      );
    }
  });

  it('binds credential slots only to exact approved hosts and safe gateway injection targets', () => {
    const wildcardOnly = pluginManifest();
    wildcardOnly.credentials[0].destinationHost = 'hooks.example.com';
    expect(() => parsePluginWorkerCapabilityManifest(wildcardOnly)).toThrow(
      'plugin_credential_host_not_exact'
    );

    const unsafeHeader = pluginManifest();
    unsafeHeader.credentials[0].injectionKind = 'header';
    unsafeHeader.credentials[0].injectionName = 'Cookie';
    expect(() => parsePluginWorkerCapabilityManifest(unsafeHeader)).toThrow(
      'plugin_credential_injection_forbidden'
    );

    const duplicate = pluginManifest();
    duplicate.credentials.push({ ...duplicate.credentials[0] });
    expect(() => parsePluginWorkerCapabilityManifest(duplicate)).toThrow(
      'duplicate_capability_entry'
    );
  });

  it('loads plugin manifests deterministically and rejects duplicate IDs or paths outside project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'authrim-plugin-capability-'));
    const outside = await mkdtemp(join(tmpdir(), 'authrim-plugin-outside-'));
    roots.push(root, outside);
    await mkdir(join(root, 'plugins', 'one'), { recursive: true });
    await mkdir(join(root, 'plugins', 'two'), { recursive: true });
    const one = join(root, 'plugins', 'one', 'authrim.plugin-worker-capabilities.json');
    const two = join(root, 'plugins', 'two', 'authrim.plugin-worker-capabilities.json');
    const outsidePath = join(outside, 'authrim.plugin-worker-capabilities.json');
    await writeFile(one, JSON.stringify(pluginManifest('plugin.one')));
    await writeFile(two, JSON.stringify(pluginManifest('plugin.two')));
    await writeFile(outsidePath, JSON.stringify(pluginManifest('plugin.outside')));
    await writeFile(
      join(root, 'plugins', 'one', 'worker.bundle.json'),
      JSON.stringify(pluginBundle('plugin.one'))
    );
    await writeFile(
      join(root, 'plugins', 'two', 'worker.bundle.json'),
      JSON.stringify(pluginBundle('plugin.two'))
    );
    await writeFile(
      join(outside, 'worker.bundle.json'),
      JSON.stringify(pluginBundle('plugin.outside'))
    );

    const loaded = await loadPluginWorkerCapabilityManifests({
      baseDir: root,
      paths: [two, one],
    });
    expect(loaded.map(({ manifest }) => manifest.pluginId)).toEqual(['plugin.one', 'plugin.two']);
    expect(loaded[0]?.dynamicWorkerArtifact).toMatchObject({
      sourceBundlePath: 'plugins/one/worker.bundle.json',
      codeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      codeObjectKey: expect.stringMatching(/^plugins\/plugin\.one\/[a-f0-9]{64}\.json$/u),
    });

    await writeFile(two, JSON.stringify(pluginManifest('plugin.one')));
    await expect(
      loadPluginWorkerCapabilityManifests({ baseDir: root, paths: [one, two] })
    ).rejects.toThrow('duplicate_plugin_capability_manifest:plugin.one');
    await expect(
      loadPluginWorkerCapabilityManifests({ baseDir: root, paths: [outsidePath] })
    ).rejects.toThrow('external_capability_manifest_outside_project');
  });
});
