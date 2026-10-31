import { afterEach, describe, expect, it } from 'vitest';
import { logProducerFixture } from '../../__tests__/log-iceberg-producer-fixture';
import { buildLogIcebergRowRecord } from '../../log-iceberg-emitter';
import { decryptLogIcebergRecord } from '../../log-iceberg-record';
import { decodeLogIcebergRow, decryptProtectedLogIcebergDetail } from '../../log-iceberg-row-codec';
import {
  decodePortableIcebergLog,
  encodePortableIcebergLog,
  icebergLogSelected,
  ICEBERG_LOG_RECORDS_DATASETS,
  icebergLogCategory,
  createIcebergLogRecordDatasetPolicy,
} from '../portable-iceberg-log';

import {
  assertTenantBackupInputLogDetailCoverage,
  loadPlannedTenantBackupInputs,
  tenantBackupInputDatasetOwners,
} from '../input-plan';
import {
  tenantDatasetSelectionRule,
  tenantBackupSelectionsCover,
  type TenantBackupSelection,
} from '../selection-contract';

const opened: Array<Awaited<ReturnType<typeof logProducerFixture>>> = [];
async function fixture() {
  const f = await logProducerFixture('scheduled');
  opened.push(f);
  return f;
}
afterEach(() => {
  for (const f of opened.splice(0)) f.db.close();
});
const selection = {
  settings: false,
  users: true,
  admin: false,
  artifacts: false,
  logs: { audit: true, other: false, sensitive: false, period: 7 as const },
};
describe('logical Iceberg DR records', () => {
  it('re-encrypts overview, row and protected metadata with target keys without copying source routing or extending expiry', async () => {
    const source = await fixture(),
      target = await fixture();
    const record = await buildLogIcebergRowRecord(source.env, {
      tenantId: 'tenant-a',
      sourceDataset: 'admin.admin_audit_log',
      logType: 'admin_audit',
      eventAt: source.now,
      ingestedAt: source.now - 1000,
      expiresAt: source.now + 86400000,
      overview: { action: 'user.update', subject_id: 'admin-a' },
      adminInlineMetadata: { admin_actor_type: 'admin_user', admin_actor_id: 'admin-a' },
      row: {
        id: 'audit-dr-1',
        tenant_id: 'tenant-a',
        admin_user_id: 'admin-a',
        action: 'user.update',
        metadata_json: JSON.stringify({ email: 'private@example.invalid', freeform: 'protected' }),
        before_json: '{"status":"pending"}',
        after_json: '{"status":"active"}',
        created_at: source.now,
      },
    });
    const bytes = await encodePortableIcebergLog({
      record,
      tenantId: 'tenant-a',
      tenantKey: 'key-a',
      resolveKeys: async () => source.keys,
      includeSensitiveDetails: true,
    });
    const withoutDetails = new TextDecoder().decode(
      await encodePortableIcebergLog({
        record,
        tenantId: 'tenant-a',
        tenantKey: 'key-a',
        resolveKeys: async () => source.keys,
        includeSensitiveDetails: false,
      })
    );
    for (const secret of ['private@example.invalid', 'freeform', 'pending', 'active'])
      expect(withoutDetails).not.toContain(secret);
    expect(decodePortableIcebergLog(withoutDetails, 'tenant-a').adminInlineMetadata).toEqual({
      admin_actor_type: 'admin_user',
      admin_actor_id: 'admin-a',
    });
    const text = new TextDecoder().decode(bytes);
    for (const value of [
      record.detail_ciphertext,
      record.storage_generation,
      'rootKeyHex',
      'physicalFingerprint',
      's3://',
    ])
      expect(text).not.toContain(value);
    const input = decodePortableIcebergLog(text, 'tenant-a');
    expect(input).toMatchObject({
      eventAt: record.event_at,
      ingestedAt: record.ingested_at,
      expiresAt: record.expires_at,
    });
    target.db.prepare("UPDATE tenants SET tenant_key='target-key' WHERE id='tenant-a'").run();
    target.env.OBJECT_ENCRYPTION_ROOT_KEY = 'ef'.repeat(32);
    target.env.LOG_ARCHIVE_CONTENT_HMAC_KEY = 'fe'.repeat(32);
    target.env.LOG_ARCHIVE_ROOT_KEYRING = JSON.stringify({
      schema_version: 1,
      current_version: 1,
      roots: { 1: 'ef'.repeat(32) },
    });
    const restored = await buildLogIcebergRowRecord(target.env, input);
    const keys = { rootKeyHex: 'ef'.repeat(32), contentHmacKeyHex: 'fe'.repeat(32), keyVersion: 1 };
    expect(restored.tenant_key).toBe('target-key');
    expect(restored.payload_hmac).not.toBe(record.payload_hmac);
    expect(restored.detail_ciphertext).not.toBe(record.detail_ciphertext);
    const body = await decryptLogIcebergRecord(
      restored,
      { tenantKey: 'target-key', sourceDataset: record.source_dataset },
      async () => keys
    );
    const row = decodeLogIcebergRow(body, 'tenant-a', record.event_id);
    expect(row.metadata_json).not.toContain('private@example.invalid');
    expect(JSON.parse(String(row.metadata_json))).toMatchObject({ admin_actor_id: 'admin-a' });
    const detail = await decryptProtectedLogIcebergDetail({
      record: restored,
      body,
      resolveKeys: async () => keys,
    });
    expect(detail).toMatchObject({
      metadata_json: JSON.stringify({ email: 'private@example.invalid', freeform: 'protected' }),
      before_json: '{"status":"pending"}',
      after_json: '{"status":"active"}',
    });
    await expect(
      decryptLogIcebergRecord(
        restored,
        { tenantKey: 'target-key', sourceDataset: record.source_dataset },
        async () => source.keys
      )
    ).rejects.toThrow();
  });

  it('rejects a cross-tenant envelope, unknown source and malformed scalar row', async () => {
    const f = await fixture();
    const record = await buildLogIcebergRowRecord(f.env, {
      tenantId: 'tenant-a',
      sourceDataset: 'core.audit_log',
      logType: 'audit',
      eventAt: f.now,
      expiresAt: null,
      row: { id: 'audit-1', tenant_id: 'tenant-a' },
    });
    const bytes = await encodePortableIcebergLog({
      record,
      tenantId: 'tenant-a',
      tenantKey: 'key-a',
      resolveKeys: async () => f.keys,
      includeSensitiveDetails: true,
    });
    const text = new TextDecoder().decode(bytes);
    expect(() => decodePortableIcebergLog(text, 'tenant-b')).toThrow();
    const outer = JSON.parse(text) as {
      record_json: ['text', string];
      source_dataset: ['text', string];
    };
    const inner = JSON.parse(outer.record_json[1]) as {
      source_dataset: string;
      row: Record<string, unknown>;
    };
    inner.source_dataset = 'core.unknown';
    outer.source_dataset[1] = 'core.unknown';
    outer.record_json[1] = JSON.stringify(inner);
    expect(() => decodePortableIcebergLog(JSON.stringify(outer), 'tenant-a')).toThrow();
    inner.source_dataset = 'core.audit_log';
    outer.source_dataset[1] = 'core.audit_log';
    inner.row.injected = { nested: 'value' };
    outer.record_json[1] = JSON.stringify(inner);
    expect(() => decodePortableIcebergLog(JSON.stringify(outer), 'tenant-a')).toThrow();
  });

  it('keeps sensitive selection, T0 window and total expiry independent', () => {
    const base = {
      source_dataset: 'core.audit_log',
      log_type: 'audit',
      event_at: 20 * 86400000,
      expires_at: null,
    };
    expect(icebergLogSelected(base, selection, 21 * 86400000)).toBe(true);
    expect(icebergLogSelected({ ...base, event_at: 10 * 86400000 }, selection, 21 * 86400000)).toBe(
      false
    );
    expect(
      icebergLogSelected({ ...base, expires_at: 21 * 86400000 }, selection, 21 * 86400000)
    ).toBe(false);
    expect(
      icebergLogSelected({ ...base, source_dataset: 'pii.pii_log' }, selection, 21 * 86400000)
    ).toBe(false);
    expect(
      icebergLogSelected(
        { ...base, source_dataset: 'pii.pii_log' },
        { ...selection, logs: { ...selection.logs, sensitive: true } },
        21 * 86400000
      )
    ).toBe(true);
  });
});

