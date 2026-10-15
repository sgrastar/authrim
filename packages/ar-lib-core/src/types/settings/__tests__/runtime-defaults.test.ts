/**
 * Settings that replace values runtime used to read from older stores must default to what
 * runtime applies when nothing is saved, so moving to them changes nothing.
 */
import { describe, it, expect } from 'vitest';
import { SESSION_DEFAULTS } from '../session';
import { TOKENS_DEFAULTS } from '../tokens';
import { EXTERNAL_IDP_DEFAULTS } from '../external-idp';
import { TENANT_DEFAULTS } from '../tenant';
import { RATE_LIMIT_DEFAULTS, RATE_LIMIT_PROFILE_SETTING_NAMES } from '../rate-limit';
import { SECURITY_DEFAULTS } from '../security';
import { CIBA_DEFAULTS, CIBA_SETTINGS_META } from '../ciba';
import { CIBA_CONSTANTS } from '../../../utils/ciba';
import { CIBA_HARD_LIMITS } from '../../../services/ciba-config';
import { DEVICE_FLOW_DEFAULTS, DEVICE_FLOW_SETTINGS_META } from '../device-flow';
import {
  DEFAULT_USER_CODE_CHARSET,
  DEFAULT_USER_CODE_LENGTH,
  DEVICE_FLOW_CONSTANTS,
  USER_CODE_CHARSETS,
  USER_CODE_CHARSET_NAMES,
  USER_CODE_MAX_LENGTH,
  USER_CODE_MIN_ENTROPY_BITS,
  USER_CODE_MIN_LENGTH,
  isUserCodeFormatAllowed,
  minimumUserCodeLength,
} from '../../../utils/device-flow';
import { DEVICE_FLOW_HARD_LIMITS } from '../../../services/device-flow-settings';
import { DEFAULT_LOGOUT_CONFIG, DEFAULT_LOGOUT_WEBHOOK_CONFIG } from '../../logout';
import { DEFAULT_ID_JAG_CONFIG } from '../../id-jag';
import { DEFAULT_JIT_CONFIG } from '../../jit-config';
import { DEFAULT_UI_PATHS } from '../../../utils/ui-config';
import { RateLimitProfiles } from '../../../middleware/rate-limit';
import { FAPI2_MESSAGE_SIGNING_ALGS } from '../../../constants';

