/**
 * External callback: how a failure is classified for the logs and the diagnostics.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { M, setupCallbackMocks } from './helpers/callback-mocks';
import { callback } from './helpers/callback-harness';
import { classifyFapi2CallbackError } from '../handlers/callback';

beforeEach(setupCallbackMocks);

const jose = (code: string, claim?: string, reason?: string) =>
  Object.assign(new Error('jose'), { code, claim, reason });

describe('classifyFapi2CallbackError', () => {
  it.each([
    ['Malformed JARM response', 'malformed_jarm'],
    ['Missing JARM authorization response', 'missing_jarm_response'],
    ['Unexpected JARM authorization response', 'unexpected_jarm_response'],
    ['FAPI2 authorization response issuer mismatch', 'issuer_mismatch'],
    ['Missing FAPI2 issuer parameter', 'missing_issuer'],
    ['JARM response audience must contain only the client_id', 'audience_mismatch'],
    ['JARM response state mismatch', 'state_mismatch'],
    ['JARM response missing iss', 'missing_issuer'],
    ['JARM response missing state', 'missing_state'],
    ['JARM response has invalid code', 'invalid_code'],
    ['JARM response has invalid error', 'invalid_error'],
    ['JARM response contains neither code nor error', 'missing_code_or_error'],
    ['Token response missing access_token', 'missing_access_token'],
    ['Token response token_type must be DPoP', 'invalid_token_type'],
    ['Token response has invalid expires_in', 'invalid_expires_in'],
  ])('maps the message %s to %s', (message, expected) => {
    expect(classifyFapi2CallbackError(new Error(message))).toBe(expected);
  });

  it.each([
    [jose('ERR_JOSE_ALG_NOT_ALLOWED'), 'unexpected_signing_algorithm'],
    [jose('ERR_JWS_SIGNATURE_VERIFICATION_FAILED'), 'invalid_signature'],
    [jose('ERR_JWKS_NO_MATCHING_KEY'), 'signing_key_not_found'],
    [jose('ERR_JWS_INVALID'), 'malformed_jwt'],
    [jose('ERR_JWT_INVALID'), 'malformed_jwt'],
    [jose('ERR_JWT_EXPIRED'), 'expired_expiration'],
    [jose('ERR_JWT_CLAIM_VALIDATION_FAILED', 'iss', 'check_failed'), 'issuer_mismatch'],
    [jose('ERR_JWT_CLAIM_VALIDATION_FAILED', 'iss', 'Missing claim'), 'missing_issuer'],
    [jose('ERR_JWT_CLAIM_VALIDATION_FAILED', 'aud', 'check_failed'), 'audience_mismatch'],
    [jose('ERR_JWT_CLAIM_VALIDATION_FAILED', 'aud', 'MISSING'), 'missing_audience'],
    [jose('ERR_JWT_CLAIM_VALIDATION_FAILED', 'exp', 'check_failed'), 'invalid_expiration'],
    [jose('ERR_JWT_CLAIM_VALIDATION_FAILED', 'exp', 'missing'), 'missing_expiration'],
    [jose('ERR_JWT_CLAIM_VALIDATION_FAILED', 'nonce', 'check_failed'), 'nonce_mismatch'],
    [jose('ERR_JWT_CLAIM_VALIDATION_FAILED', 'nonce', 'missing'), 'missing_nonce'],
    [jose('ERR_JWT_CLAIM_VALIDATION_FAILED', 'other', 'check_failed'), 'claim_validation_failed'],
    [jose('ERR_JWT_CLAIM_VALIDATION_FAILED', 'other', 'missing'), 'missing_required_claim'],
    [jose('ERR_JWT_CLAIM_VALIDATION_FAILED'), 'claim_validation_failed'],
    [jose('ERR_OTHER'), 'fapi2_validation_failed'],
  ])('maps the jose error %s to %s', (error, expected) => {
    expect(classifyFapi2CallbackError(error)).toBe(expected);
  });

  it.each([
    ['the nonce is missing', 'missing_nonce'],
    ['the nonce is wrong', 'nonce_mismatch'],
    ['bad audience', 'audience_mismatch'],
    ['bad issuer', 'issuer_mismatch'],
    ['bad signature', 'invalid_signature'],
    ['something else', 'fapi2_validation_failed'],
    ['nonce audience issuer signature', 'nonce_mismatch'],
    ['audience issuer signature', 'audience_mismatch'],
    ['issuer signature', 'issuer_mismatch'],
  ])('falls back on the words of "%s"', (message, expected) => {
    expect(classifyFapi2CallbackError(new Error(message))).toBe(expected);
  });

  it('treats a value that is not an error as unclassified', () => {
    for (const value of [undefined, null, 'Malformed JARM response', 5]) {
      expect(classifyFapi2CallbackError(value)).toBe('fapi2_validation_failed');
    }
    expect(
      classifyFapi2CallbackError(Object.assign(new Error('x'), { code: 5, claim: 5, reason: 5 }))
    ).toBe('fapi2_validation_failed');
    expect(
      classifyFapi2CallbackError(
        Object.assign(new Error('x'), {
          code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
          claim: 5,
          reason: 5,
        })
      )
    ).toBe('claim_validation_failed');
  });
});

describe('classification of a failure of a plain provider callback', () => {
  async function classify(message: string) {
    M.errorLog.mockClear();
    M.exchangeCode.mockRejectedValue(new Error(message));
    await callback();
    const call = M.errorLog.mock.calls.find((c) => c[0] === 'Callback error');
    return (call?.[1] as { errorName: string; errorCode: string } | undefined)?.errorCode;
  }

  it.each([
    ['Account provisioner unavailable', 'account_provisioning'],
    ['account_provisioning failed', 'account_provisioning'],
    ['account provisioning failed', 'account_provisioning'],
    ['account-provisioner down', 'account_provisioning'],
    ['accountprovisioner down', 'account_provisioning'],
    ['external_idp_account_provisioning_down', 'account_provisioning'],
    ['external idp account provisioning', 'account_provisioning'],
    ['external-idp-account-provisioning', 'account_provisioning'],
    ['externalidpaccountprovisioning', 'account_provisioning'],
    ['accountxprovisioner down', 'callback_processing'],
    ['FOREIGN KEY failed', 'database_constraint'],
    ['foreign_key failed', 'database_constraint'],
    ['foreign-key failed', 'database_constraint'],
    ['foreignkey failed', 'database_constraint'],
    ['unique constraint', 'database_constraint'],
    ['referential integrity', 'database_constraint'],
    ['foreignxkey', 'callback_processing'],
    ['database is locked', 'database_error'],
    ['D1_ERROR', 'database_error'],
    ['sqlite busy', 'database_error'],
    ['bad sql', 'database_error'],
    ['userinfo endpoint failed', 'userinfo_processing'],
    ['token endpoint failed', 'token_processing'],
    ['bad authorization code', 'token_processing'],
    ['bad authorization_code', 'token_processing'],
    ['bad authorization-code', 'token_processing'],
    ['bad authorizationcode', 'token_processing'],
    ['identity not found', 'identity_processing'],
    ['linked identity gone', 'identity_processing'],
    ['linked_identity gone', 'identity_processing'],
    ['email is bad', 'email_processing'],
    ['no idea', 'callback_processing'],
    ['userinfo token', 'userinfo_processing'],
    ['token database', 'database_error'],
    ['identity email', 'identity_processing'],
    ['token email', 'token_processing'],
    ['database constraint', 'database_constraint'],
    ['account provisioner database', 'account_provisioning'],
  ])('classifies "%s" as %s', async (message, expected) => {
    expect(await classify(message)).toBe(expected);
  });

  it('logs only the name and the class of an error that is not an Error object', async () => {
    M.exchangeCode.mockRejectedValue('plain text with token');
    await callback();
    expect(M.errorLog).toHaveBeenCalledWith('Callback error', {
      errorName: 'UnknownError',
      errorCode: 'callback_failed',
    });
  });
});
