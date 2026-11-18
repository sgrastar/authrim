import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { computeContentHash } from '../../utils/consent-statements';
import {
  DEFAULT_CONSENT_STATEMENT_CONTENT_HASH,
  DEFAULT_CONSENT_STATEMENT_LANGUAGES,
  DEFAULT_CONSENT_STATEMENT_VERSION,
  DEFAULT_CONSENT_STATEMENTS,
  seedDefaultConsentStatements,
} from '../default-consent-statements';

const TENANT = 'acme';

async function addTenant(adapter: DatabaseAdapter, id: string) {
  await adapter.execute(
    `INSERT INTO tenants (id, tenant_code, tenant_key, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1)`,
    [id, id, `t_${id}`, id]
  );
}

/** What a tenant's default statements are, without ids, times and the tenant itself. */
async function shape(adapter: DatabaseAdapter, tenantId: string) {
  const statements = await adapter.query<Record<string, unknown>>(
    `SELECT slug, category, legal_basis, is_active, withdrawal_allowed, definition_generation,
            closed_generation, required_consent_version, retired_at
       FROM consent_statements WHERE tenant_id = ? ORDER BY slug`,
    [tenantId]
  );
  const versions = await adapter.query<Record<string, unknown>>(
    `SELECT s.slug, v.version, v.content_type, v.content_hash, v.is_current, v.status,
            v.current_statement_guard = v.statement_id AS guarded
       FROM consent_statement_versions v
       JOIN consent_statements s ON s.tenant_id = v.tenant_id AND s.id = v.statement_id
      WHERE v.tenant_id = ? ORDER BY s.slug`,
    [tenantId]
  );
  const texts = await adapter.query<Record<string, unknown>>(
    `SELECT s.slug, l.language, l.title, l.description, l.document_url, l.inline_content
       FROM consent_statement_localizations l
       JOIN consent_statement_versions v ON v.tenant_id = l.tenant_id AND v.id = l.version_id
       JOIN consent_statements s ON s.tenant_id = v.tenant_id AND s.id = v.statement_id
      WHERE l.tenant_id = ? ORDER BY s.slug, l.language`,
    [tenantId]
  );
  const jobs = await adapter.query<Record<string, unknown>>(
    `SELECT s.slug, j.definition_generation, j.closed_generation, j.mode
       FROM statement_consent_projection_jobs j
       JOIN consent_statements s ON s.tenant_id = j.tenant_id AND s.id = j.statement_id
      WHERE j.tenant_id = ? ORDER BY s.slug`,
    [tenantId]
  );
  return { statements, versions, texts, jobs };
}

