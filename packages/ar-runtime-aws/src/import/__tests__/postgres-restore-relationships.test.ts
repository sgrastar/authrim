/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion -- an in-memory PostgreSQL stand-in */
/**
 * Relationship tuples across migration 020: a backup from before it (no `from_relation`, older
 * `user` sources) restores in the current shape, and a version 2 receipt (written before
 * `from_relation` was projected) verifies against the columns it was written with.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import type { VerifiedTenantBackupV2 } from '../backup-reader';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../postgres-restore-table-contract';
import { POSTGRES_RESTORE_EXTENSION_CONTRACTS } from '../postgres-restore-extension-contract';
import {
  restoreVerifiedPostgresFamily,
  verifyPostgresFamilyStagingRows,
  type PostgresFamilyRestoreReceipt,
} from '../postgres-restore';

vi.mock('../postgres-restore-reference-seeds', () => ({
  preparePostgresReferenceSeeds: vi.fn(),
  hasPostgresReferenceSeed: () => false,
  verifyPostgresReferenceSeed: vi.fn(),
}));
vi.mock('../postgres-restore-triggers', () => ({
  suspendSnapshotProjectionTriggers: vi.fn(async () => []),
  restoreSnapshotProjectionTriggers: vi.fn(),
}));
vi.mock('pg', () => ({
  Client: class {
    constructor() {
      throw new Error('real pg Client construction is forbidden here');
    }
  },
}));

const TENANT = 'tenant-a';
const TARGET = '11111111-1111-4111-8111-111111111111';
const CORE = POSTGRES_RESTORE_TABLE_CONTRACTS.filter((spec) => spec.family === 'core');
const RELATIONSHIPS = POSTGRES_RESTORE_EXTENSION_CONTRACTS.find(
  (spec) => spec.datasetId === 'core.relationships'
)!;
const SPECS = [...CORE, RELATIONSHIPS];

/** Tables and a journal in memory, answering the statements the restore and the verify send. */
class FakePg {
  tables = new Map<string, Record<string, unknown>[]>();
  journal: Record<string, unknown>[] = [];
  readonly client = {
    connect: async () => undefined,
    end: async () => undefined,
    query: async (sql: string, values: unknown[] = []) => this.run(sql.trim(), values),
  } as unknown as Client;
  private run(sql: string, values: unknown[]): any {
    const ok = (rows: Record<string, unknown>[] = []) => ({ rows, rowCount: rows.length });
    if (sql.includes('FROM information_schema.columns')) return ok([{ present: 1 }]);
    if (sql.includes("from_type='group'") && sql.includes('from_relation IS NOT NULL'))
      return ok(
        (this.tables.get('relationships') ?? []).filter(
          (row) =>
            row.tenant_id === values[0] && row.from_type === 'group' && row.from_relation !== null
        )
      );
    if (sql.startsWith('SELECT target_id FROM authrim_aws_import_staging')) return ok(this.journal);
    if (sql.startsWith('INSERT INTO authrim_aws_import_staging')) {
      this.journal.push({
        target_id: values[0],
        tenant_id: values[1],
        family: values[2],
        receipt_json: values[3],
      });
      return ok();
    }
    if (sql.startsWith('SELECT target_id,tenant_id,family,receipt_json'))
      return ok(this.journal.filter((row) => row.target_id === values[0]));
    let match = /^INSERT INTO "(\w+)" \(([^)]*)\) VALUES/u.exec(sql);
    if (match) {
      const spec = SPECS.find((candidate) => candidate.table === match![1])!;
      const row: Record<string, unknown> = {};
      spec.columns.forEach((column, index) => (row[column] = values[index]));
      this.tables.set(spec.table, [...(this.tables.get(spec.table) ?? []), row]);
      const returned: Record<string, unknown> = { ...row };
      spec.postgresJsonbColumns.forEach(
        (column) => (returned[`authrim_json_${spec.columns.indexOf(column)}`] = true)
      );
      return ok([returned]);
    }
    match = /^SELECT (?!1 )(.*) FROM "(\w+)" WHERE "(\w+)"\s*=\s*\$1( LIMIT \$2)?$/su.exec(sql);
    if (match) {
      const [, , table, column] = match;
      return ok((this.tables.get(table) ?? []).filter((row) => row[column] === values[0]));
    }
    return ok();
  }
}

