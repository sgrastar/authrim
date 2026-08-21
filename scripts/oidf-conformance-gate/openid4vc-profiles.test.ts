import { describe, expect, it } from 'vitest';
import {
  OPENID4VC_PROFILES,
  assertOpenID4VCPlanBinding,
  normalizeOpenID4VCTargetOrigin,
  openID4VCProfilesForArgument,
} from './openid4vc-profiles';

describe('OpenID4VC Final and HAIP conformance profiles', () => {
  it('pins the four current official Suite variants', () => {
    expect(openID4VCProfilesForArgument('all')).toEqual([
      'oid4vci-final',
      'oid4vci-haip',
      'oid4vp-final',
      'oid4vp-haip',
    ]);
    expect(OPENID4VC_PROFILES['oid4vci-final'].variant).toMatchObject({
      client_auth_type: 'private_key_jwt',
      fapi_profile: 'vci',
      credential_format: 'sd_jwt_vc',
      sender_constrain: 'dpop',
    });
    expect(OPENID4VC_PROFILES['oid4vci-haip'].variant).toMatchObject({
      client_auth_type: 'client_attestation',
      fapi_profile: 'vci_haip',
    });
    expect(OPENID4VC_PROFILES['oid4vp-final'].variant).toMatchObject({
      request_method: 'url_query',
      client_id_prefix: 'redirect_uri',
      response_mode: 'direct_post',
    });
    expect(OPENID4VC_PROFILES['oid4vp-haip'].variant).toMatchObject({
      request_method: 'request_uri_signed',
      client_id_prefix: 'x509_hash',
      response_mode: 'direct_post.jwt',
    });
  });

  it('rejects unknown profile arguments', () => {
    expect(() => openID4VCProfilesForArgument('oid4vp-draft')).toThrow(
      'Unknown OpenID4VC conformance profile'
    );
  });

  it('accepts only a credential-free HTTPS target origin', () => {
    expect(normalizeOpenID4VCTargetOrigin('https://tenant.example')).toBe('https://tenant.example');
    for (const value of [
      'http://tenant.example',
      'https://user@tenant.example',
      'https://tenant.example/path',
      'https://tenant.example?token=secret',
    ]) {
      expect(() => normalizeOpenID4VCTargetOrigin(value)).toThrow(
        'must be an absolute HTTPS origin'
      );
    }
  });

  it('fails closed when a plan name or HAIP variant drifts', () => {
    const expected = OPENID4VC_PROFILES['oid4vp-haip'];
    expect(() =>
      assertOpenID4VCPlanBinding({
        profile: 'oid4vp-haip',
        actualPlanName: expected.planName,
        actualVariant: { ...expected.variant },
      })
    ).not.toThrow();

    expect(() =>
      assertOpenID4VCPlanBinding({
        profile: 'oid4vp-haip',
        actualPlanName: expected.planName,
        actualVariant: { ...expected.variant, response_mode: 'direct_post' },
      })
    ).toThrow('requires variant response_mode=direct_post.jwt');

    expect(() =>
      assertOpenID4VCPlanBinding({
        profile: 'oid4vci-haip',
        actualPlanName: 'oid4vp-1final-verifier-test-plan',
        actualVariant: { ...OPENID4VC_PROFILES['oid4vci-haip'].variant },
      })
    ).toThrow('requires oid4vci-1_0-issuer-test-plan');
  });
});
