import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createD1Adapter, type DatabaseAdapter, type LookupBlindIndex } from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IdentifierReplacementOperationRepository,
  type CreateIdentifierReplacementOperationInput,
} from '../identifier-replacement-operation';
import {
  listAdminIdentifierReplacements,
  prepareBlockedIdentifierReplacementResume,
} from '../admin-identifier-replacements';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OLD_HASH = 'a'.repeat(64);
const NEW_HASH = 'b'.repeat(64);
const IDEMPOTENCY_HASH = 'c'.repeat(64);
const FINGERPRINT = 'd'.repeat(64);

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

function index(generation: number, digest: string, bucket: number): LookupBlindIndex {
  return {
    indexKind: 'email_exact',
    normalizationVersion: 1,
    hmacKeyGeneration: generation,
    digest,
    virtualBucket: bucket,
  };
}

describe('IdentifierReplacementOperationRepository', () => {
  let database: DatabaseSync;
  let repository: IdentifierReplacementOperationRepository;
  let adapter: DatabaseAdapter;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    for (const migrationPath of [
      'migrations/pii/001_pii_schema.sql',
      'migrations/pii/004_identifier_replacement_authority.sql',
    ]) {
      database.exec(readFileSync(resolve(REPO_ROOT, migrationPath), 'utf8'));
    }
    database
      .prepare(
        `INSERT INTO identity_identifier_replacement_challenges (
           challenge_id, tenant_id, account_id, identifier_kind, normalized_value_json,
           value_sha256, otp_verifier, delivery_state, attempt_limit, expires_at, consumed_at,
           initiating_session_ref, recent_reauth_verified_at, created_at, updated_at
         ) VALUES ('challenge-1', 'tenant-a', 'account-a', 'email_exact', ?, ?, ?, 'sent', 5,
                   1500, 1050, 'session-a', 900, 1000, 1050)`
      )
      .run(JSON.stringify('new@example.test'), NEW_HASH, 'e'.repeat(64));
    adapter = createD1Adapter(d1(database), 'pii');
    repository = new IdentifierReplacementOperationRepository(adapter, () => 1100);
  });

  afterEach(() => database.close());

  function input(overrides: Partial<CreateIdentifierReplacementOperationInput> = {}) {
    return {
      operationId: 'replacement-1',
      outboxId: 'outbox-1',
      tenantId: 'tenant-a',
      accountId: 'account-a',
      authority: 'self_service' as const,
      actorRef: 'account-a',
      idempotencyKeySha256: IDEMPOTENCY_HASH,
      requestFingerprintSha256: FINGERPRINT,
      challengeId: 'challenge-1',
      initiatingSessionRef: 'session-a',
      oldValue: 'old@example.test',
      newValue: 'new@example.test',
      oldValueSha256: OLD_HASH,
      newValueSha256: NEW_HASH,
      oldIndexes: [index(8, '1'.repeat(64), 10), index(7, '2'.repeat(64), 11)],
      newIndexes: [index(8, '3'.repeat(64), 12), index(7, '4'.repeat(64), 13)],
      authorityEvidence: { authority: 'account_session' },
      verificationEvidence: { method: 'email_otp', verifiedAt: 1050 },
      ...overrides,
    };
  }

  it('persists current and previous generations with a blind-only outbox atomically', async () => {
    await expect(repository.create(input())).resolves.toMatchObject({
      operationId: 'replacement-1',
      state: 'directory_pending',
    });
    expect(
      database
        .prepare(
          `SELECT identifier_side, hmac_key_generation, blind_digest
             FROM identity_identifier_replacement_projections
            ORDER BY identifier_side, hmac_key_generation DESC`
        )
        .all()
    ).toHaveLength(4);
    const outbox = database
      .prepare(`SELECT payload_json FROM identity_identifier_replacement_outbox`)
      .get() as { payload_json: string };
    expect(outbox.payload_json).not.toContain('old@example.test');
    expect(outbox.payload_json).not.toContain('new@example.test');
    expect(JSON.parse(outbox.payload_json).projections).toHaveLength(4);
  });

  it('adopts the exact retry and rejects a changed idempotent request', async () => {
    await repository.create(input());
    await expect(repository.create(input())).resolves.toMatchObject({
      operationId: 'replacement-1',
    });
    await expect(
      repository.create(input({ requestFingerprintSha256: 'f'.repeat(64) }))
    ).rejects.toThrow('identifier_replacement_idempotency_conflict');
  });

  it('rejects missing generation pairs and cross-account challenge evidence', async () => {
    await expect(
      repository.create(input({ newIndexes: [index(8, '3'.repeat(64), 12)] }))
    ).rejects.toThrow('identifier_replacement_generation_mismatch');
    await expect(repository.create(input({ accountId: 'account-b' }))).rejects.toThrow(
      'identifier_replacement_challenge_invalid'
    );
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM identity_identifier_replacement_operations`)
        .get()
    ).toEqual({ count: 0 });
  });

  it('scopes the Admin view and atomically resumes only blocked forward repair', async () => {
    const operationId = 'identifier-replacement:00000000-0000-4000-8000-000000000001';
    await repository.create(input({ operationId, outboxId: 'outbox-admin-resume' }));
    database
      .prepare(
        `UPDATE identity_identifier_replacement_operations
            SET state = 'blocked_forward_repair', authoritative_switched_at = 1110,
                error_code = 'sensitive_internal_detail', updated_at = 1110
          WHERE operation_id = ?`
      )
      .run(operationId);
    database
      .prepare(
        `UPDATE identity_identifier_replacement_outbox
            SET status = 'blocked', error_code = 'sensitive_internal_detail', updated_at = 1110
          WHERE operation_id = ?`
      )
      .run(operationId);

    await expect(
      listAdminIdentifierReplacements(adapter, {
        tenantId: 'tenant-a',
        accountId: 'account-a',
      })
    ).resolves.toEqual([
      {
        operationId,
        authority: 'self_service',
        state: 'blocked_forward_repair',
        attentionRequired: true,
        createdAt: 1100,
        updatedAt: 1110,
        completedAt: null,
      },
    ]);
    await expect(
      listAdminIdentifierReplacements(adapter, {
        tenantId: 'tenant-other',
        accountId: 'account-a',
      })
    ).resolves.toEqual([]);

    await prepareBlockedIdentifierReplacementResume(adapter, {
      tenantId: 'tenant-a',
      accountId: 'account-a',
      operationId,
      now: 1200,
    });
    expect(
      database
        .prepare(
          `SELECT state, error_code, retry_budget_expires_at
             FROM identity_identifier_replacement_operations WHERE operation_id = ?`
        )
        .get(operationId)
    ).toEqual({
      state: 'authoritative_switched',
      error_code: null,
      retry_budget_expires_at: 8400,
    });
    expect(
      database
        .prepare(
          `SELECT status, error_code, next_attempt_at
             FROM identity_identifier_replacement_outbox WHERE operation_id = ?`
        )
        .get(operationId)
    ).toEqual({ status: 'retry', error_code: null, next_attempt_at: 1200 });
    await expect(
      prepareBlockedIdentifierReplacementResume(adapter, {
        tenantId: 'tenant-other',
        accountId: 'account-a',
        operationId,
        now: 1201,
      })
    ).rejects.toThrow('admin_identifier_replacement_not_resumable');
  });
});