function portable(
  columns: readonly string[],
  integers: readonly string[],
  values: Record<string, string | null>
) {
  const row: Record<string, [string, string | null]> = {};
  for (const column of columns) {
    const value = values[column] ?? null;
    row[column] =
      value === null ? ['null', null] : [integers.includes(column) ? 'integer' : 'text', value];
  }
  return JSON.stringify(row);
}

/** A relationships row as a backup from before migration 020 holds it (no from_relation). */
const legacyRow = (
  id: string,
  fromType: string,
  fromId: string,
  toId: string,
  expiresAt: string | null = null
) =>
  portable(
    RELATIONSHIPS.columns.filter((column) => column !== 'from_relation'),
    RELATIONSHIPS.sqliteIntegerColumns,
    {
      id,
      expires_at: expiresAt,
      tenant_id: TENANT,
      relationship_type: 'viewer',
      from_type: fromType,
      from_id: fromId,
      to_type: 'document',
      to_id: toId,
      permission_level: 'full',
      is_bidirectional: '0',
      created_at: '1',
      updated_at: '1',
      evidence_type: 'manual',
    }
  );

/** A relationships row in the current shape (from_relation present, NULL or not). */
const currentRow = (id: string, fromType: string, fromRelation: string | null) =>
  portable(RELATIONSHIPS.columns, RELATIONSHIPS.sqliteIntegerColumns, {
    id,
    tenant_id: TENANT,
    relationship_type: 'viewer',
    from_type: fromType,
    from_id: `${id}-source`,
    from_relation: fromRelation,
    to_type: 'document',
    to_id: 'doc-3',
    permission_level: 'full',
    is_bidirectional: '0',
    created_at: '1',
    updated_at: '1',
    evidence_type: 'manual',
  });

