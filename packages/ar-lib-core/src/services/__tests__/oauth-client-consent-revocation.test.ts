import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';
import {
  accessTokenConsentClaims,
  accessTokenConsentGrant,
  findOAuthClientConsentRevocation,
  isAccessTokenConsentWithdrawn,
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

describe('access token consent claims', () => {
  it('records the generation, and the consented client only when it is not the token client', () => {
    expect(
      accessTokenConsentClaims({ generation: 3, consentClientId: 'app', tokenClientId: 'app' })
    ).toEqual({ authrim_consent_generation: 3 });
    expect(
      accessTokenConsentClaims({ generation: 3, consentClientId: 'app', tokenClientId: 'rs' })
    ).toEqual({ authrim_consent_generation: 3, authrim_consent_client_id: 'app' });
  });

  it('leaves no custom or mapped value of the grant claims', () => {
    const claims = {
      authrim_consent_client_id: 'spoofed',
      authrim_subject_issuer: 'https://spoofed.example',
      authrim_subject_ref: 'spoofed',
      original_issuer: 'https://spoofed.example',
      authrim_subject_principal: 'client',
      ...accessTokenConsentClaims({ generation: 1, consentClientId: 'app', tokenClientId: 'app' }),
    };
    const signed = JSON.parse(JSON.stringify(claims)) as Record<string, unknown>;
    expect(signed).toEqual({ authrim_consent_generation: 1 });
  });

  it('reads the consent of a token: its consented client, generation and issue time', () => {
    expect(
      accessTokenConsentGrant({
        client_id: 'rs',
        authrim_consent_client_id: 'app',
        authrim_consent_generation: 2,
        iat: 10,
      })
    ).toEqual({ clientId: 'app', generation: 2, issuedAt: 10_000 });
    // An ID token names its client by azp or a single audience.
    expect(accessTokenConsentGrant({ aud: 'app', iat: 10 }).clientId).toBe('app');
    expect(accessTokenConsentGrant({ azp: 'app', aud: ['app', 'x'] }).clientId).toBe('app');
    expect(accessTokenConsentGrant({ authrim_consent_generation: -1 }).generation).toBeUndefined();
  });

  it('compares a recorded generation, else the issue time, with the withdrawals', () => {
    const state = { generation: 2, revokedAt: 10_500 };
    expect(isAccessTokenConsentWithdrawn(state, { authrim_consent_generation: 1, iat: 99 })).toBe(
      true
    );
    // A token of the current generation stands, even one issued within the withdrawal's second.
    expect(isAccessTokenConsentWithdrawn(state, { authrim_consent_generation: 2, iat: 10 })).toBe(
      false
    );
    expect(isAccessTokenConsentWithdrawn(state, { iat: 10 })).toBe(true);
    expect(isAccessTokenConsentWithdrawn(state, { iat: 11 })).toBe(false);
    expect(isAccessTokenConsentWithdrawn({ generation: 0, revokedAt: null }, { iat: 10 })).toBe(
      false
    );
  });
});
