import { describe, expect, it } from 'vitest';
import {
  evaluateFederationRuntimePolicy,
  isFederationEntityExcluded,
  isFederationSourceServable,
  isSAMLAttributePresetId,
  parseFederationExceptions,
  parseFederationIdPSelection,
  parseFederationRuntimeResolutionPolicy,
} from '../saml-federation-policy';
import type { SAMLFederationRuntimeResolutionPolicy } from '../../types/saml';

const NOW = Date.parse('2026-01-01T00:00:00Z');

function payload(runtimeResolution: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ runtimeResolution, ...extra });
}
const basePolicy = { mode: 'automatic', roles: ['saml_idp'] };

describe('isSAMLAttributePresetId', () => {
  it('accepts the four presets only', () => {
    for (const id of [
      'basic.v1',
      'academic_publisher.v1',
      'enterprise_saas.v1',
      'research_federation.v1',
    ]) {
      expect(isSAMLAttributePresetId(id)).toBe(true);
    }
    expect(isSAMLAttributePresetId('basic')).toBe(false);
    expect(isSAMLAttributePresetId(undefined)).toBe(false);
  });
});

describe('parseFederationExceptions', () => {
  it('returns empty for missing or malformed inputs', () => {
    expect(parseFederationExceptions(null)).toEqual({ excludedEntityIds: [] });
    expect(parseFederationExceptions(undefined)).toEqual({ excludedEntityIds: [] });
    expect(parseFederationExceptions('')).toEqual({ excludedEntityIds: [] });
    expect(parseFederationExceptions('not json')).toEqual({ excludedEntityIds: [] });
    expect(parseFederationExceptions('[]')).toEqual({ excludedEntityIds: [] });
    expect(parseFederationExceptions('null')).toEqual({ excludedEntityIds: [] });
    expect(parseFederationExceptions({})).toEqual({ excludedEntityIds: [] });
    expect(parseFederationExceptions({ exceptions: 'x' })).toEqual({ excludedEntityIds: [] });
    expect(parseFederationExceptions({ exceptions: [] })).toEqual({ excludedEntityIds: [] });
    expect(parseFederationExceptions({ exceptions: { excludedEntityIds: 'a' } })).toEqual({
      excludedEntityIds: [],
    });
  });

  it('trims, de-duplicates and drops invalid entries from objects and JSON strings', () => {
    const exceptions = {
      excludedEntityIds: [
        ' https://a ',
        'https://a',
        5,
        null,
        '',
        '   ',
        'https://b',
        'x'.repeat(1025),
      ],
    };
    const expected = { excludedEntityIds: ['https://a', 'https://b'] };
    expect(parseFederationExceptions({ exceptions })).toEqual(expected);
    expect(parseFederationExceptions(JSON.stringify({ exceptions }))).toEqual(expected);
  });

  it('keeps entity ids of exactly the maximum length', () => {
    const id = 'x'.repeat(1024);
    expect(parseFederationExceptions({ exceptions: { excludedEntityIds: [id] } })).toEqual({
      excludedEntityIds: [id],
    });
  });

  it('caps the list at 500 entries', () => {
    const ids = Array.from({ length: 600 }, (_, i) => `e${i}`);
    const result = parseFederationExceptions({ exceptions: { excludedEntityIds: ids } });
    expect(result.excludedEntityIds).toHaveLength(500);
    expect(result.excludedEntityIds[0]).toBe('e0');
    expect(result.excludedEntityIds[499]).toBe('e499');
  });
});

describe('isFederationEntityExcluded', () => {
  it('checks membership and tolerates a missing list', () => {
    expect(isFederationEntityExcluded({ excludedEntityIds: ['a'] }, 'a')).toBe(true);
    expect(isFederationEntityExcluded({ excludedEntityIds: ['a'] }, 'b')).toBe(false);
    expect(isFederationEntityExcluded({}, 'a')).toBe(false);
  });
});

