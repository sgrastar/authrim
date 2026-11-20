import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import { SIGN_IN_ATTEMPT_INTERACTION_METADATA_KEY, type Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  resolveInteraction: vi.fn(),
  record: vi.fn(),
  warn: vi.fn(),
  layer: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  createAuthContextFromHono: () => ({ coreAdapter: 'core' }),
  resolveSignInAttemptInteraction: mocks.resolveInteraction,
  recordSignInAttemptFailure: mocks.record,
  loadInvestigationSubjectHmacKeysFromEnv: () => null,
  getLogger: () => ({ module: () => ({ warn: mocks.warn, info: vi.fn(), error: vi.fn() }) }),
  layerTenantSettingsDocument: mocks.layer,
}));

import {
  accountAuthenticationDenialReason,
  scheduleSignInAttemptFailure,
  signInAttemptInteractionMetadata,
} from '../sign-in-attempt-recording';
import {
  methodUsageEnabled,
  normalizeBooleanSetting,
  readAuthenticationMethodSettings,
} from '../authentication-method-settings';

function context(header?: string) {
  const waited: Promise<unknown>[] = [];
  const c = {
    env: {},
    req: { header: () => header },
    executionCtx: { waitUntil: (promise: Promise<unknown>) => waited.push(promise) },
  } as unknown as Context<{ Bindings: Env }>;
  return { c, waited };
}

beforeEach(() => {
  mocks.resolveInteraction.mockReset();
  mocks.record.mockReset().mockResolvedValue(undefined);
  mocks.warn.mockReset();
  mocks.layer
    .mockReset()
    .mockImplementation(async (_env: unknown, _category: string, document: unknown) => document);
});

describe('sign-in attempt recording', () => {
  it.each([
    [new Error('passkey_counter_replay'), 'replay_detected'],
    [new Error('totp_time_step_replay'), 'replay_detected'],
    [new Error('account_suspended'), 'account_unavailable'],
    [{ message: 'passkey_counter_replay' }, 'account_unavailable'],
    ['totp_time_step_replay', 'account_unavailable'],
  ])('classifies %j as %s', (error, reason) => {
    expect(accountAuthenticationDenialReason(error)).toBe(reason);
  });

  it('keeps a live interaction named by the header', async () => {
    mocks.resolveInteraction.mockResolvedValue('int-1');
    const { c } = context('int-1');
    await expect(signInAttemptInteractionMetadata(c, 'tenant-1')).resolves.toEqual({
      [SIGN_IN_ATTEMPT_INTERACTION_METADATA_KEY]: 'int-1',
    });
    expect(mocks.resolveInteraction).toHaveBeenCalledWith('core', {
      tenantId: 'tenant-1',
      interactionId: 'int-1',
    });
  });

  it('leaves out an interaction that is not live, or whose check fails', async () => {
    const { c } = context('int-1');
    mocks.resolveInteraction.mockResolvedValueOnce(null);
    await expect(signInAttemptInteractionMetadata(c, 'tenant-1')).resolves.toEqual({});
    mocks.resolveInteraction.mockRejectedValueOnce(new Error('down'));
    await expect(signInAttemptInteractionMetadata(c, 'tenant-1')).resolves.toEqual({});
  });

  it('throws a failed check when strict', async () => {
    mocks.resolveInteraction.mockRejectedValue(new Error('down'));
    await expect(
      signInAttemptInteractionMetadata(context().c, 'tenant-1', 'int-2', { strict: true })
    ).rejects.toThrow('down');
  });

  it('logs only the error type when a recording rejects without an Error', async () => {
    mocks.record.mockRejectedValue('database said: secret');
    const { c, waited } = context();
    scheduleSignInAttemptFailure(c, {
      tenantId: 'tenant-1',
      metadata: { [SIGN_IN_ATTEMPT_INTERACTION_METADATA_KEY]: 'int-1' },
      method: 'passkey',
      reasonCode: 'verification_failed',
      userId: 'unknown',
    });
    await Promise.all(waited);
    expect(mocks.record.mock.calls[0][3]).toMatchObject({ interactionId: 'int-1', userId: null });
    expect(mocks.warn).toHaveBeenCalledWith('Failed to record a failed sign-in attempt', {
      errorType: 'unknown',
    });
  });
});

describe('authentication method settings', () => {
  it.each([
    [true, false, true],
    [' TRUE ', false, true],
    [' False ', true, false],
    ['yes', true, true],
    ['yes', false, false],
    [1, false, false],
  ])('normalizes %j (fallback %s) to %s', (value, fallback, expected) => {
    expect(normalizeBooleanSetting(value, fallback)).toBe(expected);
  });

  it('defaults passkey on and email codes off', () => {
    expect(methodUsageEnabled({}, 'passkey', 'login')).toBe(true);
    expect(methodUsageEnabled({}, 'email_otp', 'login')).toBe(false);
  });

  it('reads the account link switch under its own key and falls back to the method switch', () => {
    expect(
      methodUsageEnabled(
        { 'authentication-methods.passkey.account_link_enabled': false },
        'passkey',
        'account_link'
      )
    ).toBe(false);
    expect(
      methodUsageEnabled(
        { 'authentication-methods.email_otp.enabled': 'true' },
        'email_otp',
        'signup'
      )
    ).toBe(true);
  });

  const envWith = (raw: string | null) =>
    ({ SETTINGS: { get: vi.fn(async () => raw) } }) as unknown as Env;

  it('reads the tenant document under the platform defaults', async () => {
    const env = envWith('{"authentication-methods.passkey.enabled":false}');
    await expect(readAuthenticationMethodSettings(env, 'tenant-1')).resolves.toEqual({
      'authentication-methods.passkey.enabled': false,
    });
    expect(env.SETTINGS?.get).toHaveBeenCalledWith(
      'settings:tenant:tenant-1:authentication-methods'
    );
    expect(mocks.layer).toHaveBeenCalledWith(env, 'authentication-methods', {
      'authentication-methods.passkey.enabled': false,
    });
  });

  it.each(['[1]', 'null', '"x"'])('treats the document %s as damaged', async (raw) => {
    await expect(readAuthenticationMethodSettings(envWith(raw), 'tenant-1')).resolves.toEqual({});
    await expect(
      readAuthenticationMethodSettings(envWith(raw), 'tenant-1', { strict: true })
    ).rejects.toThrow('authentication_methods_settings_invalid');
    expect(mocks.layer).not.toHaveBeenCalled();
  });

  it('layers an empty document when none is stored', async () => {
    await readAuthenticationMethodSettings(envWith(null), 'tenant-1');
    expect(mocks.layer).toHaveBeenCalledWith(expect.anything(), 'authentication-methods', {});
  });
});
