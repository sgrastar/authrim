import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const { loadCanonical, listTenants } = vi.hoisted(() => ({
  loadCanonical: vi.fn(),
  listTenants: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core/services/settings-canonical-store', () => ({
  DatabaseSettingsCanonicalStore: class {
    load = loadCanonical;
  },
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
  listEnvironmentTenantDefaultStores: listTenants,
}));

import {
  checkGlobalHumanVerificationDisable,
  HumanVerificationGuardUnavailableError,
  humanVerificationSettingsRequiring,
} from '../human-verification-guards';

const TURNSTILE = 'human-verification-cloudflare-turnstile';
const HCAPTCHA = 'human-verification-hcaptcha';
const LOGIN = 'authentication-methods.human_verification.login_enabled';
const SIGNUP = 'authentication-methods.human_verification.signup_enabled';
const REAUTH = 'authentication-methods.human_verification.reauth_enabled';
const PROVIDER = 'authentication-methods.human_verification.provider';
const KEY = (tenantId: string) => `settings:tenant:${tenantId}:authentication-methods`;

function env(values: Record<string, string>, options: { canonical?: boolean } = {}) {
  return {
    SETTINGS: { get: vi.fn(async (key: string) => values[key] ?? null) },
    ...(options.canonical === false ? {} : { DB_ADMIN: {} }),
  } as unknown as Env;
}

function canonical(data: Record<string, unknown> | null) {
  loadCanonical.mockResolvedValue(data ? { data, version: 'v' } : null);
}

beforeEach(() => {
  loadCanonical.mockReset();
  listTenants.mockReset();
  canonical(null);
});

describe('humanVerificationSettingsRequiring reads both copies of the settings', () => {
  it('reads the KV copy alone when there is no admin database', async () => {
    const e = env({ [KEY('t')]: JSON.stringify({ [LOGIN]: true }) }, { canonical: false });
    await expect(humanVerificationSettingsRequiring(e, 't', TURNSTILE)).resolves.toEqual([LOGIN]);
    expect(loadCanonical).not.toHaveBeenCalled();
  });

  it('refuses on the canonical document when the KV projection is stale (not yet requiring)', async () => {
    canonical({ [LOGIN]: true });
    const e = env({ [KEY('t')]: JSON.stringify({ [LOGIN]: false }) });
    await expect(humanVerificationSettingsRequiring(e, 't', TURNSTILE)).resolves.toEqual([LOGIN]);
  });

  it('refuses on the KV copy when the canonical document no longer requires it (a pending turn-off)', async () => {
    canonical({ [LOGIN]: false });
    const e = env({ [KEY('t')]: JSON.stringify({ [LOGIN]: true }) });
    await expect(humanVerificationSettingsRequiring(e, 't', TURNSTILE)).resolves.toEqual([LOGIN]);
  });

  it('joins what both require, in flow order', async () => {
    canonical({ [REAUTH]: true });
    const e = env({ [KEY('t')]: JSON.stringify({ [SIGNUP]: 'true' }) });
    await expect(humanVerificationSettingsRequiring(e, 't', TURNSTILE)).resolves.toEqual([
      SIGNUP,
      REAUTH,
    ]);
  });

  it('counts a document only for the provider it selects', async () => {
    canonical({ [PROVIDER]: HCAPTCHA, [LOGIN]: true });
    const e = env({ [KEY('t')]: JSON.stringify({ [LOGIN]: false }) });
    await expect(humanVerificationSettingsRequiring(e, 't', TURNSTILE)).resolves.toEqual([]);
    await expect(humanVerificationSettingsRequiring(e, 't', HCAPTCHA)).resolves.toEqual([LOGIN]);
  });

  it('requires nothing of a tenant with no document anywhere', async () => {
    await expect(humanVerificationSettingsRequiring(env({}), 't', TURNSTILE)).resolves.toEqual([]);
  });

  it('treats a malformed KV document as requiring nothing, still reading the canonical one', async () => {
    const e = env({ [KEY('t')]: '{bad' });
    await expect(humanVerificationSettingsRequiring(e, 't', TURNSTILE)).resolves.toEqual([]);
    canonical({ [LOGIN]: true });
    await expect(humanVerificationSettingsRequiring(e, 't', TURNSTILE)).resolves.toEqual([LOGIN]);
    for (const document of ['[]', 'null', '"text"']) {
      await expect(
        humanVerificationSettingsRequiring(env({ [KEY('t')]: document }), 't', TURNSTILE)
      ).resolves.toEqual([LOGIN]);
    }
  });

  it('throws when the KV read fails, instead of reporting nothing required', async () => {
    const e = env({});
    (e.SETTINGS!.get as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('kv down')
    );
    await expect(humanVerificationSettingsRequiring(e, 't', TURNSTILE)).rejects.toBeInstanceOf(
      HumanVerificationGuardUnavailableError
    );
  });

  it('throws when the canonical read fails', async () => {
    loadCanonical.mockRejectedValue(new Error('d1 down'));
    await expect(
      humanVerificationSettingsRequiring(env({}), 't', TURNSTILE)
    ).rejects.toBeInstanceOf(HumanVerificationGuardUnavailableError);
  });

  it('does not read anything for a plugin that is not a human verification provider', async () => {
    const e = env({});
    await expect(humanVerificationSettingsRequiring(e, 't', 'notifier-resend')).resolves.toEqual(
      []
    );
    expect(e.SETTINGS!.get).not.toHaveBeenCalled();
  });
});

