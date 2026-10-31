import { describe, expect, it } from 'vitest';
import {
  decodePortableLogChunkRecords,
  encodePortableLogChunkRecords,
} from '../portable-log-chunk';

describe('portable log chunk records', () => {
  it('round-trips record identity, indexes and payload without physical offsets', () => {
    const bytes = encodePortableLogChunkRecords({
      version: 1,
      compression: 'gzip_block',
      records: [
        {
          recordId: 'record-a',
          eventAt: 10,
          surface: 'admin',
          indexProfile: 'audit',
          indexedFields: '{"action":"read"}',
          createdAt: 11,
          payload: { result: 'allowed' },
        },
      ],
    });

    expect(decodePortableLogChunkRecords(bytes)).toEqual({
      version: 1,
      compression: 'gzip_block',
      records: [
        {
          recordId: 'record-a',
          eventAt: 10,
          surface: 'admin',
          indexProfile: 'audit',
          indexedFields: '{"action":"read"}',
          createdAt: 11,
          payload: { result: 'allowed' },
        },
      ],
    });
  });

  it('rejects duplicate identities and malformed indexed JSON', () => {
    const record = {
      recordId: 'record-a',
      eventAt: 10,
      surface: null,
      indexProfile: 'audit',
      indexedFields: null,
      createdAt: 11,
      payload: {},
    };
    expect(() =>
      encodePortableLogChunkRecords({
        version: 1,
        compression: 'none',
        records: [record, record],
      })
    ).toThrow('backup_portable_log_chunk_invalid');
    expect(() =>
      encodePortableLogChunkRecords({
        version: 1,
        compression: 'none',
        records: [{ ...record, indexedFields: '{' }],
      })
    ).toThrow('backup_portable_log_chunk_invalid');
  });
});
