import type { InProcessPluginHookHandler } from './backend-router';
import type { PluginRunnerEnv } from './types';

export const LOCAL_LOG_NOTIFIER_PLUGIN_ID = 'notifier-log';

/**
 * Deployment variable that enables the local log notifier. `authrim-setup local` sets it for
 * `wrangler dev`; setup never emits it for a Cloudflare deployment.
 */
export const LOCAL_LOG_NOTIFIER_ENV = 'AUTHRIM_LOCAL_NOTIFICATION_LOG';

export function isLocalLogNotifierEnabled(env: PluginRunnerEnv): boolean {
  return env[LOCAL_LOG_NOTIFIER_ENV] === 'true';
}

/**
 * Local development only. Writes the delivery to the Worker log so a developer can read one-time
 * codes and magic links without an email or SMS provider.
 *
 * The log line contains the secret itself (the code or link). That is acceptable only on a
 * developer machine, which is why this handler is registered solely when
 * {@link LOCAL_LOG_NOTIFIER_ENV} is `true`, and is absent from every Cloudflare deployment.
 */
export function localLogNotifierHandler(): InProcessPluginHookHandler {
  return async (invocation) => {
    if (invocation.capability !== 'notifier.send' || !('delivery' in invocation.payload)) {
      throw new Error('plugin_in_process_message_rejected');
    }
    const { delivery, notificationKind } = invocation.payload;
    // eslint-disable-next-line no-console -- the log line is this provider's only output
    console.log(
      `[LOCAL-NOTIFICATION] ${JSON.stringify({
        kind: notificationKind,
        tenantId: invocation.tenantId,
        ...delivery,
      })}`
    );
    return { providerMessageId: `local-log-${crypto.randomUUID()}` };
  };
}
