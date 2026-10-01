import { describe, expect, it } from 'vitest';
import { DEFAULT_LOGOUT_CONFIG } from '../../types/logout';
import {
  applyBackchannelLogoutSettings,
  legacyLogoutSettingsValues,
  readLegacyLogoutSettings,
} from '../logout-settings';
import { readLegacySettings } from '../../services/legacy-settings';
import { resolveEffectiveSettings } from '../../services/effective-settings';

function kvOf(values: Record<string, string>): KVNamespace {
  return { get: async (key: string) => values[key] ?? null } as unknown as KVNamespace;
}

describe('legacyLogoutSettingsValues', () => {
  it('reads the saved back-channel fields under Settings API keys', () => {
    expect(
      legacyLogoutSettingsValues({
        backchannel: {
          enabled: true,
          logout_token_exp_seconds: 60,
          request_timeout_ms: 8000,
          retry: { max_attempts: 5, initial_delay_ms: 500, max_delay_ms: 9000 },
          on_final_failure: 'alert',
        },
      })
    ).toEqual({
      'session.backchannel_logout_token_exp': 60,
      'session.backchannel_request_timeout_ms': 8000,
      'session.backchannel_retry_max_attempts': 5,
      'session.backchannel_retry_initial_delay_ms': 500,
      'session.backchannel_retry_max_delay_ms': 9000,
      'session.backchannel_on_failure': 'error',
    });
    expect(legacyLogoutSettingsValues({ backchannel: { on_final_failure: 'log_only' } })).toEqual({
      'session.backchannel_on_failure': 'log',
    });
  });

  it('skips fields that are missing or not usable', () => {
    expect(legacyLogoutSettingsValues(null)).toEqual({});
    expect(legacyLogoutSettingsValues({ frontchannel: { enabled: false } })).toEqual({});
    expect(
      legacyLogoutSettingsValues({
        backchannel: { logout_token_exp_seconds: '60', on_final_failure: 'page' },
      })
    ).toEqual({});
  });
});

describe('readLegacyLogoutSettings', () => {
  it('ignores a document it cannot parse, as the logout handler does', async () => {
    await expect(readLegacyLogoutSettings(kvOf({ 'settings:logout': '{' }))).resolves.toEqual({});
  });
});

describe('applyBackchannelLogoutSettings', () => {
  it('applies resolved values over the base config without changing it', () => {
    const base = DEFAULT_LOGOUT_CONFIG.backchannel;
    const applied = applyBackchannelLogoutSettings(base, {
      'session.backchannel_logout_token_exp': 60,
      'session.backchannel_request_timeout_ms': 8000,
      'session.backchannel_retry_max_attempts': 1,
      'session.backchannel_on_failure': 'error',
    });
    expect(applied).toMatchObject({
      logout_token_exp_seconds: 60,
      request_timeout_ms: 8000,
      on_final_failure: 'alert',
      retry: { ...base.retry, max_attempts: 1 },
    });
    expect(base.retry.max_attempts).toBe(3);
    expect(
      applyBackchannelLogoutSettings(base, { 'session.backchannel_on_failure': 'ignore' })
        .on_final_failure
    ).toBe('log_only');
  });
});

describe('session settings resolution', () => {
  it('uses the older logout document below tenant values', async () => {
    const env = {
      SETTINGS: kvOf({
        'settings:logout': JSON.stringify({
          backchannel: { logout_token_exp_seconds: 60, request_timeout_ms: 8000 },
        }),
        'settings:tenant:acme:session': JSON.stringify({
          'session.backchannel_logout_token_exp': 300,
        }),
      }),
    };
    await expect(readLegacySettings(env, 'session', { fresh: true })).resolves.toEqual({
      'session.backchannel_logout_token_exp': 60,
      'session.backchannel_request_timeout_ms': 8000,
    });

    const values = await resolveEffectiveSettings(env, 'session', { tenantId: 'acme' });
    expect(values['session.backchannel_logout_token_exp']).toBe(300);
    expect(values['session.backchannel_request_timeout_ms']).toBe(8000);
  });

  it('does not cache a read that skipped an unreadable document', async () => {
    let fail = true;
    const env = {
      SETTINGS: {
        get: async (key: string) => {
          if (key !== 'settings:logout') return null;
          if (fail) throw new Error('kv unavailable');
          return JSON.stringify({ backchannel: { request_timeout_ms: 8000 } });
        },
      } as unknown as KVNamespace,
    };

    await expect(readLegacySettings(env, 'session')).resolves.toEqual({});
    fail = false;
    await expect(readLegacySettings(env, 'session')).resolves.toEqual({
      'session.backchannel_request_timeout_ms': 8000,
    });
  });

  it('lets a caller with its own fallback see the failure (strictLegacy)', async () => {
    const env = {
      SETTINGS: {
        get: async (key: string) => {
          if (key === 'settings:logout') throw new Error('kv unavailable');
          return null;
        },
      } as unknown as KVNamespace,
    };

    await expect(
      resolveEffectiveSettings(env, 'session', { tenantId: 'acme', strictLegacy: true })
    ).rejects.toThrow();
  });

  it('defaults to the timeout the logout handler has always used', async () => {
    const values = await resolveEffectiveSettings({ SETTINGS: kvOf({}) }, 'session', {
      tenantId: 'plain',
    });
    expect(values['session.backchannel_request_timeout_ms']).toBe(
      DEFAULT_LOGOUT_CONFIG.backchannel.request_timeout_ms
    );
  });
});
