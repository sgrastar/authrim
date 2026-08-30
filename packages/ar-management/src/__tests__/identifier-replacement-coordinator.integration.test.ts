import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createD1Adapter, type LookupBlindIndex } from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IdentifierReplacementCoordinator,
  isPermanentIdentifierReplacementFailure,
} from '../identifier-replacement-coordinator';
import { IdentifierReplacementOperationRepository } from '../identifier-replacement-operation';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const NOW = 1_100;
const OLD_HASH = 'a'.repeat(64);
const NEW_HASH = 'b'.repeat(64);
const OLD_CURRENT = '1'.repeat(64);
const OLD_PREVIOUS = '2'.repeat(64);
const NEW_CURRENT = '3'.repeat(64);
const NEW_PREVIOUS = '4'.repeat(64);

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return { success: true, results: this.statement.all(...this.values) as T[], meta: {} };
  }

  async run<T>() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [] as T[], meta: { changes: Number(result.changes) } };
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(
      this.statement,
      values.map((value) => {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          value === null ||
          value instanceof Uint8Array
        ) {
          return value;
        }
        throw new Error('unsupported_test_sqlite_value');
      })
    );
  }
}

function d1(database: DatabaseSync): D1Database {
  const session = {
    prepare: (sql: string) => new PreparedStatement(database.prepare(sql)),
    async batch<T>(statements: BoundStatement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run<T>());
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    getBookmark: () => 'bookmark',
  };
  return { ...session, withSession: () => session } as unknown as D1Database;
}

function index(
  generation: number,
  digest: string,
  bucket: number,
  indexKind: LookupBlindIndex['indexKind'] = 'email_exact'
): LookupBlindIndex {
  return {
    indexKind,
    normalizationVersion: 1,
    hmacKeyGeneration: generation,
    digest,
    virtualBucket: bucket,
  };
}

