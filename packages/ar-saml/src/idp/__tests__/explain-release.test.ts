/**
 * explainSAMLReleaseFixture: the management console's "explain this release" for a test user.
 *
 * The release pipeline itself (mapping resolution, attribute computation, approval) is mocked;
 * these tests pin down how the explainer assembles the before/after consent picture and how it
 * classifies every failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env, SAMLSPConfig } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  ensureAdminDatabaseAdapter: vi.fn(),
  loadDestinationProfileConsentDescriptor: vi.fn(),
  getSPConfig: vi.fn(),
  validateSAMLSPMappingConfig: vi.fn(),
  getSAMLLocalEntityIds: vi.fn(),
  resolveSAMLRuntimeIdentityMapping: vi.fn(),
  computeSAMLAttributeRelease: vi.fn(),
  samlReleaseItems: vi.fn(),
  samlApprovalNeedsIdentifiers: vi.fn(),
  applySAMLReleaseApproval: vi.fn(),
  resolveSAMLMappedNameID: vi.fn(),
  resolveEffectiveSAMLNameIDFormat: vi.fn(),
  resolveSAMLNameIDValue: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    ensureAdminDatabaseAdapter: mocks.ensureAdminDatabaseAdapter,
    loadDestinationProfileConsentDescriptor: mocks.loadDestinationProfileConsentDescriptor,
  };
});
vi.mock('../../admin/providers', () => ({
  getSPConfig: mocks.getSPConfig,
  validateSAMLSPMappingConfig: mocks.validateSAMLSPMappingConfig,
}));
vi.mock('../../common/entity-id', () => ({ getSAMLLocalEntityIds: mocks.getSAMLLocalEntityIds }));
vi.mock('../runtime-identity-mapping', () => ({
  resolveSAMLRuntimeIdentityMapping: mocks.resolveSAMLRuntimeIdentityMapping,
}));
vi.mock('../release-items', () => ({
  computeSAMLAttributeRelease: mocks.computeSAMLAttributeRelease,
  samlReleaseItems: mocks.samlReleaseItems,
  samlApprovalNeedsIdentifiers: mocks.samlApprovalNeedsIdentifiers,
  applySAMLReleaseApproval: mocks.applySAMLReleaseApproval,
  resolveSAMLMappedNameID: mocks.resolveSAMLMappedNameID,
}));
vi.mock('../subject', () => ({
  resolveEffectiveSAMLNameIDFormat: mocks.resolveEffectiveSAMLNameIDFormat,
  resolveSAMLNameIDValue: mocks.resolveSAMLNameIDValue,
}));

import {
  DestinationProfileReleaseValidationError,
  RELEASE_APPROVE_ALL,
  RELEASE_APPROVE_REQUIRED,
} from '@authrim/ar-lib-core';
import { MissingRequiredSAMLAttributeError, SAMLIdentityMappingRuntimeError } from '../attributes';
import { explainSAMLReleaseFixture, validateSAMLSPReleaseBinding } from '../explain-release';
import { NAMEID_FORMATS } from '../../common/constants';

const env = { ISSUER_URL: 'https://idp.example.test' } as Env;
const ADMIN = { queryOne: vi.fn() };
const SP_ENTITY_ID = 'https://sp.example.test/saml';
const IDP_ENTITY_ID = 'https://idp.example.test/saml/idp';

function spConfig(overrides: Partial<SAMLSPConfig> = {}): SAMLSPConfig {
  return {
    entityId: SP_ENTITY_ID,
    acsUrl: 'https://sp.example.test/acs',
    nameIdFormat: NAMEID_FORMATS.EMAIL,
    attributeMapping: {},
    allowedBindings: ['post'],
    ...overrides,
  } as unknown as SAMLSPConfig;
}

const beforeRelease = () => ({
  attributes: [
    { name: 'mail', values: ['alice@example.test'] },
    { name: 'eduPersonTargetedID', values: ['<pending>'] },
  ],
  deferred: new Set(['eduPersonTargetedID']),
  optionalMissingAttributes: ['displayName'],
  withheldScopedValues: [],
});
const afterRelease = () => ({
  attributes: [
    { name: 'mail', values: ['alice@example.test'] },
    { name: 'eduPersonTargetedID', values: ['opaque-1'] },
  ],
  deferred: new Set(),
  optionalMissingAttributes: [],
  withheldScopedValues: [],
});
const ITEMS = [
  { key: 'nameid', values: ['alice@example.test'] },
  { key: 'mail', values: ['alice@example.test'] },
];

function request(
  consent: 'all' | 'none' | 'required' = 'all',
  attributes: Record<string, unknown> = { email: 'alice@example.test', name: 'Alice' }
) {
  return {
    env,
    tenantId: 'tenant-a',
    spEntityId: SP_ENTITY_ID,
    user: { userId: 'user-1', attributes },
    consent,
  };
}

describe('explainSAMLReleaseFixture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureAdminDatabaseAdapter.mockReturnValue(ADMIN);
    mocks.getSPConfig.mockResolvedValue(spConfig());
    mocks.getSAMLLocalEntityIds.mockResolvedValue({ idpEntityId: IDP_ENTITY_ID, spEntityId: 'x' });
    mocks.resolveSAMLRuntimeIdentityMapping.mockResolvedValue({
      destinationProfileId: 'profile-1',
    });
    mocks.loadDestinationProfileConsentDescriptor.mockResolvedValue({
      fields: [{ key: 'mail' }, { key: 'displayName' }],
    });
    mocks.resolveSAMLMappedNameID.mockResolvedValue(null);
    mocks.resolveEffectiveSAMLNameIDFormat.mockReturnValue(NAMEID_FORMATS.EMAIL);
    mocks.computeSAMLAttributeRelease.mockImplementation(async (input: { identifiers: string }) =>
      input.identifiers === 'made' ? afterRelease() : beforeRelease()
    );
    mocks.samlReleaseItems.mockReturnValue(ITEMS);
    mocks.samlApprovalNeedsIdentifiers.mockReturnValue(true);
    mocks.applySAMLReleaseApproval.mockReturnValue({
      ok: true,
      attributes: afterRelease().attributes,
    });
    mocks.resolveSAMLNameIDValue.mockResolvedValue('alice@example.test');
  });

  it('should answer 503 when no admin database is configured', async () => {
    mocks.ensureAdminDatabaseAdapter.mockReturnValue(null);
    expect(await explainSAMLReleaseFixture(request())).toEqual({
      status: 503,
      body: { error: 'temporarily_unavailable' },
    });
    expect(mocks.ensureAdminDatabaseAdapter).toHaveBeenCalledWith(env, 'saml-release-explain');
    expect(mocks.getSPConfig).not.toHaveBeenCalled();
  });

  it('should answer 404 when the SP is unknown', async () => {
    mocks.getSPConfig.mockResolvedValue(null);
    expect(await explainSAMLReleaseFixture(request())).toEqual({
      status: 404,
      body: { error: 'not_found', error_description: 'SAML SP not found' },
    });
    expect(mocks.getSPConfig).toHaveBeenCalledWith(env, 'tenant-a', SP_ENTITY_ID);
    expect(mocks.getSAMLLocalEntityIds).toHaveBeenCalledWith(env, 'tenant-a');
  });

  it('should answer 500 when loading the SP configuration throws', async () => {
    mocks.getSPConfig.mockRejectedValue(new Error('db down'));
    expect(await explainSAMLReleaseFixture(request())).toEqual({
      status: 500,
      body: {
        error: 'internal_error',
        error_description: 'The SAML release could not be explained',
      },
    });
  });

  it('should explain a full release: fields, before-consent picture and released attributes', async () => {
    const result = await explainSAMLReleaseFixture(request('all'));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      protocol: 'saml',
      tenantId: 'tenant-a',
      sp_entity_id: SP_ENTITY_ID,
      subject: { kind: 'test_user', user_id: 'user-1' },
      consent: 'all',
      fields: [
        { field: 'mail', policy: 'optional' },
        { field: 'displayName', policy: 'optional' },
      ],
      before_consent: {
        items: ITEMS,
        attributes: [{ name: 'mail', values: ['alice@example.test'] }], // deferred placeholder removed
        deferred_attributes: ['eduPersonTargetedID'],
        nameid: {
          format: NAMEID_FORMATS.EMAIL,
          status: 'deferred',
          reasons: ['consent_pending'],
          value: 'alice@example.test',
        },
        optional_missing_attributes: ['displayName'],
        withheld_scoped_values: [],
      },
      after_consent: {
        status: 'released',
        attributes: afterRelease().attributes,
        nameid: { format: NAMEID_FORMATS.EMAIL, status: 'released', value: 'alice@example.test' },
        optional_missing_attributes: [],
        identifier_evaluation: 'suppressed_for_test_user',
      },
    });

    // Consent descriptor was loaded for the mapped profile with the admin adapter
    expect(mocks.loadDestinationProfileConsentDescriptor).toHaveBeenCalledWith(
      ADMIN,
      'tenant-a',
      'profile-1'
    );
    // Identifiers were deferred first, then made for the approved release
    expect(
      mocks.computeSAMLAttributeRelease.mock.calls.map(
        ([i]) => (i as { identifiers: string }).identifiers
      )
    ).toEqual(['deferred', 'made']);
    expect(mocks.applySAMLReleaseApproval).toHaveBeenCalledWith(
      afterRelease(),
      [RELEASE_APPROVE_ALL],
      NAMEID_FORMATS.EMAIL
    );
    expect(mocks.samlReleaseItems).toHaveBeenCalledWith(
      beforeRelease(),
      expect.objectContaining({ nameIdFormat: NAMEID_FORMATS.EMAIL, showValues: true })
    );
  });

  it('should pass the user through as fixture userInfo with standard attribute names and e-mail', async () => {
    await explainSAMLReleaseFixture(
      request('all', { email: 'alice@example.test', given_name: 'Alice' })
    );
    const input = mocks.computeSAMLAttributeRelease.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({
      env,
      tenantId: 'tenant-a',
      idpEntityId: IDP_ENTITY_ID,
      fixture: true,
      userId: 'user-1',
      requestScope: {},
    });
    const userInfo = input.userInfo as Record<string, unknown>;
    expect(userInfo.id).toBe('user-1');
    expect(userInfo.email).toBe('alice@example.test');
    expect(userInfo.attributes).toEqual(userInfo.customClaims);
    expect(userInfo.attributes).toEqual(userInfo.customFields);
    expect((input.onError as () => unknown)()).toBeUndefined();
  });

  it('should keep a non-string e-mail attribute as-is instead of promoting it', async () => {
    await explainSAMLReleaseFixture(request('all', { email: 42 }));
    const input = mocks.computeSAMLAttributeRelease.mock.calls[0][0] as {
      userInfo: Record<string, unknown>;
    };
    // The attribute map is spread first; only a string e-mail is promoted explicitly
    expect(input.userInfo.email).toBe(42);
    expect(input.userInfo.attributes).toMatchObject({ email: 42 });
  });

  it('should apply the destination field policies from the SP configuration', async () => {
    mocks.getSPConfig.mockResolvedValue(
      spConfig({ identityMapping: { destinationFieldPolicies: { mail: 'required' } } } as never)
    );
    const { body } = await explainSAMLReleaseFixture(request());
    expect(body.fields).toEqual([
      { field: 'mail', policy: 'required' },
      { field: 'displayName', policy: 'optional' },
    ]);
  });

  it('should report no fields and skip the consent descriptor when the SP has no mapping or profile', async () => {
    mocks.resolveSAMLRuntimeIdentityMapping.mockResolvedValue(null);
    expect((await explainSAMLReleaseFixture(request())).body.fields).toEqual([]);
    expect(mocks.loadDestinationProfileConsentDescriptor).not.toHaveBeenCalled();

    mocks.resolveSAMLRuntimeIdentityMapping.mockResolvedValue({ destinationProfileId: 'p' });
    mocks.loadDestinationProfileConsentDescriptor.mockResolvedValue(null);
    expect((await explainSAMLReleaseFixture(request())).body.fields).toEqual([]);
  });

  it('should omit the before-consent NameID value when the items carry none', async () => {
    mocks.samlReleaseItems.mockReturnValue([{ key: 'nameid', values: [] }]);
    const { body } = await explainSAMLReleaseFixture(request('none'));
    expect((body.before_consent as { nameid: object }).nameid).toEqual({
      format: NAMEID_FORMATS.EMAIL,
      status: 'deferred',
      reasons: ['consent_pending'],
    });
  });

  it('should stop at awaiting_consent when the user gave no consent', async () => {
    const { body } = await explainSAMLReleaseFixture(request('none'));
    expect(body.after_consent).toEqual({
      status: 'awaiting_consent',
      attributes: [],
      nameid: { format: NAMEID_FORMATS.EMAIL, status: 'suppressed', reasons: ['consent_missing'] },
    });
    expect(mocks.applySAMLReleaseApproval).not.toHaveBeenCalled();
    expect(mocks.resolveSAMLNameIDValue).not.toHaveBeenCalled();
  });

  it('should approve only the required items when consent is "required"', async () => {
    await explainSAMLReleaseFixture(request('required'));
    expect(mocks.applySAMLReleaseApproval).toHaveBeenCalledWith(
      expect.anything(),
      [RELEASE_APPROVE_REQUIRED],
      NAMEID_FORMATS.EMAIL
    );
  });

  it('should reuse the deferred release when the approval needs no identifiers', async () => {
    mocks.samlApprovalNeedsIdentifiers.mockReturnValue(false);
    const { body } = await explainSAMLReleaseFixture(request());
    expect(mocks.computeSAMLAttributeRelease).toHaveBeenCalledTimes(1);
    expect(mocks.applySAMLReleaseApproval).toHaveBeenCalledWith(
      beforeRelease(),
      [RELEASE_APPROVE_ALL],
      NAMEID_FORMATS.EMAIL
    );
    expect(
      (body.after_consent as { optional_missing_attributes: string[] }).optional_missing_attributes
    ).toEqual(['displayName']);
  });

  describe('NameID resolution', () => {
    it('should release the mapped NameID when the mapping provides one', async () => {
      mocks.resolveSAMLMappedNameID.mockResolvedValue(async () => ({ value: 'mapped-id' }));
      mocks.resolveEffectiveSAMLNameIDFormat.mockReturnValue(NAMEID_FORMATS.PERSISTENT);
      const { body } = await explainSAMLReleaseFixture(request());
      expect(mocks.resolveEffectiveSAMLNameIDFormat).toHaveBeenCalledWith({
        spConfig: spConfig(),
        mappedNameID: true,
      });
      expect((body.after_consent as { nameid: object }).nameid).toEqual({
        format: NAMEID_FORMATS.PERSISTENT,
        status: 'released',
        value: 'mapped-id',
      });
      expect(mocks.resolveSAMLNameIDValue).not.toHaveBeenCalled();
    });

    it.each([NAMEID_FORMATS.PERSISTENT, NAMEID_FORMATS.TRANSIENT])(
      'should suppress an unmapped %s NameID for a test user and mark the release failed',
      async (format) => {
        mocks.resolveEffectiveSAMLNameIDFormat.mockReturnValue(format);
        const { body } = await explainSAMLReleaseFixture(request());
        const after = body.after_consent as {
          status: string;
          attributes: unknown[];
          nameid: object;
        };
        expect(after.nameid).toEqual({
          format,
          status: 'suppressed',
          reasons: ['test_user_identifier_not_evaluated'],
        });
        expect(after.status).toBe('failed');
        expect(after.attributes).toEqual([]);
      }
    );

    it('should resolve an e-mail NameID from the user info', async () => {
      await explainSAMLReleaseFixture(request());
      expect(mocks.resolveSAMLNameIDValue).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1', email: 'alice@example.test' }),
        NAMEID_FORMATS.EMAIL
      );
    });

    it('should classify a mapping error with a suppression reason as suppressed', async () => {
      mocks.resolveSAMLMappedNameID.mockResolvedValue(async () => {
        throw new SAMLIdentityMappingRuntimeError([
          { code: 'value_suppressed' } as never,
          { code: 'other' } as never,
        ]);
      });
      const { body } = await explainSAMLReleaseFixture(request());
      expect((body.after_consent as { nameid: object }).nameid).toEqual({
        format: NAMEID_FORMATS.EMAIL,
        status: 'suppressed',
        reasons: ['value_suppressed', 'other'],
      });
    });

    it('should classify a mapping error without a suppression reason as failed', async () => {
      mocks.resolveSAMLMappedNameID.mockResolvedValue(async () => {
        throw new SAMLIdentityMappingRuntimeError([{ code: 'source_unavailable' } as never]);
      });
      const { body } = await explainSAMLReleaseFixture(request());
      expect((body.after_consent as { nameid: object }).nameid).toEqual({
        format: NAMEID_FORMATS.EMAIL,
        status: 'failed',
        reasons: ['source_unavailable'],
      });
    });

    it('should report nameid_unavailable for any other NameID error', async () => {
      mocks.resolveSAMLNameIDValue.mockRejectedValue(new Error('no email'));
      const { body } = await explainSAMLReleaseFixture(request());
      expect((body.after_consent as { nameid: object }).nameid).toEqual({
        format: NAMEID_FORMATS.EMAIL,
        status: 'failed',
        reasons: ['nameid_unavailable'],
      });
    });
  });

  describe('release failures after consent', () => {
    it('should report the missing required fields when the approval cannot release', async () => {
      mocks.applySAMLReleaseApproval.mockReturnValue({ ok: false, missing: ['mail'] });
      const { body } = await explainSAMLReleaseFixture(request());
      expect(body.after_consent).toEqual({
        status: 'failed',
        attributes: [],
        nameid: { format: NAMEID_FORMATS.EMAIL, status: 'released', value: 'alice@example.test' },
        error: { code: 'required_field_missing', fields: ['mail'] },
        optional_missing_attributes: [],
        identifier_evaluation: 'suppressed_for_test_user',
      });
    });

    it('should classify a missing required attribute while making identifiers', async () => {
      mocks.computeSAMLAttributeRelease.mockImplementation(
        async (input: { identifiers: string }) => {
          if (input.identifiers === 'made')
            throw new MissingRequiredSAMLAttributeError([
              { name: 'uid' } as never,
              { name: 'mail' } as never,
            ]);
          return beforeRelease();
        }
      );
      const { body } = await explainSAMLReleaseFixture(request());
      expect(body.before_consent).toMatchObject({ items: ITEMS });
      expect(body.after_consent).toEqual({
        status: 'failed',
        attributes: [],
        nameid: { format: NAMEID_FORMATS.EMAIL, status: 'released', value: 'alice@example.test' },
        error: { code: 'required_field_missing', fields: ['uid', 'mail'] },
      });
    });
  });

  describe('release failures before consent', () => {
    const expectStopped = (
      body: Record<string, unknown>,
      error: object,
      format: string = NAMEID_FORMATS.EMAIL
    ) => {
      expect(body.before_consent).toEqual({ status: 'failed', items: [], error });
      expect(body.after_consent).toEqual({
        status: 'failed',
        attributes: [],
        nameid: { format, status: 'failed', reasons: ['release_stopped'] },
        error,
      });
    };

    it('should classify a destination profile validation error with its field', async () => {
      mocks.computeSAMLAttributeRelease.mockRejectedValue(
        new DestinationProfileReleaseValidationError('bad', 'invalid_field_value', 'mail')
      );
      const { body, status } = await explainSAMLReleaseFixture(request());
      expect(status).toBe(200);
      expectStopped(body, { code: 'invalid_field_value', fields: ['mail'] });
      expect(body.fields).toEqual([
        { field: 'mail', policy: 'optional' },
        { field: 'displayName', policy: 'optional' },
      ]);
    });

    it('should classify a destination profile validation error without a field', async () => {
      mocks.resolveSAMLMappedNameID.mockRejectedValue(
        new DestinationProfileReleaseValidationError('gone', 'destination_profile_unavailable')
      );
      const { body } = await explainSAMLReleaseFixture(request());
      expectStopped(body, { code: 'destination_profile_unavailable', fields: [] });
    });

    it('should classify a mapping runtime error with its reason codes', async () => {
      mocks.resolveSAMLRuntimeIdentityMapping.mockRejectedValue(
        new SAMLIdentityMappingRuntimeError([{ code: 'a' } as never, { code: 'b' } as never])
      );
      const { body } = await explainSAMLReleaseFixture(request());
      expectStopped(body, { code: 'mapping_failed', reasons: ['a', 'b'] });
      expect(body.fields).toEqual([]); // failed before the fields were resolved
    });

    it('should classify a missing required attribute during the deferred release', async () => {
      mocks.computeSAMLAttributeRelease.mockRejectedValue(
        new MissingRequiredSAMLAttributeError([{ name: 'uid' } as never])
      );
      const { body } = await explainSAMLReleaseFixture(request());
      expectStopped(body, { code: 'required_field_missing', fields: ['uid'] });
    });

    it('should fall back to release_failed and the configured format for unknown errors', async () => {
      mocks.getSPConfig.mockResolvedValue(spConfig({ nameIdFormat: NAMEID_FORMATS.PERSISTENT }));
      mocks.resolveSAMLRuntimeIdentityMapping.mockRejectedValue(new Error('boom'));
      const { body } = await explainSAMLReleaseFixture(request());
      expectStopped(body, { code: 'release_failed' }, NAMEID_FORMATS.PERSISTENT);
    });

    it('should default the NameID format to emailAddress when the SP has none and the mapping fails early', async () => {
      mocks.getSPConfig.mockResolvedValue(spConfig({ nameIdFormat: undefined }));
      mocks.resolveSAMLRuntimeIdentityMapping.mockRejectedValue(new Error('boom'));
      const { body } = await explainSAMLReleaseFixture(request());
      expect((body.after_consent as { nameid: { format: string } }).nameid.format).toBe(
        NAMEID_FORMATS.EMAIL
      );
    });
  });
});

describe('validateSAMLSPReleaseBinding', () => {
  it('should delegate to the provider mapping validation', async () => {
    mocks.validateSAMLSPMappingConfig.mockResolvedValue({ field: 'identityMapping.setId' });
    const config = spConfig();
    expect(await validateSAMLSPReleaseBinding(env, 'tenant-a', config)).toEqual({
      field: 'identityMapping.setId',
    });
    expect(mocks.validateSAMLSPMappingConfig).toHaveBeenCalledWith(env, 'tenant-a', config);
  });
});
