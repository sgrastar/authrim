import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';

const { storeChallengeRpc } = vi.hoisted(() => ({ storeChallengeRpc: vi.fn() }));

vi.mock('../../utils/challenge-sharding', () => ({
  getChallengeStoreByChallengeId: vi.fn(async () => ({ storeChallengeRpc })),
}));

import {
  buildSAMLSSOResumePath,
  createSAMLReauthChallenge,
  isSAMLAuthorizationChallenge,
  readSAMLAuthorizationChallengeBinding,
} from '../saml-authorization-challenge';

const input = {
  tenantId: 'tenant-a',
  requestId: '_request-1',
  spEntityId: 'https://sp.example.test/entity',
  subjectUserId: 'user-a',
  issuedAt: 1_700_000_000_000,
  issuer: 'https://tenant.example.test',
  ttlSeconds: 300,
};

describe('createSAMLReauthChallenge', () => {
  it('stores a reauth challenge bound to the request, the SP, the tenant and the person', async () => {
    storeChallengeRpc.mockResolvedValueOnce({ success: true });
    const id = await createSAMLReauthChallenge({} as Env, input);

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const stored = storeChallengeRpc.mock.calls.at(-1)?.[0];
    expect(stored).toMatchObject({
      id,
      tenantId: 'tenant-a',
      type: 'reauth',
      userId: 'user-a',
      ttl: 300,
      metadata: {
        protocol: 'saml',
        saml_request_id: '_request-1',
        saml_sp_entity_id: 'https://sp.example.test/entity',
        tenant_id: 'tenant-a',
        // The names the OIDC re-authentication checks read.
        sessionUserId: 'user-a',
        reauth_issued_at: 1_700_000_000_000,
      },
    });
    // Nothing about an assurance level is kept in it.
    expect(JSON.stringify(stored)).not.toMatch(/AAL|IAL/);
  });

  it('does not return an id when the challenge could not be stored', async () => {
    storeChallengeRpc.mockRejectedValueOnce(new Error('unavailable'));
    await expect(createSAMLReauthChallenge({} as Env, input)).rejects.toThrow('unavailable');
  });
});

describe('readSAMLAuthorizationChallengeBinding', () => {
  const stored = async () => {
    storeChallengeRpc.mockResolvedValueOnce({ success: true });
    await createSAMLReauthChallenge({} as Env, input);
    const request = storeChallengeRpc.mock.calls.at(-1)?.[0];
    return { tenantId: request.tenantId as string, metadata: request.metadata };
  };

  it('reads the binding of a SAML challenge', async () => {
    expect(readSAMLAuthorizationChallengeBinding(await stored())).toEqual({
      requestId: '_request-1',
      spEntityId: 'https://sp.example.test/entity',
      tenantId: 'tenant-a',
      issuer: 'https://tenant.example.test',
    });
  });

  it('reads none for an OIDC challenge (no protocol)', () => {
    const oidc = {
      tenantId: 'tenant-a',
      metadata: { client_id: 'client', sessionUserId: 'user-a', reauth_issued_at: 1 },
    };
    expect(isSAMLAuthorizationChallenge(oidc.metadata)).toBe(false);
    expect(readSAMLAuthorizationChallengeBinding(oidc)).toBeNull();
  });

  it.each([
    ['without the request', { saml_request_id: undefined }],
    ['without the SP', { saml_sp_entity_id: undefined }],
    ['with a tenant that disagrees with the challenge', { tenant_id: 'tenant-b' }],
    ['with a protocol that is not SAML', { protocol: 'oidc' }],
  ])('reads none for a SAML challenge %s', async (_name, change) => {
    const challenge = await stored();
    expect(
      readSAMLAuthorizationChallengeBinding({
        ...challenge,
        metadata: { ...challenge.metadata, ...change },
      })
    ).toBeNull();
  });
});

describe('buildSAMLSSOResumePath', () => {
  it('resumes the request the challenge is bound to', () => {
    expect(
      buildSAMLSSOResumePath({ requestId: '_request-1', spEntityId: 'https://sp.example.test/e' })
    ).toBe(
      '/saml/idp/sso?saml_request_id=_request-1&saml_sp_entity_id=https%3A%2F%2Fsp.example.test%2Fe&return_to=saml_sso'
    );
  });
});