describe('settings that replace older stores default to runtime behaviour', () => {
  it('session logout settings', () => {
    const { backchannel, frontchannel, session_management } = DEFAULT_LOGOUT_CONFIG;
    expect(SESSION_DEFAULTS['session.backchannel_enabled']).toBe(backchannel.enabled);
    expect(SESSION_DEFAULTS['session.backchannel_include_sub']).toBe(backchannel.include_sub_claim);
    expect(SESSION_DEFAULTS['session.backchannel_include_sid']).toBe(backchannel.include_sid_claim);
    expect(SESSION_DEFAULTS['session.frontchannel_enabled']).toBe(frontchannel.enabled);
    expect(SESSION_DEFAULTS['session.session_management_enabled']).toBe(session_management.enabled);
    expect(SESSION_DEFAULTS['session.check_session_iframe_enabled']).toBe(
      session_management.check_session_iframe_enabled
    );
    const webhook = DEFAULT_LOGOUT_WEBHOOK_CONFIG;
    expect(SESSION_DEFAULTS['session.logout_webhook_enabled']).toBe(webhook.enabled);
    expect(SESSION_DEFAULTS['session.logout_webhook_include_sub']).toBe(webhook.include_sub_claim);
    expect(SESSION_DEFAULTS['session.logout_webhook_include_sid']).toBe(webhook.include_sid_claim);
  });

  it('ID-JAG settings', () => {
    expect(TOKENS_DEFAULTS['tokens.id_jag_allowed_issuers']).toEqual(
      DEFAULT_ID_JAG_CONFIG.allowedIssuers
    );
    expect(TOKENS_DEFAULTS['tokens.id_jag_max_token_lifetime']).toBe(
      DEFAULT_ID_JAG_CONFIG.maxTokenLifetime
    );
    expect(TOKENS_DEFAULTS['tokens.id_jag_include_tenant_claim']).toBe(
      DEFAULT_ID_JAG_CONFIG.includeTenantClaim
    );
    expect(TOKENS_DEFAULTS['tokens.id_jag_require_confidential_client']).toBe(
      DEFAULT_ID_JAG_CONFIG.requireConfidentialClient
    );
  });

  it('JIT provisioning settings', () => {
    expect(EXTERNAL_IDP_DEFAULTS['external_idp.jit_require_verified_email']).toBe(
      DEFAULT_JIT_CONFIG.require_verified_email
    );
    expect(DEFAULT_JIT_CONFIG.allowed_provider_ids).toBeNull();
    expect(EXTERNAL_IDP_DEFAULTS['external_idp.jit_allowed_provider_ids']).toBe('');
    expect(EXTERNAL_IDP_DEFAULTS['external_idp.jit_join_all_matching_orgs']).toBe(
      DEFAULT_JIT_CONFIG.join_all_matching_orgs
    );
    expect(EXTERNAL_IDP_DEFAULTS['external_idp.jit_allow_user_without_org']).toBe(
      DEFAULT_JIT_CONFIG.allow_user_without_org
    );
    expect(EXTERNAL_IDP_DEFAULTS['external_idp.jit_default_role_id']).toBe(
      DEFAULT_JIT_CONFIG.default_role_id
    );
    expect(EXTERNAL_IDP_DEFAULTS['external_idp.jit_allow_unverified_domain_mappings']).toBe(
      DEFAULT_JIT_CONFIG.allow_unverified_domain_mappings
    );
  });

  it('tenant UI paths', () => {
    expect(TENANT_DEFAULTS['tenant.ui_device_path']).toBe(DEFAULT_UI_PATHS.device);
    expect(TENANT_DEFAULTS['tenant.ui_device_authorize_path']).toBe(
      DEFAULT_UI_PATHS.deviceAuthorize
    );
    expect(TENANT_DEFAULTS['tenant.ui_logout_complete_path']).toBe(DEFAULT_UI_PATHS.logoutComplete);
    expect(TENANT_DEFAULTS['tenant.ui_logged_out_path']).toBe(DEFAULT_UI_PATHS.loggedOut);
    expect(TENANT_DEFAULTS['tenant.ui_register_path']).toBe(DEFAULT_UI_PATHS.register);
  });

  it('rate limit profiles', () => {
    expect(RATE_LIMIT_DEFAULTS['rate_limit.public_read']).toBe(
      RateLimitProfiles.publicRead.maxRequests
    );
    expect(RATE_LIMIT_DEFAULTS['rate_limit.login_start']).toBe(
      RateLimitProfiles.loginStart.maxRequests
    );
    expect(RATE_LIMIT_DEFAULTS['rate_limit.send_challenge']).toBe(
      RateLimitProfiles.sendChallenge.maxRequests
    );
    expect(RATE_LIMIT_DEFAULTS['rate_limit.loadtest']).toBe(RateLimitProfiles.loadTest.maxRequests);
    const windows = {
      strict: RateLimitProfiles.strict,
      moderate: RateLimitProfiles.moderate,
      lenient: RateLimitProfiles.lenient,
      public_read: RateLimitProfiles.publicRead,
      login_start: RateLimitProfiles.loginStart,
      send_challenge: RateLimitProfiles.sendChallenge,
      loadtest: RateLimitProfiles.loadTest,
    };
    for (const [name, profile] of Object.entries(windows)) {
      expect(
        RATE_LIMIT_DEFAULTS[`rate_limit.${name}_window_seconds` as keyof typeof RATE_LIMIT_DEFAULTS]
      ).toBe(profile.windowSeconds);
    }
    // Every profile the rate limiter has has its keys.
    expect(Object.keys(RATE_LIMIT_PROFILE_SETTING_NAMES)).toEqual(Object.keys(RateLimitProfiles));
  });

  it('FAPI message signing algorithms', () => {
    expect(SECURITY_DEFAULTS['security.request_object_signing_algs']).toBe(
      FAPI2_MESSAGE_SIGNING_ALGS.join(',')
    );
  });

  it('CIBA request lifetime, polling interval and binding message settings', () => {
    expect(CIBA_DEFAULTS['ciba.expires_in']).toBe(CIBA_CONSTANTS.DEFAULT_EXPIRES_IN);
    expect(CIBA_DEFAULTS['ciba.min_expires_in']).toBe(CIBA_CONSTANTS.MIN_EXPIRES_IN);
    expect(CIBA_DEFAULTS['ciba.max_expires_in']).toBe(CIBA_CONSTANTS.MAX_EXPIRES_IN);
    expect(CIBA_DEFAULTS['ciba.poll_interval']).toBe(CIBA_CONSTANTS.DEFAULT_INTERVAL);
    expect(CIBA_DEFAULTS['ciba.min_interval']).toBe(CIBA_CONSTANTS.MIN_INTERVAL);
    expect(CIBA_DEFAULTS['ciba.max_interval']).toBe(CIBA_CONSTANTS.MAX_INTERVAL);
    expect(CIBA_DEFAULTS['ciba.max_binding_message_length']).toBe(
      CIBA_CONSTANTS.MAX_BINDING_MESSAGE_LENGTH
    );
    expect(CIBA_DEFAULTS['ciba.binding_message_required']).toBe(false);
  });

  it('CIBA polling, user code and ping settings', () => {
    expect(CIBA_DEFAULTS['ciba.slow_down_increment']).toBe(CIBA_CONSTANTS.SLOW_DOWN_INCREMENT);
    expect(CIBA_DEFAULTS['ciba.max_poll_count']).toBe(CIBA_CONSTANTS.MAX_POLL_COUNT);
    // The OP never verifies a user code: the switch is off unless the tenant turns it on.
    expect(CIBA_DEFAULTS['ciba.user_code_enabled']).toBe(false);
    expect(CIBA_DEFAULTS['ciba.ping_notification_timeout_ms']).toBe(5000);
  });

  it('CIBA slow_down increment cannot be set below the 5 seconds CIBA Core requires', () => {
    expect(CIBA_SETTINGS_META['ciba.slow_down_increment'].min).toBe(
      CIBA_HARD_LIMITS.minSlowDownIncrement
    );
    expect(CIBA_SETTINGS_META['ciba.slow_down_increment'].max).toBe(
      CIBA_HARD_LIMITS.maxSlowDownIncrement
    );
    expect(CIBA_SETTINGS_META['ciba.max_poll_count'].max).toBe(CIBA_HARD_LIMITS.maxPollCount);
    expect(CIBA_SETTINGS_META['ciba.ping_notification_timeout_ms'].max).toBe(
      CIBA_HARD_LIMITS.maxPingNotificationTimeoutMs
    );
  });

  it('every CIBA setting the runtime reads is whole-number checked and read strictly from env', () => {
    for (const key of [
      'ciba.slow_down_increment',
      'ciba.max_poll_count',
      'ciba.ping_notification_timeout_ms',
    ] as const) {
      expect(CIBA_SETTINGS_META[key].integer, key).toBe(true);
      expect(CIBA_SETTINGS_META[key].envNumber, key).toBe('strict-in-range');
      expect(CIBA_SETTINGS_META[key].status, key).toBeUndefined();
    }
    expect(CIBA_SETTINGS_META['ciba.user_code_enabled'].status).toBeUndefined();
  });

  it('CIBA settings stay inside the limits held in code', () => {
    expect(CIBA_SETTINGS_META['ciba.max_expires_in'].max).toBe(CIBA_HARD_LIMITS.maxExpiresIn);
    expect(CIBA_SETTINGS_META['ciba.max_interval'].max).toBe(CIBA_HARD_LIMITS.maxInterval);
    expect(CIBA_SETTINGS_META['ciba.max_binding_message_length'].max).toBe(
      CIBA_HARD_LIMITS.maxBindingMessageLength
    );
    expect(CIBA_SETTINGS_META['ciba.min_interval'].min).toBeLessThanOrEqual(
      CIBA_HARD_LIMITS.minInterval
    );
  });
  describe('device flow lifetime, polling and poll limit settings', () => {
    const wired = [
      'device_flow.expires_in',
      'device_flow.min_expires_in',
      'device_flow.max_expires_in',
      'device_flow.poll_interval',
      'device_flow.min_interval',
      'device_flow.max_interval',
      'device_flow.slow_down_increment',
      'device_flow.max_poll_count',
    ] as const;

    it('default to what the endpoint always issued', () => {
      expect(DEVICE_FLOW_DEFAULTS['device_flow.expires_in']).toBe(
        DEVICE_FLOW_CONSTANTS.DEFAULT_EXPIRES_IN
      );
      expect(DEVICE_FLOW_DEFAULTS['device_flow.min_expires_in']).toBe(
        DEVICE_FLOW_CONSTANTS.MIN_EXPIRES_IN
      );
      expect(DEVICE_FLOW_DEFAULTS['device_flow.max_expires_in']).toBe(
        DEVICE_FLOW_CONSTANTS.MAX_EXPIRES_IN
      );
      expect(DEVICE_FLOW_DEFAULTS['device_flow.poll_interval']).toBe(
        DEVICE_FLOW_CONSTANTS.DEFAULT_INTERVAL
      );
      expect(DEVICE_FLOW_DEFAULTS['device_flow.max_interval']).toBe(
        DEVICE_FLOW_CONSTANTS.MAX_INTERVAL
      );
      expect(DEVICE_FLOW_DEFAULTS['device_flow.slow_down_increment']).toBe(
        DEVICE_FLOW_CONSTANTS.SLOW_DOWN_INCREMENT
      );
      expect(DEVICE_FLOW_DEFAULTS['device_flow.max_poll_count']).toBe(
        DEVICE_FLOW_CONSTANTS.MAX_POLL_COUNT
      );
    });

    it('keep the default poll interval inside the default bounds', () => {
      // The default minimum (5) is above the old unused constant MIN_INTERVAL (1), but it only
      // clamps the poll interval, which is also 5 by default: nothing changes at the defaults.
      expect(DEVICE_FLOW_DEFAULTS['device_flow.min_interval']).toBeLessThanOrEqual(
        DEVICE_FLOW_DEFAULTS['device_flow.poll_interval']
      );
      expect(DEVICE_FLOW_DEFAULTS['device_flow.poll_interval']).toBeLessThanOrEqual(
        DEVICE_FLOW_DEFAULTS['device_flow.max_interval']
      );
      expect(DEVICE_FLOW_DEFAULTS['device_flow.min_expires_in']).toBeLessThanOrEqual(
        DEVICE_FLOW_DEFAULTS['device_flow.expires_in']
      );
      expect(DEVICE_FLOW_DEFAULTS['device_flow.expires_in']).toBeLessThanOrEqual(
        DEVICE_FLOW_DEFAULTS['device_flow.max_expires_in']
      );
    });

    it('stay inside the limits held in code', () => {
      expect(DEVICE_FLOW_SETTINGS_META['device_flow.max_expires_in'].max).toBe(
        DEVICE_FLOW_HARD_LIMITS.maxExpiresIn
      );
      expect(DEVICE_FLOW_SETTINGS_META['device_flow.max_interval'].max).toBe(
        DEVICE_FLOW_HARD_LIMITS.maxInterval
      );
      expect(DEVICE_FLOW_SETTINGS_META['device_flow.min_interval'].min).toBe(
        DEVICE_FLOW_HARD_LIMITS.minInterval
      );
      expect(DEVICE_FLOW_HARD_LIMITS.minInterval).toBe(DEVICE_FLOW_CONSTANTS.MIN_INTERVAL);
      expect(DEVICE_FLOW_SETTINGS_META['device_flow.slow_down_increment'].min).toBe(
        DEVICE_FLOW_HARD_LIMITS.minSlowDownIncrement
      );
      expect(DEVICE_FLOW_SETTINGS_META['device_flow.slow_down_increment'].max).toBe(
        DEVICE_FLOW_HARD_LIMITS.maxSlowDownIncrement
      );
      expect(DEVICE_FLOW_SETTINGS_META['device_flow.max_poll_count'].max).toBe(
        DEVICE_FLOW_HARD_LIMITS.maxPollCount
      );
    });

    it('cannot be set below the 5 seconds RFC 8628 requires for slow_down', () => {
      expect(DEVICE_FLOW_SETTINGS_META['device_flow.slow_down_increment'].min).toBe(5);
    });

    it('are whole-number checked, read strictly from env and applied', () => {
      for (const key of wired) {
        expect(DEVICE_FLOW_SETTINGS_META[key].integer, key).toBe(true);
        expect(DEVICE_FLOW_SETTINGS_META[key].envNumber, key).toBe('strict-in-range');
        expect(DEVICE_FLOW_SETTINGS_META[key].status, key).toBeUndefined();
      }
    });

    it('default the user code to what the endpoint always issued', () => {
      expect(DEVICE_FLOW_DEFAULTS['device_flow.user_code_charset']).toBe(DEFAULT_USER_CODE_CHARSET);
      expect(DEVICE_FLOW_DEFAULTS['device_flow.user_code_length']).toBe(DEFAULT_USER_CODE_LENGTH);
      // 8 characters of the 31 character alphabet, as before the setting existed
      expect(DEFAULT_USER_CODE_CHARSET).toBe('BASE31');
      expect(USER_CODE_CHARSETS.BASE31).toBe('23456789ABCDEFGHJKMNPQRSTUVWXYZ');
      expect(DEFAULT_USER_CODE_LENGTH).toBe(8);
      // and the default pair is above the entropy floor
      expect(isUserCodeFormatAllowed(DEFAULT_USER_CODE_CHARSET, DEFAULT_USER_CODE_LENGTH)).toBe(
        true
      );
    });

    it('offer exactly the alphabets the generator has', () => {
      expect(DEVICE_FLOW_SETTINGS_META['device_flow.user_code_charset'].enum).toEqual(
        USER_CODE_CHARSET_NAMES
      );
      expect(USER_CODE_CHARSETS.BASE20).toBe('BCDFGHJKLMNPQRSTVWXZ');
      expect(USER_CODE_CHARSETS.NUMERIC).toBe('0123456789');
    });

    it('allow the lengths the generator and the verification page handle', () => {
      const length = DEVICE_FLOW_SETTINGS_META['device_flow.user_code_length'];
      expect({ min: length.min, max: length.max }).toEqual({
        min: USER_CODE_MIN_LENGTH,
        max: USER_CODE_MAX_LENGTH,
      });
      expect(length.integer).toBe(true);
      expect(length.envNumber).toBe('strict-in-range');
    });

    it('apply per tenant only, and are no longer in development', () => {
      for (const key of [
        'device_flow.user_code_charset',
        'device_flow.user_code_length',
      ] as const) {
        expect(DEVICE_FLOW_SETTINGS_META[key].scopes, key).toEqual(['tenant']);
        expect(DEVICE_FLOW_SETTINGS_META[key].status, key).toBeUndefined();
      }
    });

    it('state the bits per charset and the floor in the description', () => {
      const charset = DEVICE_FLOW_SETTINGS_META['device_flow.user_code_charset'].description;
      for (const name of USER_CODE_CHARSET_NAMES) expect(charset).toContain(name);
      for (const name of USER_CODE_CHARSET_NAMES) {
        const bits = Math.log2(USER_CODE_CHARSETS[name].length).toFixed(2);
        expect(charset, name).toContain(`${bits} bits per character`);
        expect(charset, name).toContain(`${minimumUserCodeLength(name)} with ${name}`);
      }
      expect(charset).toContain(`${USER_CODE_MIN_ENTROPY_BITS} bits`);
    });

    it('allow the same ranges as CIBA for the values a poll record carries', () => {
      // The poll governor validates a record's max_interval, slow_down_increment and
      // max_poll_count against the CIBA metadata for both flows.
      for (const name of ['max_interval', 'slow_down_increment', 'max_poll_count']) {
        const device =
          DEVICE_FLOW_SETTINGS_META[`device_flow.${name}` as keyof typeof DEVICE_FLOW_DEFAULTS];
        const ciba = CIBA_SETTINGS_META[`ciba.${name}` as keyof typeof CIBA_DEFAULTS];
        expect({ min: device.min, max: device.max, integer: device.integer }, name).toEqual({
          min: ciba.min,
          max: ciba.max,
          integer: ciba.integer,
        });
      }
    });
  });
});
