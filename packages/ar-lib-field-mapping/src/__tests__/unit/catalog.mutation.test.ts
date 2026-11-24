import { describe, expect, it } from 'vitest';
import { findCatalogEntry, validateCatalogBundle } from '../../core/catalog';
import { reason } from '../../core/reason-registry';
import type {
  CatalogBundleIdentity,
  FieldCatalogBundle,
  FieldCatalogEntry,
  RedactionClassification,
  TargetType,
} from '../../core/types';

const identity: CatalogBundleIdentity = {
  id: 'bundle',
  version: '1',
  contentHash: 'hash',
  compatibilityRange: '^1.0.0',
};

function entry(overrides: Partial<FieldCatalogEntry> = {}): FieldCatalogEntry {
  return {
    id: 'field.a',
    namespace: 'ns',
    path: 'a',
    valueType: 'string',
    cardinality: 'single',
    classification: 'internal',
    ...overrides,
  };
}

function bundle(
  entries: FieldCatalogEntry[],
  overrides: Partial<CatalogBundleIdentity> = {}
): FieldCatalogBundle {
  return { identity: { ...identity, ...overrides }, entries };
}

function codes(candidate: FieldCatalogBundle): string[] {
  return validateCatalogBundle(candidate).reasons.map((item) => item.code);
}

describe('catalog bundle identity validation', () => {
  it('accepts a complete identity with no entries', () => {
    const result = validateCatalogBundle(bundle([]));
    expect(result).toEqual({ status: 'success', reasons: [], trace: [] });
  });

  it.each(['id', 'version', 'contentHash', 'compatibilityRange'] as const)(
    'reports exactly one invalid bundle when %s is blank',
    (key) => {
      const result = validateCatalogBundle(bundle([], { [key]: '' }));
      expect(result.reasons).toEqual([reason('catalog.invalid_bundle')]);
      expect(result.status).toBe('partial');
      expect(result.trace).toHaveLength(1);
      expect(result.trace[0]?.reason).toEqual(reason('catalog.invalid_bundle'));
    }
  );

  it('reports a single invalid bundle even when several identity fields are blank', () => {
    expect(
      codes(bundle([], { id: '', version: '', contentHash: '', compatibilityRange: '' }))
    ).toEqual(['catalog.invalid_bundle']);
  });
});

