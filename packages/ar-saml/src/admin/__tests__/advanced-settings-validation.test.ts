import { describe, expect, it } from 'vitest';
import { samlAdvancedSettingsProblem } from '../advanced-settings-validation';

describe('partial SAML advanced settings validation', () => {
  it('accepts nondefault runtime settings and partial refresh edits without inventing values', async () => {
    expect(
      await samlAdvancedSettingsProblem({
        signResponses: false,
        signAssertions: true,
        assertionValiditySeconds: 480,
        authnRequestSignaturePolicy: 'required',
        allowedBindings: ['post'],
        metadataRefreshPolicy: { mode: 'manual' },
      })
    ).toBeUndefined();
    expect(
      await samlAdvancedSettingsProblem({
        authnContextPolicy: {
          mode: 'require_any',
          allowedClassRefs: ['urn:fixture:class'],
          extension: 'preserve',
        },
        profileUpdateFields: [],
        providerName: 'Fixture',
      })
    ).toBeUndefined();
    expect(await samlAdvancedSettingsProblem({ customExtension: { keep: true } })).toBeUndefined();
  });
  it.each([
    { assertionValiditySeconds: 0 },
    { assertionValiditySeconds: 60.5 },
    { assertionValiditySeconds: 86401 },
    { signAssertions: 'true' },
    { authnRequestSignaturePolicy: 'unknown' },
    { allowedBindings: [] },
    { allowedBindings: ['invented-binding'] },
    { sloUrl: 'http://sp.example.test/logout' },
    { sloUrl: 'https://127.0.0.1/logout' },
    { metadataRefreshPolicy: { intervalSeconds: 899 } },
    { metadataRefreshPolicy: { mode: 'fake' } },
    { authnContextPolicy: { mode: 'require_any', allowedClassRefs: [] } },
    { encryptionCertificate: 'not-a-certificate' },
    { encryptionCertificates: 'not-an-array' },
    { encryptionCertificates: ['not-a-certificate'] },
    { encryptionCertificates: [null] },
  ])('refuses malformed/bounded values %j', async (patch) => {
    expect(await samlAdvancedSettingsProblem(patch)).toBeTypeOf('string');
  });
});