describe('parseFederationIdPSelection', () => {
  const dflt = { mode: 'authrim_search' };
  it('defaults when absent or unreadable', () => {
    expect(parseFederationIdPSelection(null)).toEqual(dflt);
    expect(parseFederationIdPSelection(undefined)).toEqual(dflt);
    expect(parseFederationIdPSelection('bad')).toEqual(dflt);
    expect(parseFederationIdPSelection({})).toEqual(dflt);
    expect(parseFederationIdPSelection({ idpSelection: 'x' })).toEqual(dflt);
    expect(parseFederationIdPSelection({ idpSelection: { mode: 'other' } })).toEqual(dflt);
    expect(parseFederationIdPSelection({ idpSelection: { mode: 'authrim_search' } })).toEqual(dflt);
  });

  it('returns a copy of the default, not the shared object', () => {
    const a = parseFederationIdPSelection(null);
    a.mode = 'external_ds';
    expect(parseFederationIdPSelection(null)).toEqual(dflt);
  });

  it('accepts external_ds with an https address (object or JSON string)', () => {
    const sel = { mode: 'external_ds', discoveryServiceUrl: 'https://ds.example/wayf' };
    expect(parseFederationIdPSelection({ idpSelection: sel })).toEqual(sel);
    expect(parseFederationIdPSelection(JSON.stringify({ idpSelection: sel }))).toEqual(sel);
    const upper = { mode: 'external_ds', discoveryServiceUrl: 'HTTPS://ds.example' };
    expect(parseFederationIdPSelection({ idpSelection: upper })).toEqual(upper);
  });

  it('falls back when the discovery address is not https', () => {
    for (const discoveryServiceUrl of [
      'http://ds.example',
      '',
      'xhttps://ds',
      ' https://ds',
      5,
      undefined,
    ]) {
      expect(
        parseFederationIdPSelection({ idpSelection: { mode: 'external_ds', discoveryServiceUrl } })
      ).toEqual(dflt);
    }
  });
});

describe('parseFederationRuntimeResolutionPolicy: gating', () => {
  it('returns null for missing or unreadable payloads', () => {
    expect(parseFederationRuntimeResolutionPolicy(null, NOW)).toBeNull();
    expect(parseFederationRuntimeResolutionPolicy(undefined, NOW)).toBeNull();
    expect(parseFederationRuntimeResolutionPolicy('', NOW)).toBeNull();
    expect(parseFederationRuntimeResolutionPolicy('{bad', NOW)).toBeNull();
    expect(parseFederationRuntimeResolutionPolicy('[]', NOW)).toBeNull();
    expect(parseFederationRuntimeResolutionPolicy('{}', NOW)).toBeNull();
    expect(parseFederationRuntimeResolutionPolicy(payload('x'), NOW)).toBeNull();
    expect(parseFederationRuntimeResolutionPolicy(payload([]), NOW)).toBeNull();
  });

  it('returns null when polling says expired', () => {
    expect(
      parseFederationRuntimeResolutionPolicy(
        payload(basePolicy, { polling: { sourceState: 'expired' } }),
        NOW
      )
    ).toBeNull();
    expect(
      parseFederationRuntimeResolutionPolicy(
        payload(basePolicy, { polling: { sourceState: 'ok' } }),
        NOW
      )
    ).not.toBeNull();
  });

  it('honours acceptedValidUntil', () => {
    const at = (v: unknown) =>
      parseFederationRuntimeResolutionPolicy(
        payload(basePolicy, { polling: { acceptedValidUntil: v } }),
        NOW
      );
    expect(at('2026-01-01T00:00:01Z')).not.toBeNull();
    expect(at('2026-01-01T00:00:00Z')).toBeNull(); // equal to now is expired
    expect(at('2025-12-31T23:59:59Z')).toBeNull();
    expect(at('garbage')).toBeNull();
    expect(at(123)).toBeNull();
    expect(at(null)).toBeNull();
  });

  it('ignores a non-object polling value', () => {
    expect(
      parseFederationRuntimeResolutionPolicy(payload(basePolicy, { polling: 'expired' }), NOW)
    ).not.toBeNull();
  });

  it('defaults now to the current time', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    expect(
      parseFederationRuntimeResolutionPolicy(
        payload(basePolicy, { polling: { acceptedValidUntil: future } })
      )
    ).not.toBeNull();
    expect(
      parseFederationRuntimeResolutionPolicy(
        payload(basePolicy, { polling: { acceptedValidUntil: past } })
      )
    ).toBeNull();
  });

  it('validates roles', () => {
    const p = (roles: unknown) =>
      parseFederationRuntimeResolutionPolicy(payload({ mode: 'automatic', roles }), NOW);
    expect(p(undefined)).toBeNull();
    expect(p('saml_idp')).toBeNull();
    expect(p(['saml_idp', 'other'])).toBeNull();
    expect(p(['saml_idp', 'saml_idp'])).toBeNull();
    expect(p([])?.roles).toEqual([]);
    expect(p(['saml_idp', 'saml_sp'])?.roles).toEqual(['saml_idp', 'saml_sp']);
    expect(p(['saml_sp'])?.roles).toEqual(['saml_sp']);
  });

  it('validates registrationAuthorities', () => {
    const p = (registrationAuthorities: unknown) =>
      parseFederationRuntimeResolutionPolicy(
        payload({ ...basePolicy, registrationAuthorities }),
        NOW
      );
    expect(p('x')).toBeNull();
    expect(p([1])).toBeNull();
    expect(p([''])).toBeNull();
    expect(p(['https://ra'])?.registrationAuthorities).toEqual(['https://ra']);
    expect(p([])?.registrationAuthorities).toEqual([]);
  });
});

