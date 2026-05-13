import { describe, expect, it } from 'vitest';
import { buildSAMLAssertionTiming } from '../assertion-timing';

describe('buildSAMLAssertionTiming', () => {
  it('uses one base time with clock-skewed NotBefore and validity-based NotOnOrAfter', () => {
    expect(
      buildSAMLAssertionTiming({
        now: new Date('2024-01-15T10:30:00Z'),
        assertionValiditySeconds: 300,
        notBeforeSkewSeconds: 60,
      })
    ).toEqual({
      issueInstant: '2024-01-15T10:30:00Z',
      authnInstant: '2024-01-15T10:30:00Z',
      notBefore: '2024-01-15T10:29:00Z',
      notOnOrAfter: '2024-01-15T10:35:00Z',
    });
  });

  it('rejects invalid assertion validity', () => {
    expect(() => buildSAMLAssertionTiming({ assertionValiditySeconds: 0 })).toThrow(
      'SAML assertion validity must be a positive number of seconds'
    );
  });
});
