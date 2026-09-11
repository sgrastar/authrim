import { describe, expect, it } from 'vitest';
import {
  guestResumeCredentialLookupSubject,
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

  it('uses an Authrim-owned issuer for hashed browser guest resume credentials', () => {
    expect(guestResumeCredentialLookupSubject('a'.repeat(64))).toEqual({
      issuer: 'urn:authrim:guest-resume:v1',
      subject: 'a'.repeat(64),
    });
    expect(() => guestResumeCredentialLookupSubject('raw-resume-credential')).toThrow(
      'guest_resume_credential_digest_invalid'
    );
  });
});