describe('parseFederationRuntimeResolutionPolicy: output', () => {
  it('produces a minimal policy', () => {
    expect(
      parseFederationRuntimeResolutionPolicy(
        payload({ mode: 'automatic', roles: ['saml_sp'] }),
        NOW
      )
    ).toEqual({ mode: 'automatic', roles: ['saml_sp'] });
  });

  it('falls back to inventory_only for any other mode', () => {
    for (const mode of ['inventory_only', 'x', undefined]) {
      expect(parseFederationRuntimeResolutionPolicy(payload({ mode, roles: [] }), NOW)?.mode).toBe(
        'inventory_only'
      );
    }
  });

  it('carries optional fields through', () => {
    const policy = parseFederationRuntimeResolutionPolicy(
      payload(
        {
          ...basePolicy,
          priority: 7,
          idpFieldMappingSetId: 'idp-set',
          spFieldMappingSetId: 'sp-set',
          defaultAttributePresetId: 'basic.v1',
          registrationAuthorities: ['ra1', 'ra2'],
          entityCategoryPolicy: {
            defaultDecision: 'deny',
            rules: [
              { entityCategory: 'c1', decision: 'allow', attributePresetId: 'enterprise_saas.v1' },
              { entityCategory: 'c2', decision: 'deny' },
            ],
          },
        },
        { exceptions: { excludedEntityIds: ['x1'] } }
      ),
      NOW
    );
    expect(policy).toEqual({
      mode: 'automatic',
      roles: ['saml_idp'],
      priority: 7,
      idpFieldMappingSetId: 'idp-set',
      spFieldMappingSetId: 'sp-set',
      defaultAttributePresetId: 'basic.v1',
      registrationAuthorities: ['ra1', 'ra2'],
      entityCategoryPolicy: {
        defaultDecision: 'deny',
        rules: [
          { entityCategory: 'c1', decision: 'allow', attributePresetId: 'enterprise_saas.v1' },
          { entityCategory: 'c2', decision: 'deny' },
        ],
      },
      excludedEntityIds: ['x1'],
    });
  });

  it('omits invalid optional fields', () => {
    const policy = parseFederationRuntimeResolutionPolicy(
      payload({
        ...basePolicy,
        priority: 1.5,
        idpFieldMappingSetId: '',
        spFieldMappingSetId: 5,
        defaultAttributePresetId: 'nope',
      }),
      NOW
    );
    expect(policy).toEqual({ mode: 'automatic', roles: ['saml_idp'] });
    expect(
      parseFederationRuntimeResolutionPolicy(payload({ ...basePolicy, priority: '3' }), NOW)
    ).toEqual({ mode: 'automatic', roles: ['saml_idp'] });
    expect(
      parseFederationRuntimeResolutionPolicy(payload({ ...basePolicy, priority: 0 }), NOW)?.priority
    ).toBe(0);
  });
});

