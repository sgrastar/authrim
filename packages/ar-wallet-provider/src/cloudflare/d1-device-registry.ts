/** `DeviceRegistry` on Cloudflare D1 (design section 6). Every state change is one statement. */

import type { DeviceRecord, DeviceRegistry, WalletProviderJwk } from '@authrim/ar-lib-core';
import { compareVersions } from '../domain/app-attest-policy';

interface Row {
  key_id: string;
  public_key_jwk: string;
  counter: number;
  environment: 'development' | 'production';
  validation_category: number | null;
  bundle_version: string | null;
  app_id_hash: string;
  attestation_sha256: string;
  challenge_sha256: string;
  receipt: string;
  last_bundle_version: string | null;
  last_validation_category: number | null;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  revoke_reason: string | null;
}

function toRecord(row: Row): DeviceRecord {
  const jwk = JSON.parse(row.public_key_jwk) as WalletProviderJwk;
  const record: DeviceRecord = {
    keyId: row.key_id,
    publicKeyJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    counter: row.counter,
    environment: row.environment,
    appIdHash: row.app_id_hash,
    attestationSha256: row.attestation_sha256,
    challengeSha256: row.challenge_sha256,
    receipt: row.receipt,
    createdAt: row.created_at,
  };
  if (row.validation_category !== null) record.validationCategory = row.validation_category;
  if (row.bundle_version !== null) record.bundleVersion = row.bundle_version;
  if (row.last_bundle_version !== null) record.lastBundleVersion = row.last_bundle_version;
  if (row.last_validation_category !== null) {
    record.lastValidationCategory = row.last_validation_category;
  }
  if (row.last_seen_at !== null) record.lastSeenAt = row.last_seen_at;
  if (row.revoked_at !== null) record.revokedAt = row.revoked_at;
  if (row.revoke_reason !== null) record.revokeReason = row.revoke_reason;
  return record;
}

export function createD1DeviceRegistry(db: D1Database): DeviceRegistry {
  async function get(keyId: string): Promise<DeviceRecord | null> {
    const row = await db
      .prepare('SELECT * FROM devices WHERE key_id = ?1')
      .bind(keyId)
      .first<Row>();
    return row ? toRecord(row) : null;
  }

  async function revoke(keyId: string, reason: string, at: number) {
    const done = await db
      .prepare(
        'UPDATE devices SET revoked_at = ?2, revoke_reason = ?3 WHERE key_id = ?1 AND revoked_at IS NULL'
      )
      .bind(keyId, at, reason)
      .run();
    if (done.meta.changes === 1) return 'revoked' as const;
    return (await get(keyId)) ? ('already' as const) : ('unknown' as const);
  }

  return {
    get,
    revoke,

    async register(record) {
      const inserted = await db
        .prepare(
          `INSERT INTO devices (key_id, public_key_jwk, counter, environment, validation_category,
             bundle_version, app_id_hash, attestation_sha256, challenge_sha256, receipt,
             last_bundle_version, last_validation_category, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?6, ?5, ?11)
           ON CONFLICT DO NOTHING`
        )
        .bind(
          record.keyId,
          JSON.stringify(record.publicKeyJwk),
          record.counter,
          record.environment,
          record.validationCategory ?? null,
          record.bundleVersion ?? null,
          record.appIdHash,
          record.attestationSha256,
          record.challengeSha256,
          record.receipt,
          record.createdAt
        )
        .run();
      if (inserted.meta.changes === 1) return 'created';
      const existing = await get(record.keyId);
      if (!existing) return 'challenge_used';
      return existing.attestationSha256 === record.attestationSha256 &&
        existing.challengeSha256 === record.challengeSha256
        ? 'same'
        : 'conflict';
    },

    async advanceCounter(keyId, next, seen, at) {
      const done = await db
        .prepare(
          `UPDATE devices SET counter = ?2, last_seen_at = ?3,
             last_bundle_version = COALESCE(?4, last_bundle_version),
             last_validation_category = COALESCE(?5, last_validation_category)
           WHERE key_id = ?1 AND counter < ?2 AND revoked_at IS NULL`
        )
        .bind(keyId, next, at, seen.bundleVersion ?? null, seen.validationCategory ?? null)
        .run();
      if (done.meta.changes === 1) return 'advanced';
      const current = await get(keyId);
      if (!current) return 'unknown';
      return current.revokedAt !== undefined ? 'revoked' : 'not_greater';
    },

    async revokeWhere(filter, reason, at) {
      // Light columns only (no receipt), read in pages; updates go out in batches. A failure in
      // the middle leaves some devices revoked: the operation is safe to run again.
      const matches: string[] = [];
      let after = '';
      for (;;) {
        const page = await db
          .prepare(
            `SELECT key_id, last_bundle_version, last_validation_category, created_at
             FROM devices WHERE revoked_at IS NULL AND key_id > ?1 ORDER BY key_id LIMIT 500`
          )
          .bind(after)
          .all<{
            key_id: string;
            last_bundle_version: string | null;
            last_validation_category: number | null;
            created_at: number;
          }>();
        for (const row of page.results) {
          const known = row.last_bundle_version !== null || row.last_validation_category !== null;
          if (!known && !filter.includeUnknownBuild) continue;
          if (filter.createdBefore !== undefined && !(row.created_at < filter.createdBefore)) {
            continue;
          }
          if (
            filter.lastValidationCategory !== undefined &&
            row.last_validation_category !== filter.lastValidationCategory
          ) {
            continue;
          }
          if (filter.lastBundleVersionLt !== undefined) {
            const order = row.last_bundle_version
              ? compareVersions(row.last_bundle_version, filter.lastBundleVersionLt)
              : null;
            if (order === null ? !filter.includeUnknownBuild : order >= 0) continue;
          }
          matches.push(row.key_id);
        }
        if (page.results.length < 500) break;
        after = page.results[page.results.length - 1].key_id;
      }
      let count = 0;
      for (let start = 0; start < matches.length; start += 50) {
        const results = await db.batch(
          matches
            .slice(start, start + 50)
            .map((id) =>
              db
                .prepare(
                  'UPDATE devices SET revoked_at = ?2, revoke_reason = ?3 WHERE key_id = ?1 AND revoked_at IS NULL'
                )
                .bind(id, at, reason)
            )
        );
        count += results.reduce((sum, r) => sum + r.meta.changes, 0);
      }
      return count;
    },

    async touch(keyId, at) {
      await db
        .prepare('UPDATE devices SET last_seen_at = ?2 WHERE key_id = ?1')
        .bind(keyId, at)
        .run();
    },
  };
}
