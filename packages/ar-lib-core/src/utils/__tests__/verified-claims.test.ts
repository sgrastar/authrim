import { describe, expect, it } from 'vitest';
import { buildVerifiedClaims, type BuildVerifiedClaimsInput } from '../verified-claims';
import type { IDAProfile } from '../../services/identity-assurance';

const NOW = Date.parse('2026-10-11T00:00:00Z');
const VERIFIED_AT = Date.parse('2026-09-01T09:30:15Z');

const profile: IDAProfile = {
  trustFramework: 'nist_800_63A',
  assuranceLevels: { IAL2: 'ial2', IAL3: 'ial3' },
  claims: ['given_name', 'family_name', 'birthdate', 'address'],
};

const claimValues = {
  given_name: 'Taro',
  family_name: 'Yamada',
  birthdate: '1990-01-02',
  address: { country: 'JP' },
  email: 'taro@example.com',
  name: 'Taro Yamada',
};

function build(
  request: BuildVerifiedClaimsInput['request'],
  overrides: Partial<BuildVerifiedClaimsInput> = {}
) {
  return buildVerifiedClaims({
    request,
    profile,
    state: { level: 'IAL2', verifiedAt: VERIFIED_AT },
    claimValues,
    canReleaseClaim: () => true,
    now: NOW,
    ...overrides,
  });
}

const ask = (verification: unknown, claims: unknown = { given_name: null }) => ({
  verification,
  claims,
});

