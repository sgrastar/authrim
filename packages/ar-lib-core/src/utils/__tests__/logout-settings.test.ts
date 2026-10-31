import { describe, expect, it } from 'vitest';
import { DEFAULT_LOGOUT_CONFIG, DEFAULT_LOGOUT_WEBHOOK_CONFIG } from '../../types/logout';
import {
  applyBackchannelLogoutSettings,
  legacyLogoutSettingsValues,
  legacyLogoutWebhookSettingsValues,
  logoutConfigFromValues,
  logoutWebhookConfigFromValues,
  readLegacyLogoutSettings,
  readLegacyLogoutWebhookSettings,
} from '../logout-settings';
import { resolveLogoutConfig, resolveLogoutWebhookConfig } from '../../services/logout-settings';
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
      'session.backchannel_enabled': true,
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

  it('reads the on/off fields of every section', () => {
    expect(
      legacyLogoutSettingsValues({
        backchannel: { include_sub_claim: false, include_sid_claim: true },
        frontchannel: { enabled: false, iframe_timeout_ms: 9000 },
        session_management: { enabled: true, check_session_iframe_enabled: false },
      })
    ).toEqual({
      'session.backchannel_include_sub': false,
      'session.backchannel_include_sid': true,
      'session.frontchannel_enabled': false,
      'session.session_management_enabled': true,
      'session.check_session_iframe_enabled': false,
    });
  });

  it('counts a saved on/off value by its truth, as runtime tested it', () => {
    expect(
      legacyLogoutSettingsValues({ backchannel: { enabled: null }, frontchannel: { enabled: 1 } })
    ).toEqual({ 'session.backchannel_enabled': false, 'session.frontchannel_enabled': true });
  });

  it('skips fields that are missing or not usable', () => {
    expect(legacyLogoutSettingsValues(null)).toEqual({});
    expect(legacyLogoutSettingsValues({ frontchannel: {} })).toEqual({});
    expect(
      legacyLogoutSettingsValues({
        backchannel: { logout_token_exp_seconds: '60', on_final_failure: 'page' },
      })
    ).toEqual({});
  });
});

describe('legacyLogoutWebhookSettingsValues', () => {
  it('reads the on/off fields; timeout and retries stay the code defaults', () => {
    expect(
      legacyLogoutWebhookSettingsValues({
        enabled: true,
        include_sub_claim: false,
        request_timeout_ms: 1000,
        retry: { max_attempts: 9 },
        on_final_failure: 'alert',
      })
    ).toEqual({
      'session.logout_webhook_enabled': true,
      'session.logout_webhook_include_sub': false,
    });
    expect(legacyLogoutWebhookSettingsValues('x')).toEqual({});
  });

  it('takes a document it cannot parse for one it cannot read', async () => {
    await expect(
      readLegacyLogoutWebhookSettings(kvOf({ 'settings:logout_webhook': '{' }))
    ).rejects.toThrow();
  });
});

describe('logoutConfigFromValues and logoutWebhookConfigFromValues', () => {
  it('are the code defaults when nothing is set', () => {
    expect(logoutConfigFromValues({})).toEqual(DEFAULT_LOGOUT_CONFIG);
    expect(logoutWebhookConfigFromValues({})).toEqual(DEFAULT_LOGOUT_WEBHOOK_CONFIG);
  });

  it('apply the switches and the back-channel values', () => {
    const values = {
      'session.backchannel_enabled': false,
      'session.backchannel_include_sid': false,
      'session.backchannel_request_timeout_ms': 8000,
      'session.frontchannel_enabled': false,
      'session.check_session_iframe_enabled': false,
      'session.logout_webhook_enabled': true,
      'session.logout_webhook_include_sub': false,
    };
    const logout = logoutConfigFromValues(values);
    expect(logout.backchannel).toMatchObject({
      enabled: false,
      include_sub_claim: true,
      include_sid_claim: false,
      request_timeout_ms: 8000,
    });
    expect(logout.frontchannel).toEqual({ ...DEFAULT_LOGOUT_CONFIG.frontchannel, enabled: false });
    expect(logout.session_management).toEqual({
      enabled: true,
      check_session_iframe_enabled: false,
    });
    expect(logoutWebhookConfigFromValues(values)).toEqual({
      ...DEFAULT_LOGOUT_WEBHOOK_CONFIG,
      enabled: true,
      include_sub_claim: false,
    });
    expect(DEFAULT_LOGOUT_CONFIG.backchannel.enabled).toBe(true);
  });
});

describe('resolveLogoutConfig and resolveLogoutWebhookConfig', () => {
  it('take the tenant values over the platform values', async () => {
    const env = {
      SETTINGS: kvOf({
        'settings:platform:session': JSON.stringify({
          'session.frontchannel_enabled': false,
          'session.logout_webhook_enabled': true,
          'session.logout_webhook_include_sid': false,
        }),
        'settings:tenant:acme:session': JSON.stringify({ 'session.logout_webhook_enabled': false }),
        // The older documents are no longer read.
        'settings:logout': JSON.stringify({ frontchannel: { enabled: true } }),
      }),
    };
    expect((await resolveLogoutConfig(env, 'acme')).frontchannel.enabled).toBe(false);
    const webhook = await resolveLogoutWebhookConfig(env, 'acme');
    expect(webhook.enabled).toBe(false);
    expect(webhook.include_sid_claim).toBe(false);
  });

  it('fail on a settings document that cannot be parsed', async () => {
    const env = { SETTINGS: kvOf({ 'settings:tenant:acme:session': '{' }) };
    await expect(resolveLogoutConfig(env, 'acme')).rejects.toThrow();
    await expect(resolveLogoutWebhookConfig(env, 'acme')).rejects.toThrow();
  });
});

describe('readLegacyLogoutSettings', () => {
  it('takes a document it cannot parse, or one that is not an object, for one it cannot read', async () => {
    await expect(readLegacyLogoutSettings(kvOf({ 'settings:logout': '{' }))).rejects.toThrow();
    await expect(readLegacyLogoutSettings(kvOf({ 'settings:logout': '[]' }))).rejects.toThrow();
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
  it('takes the tenant values over the platform values', async () => {
    const env = {
      SETTINGS: kvOf({
        'settings:platform:session': JSON.stringify({
          'session.backchannel_logout_token_exp': 60,
          'session.backchannel_request_timeout_ms': 8000,
        }),
        'settings:tenant:acme:session': JSON.stringify({
          'session.backchannel_logout_token_exp': 300,
        }),
      }),
    };

    const values = await resolveEffectiveSettings(env, 'session', { tenantId: 'acme' });
    expect(values['session.backchannel_logout_token_exp']).toBe(300);
    expect(values['session.backchannel_request_timeout_ms']).toBe(8000);
  });

  it('fails when a settings document cannot be read', async () => {
    const env = {
      SETTINGS: {
        get: async (key: string) => {
          if (key === 'settings:tenant:acme:session') throw new Error('kv unavailable');
          return null;
        },
      } as unknown as KVNamespace,
    };

    await expect(resolveEffectiveSettings(env, 'session', { tenantId: 'acme' })).rejects.toThrow();
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
