import { describe, expect, it } from 'vitest';
import {
  enforcedFAL,
  falRequiresDpop,
  falRequiresSignedPushedRequest,
  AAL_ACR_VALUES,
  aalMapProblem,
  aalToAcr,
  acrToAAL,
  computeAAL,
  isAssuranceLevel,
  meetsAAL,
  mergeStepUpEvidence,
  outboundAcrMappingsProblem,
  parseOutboundAcrMappings,
  parseScopeAALRequirements,
  parseUpstreamAcrMappings,
  requiredAAL,
  selectAcr,
  sessionAssuranceEvidence,
  type AssuranceRequest,
  parseSAMLAuthnContextAAL,
  samlAuthnContextAALProblem,
} from '../assurance';

describe('computeAAL', () => {
  it.each([
    [['passkey'], 'AAL2'],
    [['passkey', 'webauthn'], 'AAL2'],
    [['webauthn'], 'AAL2'],
    [['passkey_signup'], 'AAL0'],
    [['pwd'], 'AAL1'],
    [['pwd', 'directory'], 'AAL1'],
    [['otp', 'totp'], 'AAL1'],
    [['totp'], 'AAL1'],
    [['otp'], 'AAL0'],
    [['email_otp'], 'AAL0'],
    [['email_code'], 'AAL0'],
    [['pwd', 'otp', 'totp'], 'AAL2'],
    [['pwd', 'directory', 'otp', 'totp'], 'AAL2'],
    [['did'], 'AAL1'],
    [['anon'], 'AAL0'],
    [[], 'AAL0'],
  ] as const)('takes amr %j for %s', (amr, expected) => {
    expect(computeAAL({ amr })).toBe(expected);
  });

  it('never counts an emailed code as a second factor', () => {
    expect(computeAAL({ amr: ['pwd', 'otp'] })).toBe('AAL1');
    expect(computeAAL({ amr: ['pwd', 'email_otp'] })).toBe('AAL1');
  });

  it('does not take mfa or hardware claims it cannot verify at their word', () => {
    expect(computeAAL({ amr: ['pwd', 'mfa'] })).toBe('AAL1');
    expect(computeAAL({ amr: ['hwk'] })).toBe('AAL0');
  });

  it("maps an external IdP's acr, and takes an unmapped federated login for AAL1", () => {
    const upstreamAcrMappings = { 'urn:mace:incommon:iap:silver': 'AAL2' } as const;
    expect(
      computeAAL({
        amr: ['external_idp'],
        upstreamAcr: 'urn:mace:incommon:iap:silver',
        upstreamAcrMappings,
      })
    ).toBe('AAL2');
    expect(computeAAL({ amr: ['saml'], upstreamAcr: 'urn:other', upstreamAcrMappings })).toBe(
      'AAL1'
    );
    expect(computeAAL({ amr: ['external_idp'] })).toBe('AAL1');
    // A local factor completed with it still counts.
    expect(computeAAL({ amr: ['external_idp', 'passkey'] })).toBe('AAL2');
  });

  it('counts nothing for a method recorded as unverified (a passkey just registered)', () => {
    expect(computeAAL({ amr: ['passkey'], unverifiedMethods: ['passkey'] })).toBe('AAL0');
    expect(computeAAL({ amr: ['pwd', 'passkey'], unverifiedMethods: ['passkey'] })).toBe('AAL1');
  });

  it('gives no NIST AAL to a method it does not know', () => {
    expect(computeAAL({ amr: ['custom_method'] })).toBe('AAL0');
  });

  it('reads only own entries of the upstream mappings', () => {
    for (const upstreamAcr of ['toString', '__proto__', 'constructor']) {
      expect(computeAAL({ amr: ['saml'], upstreamAcr, upstreamAcrMappings: {} }), upstreamAcr).toBe(
        'AAL1'
      );
    }
    const mappings = parseUpstreamAcrMappings('{"__proto__":"AAL3","toString":"AAL2"}');
    expect(
      computeAAL({ amr: ['saml'], upstreamAcr: '__proto__', upstreamAcrMappings: mappings })
    ).toBe('AAL3');
    expect(
      computeAAL({ amr: ['saml'], upstreamAcr: 'toString', upstreamAcrMappings: mappings })
    ).toBe('AAL2');
  });
});

