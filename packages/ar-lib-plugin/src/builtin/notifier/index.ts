/**
 * Notifier Plugins
 *
 * Built-in notification plugins for Authrim.
 */

// Types
export type {
  EmailNotification,
  SMSNotification,
  PushNotification,
  NotificationPayload,
  SendSuccess,
  SendFailure,
  NotificationSendResult,
  NotificationTemplate,
} from './types';

export {
  EmailNotificationSchema,
  SMSNotificationSchema,
  PushNotificationSchema,
  NotificationSchema,
  NOTIFIER_SECURITY_DEFAULTS,
  renderTemplate,
} from './types';

// Console Notifier (development)
export { consoleNotifierPlugin, ConsoleNotifierConfigSchema } from './console';
export type { ConsoleNotifierConfig } from './console';

// Resend Email Notifier (production)
export { resendEmailPlugin, ResendNotifierConfigSchema } from './resend';
export type { ResendNotifierConfig } from './resend';

// =============================================================================
// Plugin Registry
// =============================================================================

import { consoleNotifierPlugin } from './console';
import { resendEmailPlugin } from './resend';

/**
 * All built-in notifier plugins
 *
 * Use this for bulk registration or discovery.
 */
export const builtinNotifierPlugins = [consoleNotifierPlugin, resendEmailPlugin] as const;
