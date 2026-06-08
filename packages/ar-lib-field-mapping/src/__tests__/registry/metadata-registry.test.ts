import { describe, expect, it } from 'vitest';
import { filterSafeMetadata, findUnsafeMetadata, SAFE_METADATA_KEYS } from '../../core/metadata';

describe('safe metadata registry', () => {
  it('filters unsafe metadata keys and object payloads', () => {
    const metadata = filterSafeMetadata({
      rowIndex: 1,
      csvHeaderName: 'email',
      rawValue: 'secret@example.test',
      protocolObject: { value: 'secret@example.test' },
    });

    expect(metadata).toEqual({ rowIndex: 1, csvHeaderName: 'email' });
    expect(findUnsafeMetadata({ rawValue: 'x', rowIndex: 1 })).toEqual(['rawValue']);
  });

  it('has unique allowlisted keys', () => {
    expect(new Set(SAFE_METADATA_KEYS).size).toBe(SAFE_METADATA_KEYS.length);
  });
});
