import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  settingsError: null as Error | null,
  reads: 0,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveEffectiveSettings: vi.fn(async () => {
      mocks.reads += 1;
      if (mocks.settingsError) throw mocks.settingsError;
      return mocks.settings;
    }),
  };
});

import {
  MissingRequiredSAMLAttributeError,
  type SAMLAttributeSubject,
  type SAMLIdentityMappingAttributeDescriptor,
  type SAMLIdentityMappingFieldMappingBinding,
} from '../attributes';
import {
  loadSAMLInstitutionRelease,
  releaseSAMLAttributesWithInstitution,
  withSAMLInstitutionAttributes,
} from '../institution-release';

const env = {} as Env;
const noError = () => {
  throw new Error('no error expected');
};

beforeEach(() => {
  mocks.settings = {
    'institution.scopes': 'example.ac.jp,med.example.ac.jp',
    'institution.display_names': JSON.stringify({ ja: '例大学', en: 'Example University' }),
  };
  mocks.settingsError = null;
  mocks.reads = 0;
});

describe('loadSAMLInstitutionRelease', () => {
  it('reads the scopes, the default scope and the English name', async () => {
    const release = await loadSAMLInstitutionRelease(env, 'tenant-a', noError);

    expect(mocks.reads).toBe(1);
    expect(release).toEqual({
      scopePolicy: {
        state: 'set',
        scopes: ['example.ac.jp', 'med.example.ac.jp'],
        defaultScope: 'example.ac.jp',
      },
      homeOrganization: 'example.ac.jp',
      organizationName: 'Example University',
      registeredNames: ['例大学', 'Example University'],
    });
  });

  it('leaves the name out when the saved names are not valid (English is required)', async () => {
    mocks.settings = {
      'institution.display_names': JSON.stringify({ ja: '例大学', de: 'Beispiel-Universität' }),
    };

    expect((await loadSAMLInstitutionRelease(env, 'tenant-a', noError)).organizationName).toBe(
      undefined
    );
  });

  it('says it cannot tell, and tells the caller why, when the settings cannot be read', async () => {
    mocks.settingsError = new Error('kv down');
    const onError = vi.fn();

    expect(await loadSAMLInstitutionRelease(env, 'tenant-a', onError)).toEqual({
      scopePolicy: { state: 'unavailable' },
    });
    expect(onError).toHaveBeenCalledWith(
      'Failed to read the tenant institution settings',
      mocks.settingsError
    );
  });

  it('does not read saved names that are not valid as no names, with or without scopes', async () => {
    mocks.settings = { 'institution.display_names': 'broken' };
    expect((await loadSAMLInstitutionRelease(env, 'tenant-a', noError)).scopePolicy).toEqual({
      state: 'names_invalid',
    });
    mocks.settings = {
      'institution.scopes': 'example.ac.jp',
      'institution.display_names': 'broken',
    };
    expect((await loadSAMLInstitutionRelease(env, 'tenant-a', noError)).scopePolicy).toEqual({
      state: 'names_invalid',
    });
    // Invalid scopes are the more specific answer.
    mocks.settings = { 'institution.scopes': '*.example', 'institution.display_names': 'broken' };
    expect((await loadSAMLInstitutionRelease(env, 'tenant-a', noError)).scopePolicy).toEqual({
      state: 'invalid',
    });
  });

  it('has nothing to release about the institution of a tenant that registered none', async () => {
    mocks.settings = {};

    expect(await loadSAMLInstitutionRelease(env, 'tenant-a', noError)).toEqual({
      scopePolicy: { state: 'unset' },
    });
  });
});

