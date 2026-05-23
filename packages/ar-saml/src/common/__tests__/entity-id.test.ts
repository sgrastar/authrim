import { describe, expect, it } from 'vitest';
import {
  buildSAMLEntityIdFromIssuerUrl,
  DEFAULT_SAML_ENTITY_ID_STYLE,
  normalizeSAMLEntityIdStyle,
} from '../entity-id';

describe('SAML local entityID helpers', () => {
  it('defaults new deployments to metadata URL entityIDs', () => {
    expect(DEFAULT_SAML_ENTITY_ID_STYLE).toBe('metadata_url');
  });

  it('builds metadata URL entityIDs', () => {
    expect(buildSAMLEntityIdFromIssuerUrl('https://tenant.example.org', 'idp', 'metadata_url')).toBe(
      'https://tenant.example.org/saml/idp/metadata'
    );
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
});
