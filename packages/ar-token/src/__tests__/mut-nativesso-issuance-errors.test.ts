/**
 * Native SSO token exchange (token.ts handleNativeSSOTokenExchange): issuance steps that fail
 * after the device secret was used answer a retryable native_sso_server_error and issue nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseJsonResponse } from './helpers/mocks';
import type { Harness } from './helpers/mut-nativesso-harness';
import {
  nativeSSOContext,
  setupNativeSSO,
  type NativeSSOErrorBody,
} from './helpers/mut-nativesso-fixtures';

const mocks = await vi.hoisted(async () => {
  const { createHarnessMocks } = await import('./helpers/mut-nativesso-harness');
  return createHarnessMocks();
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const { arLibCoreMock } = await import('./helpers/mut-nativesso-harness');
  return arLibCoreMock(await importOriginal(), mocks);
});

vi.mock('jose', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  importPKCS8: vi.fn().mockResolvedValue({ type: 'private' }),
  importJWK: vi.fn().mockResolvedValue({ type: 'public' }),
}));

import { tokenHandler } from '../token';
import { setupHarness } from './helpers/mut-nativesso-harness';

function serverError(description: string) {
  return {
    error: 'server_error',
    error_description: description,
    error_details: {
      code: 'native_sso_server_error',
      retryable: true,
      severity: 'error',
      transient: true,
      user_action: 'retry',
    },
  };
}

describe('Native SSO token exchange: issuance failures', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = setupHarness(mocks);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function exchange() {
    const response = await tokenHandler(nativeSSOContext(harness));
    const body = await parseJsonResponse<NativeSSOErrorBody & Record<string, unknown>>(response);
    return { response, body };
  }

  it('fails when the signing key cannot be loaded', async () => {
    setupNativeSSO(mocks, harness);
    // A rotated key version makes any cached key stale; the KeyManager is not bound.
    harness.mockEnv.AUTHRIM_CONFIG.get = vi.fn(async (key: string) =>
      key.startsWith('v1:key-version:') ? `rotated-${Math.random()}` : null
    );
    (harness.mockEnv as unknown as { KEY_MANAGER?: unknown }).KEY_MANAGER = undefined;

    const { response, body } = await exchange();

    expect(response.status).toBe(500);
    expect(body).toEqual(serverError('Failed to load signing key'));
    expect(mocks.mockCreateAccessToken).not.toHaveBeenCalled();
  });

  it('fails when the access token cannot be created', async () => {
    setupNativeSSO(mocks, harness);
    mocks.mockCreateAccessToken.mockRejectedValue(new Error('signing failed'));

    const { response, body } = await exchange();

    expect(response.status).toBe(500);
    expect(body).toEqual(serverError('Failed to create access token'));
  });

  it('fails when the at_hash cannot be calculated', async () => {
    setupNativeSSO(mocks, harness);
    mocks.mockCalculateAtHash.mockRejectedValue(new Error('digest failed'));

    const { response, body } = await exchange();

    expect(response.status).toBe(500);
    expect(body).toEqual(serverError('Failed to calculate token hash'));
    expect(mocks.mockCreateIDToken).not.toHaveBeenCalled();
  });

  it('fails when the ID token cannot be created', async () => {
    setupNativeSSO(mocks, harness);
    mocks.mockCreateIDToken.mockRejectedValue(new Error('signing failed'));

    const { response, body } = await exchange();

    expect(response.status).toBe(500);
    expect(body).toEqual(serverError('Failed to create ID token'));
    expect(mocks.mockCreateRefreshToken).not.toHaveBeenCalled();
  });
});
