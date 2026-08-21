import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildExternalCapabilityRegistrationPlan,
  registerExternalCapabilities,
} from '../core/external-capability-registration.js';
import type { AggregatedExternalCapabilitySource } from '../core/external-capabilities.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function extension(hash = 'a'.repeat(64)): AggregatedExternalCapabilitySource {
  return {
    sourceKind: 'extension_manifest',
    sourceId: 'example.extension',
    sourceManifestPath: 'authrim.extension-capabilities.json',
    sourceManifestHash: hash,
    capabilityManifestDigest: 'b'.repeat(64),
    provenance: {
      owner: 'Example team',
      source: 'packages/example',
      scope: 'tenant',
      reason: 'Connect the application.',
    },
    pluginPolicy: null,
    workers: [
      {
        workerReference: 'test-example-extension',
        scriptName: 'test-example-extension',
        bindings: [
          {
            name: 'EXAMPLE_API_KEY',
            kind: 'secret',
            capability: 'example.call',
            scope: 'tenant',
            reason: 'Call the example service.',
          },
        ],
      },
    ],
  };
}

function plugin(): AggregatedExternalCapabilitySource {
  return {
    sourceKind: 'plugin_manifest',
    sourceId: 'example.plugin',
    sourceManifestPath: 'plugins/example/authrim.plugin-worker-capabilities.json',
    sourceManifestHash: 'c'.repeat(64),
    capabilityManifestDigest: 'd'.repeat(64),
    provenance: null,
    pluginPolicy: {
      backend: 'dynamic_worker',
      resourceScope: 'tenant',
      visibility: 'tenant',
      capabilities: [],
      credentials: [],
      egressAllowedHosts: [{ kind: 'exact', host: 'api.example.com' }],
      workerArtifact: {
        sourceBundlePath: 'plugins/example/worker.bundle.json',
        codeSha256: 'e'.repeat(64),
        codeObjectKey: `plugins/example.plugin/${'e'.repeat(64)}.json`,
        size: 128,
      },
    },
    workers: [
      {
        workerReference: 'plugin:example.plugin',
        scriptName: null,
        bindings: [
          {
            name: 'PLUGIN_ACCESS',
            kind: 'plugin_interface',
            capability: 'ExamplePluginAccess',
            scope: 'tenant',
            reason: null,
          },
        ],
      },
    ],
  };
}

function controlDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(
    readFileSync(resolve(REPO_ROOT, 'migrations/control/001_pre_1_0_control_baseline.sql'), 'utf8')
  );
  database.exec(
    `INSERT INTO control_environments (
       environment_id, environment_name, issuer, created_at, updated_at
     ) VALUES ('env-test', 'test', 'urn:authrim:control:env-test', 1, 1);`
  );
  return database;
}

describe('external capability registration', () => {
  it('auto-registers extension inventory but keeps plugin Workers unresolved', async () => {
    const database = controlDatabase();
    await registerExternalCapabilities({
      controlDatabaseName: 'test-control',
      environmentId: 'env-test',
      sources: [extension(), plugin()],
      registeredBy: 'setup:test',
      now: 100,
      execute: async (_name, sql) => {
        database.exec(sql);
        return { stdout: '', stderr: '' };
      },
    });

    expect(
      database
        .prepare(
          `SELECT source_kind, source_id, review_state, status
             FROM control_external_capability_sources ORDER BY source_kind`
        )
        .all()
    ).toEqual([
      {
        source_kind: 'extension_manifest',
        source_id: 'example.extension',
        review_state: 'auto_registered',
        status: 'active',
      },
      {
        source_kind: 'plugin_manifest',
        source_id: 'example.plugin',
        review_state: 'auto_registered',
        status: 'active',
      },
    ]);
    expect(
      database.prepare(`SELECT worker_script_name FROM control_desired_worker_inventory`).all()
    ).toEqual([{ worker_script_name: 'test-example-extension' }]);
    expect(
      database.prepare(`SELECT binding_name FROM control_external_capability_bindings`).all()
    ).toEqual([{ binding_name: 'EXAMPLE_API_KEY' }, { binding_name: 'PLUGIN_ACCESS' }]);
    expect(
      JSON.stringify(
        database.prepare(`SELECT aggregate_json FROM control_external_capability_sources`).all()
      )
    ).not.toContain('secretValue');
    database.close();
  });

  it('preserves review for identical bytes, resets changed bytes, and disables removed sources', () => {
    const database = controlDatabase();
    const first = buildExternalCapabilityRegistrationPlan({
      environmentId: 'env-test',
      sources: [extension()],
      registeredBy: 'setup:test',
      now: 100,
    });
    database.exec(first.sql);
    database.exec(
      `UPDATE control_external_capability_sources
          SET review_state = 'approved', reviewed_by = 'reviewer', reviewed_at = 110
        WHERE source_id = 'example.extension';`
    );
    const same = buildExternalCapabilityRegistrationPlan({
      environmentId: 'env-test',
      sources: [extension()],
      registeredBy: 'setup:test',
      now: 120,
    });
    database.exec(same.sql);
    expect(
      database.prepare(`SELECT review_state FROM control_external_capability_sources`).get()
    ).toEqual({ review_state: 'approved' });

    const changed = buildExternalCapabilityRegistrationPlan({
      environmentId: 'env-test',
      sources: [extension('e'.repeat(64))],
      registeredBy: 'setup:test',
      now: 130,
    });
    database.exec(changed.sql);
    expect(
      database.prepare(`SELECT review_state FROM control_external_capability_sources`).get()
    ).toEqual({ review_state: 'auto_registered' });

    const removed = buildExternalCapabilityRegistrationPlan({
      environmentId: 'env-test',
      sources: [],
      registeredBy: 'setup:test',
      now: 140,
    });
    database.exec(removed.sql);
    expect(
      database.prepare(`SELECT status FROM control_external_capability_sources`).get()
    ).toEqual({ status: 'disabled' });
    expect(database.prepare(`SELECT status FROM control_desired_worker_inventory`).get()).toEqual({
      status: 'disabled',
    });
    database.close();
  });

  it('rejects duplicate sources before database access', () => {
    expect(() =>
      buildExternalCapabilityRegistrationPlan({
        environmentId: 'env-test',
        sources: [extension(), extension()],
        registeredBy: 'setup:test',
        now: 100,
      })
    ).toThrow('duplicate_external_capability_source');
  });
});