describe('checkGlobalHumanVerificationDisable', () => {
  const ids = (count: number) =>
    Array.from({ length: count }, (_, index) => `t${String(index).padStart(3, '0')}`);

  function directory(tenantIds: string[]) {
    listTenants.mockImplementation(
      async (_env: unknown, options: { limit: number; afterTenantId?: string }) =>
        tenantIds
          .filter((tenantId) => tenantId > (options.afterTenantId ?? ''))
          .slice(0, options.limit)
          .map((tenantId) => ({ tenantId, store: {} }))
    );
  }
  const on = { [`plugins:enabled:${TURNSTILE}`]: 'true' };

  it('finds a tenant whose requirement is only in the canonical document', async () => {
    directory(['a', 'b']);
    loadCanonical.mockImplementation(async (_category: string, scope: { id: string }) =>
      scope.id === 'b' ? { data: { [LOGIN]: true }, version: 'v' } : null
    );
    await expect(checkGlobalHumanVerificationDisable(env({ ...on }), TURNSTILE)).resolves.toEqual({
      outcome: 'in_use',
      tenants: [{ tenantId: 'b', settings: [LOGIN] }],
    });
  });

  it('resolves no more tenants than the room left: pages of 100, 100, then one', async () => {
    directory(ids(201));
    await expect(checkGlobalHumanVerificationDisable(env({ ...on }), TURNSTILE)).resolves.toEqual({
      outcome: 'scope_too_large',
    });
    expect(listTenants.mock.calls.map((call) => call[1].limit)).toEqual([100, 100, 1]);
  });

  it('checks exactly 200 tenants with a final look for more', async () => {
    directory(ids(200));
    await expect(checkGlobalHumanVerificationDisable(env({ ...on }), TURNSTILE)).resolves.toEqual({
      outcome: 'allowed',
    });
    expect(listTenants.mock.calls.map((call) => call[1].limit)).toEqual([100, 100, 1]);
  });

  it('stops after a short first page', async () => {
    directory(ids(30));
    await checkGlobalHumanVerificationDisable(env({ ...on }), TURNSTILE);
    expect(listTenants).toHaveBeenCalledTimes(1);
  });

  it('says the directory is not configured, apart from other failures', async () => {
    listTenants.mockRejectedValue(new Error('environment_tenant_directory_unavailable'));
    await expect(checkGlobalHumanVerificationDisable(env({ ...on }), TURNSTILE)).resolves.toEqual({
      outcome: 'directory_unavailable',
    });
    listTenants.mockRejectedValue(new Error('d1 timeout'));
    await expect(checkGlobalHumanVerificationDisable(env({ ...on }), TURNSTILE)).resolves.toEqual({
      outcome: 'scope_unavailable',
    });
  });

  it('refuses on the safe side when a tenant settings read fails', async () => {
    directory(['a']);
    loadCanonical.mockRejectedValue(new Error('d1 down'));
    await expect(checkGlobalHumanVerificationDisable(env({ ...on }), TURNSTILE)).resolves.toEqual({
      outcome: 'scope_unavailable',
    });
  });

  it('refuses on the safe side when the platform flag cannot be read', async () => {
    const e = env({});
    (e.SETTINGS!.get as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('kv down')
    );
    await expect(checkGlobalHumanVerificationDisable(e, TURNSTILE)).resolves.toEqual({
      outcome: 'scope_unavailable',
    });
  });
});
