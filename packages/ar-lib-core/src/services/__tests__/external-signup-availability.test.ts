import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_PROVIDER_LIST_LIMIT,
  bridgeExternalProvidersListed,
  externalJitSignupPolicy,
  externalSignupProviderIds,
  type ExternalJitSignupPolicy,
  type ExternalSignupProviderRow,
} from '../external-signup-availability';
import {
  NO_JIT_PROVIDER,
  jitSettingValuesWellTyped,
  parseJitAllowedProviderIds,
} from '../../types/settings/external-idp';

const USAGE = 'authentication-methods.external_provider_usage';
const everyone: ExternalJitSignupPolicy = { enabled: true, allowedProviderIds: null };

function provider(
  id: string,
  overrides: Partial<ExternalSignupProviderRow> = {}
): ExternalSignupProviderRow {
  return { id, slug: `${id}-slug`, enabled: true, jitProvisioning: true, ...overrides };
}

const ids = (
  providers: ExternalSignupProviderRow[],
  authenticationMethods: Record<string, unknown> | null = null,
  jit: ExternalJitSignupPolicy = everyone
) => externalSignupProviderIds({ authenticationMethods, providers, jit });

describe('externalSignupProviderIds', () => {
  it('counts a provider that creates accounts, with nothing saved', () => {
    expect(ids([provider('a')])).toEqual(['a']);
    expect(ids([provider('a')], {})).toEqual(['a']);
  });

  it('does not count a provider that can only link an existing account', () => {
    expect(ids([provider('a', { jitProvisioning: false })])).toEqual([]);
    expect(ids([provider('a', { jitProvisioning: false }), provider('b')])).toEqual(['b']);
  });

  it('does not count a disabled provider', () => {
    expect(ids([provider('a', { enabled: false })])).toEqual([]);
  });

  it('counts none while the tenant has JIT provisioning off', () => {
    expect(ids([provider('a')], null, { enabled: false, allowedProviderIds: null })).toEqual([]);
  });

  it('keeps to the providers the tenant allows', () => {
    const only = (allowedProviderIds: string[]) => ({ enabled: true, allowedProviderIds });
    expect(ids([provider('a'), provider('b')], null, only(['b']))).toEqual(['b']);
    expect(ids([provider('a')], null, only(['a-slug']))).toEqual([]);
    expect(ids([provider('a')], null, only(['-']))).toEqual([]);
  });

  it("honours the provider's saved sign-up switch, found by id or by an older entry's id", () => {
    const off = (entry: Record<string, unknown>) => ({ [USAGE]: [entry] });
    expect(ids([provider('a')], off({ providerId: 'a', signupEnabled: false }))).toEqual([]);
    expect(ids([provider('a')], off({ id: 'a-slug', signupEnabled: 'false' }))).toEqual([]);
    expect(ids([provider('a')], off({ id: 'a', signupEnabled: false }))).toEqual([]);
    expect(ids([provider('a')], off({ providerId: 'a', signupEnabled: true }))).toEqual(['a']);
    // Another provider's entry (the slug was reused) does not apply.
    expect(
      ids([provider('a')], off({ id: 'a-slug', providerId: 'old', signupEnabled: false }))
    ).toEqual(['a']);
  });

  it('counts a provider whose entries agree, and not one whose entries contradict', () => {
    const entries = (...list: Array<Record<string, unknown>>) => ({ [USAGE]: list });
    const on = { signupEnabled: true };
    const off = { signupEnabled: false };
    expect(
      ids([provider('a')], entries({ providerId: 'a', ...on }, { providerId: 'a', ...on }))
    ).toEqual(['a']);
    expect(
      ids([provider('a')], entries({ providerId: 'a', ...off }, { providerId: 'a', ...off }))
    ).toEqual([]);
    for (const pair of [
      [
        { providerId: 'a', ...on },
        { providerId: 'a', ...off },
      ],
      [
        { providerId: 'a', ...off },
        { providerId: 'a', ...on },
      ],
      [
        { id: 'a-slug', ...on },
        { id: 'a-slug', ...off },
      ],
      [
        { providerId: 'a', ...on },
        { id: 'a-slug', ...off },
      ],
      [
        { id: 'a', ...off },
        { id: 'a-slug', ...on },
      ],
      [
        { providerId: 'a', ...on },
        { providerId: 'a', signupEnabled: 'false' },
      ],
    ]) {
      expect(ids([provider('a')], entries(...pair))).toEqual([]);
    }
    // Contradicting entries for one provider do not stop another provider from counting.
    expect(
      ids(
        [provider('a'), provider('b')],
        entries({ providerId: 'a', ...on }, { providerId: 'a', ...off }, { providerId: 'b', ...on })
      )
    ).toEqual(['b']);
    // Another provider's entry (a different providerId) does not contradict.
    expect(
      ids(
        [provider('a')],
        entries({ providerId: 'a', ...on }, { id: 'a-slug', providerId: 'old', ...off })
      )
    ).toEqual(['a']);
  });

  it('counts none when the saved usage leaves every provider unlisted', () => {
    expect(ids([provider('a')], { [USAGE]: [] })).toEqual([]);
    expect(
      ids([provider('a'), provider('b')], {
        [USAGE]: [
          {
            providerId: 'a',
            loginEnabled: false,
            signupEnabled: false,
            reauthEnabled: false,
            accountLinkEnabled: false,
          },
        ],
      })
    ).toEqual([]);
  });

  it('throws on a saved switch it cannot understand', () => {
    expect(() =>
      ids([provider('a')], { [USAGE]: [{ providerId: 'a', signupEnabled: 'maybe' }] })
    ).toThrow();
    expect(() => ids([provider('a')], { [USAGE]: { providerId: 'a' } })).toThrow();
  });

  it('looks only at the providers the page lists', () => {
    const rows = Array.from({ length: EXTERNAL_PROVIDER_LIST_LIMIT + 1 }, (_, i) =>
      provider(`p${i}`, { jitProvisioning: i === EXTERNAL_PROVIDER_LIST_LIMIT })
    );
    expect(ids(rows)).toEqual([]);
    expect(ids(rows.slice(1).map((row, i) => ({ ...row, jitProvisioning: i === 19 })))).toEqual([
      `p${EXTERNAL_PROVIDER_LIST_LIMIT}`,
    ]);
  });
});

