import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../import/postgres-restore-table-contract';
import { createDsqlIdentityFixture, type DsqlIdentityFixture } from './identity-fixture';

// Isolate directory/permission/cleanup observations from other test processes creating fixtures.
const temporaryRoot = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, tmpdir: () => temporaryRoot.path ?? actual.tmpdir() };
});

const fixtures: DsqlIdentityFixture[] = [];
beforeEach(async () => {
  temporaryRoot.path = await mkdtemp(join(await realpath(tmpdir()), 'authrim-dsql-fixture-test-'));
});
afterEach(async () => {
  try {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  } finally {
    const path = temporaryRoot.path;
    temporaryRoot.path = null;
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe('encrypted DSQL identity fixture', () => {
  it('verifies exact native columns, tenant ownership, row counts and lossless scalar values', async () => {
    const fixture = await createDsqlIdentityFixture({ userCount: 2 });
    fixtures.push(fixture);
    expect(fixture.trustedReceiptDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(fixture.backup.manifest.source.issuer).toBe('https://identity.example.test');
    expect(fixture.backup.manifest.datasets).toHaveLength(18);
    expect(Object.values(fixture.expectedRows).filter((count) => count !== 0)).toEqual([2, 2, 2]);
    const selected: Record<string, PortableSqliteRow[]> = {};
    for (const spec of POSTGRES_RESTORE_TABLE_CONTRACTS) {
      const dataset = fixture.backup.dataset(spec.datasetId);
      expect(dataset.rows).toBe(fixture.expectedRows[spec.datasetId]);
      const rows: PortableSqliteRow[] = [];
      let cursor: string | null = null;
      for (let index = 0; index < dataset.rows; index++) {
        const next = await dataset.readNextRow(cursor);
        expect(next).not.toBeNull();
        if (!next) throw new Error('expected_fixture_row');
        const row = JSON.parse(next.rowJson) as PortableSqliteRow;
        expect(Object.keys(row)).toEqual(spec.columns);
        expect(row.tenant_id).toEqual(['text', fixture.tenantId]);
        for (const [column, [kind, value]] of Object.entries(row)) {
          if (value === null) expect(kind).toBe('null');
          else expect(kind).toBe(spec.sqliteIntegerColumns.includes(column) ? 'integer' : 'text');
        }
        rows.push(row);
        cursor = next.nextCursor;
      }
      expect(await dataset.readNextRow(cursor)).toBeNull();
      selected[spec.datasetId] = rows;
    }
    expect(selected['core.passkeys'][0].counter).toEqual(['integer', '9007199254740993']);
    expect(selected['core.users_core'][0].password_hash).toEqual(['null', null]);
    const rawAttributes = selected['pii.users_pii'][0].custom_attributes_json[1];
    expect(rawAttributes).toBe(
      '{"purpose":"DSQL適合試験","ordinal":0,"preciseInteger":9007199254740993,"fraction":0.125,"exponent":1e-3}'
    );
    expect(JSON.parse(rawAttributes ?? '')).toMatchObject({
      purpose: 'DSQL適合試験',
      ordinal: 0,
      fraction: 0.125,
      exponent: 0.001,
    });
    expect(selected['core.passkeys'].map((row) => row.user_id)).toEqual(
      selected['core.users_core'].map((row) => row.id)
    );
    expect(selected['pii.users_pii'].map((row) => row.id)).toEqual(
      selected['core.users_core'].map((row) => row.id)
    );
  });

  it('re-verifies the same encrypted snapshot after closing a reader and removes its files', async () => {
    const root = await realpath(tmpdir());
    const before = new Set(await readdir(root));
    const fixture = await createDsqlIdentityFixture({ userCount: 1 });
    fixtures.push(fixture);
    const created = (await readdir(root)).filter(
      (name) => name.startsWith('authrim-dsql-identity-') && !before.has(name)
    );
    expect(created).toHaveLength(1);
    const path = join(root, created[0]);
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(path)) {
      expect(name).toMatch(/^encrypted-\d+\.bin$/u);
      expect((await stat(join(path, name))).mode & 0o777).toBe(0o600);
      const bytes = await readFile(join(path, name));
      expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('AUTHRIM2');
      expect(new TextDecoder().decode(bytes)).not.toContain('synthetic-user-');
    }
    const original = fixture.backup.manifest;
    await fixture.backup.close();
    const reopened = await fixture.reopen();
    expect(reopened.manifest).toEqual(original);
    expect(reopened.dataset('core.passkeys').rows).toBe(1);
    await fixture.close();
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fixture.reopen()).rejects.toThrow('dsql_identity_fixture_invalid');
    expect(() => reopened.dataset('core.passkeys')).toThrow('aws_backup_reader_invalid');
    await fixture.close();
  });

  it('defaults to 201 users, PII records and credentials for multiple restore chunks', async () => {
    const fixture = await createDsqlIdentityFixture();
    fixtures.push(fixture);
    for (const id of ['core.users_core', 'pii.users_pii', 'core.passkeys']) {
      expect(fixture.backup.dataset(id).rows).toBe(201);
    }
  });

  it.each([0, -1, 2001, 1.1, NaN, Infinity])(
    'rejects unsupported fixture size %s',
    async (userCount) => {
      await expect(createDsqlIdentityFixture({ userCount })).rejects.toThrow(
        'dsql_identity_fixture_invalid'
      );
    }
  );
});
