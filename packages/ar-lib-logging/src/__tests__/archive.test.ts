import { describe, expect, it } from 'vitest';
import {
  buildArchiveLogRecordV1,
  isArchiveLogRecordV1,
  projectArchiveLogRecordForExportV1,
} from '../archive';

describe('archive log record contract', () => {
  const build = () =>
    buildArchiveLogRecordV1({
      id: 'log-1',
      tenantKey: 'tenant-a',
      logType: 'audit',
      eventAt: Date.parse('2026-01-01T00:00:00Z'),
      severity: 'warn',
      type: 'permission.revoked',
      source: 'ar-management',
      subject: 'user-1',
      requestId: 'request-1',
      summary: { permission: 'document.read' },
      delivery: { targetType: 'r2', destinationId: 'archive-1' },
    });

  it('builds a stable tenant-bound archive envelope', () => {
    const record = build();
    expect(record).toMatchObject({
      schema_version: 'authrim.log.archive.v1',
      tenant_key: 'tenant-a',
      plane: 'archive',
      time: '2026-01-01T00:00:00.000Z',
      severity: 'warn',
      correlation: { request_id: 'request-1', correlation_id: null },
      authrim: { tenant_key: 'tenant-a', log_type: 'audit', plane: 'archive' },
    });
    expect(isArchiveLogRecordV1(record)).toBe(true);
  });

  it.each([
    ['null summary', { summary: null }],
    ['array summary', { summary: [] }],
    ['invalid plane', { plane: 'internal' }],
    ['invalid timestamp', { time: 'not-a-date' }],
    ['invalid severity', { severity: 'fatal' }],
    ['missing source', { source: undefined }],
  ])('rejects %s at the archive trust boundary', (_name, replacement) => {
    expect(isArchiveLogRecordV1({ ...build(), ...replacement })).toBe(false);
  });

  it('projects only the stable export contract with immutable evidence', () => {
    const projection = projectArchiveLogRecordForExportV1(build(), {
      object_key: 'tenant-a/2026/01/chunk.ndjson',
      line_number: 7,
    });
    expect(projection).toMatchObject({
      schema_version: 'authrim.log.export.projection.v1',
      source_schema_version: 'authrim.log.archive.v1',
      record_id: 'log-1',
      tenant_key: 'tenant-a',
      evidence: { object_key: 'tenant-a/2026/01/chunk.ndjson', line_number: 7 },
    });
    expect(projection).not.toHaveProperty('delivery');
    expect(projection).not.toHaveProperty('authrim');
  });
});
