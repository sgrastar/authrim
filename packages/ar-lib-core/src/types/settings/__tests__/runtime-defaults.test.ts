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
});
