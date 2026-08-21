import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of ['001_pre_1_0_plugin_runner_baseline.sql']) {
    db.exec(readFileSync(resolve(REPO_ROOT, 'migrations/plugin-runner', migration), 'utf8'));
  }
  db.exec(
    `INSERT INTO plugin_runner_installations (
       installation_id, tenant_id, plugin_id, backend_kind, script_name,
       state, config_version, platform_concurrency_cap, platform_rate_per_minute,
       created_at, updated_at
     ) VALUES (
       'installation-a', 'tenant-a', 'plugin-a', 'dynamic_worker', 'plugin-a',
       'enabled', 1, 2, 30, 1, 1
     );`
  );
  return db;
}

function insertArtifact(db: DatabaseSync, suffix: string, state: 'pending' | 'active'): void {
  const digest = suffix.repeat(64);
  const objectKey = `plugins/plugin-a/${digest}.json`;
  db.prepare(
    `INSERT INTO plugin_runner_dynamic_worker_releases (
       plugin_id, version_digest, code_sha256, code_object_key, source_manifest_hash,
       capability_manifest_digest, policy_json, state, published_at, updated_at
     ) VALUES ('plugin-a', ?, ?, ?, ?, ?, '{}', 'published', 1, 1)`
  ).run(digest, digest, objectKey, 'd'.repeat(64), 'e'.repeat(64));
  db.prepare(
    `INSERT INTO plugin_runner_dynamic_worker_manifests (
       plugin_id, active_version_digest, state, updated_at
     ) VALUES ('plugin-a', ?, 'active', 1)
     ON CONFLICT(plugin_id) DO UPDATE SET
       active_version_digest = excluded.active_version_digest,
       state = 'active', updated_at = excluded.updated_at`
  ).run(digest);
  db.prepare(
    `INSERT INTO plugin_runner_dynamic_worker_artifacts (
       artifact_id, installation_id, plugin_id, version_digest,
       state, activated_at, updated_at
     ) VALUES (?, 'installation-a', 'plugin-a', ?, ?, ?, 1)`
  ).run(`artifact-${suffix}`, digest, state, state === 'active' ? 1 : null);
}

describe('Dynamic Worker artifact schema', () => {
  it('keeps one active version while retaining pending and retired versions', () => {
    const db = database();
    insertArtifact(db, 'a', 'active');
    insertArtifact(db, 'b', 'pending');
    expect(() =>
      db.exec(
        `UPDATE plugin_runner_dynamic_worker_artifacts
            SET state = 'active', activated_at = 2
          WHERE artifact_id = 'artifact-b';`
      )
    ).toThrow();

    db.exec(
      `UPDATE plugin_runner_dynamic_worker_artifacts
          SET state = 'retired', activated_at = NULL, updated_at = 2
        WHERE artifact_id = 'artifact-a';
       UPDATE plugin_runner_dynamic_worker_artifacts
          SET state = 'active', activated_at = 2, updated_at = 2
        WHERE artifact_id = 'artifact-b';`
    );
    expect(
      db
        .prepare(
          `SELECT artifact_id FROM plugin_runner_dynamic_worker_artifacts
            WHERE installation_id = 'installation-a' AND state = 'active'`
        )
        .get()
    ).toEqual({ artifact_id: 'artifact-b' });
    db.close();
  });

  it('rejects wrong-plugin ownership and immutable identity changes', () => {
    const db = database();
    insertArtifact(db, 'a', 'active');
    expect(() =>
      db.exec(
        `UPDATE plugin_runner_dynamic_worker_artifacts
            SET version_digest = '${'b'.repeat(64)}'
          WHERE artifact_id = 'artifact-a';`
      )
    ).toThrow('plugin_worker_artifact_identity_immutable');
    expect(() =>
      db.exec(
        `INSERT INTO plugin_runner_dynamic_worker_releases (
           plugin_id, version_digest, code_sha256, code_object_key, source_manifest_hash,
           capability_manifest_digest, policy_json, state, published_at, updated_at
         ) VALUES (
           'plugin-b', '${'c'.repeat(64)}', '${'c'.repeat(64)}',
           'plugins/plugin-b/${'c'.repeat(64)}.json', '${'d'.repeat(64)}',
           '${'e'.repeat(64)}', '{}', 'published', 1, 1
         );
         INSERT INTO plugin_runner_dynamic_worker_artifacts (
           artifact_id, installation_id, plugin_id, version_digest,
           state, activated_at, updated_at
         ) VALUES (
           'artifact-wrong', 'installation-a', 'plugin-b', '${'c'.repeat(64)}', 'active', 1, 1
         );`
      )
    ).toThrow('plugin_worker_artifact_installation_mismatch');
    db.close();
  });
});
