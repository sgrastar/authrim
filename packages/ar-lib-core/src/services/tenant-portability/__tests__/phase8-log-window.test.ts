import { describe, expect, it } from 'vitest';
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
  it('pins one timestamp column for every selected log table', () => {
    const ids = TENANT_DATASET_POLICIES.filter(({ kind }) =>
      ['audit', 'history', 'sensitive_logs'].includes(kind)
    )
      .map(({ family, table }) => `${family}.${table}`)
      .sort();
    expect(Object.keys(PHASE8_LOG_TIMESTAMP_COLUMNS).sort()).toEqual(ids);
  });

  it('uses inclusive fixed boundaries for 7, 30 and all-day selections', () => {
    const boundaryUnixMs = 100 * 86_400_000;
    const input = { datasetId: 'core.audit_log', boundaryUnixMs };
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

  it('rejects missing, non-integer and unknown timestamp contracts', () => {
    const input = { datasetId: 'core.audit_log', period: 7 as const, boundaryUnixMs: 10 };
    expect(() => phase8LogRowInWindow({ ...input, row: {} })).toThrow(
      'backup_phase8_log_timestamp_invalid'
    );
    expect(() => phase8LogRowInWindow({ ...input, row: row('created_at', '10', 'text') })).toThrow(
      'backup_phase8_log_timestamp_invalid'
    );
    expect(() =>
      phase8LogRowInWindow({ ...input, datasetId: 'unknown', row: row('created_at', '10') })
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
