import { describe, expect, it } from 'vitest';
import { validateCatalogBundle } from '../../core/catalog';
import { TEST_CATALOG } from '../../test-support';

describe('catalog validation', () => {
  it('accepts the PR1 test catalog', () => {
    expect(validateCatalogBundle(TEST_CATALOG).status).toBe('success');
  });

  it('rejects duplicate ids and aliases', () => {
    const duplicate = {
      ...TEST_CATALOG,
      entries: [TEST_CATALOG.entries[0], { ...TEST_CATALOG.entries[0] }],
    };

    expect(validateCatalogBundle(duplicate).reasons.map((item) => item.code)).toContain(
      'catalog.duplicate_id'
    );
    expect(validateCatalogBundle(duplicate).reasons.map((item) => item.code)).toContain(
      'catalog.duplicate_alias'
    );
  });
});