function backupOf(relationships: string[]): VerifiedTenantBackupV2 {
  const rows = new Map<string, string[]>([['core.relationships', relationships]]);
  const ids = SPECS.map((spec) => spec.datasetId);
  return {
    manifest: {
      bundleId: 'b'.repeat(32),
      snapshotId: 'snap',
      inventoryDigestSha256: 'd'.repeat(64),
      source: { tenantId: TENANT, issuer: 'https://t.example.test', productVersion: '1' },
      datasets: ids.map((id) => ({
        id,
        module: 'm',
        kind: 'users',
        store: 'database',
        schemaVersion: 1,
        disposition: 'include',
      })),
    },
    dataset(id: string) {
      const data = rows.get(id) ?? [];
      return {
        id,
        rows: data.length,
        bytes: 0,
        async readNextRow(cursor: string | null) {
          const index = cursor === null ? 0 : Number(cursor);
          return index < data.length
            ? { rowJson: data[index], nextCursor: String(index + 1) }
            : null;
        },
      };
    },
    close: async () => undefined,
  } as unknown as VerifiedTenantBackupV2;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(',')}}`;
}
/** The row digest of a receipt table, over the given columns (as the restore computes it). */
function rowsDigest(rows: Record<string, unknown>[], columns: readonly string[]) {
  const hash = createHash('sha256');
  const entries = rows
    .map(
      (row) =>
        [JSON.stringify([String(row.id)]), columns.map((column) => row[column] ?? null)] as const
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [key, values] of entries) {
    const text = JSON.stringify([key, values]);
    hash
      .update(String(new TextEncoder().encode(text).byteLength))
      .update(':')
      .update(text);
  }
  return hash.digest('hex');
}

async function restored() {
  const fake = new FakePg();
  const receipt = await restoreVerifiedPostgresFamily({
    backup: backupOf([
      legacyRow('r1', 'subject', 'u1', 'doc-1', '100'),
      // A legacy `user` twin of r1 (the one left out; its later expiry is kept on r1).
      legacyRow('r0', 'user', 'u1', 'doc-1', '200'),
      legacyRow('r2', 'group', 'g1', 'doc-1'),
      legacyRow('r3', 'user', 'u2', 'doc-2', '50'),
      legacyRow('r5', 'user', 'u2', 'doc-2'),
      // A real expires_at (D1 may hold one an older write accepted) is rounded down.
      JSON.stringify({
        ...JSON.parse(legacyRow('r6', 'subject', 'u6', 'doc-6')),
        expires_at: ['real', '150.9'],
      }),
      // Rows in the current shape are restored as they are (NULL from_relation included).
      currentRow('c1', 'group', null),
      currentRow('c2', 'group', 'member'),
    ]),
    family: 'core',
    tenantId: TENANT,
    targetId: TARGET,
    connectionString: 'postgres://localhost/core',
    clientFactory: () => fake.client,
  });
  return { fake, receipt };
}

describe('relationships across migration 020', () => {
  it('restores a backup from before it in the current shape (projection version 3)', async () => {
    const { fake, receipt } = await restored();
    expect(receipt.projectionVersion).toBe(3);
    const rows = (fake.tables.get('relationships') ?? [])
      .map((row) => [row.id, row.from_type, row.from_id, row.from_relation, row.expires_at])
      .sort();
    expect(rows).toEqual([
      ['c1', 'group', 'c1-source', null, null],
      ['c2', 'group', 'c2-source', 'member', null],
      ['r1', 'subject', 'u1', null, '200'],
      // A legacy group row stays inert (no from_relation) until it is written again.
      ['r2', 'group', 'g1', null, null],
      // Twins of two legacy `user` rows: the first kept, no expiry (one had none).
      ['r3', 'subject', 'u2', null, null],
      ['r6', 'subject', 'u6', null, '150'],
    ]);
    expect(receipt.tables.find((table) => table.datasetId === 'core.relationships')).toMatchObject({
      rowCount: 6,
    });
    await expect(
      verifyPostgresFamilyStagingRows({
        connectionString: 'postgres://localhost/core',
        targetId: TARGET,
        clientFactory: () => fake.client,
      })
    ).resolves.toMatchObject({ projectionVersion: 3 });
  });

  it('refuses a relationship row whose expires_at is neither an integer, a real nor null', async () => {
    const fake = new FakePg();
    const bad = JSON.parse(legacyRow('x', 'subject', 'u', 'doc')) as Record<string, unknown>;
    bad.expires_at = ['text', 'tomorrow'];
    await expect(
      restoreVerifiedPostgresFamily({
        backup: backupOf([JSON.stringify(bad)]),
        family: 'core',
        tenantId: TENANT,
        targetId: TARGET,
        connectionString: 'postgres://localhost/core',
        clientFactory: () => fake.client,
      })
    ).rejects.toThrow('aws_postgres_restore_invalid');
  });

  it('verifies a version 2 receipt against the columns it was written with', async () => {
    const { fake, receipt } = await restored();
    const rows = fake.tables.get('relationships') ?? [];
    const v2Columns = RELATIONSHIPS.columns.filter((column) => column !== 'from_relation');
    const asVersion = (version: 2 | 3, columns: readonly string[]) => {
      const { digestSha256: _digest, ...body } = receipt;
      const next: Omit<PostgresFamilyRestoreReceipt, 'digestSha256'> = {
        ...body,
        projectionVersion: version,
        tables: body.tables.map((table) =>
          table.datasetId === 'core.relationships'
            ? { ...table, targetSha256: rowsDigest(rows, columns) }
            : table
        ),
      };
      fake.journal[0].receipt_json = JSON.stringify({ ...next, digestSha256: sha(stable(next)) });
    };
    const verify = () =>
      verifyPostgresFamilyStagingRows({
        connectionString: 'postgres://localhost/core',
        targetId: TARGET,
        clientFactory: () => fake.client,
      });

    // The restored c2 is a group userset (`member`): under a version 2 receipt (which does not
    // cover from_relation) a group row must still be the inert legacy shape.
    asVersion(2, v2Columns);
    await expect(verify()).rejects.toThrow('aws_postgres_restore_invalid');
    for (const row of rows) if (row.from_type === 'group') row.from_relation = null;
    asVersion(2, v2Columns);
    await expect(verify()).resolves.toMatchObject({ projectionVersion: 2 });
    // A version 2 receipt is not read with version 3 columns, nor the other way round.
    asVersion(2, RELATIONSHIPS.columns);
    await expect(verify()).rejects.toThrow('aws_postgres_restore_invalid');
    asVersion(3, v2Columns);
    await expect(verify()).rejects.toThrow('aws_postgres_restore_invalid');
    asVersion(3, RELATIONSHIPS.columns);
    await expect(verify()).resolves.toMatchObject({ projectionVersion: 3 });
  });
});
