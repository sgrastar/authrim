import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advancePasskeyAuthenticationState,
  consumeTotpAuthenticationState,
  ensureAccountAuthenticationState,
  recordUserSessionRevocation,
} from '../session-revocation-store';

const mocks = vi.hoisted(() => ({
  revokeDo: vi.fn(),
  getAccountState: vi.fn(),
  initializeAccountState: vi.fn(),
  advancePasskeyCounter: vi.fn(),
  consumeTotpTimeStep: vi.fn(),
}));

function env() {
  return {
    SESSION_REVOCATION_STORE: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({
        revokeAllRpc: mocks.revokeDo,
        getAccountStateRpc: mocks.getAccountState,
        initializeAccountStateRpc: mocks.initializeAccountState,
        advancePasskeyCounterRpc: mocks.advancePasskeyCounter,
        consumeTotpTimeStepRpc: mocks.consumeTotpTimeStep,
      })),
    },
  } as never;
}

describe('recordUserSessionRevocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.revokeDo.mockResolvedValue(2_000);
  });

  it('advances only the user-scoped DO authority', async () => {
    const bindings = env();

    await expect(recordUserSessionRevocation(bindings, 'tenant-a', 'user-a', 2_000)).resolves.toBe(
      2_000
    );
    expect(bindings.SESSION_REVOCATION_STORE.idFromName).toHaveBeenCalledWith(
      'tenant:tenant-a:user-session:user-a'
    );
    expect(mocks.revokeDo).toHaveBeenCalledWith('tenant-a', 'user-a', 'account:user-a', 2_000);
  });

  it('fails closed when the DO authority cannot advance', async () => {
    mocks.revokeDo.mockRejectedValueOnce(new Error('DO unavailable'));

    await expect(recordUserSessionRevocation(env(), 'tenant-a', 'user-a', 2_000)).rejects.toThrow(
      'DO unavailable'
    );
    expect(mocks.revokeDo).toHaveBeenCalledOnce();
  });
});

describe('authentication proof state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('advances an initialized passkey counter in one DO call without loading D1', async () => {
    mocks.advancePasskeyCounter.mockResolvedValue({ counter: 8, advanced: true });
    const loader = vi.fn();

    await expect(
      advancePasskeyAuthenticationState(
        env(),
        {
          tenantId: 'tenant-a',
          userId: 'user-a',
          credentialId: 'passkey-a',
          storedCounter: 7,
          observedCounter: 8,
          observedAtMs: 2_000,
        },
        loader
      )
    ).resolves.toEqual({ counter: 8, advanced: true });
    expect(mocks.advancePasskeyCounter).toHaveBeenCalledOnce();
    expect(mocks.initializeAccountState).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
  });

  it('hydrates an uninitialized account and retries the passkey counter atomically', async () => {
    mocks.advancePasskeyCounter
      .mockRejectedValueOnce(new Error('account_auth_state_uninitialized'))
      .mockResolvedValueOnce({ counter: 8, advanced: true });
    mocks.initializeAccountState.mockResolvedValue({ lifecycle: 'active' });
    const loader = vi.fn().mockResolvedValue({ lifecycle: 'active', sourceVersionMs: 1_000 });

    await advancePasskeyAuthenticationState(
      env(),
      {
        tenantId: 'tenant-a',
        userId: 'user-a',
        credentialId: 'passkey-a',
        storedCounter: 7,
        observedCounter: 8,
        observedAtMs: 2_000,
      },
      loader
    );
    expect(loader).toHaveBeenCalledOnce();
    expect(mocks.initializeAccountState).toHaveBeenCalledOnce();
    expect(mocks.advancePasskeyCounter).toHaveBeenCalledTimes(2);
  });

  it('consumes an initialized TOTP step in one DO call without loading D1', async () => {
    mocks.consumeTotpTimeStep.mockResolvedValue({ lastAcceptedTimeStep: 123 });
    const loader = vi.fn();

    await expect(
      consumeTotpAuthenticationState(
        env(),
        {
          tenantId: 'tenant-a',
          userId: 'user-a',
          credentialId: 'totp-a',
          storedLastUsedTimeStep: 122,
          observedTimeStep: 123,
          observedAtMs: 2_000,
        },
        loader
      )
    ).resolves.toEqual({ lastAcceptedTimeStep: 123 });
    expect(mocks.consumeTotpTimeStep).toHaveBeenCalledOnce();
    expect(mocks.initializeAccountState).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
  });
});

describe('ensureAccountAuthenticationState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hydrates an uninitialized user once and returns active state', async () => {
    mocks.getAccountState.mockResolvedValue({ lifecycle: null });
    mocks.initializeAccountState.mockResolvedValue({ lifecycle: 'active' });
    const loader = vi.fn().mockResolvedValue({ lifecycle: 'active', sourceVersionMs: 1_000 });

    await expect(
      ensureAccountAuthenticationState(env(), 'tenant-a', 'user-a', loader)
    ).resolves.toMatchObject({ lifecycle: 'active' });
    expect(loader).toHaveBeenCalledOnce();
    expect(mocks.initializeAccountState).toHaveBeenCalledWith(
      'tenant-a',
      'user-a',
      'account:user-a',
      'active',
      1_000
    );
  });

  it('does not read D1 for initialized state and rejects a restricted account', async () => {
    mocks.getAccountState.mockResolvedValue({ lifecycle: 'suspended' });
    const loader = vi.fn();
    await expect(
      ensureAccountAuthenticationState(env(), 'tenant-a', 'user-a', loader)
    ).rejects.toThrow('account_authentication_not_allowed');
    expect(loader).not.toHaveBeenCalled();
  });
});
