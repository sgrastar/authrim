/**
 * External callback: failure recording and failure responses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { argRec, rec } from './helpers/mock-args';
import { M, setupCallbackMocks } from './helpers/callback-mocks';
import { ExternalIdPError, ExternalIdPErrorCode } from '../types';
import {
  ENV,
  STATE,
  authState,
  callback,
  fakeExecutionContext,
  paramsOf,
} from './helpers/callback-harness';

beforeEach(setupCallbackMocks);

describe('sign-in failures are recorded for the flow interaction', () => {
  const interaction = () => authState({ attemptInteractionId: 'int-1' });

  it('schedules a failure record for a provider error', async () => {
    M.consumeAuthState.mockResolvedValue(interaction());
    const waitUntil = vi.fn();
    await callback({
      query: `state=${STATE}&error=access_denied`,
      executionCtx: fakeExecutionContext(waitUntil),
    });
    expect(M.scheduleFailure).toHaveBeenCalledTimes(1);
    expect(M.scheduleFailure.mock.calls[0]?.[1]).toEqual({
      tenantId: 'default',
      interactionId: 'int-1',
      method: 'external_idp',
      reasonCode: 'upstream_error',
      userId: null,
      dedupeKey: 'auth-state-a',
    });
  });

  it('records nothing without an interaction or for a link', async () => {
    await callback({ query: `state=${STATE}&error=access_denied` });
    M.consumeAuthState.mockResolvedValue({ ...interaction(), userId: 'user-1', sessionId: 's' });
    await callback({ query: `state=${STATE}&error=access_denied` });
    expect(M.scheduleFailure).not.toHaveBeenCalled();
  });

  it('records the account the failure belongs to once the identity resolved', async () => {
    M.consumeAuthState.mockResolvedValue(interaction());
    M.findById.mockResolvedValue(null);
    M.consumeAuthState.mockResolvedValue({ ...interaction(), enableSso: true });
    await callback();
    expect(M.scheduleFailure.mock.calls[0]?.[1]).toMatchObject({
      reasonCode: 'account_unavailable',
      userId: 'user-1',
    });
  });

  it.each([
    [ExternalIdPErrorCode.NO_ACCOUNT_FOUND, 'account_not_linked'],
    [ExternalIdPErrorCode.EMAIL_NOT_VERIFIED, 'email_not_verified'],
    [ExternalIdPErrorCode.JIT_PROVISIONING_DISABLED, 'signup_disabled'],
    [ExternalIdPErrorCode.LOGIN_DISABLED, 'method_disabled'],
    [ExternalIdPErrorCode.PROVIDER_ERROR, 'upstream_error'],
    [ExternalIdPErrorCode.REAUTH_NOT_PROVEN, 'assurance_not_met'],
    [ExternalIdPErrorCode.POLICY_ACCESS_DENIED, 'policy_denied'],
    [ExternalIdPErrorCode.ACCOUNT_CREATION_FAILED, 'provisioning_failed'],
    [ExternalIdPErrorCode.SETTINGS_UNAVAILABLE, 'service_unavailable'],
    [ExternalIdPErrorCode.CALLBACK_FAILED, 'verification_failed'],
  ])('maps %s to %s', async (code, reason) => {
    M.consumeAuthState.mockResolvedValue(interaction());
    M.handleIdentity.mockRejectedValue(new ExternalIdPError(code, 'x'));
    await callback();
    expect(M.scheduleFailure.mock.calls[0]?.[1]).toMatchObject({ reasonCode: reason });
  });

  it('maps an acr message to assurance_not_met and any other error to verification_failed', async () => {
    M.consumeAuthState.mockResolvedValue(interaction());
    M.handleIdentity.mockRejectedValue(new Error('ID token acr mismatch'));
    await callback();
    expect(M.scheduleFailure.mock.calls[0]?.[1]).toMatchObject({ reasonCode: 'assurance_not_met' });
    M.scheduleFailure.mockClear();
    M.handleIdentity.mockRejectedValue('weird');
    await callback();
    expect(M.scheduleFailure.mock.calls[0]?.[1]).toMatchObject({
      reasonCode: 'verification_failed',
    });
  });
});

describe('failure responses', () => {
  const failWith = (error: unknown) => M.handleIdentity.mockRejectedValue(error);

  it('answers an ExternalIdPError with its code and a generic description', async () => {
    failWith(new ExternalIdPError(ExternalIdPErrorCode.NO_ACCOUNT_FOUND, 'hidden'));
    const response = await callback();
    expect(paramsOf(response)).toEqual({
      error: ExternalIdPErrorCode.NO_ACCOUNT_FOUND,
      error_description: 'Authentication failed. Please try again.',
    });
  });

  it('answers an acr failure with the assurance error', async () => {
    failWith(new Error('acr not satisfied'));
    const response = await callback();
    expect(paramsOf(response)).toEqual({
      error: ExternalIdPErrorCode.ACR_VALUES_NOT_SATISFIED,
      error_description:
        'The authentication level does not meet the required security level. Please try again with a stronger authentication method.',
    });
    expect(rec(argRec(M.publishEvent, 0, 1).data).errorCode).toBe(
      ExternalIdPErrorCode.ACR_VALUES_NOT_SATISFIED
    );
  });

  it('answers any other Error generically without its message', async () => {
    failWith(new Error('database exploded at /secret/path'));
    const response = await callback();
    expect(paramsOf(response)).toEqual({
      error: ExternalIdPErrorCode.CALLBACK_FAILED,
      error_description: 'An error occurred during authentication. Please try again.',
    });
    expect(response.headers.get('Location')).not.toContain('secret');
    expect(rec(argRec(M.publishEvent, 0, 1).data).errorCode).toBe(
      ExternalIdPErrorCode.CALLBACK_FAILED
    );
  });

  it('answers a thrown non-Error generically', async () => {
    failWith('just a string');
    const response = await callback();
    expect(paramsOf(response)).toEqual({
      error: ExternalIdPErrorCode.CALLBACK_FAILED,
      error_description: 'Authentication failed. Please try again.',
    });
  });

  it('exposes the failure code in headers only in conformance mode', async () => {
    failWith(new ExternalIdPError(ExternalIdPErrorCode.NO_ACCOUNT_FOUND, 'x'));
    const plain = await callback();
    expect(plain.headers.get('X-Authrim-Diagnostic-Callback-Error')).toBeNull();
    const conformance = await callback({
      env: { ...ENV, ENABLE_CONFORMANCE_MODE: 'true' },
    });
    expect(conformance.headers.get('X-Authrim-Diagnostic-Callback-Error')).toBe(
      ExternalIdPErrorCode.NO_ACCOUNT_FOUND
    );
    expect(conformance.headers.get('X-Authrim-Diagnostic-Callback-Error-Name')).toBe(
      'ExternalIdPError'
    );
    failWith('text');
    const nonError = await callback({
      env: { ...ENV, ENABLE_CONFORMANCE_MODE: 'true' },
    });
    expect(nonError.headers.get('X-Authrim-Diagnostic-Callback-Error-Name')).toBe('UnknownError');
  });

  it('reports a failed link by reason', async () => {
    M.consumeAuthState.mockResolvedValue(authState({ userId: 'user-1', sessionId: 's-1' }));
    M.readAccountSession.mockRejectedValue(new Error('boom'));
    expect(paramsOf(await callback())).toEqual({ social_link: 'error', reason: 'failed' });
  });

  it('logs the failure class without the message', async () => {
    failWith(new Error('token endpoint down'));
    await callback();
    expect(M.errorLog).toHaveBeenCalledWith('Callback error', {
      errorName: 'Error',
      errorCode: 'token_processing',
    });
    failWith(new ExternalIdPError(ExternalIdPErrorCode.NO_ACCOUNT_FOUND, 'x'));
    await callback();
    expect(M.errorLog).toHaveBeenLastCalledWith('Callback error', {
      errorName: 'ExternalIdPError',
      errorCode: ExternalIdPErrorCode.NO_ACCOUNT_FOUND,
    });
    failWith('plain');
    await callback();
    expect(M.errorLog).toHaveBeenLastCalledWith('Callback error', {
      errorName: 'UnknownError',
      errorCode: ExternalIdPErrorCode.CALLBACK_FAILED,
    });
  });

  it.each([
    ['AccountProvisioner down', 'account_provisioning'],
    ['foreign key constraint failed', 'database_constraint'],
    ['D1 error', 'database_error'],
    ['userinfo parse', 'userinfo_processing'],
    ['bad authorization code', 'token_processing'],
    ['linked identity missing', 'identity_processing'],
    ['email broken', 'email_processing'],
    ['nothing in particular', 'callback_processing'],
  ])('classifies "%s" as %s in the log', async (message, expected) => {
    failWith(new Error(message));
    await callback();
    expect(argRec(M.errorLog, 0, 1).errorCode).toBe(expected);
  });
});