describe('parseFederationRuntimeResolutionPolicy: entityCategoryPolicy', () => {
  const p = (entityCategoryPolicy: unknown) =>
    parseFederationRuntimeResolutionPolicy(payload({ ...basePolicy, entityCategoryPolicy }), NOW);
  const rule = (extra: Record<string, unknown> = {}) => ({
    entityCategory: 'c',
    decision: 'allow',
    ...extra,
  });

  it('is optional', () => {
    expect(p(undefined)?.entityCategoryPolicy).toBeUndefined();
  });

  it('rejects malformed policies', () => {
    expect(p('x')).toBeNull();
    expect(p(null)).toBeNull();
    expect(p({ defaultDecision: 'maybe', rules: [] })).toBeNull();
    expect(p({ rules: [] })).toBeNull();
    expect(p({ defaultDecision: 'allow' })).toBeNull();
    expect(p({ defaultDecision: 'allow', rules: 'x' })).toBeNull();
    expect(p({ defaultDecision: 'allow', rules: ['x'] })).toBeNull();
    expect(p({ defaultDecision: 'allow', rules: [rule({ entityCategory: 5 })] })).toBeNull();
    expect(p({ defaultDecision: 'allow', rules: [rule({ entityCategory: '' })] })).toBeNull();
    expect(p({ defaultDecision: 'allow', rules: [rule({ decision: 'x' })] })).toBeNull();
    expect(p({ defaultDecision: 'allow', rules: [rule({ attributePresetId: 'bad' })] })).toBeNull();
    expect(p({ defaultDecision: 'allow', rules: [rule(), rule({ decision: 'deny' })] })).toBeNull();
  });

  it('accepts allow/deny defaults and drops undefined presets', () => {
    expect(p({ defaultDecision: 'allow', rules: [] })?.entityCategoryPolicy).toEqual({
      defaultDecision: 'allow',
      rules: [],
    });
    expect(
      p({ defaultDecision: 'deny', rules: [rule({ decision: 'deny' })] })?.entityCategoryPolicy
    ).toEqual({
      defaultDecision: 'deny',
      rules: [{ entityCategory: 'c', decision: 'deny' }],
    });
    const second = rule({ entityCategory: 'd', attributePresetId: 'basic.v1' });
    expect(
      p({ defaultDecision: 'allow', rules: [rule(), second] })?.entityCategoryPolicy?.rules
    ).toEqual([
      { entityCategory: 'c', decision: 'allow' },
      { entityCategory: 'd', decision: 'allow', attributePresetId: 'basic.v1' },
    ]);
  });
});

function pol(
  extra: Partial<SAMLFederationRuntimeResolutionPolicy> = {}
): SAMLFederationRuntimeResolutionPolicy {
  return { mode: 'automatic', roles: ['saml_idp'], ...extra };
}

describe('evaluateFederationRuntimePolicy', () => {
  it('refuses excluded entities first', () => {
    expect(
      evaluateFederationRuntimePolicy(
        pol({ excludedEntityIds: ['e'], registrationAuthorities: ['ra'] }),
        [],
        'ra',
        'e'
      )
    ).toEqual({ allowed: false, reason: 'excluded' });
  });

  it('applies the registration authority allow-list', () => {
    const policy = pol({ registrationAuthorities: ['ra1', 'ra2'] });
    expect(evaluateFederationRuntimePolicy(policy, [], null, 'e')).toEqual({
      allowed: false,
      reason: 'registration_authority',
    });
    expect(evaluateFederationRuntimePolicy(policy, [], 'other', 'e')).toEqual({
      allowed: false,
      reason: 'registration_authority',
    });
    expect(evaluateFederationRuntimePolicy(policy, [], 'ra2', 'e')).toEqual({ allowed: true });
    // An empty list does not restrict.
    expect(
      evaluateFederationRuntimePolicy(pol({ registrationAuthorities: [] }), [], null, 'e')
    ).toEqual({
      allowed: true,
    });
  });

  it('allows without a category policy and reports the default preset', () => {
    expect(evaluateFederationRuntimePolicy(pol(), [], null, 'e')).toEqual({ allowed: true });
    expect(
      evaluateFederationRuntimePolicy(pol({ defaultAttributePresetId: 'basic.v1' }), [], null, 'e')
    ).toEqual({ allowed: true, attributePresetId: 'basic.v1' });
  });

  it('refuses when any matching rule denies', () => {
    const policy = pol({
      entityCategoryPolicy: {
        defaultDecision: 'allow',
        rules: [
          { entityCategory: 'a', decision: 'allow' },
          { entityCategory: 'b', decision: 'deny' },
        ],
      },
    });
    expect(evaluateFederationRuntimePolicy(policy, ['a', 'b'], null, 'e')).toEqual({
      allowed: false,
      reason: 'entity_category',
    });
    // A deny rule whose category the entity lacks does not apply.
    expect(evaluateFederationRuntimePolicy(policy, ['a'], null, 'e')).toEqual({ allowed: true });
  });

  it('falls back to the default decision when no rule matches', () => {
    const rules = [{ entityCategory: 'a', decision: 'allow' as const }];
    expect(
      evaluateFederationRuntimePolicy(
        pol({ entityCategoryPolicy: { defaultDecision: 'allow', rules } }),
        ['z'],
        null,
        'e'
      )
    ).toEqual({ allowed: true });
    expect(
      evaluateFederationRuntimePolicy(
        pol({ entityCategoryPolicy: { defaultDecision: 'deny', rules } }),
        ['z'],
        null,
        'e'
      )
    ).toEqual({ allowed: false, reason: 'entity_category' });
    expect(
      evaluateFederationRuntimePolicy(
        pol({ entityCategoryPolicy: { defaultDecision: 'deny', rules } }),
        ['a'],
        null,
        'e'
      )
    ).toEqual({ allowed: true });
  });

  it('resolves attribute presets from allow rules', () => {
    const policy = pol({
      defaultAttributePresetId: 'basic.v1',
      entityCategoryPolicy: {
        defaultDecision: 'deny',
        rules: [
          { entityCategory: 'a', decision: 'allow', attributePresetId: 'enterprise_saas.v1' },
          { entityCategory: 'b', decision: 'allow', attributePresetId: 'enterprise_saas.v1' },
          { entityCategory: 'c', decision: 'allow' },
          { entityCategory: 'd', decision: 'allow', attributePresetId: 'research_federation.v1' },
        ],
      },
    });
    expect(evaluateFederationRuntimePolicy(policy, ['a'], null, 'e')).toEqual({
      allowed: true,
      attributePresetId: 'enterprise_saas.v1',
    });
    expect(evaluateFederationRuntimePolicy(policy, ['a', 'b'], null, 'e')).toEqual({
      allowed: true,
      attributePresetId: 'enterprise_saas.v1',
    });
    // Rule without its own preset uses the policy default.
    expect(evaluateFederationRuntimePolicy(policy, ['c'], null, 'e')).toEqual({
      allowed: true,
      attributePresetId: 'basic.v1',
    });
    expect(evaluateFederationRuntimePolicy(policy, ['a', 'd'], null, 'e')).toEqual({
      allowed: false,
      reason: 'preset_conflict',
    });
    expect(evaluateFederationRuntimePolicy(policy, ['a', 'c'], null, 'e')).toEqual({
      allowed: false,
      reason: 'preset_conflict',
    });
  });

  it('reports the default preset when allowed by default decision only', () => {
    const policy = pol({
      defaultAttributePresetId: 'basic.v1',
      entityCategoryPolicy: { defaultDecision: 'allow', rules: [] },
    });
    expect(evaluateFederationRuntimePolicy(policy, [], null, 'e')).toEqual({
      allowed: true,
      attributePresetId: 'basic.v1',
    });
    const noDefault = pol({ entityCategoryPolicy: { defaultDecision: 'allow', rules: [] } });
    expect(evaluateFederationRuntimePolicy(noDefault, [], null, 'e')).toEqual({ allowed: true });
  });
});

