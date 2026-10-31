import { describe, expect, it } from 'vitest';
import type { AAL } from '@authrim/ar-lib-core';
import { SAMLAuthnContextPolicyError } from '../authn-context';
import {
  chooseSAMLAuthnContextClassRef,
  resolveSAMLAssuranceAuthnContext,
  selectSAMLAssuranceClassRef,
  type SAMLAuthnContextComparison,
} from '../authn-context-assurance';

const AAL1 = 'https://example.org/profile/AAL1';
const AAL2 = 'https://example.org/profile/AAL2';
const AAL2_ALT = 'https://example.org/profile/AAL2-alt';
const AAL3 = 'https://example.org/profile/AAL3';
const PPT = 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport';

const TABLE: Record<string, AAL> = {
  [AAL1]: 'AAL1',
  [AAL2]: 'AAL2',
  [AAL2_ALT]: 'AAL2',
  [AAL3]: 'AAL3',
};

function resolve(
  refs: string[],
  comparison?: SAMLAuthnContextComparison,
  table: Record<string, AAL> = TABLE
) {
  return resolveSAMLAssuranceAuthnContext({
    requested: { authnContextClassRef: refs, comparison },
    classRefAal: table,
  });
}

describe('resolveSAMLAssuranceAuthnContext', () => {
  it('leaves a request that has no AuthnContext alone', () => {
    expect(
      resolveSAMLAssuranceAuthnContext({
        requested: undefined,
        classRefAal: TABLE,
      })
    ).toEqual({ kind: 'unmapped' });
  });

  it('leaves a request naming only references the table does not list to the existing handling', () => {
    expect(resolve(['urn:example:unlisted'])).toEqual({ kind: 'unmapped' });
    expect(resolve([PPT])).toEqual({ kind: 'unmapped' });
  });

  it('holds a request to the AAL of a listed reference even when it names an unlisted one too', () => {
    // Listing a reference the table does not know beside AAL2's must not let the request round
    // the table.
    expect(resolve([AAL2, PPT])).toMatchObject({ kind: 'mapped', requiredAal: 'AAL2' });
  });

  it('ignores an unlisted reference next to a listed one', () => {
    expect(resolve([AAL2, 'urn:example:unlisted'])).toMatchObject({
      kind: 'mapped',
      requiredAal: 'AAL2',
      refs: [{ ref: AAL2, aal: 'AAL2' }],
    });
  });

  it('does not read a name that only exists on Object.prototype as listed', () => {
    expect(resolve(['toString', '__proto__'])).toEqual({ kind: 'unmapped' });
  });

  it.each<[SAMLAuthnContextComparison | undefined, string[], AAL | null, boolean]>([
    [undefined, [AAL2], 'AAL2', false],
    ['exact', [AAL2], 'AAL2', false],
    // Any of them satisfies: the lowest is the floor.
    ['exact', [AAL3, AAL2], 'AAL2', false],
    ['minimum', [AAL2], 'AAL2', false],
    ['minimum', [AAL2, AAL3], 'AAL2', false],
    // Stronger than any one of them: one level above the weakest (SAML Core errata).
    ['better', [AAL1], 'AAL2', false],
    ['better', [AAL1, AAL2], 'AAL2', false],
    ['better', [AAL1, AAL3], 'AAL2', false],
    ['better', [AAL2, AAL3], 'AAL3', false],
    ['better', [AAL3], null, true],
    // No lower bound, whatever is listed.
    ['maximum', [AAL3], null, false],
  ])(
    'reads Comparison %s of %j as requiring %s (unsatisfiable: %s)',
    (cmp, refs, required, bad) => {
      expect(resolve(refs, cmp)).toMatchObject({
        kind: 'mapped',
        requiredAal: required,
        unsatisfiable: bad,
      });
    }
  );

  it('reads an unknown Comparison as exact', () => {
    expect(
      resolveSAMLAssuranceAuthnContext({
        requested: { authnContextClassRef: [AAL3], comparison: undefined },
        classRefAal: TABLE,
      })
    ).toMatchObject({ requiredAal: 'AAL3' });
  });
});