describe('catalog entry validation', () => {
  it.each([
    ['id', { id: '' }],
    ['namespace', { namespace: '' }],
    ['path', { path: '' }],
    ['valueType', { valueType: '' }],
    ['cardinality', { cardinality: 'many' as unknown as 'single' }],
    ['classification', { classification: 'sensitive' as unknown as RedactionClassification }],
    ['targetType', { targetType: 'other' as unknown as TargetType }],
  ])('flags one invalid entry when %s is invalid', (_name, overrides) => {
    const result = validateCatalogBundle(bundle([entry(overrides)]));
    expect(result.reasons).toEqual([reason('catalog.invalid_entry')]);
    expect(result.trace).toHaveLength(1);
  });

  it.each(['single', 'multi'] as const)('accepts %s cardinality', (cardinality) => {
    expect(codes(bundle([entry({ cardinality })]))).toEqual([]);
  });

  it.each([
    'public',
    'internal',
    'pii',
    'secret',
    'regulated',
    'credential',
    'token',
    'key_material',
  ] as const)('accepts the %s classification', (classification) => {
    expect(codes(bundle([entry({ classification })]))).toEqual([]);
  });

  it.each(['canonical', 'custom', 'derived', 'destination-only', 'review-only'] as const)(
    'accepts the %s target type',
    (targetType) => {
      expect(codes(bundle([entry({ targetType })]))).toEqual([]);
    }
  );

  it('flags every invalid entry separately', () => {
    expect(
      codes(bundle([entry({ id: 'x', path: '' }), entry({ id: 'y', path: 'y', valueType: '' })]))
    ).toEqual(['catalog.invalid_entry', 'catalog.invalid_entry']);
  });

  it('reports duplicate ids and the aliases they imply in encounter order', () => {
    expect(codes(bundle([entry(), entry()]))).toEqual([
      'catalog.duplicate_id',
      'catalog.duplicate_alias',
    ]);
  });

  it('reports duplicate ids once per repeated entry', () => {
    expect(codes(bundle([entry(), entry({ path: 'b' }), entry({ path: 'c' })]))).toEqual([
      'catalog.duplicate_id',
      'catalog.duplicate_id',
    ]);
  });

  it('reports aliases that collide with a primary path or another alias', () => {
    const first = entry({ id: 'one', path: 'one', aliases: [{ namespace: 'old', path: 'name' }] });
    const collidesWithPrimary = entry({
      id: 'two',
      path: 'two',
      aliases: [{ namespace: 'ns', path: 'one' }],
    });
    const collidesWithAlias = entry({
      id: 'three',
      path: 'three',
      aliases: [{ namespace: 'old', path: 'name' }],
    });
    expect(codes(bundle([first, collidesWithPrimary]))).toEqual(['catalog.duplicate_alias']);
    expect(codes(bundle([first, collidesWithAlias]))).toEqual(['catalog.duplicate_alias']);
    expect(
      codes(
        bundle([
          first,
          entry({ id: 'four', path: 'four', aliases: [{ namespace: 'other', path: 'name' }] }),
        ])
      )
    ).toEqual([]);
  });

  it('reports an entry whose own alias repeats its primary alias', () => {
    expect(codes(bundle([entry({ aliases: [{ namespace: 'ns', path: 'a' }] })]))).toEqual([
      'catalog.duplicate_alias',
    ]);
  });

  it('builds one trace entry per reason, in order', () => {
    const result = validateCatalogBundle(bundle([entry(), entry()], { id: '' }));
    expect(result.reasons.map((item) => item.code)).toEqual([
      'catalog.invalid_bundle',
      'catalog.duplicate_id',
      'catalog.duplicate_alias',
    ]);
    expect(result.trace.map((item) => item.reason.code)).toEqual(
      result.reasons.map((item) => item.code)
    );
    expect(new Set(result.trace.map((item) => item.id)).size).toBe(3);
  });
});

describe('findCatalogEntry', () => {
  const primary = entry({ id: 'field.primary', namespace: 'ns', path: 'primary' });
  const aliased = entry({
    id: 'field.aliased',
    namespace: 'ns',
    path: 'aliased',
    aliases: [{ namespace: 'legacy', path: 'old' }],
  });
  const catalog = bundle([primary, aliased]);

  it('finds an entry by catalog id even when namespace and path disagree', () => {
    expect(
      findCatalogEntry(catalog, { catalogEntryId: 'field.aliased', namespace: 'x', path: 'y' })
    ).toBe(aliased);
  });

  it('does not fall back to namespace and path when the catalog id is unknown', () => {
    expect(
      findCatalogEntry(catalog, { catalogEntryId: 'missing', namespace: 'ns', path: 'primary' })
    ).toBeUndefined();
  });

  it('finds an entry by primary namespace and path', () => {
    expect(findCatalogEntry(catalog, { namespace: 'ns', path: 'primary' })).toBe(primary);
    expect(findCatalogEntry(catalog, { namespace: 'ns', path: 'aliased' })).toBe(aliased);
  });

  it('finds an entry through an alias', () => {
    expect(findCatalogEntry(catalog, { namespace: 'legacy', path: 'old' })).toBe(aliased);
  });

  it('does not mix up namespace and path', () => {
    expect(findCatalogEntry(catalog, { namespace: 'primary', path: 'ns' })).toBeUndefined();
    expect(findCatalogEntry(catalog, { namespace: 'legacy', path: 'new' })).toBeUndefined();
    expect(findCatalogEntry(catalog, { namespace: 'ns', path: 'old' })).toBeUndefined();
  });

  it('treats an empty catalog id as absent', () => {
    expect(
      findCatalogEntry(catalog, { catalogEntryId: '', namespace: 'ns', path: 'primary' })
    ).toBe(primary);
  });
});