describe('acr values', () => {
  it('issues urn:authrim:aal:N and reads back only its own values', () => {
    expect(AAL_ACR_VALUES).toEqual(['urn:authrim:aal:1', 'urn:authrim:aal:2', 'urn:authrim:aal:3']);
    expect(aalToAcr('AAL2')).toBe('urn:authrim:aal:2');
    expect(aalToAcr('AAL0')).toBeNull();
    expect(acrToAAL('urn:authrim:aal:3')).toBe('AAL3');
    for (const acr of ['urn:authrim:aal:0', 'urn:authrim:aal:4', 'urn:authrim:aal:02', 'silver']) {
      expect(acrToAAL(acr), acr).toBeNull();
    }
  });

  it('knows only the four levels', () => {
    expect(isAssuranceLevel('AAL2')).toBe(true);
    expect(isAssuranceLevel('toString')).toBe(false);
  });

  it('compares levels', () => {
    expect(meetsAAL('AAL2', 'AAL1')).toBe(true);
    expect(meetsAAL('AAL1', 'AAL2')).toBe(false);
    expect(meetsAAL('AAL0', 'AAL1')).toBe(false);
  });
});

describe('requiredAAL', () => {
  const base: AssuranceRequest = {
    defaultAAL: 'AAL1',
    scopes: ['openid'],
    scopeRequirements: {},
    acrValues: [],
    interactive: true,
  };

  it('requires nothing at the AAL1 baseline, and a higher default', () => {
    expect(requiredAAL(base)).toEqual({
      mandatory: 'AAL0',
      target: 'AAL0',
      essential: false,
      essentialAcrs: null,
      unsatisfiable: false,
    });
    expect(requiredAAL({ ...base, defaultAAL: 'AAL2' })).toMatchObject({
      mandatory: 'AAL2',
      target: 'AAL2',
    });
  });

  it('takes the highest requirement of the requested scopes, and only own entries', () => {
    expect(
      requiredAAL({
        ...base,
        scopes: ['openid', 'admin', 'payments', 'toString'],
        scopeRequirements: parseScopeAALRequirements(
          '{"admin":"AAL2","payments":"AAL3","other":"AAL3"}'
        ),
      })
    ).toMatchObject({ mandatory: 'AAL3' });
  });

  it('requires the lowest essential acr Authrim issues, essential AAL1 included', () => {
    expect(
      requiredAAL({
        ...base,
        essentialAcr: { values: ['urn:authrim:aal:3', 'urn:authrim:aal:2', 'x'] },
      })
    ).toMatchObject({
      mandatory: 'AAL2',
      essential: true,
      essentialAcrs: ['urn:authrim:aal:3', 'urn:authrim:aal:2'],
      unsatisfiable: false,
    });
    expect(requiredAAL({ ...base, essentialAcr: { values: ['urn:authrim:aal:1'] } })).toMatchObject(
      { mandatory: 'AAL1' }
    );
  });

  it('requires no level for an essential request naming no values (OIDC fails only named ones)', () => {
    expect(requiredAAL({ ...base, essentialAcr: { values: null } })).toEqual({
      mandatory: 'AAL0',
      target: 'AAL0',
      essential: true,
      essentialAcrs: null,
      unsatisfiable: false,
    });
  });

  it('cannot meet an essential acr request naming only values Authrim does not issue', () => {
    expect(
      requiredAAL({ ...base, essentialAcr: { values: ['urn:mace:incommon:iap:silver'] } })
    ).toMatchObject({ essential: true, essentialAcrs: [], unsatisfiable: true });
  });

  it('aims for the most preferred voluntary acr_value, whatever its level', () => {
    expect(
      requiredAAL({ ...base, acrValues: ['urn:authrim:aal:2', 'urn:authrim:aal:1'] })
    ).toMatchObject({ mandatory: 'AAL0', target: 'AAL2' });
    expect(
      requiredAAL({ ...base, acrValues: ['other', 'urn:authrim:aal:1', 'urn:authrim:aal:3'] })
    ).toMatchObject({ target: 'AAL1' });
  });

  it('keeps a voluntary acr_value as a target, apart from what is mandatory', () => {
    expect(
      requiredAAL({ ...base, defaultAAL: 'AAL2', acrValues: ['urn:authrim:aal:3'] })
    ).toMatchObject({ mandatory: 'AAL2', target: 'AAL3' });
    expect(
      requiredAAL({ ...base, acrValues: ['urn:authrim:aal:2'], interactive: false })
    ).toMatchObject({ mandatory: 'AAL0', target: 'AAL0' });
  });

  it('does not apply the default to a guest login', () => {
    expect(requiredAAL({ ...base, defaultAAL: 'AAL2', guest: true })).toMatchObject({
      mandatory: 'AAL0',
    });
  });
});