describe('selectSAMLAssuranceClassRef', () => {
  const none = { kind: 'unmapped' } as const;

  it.each<[string, AAL | 'AAL0', string | null]>([
    ['AAL0', 'AAL0', null],
    ['AAL1', 'AAL1', AAL1],
    ['AAL2', 'AAL2', AAL2],
    ['AAL3', 'AAL3', AAL3],
  ])('with no request, gives the reference of the AAL reached (%s)', (_name, actual, expected) => {
    expect(selectSAMLAssuranceClassRef({ actual, classRefAal: TABLE, request: none })).toBe(
      expected
    );
  });

  it('gives the strongest reference the sign-in meets when no reference stands for its exact AAL', () => {
    expect(
      selectSAMLAssuranceClassRef({
        actual: 'AAL3',
        classRefAal: { [AAL1]: 'AAL1', [AAL2]: 'AAL2' },
        request: none,
      })
    ).toBe(AAL2);
  });

  it('prefers, among references of the same strength, the one requested first, then the table order', () => {
    expect(selectSAMLAssuranceClassRef({ actual: 'AAL2', classRefAal: TABLE, request: none })).toBe(
      AAL2
    );
    const request = resolve([AAL2_ALT, AAL2], 'exact');
    expect(selectSAMLAssuranceClassRef({ actual: 'AAL2', classRefAal: TABLE, request })).toBe(
      AAL2_ALT
    );
  });

  it.each<[SAMLAuthnContextComparison, string[], AAL, string | null]>([
    // exact: only a requested reference, the strongest the sign-in meets.
    ['exact', [AAL2], 'AAL3', AAL2],
    ['exact', [AAL2, AAL3], 'AAL3', AAL3],
    ['exact', [AAL3], 'AAL2', null],
    // minimum: the strongest reference the sign-in meets, which is at least the lowest requested.
    ['minimum', [AAL2], 'AAL3', AAL3],
    ['minimum', [AAL2], 'AAL2', AAL2],
    ['minimum', [AAL3], 'AAL2', null],
    // better: stronger than any one requested.
    ['better', [AAL1], 'AAL3', AAL3],
    ['better', [AAL2], 'AAL2', null],
    ['better', [AAL1, AAL3], 'AAL2', AAL2],
    ['better', [AAL1, AAL3], 'AAL1', null],
    // maximum: the strongest reference not above the highest requested, and not above the sign-in.
    ['maximum', [AAL2], 'AAL3', AAL2],
    ['maximum', [AAL2], 'AAL1', AAL1],
    ['maximum', [AAL1], 'AAL3', AAL1],
  ])('with Comparison %s of %j and a sign-in at %s gives %s', (cmp, refs, actual, expected) => {
    const request = resolve(refs, cmp);
    expect(selectSAMLAssuranceClassRef({ actual, classRefAal: TABLE, request })).toBe(expected);
  });

  it('gives nothing when the table has no reference the sign-in meets', () => {
    expect(
      selectSAMLAssuranceClassRef({
        actual: 'AAL1',
        classRefAal: { [AAL2]: 'AAL2' },
        request: none,
      })
    ).toBeNull();
  });
});

