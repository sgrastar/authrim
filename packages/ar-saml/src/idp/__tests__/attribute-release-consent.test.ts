import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  trust: null as Record<string, unknown> | null,
  requirements: [] as Array<{ is_required: boolean }>,
  requirementsError: false,
  existing: null as Record<string, unknown> | null,
  latest: null as Record<string, unknown> | null,
  decision: { action: 'release', reasonCodes: ['release.granted'] } as Record<string, unknown>,
  findGranted: vi.fn(),
  findLatest: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => ({})),
    resolveClientTrustPolicy: vi.fn(async () => mocks.trust),
    resolveConsentRequirements: vi.fn(async () => {
      if (mocks.requirementsError) throw new Error('policy unavailable');
      return mocks.requirements;
    }),
    evaluateReleaseConsentGate: vi.fn(() => mocks.decision),
    AttributeReleaseConsentRepository: class {
      findGrantedConsent = mocks.findGranted;
      findLatestGrantedConsentForDestination = mocks.findLatest;
    },
  };
});
import {
  buildSAMLAttributeSetHash,
  enforceSAMLAttributeReleaseConsent,
  normalizeAttributeReleaseConsentPolicy,
} from '../attribute-release-consent';

describe('SAML attribute release consent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trust = null;
    mocks.requirements = [];
    mocks.requirementsError = false;
    mocks.existing = null;
    mocks.latest = null;
    mocks.decision = { action: 'release', reasonCodes: ['release.granted'] };
    mocks.findGranted.mockImplementation(async () => mocks.existing);
    mocks.findLatest.mockImplementation(async () => mocks.latest);
  });

  it('normalizes protocol-neutral attribute release consent policy config', () => {
    expect(
      normalizeAttributeReleaseConsentPolicy({
        enabled: true,
        mode: 'until_attributes_change',
      })
    ).toEqual({
      enabled: true,
      mode: 'until_attributes_change',
    });

    expect(normalizeAttributeReleaseConsentPolicy({ enabled: true, mode: 'invalid' })).toBeNull();
    expect(normalizeAttributeReleaseConsentPolicy(null)).toBeNull();
    expect(normalizeAttributeReleaseConsentPolicy([])).toBeNull();
    expect(normalizeAttributeReleaseConsentPolicy('once')).toBeNull();
    expect(normalizeAttributeReleaseConsentPolicy({ enabled: false })).toEqual({
      enabled: false,
      mode: 'once',
    });
  });

  it('builds a stable attribute set hash without storing raw values', async () => {
    const left = await buildSAMLAttributeSetHash([
      {
        name: 'displayName',
        values: ['Example User'],
      },
      {
        name: 'mail',
        friendlyName: 'mail',
        values: ['user@example.edu'],
      },
    ]);
    const right = await buildSAMLAttributeSetHash([
      {
        name: 'mail',
        friendlyName: 'mail',
        values: ['user@example.edu'],
      },
      {
        name: 'displayName',
        values: ['Example User'],
      },
    ]);

    expect(left).toBe(right);
    expect(left).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(left).not.toContain('user@example.edu');
  });

  it('accepts a matching same-transaction confirmation before checking stored grants', async () => {
    const attributes = [
      {
        name: 'mail',
        friendlyName: 'mail',
        values: ['user@example.edu'],
      },
    ];
    const attributeSetHash = await buildSAMLAttributeSetHash(attributes);

    await expect(
      enforceSAMLAttributeReleaseConsent({
        env: {} as never,
        tenantId: 'tenant-a',
        subjectId: 'user-1',
        spConfig: {
          entityId: 'https://sp.example.edu/saml',
          acsUrl: 'https://sp.example.edu/acs',
          nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
          attributeMapping: {},
          allowedBindings: ['post'],
          signAssertions: true,
          signResponses: true,
          attributeReleaseConsent: {
            enabled: true,
            mode: 'every_time',
          },
        },
        attributes,
        confirmedRelease: {
          subjectId: 'user-1',
          destinationType: 'saml_sp',
          destinationId: 'https://sp.example.edu/saml',
          attributeSetHash,
          confirmedAt: Date.now(),
        },
      })
    ).resolves.toMatchObject({
      action: 'release',
      attributeSetHash,
      reasonCodes: ['release.attribute_consent.transaction_confirmed'],
    });
  });

  it('releases empty attribute sets without persistence', async () => {
    await expect(enforceSAMLAttributeReleaseConsent(input({ attributes: [] }))).resolves.toEqual({
      action: 'release',
      attributeSetHash: null,
      reasonCodes: [],
    });
    expect(mocks.findLatest).not.toHaveBeenCalled();
  });

  it.each([{ trusted: true }, { skip_authorization_consent: true }])(
    'bypasses consent for trusted SP policy %#',
    async (trust) => {
      mocks.trust = trust;
      await expect(enforceSAMLAttributeReleaseConsent(input())).resolves.toMatchObject({
        action: 'release',
        reasonCodes: ['release.trusted_saml_sp'],
      });
    }
  );

  it('keeps consent disabled when no higher-level policy requires it or lookup fails', async () => {
    await expect(
      enforceSAMLAttributeReleaseConsent(input({ attributeReleaseConsent: undefined }))
    ).resolves.toMatchObject({ action: 'release', attributeSetHash: null });
    mocks.requirementsError = true;
    await expect(
      enforceSAMLAttributeReleaseConsent(input({ attributeReleaseConsent: undefined }))
    ).resolves.toMatchObject({ action: 'release', attributeSetHash: null });
  });

  it('enables one-time consent when a protocol-neutral policy requires it', async () => {
    mocks.requirements = [{ is_required: false }, { is_required: true }];
    await enforceSAMLAttributeReleaseConsent(input({ attributeReleaseConsent: undefined }));
    expect(mocks.findLatest).toHaveBeenCalled();
  });

  it('accepts transaction confirmation after a protocol-neutral policy enables consent', async () => {
    const attributes = standardAttributes();
    const attributeSetHash = await buildSAMLAttributeSetHash(attributes);
    mocks.requirements = [{ is_required: true }];
    await expect(
      enforceSAMLAttributeReleaseConsent(
        input({
          attributeReleaseConsent: undefined,
          attributes,
          confirmedRelease: {
            subjectId: 'user-1',
            destinationType: 'saml_sp',
            destinationId: 'https://sp.example.edu/saml',
            attributeSetHash,
            confirmedAt: Date.now(),
          },
        })
      )
    ).resolves.toMatchObject({
      action: 'release',
      reasonCodes: ['release.attribute_consent.transaction_confirmed'],
    });
  });

  it.each([
    { subjectId: 'other' },
    { destinationType: 'oidc_client' },
    { destinationId: 'other' },
    { attributeSetHash: 'other' },
    { confirmedAt: 0 },
  ])('does not accept mismatched transaction confirmation %#', async (override) => {
    const attributes = standardAttributes();
    const hash = await buildSAMLAttributeSetHash(attributes);
    await enforceSAMLAttributeReleaseConsent(
      input({
        attributes,
        confirmedRelease: {
          subjectId: 'user-1',
          destinationType: 'saml_sp',
          destinationId: 'https://sp.example.edu/saml',
          attributeSetHash: hash,
          confirmedAt: Date.now(),
          ...override,
        } as never,
      })
    );
    expect(mocks.findLatest).toHaveBeenCalled();
  });

  it('checks exact and latest grants for until-attributes-change mode', async () => {
    mocks.existing = null;
    mocks.latest = {
      consent_state: 'granted',
      attribute_set_hash: 'old',
      consent_record_id: 'record-a',
    };
    await enforceSAMLAttributeReleaseConsent(
      input({ attributeReleaseConsent: { enabled: true, mode: 'until_attributes_change' } })
    );
    expect(mocks.findGranted).toHaveBeenCalled();
    expect(mocks.findLatest).toHaveBeenCalled();

    mocks.existing = { consent_state: 'granted' };
    await enforceSAMLAttributeReleaseConsent(
      input({ attributeReleaseConsent: { enabled: true, mode: 'until_attributes_change' } })
    );
    expect(mocks.findLatest).toHaveBeenCalledTimes(1);
  });

  it.each(['granted', 'denied', 'revoked', 'expired', 'unknown', undefined])(
    'normalizes stored consent state %s before evaluation',
    async (consentState) => {
      mocks.latest = {
        consent_state: consentState,
        attribute_set_hash: undefined,
        consent_record_id: undefined,
      };
      await expect(enforceSAMLAttributeReleaseConsent(input())).resolves.toMatchObject({
        action: 'release',
      });
    }
  );

  it('throws a privacy-safe challenge with attribute summaries', async () => {
    mocks.decision = { action: 'challenge', reasonCodes: ['release.consent_required'] };
    await expect(enforceSAMLAttributeReleaseConsent(input())).rejects.toMatchObject({
      name: 'SAMLAttributeReleaseConsentRequiredError',
      consentMode: 'once',
      reasonCodes: ['release.consent_required'],
      attributeSummaries: [
        {
          name: 'mail',
          friendlyName: 'Email',
          nameFormat: 'uri',
          valueCount: 2,
        },
      ],
    });
  });

  it('canonically sorts duplicate names through format and friendly-name tie breakers', async () => {
    const hash = await buildSAMLAttributeSetHash([
      { name: 'same', nameFormat: 'b', friendlyName: 'same', values: ['1'] },
      { name: 'same', nameFormat: 'a', friendlyName: 'same', values: ['2'] },
      { name: 'same', nameFormat: 'a', friendlyName: 'z', values: ['3'] },
      { name: 'same', nameFormat: 'a', friendlyName: 'a', values: ['4'] },
      { name: 'same', nameFormat: 'a', friendlyName: 'a', values: ['5'] },
    ]);
    expect(hash).toMatch(/^sha256:/);
  });
});

function standardAttributes() {
  return [
    {
      name: 'mail',
      friendlyName: 'Email',
      nameFormat: 'uri',
      values: ['a@example.test', 'b@example.test'],
    },
  ];
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    env: {} as never,
    tenantId: 'tenant-a',
    subjectId: 'user-1',
    spConfig: {
      entityId: 'https://sp.example.edu/saml',
      acsUrl: 'https://sp.example.edu/acs',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      attributeMapping: {},
      allowedBindings: ['post'],
      signAssertions: true,
      signResponses: true,
      ...(Object.prototype.hasOwnProperty.call(overrides, 'attributeReleaseConsent')
        ? { attributeReleaseConsent: overrides.attributeReleaseConsent }
        : { attributeReleaseConsent: { enabled: true, mode: 'once' } }),
    },
    attributes: standardAttributes(),
    ...overrides,
  } as never;
}
