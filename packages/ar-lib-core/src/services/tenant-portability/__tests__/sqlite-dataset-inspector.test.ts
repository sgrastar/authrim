import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { beforeAll, expect, it } from 'vitest';
import { createSqliteDatasetInspectorFactory } from '../sqlite-dataset-inspector';
import { SQLITE_SNAPSHOT_SCHEMA, type CaptureSchema } from '../sqlite-snapshot';
import { readSqliteSnapshotDataset } from '../sqlite-dataset-source';
import {
  createTenantBundleKeyEnvelope,
  type TenantBundleKeyEnvelope,
} from '../bundle-key-envelope';
import { encodeTenantBundle } from '../bundle-codec';
import {
  validateTenantBundleInputSet,
  type TenantBundleReferenceIndex,
} from '../bundle-validation';
import type { TenantBundleManifest } from '../bundle-manifest';
import type { TenantPortableDataset } from '../module-contract';
import type { TenantPortableRecordIdentity, TenantPortableDependency } from '../reference-contract';
const dataset: TenantPortableDataset = {
  id: 'core.tenants',
  module: 'tenant-runtime',
  kind: 'settings',
  store: 'database',
  schemaVersion: 1,
  disposition: 'include',
};
const schema: CaptureSchema = {
  table: 'tenants',
  columns: ['id', 'value'],
  primaryKey: ['id'],
  uniqueKeys: [],
  tenantColumn: 'id',
};
const manifest: TenantBundleManifest = {
  formatVersion: 1,
  bundleId: 'a'.repeat(32),
  source: { tenantId: 'a', issuer: 'https://issuer.example', productVersion: '0.4.2' },
  selection: {
    settings: true,
    users: false,
    admin: false,
    artifacts: false,
    logs: { audit: false, other: false, sensitive: false, period: 'all' },
  },
  snapshotId: 's',
  boundaryUnixMs: 100,
  inventoryDigestSha256: 'b'.repeat(64),
  datasets: [dataset],
};
function factory() {
  return createSqliteDatasetInspectorFactory({
    dataset,
    schema,
    async inspectRow(row) {
      if (row.value[0] !== 'text') throw new Error('value_type');
      return [];
    },
  });
}
const encode = (value: string) => new TextEncoder().encode(value);
const row = JSON.stringify({ id: ['text', 'a'], value: ['text', '日本語😀'] }) + '\n';
let encryption: TenantBundleKeyEnvelope;
beforeAll(async () => {
  encryption = await createTenantBundleKeyEnvelope('test-only backup passphrase');
});

it('inspects exported SQL bytes through encrypted bundle decoding and the reference validator', async () => {
  const db = new DatabaseSync(':memory:');
  const records = new Set<string>();
  let disposed = false;
  const key = (record: TenantPortableRecordIdentity) => JSON.stringify(record);
  const index: TenantBundleReferenceIndex = {
    async record(_bundle, record) {
      const id = key(record);
      if (records.has(id)) return false;
      records.add(id);
      return true;
    },
    async hasRecord(record) {
      return records.has(key(record));
    },
    async reference() {
      throw new Error('unexpected_reference');
    },
    async *references() {},
    async dispose() {
      disposed = true;
    },
  };
  try {
    db.exec(
      "CREATE TABLE tenants(id TEXT PRIMARY KEY NOT NULL,value TEXT); INSERT INTO tenants VALUES ('a','日本語😀'),('other','private')"
    );
    db.exec(SQLITE_SNAPSHOT_SCHEMA);
    db.exec("INSERT INTO tenant_backup_snapshots(id,tenant_id,state) VALUES ('s','a','capturing')");
    const database = {
      async query<T>(sql: string, params: unknown[] = []) {
        return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
      },
      async queryOne<T>(sql: string, params: unknown[] = []) {
        return db.prepare(sql).get(...(params as SQLInputValue[])) as T;
      },
    };
    const pinned = {
      ...manifest,
      bundleId: Array.from(encryption.envelope.slice(1, 17), (b) =>
        b.toString(16).padStart(2, '0')
      ).join(''),
    };
    async function* source() {
      yield {
        datasetId: dataset.id,
        chunks: readSqliteSnapshotDataset({
          database,
          schema,
          snapshotId: 's',
          tenantId: 'a',
          signal: new AbortController().signal,
        }),
      };
    }
    const result = await validateTenantBundleInputSet(
      [
        {
          key: encryption,
          expected: pinned,
          limits: { maxFrames: 100, maxTotalBytes: 100_000 },
          stream: encodeTenantBundle(pinned, source(), encryption, pinned),
        },
      ],
      new Map([[dataset.id, factory()]]),
      async () => index
    );
    expect(result.manifests).toHaveLength(1);
    expect(records.size).toBe(1);
    expect([...records][0]).toContain('[[\\"text\\",\\"a\\"]]');
    expect(disposed).toBe(true);
  } finally {
    db.close();
  }
});

it('handles UTF-8 split at every byte and rejects incomplete records', async () => {
  const inspector = await factory()(dataset, manifest);
  const bytes = encode(row);
  let records: TenantPortableRecordIdentity[] = [];
  for (let i = 0; i < bytes.length; i++)
    records.push(...(await inspector.chunk(bytes.slice(i, i + 1), i)).records);
  expect(records).toEqual([
    { module: dataset.module, collection: dataset.id, id: '[["text","a"]]', tenantId: 'a' },
  ]);
  await inspector.finish();
  await expect(inspector.chunk(encode(row), bytes.length)).rejects.toThrow();
  const truncated = await factory()(dataset, manifest);
  await truncated.chunk(encode(row.slice(0, -1)), 0);
  await expect(truncated.finish()).rejects.toThrow();
});