describe('buildVerifiedClaims', () => {
  it('releases the requested claims under the profile trust framework', () => {
    expect(
      build(ask({ trust_framework: null }, { given_name: null, family_name: { essential: true } }))
    ).toEqual({
      verification: { trust_framework: 'nist_800_63A' },
      claims: { given_name: 'Taro', family_name: 'Yamada' },
    });
  });

  it('releases nothing at IAL1, whatever is asked', () => {
    expect(
      build(ask({ trust_framework: null }), { state: { level: 'IAL1', verifiedAt: null } })
    ).toBe(undefined);
    expect(
      build([ask({ trust_framework: null })], { state: { level: 'IAL1', verifiedAt: VERIFIED_AT } })
    ).toBe(undefined);
  });

  it('releases only what is asked for: no claims member, no claims', () => {
    expect(build({ verification: { trust_framework: null } })).toBeUndefined();
    expect(build(ask({ trust_framework: null }, {}))).toBeUndefined();
    expect(build(ask({ trust_framework: null }, 'given_name'))).toBeUndefined();
    expect(build(null)).toBeUndefined();
  });

  it('adds assurance_level and time to the verification only when they are requested', () => {
    expect(build(ask({ trust_framework: null, assurance_level: null, time: null }))).toEqual({
      verification: {
        trust_framework: 'nist_800_63A',
        assurance_level: 'ial2',
        time: '2026-09-01T09:30:15Z',
      },
      claims: { given_name: 'Taro' },
    });
    expect(build(ask({ trust_framework: null, time: null }))).toEqual({
      verification: { trust_framework: 'nist_800_63A', time: '2026-09-01T09:30:15Z' },
      claims: { given_name: 'Taro' },
    });
  });

  it('gives the assurance level of the effective IAL, and no more', () => {
    expect(
      build(ask({ assurance_level: null }), { state: { level: 'IAL3', verifiedAt: VERIFIED_AT } })
    ).toMatchObject({ verification: { assurance_level: 'ial3' } });
    // Asking for the higher level does not raise it.
    expect(build(ask({ assurance_level: { value: 'ial3' } }))).toBeUndefined();
    expect(build(ask({ assurance_level: { values: ['ial3', 'ial2'] } }))).toMatchObject({
      verification: { assurance_level: 'ial2' },
    });
  });

  it('leaves assurance_level out when the profile gives the IAL none, and cannot meet a constraint on it', () => {
    const noLevels = { ...profile, assuranceLevels: {} };
    expect(build(ask({ assurance_level: null }), { profile: noLevels })).toEqual({
      verification: { trust_framework: 'nist_800_63A' },
      claims: { given_name: 'Taro' },
    });
    expect(
      build(ask({ assurance_level: { value: 'ial2' } }), { profile: noLevels })
    ).toBeUndefined();
  });

  it('matches trust_framework by value or values', () => {
    expect(build(ask({ trust_framework: { value: 'nist_800_63A' } }))).toBeDefined();
    expect(build(ask({ trust_framework: { values: ['eidas', 'nist_800_63A'] } }))).toBeDefined();
    expect(build(ask({ trust_framework: { value: 'eidas' } }))).toBeUndefined();
    expect(build(ask({ trust_framework: { values: ['eidas', 'jp_aml'] } }))).toBeUndefined();
    expect(build(ask({ trust_framework: 'nist_800_63A' }))).toBeUndefined();
    expect(build(ask('nist_800_63A'))).toBeUndefined();
  });

  it('holds the verification time to max_age (seconds since the verification)', () => {
    const elapsed = (NOW - VERIFIED_AT) / 1000;
    expect(build(ask({ time: { max_age: elapsed } }))).toBeDefined();
    expect(build(ask({ time: { max_age: elapsed - 1 } }))).toBeUndefined();
    expect(build(ask({ time: { max_age: -1 } }))).toBeUndefined();
    expect(build(ask({ time: { max_age: '86400' } }))).toBeUndefined();
    expect(build(ask({ time: { max_age: elapsed } }))).toMatchObject({
      verification: { time: '2026-09-01T09:30:15Z' },
    });
  });

  it('cannot meet a time request when the verification time is unknown', () => {
    expect(
      build(ask({ time: null }), { state: { level: 'IAL2', verifiedAt: null } })
    ).toBeUndefined();
  });

  it('leaves out a request that filters on evidence, which the profile does not describe', () => {
    expect(
      build(ask({ trust_framework: null, evidence: [{ type: { value: 'document' } }] }))
    ).toBeUndefined();
    expect(
      build(ask({ trust_framework: null, evidence: [{ type: { value: 'document' } }] }), {
        state: { level: 'IAL3', verifiedAt: VERIFIED_AT },
      })
    ).toBeUndefined();
    // Without a filter, evidence is data it does not have, and is simply not returned.
    expect(build(ask({ trust_framework: null, evidence: [{ type: null }] }))).toEqual({
      verification: { trust_framework: 'nist_800_63A' },
      claims: { given_name: 'Taro' },
    });
  });

  it('releases only the claims the profile lists', () => {
    expect(
      build(ask({ trust_framework: null }, { given_name: null, email: null, name: null }))
    ).toEqual({
      verification: { trust_framework: 'nist_800_63A' },
      claims: { given_name: 'Taro' },
    });
    expect(build(ask({ trust_framework: null }, { email: null }))).toBeUndefined();
  });

  it('releases only the claims the scopes and the client policy allow', () => {
    expect(
      build(ask({ trust_framework: null }, { given_name: null, birthdate: null }), {
        canReleaseClaim: (name) => name === 'birthdate',
      })
    ).toEqual({
      verification: { trust_framework: 'nist_800_63A' },
      claims: { birthdate: '1990-01-02' },
    });
    expect(build(ask({ trust_framework: null }), { canReleaseClaim: () => false })).toBeUndefined();
  });

  it('leaves out a claim the person has no value for, and one whose requested value differs', () => {
    expect(
      build(ask({ trust_framework: null }, { given_name: null, birthdate: null }), {
        claimValues: { given_name: 'Taro', birthdate: '' },
      })
    ).toMatchObject({ claims: { given_name: 'Taro' } });
    expect(
      build(
        ask(
          { trust_framework: null },
          { given_name: { value: 'Jiro' }, family_name: { values: ['Yamada'] } }
        )
      )
    ).toEqual({
      verification: { trust_framework: 'nist_800_63A' },
      claims: { family_name: 'Yamada' },
    });
  });

  it('does not take names off the prototype for requested or held claims', () => {
    const risky = { ...profile, claims: ['given_name' as const] };
    expect(
      build(
        ask({ trust_framework: null }, JSON.parse('{"__proto__": null, "constructor": null}')),
        {
          profile: risky,
        }
      )
    ).toBeUndefined();
  });

  it('answers a list with a list: each request on its own, the unmet ones left out', () => {
    const result = build([
      ask({ trust_framework: { value: 'eidas' } }, { given_name: null }),
      ask({ trust_framework: { value: 'nist_800_63A' } }, { family_name: null }),
      ask({ trust_framework: null, assurance_level: { value: 'ial2' } }, { given_name: null }),
    ]);
    expect(result).toEqual([
      { verification: { trust_framework: 'nist_800_63A' }, claims: { family_name: 'Yamada' } },
      {
        verification: { trust_framework: 'nist_800_63A', assurance_level: 'ial2' },
        claims: { given_name: 'Taro' },
      },
    ]);
  });

  it('releases nothing when no request of a list can be answered', () => {
    expect(
      build([
        ask({ trust_framework: { value: 'eidas' } }),
        ask({ assurance_level: { value: 'x' } }),
      ])
    ).toBeUndefined();
    expect(build([])).toBeUndefined();
  });

  it('answers a list of one with a list', () => {
    expect(build([ask({ trust_framework: null })])).toEqual([
      { verification: { trust_framework: 'nist_800_63A' }, claims: { given_name: 'Taro' } },
    ]);
  });
});