describe('bridgeExternalProvidersListed', () => {
  it.each([
    ['nothing saved', null],
    ['no usage saved', {}],
    ['usage that is neither a list nor text', { [USAGE]: { id: 'a' } }],
    ['usage that is null', { [USAGE]: null }],
    ['a provider with every use on by default', { [USAGE]: [{ providerId: 'a' }] }],
    ['a list text', { [USAGE]: JSON.stringify([{ providerId: 'a', signupEnabled: true }]) }],
    [
      'a provider with one use on',
      {
        [USAGE]: [
          { providerId: 'a', loginEnabled: false, reauthEnabled: false, signupEnabled: 'true' },
        ],
      },
    ],
  ])('lists them for %s', (_label, settings) => {
    expect(bridgeExternalProvidersListed(settings as Record<string, unknown> | null)).toBe(true);
  });

  const allOff = {
    loginEnabled: false,
    signupEnabled: false,
    reauthEnabled: false,
    accountLinkEnabled: false,
  };
  it.each([
    ['an empty list', { [USAGE]: [] }],
    ['an empty text', { [USAGE]: '' }],
    ['a text that is not JSON', { [USAGE]: 'nope' }],
    ['a text that is not a list', { [USAGE]: '{"a":1}' }],
    ['only entries with every use off', { [USAGE]: [{ providerId: 'a', ...allOff }] }],
    ['only a SAML entry', { [USAGE]: [{ id: 'saml:x' }] }],
    ['only a SAML entry by provider id', { [USAGE]: [{ providerId: 'saml:x' }] }],
  ])('does not list them for %s', (_label, settings) => {
    expect(bridgeExternalProvidersListed(settings)).toBe(false);
  });
});

describe('externalJitSignupPolicy', () => {
  const rest = {
    'external_idp.jit_require_verified_email': true,
    'external_idp.jit_join_all_matching_orgs': false,
    'external_idp.jit_allow_user_without_org': true,
    'external_idp.jit_allow_unverified_domain_mappings': false,
    'external_idp.jit_default_role_id': 'role_end_user',
  };

  it('reads the switch and the allow list', () => {
    expect(
      externalJitSignupPolicy({
        ...rest,
        'external_idp.jit_provisioning_enabled': true,
        'external_idp.jit_allowed_provider_ids': 'a, b',
      })
    ).toEqual({ enabled: true, allowedProviderIds: ['a', 'b'] });
    expect(
      externalJitSignupPolicy({
        ...rest,
        'external_idp.jit_provisioning_enabled': false,
        'external_idp.jit_allowed_provider_ids': '',
      })
    ).toEqual({ enabled: false, allowedProviderIds: null });
  });

  it('is off for a value of the wrong type', () => {
    for (const values of [
      {},
      {
        'external_idp.jit_provisioning_enabled': 'true',
        'external_idp.jit_allowed_provider_ids': '',
      },
      {
        ...rest,
        'external_idp.jit_provisioning_enabled': true,
        'external_idp.jit_allowed_provider_ids': null,
      },
      // Any other badly typed JIT value switches JIT off, as in the bridge.
      {
        ...rest,
        'external_idp.jit_require_verified_email': 'maybe',
        'external_idp.jit_provisioning_enabled': true,
        'external_idp.jit_allowed_provider_ids': '',
      },
    ]) {
      expect(externalJitSignupPolicy(values).enabled).toBe(false);
    }
  });
});