function inputBundle(bundleId: string, boundaryUnixMs: number, selected: TenantBackupSelection) {
  return {
    version: 1 as const,
    kind: 'backup-input' as const,
    identity: { key: bundleId, etag: bundleId, version: bundleId, size: 256 },
    limits: { maxFrames: 100, maxTotalBytes: 1024 },
    manifest: {
      formatVersion: 1 as const,
      bundleId,
      snapshotId: 'snapshot-' + bundleId,
      source: { tenantId: 'tenant-a', issuer: 'https://source.invalid', productVersion: '1' },
      boundaryUnixMs,
      inventoryDigestSha256: 'a'.repeat(64),
      selection: selected,
      datasets: ICEBERG_LOG_RECORDS_DATASETS.filter(
        (dataset) => tenantDatasetSelectionRule(dataset.kind, selected).action === 'selected'
      ),
    },
  };
}

it('keeps independent audit/other/sensitive owners when bundles are combined, without a settings-only owner', () => {
  const none = {
    ...selection,
    settings: false,
    logs: { audit: false, other: false, sensitive: false, period: 7 as const },
  };
  const audit = { ...none, logs: { ...none.logs, audit: true } };
  const other = { ...none, logs: { ...none.logs, other: true } };
  const sensitive = { ...none, logs: { ...none.logs, sensitive: true } };
  const settings = { ...none, settings: true };
  const bundles = [
    inputBundle('audit-old', 1, audit),
    inputBundle('other', 2, other),
    inputBundle('sensitive', 3, sensitive),
    inputBundle('settings-newest', 9, settings),
    inputBundle('audit-new', 4, audit),
  ];
  const requested = {
    ...settings,
    logs: { audit: true, other: true, sensitive: true, period: 7 as const },
  };
  expect(
    tenantBackupSelectionsCover(
      requested,
      bundles.map((bundle) => bundle.manifest.selection)
    )
  ).toBe(true);
  expect(Object.fromEntries(tenantBackupInputDatasetOwners(bundles))).toEqual({
    'logs.iceberg_audit_records': 'audit-new',
    'logs.iceberg_other_records': 'other',
    'logs.iceberg_sensitive_records': 'sensitive',
  });
  expect(inputBundle('settings-only', 100, settings).manifest.datasets).toHaveLength(0);
});

