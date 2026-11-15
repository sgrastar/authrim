import { describe, expect, it } from 'vitest';
import {
  equivalentMappingSnapshotHashes,
  runtimeMappingSnapshotMatches,
} from '../mapping-snapshot-equivalence';

describe('format-only mapping snapshot equivalence', () => {
  const metadata = JSON.stringify({
    graphMigration023: {
      previousSnapshotHash: 'old',
      snapshotHash: 'migrated',
    },
  });
  it('accepts the previous hash only for the exact migrated snapshot', () => {
    const binding = {
      mappingSnapshotHash: 'migrated',
      equivalentMappingSnapshotHashes: equivalentMappingSnapshotHashes(metadata, 'migrated'),
    };
    expect(runtimeMappingSnapshotMatches(binding, 'old')).toBe(true);
    expect(runtimeMappingSnapshotMatches(binding, 'migrated')).toBe(true);
    expect(runtimeMappingSnapshotMatches(binding, 'unrelated')).toBe(false);
    const recompiled = {
      mappingSnapshotHash: 'changed',
      equivalentMappingSnapshotHashes: equivalentMappingSnapshotHashes(metadata, 'changed'),
    };
    expect(runtimeMappingSnapshotMatches(recompiled, 'old')).toBe(false);
  });
  it.each([
    undefined,
    null,
    '{}',
    'broken',
    '{"graphMigration023":{"previousSnapshotHash":42,"snapshotHash":"migrated"}}',
  ])('refuses missing or malformed equivalence metadata %s', (value) => {
    expect(equivalentMappingSnapshotHashes(value, 'migrated')).toEqual([]);
  });
});
