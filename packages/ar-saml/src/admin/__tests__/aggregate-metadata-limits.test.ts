/**
 * Aggregate (federation) metadata: structural limits, summary edge cases, policy resolution and
 * the helper exports that the signed-aggregate tests do not reach.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isAggregateMetadata,
  parseAggregateMetadata,
  unwrapSingleEntityMetadata,
  extractEntityDescriptorXml,
  extractEntityDescriptorXmls,
  resolveAggregateSignaturePolicy,
  verifyAggregateMetadata,
  fingerprintCertificateSha256,
  getLogoUrl,
} from '../aggregate-metadata';
import { SAMLMetadataValidationError } from '../errors';
import { parseXml } from '../../common/xml-utils';
import { RSA_2048_SHA256_PEM } from '../__fixtures__/certificates';
import type { Env, SAMLFederationTrustProfile } from '@authrim/ar-lib-core';

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const MDUI = 'urn:oasis:names:tc:SAML:metadata:ui';
const MDRPI = 'urn:oasis:names:tc:SAML:metadata:rpi';

const entity = (
  id: string,
  body = '<md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"/>'
) => `<md:EntityDescriptor entityID="${id}">${body}</md:EntityDescriptor>`;
const aggregate = (children: string, attrs = ' ID="_root"') =>
  `<md:EntitiesDescriptor xmlns:md="${MD}" xmlns:ds="${DS}" xmlns:mdui="${MDUI}" xmlns:mdrpi="${MDRPI}"${attrs}>${children}</md:EntitiesDescriptor>`;

const expectValidationError = (fn: () => unknown, message: string) => {
  expect(fn).toThrow(SAMLMetadataValidationError);
  expect(fn).toThrow(new SAMLMetadataValidationError(message));
};

describe('isAggregateMetadata', () => {
  it('should detect an EntitiesDescriptor root and reject other roots', () => {
    expect(isAggregateMetadata(aggregate(entity('https://a')))).toBe(true);
    expect(
      isAggregateMetadata(`<md:EntityDescriptor xmlns:md="${MD}" entityID="https://a"/>`)
    ).toBe(false);
    expect(isAggregateMetadata(`<EntitiesDescriptor xmlns="urn:other"/>`)).toBe(false);
  });

  it.each([
    [
      'a DOCTYPE',
      `<!DOCTYPE md [<!ENTITY x "y">]>${aggregate(entity('https://a'))}`,
      'XML security error: DOCTYPE declarations are not allowed',
    ],
    [
      'a processing instruction',
      `<?xml-stylesheet href="x"?>${aggregate(entity('https://a'))}`,
      'SAML metadata processing instructions are not allowed',
    ],
    [
      'excessive depth',
      aggregate('<a>'.repeat(64) + '</a>'.repeat(64)),
      'SAML metadata exceeds maximum depth',
    ],
    [
      'malformed XML',
      `<md:EntitiesDescriptor xmlns:md="${MD}"><md:EntityDescriptor>`,
      'Invalid aggregate metadata: ',
    ],
  ])('should reject %s', (_label, xml, message) => {
    expect(() => isAggregateMetadata(xml)).toThrow(SAMLMetadataValidationError);
    expect(() => isAggregateMetadata(xml)).toThrow(message);
  });

  it('should reject documents above the size limit before parsing', () => {
    const huge = 'x'.repeat(10 * 1024 * 1024 + 1);
    expectValidationError(
      () => isAggregateMetadata(huge),
      'Aggregate metadata exceeds maximum size'
    );
  });

  it('should count multi-byte characters by their UTF-8 size', () => {
    // 3.5M three-byte characters = 10.5 MB > 10 MiB
    const xml = aggregate(
      `<md:EntityDescriptor entityID="https://a"><a>${'あ'.repeat(3_500_000)}</a></md:EntityDescriptor>`
    );
    expectValidationError(
      () => isAggregateMetadata(xml),
      'Aggregate metadata exceeds maximum size'
    );
  });

  it('should reject more than 100000 elements', () => {
    const xml = aggregate(entity('https://a', '<a/>'.repeat(100_000)));
    expectValidationError(
      () => isAggregateMetadata(xml),
      'SAML metadata exceeds maximum element count'
    );
  });

  it('should reject more than 200000 attributes', () => {
    const attrs = Array.from({ length: 101 }, (_, i) => `a${i}="v"`).join(' ');
    const xml = aggregate(entity('https://a', `<a ${attrs}/>`.repeat(2000)));
    expectValidationError(
      () => isAggregateMetadata(xml),
      'SAML metadata exceeds maximum attribute count'
    );
  });
});

describe('parseAggregateMetadata structure checks', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    [
      'the root is not an EntitiesDescriptor',
      `<md:EntityDescriptor xmlns:md="${MD}" ID="_r" entityID="https://a"/>`,
      'Invalid aggregate metadata: missing EntitiesDescriptor',
    ],
    [
      'the root has no ID',
      aggregate(entity('https://a'), ''),
      'Invalid aggregate metadata: missing root ID',
    ],
    [
      'there are no entities',
      aggregate('<md:EntitiesDescriptor Name="empty"/>'),
      'Invalid aggregate metadata: no EntityDescriptor entries',
    ],
    [
      'an EntityDescriptor is nested in another',
      aggregate(
        `<md:EntityDescriptor entityID="https://a">${entity('https://b')}</md:EntityDescriptor>`
      ),
      'Invalid aggregate metadata: nested EntityDescriptor',
    ],
    [
      'the root carries two signatures',
      aggregate(`<ds:Signature/><ds:Signature/>${entity('https://a')}`),
      'Invalid aggregate metadata: multiple root signatures',
    ],
    [
      'an entity has an empty entityID',
      aggregate(entity('')),
      'Invalid aggregate metadata: entityID values must be present and unique',
    ],
    [
      'a nested EntitiesDescriptor validUntil is malformed',
      aggregate(
        `<md:EntitiesDescriptor validUntil="soon">${entity('https://a')}</md:EntitiesDescriptor>`
      ),
      'Invalid aggregate metadata: invalid validUntil',
    ],
    [
      'an EntityDescriptor validUntil is expired',
      aggregate(`<md:EntityDescriptor entityID="https://a" validUntil="2000-01-01T00:00:00Z"/>`),
      'Invalid aggregate metadata: expired validUntil',
    ],
    [
      'an entity has two RegistrationInfo elements',
      aggregate(
        entity(
          'https://a',
          `<md:Extensions><mdrpi:RegistrationInfo registrationAuthority="x"/><mdrpi:RegistrationInfo registrationAuthority="y"/></md:Extensions>`
        )
      ),
      'Invalid aggregate metadata: multiple mdrpi RegistrationInfo elements',
    ],
  ])('should reject an aggregate where %s', (_label, xml, message) => {
    expectValidationError(() => parseAggregateMetadata(xml), message);
  });

  it('should reject more than 10000 entities', () => {
    const xml = aggregate(
      Array.from(
        { length: 10_001 },
        (_, i) => `<md:EntityDescriptor entityID="https://e${i}"/>`
      ).join('')
    );
    expectValidationError(
      () => parseAggregateMetadata(xml),
      'Aggregate metadata exceeds maximum entity count'
    );
  });

  it('should reject a root signature with too many elements', () => {
    const signature = `<ds:Signature>${'<ds:X/>'.repeat(512)}</ds:Signature>`;
    expectValidationError(
      () => parseAggregateMetadata(aggregate(signature + entity('https://a'))),
      'Aggregate signature exceeds maximum element count'
    );
  });

  it('should reject a root signature with too many attributes', () => {
    const attrs = Array.from({ length: 1025 }, (_, i) => `a${i}="v"`).join(' ');
    expectValidationError(
      () => parseAggregateMetadata(aggregate(`<ds:Signature ${attrs}/>` + entity('https://a'))),
      'Aggregate signature exceeds maximum attribute count'
    );
  });

  it('should treat a validUntil exactly now as expired', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    expectValidationError(
      () =>
        parseAggregateMetadata(
          aggregate(entity('https://a'), ' ID="_r" validUntil="2030-01-01T00:00:00Z"')
        ),
      'Invalid aggregate metadata: expired validUntil'
    );
    vi.setSystemTime(new Date('2029-12-31T23:59:59.999Z'));
    expect(
      parseAggregateMetadata(
        aggregate(entity('https://a'), ' ID="_r" validUntil="2030-01-01T00:00:00Z"')
      ).validUntil
    ).toBe('2030-01-01T00:00:00Z');
  });

  it('should escape text and attribute values when re-serializing an entity', () => {
    const xml = aggregate(
      `<md:EntityDescriptor entityID="https://a?x=1&amp;y=&quot;2&quot;"><md:Organization><md:OrganizationName xml:lang="en">A &amp; B &lt;C&gt;</md:OrganizationName><md:OrganizationDisplayName xml:lang="en"><![CDATA[Display <A>]]></md:OrganizationDisplayName></md:Organization></md:EntityDescriptor>`
    );
    const [summary] = parseAggregateMetadata(xml).entities;
    expect(summary.entityId).toBe('https://a?x=1&y="2"');
    expect(summary.displayName).toBe('Display <A>');
    const extracted = extractEntityDescriptorXml(xml, 'https://a?x=1&y="2"');
    expect(extracted).toContain('entityID="https://a?x=1&amp;y=&quot;2&quot;"');
    expect(extracted).toContain('A &amp; B &lt;C&gt;');
    expect(extracted).toContain('Display &lt;A&gt;');
  });
});

describe('entity summaries', () => {
  const summaryOf = (body: string) =>
    parseAggregateMetadata(aggregate(entity('https://e', body))).entities[0];

  it('should classify roles', () => {
    expect(summaryOf('<md:IDPSSODescriptor/>').role).toBe('saml_idp');
    expect(summaryOf('<md:SPSSODescriptor/>').role).toBe('saml_sp');
    expect(summaryOf('<md:IDPSSODescriptor/><md:SPSSODescriptor/>').role).toBe('ambiguous');
    expect(summaryOf('<md:AttributeAuthorityDescriptor/>').role).toBe('unknown');
  });

  it('should leave optional fields undefined for a bare entity', () => {
    expect(summaryOf('<md:SPSSODescriptor/>')).toEqual({
      entityId: 'https://e',
      role: 'saml_sp',
      displayName: undefined,
      acsUrl: undefined,
      ssoUrl: undefined,
      sloUrl: undefined,
      certificateCount: 0,
      validUntil: undefined,
      keywords: undefined,
      logoUrl: undefined,
      entityCategories: undefined,
      entityCategorySupport: undefined,
      registrationAuthority: undefined,
    });
  });

  it('should fall back from DisplayName to OrganizationDisplayName to OrganizationName', () => {
    const org = (name: string, display?: string) =>
      `<md:Organization><md:OrganizationName xml:lang="en">${name}</md:OrganizationName>${display ? `<md:OrganizationDisplayName xml:lang="en">${display}</md:OrganizationDisplayName>` : ''}</md:Organization>`;
    expect(
      summaryOf(
        `<md:SPSSODescriptor><md:Extensions><mdui:UIInfo><mdui:DisplayName xml:lang="de">DE</mdui:DisplayName></mdui:UIInfo></md:Extensions></md:SPSSODescriptor>${org('Org', 'Org Display')}`
      ).displayName
    ).toBe('DE');
    expect(summaryOf(`<md:SPSSODescriptor/>${org('Org', 'Org Display')}`).displayName).toBe(
      'Org Display'
    );
    expect(summaryOf(`<md:SPSSODescriptor/>${org('Org')}`).displayName).toBe('Org');
  });

  it('should prefer English, then Japanese, then the first localized text', () => {
    const ui = (...names: string[]) =>
      `<md:SPSSODescriptor><md:Extensions><mdui:UIInfo>${names.join('')}</mdui:UIInfo></md:Extensions></md:SPSSODescriptor>`;
    const dn = (lang: string, text: string) =>
      `<mdui:DisplayName xml:lang="${lang}">${text}</mdui:DisplayName>`;
    expect(summaryOf(ui(dn('de', 'DE'), dn('ja', 'JA'), dn('en', 'EN'))).displayName).toBe('EN');
    expect(summaryOf(ui(dn('de', 'DE'), dn('ja', 'JA'))).displayName).toBe('JA');
    expect(summaryOf(ui(dn('de', 'DE'), dn('fr', 'FR'))).displayName).toBe('DE');
  });

  it('should collect endpoints, certificates, keywords and the entity validUntil', () => {
    const body = `<md:IDPSSODescriptor><md:Extensions><mdui:UIInfo><mdui:Keywords xml:lang="en">a b  a</mdui:Keywords><mdui:Keywords xml:lang="ja">c</mdui:Keywords></mdui:UIInfo></md:Extensions><md:KeyDescriptor><ds:KeyInfo><ds:X509Data><ds:X509Certificate>A</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:KeyDescriptor><ds:KeyInfo><ds:X509Data><ds:X509Certificate>B</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleLogoutService Binding="b" Location="https://e/slo"/><md:SingleSignOnService Binding="b" Location="https://e/sso"/></md:IDPSSODescriptor>`;
    const xml = aggregate(
      `<md:EntityDescriptor entityID="https://e" validUntil="2099-01-01T00:00:00Z">${body}</md:EntityDescriptor>`
    );
    expect(parseAggregateMetadata(xml).entities[0]).toMatchObject({
      role: 'saml_idp',
      ssoUrl: 'https://e/sso',
      sloUrl: 'https://e/slo',
      acsUrl: undefined,
      certificateCount: 2,
      keywords: ['a', 'b', 'c'],
      validUntil: '2099-01-01T00:00:00Z',
    });
  });

  it('should take the SLO endpoint from the SP descriptor and report undefined Location as undefined', () => {
    expect(
      summaryOf(
        '<md:SPSSODescriptor><md:AssertionConsumerService Binding="b"/><md:SingleLogoutService Binding="b" Location="https://e/sp-slo"/></md:SPSSODescriptor>'
      )
    ).toMatchObject({
      acsUrl: undefined,
      sloUrl: 'https://e/sp-slo',
    });
  });

  it('should read entity categories only from the entity-level Extensions and de-duplicate them', () => {
    const attr = (name: string, ...values: string[]) =>
      `<saml:Attribute xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" Name="${name}">${values.map((v) => `<saml:AttributeValue>${v}</saml:AttributeValue>`).join('')}</saml:Attribute>`;
    const body = `<md:Extensions><mdattr:EntityAttributes xmlns:mdattr="urn:oasis:names:tc:SAML:metadata:attribute">${attr('http://macedir.org/entity-category', ' cat1 ', 'cat1', '', 'cat2')}${attr('http://macedir.org/entity-category-support', 'sup')}${attr('other', 'x')}</mdattr:EntityAttributes><mdrpi:RegistrationInfo registrationAuthority="https://fed"/></md:Extensions><md:SPSSODescriptor/>`;
    expect(summaryOf(body)).toMatchObject({
      entityCategories: ['cat1', 'cat2'],
      entityCategorySupport: ['sup'],
      registrationAuthority: 'https://fed',
    });
    expect(
      summaryOf('<md:Extensions><mdrpi:RegistrationInfo/></md:Extensions><md:SPSSODescriptor/>')
        .registrationAuthority
    ).toBeUndefined();
  });
});

describe('getLogoUrl', () => {
  const logos = (
    ...items: Array<{ url: string; lang?: string; width?: number; height?: number }>
  ) =>
    parseXml(
      `<mdui:UIInfo xmlns:mdui="${MDUI}">${items
        .map(
          (l) =>
            `<mdui:Logo${l.lang ? ` xml:lang="${l.lang}"` : ''}${l.width ? ` width="${l.width}"` : ''}${l.height ? ` height="${l.height}"` : ''}>${l.url}</mdui:Logo>`
        )
        .join('')}</mdui:UIInfo>`
    ).documentElement;

  it('should return undefined without any https logo', () => {
    expect(getLogoUrl(logos())).toBeUndefined();
    expect(
      getLogoUrl(logos({ url: 'http://insecure/logo.png' }, { url: 'not a url' }, { url: '' }))
    ).toBeUndefined();
  });

  it('should prefer English or Japanese logos, then the largest', () => {
    expect(
      getLogoUrl(
        logos(
          { url: 'https://x/de-big.png', lang: 'de', width: 500, height: 500 },
          { url: 'https://x/en-small.png', lang: 'en', width: 10 }
        )
      )
    ).toBe('https://x/en-small.png');
    expect(
      getLogoUrl(
        logos(
          { url: 'https://x/ja-small.png', lang: 'ja', width: 10, height: 20 },
          { url: 'https://x/en-big.png', lang: 'en', height: 30 }
        )
      )
    ).toBe('https://x/en-big.png');
    expect(
      getLogoUrl(
        logos({ url: 'https://x/a.png', width: 10 }, { url: 'https://x/b.png', width: 10 })
      )
    ).toBe('https://x/a.png');
  });

  it('should trim whitespace around the URL', () => {
    expect(getLogoUrl(logos({ url: '  https://x/logo.png\n' }))).toBe('https://x/logo.png');
  });
});

describe('unwrapSingleEntityMetadata / extractEntityDescriptorXmls', () => {
  it('should unwrap a one-entity aggregate even without a root ID', () => {
    const unwrapped = unwrapSingleEntityMetadata(aggregate(entity('https://only'), ''));
    expect(unwrapped.startsWith('<md:EntityDescriptor')).toBe(true);
    expect(unwrapped).toContain(`xmlns:md="${MD}"`); // in-scope namespaces are re-declared
    expect(unwrapped).toContain('entityID="https://only"');
  });

  it('should refuse to unwrap an aggregate with several entities', () => {
    expectValidationError(
      () => unwrapSingleEntityMetadata(aggregate(entity('https://a') + entity('https://b'))),
      'metadata_aggregate_requires_federation'
    );
  });

  it('should return an empty map for no requested IDs without parsing', () => {
    expect(extractEntityDescriptorXmls('<not xml', [])).toEqual(new Map());
  });

  it('should return only the requested entities, once each', () => {
    const xml = aggregate(entity('https://a') + entity('https://b') + entity('https://c'));
    const result = extractEntityDescriptorXmls(xml, ['https://c', 'https://a', 'https://missing']);
    expect([...result.keys()].sort()).toEqual(['https://a', 'https://c']);
    expect(result.get('https://c')).toContain('entityID="https://c"');
  });

  it('should name the missing entityID when extracting a single entity', () => {
    expectValidationError(
      () => extractEntityDescriptorXml(aggregate(entity('https://a')), 'https://zzz'),
      'Aggregate metadata does not contain entityID: https://zzz'
    );
  });

  it('should reject an extracted entity above the single-entity size limit', () => {
    const big = `<md:EntityDescriptor entityID="https://big"><a>${'x'.repeat(1024 * 1024)}</a></md:EntityDescriptor>`;
    expectValidationError(
      () => extractEntityDescriptorXml(aggregate(big), 'https://big'),
      'Invalid aggregate metadata: EntityDescriptor exceeds size limit'
    );
  });
});

describe('resolveAggregateSignaturePolicy', () => {
  const env = (overrides: Record<string, string | undefined>) => overrides as unknown as Env;

  it.each([
    ['strict', 'strict'],
    [' WARN ', 'warn'],
    ['Disabled', 'disabled'],
  ])('should honour an explicit policy %j', (raw, expected) => {
    expect(
      resolveAggregateSignaturePolicy(
        env({ SAML_AGGREGATE_METADATA_SIGNATURE_POLICY: raw, ENVIRONMENT: 'production' })
      )
    ).toBe(expected);
  });

  it.each([
    [{ AUTHRIM_DEPLOYMENT_TARGET: 'prod' }],
    [{ AUTHRIM_DEPLOYMENT_TARGET: 'production' }],
    [{ ENVIRONMENT: 'prod' }],
    [{ ENVIRONMENT: 'production' }],
    [{ SAML_AGGREGATE_METADATA_SIGNATURE_POLICY: 'lenient', ENVIRONMENT: 'production' }],
  ])('should default to strict in production (%j)', (vars) => {
    expect(resolveAggregateSignaturePolicy(env(vars))).toBe('strict');
  });

  it.each([[{}], [{ ENVIRONMENT: 'staging' }], [{ AUTHRIM_DEPLOYMENT_TARGET: 'dev' }]])(
    'should default to warn elsewhere (%j)',
    (vars) => {
      expect(resolveAggregateSignaturePolicy(env(vars))).toBe('warn');
    }
  );
});

describe('verifyAggregateMetadata trust profile matching', () => {
  const profile = (overrides: Partial<SAMLFederationTrustProfile>): SAMLFederationTrustProfile =>
    ({
      id: 'p1',
      name: 'Federation',
      enabled: true,
      metadataUrlPatterns: ['https://fed.example.test/*'],
      certificates: [],
      trustContextSnapshotHash: 'hash-1',
      ...overrides,
    }) as unknown as SAMLFederationTrustProfile;
  const xml = aggregate(entity('https://a'));

  it('should skip verification when the policy is disabled and name the single matching profile', async () => {
    const result = await verifyAggregateMetadata(
      xml,
      'https://fed.example.test/metadata.xml',
      [profile({})],
      'disabled'
    );
    expect(result.verification).toEqual({
      status: 'skipped',
      policy: 'disabled',
      trustProfileId: 'p1',
      trustProfileName: 'Federation',
      trustContextSnapshotHash: 'hash-1',
      warnings: ['Aggregate metadata signature verification is disabled.'],
    });
    expect(result.aggregate.entities.map((e) => e.entityId)).toEqual(['https://a']);
  });

  it('should omit the profile when several or none match in disabled mode', async () => {
    const two = await verifyAggregateMetadata(
      xml,
      'https://fed.example.test/m',
      [profile({}), profile({ id: 'p2' })],
      'disabled'
    );
    expect(two.verification.trustProfileId).toBeUndefined();
    const none = await verifyAggregateMetadata(
      xml,
      'https://other.example.test/m',
      [profile({})],
      'disabled'
    );
    expect(none.verification.trustProfileId).toBeUndefined();
  });

  it('should ignore disabled profiles and match patterns with escaped metacharacters', async () => {
    const result = await verifyAggregateMetadata(
      xml,
      'https://fed.example.test/metadata.xml?v=1',
      [
        profile({ id: 'off', enabled: false, metadataUrlPatterns: ['*'] }),
        profile({
          id: 'exact',
          metadataUrlPatterns: ['https://fed.example.test/metadata.xml?v=1'],
        }),
        profile({
          id: 'dotted',
          metadataUrlPatterns: ['https://fed.exampleXtest/metadata.xml?v=1'],
        }),
      ],
      'disabled'
    );
    expect(result.verification.trustProfileId).toBe('exact');
  });

  it('should report an unverified aggregate in warn mode when no profile matches', async () => {
    const result = await verifyAggregateMetadata(xml, 'https://other/m', [profile({})], 'warn');
    expect(result.verification).toEqual({
      status: 'unverified',
      policy: 'warn',
      signedElementId: '_root',
      warnings: ['No enabled federation trust profile matched this metadata URL.'],
      error: 'No matching federation trust profile',
    });
  });

  it('should fail closed in strict mode when no profile matches', async () => {
    await expect(
      verifyAggregateMetadata(xml, 'https://other/m', [profile({})], 'strict')
    ).rejects.toThrow(new SAMLMetadataValidationError('No matching federation trust profile'));
  });

  it('should not match an uploaded document (no URL) unless a profile uses the bare wildcard', async () => {
    const miss = await verifyAggregateMetadata(
      xml,
      undefined,
      [profile({ metadataUrlPatterns: ['https://*'] })],
      'warn'
    );
    expect(miss.verification.status).toBe('unverified');
    const hit = await verifyAggregateMetadata(
      xml,
      undefined,
      [profile({ metadataUrlPatterns: [' * '] })],
      'warn'
    );
    expect(hit.verification).toMatchObject({
      status: 'unverified',
      trustProfileId: 'p1',
      error: 'Aggregate metadata root is not signed',
    });
  });
});

describe('fingerprintCertificateSha256', () => {
  it('should return the lower-case colon separated SHA-256 of the DER bytes', async () => {
    expect(await fingerprintCertificateSha256(RSA_2048_SHA256_PEM)).toBe(
      'e7:25:15:ed:bb:77:d5:f7:a5:db:1b:bf:df:62:f7:8f:79:d8:21:c8:b8:67:a6:3d:b4:0b:7c:64:18:c4:2b:87'
    );
  });

  it('should ignore whitespace inside the PEM body', async () => {
    const spaced = RSA_2048_SHA256_PEM.replace(/\n/g, '\r\n  ');
    expect(await fingerprintCertificateSha256(spaced)).toBe(
      await fingerprintCertificateSha256(RSA_2048_SHA256_PEM)
    );
  });

  it.each([
    ['no PEM armour', 'MIIB'],
    ['a missing END marker', '-----BEGIN CERTIFICATE-----\nMIIB'],
    ['an empty body', '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----'],
    ['non-base64 characters', '-----BEGIN CERTIFICATE-----\nMI*IB\n-----END CERTIFICATE-----'],
    ['base64 that cannot be decoded', '-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----'],
  ])('should reject %s', async (_label, pem) => {
    await expect(fingerprintCertificateSha256(pem)).rejects.toThrow(
      new SAMLMetadataValidationError('Invalid trust certificate PEM')
    );
  });
});
