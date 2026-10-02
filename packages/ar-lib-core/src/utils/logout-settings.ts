/**
 * Logout settings under Settings API keys.
 *
 * The older `/api/admin/settings/logout` and `/api/admin/settings/logout-webhook` endpoints kept
 * platform-wide documents at `settings:logout` and `settings:logout_webhook` (SETTINGS). Their
 * fields are the Settings API `session.*` logout settings; this module converts the documents to
 * those keys (for the one-time import) and the resolved keys to the configs the
 * logout senders take. Fields that were only internal tuning (iframe timing, webhook timeout and
 * retries) are the code defaults.
 */

import {
  DEFAULT_LOGOUT_CONFIG,
  DEFAULT_LOGOUT_WEBHOOK_CONFIG,
  LOGOUT_SETTINGS_KEY,
  LOGOUT_WEBHOOK_SETTINGS_KEY,
  type BackchannelLogoutConfig,
  type LogoutConfig,
  type LogoutRetryConfig,
  type LogoutWebhookConfig,
} from '../types/logout';
import { parseSettingsDocument } from './tenant-settings';

type NumberField =
  | { key: string; field: 'logout_token_exp_seconds' | 'request_timeout_ms' }
  | { key: string; retry: keyof LogoutRetryConfig };

const NUMBER_FIELDS: NumberField[] = [
  { key: 'session.backchannel_logout_token_exp', field: 'logout_token_exp_seconds' },
  { key: 'session.backchannel_request_timeout_ms', field: 'request_timeout_ms' },
  { key: 'session.backchannel_retry_max_attempts', retry: 'max_attempts' },
  { key: 'session.backchannel_retry_initial_delay_ms', retry: 'initial_delay_ms' },
  { key: 'session.backchannel_retry_max_delay_ms', retry: 'max_delay_ms' },
  { key: 'session.backchannel_retry_backoff_multiplier', retry: 'backoff_multiplier' },
];

const ON_FAILURE_KEY = 'session.backchannel_on_failure';

/** On/off fields of the older logout document: [section, field, Settings API key]. */
const LOGOUT_SWITCHES = [
  ['backchannel', 'enabled', 'session.backchannel_enabled'],
  ['backchannel', 'include_sub_claim', 'session.backchannel_include_sub'],
  ['backchannel', 'include_sid_claim', 'session.backchannel_include_sid'],
  ['frontchannel', 'enabled', 'session.frontchannel_enabled'],
  ['session_management', 'enabled', 'session.session_management_enabled'],
  ['session_management', 'check_session_iframe_enabled', 'session.check_session_iframe_enabled'],
] as const;

/** On/off fields of the older logout webhook document: [field, Settings API key]. */
const WEBHOOK_SWITCHES = [
  ['enabled', 'session.logout_webhook_enabled'],
  ['include_sub_claim', 'session.logout_webhook_include_sub'],
  ['include_sid_claim', 'session.logout_webhook_include_sid'],
] as const;

/** The Settings API keys of back-channel, front-channel and session management (`settings:logout`). */
export const LOGOUT_CONFIG_SETTING_KEYS: readonly string[] = [
  ...NUMBER_FIELDS.map((entry) => entry.key),
  ON_FAILURE_KEY,
  ...LOGOUT_SWITCHES.map(([, , key]) => key),
];

/** The Settings API keys of the logout webhook (`settings:logout_webhook`). */
export const LOGOUT_WEBHOOK_SETTING_KEYS: readonly string[] = WEBHOOK_SWITCHES.map(
  ([, key]) => key
);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A saved on/off field as runtime read it: the documents were spread over the defaults and the
 * field tested for truth, so any saved value counts by its truth.
 */