describe('parseJitAllowedProviderIds', () => {
  it('allows every provider only for an empty value', () => {
    expect(parseJitAllowedProviderIds('')).toBeNull();
    expect(parseJitAllowedProviderIds('-')).toEqual(['-']);
    expect(parseJitAllowedProviderIds(' , ')).toEqual(['-']);
    expect(parseJitAllowedProviderIds(' a ,b,,')).toEqual(['a', 'b']);
  });
});

/** The allow-list parsing the bridge had inline before it was shared (copied from getJITConfig). */
function previousAllowList(providerList: string): string[] | null {
  const listed = providerList
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  // Only an empty value allows every provider: one that names none allows none.
  const providers = providerList !== '' && listed.length === 0 ? [NO_JIT_PROVIDER] : listed;
  return providers.length > 0 ? providers : null;
}

describe('parseJitAllowedProviderIds against the bridge parsing it replaced', () => {
  const uuid = '0b9c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
  const inputs = [
    '',
    ' ',
    '   ',
    '\t',
    '\n',
    ',',
    ',,',
    ' , ',
    ', ,',
    '-',
    '- ',
    ' - ',
    '-,-',
    '-,a',
    'a',
    ' a ',
    'a,b',
    'a, b',
    'a ,b ',
    'a,,b',
    ',a,',
    'a,\tb\n',
    'a b',
    'a;b',
    'a|b',
    'a, ,b',
    uuid,
    uuid.toUpperCase(),
    `${uuid},${uuid.toUpperCase()}`,
    ` ${uuid} , ${uuid.toUpperCase()} `,
    `{${uuid}}`,
    uuid.replace(/-/g, ''),
    'not-a-uuid',
    '0',
    'null',
    'undefined',
    'true',
    '\u3000a\u3000',
    'a\u00a0,b',
  ];

  it.each(inputs.map((input) => [JSON.stringify(input), input]))('%s', (_label, input) => {
    expect(parseJitAllowedProviderIds(input)).toEqual(previousAllowList(input));
  });

  it('keeps ids exactly as listed: no case folding, no normalising', () => {
    expect(parseJitAllowedProviderIds(` ${uuid.toUpperCase()} `)).toEqual([uuid.toUpperCase()]);
    // The check is `includes` on the provider's id: an upper-case entry does not allow the lower-case id.
    const jit = {
      enabled: true,
      allowedProviderIds: parseJitAllowedProviderIds(uuid.toUpperCase()),
    };
    expect(ids([provider(uuid)], null, jit)).toEqual([]);
    expect(
      ids([provider(uuid)], null, {
        enabled: true,
        allowedProviderIds: parseJitAllowedProviderIds(`x, ${uuid}`),
      })
    ).toEqual([uuid]);
  });
});

describe('jitSettingValuesWellTyped', () => {
  const good = {
    'external_idp.jit_provisioning_enabled': true,
    'external_idp.jit_require_verified_email': true,
    'external_idp.jit_join_all_matching_orgs': false,
    'external_idp.jit_allow_user_without_org': true,
    'external_idp.jit_allow_unverified_domain_mappings': false,
    'external_idp.jit_allowed_provider_ids': '',
    'external_idp.jit_default_role_id': 'role_end_user',
  };

  it('accepts well typed values, and values the bridge does not check being anything', () => {
    expect(jitSettingValuesWellTyped(good)).toBe(true);
    expect(
      jitSettingValuesWellTyped({ ...good, 'external_idp.jit_update_on_login': 'maybe' })
    ).toBe(true);
  });

  it.each(
    Object.keys(good).flatMap((key) =>
      ['maybe', 7, null, ['x'], { a: 1 }, undefined].map(
        (bad) => [key, JSON.stringify(bad) ?? 'missing', bad] as const
      )
    )
  )('rejects %s as %s', (key, _label, bad) => {
    const values = { ...good, [key]: bad };
    // A text is a valid allow list or role, a boolean is not: the type is what matters.
    const stillWellTyped =
      (key === 'external_idp.jit_allowed_provider_ids' ||
        key === 'external_idp.jit_default_role_id') &&
      bad === 'maybe';
    expect(jitSettingValuesWellTyped(values)).toBe(stillWellTyped);
    if (!stillWellTyped) {
      expect(externalJitSignupPolicy(values).enabled).toBe(false);
    }
  });
});
