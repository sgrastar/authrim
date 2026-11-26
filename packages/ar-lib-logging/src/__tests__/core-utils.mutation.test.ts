import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildArchiveLogRecordV1,
  isArchiveLogRecordV1,
  projectArchiveLogRecordForExportV1,
  type ArchiveLogRecordV1,
} from '../archive';
import { createLoggingId, createUuidV7 } from '../ids';
import {
  LOG_CHUNK_COMPRESSION,
  LOG_PLANES,
  LOG_TYPES,
  assertLogPlane,
  assertLogType,
} from '../registry';
import { createOpaqueTenantKey, deriveTenantKeyFromTenantId } from '../tenant-key';
import { LOGGING_TIME_UNITS, floorTimeBucket, formatUtcPartition, nowEpochMs } from '../time';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createUuidV7', () => {
  const random = Uint8Array.from([0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19]);

  it('lays out the timestamp, version, variant and random bytes', () => {
    expect(createUuidV7(0x0123456789ab, random)).toBe('01234567-89ab-7011-9213-141516171819');
  });

  it('forces the version and variant bits over any random bits', () => {
    expect(createUuidV7(0, new Uint8Array(10).fill(0xff))).toBe(
      '00000000-0000-7fff-bfff-ffffffffffff'
    );
    expect(createUuidV7(0, new Uint8Array(10))).toBe('00000000-0000-7000-8000-000000000000');
  });

  it('clamps the timestamp to 48 bits and to zero, and drops fractions', () => {
    expect(createUuidV7(-5, random).slice(0, 13)).toBe('00000000-0000');
    expect(createUuidV7(2 ** 48 + 10, random).slice(0, 13)).toBe('ffffffff-ffff');
    expect(createUuidV7(2 ** 48 - 1, random).slice(0, 13)).toBe('ffffffff-ffff');
    expect(createUuidV7(0x0123456789ab + 0.9, random).slice(0, 13)).toBe('01234567-89ab');
  });

  it('requires exactly ten random bytes', () => {
    expect(() => createUuidV7(1, new Uint8Array(9))).toThrow('uuidv7_random_must_be_10_bytes');
    expect(() => createUuidV7(1, new Uint8Array(11))).toThrow('uuidv7_random_must_be_10_bytes');
  });

  it('uses the current time and the random source bytes by default', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(0x0123456789ab));
    let fill = 0;
    const spy = vi
      .spyOn(crypto, 'getRandomValues')
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        fill += 1;
        if (array instanceof Uint8Array) array.fill(fill);
        return array;
      });
    const first = createUuidV7();
    const second = createUuidV7();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(first).toBe('01234567-89ab-7101-8101-010101010101');
    expect(second).toBe('01234567-89ab-7202-8202-020202020202');
  });
});

describe('createLoggingId', () => {
  it('prefixes a UUIDv7 made at the given time', () => {
    expect(createLoggingId('dest', 0x0123456789ab)).toMatch(/^dest_01234567-89ab-7[0-9a-f]{3}-/);
  });

  it('uses the current time by default', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(0x0123456789ab));
    expect(createLoggingId('evt')).toMatch(/^evt_01234567-89ab-7/);
  });
});

describe('tenant keys', () => {
  it('encodes 18 random bytes as 24 URL-safe characters', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) {
          for (let index = 0; index < array.length; index += 1) {
            array[index] = [0xfb, 0xef, 0xbe][index % 3] ?? 0;
          }
        }
        return array;
      }
    );
    expect(createOpaqueTenantKey()).toBe(`t_${'-'.repeat(24)}`);
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) array.fill(0xff);
        return array;
      }
    );
    expect(createOpaqueTenantKey()).toBe(`t_${'_'.repeat(24)}`);
  });

  it('derives a stable key from the tenant id', async () => {
    expect(await deriveTenantKeyFromTenantId('tenant-a')).toBe(
      't_gKcHr33HfuEij5EnGA85ZINeW-tMSrDY'
    );
    expect(await deriveTenantKeyFromTenantId('tenant-0')).toBe(
      't_DnT1mg2pVjCaL7F-hwZ6zItZcRcC7_Vk'
    );
  });

  it('trims the tenant id and mixes the salt in', async () => {
    expect(await deriveTenantKeyFromTenantId('  tenant-a \n')).toBe(
      't_gKcHr33HfuEij5EnGA85ZINeW-tMSrDY'
    );
    expect(await deriveTenantKeyFromTenantId('tenant-a', 'salt1')).toBe(
      't_lB2gV9xFjdovvAd34HyuT7x8pO5tr7DP'
    );
    expect(await deriveTenantKeyFromTenantId('tenant-a', '')).toBe(
      't_gKcHr33HfuEij5EnGA85ZINeW-tMSrDY'
    );
  });

  it('refuses an empty tenant id', async () => {
    await expect(deriveTenantKeyFromTenantId('')).rejects.toThrow('tenant_id_required');
    await expect(deriveTenantKeyFromTenantId('  \t')).rejects.toThrow('tenant_id_required');
  });
});