describe('selectAcr', () => {
  const essential = (values: string[] | null) => ({ ...required(values), essential: true });
  const required = (values: string[] | null) => ({ essential: false, essentialAcrs: values });

  it('returns the first essential value the authentication meets, in order of preference', () => {
    expect(selectAcr('AAL3', essential(['urn:authrim:aal:2']))).toBe('urn:authrim:aal:2');
    expect(selectAcr('AAL3', essential(['urn:authrim:aal:1', 'urn:authrim:aal:2']))).toBe(
      'urn:authrim:aal:1'
    );
    expect(selectAcr('AAL2', essential(['urn:authrim:aal:3', 'urn:authrim:aal:2']))).toBe(
      'urn:authrim:aal:2'
    );
    expect(selectAcr('AAL1', essential(['urn:authrim:aal:2']))).toBeNull();
  });

  it("issues the authentication's own level for an essential request naming no values", () => {
    expect(selectAcr('AAL2', essential(null))).toBe('urn:authrim:aal:2');
    // Voluntary acr_values do not lower what an essential request without values gets.
    expect(selectAcr('AAL2', essential(null), ['urn:authrim:aal:1'])).toBe('urn:authrim:aal:2');
    expect(selectAcr('AAL0', essential(null))).toBeNull();
  });

  it('prefers a voluntary acr_value it meets, else its own level', () => {
    expect(selectAcr('AAL2', undefined, ['urn:authrim:aal:1', 'urn:authrim:aal:2'])).toBe(
      'urn:authrim:aal:1'
    );
    expect(selectAcr('AAL1', undefined, ['urn:authrim:aal:2'])).toBe('urn:authrim:aal:1');
    expect(selectAcr('AAL2')).toBe('urn:authrim:aal:2');
    expect(selectAcr('AAL0')).toBeNull();
  });

  it('agrees with requiredAAL for each kind of essential request', () => {
    const base = {
      defaultAAL: 'AAL1' as const,
      scopes: [],
      scopeRequirements: {},
      acrValues: [],
      interactive: true,
    };
    const anyAcr = requiredAAL({ ...base, essentialAcr: { values: null } });
    expect(selectAcr('AAL1', anyAcr)).toBe('urn:authrim:aal:1');
    const named = requiredAAL({
      ...base,
      essentialAcr: { values: ['urn:authrim:aal:2', 'x'] },
    });
    expect(selectAcr('AAL2', named)).toBe('urn:authrim:aal:2');
    expect(selectAcr('AAL1', named)).toBeNull();
  });
});

