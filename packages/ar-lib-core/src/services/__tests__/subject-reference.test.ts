import { describe, expect, it } from 'vitest';
import {
  isSubjectReferenceAvailable,
  openSubjectReference,
  sealSubjectReference,
  nonAccountPrincipalKind,
  tokenNamesAccountSubject,
  tokenRecordsUserGrant,
} from '../subject-reference';

const env = { OBJECT_ENCRYPTION_ROOT_KEY: 'ef'.repeat(32) };
const binding = { tenantId: 'tenant-a', clientId: 'app' };

describe('subject reference', () => {
  it('opens for the tenant and client it was sealed for', async () => {
    const reference = await sealSubjectReference(env, binding, 'user-1');
    expect(reference).not.toContain('user-1');
    await expect(openSubjectReference(env, binding, reference)).resolves.toBe('user-1');
  });

  it('does not open for another tenant, client or key, nor a malformed value', async () => {
    const reference = await sealSubjectReference(env, binding, 'user-1');
    await expect(
      openSubjectReference(env, { tenantId: 'tenant-b', clientId: 'app' }, reference)
    ).resolves.toBeNull();
    await expect(
      openSubjectReference(env, { tenantId: 'tenant-a', clientId: 'other' }, reference)
    ).resolves.toBeNull();
    await expect(
      openSubjectReference({ OBJECT_ENCRYPTION_ROOT_KEY: '01'.repeat(32) }, binding, reference)
    ).resolves.toBeNull();
    await expect(openSubjectReference(env, binding, 'sr1.x')).resolves.toBeNull();
    await expect(openSubjectReference(env, binding, 'user-1')).resolves.toBeNull();
  });

  it('is unavailable without a valid root key', async () => {
    expect(isSubjectReferenceAvailable({})).toBe(false);
    expect(isSubjectReferenceAvailable({ OBJECT_ENCRYPTION_ROOT_KEY: 'short' })).toBe(false);
    await expect(sealSubjectReference({}, binding, 'user-1')).rejects.toThrow(
      'subject_reference_key_unavailable'
    );
  });
});

describe('token subject kind', () => {
  it('takes the principals their issuance paths signed for non-account subjects', () => {
    // Client credentials, an admin machine, an admin agent delegation, as issued.
    expect(
      tokenNamesAccountSubject({
        sub: 'client:payments',
        client_id: 'payments',
        token_use: 'access',
        jti: 'jti-1',
      })
    ).toBe(false);
    expect(
      tokenNamesAccountSubject({
        sub: 'machine:m-1',
        actor_type: 'machine',
        actor_id: 'm-1',
        token_use: 'access',
        jti: 'jti-1',
      })
    ).toBe(false);
    expect(
      tokenNamesAccountSubject({
        sub: 'admin_user:a-1',
        grant_id: 'grant-1',
        actor_mode: 'mode_a',
        token_use: 'refresh',
        jti: 'jti-1',
      })
    ).toBe(false);
    expect(tokenNamesAccountSubject({ sub: 'user-1', token_use: 'access', jti: 'jti-1' })).toBe(
      true
    );
  });

  it('does not take a principal without a JWT ID, as a legacy mapped ID token could look', () => {
    // An identity mapping could once emit sub, client_id and token_use on an ID token, never jti.
    const legacyIdToken = { sub: 'client:alice', client_id: 'alice', token_use: 'access' };
    expect(nonAccountPrincipalKind(legacyIdToken)).toBeNull();
    expect(tokenNamesAccountSubject(legacyIdToken)).toBe(true);
    expect(nonAccountPrincipalKind({ ...legacyIdToken, jti: '' })).toBeNull();
    expect(
      nonAccountPrincipalKind({
        ...legacyIdToken,
        client_id: 'x',
        authrim_subject_principal: 'client',
      })
    ).toBeNull();
    expect(nonAccountPrincipalKind({ ...legacyIdToken, jti: 'jti-1' })).toBe('client');
  });

  it('does not take a principal-looking sub alone for a non-account subject', () => {
    // An ID token (no token_use) from a mapping that issued such a sub is for a user.
    expect(tokenNamesAccountSubject({ sub: 'client:alice', aud: 'alice' })).toBe(true);
    // An access token whose client is not the one its sub names (an exchange of such an ID token).
    expect(
      tokenNamesAccountSubject({
        sub: 'client:alice',
        client_id: 'exchanger',
        token_use: 'access',
        jti: 'jti-1',
      })
    ).toBe(true);
    expect(
      tokenNamesAccountSubject({ sub: 'machine:m-1', token_use: 'access', jti: 'jti-1' })
    ).toBe(true);
    expect(
      tokenNamesAccountSubject({ sub: 'admin_user:a-1', token_use: 'access', jti: 'jti-1' })
    ).toBe(true);
  });

  it("takes a user's grant for an account, whatever its public sub looks like", () => {
    expect(
      tokenNamesAccountSubject({
        sub: 'client:alice',
        client_id: 'alice',
        token_use: 'access',
        jti: 'jti-1',
        authrim_consent_generation: 0,
      })
    ).toBe(true);
    expect(tokenNamesAccountSubject({ sub: 'client:alice', authrim_subject_ref: 'sr1.a.b' })).toBe(
      true
    );
    expect(tokenRecordsUserGrant({ sub: 'client:alice' })).toBe(false);
  });
});

describe('subject principal of an exchanged token', () => {
  it('takes the principal a Token Exchange recorded, across another client_id', () => {
    const exchanged = {
      sub: 'client:payments',
      client_id: 'exchanger',
      token_use: 'access',
      jti: 'jti-1',
      authrim_subject_principal: 'client',
    };
    expect(nonAccountPrincipalKind(exchanged)).toBe('client');
    expect(tokenNamesAccountSubject(exchanged)).toBe(false);
    expect(
      nonAccountPrincipalKind({
        sub: 'machine:m-1',
        client_id: 'exchanger',
        token_use: 'access',
        jti: 'jti-1',
        authrim_subject_principal: 'machine',
      })
    ).toBe('machine');
    expect(
      nonAccountPrincipalKind({
        sub: 'admin_user:a-1',
        client_id: 'exchanger',
        token_use: 'access',
        jti: 'jti-1',
        authrim_subject_principal: 'admin_agent',
      })
    ).toBe('admin_agent');
  });

  it('does not take a recorded principal that does not match the sub, or on an ID token or a user grant', () => {
    // Its namespace must match the sub's.
    expect(
      nonAccountPrincipalKind({
        sub: 'machine:m-1',
        token_use: 'access',
        jti: 'jti-1',
        authrim_subject_principal: 'client',
      })
    ).toBeNull();
    expect(
      nonAccountPrincipalKind({
        sub: 'user-1',
        token_use: 'access',
        jti: 'jti-1',
        authrim_subject_principal: 'client',
      })
    ).toBeNull();
    // An ID token (no token_use) carrying it, as a mapping or custom claim might have put it.
    expect(
      nonAccountPrincipalKind({ sub: 'client:alice', authrim_subject_principal: 'client' })
    ).toBeNull();
    // A user's grant names an account.
    expect(
      nonAccountPrincipalKind({
        sub: 'client:alice',
        token_use: 'access',
        jti: 'jti-1',
        authrim_consent_generation: 0,
        authrim_subject_principal: 'client',
      })
    ).toBeNull();
    expect(
      nonAccountPrincipalKind({
        sub: 'client:alice',
        token_use: 'access',
        jti: 'jti-1',
        authrim_subject_principal: 'unknown',
      })
    ).toBeNull();
  });
});