describe('time helpers', () => {
  it('names its unit and reads the clock', () => {
    expect(LOGGING_TIME_UNITS).toBe('epoch_ms');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1_234_567));
    expect(nowEpochMs()).toBe(1_234_567);
  });

  it('floors to the start of the interval', () => {
    expect(floorTimeBucket(0, 1000)).toBe(0);
    expect(floorTimeBucket(999, 1000)).toBe(0);
    expect(floorTimeBucket(1000, 1000)).toBe(1000);
    expect(floorTimeBucket(12_345, 1000)).toBe(12_000);
    expect(floorTimeBucket(7, 0.5)).toBe(7);
  });

  it('refuses a bad time or interval', () => {
    for (const time of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => floorTimeBucket(time, 1000)).toThrow('invalid_epoch_ms');
    }
    for (const interval of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => floorTimeBucket(1000, interval)).toThrow('invalid_interval_ms');
    }
  });

  it('formats UTC partitions with zero padding', () => {
    expect(formatUtcPartition(Date.UTC(2026, 0, 2, 3))).toStrictEqual({
      year: '2026',
      month: '01',
      day: '02',
      hour: '03',
    });
    expect(formatUtcPartition(Date.UTC(2026, 11, 31, 23))).toStrictEqual({
      year: '2026',
      month: '12',
      day: '31',
      hour: '23',
    });
    const early = new Date(0);
    early.setUTCFullYear(5);
    expect(formatUtcPartition(early.getTime()).year).toBe('0005');
  });
});

describe('registry', () => {
  it('lists the log types, planes and chunk compressions', () => {
    expect([...LOG_TYPES]).toEqual([
      'normal',
      'audit',
      'admin_audit',
      'security',
      'pii',
      'diagnostic',
      'job',
      'webhook',
      'operational',
    ]);
    expect([...LOG_PLANES]).toEqual([
      'primary',
      'archive',
      'external_sink',
      'sensitive_detail',
      'diagnostic_detail',
      'delivery_event',
    ]);
    expect([...LOG_CHUNK_COMPRESSION]).toEqual(['none', 'gzip_block']);
  });

  it('accepts every known type and plane and names an unknown one', () => {
    for (const type of LOG_TYPES) expect(() => assertLogType(type)).not.toThrow();
    for (const plane of LOG_PLANES) expect(() => assertLogPlane(plane)).not.toThrow();
    expect(() => assertLogType('nope')).toThrow('unsupported_log_type:nope');
    expect(() => assertLogPlane('nope')).toThrow('unsupported_log_plane:nope');
    expect(() => assertLogType('')).toThrow('unsupported_log_type:');
  });
});

