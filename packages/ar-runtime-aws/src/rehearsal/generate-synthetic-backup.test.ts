import { describe, expect, it } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  assertLocalFixtureDatabase,
  parseSyntheticFixtureArguments,
} from './generate-synthetic-backup';
import {
  fromBase64url,
  resolveSyntheticFixtureProfile,
  softwarePasskey,
  type SyntheticFixtureProfile,
} from './synthetic-fixture';

describe('synthetic backup generator connection boundary', () => {
  it.each(['127.0.0.1', 'localhost', '[::1]'])('accepts loopback %s', (host) => {
    expect(assertLocalFixtureDatabase(`postgresql://fixture@${host}:5432/postgres`).hostname).toBe(
      host
    );
  });

  it.each([
    'postgresql://fixture@db.example.test/postgres',
    'postgresql://fixture@authrim.c1.example.rds.amazonaws.com/postgres',
    'postgresql://fixture@127.0.0.1/postgres?host=remote.example.test',
    'postgresql://fixture@127.0.0.1/postgres?hostaddr=203.0.113.1',
    'postgresql://fixture@127.0.0.1/postgres?service=production',
    'https://localhost/postgres',
  ])('rejects remote or redirected connections: %s', (url) => {
    expect(() => assertLocalFixtureDatabase(url)).toThrow(
      'aws_synthetic_fixture_local_database_required'
    );
  });
});

const issuer = 'https://abcdefghij.execute-api.ap-northeast-1.amazonaws.com';
const browserProfile = {
  kind: 'aws-browser' as const,
  issuer,
  spEntityId: `${issuer}/test-sp/metadata`,
  acsUrl: `${issuer}/test-sp/acs`,
};

describe('synthetic browser fixture identity boundary', () => {
  it('preserves the original fixture profile when no profile is supplied', () => {
    expect(resolveSyntheticFixtureProfile()).toMatchObject({
      kind: 'in-process',
      issuer: 'https://tenant-a.example.test',
      spEntityId: 'https://sp.example.test/entity',
      acsUrl: 'https://sp.example.test/acs',
      environmentName: 'aws-synthetic-rehearsal',
      rpId: 'tenant-a.example.test',
    });
  });

  it('binds a separate synthetic browser fixture to the exact AWS hostname', () => {
    expect(resolveSyntheticFixtureProfile(browserProfile)).toEqual({
      ...browserProfile,
      environmentName: 'aws-browser-rehearsal',
      rpId: 'abcdefghij.execute-api.ap-northeast-1.amazonaws.com',
    });
  });

  it.each([
    null,
    [],
    { kind: 'production' },
    { kind: 'in-process', issuer },
    { ...browserProfile, issuer: 'https://customer.example.com' },
    { ...browserProfile, issuer: issuer.replace('https:', 'http:') },
    { ...browserProfile, issuer: issuer.replace('ap-northeast-1', 'us-east-1') },
    { ...browserProfile, issuer: `${issuer}/stage` },
    { ...browserProfile, issuer: `${issuer}/` },
    { ...browserProfile, issuer: `${issuer}?redirect=1` },
    { ...browserProfile, issuer: `${issuer}:8443` },
    { ...browserProfile, issuer: issuer.replace('https://', 'https://user:password@') },
    { ...browserProfile, issuer: `${issuer}.attacker.example.test` },
    { ...browserProfile, acsUrl: 'https://sp.example.test/acs' },
    { ...browserProfile, acsUrl: `${issuer}/saml/idp/sso` },
    { ...browserProfile, spEntityId: `${issuer}/another-sp` },
    { ...browserProfile, tenantId: 'production-tenant' },
  ])('rejects non-synthetic or mismatched profile %j', (profile) => {
    expect(() => resolveSyntheticFixtureProfile(profile as SyntheticFixtureProfile)).toThrow(
      'aws_synthetic_fixture_profile_invalid'
    );
  });

  it('exports the same passkey as private JWK and CDP-compatible PKCS#8 while binding WebAuthn to the AWS host', async () => {
    const credential = await softwarePasskey(browserProfile);
    const pkcs8 = Uint8Array.from(atob(credential.privateKeyPkcs8Base64), (character) =>
      character.charCodeAt(0)
    );
    const imported = await webcrypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign']
    );
    const privateJwk = await webcrypto.subtle.exportKey('jwk', imported);
    expect(privateJwk).toMatchObject({
      d: credential.privateJwk.d,
      x: credential.privateJwk.x,
      y: credential.privateJwk.y,
    });
    const assertion = await credential.sign('synthetic-challenge', 'user-tenant-a');
    expect(
      JSON.parse(
        new TextDecoder().decode(fromBase64url(assertion.response.clientDataJSON))
      ) as unknown
    ).toMatchObject({ origin: issuer, challenge: 'synthetic-challenge', type: 'webauthn.get' });
    const authData = fromBase64url(assertion.response.authenticatorData);
    const expectedRpHash = new Uint8Array(
      await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(new URL(issuer).hostname))
    );
    expect(authData.slice(0, 32)).toEqual(expectedRpHash);
  });

  it('binds generated external credentials to the captured UI origin and leaves issuer identity intact', async () => {
    const externalLogin = {
      mode: 'external' as const,
      baseUrl: 'https://login.example.test',
      clientId: 'test-external-ui',
      paths: { login: '/sign-in', reauth: '/again' },
    };
    const profile = { ...browserProfile, externalLogin };
    expect(resolveSyntheticFixtureProfile(profile)).toMatchObject({
      issuer,
      externalLogin,
      rpId: 'login.example.test',
    });
    const credential = await softwarePasskey(profile);
    const assertion = await credential.sign('challenge', 'user-tenant-a');
    expect(
      JSON.parse(new TextDecoder().decode(fromBase64url(assertion.response.clientDataJSON)))
    ).toMatchObject({ origin: externalLogin.baseUrl });
    expect(fromBase64url(assertion.response.authenticatorData).slice(0, 32)).toEqual(
      new Uint8Array(
        await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('login.example.test'))
      )
    );
    for (const invalid of [
      { ...externalLogin, baseUrl: 'http://login.example.test' },
      { mode: 'disabled' },
      { ...externalLogin, clientId: '' },
    ]) {
      expect(() =>
        resolveSyntheticFixtureProfile({
          ...browserProfile,
          externalLogin: invalid,
        } as SyntheticFixtureProfile)
      ).toThrow('aws_synthetic_fixture_profile_invalid');
    }
  });

  it('accepts the optional profile file without changing the existing CLI arguments', () => {
    expect(
      parseSyntheticFixtureArguments(['--out', 'new-output', '--migrations', 'migrations'])
    ).toEqual({
      directory: 'new-output',
      migrationDirectory: 'migrations',
      profilePath: undefined,
    });
    expect(
      parseSyntheticFixtureArguments([
        '--out',
        'new-output',
        '--migrations',
        'migrations',
        '--profile',
        'browser-profile.json',
      ])
    ).toHaveProperty('profilePath', 'browser-profile.json');
    expect(() =>
      parseSyntheticFixtureArguments([
        '--out',
        'new-output',
        '--migrations',
        'migrations',
        '--issuer',
        issuer,
      ])
    ).toThrow('aws_synthetic_fixture_arguments_invalid');
  });
});
