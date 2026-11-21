import { afterEach, describe, expect, it } from 'vitest';
import { sqliteAdapter } from '../../../repositories/__tests__/sqlite-core-schema';
import { SqliteRestoreTarget } from '../sqlite-restore-target';
import type { SqliteDatasetInspectionPolicy } from '../sqlite-dataset-inspector';
import type { TenantBundleManifest } from '../bundle-manifest';

const closed: (() => void)[] = [];
afterEach(() => {
  for (const close of closed.splice(0)) close();
});

const portable = (row: Record<string, unknown>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value === null
          ? ['null', null]
          : typeof value === 'number'
            ? ['integer', String(value)]
            : ['text', value],
      ])
    )
  );

/**
 * A fresh destination (every core migration, so its baseline tenant has migration 013's terms of
 * service and privacy policy) restoring the baseline tenant's own statements.
 */
async function policyFor(
  adapter: ReturnType<typeof sqliteAdapter>['adapter'],
  table: string
): Promise<SqliteDatasetInspectionPolicy> {
  const columns = await adapter.query<{ name: string }>(`PRAGMA table_info(${table})`);
  return {
    dataset: {
      id: `core.${table}`,
      module: 'consent',
      kind: 'settings',
      store: 'database',
      disposition: 'include',
      schemaVersion: 1,
    },
    schema: {
      table,
      columns: columns.map((column) => column.name),
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
    },
    restoreAllowsAdditionalRows: true,
    restoreReplacesInstalledSeedRows: true,
    async inspectRow() {
      return [];
    },
  };
}

async function restoring() {
  const target = sqliteAdapter('core');
  closed.push(() => target.db.close());
  const columns = await target.adapter.query<{ name: string; pk: number }>(
    'PRAGMA table_info(consent_statements)'
  );
  const policy: SqliteDatasetInspectionPolicy = {
    dataset: {
      id: 'core.consent_statements',
      module: 'consent',
      kind: 'settings',
      store: 'database',
      disposition: 'include',
      schemaVersion: 1,
    },
    schema: {
      table: 'consent_statements',
      columns: columns.map((column) => column.name),
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
    },
    restoreAllowsAdditionalRows: true,
    restoreReplacesInstalledSeedRows: true,
    async inspectRow() {
      return [];
    },
  };
  const manifest: TenantBundleManifest = {
    formatVersion: 1,
    bundleId: 'a'.repeat(32),
    source: { tenantId: 'default', issuer: 'https://fixture.example', productVersion: '0.5.0' },
    selection: {
      settings: true,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' },
    },
    snapshotId: 'snapshot',
    boundaryUnixMs: Date.now(),
    inventoryDigestSha256: 'b'.repeat(64),
    datasets: [
      policy.dataset,
      (await policyFor(target.adapter, 'consent_statement_versions')).dataset,
    ],
  };
  const restorer = await SqliteRestoreTarget.open({
    database: target.adapter,
    identity: {
      id: 'target',
      tenantId: 'default',
      operationId: 'import',
      resourceId: 'target-db',
      planDigest: 'a'.repeat(64),
      seedFingerprint: 'b'.repeat(64),
    },
    lease: { owner: 'restorer', fencingToken: 1, expiresAt: Date.now() + 600000 },
    now: () => Date.now(),
    authorize: async () => {},
    readSeedFingerprint: async () => 'b'.repeat(64),
  });
  const row = (id: string, slug: string, category: string) =>
    portable(
      Object.fromEntries(
        columns.map(({ name }) => [
          name,
          (
            {
              id,
              tenant_id: 'default',
              slug,
              category,
              legal_basis: 'consent',
              display_order: 0,
              is_active: 1,
              created_at: 1,
              updated_at: 1,
              withdrawal_allowed: 1,
              reconsent_on_version_change: 1,
              definition_generation: 0,
              closed_generation: 0,
            } as Record<string, unknown>
          )[name] ?? null,
        ])
      )
    );
  const remaining = async (table: string, column = 'statement_id') =>
    (
      await target.adapter.query<{ id: string }>(
        `SELECT DISTINCT ${column} AS id FROM ${table} WHERE tenant_id = 'default' ORDER BY 1`
      )
    ).map(({ id }) => id);
  return { target, policy, manifest, restorer, row, remaining };
}

