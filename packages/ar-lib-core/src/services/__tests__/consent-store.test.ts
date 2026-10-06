import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';
import { D1OperationError } from '../../utils/d1-retry';
import {
  isOAuthClientConsentGenerationChanged,
  listOAuthClientConsentsWithClients,
  upsertOAuthClientConsent,
} from '../consent-store';

const MIGRATIONS = new URL('../../../../../migrations/core/d1/', import.meta.url);

type SqlValue = string | number | null;

/**
 * The executable core D1 schema. `beforeFirstInsert` runs once before the first consent INSERT
 * (another request writing first), and `wrapConflict` hands a unique violation on as an
 * adapter error's cause.
 */
function createConsentDatabase(
  options: { beforeFirstInsert?: (db: DatabaseSync) => void; wrapConflict?: boolean } = {}
) {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(renderPortableMigrationSql(readFileSync(new URL(file, MIGRATIONS), 'utf8'), 'sqlite'));
  }
  const values = (params: unknown[] = []) => params as SqlValue[];
  let insertSeen = false;
  const adapter = {
    async query(sql: string, params?: unknown[]) {
      return db.prepare(sql).all(...values(params));
    },
    async queryOne(sql: string, params?: unknown[]) {
      return db.prepare(sql).get(...values(params)) ?? null;
    },
    async execute(sql: string, params?: unknown[]) {
      if (sql.trimStart().startsWith('INSERT INTO oauth_client_consents') && !insertSeen) {
        insertSeen = true;
        options.beforeFirstInsert?.(db);
      }
      try {
        return {
          success: true,
          rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
        };
      } catch (error) {
        throw options.wrapConflict
          ? new D1OperationError('D1Adapter.execute[core]', 1, error as Error, false)
          : error;
      }
    },
    async transaction() {
      throw new Error('not used');
    },
    async batch() {
      return [];
    },
    async isHealthy() {
      return { healthy: true, latencyMs: 0, type: 'sqlite' };
    },
    getType: () => 'sqlite',
    async close() {
      return undefined;
    },
  } as unknown as DatabaseAdapter;
  const consents = () =>
    db
      .prepare(
        `SELECT id, scope, consent_version, consent_generation, updated_at
           FROM oauth_client_consents ORDER BY id`
      )
      .all() as Array<{
      id: string;
      scope: string;
      consent_version: number;
      consent_generation: number;
      updated_at: number;
    }>;
  const insertConsent = (id: string, generation = 0) =>
    db
      .prepare(
        `INSERT INTO oauth_client_consents
           (id, user_id, client_id, scope, granted_at, consent_version, created_at, updated_at,
            tenant_id, consent_generation)
         VALUES (?, 'user-1', 'client-1', 'openid', 50, 2, 10, 50, 'tenant-a', ?)`
      )
      .run(id, generation);
  return { db, adapter, consents, insertConsent };
}

const input = {
  consentId: 'consent-new',
  userId: 'user-1',
  clientId: 'client-1',
  tenantId: 'tenant-a',
  scope: 'openid profile',
  grantedAt: 100,
  now: 100,
  consentGeneration: 0,
};

