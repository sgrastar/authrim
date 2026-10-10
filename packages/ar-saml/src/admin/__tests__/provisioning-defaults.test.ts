import { describe, expect, it } from 'vitest';
import type { SAMLIdPConfig, SAMLSPConfig, SamlProvisioningDefaults } from '@authrim/ar-lib-core';
import { NAMEID_FORMATS } from '../../common/constants';
import { applySAMLSPProfileDefaults } from '../profile-defaults';
import {
  parseIdPMetadata,
  parseSPMetadata,
  refreshSAMLProviderConfigFromMetadata,
} from '../providers';
import { fillSAMLProviderProvisioningDefaults } from '../provisioning-defaults';

const POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';

const tenant = (overrides: Partial<SamlProvisioningDefaults> = {}): SamlProvisioningDefaults => ({
  ssoBinding: 'redirect',
  sloBinding: 'redirect',
  nameIdFormat: NAMEID_FORMATS.EMAIL,
  ...overrides,
});

function idpMetadata(options: {
  sso?: Array<'post' | 'redirect'>;
  slo?: Array<'post' | 'redirect'>;
  nameId?: string;
}) {
  const service = (tag: string, kind: 'post' | 'redirect', path: string) =>
    `<md:${tag} Binding="${kind === 'post' ? POST : REDIRECT}" Location="https://idp.example.test/${path}/${kind}" />`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="https://idp.example.test/entity">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>IDPCERT</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    ${options.nameId ? `<md:NameIDFormat>${options.nameId}</md:NameIDFormat>` : ''}
    ${(options.sso ?? ['post', 'redirect']).map((kind) => service('SingleSignOnService', kind, 'sso')).join('\n')}
    ${(options.slo ?? []).map((kind) => service('SingleLogoutService', kind, 'slo')).join('\n')}
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

function spMetadata(options: { slo?: Array<'post' | 'redirect'>; nameId?: string }) {
  const slo = (options.slo ?? [])
    .map(
      (kind) =>
        `<md:SingleLogoutService Binding="${kind === 'post' ? POST : REDIRECT}" Location="https://sp.example.test/slo/${kind}" />`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://sp.example.test/entity">
  <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    ${options.nameId ? `<md:NameIDFormat>${options.nameId}</md:NameIDFormat>` : ''}
    <md:AssertionConsumerService Binding="${POST}" Location="https://sp.example.test/acs" index="0" isDefault="true" />
    ${slo}
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
}

describe('IdP metadata with the tenant defaults', () => {
  it('keeps the Redirect endpoints and both bindings without defaults, as before', () => {
    const config = parseIdPMetadata(idpMetadata({ slo: ['post', 'redirect'] }));
    expect(config.ssoUrl).toBe('https://idp.example.test/sso/redirect');
    expect(config.sloUrl).toBe('https://idp.example.test/slo/redirect');
    expect(config.allowedBindings).toEqual(['post', 'redirect']);
    expect(config.nameIdFormat).toBe(NAMEID_FORMATS.EMAIL);
  });

  it('prefers the POST endpoints when the tenant default is POST and the metadata offers both', () => {
    const config = parseIdPMetadata(
      idpMetadata({ slo: ['post', 'redirect'] }),
      tenant({ ssoBinding: 'post', sloBinding: 'post' })
    );
    expect(config.ssoUrl).toBe('https://idp.example.test/sso/post');
    expect(config.sloUrl).toBe('https://idp.example.test/slo/post');
    // Sign-in is then sent by POST; a Redirect entry would send it to the POST endpoint.
    expect(config.allowedBindings).toEqual(['post']);
  });

  it('prefers Redirect endpoints when the tenant default is Redirect', () => {
    const config = parseIdPMetadata(idpMetadata({ slo: ['post', 'redirect'] }), tenant());
    expect(config.ssoUrl).toBe('https://idp.example.test/sso/redirect');
    expect(config.sloUrl).toBe('https://idp.example.test/slo/redirect');
    expect(config.allowedBindings).toEqual(['post', 'redirect']);
  });

  it('uses the only binding the metadata offers, whatever the tenant default', () => {
    const redirectOnly = parseIdPMetadata(
      idpMetadata({ sso: ['redirect'], slo: ['redirect'] }),
      tenant({ ssoBinding: 'post', sloBinding: 'post' })
    );
    expect(redirectOnly.ssoUrl).toBe('https://idp.example.test/sso/redirect');
    expect(redirectOnly.sloUrl).toBe('https://idp.example.test/slo/redirect');
    expect(redirectOnly.allowedBindings).toEqual(['redirect']);

    const postOnly = parseIdPMetadata(
      idpMetadata({ sso: ['post'], slo: ['post'] }),
      tenant({ ssoBinding: 'redirect', sloBinding: 'redirect' })
    );
    expect(postOnly.ssoUrl).toBe('https://idp.example.test/sso/post');
    expect(postOnly.sloUrl).toBe('https://idp.example.test/slo/post');
    expect(postOnly.allowedBindings).toEqual(['post']);
  });

  it("gives the tenant NameID format when the metadata names none, and keeps the metadata's own", () => {
    expect(
      parseIdPMetadata(idpMetadata({}), tenant({ nameIdFormat: NAMEID_FORMATS.PERSISTENT }))
        .nameIdFormat
    ).toBe(NAMEID_FORMATS.PERSISTENT);
    expect(
      parseIdPMetadata(
        idpMetadata({ nameId: NAMEID_FORMATS.TRANSIENT }),
        tenant({ nameIdFormat: NAMEID_FORMATS.PERSISTENT })
      ).nameIdFormat
    ).toBe(NAMEID_FORMATS.TRANSIENT);
  });
});

describe('SP metadata with the tenant defaults', () => {
  const both = spMetadata({ slo: ['post', 'redirect'] });

  it('keeps preferring Redirect logout without defaults, as before', () => {
    expect(parseSPMetadata(both)).toMatchObject({
      sloBinding: 'redirect',
      sloUrl: 'https://sp.example.test/slo/redirect',
      nameIdFormat: NAMEID_FORMATS.EMAIL,
    });
  });

  it('prefers POST logout when the tenant default is POST and the metadata offers both', () => {
    expect(parseSPMetadata(both, undefined, tenant({ sloBinding: 'post' }))).toMatchObject({
      sloBinding: 'post',
      sloUrl: 'https://sp.example.test/slo/post',
    });
  });

  it('uses the only logout binding the metadata offers', () => {
    expect(
      parseSPMetadata(spMetadata({ slo: ['redirect'] }), undefined, tenant({ sloBinding: 'post' }))
    ).toMatchObject({ sloBinding: 'redirect' });
  });

  it("lets the legacy profile's POST logout win over a Redirect tenant default", () => {
    expect(parseSPMetadata(both, 'legacy', tenant({ sloBinding: 'redirect' }))).toMatchObject({
      sloBinding: 'post',
    });
  });

  it('applies the tenant logout default under profiles that name none', () => {
    for (const profile of ['baseline', 'strict', 'academic_publisher'] as const) {
      expect(parseSPMetadata(both, profile, tenant({ sloBinding: 'post' }))).toMatchObject({
        sloBinding: 'post',
      });
    }
  });

  it('gives the tenant NameID format when the metadata names none, and keeps the metadata own', () => {
    const persistent = tenant({ nameIdFormat: NAMEID_FORMATS.PERSISTENT });
    expect(parseSPMetadata(spMetadata({}), undefined, persistent).nameIdFormat).toBe(
      NAMEID_FORMATS.PERSISTENT
    );
    expect(
      parseSPMetadata(spMetadata({ nameId: NAMEID_FORMATS.TRANSIENT }), undefined, persistent)
        .nameIdFormat
    ).toBe(NAMEID_FORMATS.TRANSIENT);
  });

  it("keeps a profile's own NameID format over the tenant default", () => {
    const transient = tenant({ nameIdFormat: NAMEID_FORMATS.TRANSIENT });
    const strict = applySAMLSPProfileDefaults(
      parseSPMetadata(spMetadata({}), 'strict', transient),
      'strict'
    );
    expect(strict.nameIdFormat).toBe(NAMEID_FORMATS.PERSISTENT);
    const legacy = applySAMLSPProfileDefaults(
      parseSPMetadata(spMetadata({}), 'legacy', transient),
      'legacy'
    );
    expect(legacy.nameIdFormat).toBe(NAMEID_FORMATS.EMAIL);
    // The baseline profile names none, so the tenant default applies.
    const baseline = applySAMLSPProfileDefaults(
      parseSPMetadata(spMetadata({}), 'baseline', transient),
      'baseline'
    );
    expect(baseline.nameIdFormat).toBe(NAMEID_FORMATS.TRANSIENT);
  });
});

const idpConfig = (config: Record<string, unknown>) => config as unknown as SAMLIdPConfig;
const spConfig = (config: Record<string, unknown>) => config as unknown as SAMLSPConfig;

describe('fillSAMLProviderProvisioningDefaults (a provider added without metadata)', () => {
  const defaults = tenant({
    ssoBinding: 'post',
    sloBinding: 'post',
    nameIdFormat: NAMEID_FORMATS.PERSISTENT,
  });

  it('fills what an identity provider leaves out', () => {
    const config = fillSAMLProviderProvisioningDefaults(
      'saml_idp',
      idpConfig({ entityId: 'https://idp.example.test', ssoUrl: 'https://idp.example.test/sso' }),
      defaults
    );
    expect(config).toMatchObject({
      nameIdFormat: NAMEID_FORMATS.PERSISTENT,
      allowedBindings: ['post'],
    });
  });

  it('keeps an empty allowedBindings list an identity provider names without metadata', () => {
    const config = fillSAMLProviderProvisioningDefaults(
      'saml_idp',
      idpConfig({ entityId: 'https://idp.example.test', allowedBindings: [] }),
      defaults
    );
    expect(config.allowedBindings).toEqual([]);
  });

  it('keeps what an identity provider names', () => {
    const config = fillSAMLProviderProvisioningDefaults(
      'saml_idp',
      idpConfig({
        entityId: 'https://idp.example.test',
        nameIdFormat: NAMEID_FORMATS.EMAIL,
        allowedBindings: ['redirect'],
      }),
      defaults
    );
    expect(config).toMatchObject({
      nameIdFormat: NAMEID_FORMATS.EMAIL,
      allowedBindings: ['redirect'],
    });
  });

  it('fills the NameID format and the logout binding of a service provider with a logout URL', () => {
    const config = fillSAMLProviderProvisioningDefaults(
      'saml_sp',
      spConfig({ entityId: 'https://sp.example.test', sloUrl: 'https://sp.example.test/slo' }),
      defaults
    );
    expect(config).toMatchObject({
      nameIdFormat: NAMEID_FORMATS.PERSISTENT,
      sloBinding: 'post',
    });
  });

  it('leaves the logout binding out when the service provider has no logout URL', () => {
    const config = fillSAMLProviderProvisioningDefaults(
      'saml_sp',
      spConfig({ entityId: 'https://sp.example.test' }),
      defaults
    );
    expect(config).not.toHaveProperty('sloBinding');
  });

  it("gives the service provider's profile NameID format and logout binding before the tenant's", () => {
    const legacy = fillSAMLProviderProvisioningDefaults(
      'saml_sp',
      spConfig({
        entityId: 'https://sp.example.test',
        sloUrl: 'https://sp.example.test/slo',
        samlProfile: 'legacy',
      }),
      tenant({ sloBinding: 'redirect', nameIdFormat: NAMEID_FORMATS.TRANSIENT })
    );
    expect(legacy).toMatchObject({ nameIdFormat: NAMEID_FORMATS.EMAIL, sloBinding: 'post' });

    const strict = fillSAMLProviderProvisioningDefaults(
      'saml_sp',
      spConfig({ entityId: 'https://sp.example.test', samlProfile: 'strict' }),
      tenant({ nameIdFormat: NAMEID_FORMATS.TRANSIENT })
    );
    expect(strict.nameIdFormat).toBe(NAMEID_FORMATS.PERSISTENT);
  });

  it('keeps what a service provider names', () => {
    const config = fillSAMLProviderProvisioningDefaults(
      'saml_sp',
      spConfig({
        entityId: 'https://sp.example.test',
        sloUrl: 'https://sp.example.test/slo',
        nameIdFormat: NAMEID_FORMATS.EMAIL,
        sloBinding: 'redirect',
      }),
      defaults
    );
    expect(config).toMatchObject({ nameIdFormat: NAMEID_FORMATS.EMAIL, sloBinding: 'redirect' });
  });
});

describe('refreshing a registered provider keeps what the tenant defaults gave it', () => {
  const persistent = tenant({
    nameIdFormat: NAMEID_FORMATS.PERSISTENT,
    ssoBinding: 'post',
    sloBinding: 'post',
  });
  const refresh = (
    providerType: 'saml_idp' | 'saml_sp',
    existingConfig: SAMLIdPConfig | SAMLSPConfig,
    metadataXml: string
  ) =>
    refreshSAMLProviderConfigFromMetadata({
      providerType,
      existingConfig,
      metadataXml,
      metadataUrl: 'https://metadata.example.test/m.xml',
    }).then((result) => result.config);

  it('keeps the NameID format and bindings an identity provider got at registration', async () => {
    const xml = idpMetadata({ slo: ['post', 'redirect'] });
    const registered = parseIdPMetadata(xml, persistent);
    expect(registered).toMatchObject({
      nameIdFormat: NAMEID_FORMATS.PERSISTENT,
      allowedBindings: ['post'],
      ssoUrl: 'https://idp.example.test/sso/post',
      sloUrl: 'https://idp.example.test/slo/post',
    });

    expect(await refresh('saml_idp', registered, xml)).toMatchObject({
      nameIdFormat: NAMEID_FORMATS.PERSISTENT,
      allowedBindings: ['post'],
      ssoUrl: 'https://idp.example.test/sso/post',
      sloUrl: 'https://idp.example.test/slo/post',
    });
  });

  it('follows metadata that now names a NameID format', async () => {
    const registered = parseIdPMetadata(idpMetadata({}), persistent);
    expect(
      await refresh('saml_idp', registered, idpMetadata({ nameId: NAMEID_FORMATS.TRANSIENT }))
    ).toMatchObject({ nameIdFormat: NAMEID_FORMATS.TRANSIENT });
  });

  it('follows metadata that now offers only one binding', async () => {
    const registered = parseIdPMetadata(idpMetadata({ slo: ['post', 'redirect'] }), persistent);
    expect(
      await refresh('saml_idp', registered, idpMetadata({ sso: ['redirect'], slo: ['redirect'] }))
    ).toMatchObject({
      allowedBindings: ['redirect'],
      ssoUrl: 'https://idp.example.test/sso/redirect',
      sloUrl: 'https://idp.example.test/slo/redirect',
    });
  });

  it('keeps an identity provider that was registered with the usual Redirect choice', async () => {
    const xml = idpMetadata({ slo: ['post', 'redirect'] });
    const registered = parseIdPMetadata(xml);
    expect(await refresh('saml_idp', registered, xml)).toMatchObject({
      allowedBindings: ['post', 'redirect'],
      ssoUrl: 'https://idp.example.test/sso/redirect',
      sloUrl: 'https://idp.example.test/slo/redirect',
    });
  });

  it('keeps the NameID format and logout binding a service provider got at registration', async () => {
    const xml = spMetadata({ slo: ['post', 'redirect'] });
    const registered = parseSPMetadata(xml, undefined, persistent);
    expect(registered).toMatchObject({
      nameIdFormat: NAMEID_FORMATS.PERSISTENT,
      sloBinding: 'post',
    });
    expect(await refresh('saml_sp', registered, xml)).toMatchObject({
      nameIdFormat: NAMEID_FORMATS.PERSISTENT,
      sloBinding: 'post',
      sloUrl: 'https://sp.example.test/slo/post',
    });
  });

  it('keeps the logout binding when only the endpoint URLs change', async () => {
    const before = idpMetadata({ slo: ['post', 'redirect'] });
    const after = before
      .replaceAll('idp.example.test/sso', 'idp2.example.test/sso')
      .replaceAll('idp.example.test/slo', 'idp2.example.test/slo');
    const registered = {
      ...parseIdPMetadata(before, persistent),
      metadataXml: before,
    };
    expect(registered.sloUrl).toBe('https://idp.example.test/slo/post');

    expect(await refresh('saml_idp', registered, after)).toMatchObject({
      sloUrl: 'https://idp2.example.test/slo/post',
      ssoUrl: 'https://idp2.example.test/sso/post',
      allowedBindings: ['post'],
    });
  });

  it('reads the earlier choice from stored metadata whose validity has since expired', async () => {
    const before = idpMetadata({ slo: ['post', 'redirect'] });
    const after = before
      .replaceAll('idp.example.test/sso', 'idp2.example.test/sso')
      .replaceAll('idp.example.test/slo', 'idp2.example.test/slo');
    const expired = before.replace('entityID=', 'validUntil="2020-01-01T00:00:00Z" entityID=');
    expect(() => parseIdPMetadata(expired)).toThrow();
    const registered = { ...parseIdPMetadata(before, persistent), metadataXml: expired };

    expect(await refresh('saml_idp', registered, after)).toMatchObject({
      sloUrl: 'https://idp2.example.test/slo/post',
    });
  });

  it('keeps POST logout registered from POST-only metadata when the new metadata offers both', async () => {
    const before = idpMetadata({ sso: ['post'], slo: ['post'] });
    const after = idpMetadata({ sso: ['post', 'redirect'], slo: ['post', 'redirect'] })
      .replaceAll('idp.example.test/sso', 'idp2.example.test/sso')
      .replaceAll('idp.example.test/slo', 'idp2.example.test/slo');
    const registered = { ...parseIdPMetadata(before), metadataXml: before };
    expect(registered.sloUrl).toBe('https://idp.example.test/slo/post');

    expect(await refresh('saml_idp', registered, after)).toMatchObject({
      sloUrl: 'https://idp2.example.test/slo/post',
    });
  });

  it('keeps the Redirect logout binding of a provider registered with the usual choice when URLs change', async () => {
    const before = idpMetadata({ slo: ['post', 'redirect'] });
    const after = before
      .replaceAll('idp.example.test/sso', 'idp2.example.test/sso')
      .replaceAll('idp.example.test/slo', 'idp2.example.test/slo');
    const registered = { ...parseIdPMetadata(before), metadataXml: before };
    expect(await refresh('saml_idp', registered, after)).toMatchObject({
      sloUrl: 'https://idp2.example.test/slo/redirect',
    });
  });

  it('follows service provider metadata that now names a NameID format', async () => {
    const registered = parseSPMetadata(spMetadata({}), undefined, persistent);
    expect(
      await refresh('saml_sp', registered, spMetadata({ nameId: NAMEID_FORMATS.TRANSIENT }))
    ).toMatchObject({ nameIdFormat: NAMEID_FORMATS.TRANSIENT });
  });
});