describe('outbound acr mappings', () => {
  const SILVER = 'urn:mace:incommon:iap:silver';
  const BRONZE = 'urn:mace:incommon:iap:bronze';
  const outbound = parseOutboundAcrMappings(JSON.stringify({ [SILVER]: 'AAL2', [BRONZE]: 'AAL1' }));
  const base: AssuranceRequest = {
    defaultAAL: 'AAL1',
    scopes: ['openid'],
    scopeRequirements: {},
    acrValues: [],
    interactive: true,
    outboundAcrMappings: outbound,
  };
  const essential = (values: string[] | null) => ({ essential: true, essentialAcrs: values });

  it('returns the first mapped value the authentication meets, in the order asked', () => {
    expect(selectAcr('AAL2', undefined, [SILVER, BRONZE], outbound)).toBe(SILVER);
    expect(selectAcr('AAL2', undefined, [BRONZE, SILVER], outbound)).toBe(BRONZE);
  });

  it('skips a mapped value whose AAL is not met', () => {
    expect(selectAcr('AAL1', undefined, [SILVER, BRONZE], outbound)).toBe(BRONZE);
    expect(selectAcr('AAL1', undefined, [SILVER], outbound)).toBe('urn:authrim:aal:1');
  });

  it('never returns a value the table does not map, nor one not asked for', () => {
    expect(selectAcr('AAL3', undefined, ['urn:mace:incommon:iap:gold'], outbound)).toBe(
      'urn:authrim:aal:3'
    );
    expect(selectAcr('AAL2', undefined, [SILVER])).toBe('urn:authrim:aal:2');
    expect(selectAcr('AAL2', undefined, [], outbound)).toBe('urn:authrim:aal:2');
  });

  it('takes an own value listed before a mapped one by order, and the other way round', () => {
    expect(selectAcr('AAL2', undefined, ['urn:authrim:aal:2', SILVER], outbound)).toBe(
      'urn:authrim:aal:2'
    );
    expect(selectAcr('AAL2', undefined, [SILVER, 'urn:authrim:aal:2'], outbound)).toBe(SILVER);
  });

  it('answers an essential request with a mapped value, or nothing when none is met', () => {
    const named = requiredAAL({ ...base, essentialAcr: { values: [SILVER, 'x'] } });
    expect(named).toMatchObject({
      mandatory: 'AAL2',
      essentialAcrs: [SILVER],
      unsatisfiable: false,
    });
    expect(selectAcr('AAL2', named, [], outbound)).toBe(SILVER);
    expect(selectAcr('AAL1', named, [], outbound)).toBeNull();
    expect(selectAcr('AAL3', essential([BRONZE, SILVER]), [], outbound)).toBe(BRONZE);
  });

  it('counts a mapped value towards the required level like an own value', () => {
    expect(requiredAAL({ ...base, acrValues: [SILVER] })).toMatchObject({ target: 'AAL2' });
    expect(requiredAAL({ ...base, acrValues: [SILVER] })).toEqual(
      requiredAAL({ ...base, acrValues: ['urn:authrim:aal:2'] })
    );
    expect(
      requiredAAL({ ...base, essentialAcr: { values: [SILVER, 'urn:authrim:aal:3'] } })
    ).toMatchObject({ mandatory: 'AAL2', essentialAcrs: [SILVER, 'urn:authrim:aal:3'] });
    // Unmapped, or without the table: as before.
    expect(
      requiredAAL({ ...base, acrValues: [SILVER], outboundAcrMappings: undefined })
    ).toMatchObject({ target: 'AAL0' });
    expect(
      requiredAAL({ ...base, essentialAcr: { values: ['urn:mace:incommon:iap:gold'] } })
    ).toMatchObject({ essentialAcrs: [], unsatisfiable: true });
  });

  it("reads only valid entries, never one of Authrim's own values", () => {
    expect(
      parseOutboundAcrMappings(
        JSON.stringify({
          [SILVER]: 'AAL2',
          'urn:authrim:aal:3': 'AAL1',
          'URN:Authrim:aal:3': 'AAL1',
          'two words': 'AAL1',
          toString: 'AAL9',
        })
      )
    ).toEqual({ [SILVER]: 'AAL2' });
    expect(parseOutboundAcrMappings('not json')).toEqual({});
    expect(parseOutboundAcrMappings('[]')).toEqual({});
    // A prototype name is only ever a name.
    expect(selectAcr('AAL3', undefined, ['toString'], {})).toBe('urn:authrim:aal:3');
  });

  it('names the problem with a table the Settings API would refuse', () => {
    expect(outboundAcrMappingsProblem({ [SILVER]: 'AAL2' })).toBeNull();
    expect(outboundAcrMappingsProblem({})).toBeNull();
    expect(outboundAcrMappingsProblem([])).not.toBeNull();
    expect(outboundAcrMappingsProblem({ [SILVER]: 'high' })).not.toBeNull();
    expect(outboundAcrMappingsProblem({ ' silver': 'AAL2' })).not.toBeNull();
    expect(outboundAcrMappingsProblem({ 'urn:authrim:aal:2': 'AAL2' })).not.toBeNull();
    expect(outboundAcrMappingsProblem({ 'a b': 'AAL2' })).not.toBeNull();
    expect(outboundAcrMappingsProblem({ ['x'.repeat(513)]: 'AAL2' })).not.toBeNull();
  });
});

describe('AAL maps', () => {
  it('reads saved JSON text and keeps only valid entries', () => {
    expect(parseScopeAALRequirements('{"admin":"AAL2","x":"AAL9","":"AAL1"}')).toEqual({
      admin: 'AAL2',
    });
    expect(parseUpstreamAcrMappings('not json')).toEqual({});
    expect(parseUpstreamAcrMappings('[]')).toEqual({});
  });

  it('names the problem with a map the Settings API would refuse', () => {
    expect(aalMapProblem({ admin: 'AAL2' })).toBeNull();
    expect(aalMapProblem({})).toBeNull();
    expect(aalMapProblem([])).not.toBeNull();
    expect(aalMapProblem({ admin: 'AAL0' })).not.toBeNull();
    expect(aalMapProblem({ ' admin': 'AAL2' })).not.toBeNull();
  });
});