function savedSwitch(section: Record<string, unknown> | undefined, field: string): unknown {
  if (!section || !(field in section) || section[field] === undefined) return undefined;
  return Boolean(section[field]);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The back-channel values an admin saved in the older logout document, keyed by Settings API key.
 * `on_final_failure` maps to `session.backchannel_on_failure`: 'alert' is 'error', 'log_only' is
 * 'log'.
 */
export function legacyLogoutSettingsValues(document: unknown): Record<string, unknown> {
  const sections = record(document);
  if (!sections) return {};
  const values: Record<string, unknown> = {};
  for (const [section, field, key] of LOGOUT_SWITCHES) {
    const value = savedSwitch(record(sections[section]), field);
    if (value !== undefined) values[key] = value;
  }
  const backchannel = record(sections.backchannel);
  if (!backchannel) return values;
  const saved = backchannel as Partial<BackchannelLogoutConfig>;
  for (const entry of NUMBER_FIELDS) {
    const value =
      'field' in entry
        ? saved[entry.field]
        : saved.retry && typeof saved.retry === 'object'
          ? saved.retry[entry.retry]
          : undefined;
    if (isNumber(value)) values[entry.key] = value;
  }
  if (saved.on_final_failure === 'alert') values[ON_FAILURE_KEY] = 'error';
  else if (saved.on_final_failure === 'log_only') values[ON_FAILURE_KEY] = 'log';
  return values;
}

/** The on/off values an admin saved in the older logout webhook document, by Settings API key. */
export function legacyLogoutWebhookSettingsValues(document: unknown): Record<string, unknown> {
  const saved = record(document);
  const values: Record<string, unknown> = {};
  for (const [field, key] of WEBHOOK_SWITCHES) {
    const value = savedSwitch(saved, field);
    if (value !== undefined) values[key] = value;
  }
  return values;
}

/** Read the older logout document from SETTINGS; throws when it cannot be read or parsed. */
export async function readLegacyLogoutSettings(
  kv: KVNamespace | undefined
): Promise<Record<string, unknown>> {
  if (!kv) return {};
  // A document that is not a JSON object throws: it is never taken for an absent one.
  return legacyLogoutSettingsValues(parseSettingsDocument(await kv.get(LOGOUT_SETTINGS_KEY)));
}

/** Read the older logout webhook document from SETTINGS; throws when it cannot be read or parsed. */
export async function readLegacyLogoutWebhookSettings(
  kv: KVNamespace | undefined
): Promise<Record<string, unknown>> {
  if (!kv) return {};
  return legacyLogoutWebhookSettingsValues(
    parseSettingsDocument(await kv.get(LOGOUT_WEBHOOK_SETTINGS_KEY))
  );
}

/**
 * Apply resolved `session.backchannel_*` values to a back-channel config. `session.backchannel_on_failure`
 * 'error' raises an alert; 'log' and 'ignore' only log.
 */
export function applyBackchannelLogoutSettings(
  base: BackchannelLogoutConfig,
  values: Record<string, unknown>
): BackchannelLogoutConfig {
  const config: BackchannelLogoutConfig = { ...base, retry: { ...base.retry } };
  for (const entry of NUMBER_FIELDS) {
    const value = values[entry.key];
    if (!isNumber(value)) continue;
    if ('field' in entry) config[entry.field] = value;
    else config.retry[entry.retry] = value;
  }
  const onFailure = values[ON_FAILURE_KEY];
  if (onFailure === 'error') config.on_final_failure = 'alert';
  else if (onFailure === 'log' || onFailure === 'ignore') config.on_final_failure = 'log_only';
  return config;
}

function switchValue(values: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = values[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** The logout config for resolved `session.*` settings (code defaults for the rest). */
export function logoutConfigFromValues(values: Record<string, unknown>): LogoutConfig {
  const defaults = DEFAULT_LOGOUT_CONFIG;
  const backchannel = applyBackchannelLogoutSettings(defaults.backchannel, values);
  backchannel.enabled = switchValue(values, 'session.backchannel_enabled', backchannel.enabled);
  backchannel.include_sub_claim = switchValue(
    values,
    'session.backchannel_include_sub',
    backchannel.include_sub_claim
  );
  backchannel.include_sid_claim = switchValue(
    values,
    'session.backchannel_include_sid',
    backchannel.include_sid_claim
  );
  return {
    backchannel,
    frontchannel: {
      ...defaults.frontchannel,
      enabled: switchValue(values, 'session.frontchannel_enabled', defaults.frontchannel.enabled),
    },
    session_management: {
      enabled: switchValue(
        values,
        'session.session_management_enabled',
        defaults.session_management.enabled
      ),
      check_session_iframe_enabled: switchValue(
        values,
        'session.check_session_iframe_enabled',
        defaults.session_management.check_session_iframe_enabled
      ),
    },
  };
}

/** The logout webhook config for resolved `session.logout_webhook_*` settings. */
export function logoutWebhookConfigFromValues(
  values: Record<string, unknown>
): LogoutWebhookConfig {
  const defaults = DEFAULT_LOGOUT_WEBHOOK_CONFIG;
  return {
    ...defaults,
    retry: { ...defaults.retry },
    enabled: switchValue(values, 'session.logout_webhook_enabled', defaults.enabled),
    include_sub_claim: switchValue(
      values,
      'session.logout_webhook_include_sub',
      defaults.include_sub_claim
    ),
    include_sid_claim: switchValue(
      values,
      'session.logout_webhook_include_sid',
      defaults.include_sid_claim
    ),
  };
}
