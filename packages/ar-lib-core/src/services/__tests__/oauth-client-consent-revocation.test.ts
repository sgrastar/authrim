import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';
import {
  findOAuthClientConsentRevocation,
  isOAuthClientConsentGrantWithdrawn,
  oauthClientConsentRevocationStatement,
  predatesOAuthClientConsentRevocation,
  recordOAuthClientConsentRevocation,
} from '../oauth-client-consent-revocation';

const MIGRATIONS = new URL('../../../../../migrations/core/d1/', import.meta.url);

type SqlValue = string | number | null;

/** The executable core D1 schema, so the statements run against the migrated table. */
function migratedCoreAdapter(): DatabaseAdapter {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(renderPortableMigrationSql(readFileSync(new URL(file, MIGRATIONS), 'utf8'), 'sqlite'));
  }
  const values = (params: unknown[] = []) => params as SqlValue[];
  return {
    async query(sql: string, params?: unknown[]) {
      return db.prepare(sql).all(...values(params));
    },
    async queryOne(sql: string, params?: unknown[]) {
      return db.prepare(sql).get(...values(params)) ?? null;
    },
    async execute(sql: string, params?: unknown[]) {
      return {
        success: true,
        rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
      };
    },
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: () => 'sqlite',
    close: vi.fn(),
  } as unknown as DatabaseAdapter;
}

describe('OAuth client consent revocation', () => {
  const key = { tenantId: 'tenant-a', userId: 'user-1', clientId: 'client-a' };
  let adapter: DatabaseAdapter;

  beforeEach(() => {
    adapter = migratedCoreAdapter();
  });

  it('moves the generation on with every withdrawal; the time never moves backwards', async () => {
    expect(await findOAuthClientConsentRevocation(adapter, key)).toEqual({
      generation: 0,
      revokedAt: null,
    });

    await recordOAuthClientConsentRevocation(adapter, { ...key, revokedAt: 2_000 });
    expect(await findOAuthClientConsentRevocation(adapter, key)).toEqual({
      generation: 1,
      revokedAt: 2_000,
    });
    await recordOAuthClientConsentRevocation(adapter, { ...key, revokedAt: 1_000 });
    expect(await findOAuthClientConsentRevocation(adapter, key)).toEqual({
      generation: 2,
      revokedAt: 2_000,
    });

    const later = oauthClientConsentRevocationStatement({ ...key, revokedAt: 3_000 });
    await adapter.execute(later.sql, later.params);
    expect(await findOAuthClientConsentRevocation(adapter, key)).toEqual({
      generation: 3,
      revokedAt: 3_000,
    });

    expect(
      await findOAuthClientConsentRevocation(adapter, { ...key, clientId: 'client-b' })
    ).toEqual({ generation: 0, revokedAt: null });
    expect(await findOAuthClientConsentRevocation(adapter, { ...key, userId: 'user-2' })).toEqual({
      generation: 0,
      revokedAt: null,
    });
  });

  it('refuses a grant from an earlier generation, or one without a generation issued before', () => {
    const state = { generation: 2, revokedAt: 5_000 };
    expect(isOAuthClientConsentGrantWithdrawn(state, { generation: 1, issuedAt: 9_000 })).toBe(
      true
    );
    expect(isOAuthClientConsentGrantWithdrawn(state, { generation: 2, issuedAt: 1_000 })).toBe(
      false
    );
    expect(isOAuthClientConsentGrantWithdrawn(state, { issuedAt: 5_000 })).toBe(true);
    expect(isOAuthClientConsentGrantWithdrawn(state, { issuedAt: 5_001 })).toBe(false);
    expect(
      isOAuthClientConsentGrantWithdrawn({ generation: 0, revokedAt: null }, { generation: 0 })
    ).toBe(false);
  });

  it('refuses what was issued at or before the withdrawal, or at an unknown time', () => {
    expect(predatesOAuthClientConsentRevocation(1_000, null)).toBe(false);
    expect(predatesOAuthClientConsentRevocation(undefined, null)).toBe(false);
    expect(predatesOAuthClientConsentRevocation(999, 1_000)).toBe(true);
    expect(predatesOAuthClientConsentRevocation(1_000, 1_000)).toBe(true);
    expect(predatesOAuthClientConsentRevocation(undefined, 1_000)).toBe(true);
    expect(predatesOAuthClientConsentRevocation(Number.NaN, 1_000)).toBe(true);
    // A re-consent after the withdrawal issues new grants.
    expect(predatesOAuthClientConsentRevocation(1_001, 1_000)).toBe(false);
  });
});
