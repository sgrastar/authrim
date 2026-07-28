import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function migration(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function controlDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(migration('migrations/control/001_control_plane.sql'));
  db.exec(
    `INSERT INTO control_environments (
       environment_id, environment_name, issuer, created_at, updated_at
     ) VALUES (
       'env-1', 'test', 'urn:authrim:control:env-1', 1, 1
     );
     INSERT INTO control_operations (
       operation_id, environment_id, operation_kind, idempotency_key,
       requested_by_type, created_at, updated_at
     ) VALUES (
       'op-1', 'env-1', 'bootstrap', 'bootstrap-1', 'setup', 1, 1
     );
     INSERT INTO control_environment_resource_policies (
       environment_id, max_concurrent_provisioning, max_ready_spares,
       max_d1_resources, daily_d1_create_budget, target_account_count,
       created_at, updated_at
     ) VALUES (
       'env-1', 2, 2, 1000, 20, 100000, 1, 1
     );`
  );
  return db;
}

describe('Control D1 schema', () => {
  it('enforces desired resource identity and operation idempotency', () => {
    const db = controlDatabase();
    db.exec(
      `INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, origin_operation_id, created_at, updated_at
       ) VALUES ('r-1', 'env-1', 'd1', 'core-users-1', 'test-core-users-1', 'fp-1', 'op-1', 1, 1);`
    );
    expect(() =>
      db.exec(
        `INSERT INTO control_desired_resources (
           desired_resource_id, environment_id, resource_kind, logical_shard_id,
           deterministic_name, ownership_fingerprint, origin_operation_id, created_at, updated_at
         ) VALUES ('r-2', 'env-1', 'd1', 'core-users-1', 'different-name', 'fp-2', 'op-1', 1, 1);`
      )
    ).toThrow();
    expect(() =>
      db.exec(
        `INSERT INTO control_operations (
           operation_id, environment_id, operation_kind, idempotency_key,
           requested_by_type, created_at, updated_at
         ) VALUES ('op-2', 'env-1', 'retry', 'bootstrap-1', 'scheduler', 1, 1);`
      )
    ).toThrow();
    db.close();
  });

  it('rejects invalid handoff, release, rewrite, and signing-key states', () => {
    const db = controlDatabase();
    expect(() =>
      db.exec(
        `INSERT INTO control_bootstrap_handoffs (
           environment_id, state, ownership_fingerprint, release_manifest_digest, updated_at
         ) VALUES ('env-1', 'accepted', 'fp', '${'a'.repeat(64)}', 1);`
      )
    ).toThrow();

    db.exec(
      `INSERT INTO control_migration_release_catalog (
         environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
         state, registered_by_operation_id, registered_at
       ) VALUES ('env-1', 'd1-control', 'release-1', '${'a'.repeat(64)}', 'releases/1.json', 'active', 'op-1', 1);`
    );
    expect(() =>
      db.exec(
        `INSERT INTO control_migration_release_catalog (
           environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
           state, registered_by_operation_id, registered_at
         ) VALUES ('env-1', 'd1-control', 'release-2', '${'b'.repeat(64)}', 'releases/2.json', 'active', 'op-1', 1);`
      )
    ).toThrow();
    expect(() =>
      db.exec(
        `UPDATE control_migration_release_catalog
            SET manifest_digest = '${'c'.repeat(64)}'
          WHERE environment_id = 'env-1' AND stream_id = 'd1-control' AND release_id = 'release-1';`
      )
    ).toThrow('control_release_catalog_immutable');
    db.exec(
      `INSERT INTO control_operation_release_pins (
         operation_id, environment_id, stream_id, release_id, manifest_digest, pinned_at
       ) VALUES ('op-1', 'env-1', 'd1-control', 'release-1', '${'a'.repeat(64)}', 1);`
    );
    expect(() =>
      db.exec(
        `UPDATE control_operation_release_pins SET release_id = 'release-2'
          WHERE operation_id = 'op-1' AND stream_id = 'd1-control';`
      )
    ).toThrow('control_operation_release_pin_immutable');

    db.exec(
      `INSERT INTO control_directory_rewrite_leases (
         environment_id, operation_id, operation_kind, owner_id, fencing_token,
         lease_expires_at, updated_at
       ) VALUES ('env-1', 'op-1', 'hmac_reindex', 'worker-a', 1, 100, 1);`
    );
    expect(() =>
      db.exec(
        `INSERT INTO control_directory_rewrite_leases (
           environment_id, operation_id, operation_kind, owner_id, fencing_token,
           lease_expires_at, updated_at
         ) VALUES ('env-1', 'op-1', 'lookup_bucket_migration', 'worker-b', 2, 100, 1);`
      )
    ).toThrow();

    db.exec(
      `INSERT INTO control_signing_key_metadata (
         environment_id, key_purpose, slot, key_id, public_jwk_json,
         public_key_fingerprint, state, updated_at
       ) VALUES ('env-1', 'smoke_rpc', 'a', 'smoke-a', '{}', 'fp-a', 'active', 1);`
    );
    expect(() =>
      db.exec(
        `INSERT INTO control_signing_key_metadata (
           environment_id, key_purpose, slot, key_id, public_jwk_json,
           public_key_fingerprint, state, updated_at
         ) VALUES ('env-1', 'smoke_rpc', 'b', 'smoke-b', '{}', 'fp-b', 'active', 1);`
      )
    ).toThrow();
    db.close();
  });

  it('contains no columns capable of storing provider tokens or private signing keys', () => {
    const db = controlDatabase();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const columnNames = tables.flatMap((table) =>
      (db.prepare(`PRAGMA table_info(${table.name})`).all() as Array<{ name: string }>).map(
        (column) => column.name.toLowerCase()
      )
    );
    expect(
      columnNames.some((name) => /api_token|private_jwk|hmac_key_body|raw_email/.test(name))
    ).toBe(false);
    db.close();
  });

  it('rejects D1 desired resources when the environment resource cap is reached', () => {
    const db = controlDatabase();
    db.exec(
      `UPDATE control_environment_resource_policies SET max_d1_resources = 1
        WHERE environment_id = 'env-1';
       INSERT INTO control_desired_resources (
         desired_resource_id, environment_id, resource_kind, logical_shard_id,
         deterministic_name, ownership_fingerprint, origin_operation_id, created_at, updated_at
       ) VALUES ('r-1', 'env-1', 'd1', 'core-1', 'test-core-1', 'fp-1', 'op-1', 1, 1);`
    );
    expect(() =>
      db.exec(
        `INSERT INTO control_desired_resources (
           desired_resource_id, environment_id, resource_kind, logical_shard_id,
           deterministic_name, ownership_fingerprint, origin_operation_id, created_at, updated_at
         ) VALUES ('r-2', 'env-1', 'd1', 'core-2', 'test-core-2', 'fp-2', 'op-1', 1, 1);`
      )
    ).toThrow('control_d1_resource_limit');
    db.close();
  });
});

