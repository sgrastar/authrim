import { describe, expect, it } from 'vitest';
import {
  buildSAMLEntityIdFromIssuerUrl,
  DEFAULT_SAML_ENTITY_ID_STYLE,
  DEFAULT_SAML_INTERACTIVE_LOGIN_URL_POLICY,
  getSAMLPublicSettings,
  normalizeSAMLInteractiveLoginUrlPolicy,
  normalizeSAMLEntityIdStyle,
} from '../entity-id';

describe('SAML local entityID helpers', () => {
  it('defaults new deployments to metadata URL entityIDs', () => {
    expect(DEFAULT_SAML_ENTITY_ID_STYLE).toBe('metadata_url');
  });

  it('defaults SAML interactive login redirects to tenant host', () => {
    expect(DEFAULT_SAML_INTERACTIVE_LOGIN_URL_POLICY).toBe('tenant_host');
  });

  it('builds metadata URL entityIDs', () => {
    expect(
      buildSAMLEntityIdFromIssuerUrl('https://tenant.example.org', 'idp', 'metadata_url')
    ).toBe('https://tenant.example.org/saml/idp/metadata');
    expect(buildSAMLEntityIdFromIssuerUrl('https://tenant.example.org', 'sp', 'metadata_url')).toBe(
      'https://tenant.example.org/saml/sp/metadata'
    );
  });

  it('builds role URL entityIDs', () => {
    expect(buildSAMLEntityIdFromIssuerUrl('https://tenant.example.org', 'idp', 'role_url')).toBe(
      'https://tenant.example.org/saml/idp'
    );
    expect(buildSAMLEntityIdFromIssuerUrl('https://tenant.example.org', 'sp', 'role_url')).toBe(
      'https://tenant.example.org/saml/sp'
    );
  });

  it('rejects unknown style values', () => {
    expect(normalizeSAMLEntityIdStyle('metadata_url')).toBe('metadata_url');
    expect(normalizeSAMLEntityIdStyle('role_url')).toBe('role_url');
    expect(normalizeSAMLEntityIdStyle('metadata')).toBeNull();
  });

  it('normalizes interactive login URL policies', () => {
    expect(normalizeSAMLInteractiveLoginUrlPolicy('tenant_host')).toBe('tenant_host');
    expect(normalizeSAMLInteractiveLoginUrlPolicy('ui_base_url')).toBe('ui_base_url');
    expect(normalizeSAMLInteractiveLoginUrlPolicy('common_discovery')).toBeNull();
  });

  it('reads tenant-host login redirects as the stored/default SAML policy', async () => {
    const settings = await getSAMLPublicSettings(
      {
        SETTINGS: {
          get: async () =>
            JSON.stringify({
              entityIdStyle: 'metadata_url',
              interactiveLoginUrlPolicy: 'ui_base_url',
            }),
        },
      } as never,
      'tenant-a'
    );

    expect(settings).toEqual({
      entityIdStyle: 'metadata_url',
      interactiveLoginUrlPolicy: 'ui_base_url',
      certificateSubject: {
        countryName: '',
        stateOrProvinceName: '',
        localityName: '',
        organizationName: 'Authrim',
        organizationalUnitName: '',
        commonName: 'Authrim SAML Signing',
      },
      signingKeyPolicies: {},
    });
  });
});
