import { describe, expect, it } from 'vitest';
import { sameFieldRef, validateMappingInput } from '../../authoring';
import type { FieldRef } from '../../core/types';
import { TEST_CATALOG } from '../../test-support';

const ref = (side: FieldRef['side'], path: string, catalogEntryId?: string): FieldRef => ({
  side,
  namespace: 'saml.attribute',
  path,
  catalogEntryId,
});

describe('sameFieldRef', () => {
  it('compares by catalog entry id when both name one, else by side, namespace and path', () => {
    expect(sameFieldRef(ref('source', 'a', 'x'), ref('destination', 'b', 'x'))).toBe(true);
    expect(sameFieldRef(ref('source', 'a', 'x'), ref('source', 'a', 'y'))).toBe(false);
    expect(sameFieldRef(ref('source', 'a'), ref('source', 'a'))).toBe(true);
    expect(sameFieldRef(ref('source', 'a'), ref('destination', 'a'))).toBe(false);
    expect(sameFieldRef(ref('source', 'a', 'x'), ref('source', 'a'))).toBe(true);
    expect(sameFieldRef(ref('source', 'a', 'x'), ref('source', 'b'))).toBe(false);
  });

  it('is the comparison a required rule finds its value by (what the exported function stands for)', () => {
    const refs = [
      ref('source', 'a'),
      ref('destination', 'a'),
      ref('source', 'a', 'x'),
      ref('destination', 'a', 'x'),
      ref('source', 'b', 'x'),
      ref('source', 'b'),
    ];
    for (const rule of refs) {
      for (const value of refs) {
        const result = validateMappingInput({
          catalog: TEST_CATALOG,
          sourceValues: [{ value: 'present', sourceRef: value }],
          edges: [],
          validationRules: [
            { id: 'r', kind: 'required', targetRef: rule, defaultSeverity: 'critical' },
          ],
        });
        const missing = result.reasons.some((item) => item.code === 'validation.required_missing');
        expect(missing).toBe(!sameFieldRef(value, rule));
      }
    }
  });
});
