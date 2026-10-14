import { describe, expect, it } from 'vitest';
import {
  didLookupSubject,
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

  it('indexes a DID under the plain did issuer that DID login and linking both use', () => {
    expect(didLookupSubject('did:web:example.com')).toEqual({
      issuer: 'did',
      subject: 'did:web:example.com',
    });
    for (const invalid of ['example.com', '', `did:web:${'a'.repeat(2100)}`]) {
      expect(() => didLookupSubject(invalid)).toThrow('did_route_subject_invalid');
    }
  });

  it('enforces the lookup directory limits on DIDs (1024 UTF-8 bytes, no control characters)', () => {
    const atLimit = `did:web:${'a'.repeat(1024 - 'did:web:'.length)}`;
    expect(new TextEncoder().encode(atLimit).byteLength).toBe(1024);
    expect(didLookupSubject(atLimit)).toEqual({ issuer: 'did', subject: atLimit });

    const overByOne = `${atLimit}a`;
    // Fewer characters than bytes: 8 + 340 * 3 = 1028 bytes in 348 characters.
    const multibyte = `did:web:${'\u3042'.repeat(340)}`;
    expect(multibyte.length).toBeLessThan(1024);
    expect(new TextEncoder().encode(multibyte).byteLength).toBeGreaterThan(1024);
    for (const invalid of [
      overByOne,
      multibyte,
      'did:web:exa\u0007mple.com',
      'did:web:exa\nmple.com',
      'did:web:example.com\u007f',
      ' did:web:example.com',
      'did:web:example.com ',
    ]) {
      expect(() => didLookupSubject(invalid)).toThrow('did_route_subject_invalid');
    }
  });
});
