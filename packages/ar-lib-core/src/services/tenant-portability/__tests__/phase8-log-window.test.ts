import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inventoryBackupSchemas } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { TENANT_DATASET_POLICIES } from '../dataset-registry';
import {
  PHASE8_LOG_TIMESTAMP_COLUMNS,
  parsePhase8PortableSqliteRow,
  phase8LogDependencyRowInSelection,
  phase8LogRowInWindow,
} from '../phase8-log-window';

const row = (column: string, value: string, type = 'integer') =>
  ({ [column]: [type, value] }) as never;

describe('Phase 8 log window', () => {
  it('selects cumulative failure aggregates by last_at rather than first_at', () => {
    const boundaryUnixMs = 100 * 86_400_000;
    for (const [lastAt, selected] of [
      [93 * 86_400_000 - 1, false],
      [93 * 86_400_000, true],
      [boundaryUnixMs, true],
      [boundaryUnixMs + 1, false],
    ] as const) {
      const aggregate = {
        first_at: ['integer', '1'],
        last_at: ['integer', String(lastAt)],
        count: ['integer', '12345'],
      } as const;
      expect(
        phase8LogRowInWindow({
          datasetId: 'admin.identity_mapping_failures',
          period: 7,
          boundaryUnixMs,
          row: aggregate,
        })
      ).toBe(selected);
      expect(aggregate.count).toEqual(['integer', '12345']);
    }
  });

  it('pins one timestamp column for every selected log table', () => {
    const ids = TENANT_DATASET_POLICIES.filter(({ kind }) =>
      ['audit', 'history', 'sensitive_logs'].includes(kind)
    )
      .map(({ family, table }) => `${family}.${table}`)
      .sort();
    expect(Object.keys(PHASE8_LOG_TIMESTAMP_COLUMNS).sort()).toEqual(ids);
  });

  it('pins a column whose installed type matches the declared unit', () => {
    const repositoryRoot = fileURLToPath(new URL('../../../../../../', import.meta.url));
    const streams = new Map(
      inventoryBackupSchemas(repositoryRoot).inspectedStreams.map((stream) => [stream.id, stream])
    );
    for (const [datasetId, timestamp] of Object.entries(PHASE8_LOG_TIMESTAMP_COLUMNS)) {
      const [family, table] = datasetId.split('.');
      const stream = streams.get(`${family.replaceAll('_', '-')}-d1` as never);
      const column = stream?.tables
        .find(({ name }) => name === table)
        ?.columns.find(({ name }) => name === timestamp.column);
      expect(column, datasetId).toBeDefined();
      expect(column?.notNull, datasetId).toBe(true);
      expect(column?.type.toUpperCase(), datasetId).toBe(
        timestamp.unit === 'iso8601' ? 'TEXT' : 'INTEGER'
      );
    }
  });

  it('uses inclusive fixed boundaries for 7, 30 and all-day selections', () => {
    const boundaryUnixMs = 100 * 86_400_000;
    const input = { datasetId: 'admin.admin_audit_log', boundaryUnixMs };
    expect(
      phase8LogRowInWindow({ ...input, period: 7, row: row('created_at', String(93 * 86_400_000)) })
    ).toBe(true);
    expect(
      phase8LogRowInWindow({
        ...input,
        period: 7,
        row: row('created_at', String(93 * 86_400_000 - 1)),
      })
    ).toBe(false);
    expect(
      phase8LogRowInWindow({
        ...input,
        period: 30,
        row: row('created_at', String(boundaryUnixMs + 1)),
      })
    ).toBe(false);
    expect(phase8LogRowInWindow({ ...input, period: 'all', row: row('created_at', '0') })).toBe(
      true
    );
  });

  it('converts tables that store seconds before comparing with the millisecond window', () => {
    // 2026-10-21T00:00:00Z; one second is the finest a seconds column can express.
    const boundaryUnixMs = 1_792_540_800_000;
    const boundarySeconds = boundaryUnixMs / 1000;
    const secondsTables = Object.entries(PHASE8_LOG_TIMESTAMP_COLUMNS).filter(
      ([, timestamp]) => timestamp.unit === 's'
    );
    expect(secondsTables.map(([datasetId]) => datasetId).sort()).toEqual([
      'core.audit_log',
      'core.custom_claim_schema_history',
      'core.flow_audit_events',
      'core.operational_logs',
      'core.permission_check_audit',
      'core.plugin_account_metadata_audit',
      'core.settings_history',
      'pii.identity_identifier_replacement_history',
      'plugin_runner.plugin_runner_egress_audit',
    ]);
    for (const [datasetId, { column }] of secondsTables) {
      const inWindow = (stored: number, period: 7 | 30 | 90 | 'all') =>
        phase8LogRowInWindow({
          datasetId,
          period,
          boundaryUnixMs,
          row: row(column, String(stored)),
        });
      // A row written one hour before the boundary is in every window.
      for (const period of [7, 30, 90, 'all'] as const)
        expect(inWindow(boundarySeconds - 3600, period), `${datasetId} ${period}`).toBe(true);
      expect(inWindow(boundarySeconds - 7 * 86_400, 7), datasetId).toBe(true);
      expect(inWindow(boundarySeconds - 7 * 86_400 - 1, 7), datasetId).toBe(false);
      expect(inWindow(boundarySeconds, 7), datasetId).toBe(true);
      expect(inWindow(boundarySeconds + 1, 7), datasetId).toBe(false);
    }
    // The bug this guards against: a seconds value read as milliseconds is decades old.
    expect(
      phase8LogRowInWindow({
        datasetId: 'core.audit_log',
        period: 90,
        boundaryUnixMs,
        row: row('created_at', String(boundarySeconds - 60)),
      })
    ).toBe(true);
  });

  it('reads the event-time column, not another timestamp of the same row', () => {
    const boundaryUnixMs = 1_792_540_800_000;
    // permission_change_audit.created_at is seconds; its event time `timestamp` is milliseconds.
    const change = {
      created_at: ['integer', String(boundaryUnixMs / 1000 - 30 * 86_400)],
      timestamp: ['integer', String(boundaryUnixMs - 60_000)],
    } as never;
    expect(
      phase8LogRowInWindow({
        datasetId: 'core.permission_change_audit',
        period: 7,
        boundaryUnixMs,
        row: change,
      })
    ).toBe(true);
  });

  it('windows lifecycle signals by the time this deployment observed them', () => {
    const boundaryUnixMs = 100 * 86_400_000;
    const signal = (observedAt: number) =>
      ({
        source_timestamp: ['integer', null],
        observed_at: ['integer', String(observedAt)],
      }) as never;
    const inWindow = (observedAt: number) =>
      phase8LogRowInWindow({
        datasetId: 'core.external_lifecycle_signal_events',
        period: 7,
        boundaryUnixMs,
        row: signal(observedAt),
      });
    expect(inWindow(boundaryUnixMs - 1)).toBe(true);
    expect(inWindow(93 * 86_400_000 - 1)).toBe(false);
  });

  it('parses ISO 8601 text timestamps as UTC unless they carry an offset', () => {
    const boundaryUnixMs = Date.parse('2026-10-21T00:00:00Z');
    const inWindow = (value: string, period: 7 | 'all' = 7) =>
      phase8LogRowInWindow({
        datasetId: 'core.webhook_delivery_logs',
        period,
        boundaryUnixMs,
        row: row('created_at', value, 'text'),
      });
    expect(inWindow('2026-10-20 12:00:00')).toBe(true);
    expect(inWindow('2026-10-20T12:00:00.123Z')).toBe(true);
    expect(inWindow('2026-10-14T00:00:00Z')).toBe(true);
    expect(inWindow('2026-10-13 23:59:59')).toBe(false);
    expect(inWindow('2026-10-14T08:59:59+09:00')).toBe(false);
    expect(inWindow('2026-10-21T00:00:01Z')).toBe(false);
    // The window ends at the boundary millisecond; finer fractions could round into it.
    expect(inWindow('2026-10-21T00:00:00.000Z')).toBe(true);
    expect(inWindow('2026-10-21 00:00:00.001')).toBe(false);
    // 15:00-09:00 is the boundary instant itself.
    expect(inWindow('2026-10-20T15:00:00-09:00')).toBe(true);
    expect(inWindow('2026-10-20T15:00:00.001-09:00')).toBe(false);
    expect(inWindow('2024-02-29T00:00:00Z', 'all')).toBe(true);
    for (const malformed of [
      '',
      '1792540800000',
      'yesterday',
      '2026-13-01T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-02-29T00:00:00Z',
      '2026-04-31 00:00:00',
      '2026-10-20T24:00:00Z',
      '2026-10-20T23:60:00Z',
      '2026-10-20T23:59:60Z',
      '2026-10-21T00:00:00.0001Z',
      '2026-10-20T12:00:00+24:00',
      '1969-12-31T23:59:59Z',
    ])
      expect(() => inWindow(malformed, 'all'), malformed).toThrow(
        'backup_phase8_log_timestamp_invalid'
      );
    expect(() =>
      phase8LogRowInWindow({
        datasetId: 'core.webhook_delivery_logs',
        period: 'all',
        boundaryUnixMs,
        row: row('created_at', '1792540800000'),
      })
    ).toThrow('backup_phase8_log_timestamp_invalid');
  });

  it('rejects missing, non-integer and unknown timestamp contracts', () => {
    const input = { datasetId: 'core.audit_log', period: 7 as const, boundaryUnixMs: 10 };
    expect(() => phase8LogRowInWindow({ ...input, row: {} })).toThrow(
      'backup_phase8_log_timestamp_invalid'
    );
    expect(() => phase8LogRowInWindow({ ...input, row: row('created_at', '10', 'text') })).toThrow(
      'backup_phase8_log_timestamp_invalid'
    );
    expect(() =>
      phase8LogRowInWindow({ ...input, row: row('created_at', String(2 ** 53 / 1000)) })
    ).toThrow('backup_phase8_log_timestamp_invalid');
    for (const datasetId of ['unknown', 'toString', '__proto__'])
      expect(() =>
        phase8LogRowInWindow({ ...input, datasetId, row: row('created_at', '10') })
      ).toThrow('backup_phase8_log_timestamp_invalid');
  });

  it('strictly parses typed portable rows', () => {
    expect(parsePhase8PortableSqliteRow('{"created_at":["integer","1"]}')).toEqual({
      created_at: ['integer', '1'],
    });
    for (const invalid of ['', 'null', '[]', '1'])
      expect(() => parsePhase8PortableSqliteRow(invalid)).toThrow(
        'backup_phase8_log_timestamp_invalid'
      );
  });

  it('selects sensitive-detail dependencies by their owning data category', () => {
    const boundaryUnixMs = 100 * 86_400_000;
    const selection = {
      settings: false,
      users: true,
      admin: true,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: true, period: 7 as const },
    };
    const detail = (objectClass: string, createdAt: number) =>
      ({
        object_class: ['text', objectClass],
        created_at: ['integer', String(createdAt)],
      }) as never;
    const selected = (objectClass: string, createdAt = 1) =>
      phase8LogDependencyRowInSelection({
        datasetId: 'core.sensitive_detail_chunk_index',
        row: detail(objectClass, createdAt),
        selection,
        boundaryUnixMs,
      });

    expect(selected('webhook_delivery_payload')).toBe(true);
    expect(selected('approval_transport_detail')).toBe(true);
    expect(selected('pii_log_values')).toBe(false);
    expect(selected('event_log_detail', boundaryUnixMs)).toBe(false);
    selection.logs.other = true;
    expect(selected('event_log_detail', boundaryUnixMs)).toBe(true);
    expect(selected('event_log_detail', 93 * 86_400_000 - 1)).toBe(false);
  });
});