describe('default consent statements', () => {
  it('seeds a new tenant with both, published, in every console language', async () => {
    const { adapter } = sqliteAdapter('core');
    await addTenant(adapter, TENANT);
    await seedDefaultConsentStatements(adapter, TENANT, 1_000);
    const seeded = await shape(adapter, TENANT);
    expect(seeded.statements.map((row) => row.slug)).toEqual([
      'privacy-policy',
      'terms-of-service',
    ]);
    expect(seeded.statements.every((row) => row.required_consent_version === '20261118')).toBe(
      true
    );
    expect(seeded.versions.map((row) => [row.status, row.is_current, row.guarded])).toEqual([
      ['active', 1, 1],
      ['active', 1, 1],
    ]);
    expect(seeded.texts).toHaveLength(2 * DEFAULT_CONSENT_STATEMENT_LANGUAGES.length);
    expect(
      seeded.texts.find((row) => row.language === 'ja' && row.slug === 'terms-of-service')
    ).toMatchObject({
      title: '利用規約',
      description: '利用規約を読み、その内容に同意します。',
      document_url: null,
    });
    expect(seeded.jobs.map((row) => row.mode)).toEqual(['enforced', 'enforced']);
  });

  it('is what migration 013 gave tenants that existed, content hash included', async () => {
    // The core schema fixture applies every migration, so its baseline tenant got them there.
    const { adapter } = sqliteAdapter('core');
    await addTenant(adapter, TENANT);
    await seedDefaultConsentStatements(adapter, TENANT);
    expect(await shape(adapter, 'default')).toEqual(await shape(adapter, TENANT));
    for (const tenantId of ['default', TENANT]) {
      const versions = await adapter.query<{ id: string }>(
        `SELECT id FROM consent_statement_versions WHERE tenant_id = ?`,
        [tenantId]
      );
      expect(versions).toHaveLength(DEFAULT_CONSENT_STATEMENTS.length);
      for (const { id } of versions) {
        await expect(computeContentHash(adapter, id, tenantId)).resolves.toBe(
          DEFAULT_CONSENT_STATEMENT_CONTENT_HASH
        );
      }
    }
    expect(DEFAULT_CONSENT_STATEMENT_VERSION).toBe('20261118');
  });

  it('runs again without change and finishes one stopped part way', async () => {
    const { adapter } = sqliteAdapter('core');
    await addTenant(adapter, TENANT);
    // Stopped after the terms of service was written, before it was published.
    await adapter.execute(
      `INSERT INTO consent_statements (id, tenant_id, slug, category, created_at, updated_at)
       VALUES (?, ?, 'terms-of-service', 'terms_of_service', 1, 1)`,
      ['cst_default_terms_partial', TENANT]
    );
    await seedDefaultConsentStatements(adapter, TENANT);
    const once = await shape(adapter, TENANT);
    expect(once.versions.map((row) => row.status)).toEqual(['active', 'active']);
    await seedDefaultConsentStatements(adapter, TENANT);
    expect(await shape(adapter, TENANT)).toEqual(once);
  });

  it('carries on with the draft another run began when it lost the race to begin it', async () => {
    const { adapter } = sqliteAdapter('core');
    await addTenant(adapter, TENANT);
    // Run A wrote its draft and stopped; run B looked before A's write landed (it saw none).
    await adapter.execute(
      `INSERT INTO consent_statements (id, tenant_id, slug, category, created_at, updated_at)
       VALUES ('cst_default_terms_a', ?, 'terms-of-service', 'terms_of_service', 1, 1)`,
      [TENANT]
    );
    await adapter.execute(
      `INSERT INTO consent_statement_versions
         (id, tenant_id, statement_id, version, content_type, effective_at, status, created_at, updated_at)
       VALUES ('csv_default_terms_a', ?, 'cst_default_terms_a', '20261118', 'url', 1, 'draft', 1, 1)`,
      [TENANT]
    );
    let hidden = true;
    const racing = new Proxy(adapter, {
      get(target, key, receiver) {
        if (key !== 'queryOne') return Reflect.get(target, key, receiver) as unknown;
        return async (sql: string, params?: unknown[]) => {
          if (hidden && sql.includes('substr(id, 1,') && params?.[1] === 'terms-of-service') {
            hidden = false;
            return null;
          }
          return target.queryOne(sql, params);
        };
      },
    });
    await seedDefaultConsentStatements(racing, TENANT);
    const rows = await adapter.query<{ id: string; status: string }>(
      `SELECT s.id, v.status FROM consent_statements s
         JOIN consent_statement_versions v ON v.tenant_id = s.tenant_id AND v.statement_id = s.id
        WHERE s.tenant_id = ? AND s.slug = 'terms-of-service'`,
      [TENANT]
    );
    expect(rows).toEqual([{ id: 'cst_default_terms_a', status: 'active' }]);
    expect((await shape(adapter, TENANT)).texts).toHaveLength(
      2 * DEFAULT_CONSENT_STATEMENT_LANGUAGES.length
    );
  });

  it('does not publish again a version another run published after this one looked', async () => {
    const { adapter } = sqliteAdapter('core');
    await addTenant(adapter, TENANT);
    await seedDefaultConsentStatements(adapter, TENANT);
    const published = await shape(adapter, TENANT);
    // This run read the versions as drafts just before the other run published them.
    const stale = new Proxy(adapter, {
      get(target, key, receiver) {
        if (key !== 'queryOne') return Reflect.get(target, key, receiver) as unknown;
        return async (sql: string, params?: unknown[]) =>
          sql.startsWith('SELECT status FROM consent_statement_versions')
            ? { status: 'draft' }
            : target.queryOne(sql, params);
      },
    });
    await seedDefaultConsentStatements(stale, TENANT);
    expect(await shape(adapter, TENANT)).toEqual(published);
  });

  it('gives a tenant made later with a renamed tenant’s old name ids of its own', async () => {
    const { adapter } = sqliteAdapter('core');
    // The baseline tenant renamed (setup's initial tenant): its rows keep their ids.
    for (const table of [
      'consent_statements',
      'consent_statement_versions',
      'consent_statement_localizations',
      'statement_consent_projection_jobs',
    ]) {
      await adapter.execute(`UPDATE ${table} SET tenant_id = 'first' WHERE tenant_id = 'default'`);
    }
    await seedDefaultConsentStatements(adapter, 'default');
    expect((await shape(adapter, 'default')).versions.map((row) => row.status)).toEqual([
      'active',
      'active',
    ]);
    expect(await shape(adapter, 'first')).toEqual(await shape(adapter, 'default'));
  });

  it('adds none of a kind or key the tenant already has, and does not bring back a deleted one', async () => {
    const { adapter } = sqliteAdapter('core');
    await addTenant(adapter, TENANT);
    await adapter.execute(
      `INSERT INTO consent_statements (id, tenant_id, slug, category, created_at, updated_at)
       VALUES ('own-terms', ?, 'our-terms', 'terms_of_service', 1, 1)`,
      [TENANT]
    );
    await seedDefaultConsentStatements(adapter, TENANT);
    expect((await shape(adapter, TENANT)).statements.map((row) => row.slug)).toEqual([
      'our-terms',
      'privacy-policy',
    ]);
    // One the admin deleted stays gone: the seed only adds what is missing when it runs (once,
    // as a tenant is made), and the migration ran once per database.
    await adapter.execute(`DELETE FROM consent_statements WHERE tenant_id = ? AND slug = ?`, [
      TENANT,
      'privacy-policy',
    ]);
    expect((await shape(adapter, TENANT)).statements.map((row) => row.slug)).toEqual(['our-terms']);
  });
});
