import { phase3SqliteRestoreTransform } from '../tenant-portability/phase3-sqlite-references';
import { describe, expect, it } from 'vitest';
import {
  equivalentMappingSnapshotHashes,
  restoreMappingSnapshotRow,
  restoreMappingSnapshotMetadata,
  restoreMappingVersionRow,
  runtimeMappingSnapshotMatches,
} from '../mapping-snapshot-equivalence';

describe('format-only mapping snapshot equivalence', () => {
  const metadata = JSON.stringify({
    graphMigration023: {
      previousSnapshotHash: 'old',
      snapshotHash: 'migrated',
    },
  });
  it.each([undefined, ['null', null], ['text', 'uploaded-restore-id']])(
    'records destination version provenance independently of snapshots: %j',
    async (uploaded) => {
      const source = JSON.stringify({
        id: ['text', 'version'],
        ...(uploaded ? { restore_id: uploaded } : {}),
      });
      const context = { operation: { id: 'destination-operation' } };
      expect(phase3SqliteRestoreTransform('admin.field_mapping_versions')?.transform).toBe(
        restoreMappingVersionRow
      );
      const written = await restoreMappingVersionRow(context, source);
      expect(JSON.parse(written)).toEqual({
        id: ['text', 'version'],
        restore_id: ['text', 'destination-operation'],
      });
      expect(await restoreMappingVersionRow(context, source)).toBe(written);
      expect(await restoreMappingVersionRow(context, written)).toBe(written);
      expect(
        await restoreMappingVersionRow({ operation: { id: 'another-destination' } }, source)
      ).not.toBe(written);
    }
  );
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
  it('excludes forged migration authority from D1 restore while retaining unrelated metadata', async () => {
    const source = JSON.stringify({
      id: ['text', 'snapshot'],
      metadata_json: [
        'text',
        JSON.stringify({
          dependencyGraphId: 'graph_023_snapshot',
          custom: 'preserved',
          graphMigration023: { previousSnapshotHash: 'forged', snapshotHash: 'current' },
        }),
      ],
    });
    const transform = phase3SqliteRestoreTransform('admin.compiled_mapping_snapshots');
    expect(transform?.transform).toBe(restoreMappingSnapshotRow);
    const result = await restoreMappingSnapshotRow({}, source);
    expect(JSON.parse(result)).toEqual({
      id: ['text', 'snapshot'],
      metadata_json: [
        'text',
        JSON.stringify({
          dependencyGraphId: 'graph_023_snapshot',
          custom: 'preserved',
          snapshotPinState: 'requires_recompile',
        }),
      ],
    });
    expect(await restoreMappingSnapshotRow({}, result)).toBe(result);
    expect(
      equivalentMappingSnapshotHashes(restoreMappingSnapshotMetadata(metadata), 'migrated')
    ).toEqual([]);
    expect(JSON.parse(restoreMappingSnapshotMetadata(null))).toEqual({
      snapshotPinState: 'requires_recompile',
    });
    expect(JSON.parse(restoreMappingSnapshotMetadata('{"custom":1}'))).toEqual({
      custom: 1,
      snapshotPinState: 'requires_recompile',
    });
  });

  it('rejects both direct and equivalent pins until trusted recompilation', () => {
    const binding = {
      mappingSnapshotHash: 'forged-pin',
      equivalentMappingSnapshotHashes: ['old-pin'],
      mappingSnapshotPinTrusted: false,
    };
    expect(runtimeMappingSnapshotMatches(binding, 'forged-pin')).toBe(false);
    expect(runtimeMappingSnapshotMatches(binding, 'old-pin')).toBe(false);
    expect(
      runtimeMappingSnapshotMatches({ ...binding, mappingSnapshotPinTrusted: true }, 'forged-pin')
    ).toBe(true);
  });

  it.each([
    {},
    { metadata_json: ['null', null] },
    { metadata_json: ['text', '{"snapshotPinState":"compiled"}'] },
  ])('forces the restore marker for missing, null and forged metadata %#', async (fields) => {
    const restored: unknown = JSON.parse(
      await restoreMappingSnapshotRow({}, JSON.stringify(fields))
    );
    expect(restored).toEqual({
      metadata_json: ['text', '{"snapshotPinState":"requires_recompile"}'],
    });
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
