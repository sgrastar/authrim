/**
 * Token Exchange: who may exchange a subject token (audience, allowed subject clients), the
 * account and consent it names (external subjects, withdrawals, release approval) and elevation
 * grant subject tokens.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SERVICE_CLIENT,
  baseClient,
  clientSubject,
  exchangeContext,
  expectError,
  issuedClaims,
  keyEnv,
  m,
  resetExchange,
  userSubject,
} from './helpers/mut-exchange-harness';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const h = await import('./helpers/mut-exchange-harness');
  return h.mockCore(await importOriginal());
});
vi.mock('../external-id-jag-verifier', async () =>
  (await import('./helpers/mut-exchange-harness')).mockJagVerifier()
);

import { tokenHandler } from '../token';

const REVOKED = 'Subject token is invalid or revoked';
const UNAVAILABLE = 'Account data is unavailable';
const ELEVATION_TYPE = 'urn:authrim:token-type:elevation-grant';

async function exchange(bodyOverrides: Record<string, unknown> = {}): Promise<Response> {
  return tokenHandler(exchangeContext(bodyOverrides, { env: await keyEnv() }));
}

function useClients(clients: Record<string, Record<string, unknown>>): void {
  m.getClientCached.mockImplementation(
    async (_c: unknown, _e: unknown, id: string) => clients[id] ?? null
  );
}

describe('who may exchange the subject token', () => {
  beforeEach(() => resetExchange());

  const issuedTo = (aud: string[]) =>
    clientSubject({ sub: 'client:issuer-app', client_id: 'issuer-app', aud });

  it('lets an allowed subject client exchange tokens issued to itself', async () => {
    useClients({
      [SERVICE_CLIENT]: baseClient({ allowed_subject_token_clients: ['issuer-app'] }),
      'issuer-app': { client_id: 'issuer-app' },
    });
    m.parseToken.mockReturnValue(issuedTo(['issuer-app']));
    expect((await exchange()).status).toBe(200);
    expect(issuedClaims()).toMatchObject({
      sub: 'client:issuer-app',
      client_id: SERVICE_CLIENT,
      authrim_subject_principal: 'client',
    });
  });

  it.each([
    ['its audience does not name it', ['issuer-app'], ['somewhere-else']],
    ['it is not in the allowed list', ['other-app'], ['issuer-app']],
    ['no subject client is allowed', [], ['issuer-app']],
  ])('refuses a token of another client when %s', async (_name, allowed, aud) => {
    useClients({
      [SERVICE_CLIENT]: baseClient({ allowed_subject_token_clients: allowed }),
      'issuer-app': { client_id: 'issuer-app' },
    });
    m.parseToken.mockReturnValue(issuedTo(aud));
    await expectError(
      await exchange(),
      403,
      'invalid_target',
      'Client is not authorized to exchange this token'
    );
  });

  it('judges the issuing client by client_id before azp', async () => {
    useClients({
      [SERVICE_CLIENT]: baseClient({ allowed_subject_token_clients: ['issuer-app'] }),
      'issuer-app': { client_id: 'issuer-app' },
    });
    m.parseToken.mockReturnValue({ ...issuedTo(['issuer-app']), azp: 'somebody' });
    expect((await exchange()).status).toBe(200);
  });
});

describe('the account a user subject token names', () => {
  beforeEach(() => resetExchange());

  it('refuses a user token that does not show which account it names', async () => {
    m.parseToken.mockReturnValue(userSubject({ jti: undefined }));
    await expectError(await exchange(), 400, 'invalid_grant', REVOKED);
    expect(m.resolveAccountDataContextFromHono).not.toHaveBeenCalled();
  });

  it('records the consent generation and release approval of the same app', async () => {
    m.findOAuthClientConsentRevocation.mockResolvedValue({ generation: 4, revokedAt: null });
    m.parseToken.mockReturnValue(userSubject({ authrim_release: ['name', 'email', 'email'] }));
    expect((await exchange()).status).toBe(200);
    expect(m.findOAuthClientConsentRevocation).toHaveBeenCalledWith(m.accountAdapter, {
      tenantId: 'default',
      userId: 'user-1',
      clientId: SERVICE_CLIENT,
    });
    expect(issuedClaims()).toMatchObject({
      sub: 'user-1',
      authrim_consent_generation: 4,
      authrim_release: ['email', 'name'],
    });
    expect(issuedClaims().authrim_consent_client_id).toBeUndefined();
  });

  it('keeps the generation the subject token recorded and an empty approval by default', async () => {
    m.findOAuthClientConsentRevocation.mockResolvedValue({ generation: 2, revokedAt: null });
    m.parseToken.mockReturnValue(userSubject({ authrim_consent_generation: 2 }));
    expect((await exchange()).status).toBe(200);
    expect(issuedClaims()).toMatchObject({ authrim_consent_generation: 2, authrim_release: [] });
  });

  it('gives another app no release approval and records whose consent it is', async () => {
    useClients({
      [SERVICE_CLIENT]: baseClient({ allowed_subject_token_clients: ['issuer-app'] }),
      'issuer-app': { client_id: 'issuer-app' },
    });
    m.derivedSubject.value = 'user-1';
    m.parseToken.mockReturnValue(
      userSubject({ client_id: 'issuer-app', aud: ['issuer-app'], authrim_release: ['email'] })
    );
    expect((await exchange()).status).toBe(200);
    expect(issuedClaims()).toMatchObject({
      authrim_release: [],
      authrim_consent_client_id: 'issuer-app',
    });
  });

  it('refuses a token whose consent was withdrawn', async () => {
    m.findOAuthClientConsentRevocation.mockResolvedValue({ generation: 3, revokedAt: 1 });
    m.parseToken.mockReturnValue(userSubject({ authrim_consent_generation: 2 }));
    await expectError(await exchange(), 400, 'invalid_grant', REVOKED);
  });

  it('answers 503 when the consent withdrawal cannot be read', async () => {
    m.findOAuthClientConsentRevocation.mockRejectedValue(new Error('db'));
    await expectError(
      await exchange(),
      503,
      'temporarily_unavailable',
      'Consent state is unavailable'
    );
  });

  it.each([
    ['account_data_route_not_found', 400, 'invalid_grant', REVOKED],
    ['account_data_account_id_invalid', 400, 'invalid_grant', REVOKED],
    ['lookup_destination_revalidation_failed', 400, 'invalid_grant', REVOKED],
    ['account_data_route_unavailable', 503, 'temporarily_unavailable', UNAVAILABLE],
  ])('answers a %s account route failure', async (code, status, error, description) => {
    m.resolveAccountDataContextFromHono.mockRejectedValue(new Error(code));
    await expectError(await exchange(), status, error, description);
  });

  it('answers 503 for an account route failure that is not an Error', async () => {
    m.resolveAccountDataContextFromHono.mockRejectedValue('boom');
    await expectError(await exchange(), 503, 'temporarily_unavailable', UNAVAILABLE);
  });
});

describe('a subject asserted by an external issuer', () => {
  const ISSUER = 'https://trusted.example';

  beforeEach(() => {
    resetExchange();
    m.parseToken.mockReturnValue(
      userSubject({ sub: 'external-subject', authrim_subject_issuer: ISSUER })
    );
  });

  it('carries the issuer on when the subject has no account here', async () => {
    m.resolveAccountDataContextFromHono.mockRejectedValue(
      new Error('account_data_route_not_found')
    );
    expect((await exchange()).status).toBe(200);
    expect(m.readAccountAuthenticationState).toHaveBeenCalledWith(
      expect.anything(),
      'default',
      'external-subject'
    );
    const claims = issuedClaims();
    expect(claims).toMatchObject({ sub: 'external-subject', authrim_subject_issuer: ISSUER });
    expect(claims).not.toHaveProperty('authrim_consent_generation');
    expect(m.findOAuthClientConsentRevocation).not.toHaveBeenCalled();
  });

  it('does not read the authentication state of an id that cannot be an account', async () => {
    m.resolveAccountDataContextFromHono.mockRejectedValue(
      new Error('account_data_account_id_invalid')
    );
    expect((await exchange()).status).toBe(200);
    expect(m.readAccountAuthenticationState).not.toHaveBeenCalled();
  });

  it('refuses a subject whose deleted account left its authentication state', async () => {
    m.resolveAccountDataContextFromHono.mockRejectedValue(
      new Error('account_data_route_not_found')
    );
    m.readAccountAuthenticationState.mockResolvedValue({ lifecycle: 'deleted' });
    await expectError(await exchange(), 400, 'invalid_grant', REVOKED);
  });

  it('treats an invalid identity in the authentication state as no account', async () => {
    m.resolveAccountDataContextFromHono.mockRejectedValue(
      new Error('account_data_route_not_found')
    );
    m.readAccountAuthenticationState.mockRejectedValue(
      new Error('session_revocation_identity_invalid')
    );
    expect((await exchange()).status).toBe(200);
  });

  it.each([[new Error('db down')], ['not an error']])(
    'answers 503 when the authentication state cannot be read (%s)',
    async (failure) => {
      m.resolveAccountDataContextFromHono.mockRejectedValue(
        new Error('account_data_route_not_found')
      );
      m.readAccountAuthenticationState.mockRejectedValue(failure);
      await expectError(await exchange(), 503, 'temporarily_unavailable', UNAVAILABLE);
    }
  );

  it('keeps the account and consent of an external subject that has one', async () => {
    m.findOAuthClientConsentRevocation.mockResolvedValue({ generation: 1, revokedAt: null });
    expect((await exchange()).status).toBe(200);
    expect(issuedClaims()).toMatchObject({ authrim_consent_generation: 1 });
  });
});

describe('elevation grant subject tokens', () => {
  const elevationPayload = {
    iss: 'https://auth.example.com',
    sub: 'user-1',
    aud: [SERVICE_CLIENT],
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: 'subject-jti-1',
    token_use: 'elevation_grant_subject',
  };

  beforeEach(() => {
    resetExchange();
    m.parseToken.mockReturnValue(elevationPayload);
    m.resolveElevationGrantSubjectToken.mockResolvedValue({
      grant: { public_grant_id: 'egr_1', resource_class: 'profile', redaction_level: 'masked' },
      request: {
        public_request_id: 'apr_1',
        investigation_id: 'inv_1',
        target_subject_type: 'user',
        target_subject_id: 'user-1',
        requester_subject_type: 'admin_user',
        requester_subject_id: 'admin-1',
      },
      authorizationDetails: [{ type: 'authrim_break_glass' }],
      actClaim: { sub: 'admin_user:admin-1', client_id: SERVICE_CLIENT },
    });
  });

  it('exchanges one with no client_id, acting for the approving admin', async () => {
    expect((await exchange({ subject_token_type: ELEVATION_TYPE })).status).toBe(200);
    expect(issuedClaims()).toMatchObject({
      act: { sub: 'admin_user:admin-1', client_id: SERVICE_CLIENT },
      authrim_elevation: { grant_id: 'egr_1', request_id: 'apr_1' },
    });
  });

  it('refuses one declared as an access token', async () => {
    await expectError(
      await exchange(),
      400,
      'invalid_grant',
      'Elevation grant subject tokens must be exchanged as elevation grant tokens'
    );
  });

  it.each([
    [new Error('Elevation grant has expired'), 'Elevation grant has expired'],
    ['not an error', 'Invalid elevation grant subject token'],
  ])('refuses one whose grant does not resolve (%s)', async (failure, description) => {
    m.resolveElevationGrantSubjectToken.mockRejectedValue(failure);
    await expectError(
      await exchange({ subject_token_type: ELEVATION_TYPE }),
      400,
      'invalid_grant',
      description
    );
    expect(m.requireDedicatedAdminDatabaseAdapter).toHaveBeenCalledWith(
      expect.anything(),
      'token-exchange-elevation-grant'
    );
  });
});