describe('Lookup D1 schema', () => {
  it('enforces the three-state activation gate and tenant-scoped uniqueness authority', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(migration('migrations/lookup/001_lookup_directory.sql'));
    const identifierSql = `INSERT INTO lookup_identifiers (
      virtual_bucket, index_kind, normalization_version, hmac_key_generation,
      identifier_blind_digest, tenant_id, account_id, route_schema_version,
      account_route_generation, required_binding_route_generation, residency_policy_id,
      route_projection_json, tenant_lifecycle_state, runtime_route_status, lifecycle_state,
      created_at, updated_at
    ) VALUES (1, 'email_exact', 1, 1, 'digest', 'tenant-1', 'account-1', 1, 1, 1,
      'residency-1', '{}', 'creating', 'pending', 'active', 1, 1);`;
    expect(() => db.exec(identifierSql)).toThrow();

    db.exec(
      identifierSql.replace("'creating', 'pending'", "'active', 'active'") +
        `INSERT INTO lookup_identifier_reservations (
          virtual_bucket, tenant_id, index_kind, normalization_version, hmac_key_generation,
          identifier_blind_digest, account_id, operation_id, created_at, updated_at
        ) VALUES (1, 'tenant-1', 'email_exact', 1, 1, 'digest', 'account-1', 'op-1', 1, 1);`
    );
    expect(() =>
      db.exec(
        `INSERT INTO lookup_identifier_reservations (
          virtual_bucket, tenant_id, index_kind, normalization_version, hmac_key_generation,
          identifier_blind_digest, account_id, operation_id, created_at, updated_at
        ) VALUES (1, 'tenant-1', 'email_exact', 1, 1, 'digest', 'account-2', 'op-2', 1, 1);`
      )
    ).toThrow();
    db.close();
  });

  it('stores discovery challenges without raw email or domain indexes', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(migration('migrations/lookup/001_lookup_directory.sql'));
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table'").all() as Array<{
      sql: string;
    }>;
    const serialized = schema
      .map((row) => row.sql)
      .join('\n')
      .toLowerCase();
    expect(serialized).not.toContain('raw_email');
    expect(serialized).not.toContain('email_domain');
    expect(serialized).toContain('email_blind_digest');
    db.close();
  });
});

describe('tenant and plugin outbox schemas', () => {
  it('keeps account routing and plugin delivery separate and fixes retention periods', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      `PRAGMA foreign_keys = ON;
       CREATE TABLE identity_accounts (
         id TEXT PRIMARY KEY,
         tenant_id TEXT NOT NULL,
         created_at INTEGER NOT NULL
       );`
    );
    db.exec(migration('migrations/032_tenant_directory_and_plugin_outboxes.sql'));
    db.exec(
      `INSERT INTO plugin_hook_outbox (
         outbox_id, tenant_id, plugin_installation_id, capability, event_type,
         event_version, idempotency_key, payload_json, status, created_at,
         succeeded_at, delete_after, updated_at
       ) VALUES ('outbox-1', 'tenant-1', 'plugin-1', 'after_create', 'account.created',
         1, 'idem-1', '{}', 'succeeded', 1, 10, 604810, 10);`
    );
    expect(() =>
      db.exec(
        `INSERT INTO plugin_hook_outbox (
           outbox_id, tenant_id, plugin_installation_id, capability, event_type,
           event_version, idempotency_key, payload_json, status, created_at,
           dead_lettered_at, delete_after, updated_at
         ) VALUES ('outbox-2', 'tenant-1', 'plugin-1', 'after_create', 'account.created',
           1, 'idem-2', '{}', 'dead_letter', 1, 10, 100, 10);`
      )
    ).toThrow();
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%outbox'")
        .all()
    ).toHaveLength(3);
    db.close();
  });

  it('rejects overly broad plugin egress suffix wildcards', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(migration('migrations/plugin-runner/001_plugin_runner.sql'));
    expect(() =>
      db.exec(
        `INSERT INTO plugin_runner_egress_allowed_hosts (
           plugin_id, rule_id, match_kind, host_pattern, created_at
         ) VALUES ('plugin-1', 'rule-1', 'suffix_wildcard', '*.com', 1);`
      )
    ).toThrow();
    db.exec(
      `INSERT INTO plugin_runner_egress_allowed_hosts (
         plugin_id, rule_id, match_kind, host_pattern, created_at
       ) VALUES ('plugin-1', 'rule-2', 'suffix_wildcard', '*.example.com', 1);`
    );
    db.close();
  });
});
