import { describe, expect, it } from 'vitest';
import {
  assertSemanticBaselineAllowed,
  mergeSemanticBaselineProvenance,
} from '../../../../scripts/semantic-baseline-migrations.js';
import type { ReleaseMigrationManifest } from '../core/release-migrations.js';

function publishedManifest(productVersion: string): ReleaseMigrationManifest {
  return {
    formatVersion: 1,
    productVersion,
    streams: [],
  };
}

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

describe('semantic baseline release immutability', () => {
  it('rejects rewriting an already published pre-1.0 product version', () => {
    expect(() =>
      assertSemanticBaselineAllowed({
        version: '0.4.0',
        manifests: [{ manifest: publishedManifest('0.4.0') }],
        write: true,
      })
    ).toThrow('Product version 0.4.0 is already published');
  });

  it('allows verification and a later pre-1.0 version rewrite', () => {
    expect(() =>
      assertSemanticBaselineAllowed({
        version: '0.4.0',
        manifests: [{ manifest: publishedManifest('0.4.0') }],
        write: false,
      })
    ).not.toThrow();
    expect(() =>
      assertSemanticBaselineAllowed({
        version: '0.5.0',
        manifests: [{ manifest: publishedManifest('0.4.0') }],
        write: true,
      })
    ).not.toThrow();
  });
});