describe('IdentifierReplacementCoordinator', () => {
  let pii: DatabaseSync;
  let oldLookup: DatabaseSync;
  let newLookup: DatabaseSync;
  let repository: IdentifierReplacementOperationRepository;
  const revokeCredentials = vi.fn(async () => {});

  beforeEach(async () => {
    revokeCredentials.mockClear();
    pii = new DatabaseSync(':memory:');
    oldLookup = new DatabaseSync(':memory:');
    newLookup = new DatabaseSync(':memory:');
    pii.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/pii/001_pre_1_0_pii_baseline.sql'), 'utf8')
    );
    for (const database of [oldLookup, newLookup]) {
      database.exec(
        readFileSync(
          resolve(REPO_ROOT, 'migrations/lookup/001_pre_1_0_lookup_baseline.sql'),
          'utf8'
        )
          .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
          .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
      );
      database.exec(
        readFileSync(
          resolve(REPO_ROOT, 'migrations/lookup/002_lookup_scale_out_publication_metrics.sql'),
          'utf8'
        )
      );
    }
    pii
      .prepare(
        `INSERT INTO identity_sensitive_values (
           id, tenant_id, owner_type, owner_id, value_key, value_json,
           classification, lifecycle_state, created_at, updated_at
         ) VALUES ('email-1', 'tenant-a', 'runtime_user', 'account-a', 'email', ?,
                   'sensitive', 'active', 900, 900)`
      )
      .run(JSON.stringify('old@example.test'));
    pii
      .prepare(
        `INSERT INTO identity_identifier_replacement_challenges (
           challenge_id, tenant_id, account_id, identifier_kind, normalized_value_json,
           value_sha256, otp_verifier, delivery_state, attempt_limit, expires_at, consumed_at,
           initiating_session_ref, recent_reauth_verified_at, created_at, updated_at
         ) VALUES ('challenge-1', 'tenant-a', 'account-a', 'email_exact', ?, ?, ?, 'sent', 5,
                   1500, 1050, 'session-a', 900, 1000, 1050)`
      )
      .run(JSON.stringify('new@example.test'), NEW_HASH, 'e'.repeat(64));
    const oldIndexes = [index(8, OLD_CURRENT, 10), index(7, OLD_PREVIOUS, 11)];
    for (const oldIndex of oldIndexes) {
      oldLookup
        .prepare(
          `INSERT INTO lookup_identifiers (
             virtual_bucket, index_kind, normalization_version, hmac_key_generation,
             identifier_blind_digest, tenant_id, account_id, route_schema_version,
             account_route_generation, required_binding_route_generation, residency_policy_id,
             route_projection_json, tenant_lifecycle_state, runtime_route_status,
             lifecycle_state, created_at, updated_at
           ) VALUES (?, 'email_exact', 1, ?, ?, 'tenant-a', 'account:account-a', 1, 1, 1,
                     'global', '{}', 'active', 'active', 'active', 900, 900)`
        )
        .run(oldIndex.virtualBucket, oldIndex.hmacKeyGeneration, oldIndex.digest);
      oldLookup
        .prepare(
          `INSERT INTO lookup_identifier_reservations (
             virtual_bucket, tenant_id, index_kind, normalization_version,
             hmac_key_generation, identifier_blind_digest, account_id,
             reservation_state, operation_id, created_at, committed_at, updated_at
           ) VALUES (?, 'tenant-a', 'email_exact', 1, ?, ?, 'account:account-a',
                     'committed', 'account-create-1', 900, 900, 900)`
        )
        .run(oldIndex.virtualBucket, oldIndex.hmacKeyGeneration, oldIndex.digest);
    }
    repository = new IdentifierReplacementOperationRepository(
      createD1Adapter(d1(pii), 'pii'),
      () => NOW
    );
    await repository.create({
      operationId: 'replacement-1',
      outboxId: 'outbox-1',
      tenantId: 'tenant-a',
      accountId: 'account-a',
      authority: 'self_service',
      actorRef: 'account-a',
      idempotencyKeySha256: 'c'.repeat(64),
      requestFingerprintSha256: 'd'.repeat(64),
      challengeId: 'challenge-1',
      initiatingSessionRef: 'session-a',
      oldValue: 'old@example.test',
      newValue: 'new@example.test',
      oldValueSha256: OLD_HASH,
      newValueSha256: NEW_HASH,
      oldIndexes,
      newIndexes: [index(8, NEW_CURRENT, 12), index(7, NEW_PREVIOUS, 13)],
      authorityEvidence: { authority: 'account_session' },
      verificationEvidence: { method: 'email_otp', verifiedAt: 1050 },
    });
  });

  afterEach(() => {
    pii.close();
    oldLookup.close();
    newLookup.close();
  });

  function coordinator(
    revoke = revokeCredentials,
    enqueueOldIdentifierNotification?: (input: {
      operationId: string;
      tenantId: string;
      accountId: string;
      oldValue: string;
    }) => Promise<void>
  ) {
    return new IdentifierReplacementCoordinator({
      pii: createD1Adapter(d1(pii), 'pii'),
      lookupForBucket: async (bucket) => d1(bucket < 12 ? oldLookup : newLookup),
      revokeCredentials: revoke,
      enqueueOldIdentifierNotification,
      now: () => NOW,
    });
  }

  it('classifies integrity and reservation failures separately from runtime outages', () => {
    expect(
      isPermanentIdentifierReplacementFailure(
        new Error('identifier_replacement_reservation_conflict')
      )
    ).toBe(true);
    expect(isPermanentIdentifierReplacementFailure(new Error('binding_unavailable'))).toBe(false);
  });

  it('switches PII in place and converges both HMAC generations before completion', async () => {
    await expect(
      coordinator().resume({
        operationId: 'replacement-1',
        tenantId: 'tenant-a',
        accountId: 'account-a',
      })
    ).resolves.toEqual({ state: 'completed' });
    expect(
      pii.prepare(`SELECT value_json FROM identity_sensitive_values WHERE id = 'email-1'`).get()
    ).toEqual({ value_json: JSON.stringify('new@example.test') });
    expect(
      oldLookup
        .prepare(`SELECT DISTINCT lifecycle_state FROM lookup_identifiers ORDER BY lifecycle_state`)
        .all()
    ).toEqual([{ lifecycle_state: 'disabled' }]);
    expect(
      newLookup
        .prepare(`SELECT DISTINCT lifecycle_state FROM lookup_identifiers ORDER BY lifecycle_state`)
        .all()
    ).toEqual([{ lifecycle_state: 'active' }]);
    expect(
      newLookup.prepare(`SELECT DISTINCT gate_state FROM lookup_identifier_replacements`).all()
    ).toEqual([{ gate_state: 'completed' }]);
    expect(
      oldLookup
        .prepare(`SELECT DISTINCT reservation_state FROM lookup_identifier_reservations`)
        .all()
    ).toEqual([{ reservation_state: 'released' }]);
    expect(revokeCredentials).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      accountId: 'account-a',
      initiatingSessionRef: 'session-a',
    });
    expect(
      newLookup
        .prepare(
          `SELECT SUM(successful_route_publication_count) AS count
             FROM lookup_bucket_counters`
        )
        .get()
    ).toEqual({ count: 2 });

    await coordinator().resume({
      operationId: 'replacement-1',
      tenantId: 'tenant-a',
      accountId: 'account-a',
    });
    expect(revokeCredentials).toHaveBeenCalledTimes(1);
    expect(
      newLookup
        .prepare(
          `SELECT SUM(successful_route_publication_count) AS count
             FROM lookup_bucket_counters`
        )
        .get()
    ).toEqual({ count: 2 });
  });

  it('does not disable the old route when the new bucket publication counter is missing', async () => {
    newLookup.prepare(`DELETE FROM lookup_bucket_counters WHERE virtual_bucket = 12`).run();

    await expect(
      coordinator().resume({
        operationId: 'replacement-1',
        tenantId: 'tenant-a',
        accountId: 'account-a',
      })
    ).rejects.toThrow('identifier_replacement_publication_counter_missing');
    expect(
      oldLookup
        .prepare(`SELECT DISTINCT lifecycle_state FROM lookup_identifiers ORDER BY lifecycle_state`)
        .all()
    ).toEqual([{ lifecycle_state: 'active' }]);
  });

  it('replaces a SCIM userName external subject and skips the email notification', async () => {
    pii
      .prepare(
        `INSERT INTO identity_sensitive_values (
           id, tenant_id, owner_type, owner_id, value_key, value_json,
           classification, lifecycle_state, created_at, updated_at
         ) VALUES ('username-1', 'tenant-a', 'runtime_user', 'account-a',
                   'preferred_username', ?, 'sensitive', 'active', 900, 900)`
      )
      .run(JSON.stringify('OldUser'));
    const oldIndexes = [
      index(8, '5'.repeat(64), 8, 'external_subject'),
      index(7, '6'.repeat(64), 9, 'external_subject'),
    ];
    for (const oldIndex of oldIndexes) {
      oldLookup
        .prepare(
          `INSERT INTO lookup_identifiers (
             virtual_bucket, index_kind, normalization_version, hmac_key_generation,
             identifier_blind_digest, tenant_id, account_id, route_schema_version,
             account_route_generation, required_binding_route_generation, residency_policy_id,
             route_projection_json, tenant_lifecycle_state, runtime_route_status,
             lifecycle_state, created_at, updated_at
           ) VALUES (?, 'external_subject', 1, ?, ?, 'tenant-a', 'account:account-a', 1, 1, 1,
                     'global', '{}', 'active', 'active', 'active', 900, 900)`
        )
        .run(oldIndex.virtualBucket, oldIndex.hmacKeyGeneration, oldIndex.digest);
      oldLookup
        .prepare(
          `INSERT INTO lookup_identifier_reservations (
             virtual_bucket, tenant_id, index_kind, normalization_version,
             hmac_key_generation, identifier_blind_digest, account_id,
             reservation_state, operation_id, created_at, committed_at, updated_at
           ) VALUES (?, 'tenant-a', 'external_subject', 1, ?, ?, 'account:account-a',
                     'committed', 'account-create-username', 900, 900, 900)`
        )
        .run(oldIndex.virtualBucket, oldIndex.hmacKeyGeneration, oldIndex.digest);
    }
    await repository.create({
      operationId: 'username-replacement-1',
      outboxId: 'username-outbox-1',
      tenantId: 'tenant-a',
      accountId: 'account-a',
      authority: 'scim',
      identifierKind: 'external_subject',
      actorRef: 'scim-token:test',
      idempotencyKeySha256: 'e'.repeat(64),
      requestFingerprintSha256: 'f'.repeat(64),
      oldValue: 'OldUser',
      newValue: 'NewUser',
      oldValueSha256: '7'.repeat(64),
      newValueSha256: '8'.repeat(64),
      oldIndexes,
      newIndexes: [
        index(8, '9'.repeat(64), 22, 'external_subject'),
        index(7, 'a'.repeat(64), 23, 'external_subject'),
      ],
      authorityEvidence: { authority: 'scim_bearer' },
      verificationEvidence: { method: 'scim_mapping' },
    });
    const notification = vi.fn(async () => {});

    await expect(
      coordinator(revokeCredentials, notification).resume({
        operationId: 'username-replacement-1',
        tenantId: 'tenant-a',
        accountId: 'account-a',
      })
    ).resolves.toEqual({ state: 'completed' });
    expect(
      pii.prepare(`SELECT value_json FROM identity_sensitive_values WHERE id = 'username-1'`).get()
    ).toEqual({ value_json: JSON.stringify('NewUser') });
    expect(
      newLookup
        .prepare(
          `SELECT DISTINCT index_kind, lifecycle_state
             FROM lookup_identifiers WHERE index_kind = 'external_subject'`
        )
        .all()
    ).toEqual([{ index_kind: 'external_subject', lifecycle_state: 'active' }]);
    expect(notification).not.toHaveBeenCalled();
  });

  it('keeps the new authority and resumes forward when credential revocation fails', async () => {
    const failedRevoke = vi.fn(async () => {
      throw new Error('revocation_unavailable');
    });
    await expect(
      coordinator(failedRevoke).resume({
        operationId: 'replacement-1',
        tenantId: 'tenant-a',
        accountId: 'account-a',
      })
    ).rejects.toThrow('revocation_unavailable');
    expect(
      pii
        .prepare(
          `SELECT state FROM identity_identifier_replacement_operations
            WHERE operation_id = 'replacement-1'`
        )
        .get()
    ).toEqual({ state: 'revocation_pending' });
    expect(
      oldLookup
        .prepare(`SELECT DISTINCT reservation_state FROM lookup_identifier_reservations`)
        .all()
    ).toEqual([{ reservation_state: 'releasing' }]);
    expect(
      pii.prepare(`SELECT value_json FROM identity_sensitive_values WHERE id = 'email-1'`).get()
    ).toEqual({ value_json: JSON.stringify('new@example.test') });
    await expect(
      coordinator().resume({
        operationId: 'replacement-1',
        tenantId: 'tenant-a',
        accountId: 'account-a',
      })
    ).resolves.toEqual({ state: 'completed' });
  });

  it('keeps old reservations unreleased until the notification intent is durably enqueued', async () => {
    const failedNotification = vi.fn(async () => {
      throw new Error('notification_unavailable');
    });
    await expect(
      coordinator(revokeCredentials, failedNotification).resume({
        operationId: 'replacement-1',
        tenantId: 'tenant-a',
        accountId: 'account-a',
      })
    ).rejects.toThrow('notification_unavailable');
    expect(
      oldLookup
        .prepare(`SELECT DISTINCT reservation_state FROM lookup_identifier_reservations`)
        .all()
    ).toEqual([{ reservation_state: 'releasing' }]);
    expect(
      pii
        .prepare(
          `SELECT state FROM identity_identifier_replacement_operations
            WHERE operation_id = 'replacement-1'`
        )
        .get()
    ).toEqual({ state: 'revocation_pending' });

    const deliveredNotification = vi.fn(async () => {});
    await expect(
      coordinator(revokeCredentials, deliveredNotification).resume({
        operationId: 'replacement-1',
        tenantId: 'tenant-a',
        accountId: 'account-a',
      })
    ).resolves.toEqual({ state: 'completed' });
    expect(
      oldLookup
        .prepare(`SELECT DISTINCT reservation_state FROM lookup_identifier_reservations`)
        .all()
    ).toEqual([{ reservation_state: 'released' }]);
    expect(deliveredNotification).toHaveBeenCalledTimes(1);
  });

  it('fails before the authoritative switch when another account owns the new reservation', async () => {
    newLookup.exec(
      `INSERT INTO lookup_identifier_reservations (
         virtual_bucket, tenant_id, index_kind, normalization_version,
         hmac_key_generation, identifier_blind_digest, account_id,
         reservation_state, operation_id, created_at, updated_at
       ) VALUES (12, 'tenant-a', 'email_exact', 1, 8, '${NEW_CURRENT}', 'account-b',
                 'committed', 'other-operation', 1000, 1000)`
    );
    await expect(
      coordinator().resume({
        operationId: 'replacement-1',
        tenantId: 'tenant-a',
        accountId: 'account-a',
      })
    ).rejects.toThrow('identifier_replacement_reservation_conflict');
    expect(
      pii.prepare(`SELECT value_json FROM identity_sensitive_values WHERE id = 'email-1'`).get()
    ).toEqual({ value_json: JSON.stringify('old@example.test') });
  });

  it('reclaims a released identifier reservation for the replacement account', async () => {
    newLookup.exec(
      `INSERT INTO lookup_identifier_reservations (
         virtual_bucket, tenant_id, index_kind, normalization_version,
         hmac_key_generation, identifier_blind_digest, account_id,
         reservation_state, operation_id, created_at, released_at, updated_at
       ) VALUES
         (12, 'tenant-a', 'email_exact', 1, 8, '${NEW_CURRENT}', 'account-b',
          'released', 'old-operation-8', 900, 950, 950),
         (13, 'tenant-a', 'email_exact', 1, 7, '${NEW_PREVIOUS}', 'account-b',
          'released', 'old-operation-7', 900, 950, 950)`
    );

    await expect(
      coordinator().resume({
        operationId: 'replacement-1',
        tenantId: 'tenant-a',
        accountId: 'account-a',
      })
    ).resolves.toEqual({ state: 'completed' });
    expect(
      newLookup
        .prepare(
          `SELECT account_id, operation_id, reservation_state
             FROM lookup_identifier_reservations ORDER BY hmac_key_generation DESC`
        )
        .all()
    ).toEqual([
      {
        account_id: 'account:account-a',
        operation_id: 'replacement-1',
        reservation_state: 'committed',
      },
      {
        account_id: 'account:account-a',
        operation_id: 'replacement-1',
        reservation_state: 'committed',
      },
    ]);
  });

  it('rejects a mismatched reflected Lookup gate before changing PII', async () => {
    newLookup.exec(
      `INSERT INTO lookup_identifier_replacements (
         replacement_id, tenant_id, account_id, index_kind, normalization_version,
         hmac_key_generation, old_virtual_bucket, old_blind_digest,
         new_virtual_bucket, new_blind_digest, gate_state, created_at, updated_at
       ) VALUES ('replacement-1', 'tenant-a', 'account-a', 'email_exact', 1, 8,
                 10, '${'9'.repeat(64)}', 12, '${NEW_CURRENT}', 'pending', 1000, 1000)`
    );
    await expect(
      coordinator().resume({
        operationId: 'replacement-1',
        tenantId: 'tenant-a',
        accountId: 'account-a',
      })
    ).rejects.toThrow('identifier_replacement_gate_mismatch');
    expect(
      pii.prepare(`SELECT value_json FROM identity_sensitive_values WHERE id = 'email-1'`).get()
    ).toEqual({ value_json: JSON.stringify('old@example.test') });
  });
});
