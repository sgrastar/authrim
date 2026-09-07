import { describe, expect, it } from 'vitest';
import {
  anonymousDeviceLookupSubject,
  passkeyCredentialLookupSubject,
} from '../account-provisioning';

describe('account provisioning routing subjects', () => {
  it('namespaces normalized passkey credentials by RP ID', () => {
    expect(
      passkeyCredentialLookupSubject({
        rpId: 'Login.Example.COM.',
        credentialId: 'Abc_123-xyz',
      })
    ).toEqual({
      issuer: 'urn:authrim:passkey:login.example.com',
      subject: 'Abc_123-xyz',
    });
  });

  it.each([
    { rpId: 'https://example.com', credentialId: 'credential' },
    { rpId: 'example..com', credentialId: 'credential' },
    { rpId: 'example.com', credentialId: 'not+base64url' },
    { rpId: 'example.com', credentialId: '' },
  ])('rejects malformed passkey routing input without normalization fallback', (input) => {
    expect(() => passkeyCredentialLookupSubject(input)).toThrow(/passkey_route_/u);
  });

  it('uses an Authrim-owned issuer for already-HMACed anonymous device identifiers', () => {
    expect(anonymousDeviceLookupSubject('a'.repeat(64))).toEqual({
      issuer: 'urn:authrim:anonymous-device:v1',
      subject: 'a'.repeat(64),
    });
    expect(() => anonymousDeviceLookupSubject('raw-device-id')).toThrow(
      'anonymous_device_route_digest_invalid'
    );
  });
});