describe('a restored statement taking the place of an installed default one', () => {
  it('removes the installed one of the same key, with its version, texts and job, in one write', async () => {
    const { policy, manifest, restorer, row, remaining } = await restoring();
    const own = row('own-terms', 'terms-of-service', 'terms_of_service');
    await restorer.writeRows(policy, manifest, [own]);
    await restorer.writeRows(policy, manifest, [own]); // a lost acknowledgement is idempotent
    await restorer.verifyRows(policy, manifest, [own]);
    expect(await remaining('consent_statements', 'id')).toEqual([
      'cst_default_privacy:default',
      'own-terms',
    ]);
    expect(await remaining('consent_statement_versions')).toEqual(['cst_default_privacy:default']);
    expect(await remaining('statement_consent_projection_jobs')).toEqual([
      'cst_default_privacy:default',
    ]);
    expect(await remaining('consent_statement_localizations', 'version_id')).toEqual([
      'csv_default_privacy:default',
    ]);
    await restorer.verifyDataset(policy, 1);
  });

  it('does the same on the one-row path', async () => {
    const { policy, manifest, restorer, row, remaining } = await restoring();
    await restorer.writeRow(policy, manifest, row('own-privacy', 'privacy-policy', 'custom'));
    expect(await remaining('consent_statements', 'id')).toEqual([
      'cst_default_terms:default',
      'own-privacy',
    ]);
  });

  it('replaces the installed one in place when the backup holds it under the same id', async () => {
    const { policy, manifest, restorer, row, remaining } = await restoring();
    await restorer.writeRows(policy, manifest, [
      row('cst_default_terms:default', 'terms-of-service', 'terms_of_service'),
    ]);
    expect(await remaining('consent_statements', 'id')).toEqual([
      'cst_default_privacy:default',
      'cst_default_terms:default',
    ]);
    expect(await remaining('consent_statement_versions')).toEqual([
      'cst_default_privacy:default',
      'cst_default_terms:default',
    ]);
  });

  it('leaves a statement the destination did not install', async () => {
    const { target, policy, manifest, restorer, row } = await restoring();
    await target.adapter.execute(
      `INSERT INTO consent_statements (id, tenant_id, slug, created_at, updated_at)
       VALUES ('mine', 'default', 'newsletter', 1, 1)`
    );
    await expect(
      restorer.writeRows(policy, manifest, [row('theirs', 'newsletter', 'custom')])
    ).rejects.toThrow();
  });

  it('restores the installed statement with a later version published over the installed one', async () => {
    const { target, policy, manifest, restorer, row } = await restoring();
    const versions = await policyFor(target.adapter, 'consent_statement_versions');
    const version = (id: string, current: boolean, version: string) =>
      portable(
        Object.fromEntries(
          versions.schema.columns.map((name) => [
            name,
            (
              {
                id,
                tenant_id: 'default',
                statement_id: 'cst_default_terms:default',
                version,
                content_type: 'url',
                effective_at: 1,
                content_hash: 'c'.repeat(64),
                is_current: current ? 1 : 0,
                current_statement_guard: current ? 'cst_default_terms:default' : null,
                status: current ? 'active' : 'archived',
                created_at: 1,
                updated_at: 2,
              } as Record<string, unknown>
            )[name] ?? null,
          ])
        )
      );
    await restorer.writeRows(policy, manifest, [
      row('cst_default_terms:default', 'terms-of-service', 'terms_of_service'),
    ]);
    // The later version first: the installed one is still current in the destination then.
    const later = version('a-later-version', true, '20261201');
    const installed = version('csv_default_terms:default', false, '20261118');
    await restorer.writeRows(versions, manifest, [later, installed]);
    await restorer.writeRows(versions, manifest, [later, installed]); // retried
    await restorer.verifyRows(versions, manifest, [later, installed]);
    expect(
      await target.adapter.query(
        `SELECT id, status, is_current FROM consent_statement_versions
          WHERE tenant_id = 'default' AND statement_id = 'cst_default_terms:default' ORDER BY id`
      )
    ).toEqual([
      { id: 'a-later-version', status: 'active', is_current: 1 },
      { id: 'csv_default_terms:default', status: 'archived', is_current: 0 },
    ]);
  });

  it('stops at a default statement that is no longer as installed', async () => {
    const { target, policy, manifest, restorer, row } = await restoring();
    await target.adapter.execute(
      `UPDATE consent_statement_versions SET content_hash = 'changed'
        WHERE id = 'csv_default_terms:default'`
    );
    await expect(
      restorer.writeRows(policy, manifest, [
        row('own-terms', 'terms-of-service', 'terms_of_service'),
      ])
    ).rejects.toThrow();
  });

  it('changes nothing where the database cannot write them together', async () => {
    const { target, policy, manifest, restorer, row, remaining } = await restoring();
    const before = await remaining('consent_statements', 'id');
    const batch = target.adapter.batch;
    (target.adapter as { batch?: unknown }).batch = undefined;
    await expect(
      restorer.writeRows(policy, manifest, [
        row('own-terms', 'terms-of-service', 'terms_of_service'),
      ])
    ).rejects.toThrow();
    await expect(
      restorer.writeRow(policy, manifest, row('own-terms', 'terms-of-service', 'terms_of_service'))
    ).rejects.toThrow();
    (target.adapter as { batch?: unknown }).batch = batch;
    expect(await remaining('consent_statements', 'id')).toEqual(before);
  });
});
