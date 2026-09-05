import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function migration(name: string): string {
  return readFileSync(resolve(REPO_ROOT, 'migrations/lookup', name), 'utf8')
    .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
    .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()');
}

describe('Lookup retention and OTP bucket migration', () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(migration('001_0_4_0_lookup_baseline.sql'));
  });

  afterEach(() => database.close());

  it('stores disabled aliases and challenges with exact virtual buckets', () => {
    database.exec(
      `INSERT INTO lookup_tenant_aliases (
         virtual_bucket, alias_kind, alias_sha256_digest, tenant_id, route_schema_version,
         route_projection_json, tenant_lifecycle_state, runtime_route_status,
         lifecycle_state, created_at, updated_at, disabled_at
       ) VALUES (
         41, 'tenant_slug', '${'a'.repeat(64)}', 'tenant-a', 1, '{}',
         'disabled', 'disabled', 'disabled', 100, 150, 150
       );
       INSERT INTO lookup_discovery_otp_challenges (
         challenge_id, normalization_version, email_blind_digest, hmac_key_generation,
         otp_verifier, delivery_state, attempt_count, attempt_limit, expires_at,
         consumed_at, created_at, updated_at, virtual_bucket
       ) VALUES (
         'discovery-41-1-00000000-0000-4000-8000-000000000001', 1,
         '${'b'.repeat(64)}', 1, '${'c'.repeat(64)}', 'sent', 0, 5, 1000, NULL, 100, 100, 41
       );`
    );

    expect(database.prepare(`SELECT disabled_at FROM lookup_tenant_aliases`).get()).toEqual({
      disabled_at: 150,
    });
    expect(
      database.prepare(`SELECT virtual_bucket FROM lookup_discovery_otp_challenges`).get()
    ).toEqual({ virtual_bucket: 41 });
    expect(() =>
      database.exec(
        `INSERT INTO lookup_discovery_otp_challenges (
           challenge_id, normalization_version, email_blind_digest, hmac_key_generation,
           otp_verifier, delivery_state, attempt_count, attempt_limit, expires_at,
           consumed_at, created_at, updated_at
         ) VALUES (
           'discovery-42-1-00000000-0000-4000-8000-000000000002', 1,
           '${'d'.repeat(64)}', 1, '${'e'.repeat(64)}', 'sent', 0, 5, 1000, NULL, 100, 100
         )`
      )
    ).toThrow(/lookup_discovery_otp_virtual_bucket_required/u);
  });

  it('fails closed when a challenge has no exact virtual bucket', () => {
    expect(() =>
      database.exec(
        `INSERT INTO lookup_discovery_otp_challenges (
           challenge_id, normalization_version, email_blind_digest, hmac_key_generation,
           otp_verifier, delivery_state, attempt_count, attempt_limit, expires_at,
           consumed_at, created_at, updated_at
         ) VALUES (
           'legacy-unclassifiable-challenge', 1, '${'f'.repeat(64)}', 1,
           '${'0'.repeat(64)}', 'sent', 0, 5, 1000, NULL, 100, 100
         )`
      )
    ).toThrow(/lookup_discovery_otp_virtual_bucket_required/u);
  });
});