describe('chooseSAMLAuthnContextClassRef', () => {
  const PHISHING_RESISTANT = 'urn:authrim:acr:phishing-resistant';
  const request = (refs?: string[]) => ({
    id: '_r',
    issueInstant: '2026-01-01T00:00:00Z',
    issuer: 'https://sp.example.test',
    requestedAuthnContext: refs
      ? { comparison: 'exact' as const, authnContextClassRef: refs }
      : undefined,
  });
  const options = (defaultRef?: string) => ({
    spConfig: {
      authnContextClassRefMode: 'legacy_static' as const,
      defaultAuthnContextClassRef: defaultRef,
    },
  });
  const guard = (reached: 'AAL0' | AAL, table: Record<string, AAL>) => ({
    reached,
    classRefAal: table,
  });

  it('puts in the assertion the reference the existing handling chooses when no guard applies', () => {
    expect(chooseSAMLAuthnContextClassRef(request([PPT]), options())).toBe(PPT);
  });

  it('prefers the reference chosen for the AAL reached', () => {
    expect(
      chooseSAMLAuthnContextClassRef(request(), options(), {
        classRef: AAL2,
        guard: guard('AAL2', TABLE),
      })
    ).toBe(AAL2);
  });

  it('does not issue a listed reference to a sign-in below its AAL, however it was chosen', () => {
    const table = { [PHISHING_RESISTANT]: 'AAL2' } as Record<string, AAL>;
    // The existing handling prefers its own phishing-resistant reference to the static one.
    const mixed = request([PHISHING_RESISTANT, 'urn:legacy:context']);
    // It chooses among the references the sign-in has reached: the static one.
    expect(
      chooseSAMLAuthnContextClassRef(mixed, options('urn:legacy:context'), {
        guard: guard('AAL1', table),
      })
    ).toBe('urn:legacy:context');
    // And a static or session choice that is itself above the AAL reached is refused.
    expect(() =>
      chooseSAMLAuthnContextClassRef(request(), options(PHISHING_RESISTANT), {
        guard: guard('AAL1', table),
      })
    ).toThrow(SAMLAuthnContextPolicyError);
    expect(() =>
      chooseSAMLAuthnContextClassRef(request([PHISHING_RESISTANT]), options(), {
        guard: guard('AAL1', table),
      })
    ).toThrow(SAMLAuthnContextPolicyError);
  });

  it('issues a listed reference to a sign-in that reached its AAL', () => {
    const table = { [PHISHING_RESISTANT]: 'AAL2' } as Record<string, AAL>;
    expect(
      chooseSAMLAuthnContextClassRef(request([PHISHING_RESISTANT]), options(), {
        guard: guard('AAL2', table),
      })
    ).toBe(PHISHING_RESISTANT);
  });

  it('refuses even a reference chosen for the AAL reached if the table says it is above it', () => {
    expect(() =>
      chooseSAMLAuthnContextClassRef(request(), options(), {
        classRef: AAL3,
        guard: guard('AAL2', TABLE),
      })
    ).toThrow(SAMLAuthnContextPolicyError);
  });

  it.each([
    ['better', [PPT], 'AAL2', { [PPT]: 'AAL1' as AAL, [AAL2]: 'AAL2' as AAL }, AAL2],
    ['better', [PPT], 'AAL2', { [PPT]: 'AAL1' as AAL, [AAL3]: 'AAL3' as AAL }, null],
    ['minimum', [AAL2], 'AAL3', { [AAL2]: 'AAL2' as AAL, [AAL3]: 'AAL3' as AAL }, AAL2],
    ['maximum', [AAL2], 'AAL3', { [AAL2]: 'AAL2' as AAL, [AAL3]: 'AAL3' as AAL }, AAL2],
    ['exact', [AAL2], 'AAL3', { [AAL2]: 'AAL2' as AAL, [AAL3]: 'AAL3' as AAL }, AAL2],
  ] as const)(
    'for a request read through the table (%s of %j) answers with a reference that fits it',
    (comparison, refs, reached, table, expected) => {
      const mapped = resolve([...refs], comparison, table);
      const run = () =>
        chooseSAMLAuthnContextClassRef(
          request([...refs]),
          // The existing handling returns the first reference it supports among those requested
          // (PasswordProtectedTransport, or the SP's own default).
          {
            spConfig: {
              authnContextClassRefMode: 'legacy_static',
              defaultAuthnContextClassRef: AAL2,
            },
          },
          { guard: { reached, classRefAal: table, request: mapped } }
        );
      if (expected) expect(run()).toBe(expected);
      else expect(run).toThrow(SAMLAuthnContextPolicyError);
    }
  );
});