it.each(['audit', 'other'] as const)(
  'rejects missing %s protected details from split inputs and a newer redacted owner',
  async (category) => {
    const f = await fixture();
    const sourceDataset = category === 'audit' ? 'admin.admin_audit_log' : 'core.operational_logs';
    const record = await buildLogIcebergRowRecord(f.env, {
      tenantId: 'tenant-a',
      sourceDataset,
      logType: category === 'audit' ? 'admin_audit' : 'operational',
      eventAt: f.now,
      expiresAt: null,
      row: {
        id: 'protected-' + category,
        tenant_id: 'tenant-a',
        created_at: f.now,
        ...(category === 'audit'
          ? {
              before_json: '{"state":"before"}',
              after_json: '{"state":"after"}',
              metadata_json: '{"private":"synthetic"}',
            }
          : { reason_detail_encrypted: null, encryption_key_version: 0 }),
      },
      ...(category === 'other'
        ? { protectedDetail: { reason_detail: 'synthetic protected reason' } }
        : {}),
    });
    const portable = async (includeSensitiveDetails: boolean) =>
      decodePortableIcebergLog(
        new TextDecoder().decode(
          await encodePortableIcebergLog({
            record,
            tenantId: 'tenant-a',
            tenantKey: 'key-a',
            resolveKeys: async () => f.keys,
            includeSensitiveDetails,
          })
        ),
        'tenant-a'
      );
    const fullRecord = await portable(true);
    const redactedRecord = await portable(false);
    if (category === 'audit') {
      expect(fullRecord.row.before_json).toBe('{"state":"before"}');
      expect(redactedRecord.row.before_json).toBeNull();
    } else {
      expect(fullRecord.protectedDetail?.reason_detail).toBe('synthetic protected reason');
      expect(redactedRecord.protectedDetail).toBeUndefined();
    }
    const none = {
      settings: false,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 7 as const },
    };
    const only = { ...none, logs: { ...none.logs, [category]: true } };
    const sensitive = { ...none, logs: { ...none.logs, sensitive: true } };
    const requested = { ...only, logs: { ...only.logs, sensitive: true } };
    const datasetId = `logs.iceberg_${category}_records`;
    const expectedIds = new Set([datasetId, 'logs.iceberg_sensitive_records']);
    expect(icebergLogSelected(record, sensitive, f.now)).toBe(false);
    const split = [inputBundle('a'.repeat(32), 2, only), inputBundle('b'.repeat(32), 3, sensitive)];
    const newerRedacted = [
      inputBundle('c'.repeat(32), 1, requested),
      inputBundle('d'.repeat(32), 2, only),
    ];
    for (const inputs of [split, newerRedacted]) {
      expect(
        tenantBackupSelectionsCover(
          requested,
          inputs.map(({ manifest }) => manifest.selection)
        )
      ).toBe(true);
      expect(tenantBackupInputDatasetOwners(inputs).get(datasetId)).toBe(
        inputs === split ? 'a'.repeat(32) : 'd'.repeat(32)
      );
      expect(() =>
        assertTenantBackupInputLogDetailCoverage(inputs, requested, expectedIds)
      ).toThrow('backup_input_sensitive_log_details_uncovered');
      // The common sealed-input loader must reject the same canonically decoded manifests.
      const context = {
        operation: {
          kind: 'import',
          state: 'running',
          id: 'operation-a',
          tenant_id: 'tenant-a',
          lease_owner: 'worker-a',
          fencing_token: 1,
        },
        lease: {
          operationId: 'operation-a',
          tenantId: 'tenant-a',
          owner: 'worker-a',
          fencingToken: 1,
        },
        signal: new AbortController().signal,
      } as Parameters<typeof loadPlannedTenantBackupInputs>[0];
      const inventory = {
        headForLease: async () => ({ state: 'sealed', item_count: inputs.length }),
        readPage: async (ordinal: number) => [
          {
            ordinal,
            item_id: `backup-input:${inputs[ordinal].manifest.bundleId}`,
            payload_json: JSON.stringify(inputs[ordinal]),
          },
        ],
      } as unknown as Parameters<typeof loadPlannedTenantBackupInputs>[1];
      await expect(
        loadPlannedTenantBackupInputs(context, inventory, {
          source: inputs[0].manifest.source,
          selection: requested,
          datasets: ICEBERG_LOG_RECORDS_DATASETS.filter(({ id }) => expectedIds.has(id)),
        })
      ).rejects.toThrow('backup_input_sensitive_log_details_uncovered');
    }
    const fullOwner = [
      inputBundle('e'.repeat(32), 1, only),
      inputBundle('f'.repeat(32), 2, requested),
    ];
    expect(tenantBackupInputDatasetOwners(fullOwner).get(datasetId)).toBe('f'.repeat(32));
    expect(() =>
      assertTenantBackupInputLogDetailCoverage(fullOwner, requested, expectedIds)
    ).not.toThrow();
    expect(() =>
      assertTenantBackupInputLogDetailCoverage([split[0]], only, expectedIds)
    ).not.toThrow();
    // Legacy physical datasets and other categories do not acquire a new policy here.
    expect(() =>
      assertTenantBackupInputLogDetailCoverage(split, requested, new Set(['core.audit_log']))
    ).not.toThrow();
  }
);

