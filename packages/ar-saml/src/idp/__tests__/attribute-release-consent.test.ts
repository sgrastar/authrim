import { describe, expect, it } from 'vitest';
import {
  buildSAMLAttributeSetHash,
  enforceSAMLAttributeReleaseConsent,
  normalizeAttributeReleaseConsentPolicy,
} from '../attribute-release-consent';

describe('SAML attribute release consent', () => {
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
});