describe('archive records', () => {
  const eventAt = Date.parse('2026-01-01T00:00:00Z');
  const base = {
    id: 'log-1',
    tenantKey: 'tenant-a',
    logType: 'audit' as const,
    eventAt,
    type: 'permission.revoked',
    source: 'ar-management',
    delivery: { targetType: 'r2' },
  };

  it('fills every default of a minimal record', () => {
    expect(buildArchiveLogRecordV1(base)).toStrictEqual({
      schema_version: 'authrim.log.archive.v1',
      record_type: 'log_record',
      id: 'log-1',
      tenant_key: 'tenant-a',
      log_type: 'audit',
      plane: 'archive',
      time: '2026-01-01T00:00:00.000Z',
      severity: 'info',
      type: 'permission.revoked',
      source: 'ar-management',
      subject: null,
      correlation: { request_id: null, correlation_id: null },
      actor: null,
      resource: null,
      result: null,
      summary: {},
      detail_ref: null,
      delivery: { target_type: 'r2', destination_id: null, target_ref: null },
      authrim: { tenant_key: 'tenant-a', log_type: 'audit', plane: 'archive' },
    });
  });

  it('carries every given field into the record and its authrim block', () => {
    const detailRef = { object_catalog_id: 'obj-1', artifact_id: null, class: 'pii' };
    expect(
      buildArchiveLogRecordV1({
        ...base,
        plane: 'external_sink',
        surface: 'admin',
        severity: 'critical',
        subject: 'user-1',
        correlationId: 'corr-1',
        requestId: 'req-1',
        actor: { id: 'a' },
        resource: { id: 'r' },
        result: 'denied',
        summary: { k: 'v' },
        detailRef,
        delivery: { targetType: 'http', destinationId: 'dest-1', targetRef: 'ref-1' },
      })
    ).toStrictEqual({
      schema_version: 'authrim.log.archive.v1',
      record_type: 'log_record',
      id: 'log-1',
      tenant_key: 'tenant-a',
      log_type: 'audit',
      plane: 'external_sink',
      surface: 'admin',
      time: '2026-01-01T00:00:00.000Z',
      severity: 'critical',
      type: 'permission.revoked',
      source: 'ar-management',
      subject: 'user-1',
      correlation: { request_id: 'req-1', correlation_id: 'corr-1' },
      actor: { id: 'a' },
      resource: { id: 'r' },
      result: 'denied',
      summary: { k: 'v' },
      detail_ref: detailRef,
      delivery: { target_type: 'http', destination_id: 'dest-1', target_ref: 'ref-1' },
      authrim: {
        tenant_key: 'tenant-a',
        log_type: 'audit',
        plane: 'external_sink',
        surface: 'admin',
      },
    });
  });

  it('omits an empty surface', () => {
    const record = buildArchiveLogRecordV1({ ...base, surface: '' });
    expect(record).not.toHaveProperty('surface');
    expect(record.authrim).not.toHaveProperty('surface');
  });

  describe('isArchiveLogRecordV1', () => {
    const valid = (): ArchiveLogRecordV1 => buildArchiveLogRecordV1(base);

    it('accepts both archive planes and every severity', () => {
      expect(isArchiveLogRecordV1(valid())).toBe(true);
      expect(isArchiveLogRecordV1({ ...valid(), plane: 'external_sink' })).toBe(true);
      for (const severity of ['debug', 'info', 'warn', 'error', 'critical']) {
        expect(isArchiveLogRecordV1({ ...valid(), severity })).toBe(true);
      }
    });

    it('refuses what is not an object', () => {
      for (const value of [null, undefined, 'x', 5, [], [valid()]]) {
        expect(isArchiveLogRecordV1(value)).toBe(false);
      }
    });

    it('refuses a record with a wrong or missing field', () => {
      const wrong: Array<Record<string, unknown>> = [
        { schema_version: 'authrim.log.archive.v2' },
        { record_type: 'other' },
        { id: 1 },
        { id: undefined },
        { tenant_key: 1 },
        { tenant_key: undefined },
        { log_type: 1 },
        { log_type: undefined },
        { plane: 'primary' },
        { plane: undefined },
        { time: 1 },
        { time: undefined },
        { time: 'not-a-date' },
        { severity: undefined },
        { severity: 'fatal' },
        { severity: '' },
        { type: 1 },
        { type: undefined },
        { source: 1 },
        { source: undefined },
        { summary: undefined },
        { summary: null },
        { summary: 'text' },
        { summary: [] },
      ];
      for (const replacement of wrong) {
        expect(isArchiveLogRecordV1({ ...valid(), ...replacement })).toBe(false);
      }
    });
  });

  describe('projectArchiveLogRecordForExportV1', () => {
    it('projects a full record with its evidence', () => {
      const record = buildArchiveLogRecordV1({
        ...base,
        surface: 'admin',
        subject: 'user-1',
        requestId: 'req-1',
        actor: { id: 'a' },
        resource: { id: 'r' },
        result: 'ok',
        summary: { k: 'v' },
        detailRef: { object_catalog_id: 'obj-1', class: 'pii' },
      });
      const evidence = { chunk_id: 'chk-1', line_number: 3 };
      expect(projectArchiveLogRecordForExportV1(record, evidence)).toStrictEqual({
        schema_version: 'authrim.log.export.projection.v1',
        projection_type: 'compliance_export_record',
        source_schema_version: 'authrim.log.archive.v1',
        record_id: 'log-1',
        tenant_key: 'tenant-a',
        log_type: 'audit',
        plane: 'archive',
        surface: 'admin',
        time: '2026-01-01T00:00:00.000Z',
        severity: 'info',
        type: 'permission.revoked',
        source: 'ar-management',
        subject: 'user-1',
        correlation: { request_id: 'req-1', correlation_id: null },
        actor: { id: 'a' },
        resource: { id: 'r' },
        result: 'ok',
        summary: { k: 'v' },
        detail_ref: { object_catalog_id: 'obj-1', class: 'pii' },
        evidence,
      });
    });

    it('defaults the evidence, omits an absent surface and nulls absent optionals', () => {
      const record = buildArchiveLogRecordV1(base);
      const bare: Partial<ArchiveLogRecordV1> = { ...record };
      delete bare.subject;
      delete bare.actor;
      delete bare.resource;
      delete bare.result;
      delete bare.detail_ref;
      const projection = projectArchiveLogRecordForExportV1(bare as ArchiveLogRecordV1);
      expect(projection).not.toHaveProperty('surface');
      expect(projection).toMatchObject({
        subject: null,
        actor: null,
        resource: null,
        result: null,
        detail_ref: null,
        evidence: {},
      });
    });
  });
});