it.each([
  row.replace('["text","a"]', '["text","other"]'),
  row.replace('["text","a"]', '["null",null]'),
  row.replace('"value":', '"unknown":'),
  row.replace('["text","日本語😀"]', '["blob","not_hex"]'),
  row.replace('["text","日本語😀"]', '["integer","9223372036854775808"]'),
  row.replace('["text","日本語😀"]', '["integer","1"]'),
  '\n',
])(
  'rejects foreign, malformed or module-invalid rows before returning identities',
  async (value) => {
    const inspector = await factory()(dataset, manifest);
    await expect(inspector.chunk(encode(value), 0)).rejects.toThrow(
      /^backup_sqlite_dataset_invalid$/
    );
    await expect(inspector.finish()).rejects.toThrow();
  }
);

it('requires complete parent keys and emits a required dependency for parent ownership', async () => {
  const child: TenantPortableDataset = { ...dataset, id: 'core.children' };
  const childSchema: CaptureSchema = {
    table: 'children',
    columns: ['id', 'tenant_ref'],
    primaryKey: ['id'],
    uniqueKeys: [],
    parent: {
      schema: schema as Exclude<CaptureSchema, { parent: unknown }>,
      childColumns: ['tenant_ref'],
    },
  };
  const policy = {
    dataset: child,
    schema: childSchema,
    parentDataset: dataset,
    async inspectRow() {
      return [];
    },
  };
  const inspector = await createSqliteDatasetInspectorFactory(policy)(child, manifest);
  const result = await inspector.chunk(
    encode('{"id":["text","child"],"tenant_ref":["text","a"]}\n'),
    0
  );
  expect(result.references).toEqual([
    {
      from: result.records[0],
      to: {
        module: dataset.module,
        collection: dataset.id,
        id: '[["text","a"]]',
        tenantId: 'a',
        meaning: 'resource',
        requirement: 'required',
      },
    },
  ]);
  await inspector.finish();
  await expect(
    createSqliteDatasetInspectorFactory({ ...policy, parentDataset: undefined })(child, manifest)
  ).rejects.toThrow();
});

it('rejects rows assigned to another logical dataset in a partitioned SQL table', async () => {
  const partitionedDataset = { ...dataset, id: 'core.permissions.settings' };
  const partitionedSchema: CaptureSchema = {
    table: 'resource_permissions',
    columns: ['id', 'tenant_id', 'subject_type'],
    primaryKey: ['id'],
    uniqueKeys: [],
    tenantColumn: 'tenant_id',
    rowPartition: { column: 'subject_type', values: ['user', 'role', 'org'] },
  };
  const settingsInspector = await createSqliteDatasetInspectorFactory({
    dataset: partitionedDataset,
    schema: partitionedSchema,
    partitions: ['role', 'org'],
    async inspectRow() {
      return [];
    },
  })(partitionedDataset, { ...manifest, datasets: [partitionedDataset] });
  await expect(
    settingsInspector.chunk(
      encode(
        '{"id":["text","permission"],"tenant_id":["text","a"],"subject_type":["text","user"]}\n'
      ),
      0
    )
  ).rejects.toThrow('backup_sqlite_dataset_invalid');

  await expect(
    createSqliteDatasetInspectorFactory({
      dataset: partitionedDataset,
      schema: partitionedSchema,
      async inspectRow() {
        return [];
      },
    })(partitionedDataset, { ...manifest, datasets: [partitionedDataset] })
  ).rejects.toThrow('backup_sqlite_dataset_invalid');
});

it('bounds row allocation and rejects sequence and UTF-8 corruption', async () => {
  const inspector = await factory()(dataset, manifest);
  await expect(inspector.chunk(encode(row), 1)).rejects.toThrow();
  const badUtf8 = await factory()(dataset, manifest);
  await expect(badUtf8.chunk(new Uint8Array([255, 10]), 0)).rejects.toThrow();
  const large = await factory()(dataset, manifest);
  const block = encode('a'.repeat(4 * 1024 * 1024));
  for (let i = 0; i < 4; i++) await large.chunk(block, i);
  await expect(large.chunk(encode('a'), 4)).rejects.toThrow();
});

it('requires every sidecar-owned verification column to have a safe SQL reset', async () => {
  const installed = { dataset, schema, inspectRow: async () => [] };
  await expect(
    createSqliteDatasetInspectorFactory({
      ...installed,
      verificationIgnoredColumns: ['value'],
    })(dataset, manifest)
  ).rejects.toThrow('backup_sqlite_dataset_invalid');
  await expect(
    createSqliteDatasetInspectorFactory({
      ...installed,
      restoreOverrides: { value: ['null', null] },
      verificationIgnoredColumns: ['id'],
    })(dataset, manifest)
  ).rejects.toThrow('backup_sqlite_dataset_invalid');
  await expect(
    createSqliteDatasetInspectorFactory({
      ...installed,
      restoreOverrides: { value: ['null', null] },
      verificationIgnoredColumns: ['value'],
    })(dataset, manifest)
  ).resolves.toBeDefined();
});
