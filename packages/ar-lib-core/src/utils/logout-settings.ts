/**
 * Back-channel logout settings under Settings API keys.
 *
 * The older `/api/admin/settings/logout` endpoint keeps a platform-wide document at
 * `settings:logout` (SETTINGS). Its back-channel fields are the Settings API `session.backchannel_*`
 * settings; this module converts between the two, so the Settings API can show the saved values as
 * the platform layer and the logout sender can apply what the Settings API resolves.
 */

import {
  LOGOUT_SETTINGS_KEY,
  type BackchannelLogoutConfig,
  type LogoutRetryConfig,
} from '../types/logout';

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

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The back-channel values an admin saved in the older logout document, keyed by Settings API key.
 * `on_final_failure` maps to `session.backchannel_on_failure`: 'alert' is 'error', 'log_only' is
 * 'log'.
 */
export function legacyLogoutSettingsValues(document: unknown): Record<string, unknown> {
  const backchannel =
    document && typeof document === 'object'
      ? (document as { backchannel?: unknown }).backchannel
      : undefined;
  if (!backchannel || typeof backchannel !== 'object') return {};
  const saved = backchannel as Partial<BackchannelLogoutConfig>;
  const values: Record<string, unknown> = {};
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

/** Read the older logout document from SETTINGS; throws when it cannot be read. */
export async function readLegacyLogoutSettings(
  kv: KVNamespace | undefined
): Promise<Record<string, unknown>> {
  if (!kv) return {};
  const raw = await kv.get(LOGOUT_SETTINGS_KEY);
  if (!raw) return {};
  try {
    return legacyLogoutSettingsValues(JSON.parse(raw));
  } catch {
    // The logout handler ignores a document it cannot parse.
    return {};
  }
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
