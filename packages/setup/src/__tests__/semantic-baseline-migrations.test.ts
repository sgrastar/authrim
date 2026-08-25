import { describe, expect, it } from 'vitest';
import { mergeSemanticBaselineProvenance } from '../../../../scripts/semantic-baseline-migrations.js';

describe('semantic baseline migration provenance', () => {
  it('expands prior baseline provenance before appending new migration sources', () => {
    expect(
      mergeSemanticBaselineProvenance({
        baselinePath: '001_pre_1_0_core_baseline.sql',
        sourceFiles: [
          { path: '001_pre_1_0_core_baseline.sql', checksum: 'current-baseline' },
          { path: '002_application_launchers.sql', checksum: 'application-launchers' },
        ],
        priorGeneratedFrom: [
          { path: '001_initial.sql', checksum: 'initial' },
          { path: '052_consent_records.sql', checksum: 'consent-records' },
        ],
      })
    ).toEqual([
      { path: '001_initial.sql', checksum: 'initial' },
      { path: '052_consent_records.sql', checksum: 'consent-records' },
      { path: '002_application_launchers.sql', checksum: 'application-launchers' },
    ]);
  });

  it('rejects conflicting checksums for the same historical source path', () => {
    expect(() =>
      mergeSemanticBaselineProvenance({
        baselinePath: '001_pre_1_0_core_baseline.sql',
        sourceFiles: [
          { path: '001_pre_1_0_core_baseline.sql', checksum: 'current-baseline' },
          { path: '002_application_launchers.sql', checksum: 'new-checksum' },
        ],
        priorGeneratedFrom: [{ path: '002_application_launchers.sql', checksum: 'old-checksum' }],
      })
    ).toThrow('Conflicting semantic baseline provenance checksum');
  });
});