describe('upsertOAuthClientConsent', () => {
  it('inserts a new consent row with version 1 under the current generation', async () => {
    const { adapter, consents } = createConsentDatabase();

    const result = await upsertOAuthClientConsent(adapter, {
      ...input,
      selectedScopesJson: '["openid","profile"]',
      expiresAt: 200,
      privacyPolicyVersion: 'privacy-v1',
      tosVersion: 'tos-v1',
    });

    expect(result).toMatchObject({ inserted: true, id: 'consent-new', consentVersion: 1 });
    expect(consents()).toEqual([
      expect.objectContaining({ id: 'consent-new', consent_version: 1, consent_generation: 0 }),
    ]);
  });

  it('updates an existing consent row and increments version without replacing id', async () => {
    const { adapter, consents, insertConsent } = createConsentDatabase();
    insertConsent('consent-existing');

    const result = await upsertOAuthClientConsent(adapter, {
      ...input,
      consentId: 'consent-newer',
      scope: 'openid email',
    });

    expect(result).toMatchObject({ inserted: false, id: 'consent-existing', consentVersion: 3 });
    expect(consents()).toEqual([
      expect.objectContaining({
        id: 'consent-existing',
        scope: 'openid email',
        consent_version: 3,
      }),
    ]);
  });

  it.each([false, true])(
    'recovers from a concurrent first-grant unique constraint race (wrapped=%s)',
    async (wrapConflict) => {
      const { adapter, consents } = createConsentDatabase({
        wrapConflict,
        beforeFirstInsert: (db) =>
          db.exec(
            `INSERT INTO oauth_client_consents
               (id, user_id, client_id, scope, granted_at, consent_version, created_at,
                updated_at, tenant_id)
             VALUES ('consent-concurrent', 'user-1', 'client-1', 'openid', 90, 1, 90, 90,
                     'tenant-a')`
          ),
      });

      const result = await upsertOAuthClientConsent(adapter, { ...input, consentId: 'loser' });

      expect(result).toMatchObject({
        inserted: false,
        id: 'consent-concurrent',
        consentVersion: 2,
      });
      expect(consents()).toEqual([
        expect.objectContaining({ id: 'consent-concurrent', scope: 'openid profile' }),
      ]);
    }
  );

  it('records nothing when an approval races a withdrawal of the consent', async () => {
    // The approval read generation 1; the withdrawal then deleted the consent and moved the
    // generation to 2 before the approval's write.
    const { db, adapter, consents, insertConsent } = createConsentDatabase();
    insertConsent('consent-existing', 1);
    db.exec(
      `INSERT INTO oauth_client_consent_revocations (tenant_id, user_id, client_id, generation, revoked_at)
       VALUES ('tenant-a', 'user-1', 'client-1', 1, 10)`
    );
    db.exec(`DELETE FROM oauth_client_consents`);
    db.exec(`UPDATE oauth_client_consent_revocations SET generation = 2, revoked_at = 20`);

    await expect(
      upsertOAuthClientConsent(adapter, { ...input, consentGeneration: 1 })
    ).rejects.toSatisfy(isOAuthClientConsentGenerationChanged);
    expect(consents()).toEqual([]);
  });

  it('does not update a consent once the generation has moved on', async () => {
    const { db, adapter, consents, insertConsent } = createConsentDatabase();
    insertConsent('consent-existing', 1);
    db.exec(
      `INSERT INTO oauth_client_consent_revocations (tenant_id, user_id, client_id, generation, revoked_at)
       VALUES ('tenant-a', 'user-1', 'client-1', 2, 20)`
    );

    await expect(
      upsertOAuthClientConsent(adapter, { ...input, consentGeneration: 1 })
    ).rejects.toSatisfy(isOAuthClientConsentGenerationChanged);
    expect(consents()).toEqual([
      expect.objectContaining({ id: 'consent-existing', consent_version: 2 }),
    ]);
  });

  it('records a consent given again under the current generation', async () => {
    const { db, adapter, consents } = createConsentDatabase();
    db.exec(
      `INSERT INTO oauth_client_consent_revocations (tenant_id, user_id, client_id, generation, revoked_at)
       VALUES ('tenant-a', 'user-1', 'client-1', 2, 20)`
    );

    await upsertOAuthClientConsent(adapter, { ...input, consentGeneration: 2 });

    expect(consents()).toEqual([expect.objectContaining({ consent_generation: 2 })]);
  });
});

describe('listOAuthClientConsentsWithClients', () => {
  function queryOnlyAdapter(
    query: (sql: string, params: unknown[]) => unknown[]
  ): DatabaseAdapter & { calls: Array<{ sql: string; params: unknown[] }> } {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    return {
      calls,
      async query(sql: string, params: unknown[] = []) {
        calls.push({ sql, params });
        return query(sql, params);
      },
    } as unknown as DatabaseAdapter & { calls: Array<{ sql: string; params: unknown[] }> };
  }

  it('reads consents from the account database and clients from tenant metadata in chunks', async () => {
    const consentRows = Array.from({ length: 95 }, (_, index) => ({
      id: `consent-${index}`,
      client_id: `client-${index}`,
      scope: 'openid',
      selected_scopes: null,
      granted_at: 1_000 - index,
      expires_at: null,
      privacy_policy_version: null,
      tos_version: null,
      consent_version: 1,
    }));
    const accountCore = queryOnlyAdapter((sql) =>
      sql.includes('FROM oauth_client_consents') ? consentRows : []
    );
    const tenantMetadata = queryOnlyAdapter((sql, params) =>
      sql.includes('FROM oauth_clients')
        ? (params.slice(1) as string[])
            .filter((clientId) => clientId !== 'client-94')
            .map((clientId) => ({
              client_id: clientId,
              client_name: `Name ${clientId}`,
              logo_uri: null,
            }))
        : []
    );

    const rows = await listOAuthClientConsentsWithClients({
      accountCore,
      tenantMetadata,
      tenantId: 'tenant-a',
      userId: 'user-1',
    });

    expect(accountCore.calls).toEqual([
      {
        sql: expect.stringContaining('FROM oauth_client_consents'),
        params: ['tenant-a', 'user-1'],
      },
    ]);
    expect(tenantMetadata.calls).toHaveLength(2);
    expect(tenantMetadata.calls.every((call) => call.params.length <= 91)).toBe(true);
    expect(tenantMetadata.calls.some((call) => call.sql.includes('oauth_client_consents'))).toBe(
      false
    );
    expect(rows).toHaveLength(95);
    expect(rows[0]).toMatchObject({ id: 'consent-0', client_name: 'Name client-0' });
    expect(rows[94]).toMatchObject({ id: 'consent-94', client_name: null, logo_uri: null });
  });
});
