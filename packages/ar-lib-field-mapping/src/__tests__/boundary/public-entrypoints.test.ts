import { describe, expect, it } from 'vitest';
import * as authoringPublic from '@authrim/ar-lib-field-mapping/authoring';
import * as contractPublic from '@authrim/ar-lib-field-mapping/contract';
import * as runtimePublic from '@authrim/ar-lib-field-mapping/runtime';
import type { MappingInput, SourceValueEnvelope } from '@authrim/ar-lib-field-mapping/contract';
import {
  dryRunMapping,
  parseCsvSourceProfile,
  resolveEffectiveFieldMappingSet,
  validateCatalogBundle,
} from '@authrim/ar-lib-field-mapping/authoring';
import { executeRuntimeMapping, findCatalogEntry } from '@authrim/ar-lib-field-mapping/runtime';
import { validateCatalogBundle as validateCatalogBundleImplementation } from '../../core/catalog';
import { dryRunMapping as dryRunMappingImplementation } from '../../core/dry-run';
import { resolveEffectiveFieldMappingSet as resolveEffectiveFieldMappingSetImplementation } from '../../core/field-mapping-set';
import { executeRuntimeMapping as executeRuntimeMappingImplementation } from '../../core/runtime';
import { parseCsvSourceProfile as parseCsvSourceProfileImplementation } from '../../source-profiles/csv';
import { mappingInput, sourceValue, TEST_CATALOG } from '../../test-support';

describe('public field-mapping entrypoints', () => {
  it('keeps the contract runtime-empty and the hot-path surface narrow', () => {
    expect(Object.keys(contractPublic)).toEqual([]);
    expect(Object.keys(runtimePublic).sort()).toEqual([
      'executeRuntimeMapping',
      'findCatalogEntry',
    ]);
    expect(authoringPublic).not.toHaveProperty('executeRuntimeMapping');
    expect(authoringPublic).not.toHaveProperty('findCatalogEntry');
  });

  it('matches the existing implementations without changing their behavior', () => {
    const input = mappingInput([sourceValue('csv', 'email', 'user@example.test', 'pii')]);
    const csv = 'email,name\nuser@example.test,Example User';
    const effectiveSetInput = { sets: [] };

    expect(executeRuntimeMapping(input)).toEqual(executeRuntimeMappingImplementation(input));
    expect(validateCatalogBundle(TEST_CATALOG)).toEqual(
      validateCatalogBundleImplementation(TEST_CATALOG)
    );
    expect(dryRunMapping(input)).toEqual(dryRunMappingImplementation(input));
    expect(resolveEffectiveFieldMappingSet(effectiveSetInput)).toEqual(
      resolveEffectiveFieldMappingSetImplementation(effectiveSetInput)
    );
    expect(parseCsvSourceProfile(csv)).toEqual(parseCsvSourceProfileImplementation(csv));
  });

  it('preserves successful runtime status, reasons, trace, and mapped values', () => {
    const input: MappingInput = mappingInput([
      sourceValue('csv', 'email', 'user@example.test', 'pii'),
    ]);
    const result = executeRuntimeMapping(input);

    expect(result.status).toBe('success');
    expect(result.reasons).toEqual([]);
    expect(
      result.ruleTrace.map((entry) => ({
        action: entry.action,
        reason: entry.reason.code,
      }))
    ).toEqual([{ action: 'mapped', reason: 'trace.mapping_evaluated' }]);
    expect(result.values).toEqual([
      expect.objectContaining({
        value: 'user@example.test',
        sourceRef: expect.objectContaining({
          side: 'canonical',
          namespace: 'authrim.profile',
          path: 'email',
          catalogEntryId: 'field.canonical.email',
        }),
      }),
    ]);
    expect(findCatalogEntry(TEST_CATALOG, result.values[0]!.sourceRef)?.id).toBe(
      'field.canonical.email'
    );
  });

  it('preserves fail-closed status and evidence for a required missing value', () => {
    const source: SourceValueEnvelope = sourceValue('csv', 'email', '', 'pii');
    const result = executeRuntimeMapping({
      ...mappingInput([source]),
      validationRules: [
        {
          id: 'validation.email.required',
          kind: 'required',
          targetRef: source.sourceRef,
        },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.reasons.map((reason) => reason.code)).toEqual(['validation.required_missing']);
    expect(
      result.ruleTrace.map((entry) => ({
        action: entry.action,
        reason: entry.reason.code,
      }))
    ).toEqual([
      { action: undefined, reason: 'validation.required_missing' },
      { action: 'mapped', reason: 'trace.mapping_evaluated' },
    ]);
    expect(result.values).toEqual([
      expect.objectContaining({
        value: '',
        sourceRef: expect.objectContaining({
          side: 'canonical',
          namespace: 'authrim.profile',
          path: 'email',
          catalogEntryId: 'field.canonical.email',
        }),
      }),
    ]);
  });
});
