import { describe, expect, it } from 'vitest';
import { generatePairwiseSubject } from '../../utils/pairwise';
import {
  base32,
  computeIdentifier,
  IdentifierComputationError,
  isSubjectIdentifierValue,
  type IdentifierComputation,
} from '../identifier-algorithms';
import { md5 } from '../md5';

/**
 * Expected values come from the other systems' own code paths, not from this module:
 * Shibboleth and Keycloak through Java's MessageDigest / UUID.nameUUIDFromBytes (the calls
 * their sources make), SimpleSAMLphp through a transcription of its PHP (hash('sha1'),
 * strlen byte lengths, hash_hmac('sha256')). See the plan of 2026-11-14 for the sources.
 */
const utf8 = (value: string) => new TextEncoder().encode(value);
const run = (input: Omit<IdentifierComputation, 'salt'> & { salt: string }) =>
  computeIdentifier({ ...input, salt: utf8(input.salt) });

describe('identifier algorithms reproduce their sources', () => {
  it('authrim_sha256 is the existing pairwise subject', async () => {
    const value = await run({
      algorithm: 'authrim_sha256',
      value: 'usr_1',
      audience: 'client-1',
      salt: 'authrim-salt',
    });
    expect(value).toBe('VMpSYcCuIhCAfs-JaYLplxsIlJ66dsBl1d_RpOGcbpU');
    expect(value).toBe(await generatePairwiseSubject('usr_1', 'client-1', 'authrim-salt'));
  });

  it('shibboleth: SHA-1, Base64 by default', async () => {
    await expect(
      run({
        algorithm: 'shibboleth',
        value: 'jdoe',
        audience: 'https://sp.example.org/shibboleth',
        salt: '0123456789abcdef-salt',
      })
    ).resolves.toBe('iXw0A3ZJeWL04PK1adRXebjDCVI=');
  });

  it('shibboleth: Base32 for pairwise-id', async () => {
    await expect(
      run({
        algorithm: 'shibboleth',
        value: 'jdoe',
        audience: 'https://sp.example.org/shibboleth',
        salt: '0123456789abcdef-salt',
        encoding: 'base32',
      })
    ).resolves.toBe('RF6DIA3WJF4WF5HA6K2WTVCXPG4MGCKS');
  });

  it('shibboleth: another digest and a non-ASCII value', async () => {
    await expect(
      run({
        algorithm: 'shibboleth',
        value: '山田',
        audience: 'https://sp.example.org/shibboleth',
        salt: '0123456789abcdef-salt',
        digest: 'SHA-256',
      })
    ).resolves.toBe('Rs/LPCCbihVl1zPhTEdhamUOvfhENvvYQolt/e+sIV8=');
  });

  it('keycloak_sha256: UUID.nameUUIDFromBytes of the SHA-256', async () => {
    await expect(
      run({
        algorithm: 'keycloak_sha256',
        value: '8f1c2b6e-1d2a-4c5b-9e3f-0a1b2c3d4e5f',
        audience: 'app.example.com',
        salt: 'kc-salt-value',
      })
    ).resolves.toBe('828cb4cc-3f15-3f07-b5e5-560bfef0a73d');
    await expect(
      run({
        algorithm: 'keycloak_sha256',
        value: 'ユーザー',
        audience: 'app.example.com',
        salt: 'kc-salt-value',
      })
    ).resolves.toBe('09f2106d-884c-327d-a4b6-ea34ef10e416');
  });

  const idp = 'https://idp.example.org';
  const sp = 'https://sp.example.org';

  it('simplesamlphp_targeted_id: metadata sets and byte lengths', async () => {
    const base = {
      algorithm: 'simplesamlphp_targeted_id' as const,
      issuer: idp,
      audience: sp,
      salt: 'sspsecretsalt',
      sourceMetadataSet: 'saml20-idp-hosted',
      destinationMetadataSet: 'saml20-sp-remote',
    };
    await expect(run({ ...base, value: 'jdoe' })).resolves.toBe(
      '605cd455fdb7d75dfb029bdaa2ac5ccc658f4577'
    );
    await expect(run({ ...base, value: '山田' })).resolves.toBe(
      '7aea5828480f91a0e9b1938b4eda3bf1f8cd5755'
    );
  });

  it('simplesamlphp_persistent_nameid: bare entity IDs and byte lengths', async () => {
    const base = {
      algorithm: 'simplesamlphp_persistent_nameid' as const,
      issuer: idp,
      audience: sp,
      salt: 'sspsecretsalt',
    };
    await expect(run({ ...base, value: 'jdoe' })).resolves.toBe(
      '6fd45f7ea323c6341c7b6a45e5f54e7beca39285'
    );
    await expect(run({ ...base, value: '山田' })).resolves.toBe(
      '001c17100d6a9ff1c91d49728a0d982e5b20f953'
    );
  });

  it('simplesamlphp_pairwise_id and subject_id: HMAC, lower case with the scope', async () => {
    const pairwise = await run({
      algorithm: 'simplesamlphp_pairwise_id',
      value: 'jdoe',
      audience: sp,
      salt: 'sspsecretsalt',
      scope: 'Example.ORG',
    });
    expect(pairwise).toBe(
      'e9b0f04a8599f01c1502aaabddee191d14cc5ac58573c64c276a1be3cf30f5e4@example.org'
    );
    expect(isSubjectIdentifierValue(pairwise)).toBe(true);
    await expect(
      run({
        algorithm: 'simplesamlphp_subject_id',
        value: 'jdoe',
        audience: '',
        salt: 'sspsecretsalt',
        scope: 'example.org',
      })
    ).resolves.toBe('0177757650cc74f88a89ea31b27a191fe28de04b0cf443cf370109b72cb67272@example.org');
  });

  it('refuses to compute without a value, a salt or what the algorithm needs', async () => {
    const base = { algorithm: 'authrim_sha256' as const, audience: 'c', salt: 's' };
    await expect(run({ ...base, value: '' })).rejects.toBeInstanceOf(IdentifierComputationError);
    await expect(run({ ...base, value: 'u', salt: '' })).rejects.toThrow('identifier.salt_missing');
    await expect(
      run({ algorithm: 'simplesamlphp_persistent_nameid', value: 'u', audience: sp, salt: 's' })
    ).rejects.toThrow('identifier.issuer_missing');
    await expect(
      run({ algorithm: 'simplesamlphp_pairwise_id', value: 'u', audience: sp, salt: 's' })
    ).rejects.toThrow('identifier.scope_missing');
  });
});

describe('building blocks', () => {
  it('md5 matches RFC 1321 test suite', () => {
    const hex = (bytes: Uint8Array) =>
      Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(hex(md5(utf8('')))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(hex(md5(utf8('abc')))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(hex(md5(utf8('message digest')))).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(
      hex(
        md5(
          utf8('12345678901234567890123456789012345678901234567890123456789012345678901234567890')
        )
      )
    ).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });

  it('base32 matches RFC 4648 test vectors', () => {
    expect(base32(utf8(''))).toBe('');
    expect(base32(utf8('f'))).toBe('MY======');
    expect(base32(utf8('fo'))).toBe('MZXQ====');
    expect(base32(utf8('foobar'))).toBe('MZXW6YTBOI======');
  });

  it('OASIS subject identifier grammar', () => {
    expect(isSubjectIdentifierValue('AbC=-1@example.org')).toBe(true);
    expect(isSubjectIdentifierValue('-abc@example.org')).toBe(false);
    expect(isSubjectIdentifierValue('ab_c@example.org')).toBe(false);
    expect(isSubjectIdentifierValue('abc@.example.org')).toBe(false);
    expect(isSubjectIdentifierValue(`${'a'.repeat(128)}@example.org`)).toBe(false);
  });
});