describe('withSAMLInstitutionAttributes', () => {
  const institution = {
    scopePolicy: { state: 'unset' as const },
    homeOrganization: 'example.ac.jp',
    organizationName: 'Example University',
  };
  const subject = { id: 'user-a', email: 'user@example.test' };

  it('adds the home organization and the name the tenant set', () => {
    expect(withSAMLInstitutionAttributes(subject, institution)).toEqual({
      ...subject,
      schac_home_organization: 'example.ac.jp',
      organization_name: 'Example University',
    });
    expect(withSAMLInstitutionAttributes(subject, { scopePolicy: { state: 'unset' } })).toEqual(
      subject
    );
  });

  it('replaces what the subject carried under those names, and drops it when none is released', () => {
    const carried = {
      ...subject,
      schac_home_organization: 'rival.example',
      organization_name: 'Rival University',
    };

    expect(withSAMLInstitutionAttributes(carried, institution)).toEqual({
      ...subject,
      schac_home_organization: 'example.ac.jp',
      organization_name: 'Example University',
    });
    expect(withSAMLInstitutionAttributes(carried, { scopePolicy: { state: 'unset' } })).toEqual(
      subject
    );
  });
});

describe('releaseSAMLAttributesWithInstitution', () => {
  const OID_EPPN = 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6';
  const OID_EPSA = 'urn:oid:1.3.6.1.4.1.5923.1.1.1.9';
  const OID_MAIL = 'urn:oid:0.9.2342.19200300.100.1.3';
  const subject: SAMLAttributeSubject = {
    id: 'user-a',
    customClaims: {
      principal: 'alice@rival.example',
      affiliation: 'member@rival.example',
      eduPersonPrincipalName: 'carol@rival.example',
      mail: 'bob@gmail.example',
    },
  };
  const entry = (path: string) => ({
    id: `field.custom.${path}`,
    namespace: 'authrim.custom_claims',
    path,
    valueType: 'string',
    cardinality: 'single' as const,
    classification: 'internal' as const,
    targetType: 'custom' as const,
  });
  const source = (path: string) => ({
    side: 'source' as const,
    namespace: 'authrim.custom_claims',
    path,
  });
  const target = (path: string, catalogEntryId?: string) => ({
    side: 'destination' as const,
    namespace: 'saml.attribute',
    path,
    ...(catalogEntryId ? { catalogEntryId } : {}),
  });
  const edge = (id: string, from: string, to: ReturnType<typeof target>) => ({
    id,
    sourceRef: source(from),
    targetRef: to,
    edgeKind: 'direct',
  });

  const destinations = (parts: { edges: object[]; transforms?: object[] }) =>
    [
      ...parts.edges.map((e) => (e as { targetRef: ReturnType<typeof target> }).targetRef),
      ...(parts.transforms ?? []).map(
        (t) => (t as { outputTargetRef: ReturnType<typeof target> }).outputTargetRef
      ),
    ].map((ref) => ({
      id: ref.catalogEntryId ?? `dest.${ref.path}`,
      namespace: ref.namespace,
      path: ref.path,
      valueType: 'string',
      cardinality: 'multi' as const,
      classification: 'internal' as const,
      targetType: 'destination-only' as const,
    }));

  /** A mapping set as a deployed tenant has it, with the pieces a case needs. */
  function release(
    parts: {
      edges: object[];
      transforms?: object[];
      descriptors?: Record<string, SAMLIdentityMappingAttributeDescriptor>;
      policies?: Record<string, 'required' | 'optional' | 'hidden'>;
    },
    onError: (message: string, error: unknown) => void = noError
  ) {
    const identityMapping = {
      catalog: {
        identity: { id: 'c', version: '1', contentHash: 'c', compatibilityRange: '*' },
        entries: [
          ...['principal', 'affiliation', 'eduPersonPrincipalName', 'mail'].map(entry),
          // A value reaches a destination only when the catalog has an entry for it.
          ...destinations(parts),
        ],
      },
      edges: parts.edges,
      transforms: parts.transforms ?? [],
      attributeDescriptors: parts.descriptors,
      destinationFieldPolicies: parts.policies,
    } as unknown as SAMLIdentityMappingFieldMappingBinding;
    return releaseSAMLAttributesWithInstitution({
      env,
      tenantId: 'tenant-a',
      subject,
      releaseConfig: {
        entityId: 'https://sp.example.test',
        tenantId: 'tenant-a',
        localEntityId: 'https://idp.example.test',
        attributeMapping: {},
        identityMapping,
      },
      onError,
    });
  }
  const released = async (parts: Parameters<typeof release>[0]) =>
    Object.fromEntries(
      (await release(parts)).attributes.map((attribute) => [attribute.name, attribute.values])
    );

  it('applies the scopes to a principal name a transform makes, as to one an edge makes', async () => {
    // The edge brings the value to a field that is not scoped; the transform copies it to the
    // standard eduPersonPrincipalName, which no edge names.
    const parts = {
      edges: [edge('e1', 'principal', target('urn:oid:example:intermediate'))],
      transforms: [
        {
          id: 't1',
          inputEdgeIds: ['e1'],
          operation: 'copy',
          outputTargetRef: target(OID_EPPN),
        },
      ],
    };

    const attributes = await released(parts);

    expect(mocks.reads).toBe(1);
    expect(attributes[OID_EPPN]).toBeUndefined();
    // The edge's own field is not scoped, and goes as it is.
    expect(attributes['urn:oid:example:intermediate']).toEqual(['alice@rival.example']);
    const result = await release(parts);
    expect(result.withheldScopedValues).toEqual([
      expect.objectContaining({
        attribute: 'eduPersonPrincipalName',
        name: OID_EPPN,
        reason: 'scope_not_registered',
        scope: 'rival.example',
      }),
    ]);
  });

  it.each([
    ['a short name', target('eppn'), undefined],
    ['an OID without urn:oid:', target('1.3.6.1.4.1.5923.1.1.1.6'), undefined],
    [
      'a catalog entry that says it is the principal name, released as uid',
      target('uid', 'target.eduPersonPrincipalName'),
      undefined,
    ],
    [
      'a name set on the destination field that says nothing',
      target('urn:oid:example:opaque', 'target.opaque'),
      { 'target.opaque': { name: 'uid', friendlyName: 'eduPersonPrincipalName' } },
    ],
  ])('applies the scopes to a principal name released as %s', async (_name, to, descriptors) => {
    const attributes = await released({ edges: [edge('e1', 'principal', to)], descriptors });

    expect(mocks.reads).toBe(1);
    expect(JSON.stringify(attributes)).not.toContain('rival.example');
  });

  it('applies the scopes to a value read from a field that is a principal name, whatever it is released as', async () => {
    const attributes = await released({
      edges: [edge('e1', 'eduPersonPrincipalName', target('uid'))],
    });

    expect(mocks.reads).toBe(1);
    expect(attributes).toEqual({});
  });

  it('does the same for the scoped affiliation under another name', async () => {
    const attributes = await released({
      edges: [edge('e1', 'affiliation', target('epsa'))],
    });

    expect(mocks.reads).toBe(1);
    expect(attributes).toEqual({});
  });

  it('gives the default scope to a value with no scope, however the attribute is named', async () => {
    mocks.settings = { 'institution.scopes': 'example.ac.jp' };
    const result = await release({ edges: [edge('e1', 'principal', target('eppn'))] });
    expect(result.attributes).toEqual([]);

    const bare = await releaseSAMLAttributesWithInstitution({
      env,
      tenantId: 'tenant-a',
      subject: { id: 'u', customClaims: { principal: 'alice' } },
      releaseConfig: {
        entityId: 'https://sp.example.test',
        attributeMapping: {},
        identityMapping: {
          catalog: {
            identity: { id: 'c', version: '1', contentHash: 'c', compatibilityRange: '*' },
            entries: [
              entry('principal'),
              ...destinations({ edges: [edge('e1', 'principal', target('eppn'))] }),
            ],
          },
          edges: [edge('e1', 'principal', target('eppn'))],
        } as never,
      },
      onError: noError,
    });
    expect(bare.attributes).toEqual([
      expect.objectContaining({ name: 'eppn', values: ['alice@example.ac.jp'] }),
    ]);
  });

  it('reads the settings once, and leaves every value alone, for a mapping that releases no scoped attribute', async () => {
    const attributes = await released({
      edges: [edge('e1', 'mail', target(OID_MAIL)), edge('e2', 'mail', target('urn:oid:other'))],
    });

    expect(mocks.reads).toBe(1);
    expect(attributes).toEqual({
      [OID_MAIL]: ['bob@gmail.example'],
      'urn:oid:other': ['bob@gmail.example'],
    });
  });

  it('withholds the scoped values, and tells the caller, when the settings cannot be read', async () => {
    mocks.settingsError = new Error('kv down');
    const onError = vi.fn();

    const result = await release(
      { edges: [edge('e1', 'principal', target('eppn')), edge('e2', 'mail', target(OID_MAIL))] },
      onError
    );

    expect(result.attributes.map((attribute) => attribute.name)).toEqual([OID_MAIL]);
    expect(result.withheldScopedValues).toEqual([
      expect.objectContaining({ reason: 'institution_settings_unavailable' }),
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('does not touch the scopes of a tenant that registered none', async () => {
    mocks.settings = {};
    const attributes = await released({
      edges: [edge('e1', 'principal', target('eppn')), edge('e2', 'affiliation', target(OID_EPSA))],
    });

    expect(attributes).toEqual({
      eppn: ['alice@rival.example'],
      [OID_EPSA]: ['member@rival.example'],
    });
  });

  const systemEdge = (
    id: string,
    path: string,
    catalogEntryId: string,
    to: ReturnType<typeof target>
  ) => ({
    id,
    sourceRef: { side: 'source' as const, namespace: 'authrim.profile', path, catalogEntryId },
    targetRef: to,
    edgeKind: 'direct',
  });
  const copy = (id: string, from: string, to: ReturnType<typeof target>) => ({
    id,
    inputEdgeIds: [from],
    operation: 'copy',
    outputTargetRef: to,
  });

  it('knows a principal name that goes through a hidden intermediate field and a copy, and releases it as another name', async () => {
    const parts = {
      edges: [edge('e1', 'eduPersonPrincipalName', target('urn:oid:example:tmp'))],
      transforms: [copy('t1', 'e1', target('uid'))],
      policies: { 'urn:oid:example:tmp': 'hidden' as const },
    };

    const result = await release(parts);

    expect(result.attributes).toEqual([]);
    expect(result.withheldScopedValues).toEqual([
      expect.objectContaining({
        name: 'uid',
        reason: 'scope_not_registered',
        scope: 'rival.example',
      }),
    ]);
  });

  it('does not take a public field for a principal name because a hidden one of another namespace has its name', async () => {
    // The principal name passes through a field called mail in the custom claims; the mail that is
    // released is the person's email, in the SAML attributes.
    const parts = {
      edges: [
        edge('e1', 'eduPersonPrincipalName', {
          side: 'destination' as const,
          namespace: 'authrim.custom_claims',
          path: 'mail',
        }),
        edge('e2', 'mail', target('mail')),
      ],
      transforms: [copy('t1', 'e1', target('uid'))],
      policies: { mail: 'required' as const },
    };

    const result = await release(parts);

    // The email stays; what came from the principal name is checked, as it always was.
    expect(result.attributes).toEqual([
      expect.objectContaining({ name: 'mail', values: ['bob@gmail.example'] }),
    ]);
    expect(result.withheldScopedValues).toEqual([
      expect.objectContaining({ name: 'uid', reason: 'scope_not_registered' }),
    ]);
  });

  describe('the attributes that name the institution', () => {
    const OID_SCHAC = 'urn:oid:1.3.6.1.4.1.25178.1.2.9';
    const OID_O = 'urn:oid:2.5.4.10';
    const OID_EPPN_HERE = 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6';
    const withSubject = (claims: Record<string, string>) => {
      subject.customClaims = { ...subject.customClaims, ...claims };
    };

    it('does not let a tenant administrator name another institution from the person’s own data', async () => {
      withSubject({ homeDomain: 'rival.example', orgName: 'Rival University' });
      const parts = {
        edges: [
          edge('e1', 'homeDomain', target(OID_SCHAC)),
          edge('e2', 'orgName', target(OID_O)),
          edge('e3', 'mail', target(OID_MAIL)),
        ],
      };

      const result = await release(parts);

      expect(result.attributes.map((attribute) => attribute.name)).toEqual([OID_MAIL]);
      expect(result.withheldScopedValues).toEqual([
        expect.objectContaining({
          attribute: 'schacHomeOrganization',
          reason: 'organization_not_registered',
          scope: 'rival.example',
        }),
        expect.objectContaining({
          attribute: 'organizationName',
          reason: 'organization_not_registered',
        }),
      ]);
      expect(JSON.stringify(result)).not.toContain('Rival');
    });

    it('withholds them, and the scoped values, when only invalid names are saved', async () => {
      mocks.settings = { 'institution.display_names': 'broken' };
      withSubject({ homeDomain: 'rival.example', orgName: 'Rival University' });
      const result = await release({
        edges: [
          edge('e1', 'homeDomain', target(OID_SCHAC)),
          edge('e2', 'orgName', target(OID_O)),
          edge('e3', 'principal', target(OID_EPPN_HERE)),
          edge('e4', 'mail', target(OID_MAIL)),
        ],
      });

      expect(result.attributes.map((attribute) => attribute.name)).toEqual([OID_MAIL]);
      expect(result.withheldScopedValues?.map((entry) => entry.reason)).toEqual([
        'institution_names_invalid',
        'institution_names_invalid',
        'institution_names_invalid',
      ]);
    });

    it('holds a value released under the URN name of o, with no friendly name', async () => {
      withSubject({ orgName: 'Rival University' });
      const result = await release({
        edges: [edge('e1', 'orgName', target('urn:mace:dir:attribute-def:o'))],
      });

      expect(result.attributes).toEqual([]);
    });

    it('lets a person’s own value through when it is the registered one', async () => {
      withSubject({ homeDomain: 'med.example.ac.jp', orgName: '例大学' });
      const attributes = await released({
        edges: [edge('e1', 'homeDomain', target(OID_SCHAC)), edge('e2', 'orgName', target(OID_O))],
      });

      expect(attributes).toEqual({ [OID_SCHAC]: ['med.example.ac.jp'], [OID_O]: ['例大学'] });
    });

    it('holds a value that reaches them through a hidden intermediate field and a copy', async () => {
      withSubject({ homeDomain: 'rival.example' });
      const parts = {
        edges: [edge('e1', 'homeDomain', target('urn:oid:example:tmp'))],
        transforms: [copy('t1', 'e1', target('schacHomeOrganization'))],
        policies: { 'urn:oid:example:tmp': 'hidden' as const },
      };

      expect((await release(parts)).attributes).toEqual([]);
    });

    it('holds a value read from a field called schac_home_organization, released as another name', async () => {
      withSubject({ schac_home_organization: 'rival.example' });
      const result = await release({
        edges: [edge('e1', 'schac_home_organization', target('homeDomain'))],
      });

      expect(result.attributes).toEqual([]);
    });

    it('passes the values of the system sources, which are the registered ones', async () => {
      const parts = {
        edges: [
          systemEdge(
            'e1',
            'schac_home_organization',
            'system.identity.schac_home_organization',
            target(OID_SCHAC)
          ),
          systemEdge('e2', 'organization_name', 'system.identity.organization_name', target(OID_O)),
        ],
      };
      const result = await releaseSAMLAttributesWithInstitution({
        env,
        tenantId: 'tenant-a',
        subject: { id: 'u' },
        releaseConfig: {
          entityId: 'https://sp.example.test',
          attributeMapping: {},
          identityMapping: {
            catalog: {
              identity: { id: 'c', version: '1', contentHash: 'c', compatibilityRange: '*' },
              entries: destinations(parts),
            },
            edges: parts.edges,
          } as never,
        },
        onError: noError,
      });

      expect(Object.fromEntries(result.attributes.map((a) => [a.name, a.values]))).toEqual({
        [OID_SCHAC]: ['example.ac.jp'],
        [OID_O]: ['Example University'],
      });
      expect(result.withheldScopedValues).toBeUndefined();
    });

    it('does not take other attributes for them by a part of their name', async () => {
      withSubject({ dept: 'Rival Department' });
      const attributes = await released({
        edges: [edge('e1', 'dept', target('ou')), edge('e2', 'dept', target('urn:oid:2.5.4.100'))],
      });

      expect(attributes).toEqual({
        ou: ['Rival Department'],
        'urn:oid:2.5.4.100': ['Rival Department'],
      });
    });

    it('withholds them when the settings cannot be read, and for a tenant that registered nothing', async () => {
      withSubject({ homeDomain: 'rival.example' });
      const parts = { edges: [edge('e1', 'homeDomain', target(OID_SCHAC))] };

      mocks.settingsError = new Error('kv down');
      const unavailable = await release(parts, () => undefined);
      expect(unavailable.attributes).toEqual([]);
      expect(unavailable.withheldScopedValues).toEqual([
        expect.objectContaining({ reason: 'institution_settings_unavailable' }),
      ]);

      mocks.settingsError = null;
      mocks.settings = {};
      const unregistered = await release(parts, () => undefined);
      expect(unregistered.attributes).toEqual([]);
      expect(unregistered.withheldScopedValues).toEqual([
        expect.objectContaining({
          attribute: 'schacHomeOrganization',
          reason: 'institution_not_registered',
        }),
      ]);
      expect(JSON.stringify(unregistered.withheldScopedValues)).not.toContain('rival');
    });
  });

  it('releases the organization name through a hidden intermediate field and a copy, to a service provider that requires it', async () => {
    const parts = {
      edges: [
        systemEdge(
          'e1',
          'organization_name',
          'system.identity.organization_name',
          target('urn:oid:example:tmp')
        ),
      ],
      transforms: [copy('t1', 'e1', target('urn:oid:2.5.4.10'))],
      policies: {
        'urn:oid:example:tmp': 'hidden' as const,
        'urn:oid:2.5.4.10': 'required' as const,
      },
    };

    expect(await released(parts)).toEqual({ 'urn:oid:2.5.4.10': ['Example University'] });
  });

  it('is not misled by an OID that continues the ones it knows', async () => {
    const attributes = await released({
      edges: [
        edge('e1', 'principal', target('urn:oid:1.3.6.1.4.1.5923.1.1.1.6.1')),
        edge('e2', 'affiliation', target('urn:oid:1.3.6.1.4.1.5923.1.1.1.9.4')),
      ],
    });

    expect(attributes).toEqual({
      'urn:oid:1.3.6.1.4.1.5923.1.1.1.6.1': ['alice@rival.example'],
      'urn:oid:1.3.6.1.4.1.5923.1.1.1.9.4': ['member@rival.example'],
    });
  });

  it('reports a missing required attribute and a withheld scoped value together', async () => {
    const parts = {
      edges: [edge('e1', 'absent', target(OID_MAIL)), edge('e2', 'principal', target(OID_EPPN))],
      policies: { [OID_MAIL]: 'required' as const, [OID_EPPN]: 'required' as const },
    };

    const error = await release(parts).then(
      () => null,
      (e: unknown) => e as MissingRequiredSAMLAttributeError
    );

    expect(error).toBeInstanceOf(MissingRequiredSAMLAttributeError);
    expect(error!.missingAttributes.map((attribute) => attribute.name).sort()).toEqual(
      [OID_EPPN, OID_MAIL].sort()
    );
    expect(error!.withheldScopedValues).toEqual([
      expect.objectContaining({ name: OID_EPPN, reason: 'scope_not_registered' }),
    ]);
  });

  it('releases a tenant that registered nothing exactly as it was, reading the settings once', async () => {
    mocks.settings = {};
    const result = await release({
      edges: [edge('e1', 'principal', target(OID_EPPN)), edge('e2', 'mail', target(OID_MAIL))],
    });

    expect(mocks.reads).toBe(1);
    expect(result).toEqual({
      attributes: [
        expect.objectContaining({ name: OID_EPPN, values: ['alice@rival.example'] }),
        expect.objectContaining({ name: OID_MAIL, values: ['bob@gmail.example'] }),
      ],
      optionalMissingAttributes: [],
    });
  });
});
