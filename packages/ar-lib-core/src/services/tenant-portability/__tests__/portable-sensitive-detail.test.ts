import { describe, expect, it } from 'vitest';
import {
  decodePortableSensitiveDetailRecord,
  encodePortableSensitiveDetailRecord,
} from '../portable-sensitive-detail';

describe('portable sensitive detail record', () => {
  it('round-trips plaintext and content type without source encryption metadata', () => {
    const encoded = encodePortableSensitiveDetailRecord({
      version: 1,
      contentType: 'application/json',
      plaintext: '{"secret":true}',
    });
    expect(decodePortableSensitiveDetailRecord(encoded)).toEqual({
      version: 1,
      contentType: 'application/json',
      plaintext: '{"secret":true}',
    });
  });

  it('rejects unknown fields', () => {
    expect(() =>
      decodePortableSensitiveDetailRecord(
        new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            contentType: 'application/json',
            plaintext: '{}',
            sourceKey: 'must-not-travel',
          })
        )
      )
    ).toThrow('backup_portable_sensitive_detail_invalid');
  });
});