describe('session evidence and step-up', () => {
  it('reads what a session records, and fails closed on a malformed unproven marker', () => {
    expect(
      sessionAssuranceEvidence({
        amr: ['pwd', 3, ''],
        unverified_amr: 'passkey',
        upstream_acr: 'urn:x',
      })
    ).toEqual({
      amr: ['pwd'],
      // A marker that cannot be read leaves every method unproven.
      unverifiedMethods: ['pwd'],
      upstreamAcr: 'urn:x',
      upstreamAcrMappings: undefined,
    });
    expect(
      computeAAL(sessionAssuranceEvidence({ amr: ['passkey'], unverified_amr: 'passkey' }))
    ).toBe('AAL0');
    expect(
      sessionAssuranceEvidence({ amr: ['passkey'], unverified_amr: ['passkey', 7] })
        .unverifiedMethods
    ).toEqual(['passkey']);
    expect(sessionAssuranceEvidence(undefined)).toMatchObject({ amr: [], upstreamAcr: null });
  });

  it('combines the factors a session proved with the one a step-up completes', () => {
    const merged = mergeStepUpEvidence({ amr: ['pwd'] }, { amr: ['otp', 'totp'] });
    expect(merged.amr).toEqual(['pwd', 'otp', 'totp']);
    expect(computeAAL(merged)).toBe('AAL2');
  });

  it('does not let a factor the session never proved count after a step-up', () => {
    // A passkey just registered, then a password step-up: still only the password.
    const merged = mergeStepUpEvidence(
      { amr: ['passkey'], unverifiedMethods: ['passkey'] },
      { amr: ['pwd'] }
    );
    expect(merged.amr).toEqual(['pwd']);
    expect(computeAAL(merged)).toBe('AAL1');
    // Signing in with that passkey proves it.
    const proven = mergeStepUpEvidence(
      { amr: ['passkey'], unverifiedMethods: ['passkey'] },
      { amr: ['passkey'] }
    );
    expect(computeAAL(proven)).toBe('AAL2');
  });

  it('keeps an unproven step-up factor unproven unless the session had proven it', () => {
    const merged = mergeStepUpEvidence(
      { amr: ['pwd'] },
      { amr: ['passkey'], unverifiedMethods: ['passkey'] }
    );
    expect(merged.unverifiedMethods).toEqual(['passkey']);
    expect(computeAAL(merged)).toBe('AAL1');
  });
});

describe('FAL enforcement', () => {
  const on = (values: Record<string, unknown>) => ({
    'assurance.enabled': true,
    'assurance.fal2_requires_dpop': true,
    'assurance.fal3_requires_par': true,
    ...values,
  });

  it('enforces nothing while assurance is off', () => {
    const off = { 'assurance.enabled': false, 'assurance.default_fal': 'FAL3' };
    expect(enforcedFAL(off)).toBeNull();
    expect(falRequiresDpop({ ...off, 'assurance.fal2_requires_dpop': true })).toBe(false);
    expect(falRequiresSignedPushedRequest({ ...off, 'assurance.fal3_requires_par': true })).toBe(
      false
    );
  });

  it.each([
    ['FAL1', false, false],
    ['FAL2', true, false],
    ['FAL3', true, true],
  ])('at %s requires DPoP %s and a pushed signed request %s', (fal, dpop, pushed) => {
    const settings = on({ 'assurance.default_fal': fal });
    expect(enforcedFAL(settings)).toBe(fal);
    expect(falRequiresDpop(settings)).toBe(dpop);
    expect(falRequiresSignedPushedRequest(settings)).toBe(pushed);
  });

  it('requires neither when its switch is off', () => {
    const settings = on({
      'assurance.default_fal': 'FAL3',
      'assurance.fal2_requires_dpop': false,
      'assurance.fal3_requires_par': false,
    });
    expect(falRequiresDpop(settings)).toBe(false);
    expect(falRequiresSignedPushedRequest(settings)).toBe(false);
  });

  it('takes an unknown FAL for the baseline', () => {
    expect(enforcedFAL(on({ 'assurance.default_fal': 'FAL9' }))).toBe('FAL1');
  });

  it('maps SAML AuthnContextClassRefs to an AAL only by absolute URI', () => {
    const gakunin = 'https://www.gakunin.jp/profile/AAL2';
    expect({ ...parseSAMLAuthnContextAAL(`{"${gakunin}":"AAL2","AAL2":"AAL2"}`) }).toEqual({
      [gakunin]: 'AAL2',
    });
    expect(samlAuthnContextAALProblem({ [gakunin]: 'AAL2' })).toBeNull();
    expect(samlAuthnContextAALProblem({ AAL2: 'AAL2' })).not.toBeNull();
    expect(samlAuthnContextAALProblem({ [gakunin]: 'IAL2' })).not.toBeNull();
  });
});