describe('isFederationSourceServable', () => {
  const servable = (
    runtime: Record<string, unknown>,
    role: 'saml_idp' | 'saml_sp',
    extra: Record<string, unknown> = {}
  ) => isFederationSourceServable(payload(runtime, extra), role, NOW);

  it("requires automatic mode, the role and that role's mapping set", () => {
    const full = {
      mode: 'automatic',
      roles: ['saml_idp', 'saml_sp'],
      idpFieldMappingSetId: 'i',
      spFieldMappingSetId: 's',
    };
    expect(servable(full, 'saml_idp')).toBe(true);
    expect(servable(full, 'saml_sp')).toBe(true);
    expect(servable({ ...full, mode: 'inventory_only' }, 'saml_idp')).toBe(false);
    expect(servable({ ...full, roles: ['saml_sp'] }, 'saml_idp')).toBe(false);
    expect(servable({ ...full, roles: ['saml_idp'] }, 'saml_sp')).toBe(false);
    expect(servable({ ...full, idpFieldMappingSetId: undefined }, 'saml_idp')).toBe(false);
    expect(servable({ ...full, spFieldMappingSetId: undefined }, 'saml_idp')).toBe(true);
    expect(servable({ ...full, spFieldMappingSetId: undefined }, 'saml_sp')).toBe(false);
    expect(servable({ ...full, idpFieldMappingSetId: undefined }, 'saml_sp')).toBe(true);
  });

  it('is false for unreadable or expired sources', () => {
    expect(isFederationSourceServable(null, 'saml_idp', NOW)).toBe(false);
    expect(
      servable({ mode: 'automatic', roles: ['saml_idp'], idpFieldMappingSetId: 'i' }, 'saml_idp', {
        polling: { sourceState: 'expired' },
      })
    ).toBe(false);
  });

  it('defaults now to the current time', () => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    expect(
      isFederationSourceServable(
        payload(
          { mode: 'automatic', roles: ['saml_idp'], idpFieldMappingSetId: 'i' },
          { polling: { acceptedValidUntil: past } }
        ),
        'saml_idp'
      )
    ).toBe(false);
  });
});