it('binds logical log dataset policies to their category and tenant rather than trusting an envelope label', async () => {
  const f = await fixture();
  const record = await buildLogIcebergRowRecord(f.env, {
    tenantId: 'tenant-a',
    sourceDataset: 'core.audit_log',
    logType: 'audit',
    eventAt: f.now,
    expiresAt: null,
    row: { id: 'policy-row', tenant_id: 'tenant-a' },
  });
  const text = new TextDecoder().decode(
    await encodePortableIcebergLog({
      record,
      tenantId: 'tenant-a',
      tenantKey: 'key-a',
      resolveKeys: async () => f.keys,
      includeSensitiveDetails: false,
    })
  );
  const row: unknown = JSON.parse(text);
  const audit = createIcebergLogRecordDatasetPolicy('logs.iceberg_audit_records');
  const other = createIcebergLogRecordDatasetPolicy('logs.iceberg_other_records');
  // Inspection receives scalar rows only after the shared row-shape validator.
  await expect(
    audit.inspectRow(
      row as Parameters<typeof audit.inspectRow>[0],
      { tenantId: 'tenant-a' } as Parameters<typeof audit.inspectRow>[1]
    )
  ).resolves.toEqual([]);
  await expect(
    other.inspectRow(
      row as Parameters<typeof other.inspectRow>[0],
      { tenantId: 'tenant-a' } as Parameters<typeof other.inspectRow>[1]
    )
  ).rejects.toThrow('backup_iceberg_log_record_invalid');
  expect(icebergLogCategory({ source_dataset: 'pii.audit_log_pii', log_type: 'audit' })).toBe(
    'sensitive'
  );
  expect(
    icebergLogCategory({ source_dataset: 'core.operational_logs', log_type: 'operational' })
  ).toBe('other');
});
