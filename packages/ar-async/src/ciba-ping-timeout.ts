/**
 * How long a ping notification waits for the client's endpoint (`ciba.ping_notification_timeout_ms`
 * of the tenant).
 *
 * The notification is awaited inline, in the request of the person who approves (or in the
 * conformance action), so this is how long that request can be held open by the client's endpoint.
 *
 * A timeout restricts nothing: when the tenant's settings cannot be read, the default stands in
 * (and the failure is logged) rather than failing an approval that has already been stored. That
 * differs from /bc-authorize, which refuses a request when its settings are unreadable because
 * `ciba.binding_message_required` is a restriction.
 */

import { CIBA_DEFAULTS, resolveCibaConfig, type Env, type Logger } from '@authrim/ar-lib-core';

export async function resolvePingTimeoutMs(
  env: Env,
  tenantId: string,
  log: Pick<Logger, 'warn'>
): Promise<number> {
  try {
    return (await resolveCibaConfig(env, tenantId)).pingNotificationTimeoutMs;
  } catch (error) {
    log.warn(
      'Failed to load CIBA settings for the ping notification; using the default timeout',
      { action: 'ciba_ping_timeout_settings', tenantId },
      error as Error
    );
    return CIBA_DEFAULTS['ciba.ping_notification_timeout_ms'];
  }
}
