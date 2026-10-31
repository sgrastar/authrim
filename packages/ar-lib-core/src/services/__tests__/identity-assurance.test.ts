import { describe, expect, it } from 'vitest';
import {
  assuranceValuesForIAL,
  computeEffectiveIAL,
  ialAssuranceValuesProblem,
  ialEvidenceStatus,
  ialMapProblem,
  idaProfileProblem,
  IAL_FRAMEWORK,
  meetsIAL,
  parseIALAssuranceValues,
  parseIDAProfile,
  parseScopeIALRequirements,
  requiredIAL,
  type IALEvidence,
} from '../identity-assurance';

const evidence = (overrides: Partial<IALEvidence>): IALEvidence => ({
  id: 'ev',
  assurance_framework: IAL_FRAMEWORK,
  assurance_level: 'IAL2',
  verified_at: 1_000,
  expires_at: null,
  revoked_at: null,
  ...overrides,
});

describe('identity assurance', () => {
  it('counts only verified, unexpired, unrevoked NIST evidence', () => {
    const now = 5_000;
    expect(computeEffectiveIAL([], now)).toEqual({
      level: 'IAL1',
      evidenceId: null,
      verifiedAt: null,
    });
    for (const row of [
      evidence({ revoked_at: 2_000 }),
      evidence({ expires_at: 5_000 }),
      evidence({ verified_at: null }),
      evidence({ verified_at: 6_000 }),
      evidence({ assurance_framework: 'eidas' }),
      evidence({ assurance_framework: null }),
      evidence({ assurance_level: 'ial2' }),
      evidence({ assurance_level: 'substantial' }),
    ]) {
      expect(computeEffectiveIAL([row], now).level).toBe('IAL1');
    }
    expect(ialEvidenceStatus(evidence({ verified_at: 6_000 }), now)).toBe('pending');
    expect(ialEvidenceStatus(evidence({ expires_at: 4_000 }), now)).toBe('expired');
    expect(ialEvidenceStatus(evidence({ revoked_at: 1 }), now)).toBe('revoked');
    expect(ialEvidenceStatus(evidence({}), now)).toBe('active');
  });

  it('takes the highest level, resting on its most recent verification', () => {
    expect(
      computeEffectiveIAL(
        [
          evidence({ id: 'a', assurance_level: 'IAL2', verified_at: 1_000 }),
          evidence({ id: 'b', assurance_level: 'IAL2', verified_at: 3_000 }),
          evidence({ id: 'c', assurance_level: 'IAL1', verified_at: 4_000 }),
        ],
        5_000
      )
    ).toEqual({ level: 'IAL2', evidenceId: 'b', verifiedAt: 3_000 });
    expect(
      computeEffectiveIAL(
        [evidence({ id: 'a' }), evidence({ id: 'z', assurance_level: 'IAL3', verified_at: 500 })],
        5_000
      ).evidenceId
    ).toBe('z');
  });

  it('requires the highest of the scopes and minimums, nothing for IAL1', () => {
    const scopeRequirements = parseScopeIALRequirements(
      '{"payroll":"IAL2","records":"IAL3","open":"IAL1","bad":"AAL2","__proto__":"IAL3"}'
    );
    expect(Object.getPrototypeOf(scopeRequirements)).toBeNull();
    expect({ ...scopeRequirements }).toEqual({
      payroll: 'IAL2',
      records: 'IAL3',
      open: 'IAL1',
      ['__proto__']: 'IAL3',
    });
    expect(requiredIAL({ scopes: ['openid', 'open'], scopeRequirements })).toBeNull();
    expect(requiredIAL({ scopes: ['payroll'], scopeRequirements })).toBe('IAL2');
    expect(requiredIAL({ scopes: ['payroll'], scopeRequirements, minimums: ['IAL3'] })).toBe(
      'IAL3'
    );
    expect(requiredIAL({ minimums: [null, undefined, 'IAL2'] })).toBe('IAL2');
    expect(requiredIAL({ scopes: ['toString'], scopeRequirements })).toBeNull();
    expect(meetsIAL('IAL2', 'IAL2')).toBe(true);
    expect(meetsIAL('IAL1', 'IAL2')).toBe(false);
  });

  it('reads only the map’s own scopes, whatever object it is given', () => {
    expect(
      requiredIAL({
        scopes: ['payroll', 'toString', 'low'],
        scopeRequirements: { payroll: 'IAL3', low: 'IAL1' },
      })
    ).toBe('IAL3');
  });

  it('compares times stored as text (PostgreSQL BIGINT) as numbers', () => {
    expect(
      computeEffectiveIAL(
        [
          evidence({ id: 'old', verified_at: '900000000000' }),
          evidence({ id: 'new', verified_at: '1791000000000' }),
        ],
        1_800_000_000_000
      )
    ).toEqual({ level: 'IAL2', evidenceId: 'new', verifiedAt: 1_791_000_000_000 });
    expect(ialEvidenceStatus(evidence({ expires_at: '1000' }), 2_000)).toBe('expired');
  });

  it('validates the saved maps the way runtime reads them', () => {
    expect(ialMapProblem({ payroll: 'IAL2' })).toBeNull();
    expect(ialMapProblem([])).not.toBeNull();
    expect(ialMapProblem({ ' payroll': 'IAL2' })).not.toBeNull();
    expect(ialMapProblem({ payroll: 'AAL2' })).not.toBeNull();

    const gakunin = 'https://www.gakunin.jp/profile/IAL2';
    expect(ialAssuranceValuesProblem({ IAL2: [gakunin] })).toBeNull();
    expect(ialAssuranceValuesProblem({ IAL4: [gakunin] })).not.toBeNull();
    expect(ialAssuranceValuesProblem({ IAL2: [] })).not.toBeNull();
    expect(ialAssuranceValuesProblem({ IAL2: ['not a uri'] })).not.toBeNull();
    expect(ialAssuranceValuesProblem({ IAL2: [gakunin, gakunin] })).not.toBeNull();
    expect(
      ialAssuranceValuesProblem({ IAL2: Array.from({ length: 17 }, (_, i) => `urn:x:${i}`) })
    ).not.toBeNull();
  });

  it('releases the values of every level up to the person’s, without repeats', () => {
    const values = parseIALAssuranceValues(
      JSON.stringify({
        IAL1: ['https://refeds.org/assurance/IAP/low'],
        IAL2: ['https://refeds.org/assurance/IAP/medium', 'https://www.gakunin.jp/profile/IAL2'],
        IAL3: ['https://refeds.org/assurance/IAP/high', 'https://refeds.org/assurance/IAP/low'],
      })
    );
    expect(assuranceValuesForIAL('IAL1', values)).toEqual(['https://refeds.org/assurance/IAP/low']);
    expect(assuranceValuesForIAL('IAL2', values)).toEqual([
      'https://refeds.org/assurance/IAP/low',
      'https://refeds.org/assurance/IAP/medium',
      'https://www.gakunin.jp/profile/IAL2',
    ]);
    expect(assuranceValuesForIAL('IAL3', values)).toHaveLength(4);
    expect(parseIALAssuranceValues('not json')).toEqual({});
    expect(parseIALAssuranceValues({ IAL2: ['x y', 7] })).toEqual({});
  });

  it('reads an Identity Assurance profile only when it is one runtime can use', () => {
    const profile = {
      trust_framework: 'nist_800_63A',
      assurance_levels: { IAL2: 'nist_800_63A_ial_2' },
      claims: ['given_name', 'birthdate'],
    };
    expect(parseIDAProfile(JSON.stringify(profile))).toEqual({
      trustFramework: 'nist_800_63A',
      assuranceLevels: { IAL2: 'nist_800_63A_ial_2' },
      claims: ['given_name', 'birthdate'],
    });
    expect(parseIDAProfile('{}')).toBeNull();
    expect(parseIDAProfile('nope')).toBeNull();
    expect(idaProfileProblem({})).toBeNull();
    expect(idaProfileProblem({ ...profile, extra: 1 })).not.toBeNull();
    expect(idaProfileProblem({ ...profile, claims: ['given_name', 'given_name'] })).not.toBeNull();
    expect(idaProfileProblem({ ...profile, claims: ['email_verified'] })).not.toBeNull();
    expect(idaProfileProblem({ ...profile, trust_framework: '' })).not.toBeNull();
  });
});
