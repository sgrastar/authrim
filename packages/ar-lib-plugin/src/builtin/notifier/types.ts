/**
 * Notifier Plugin Types
 *
 * Type definitions for notification plugins.
 */

import { z } from 'zod';

// =============================================================================
// Notification Types
// =============================================================================

/**
 * Email notification payload
 */
export const EmailNotificationSchema = z.object({
  /** Notification channel */
  channel: z.literal('email'),

  /** Recipient email address */
  to: z.string().email(),

  /** Sender email address (optional, uses default) */
  from: z.string().email().optional(),

  /** Email subject */
  subject: z.string().min(1).max(998), // RFC 2822 limit

  /** Email body (HTML) */
  body: z.string(),

  /** Reply-to address (optional) */
  replyTo: z.string().email().optional(),

  /** CC recipients (optional) */
  cc: z.array(z.string().email()).optional(),

  /** BCC recipients (optional) */
  bcc: z.array(z.string().email()).optional(),

  /** Template ID (optional) */
  templateId: z.string().optional(),

  /** Template variables (optional) */
  templateVars: z.record(z.unknown()).optional(),

  /** Additional metadata */
  metadata: z.record(z.unknown()).optional(),
});

export type EmailNotification = z.infer<typeof EmailNotificationSchema>;

/**
 * SMS notification payload
 */
export const SMSNotificationSchema = z.object({
  /** Notification channel */
  channel: z.literal('sms'),

  /** Recipient phone number (E.164 format) */
  to: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Phone number must be in E.164 format'),

  /** Sender phone number or ID (optional) */
  from: z.string().optional(),

  /** SMS body (max 1600 chars for concatenated SMS) */
  body: z.string().min(1).max(1600),

  /** Template ID (optional) */
  templateId: z.string().optional(),

  /** Template variables (optional) */
  templateVars: z.record(z.unknown()).optional(),

  /** Additional metadata */
  metadata: z.record(z.unknown()).optional(),
});

export type SMSNotification = z.infer<typeof SMSNotificationSchema>;

/**
 * Push notification payload
 */
export const PushNotificationSchema = z.object({
  /** Notification channel */
  channel: z.literal('push'),

  /** Device token or topic */
  to: z.string(),

  /** Notification title */
  subject: z.string().optional(),

  /** Notification body */
  body: z.string(),

  /** Badge count (optional) */
  badge: z.number().int().min(0).optional(),

  /** Sound (optional) */
  sound: z.string().optional(),

  /** Custom data payload (optional) */
  data: z.record(z.unknown()).optional(),

  /** Additional metadata */
  metadata: z.record(z.unknown()).optional(),
});

export type PushNotification = z.infer<typeof PushNotificationSchema>;

/**
 * Union of all notification types
 */
export const NotificationSchema = z.discriminatedUnion('channel', [
  EmailNotificationSchema,
  SMSNotificationSchema,
  PushNotificationSchema,
]);

export type NotificationPayload = z.infer<typeof NotificationSchema>;

// =============================================================================
// Send Result Types
// =============================================================================

/**
 * Successful send result
 */
export interface SendSuccess {
  success: true;
  messageId: string;
  providerResponse?: unknown;
}

/**
 * Failed send result
 */
export interface SendFailure {
  success: false;
  error: string;
  errorCode?: string;
  retryable?: boolean;
  providerResponse?: unknown;
}

export type NotificationSendResult = SendSuccess | SendFailure;

// =============================================================================
// Template Types
// =============================================================================

/**
 * Notification template
 */
export interface NotificationTemplate {
  /** Template ID */
  id: string;

  /** Template name */
  name: string;

  /** Template channel */
  channel: 'email' | 'sms' | 'push';

  /** Subject template (for email) */
  subject?: string;

  /** Body template */
  body: string;

  /** Available variables */
  variables: string[];

  /** Locale */
  locale?: string;
}

/**
 * Render template with variables
 */
export function renderTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) {
      return match;
    }
    const value = variables[key];
    if (value === undefined || value === null) {
      return match;
    }
    // Handle objects by JSON stringifying them
    if (typeof value === 'object') {
      return JSON.stringify(value);
    }
    // Handle primitives
    return String(value as string | number | boolean);
  });
}

// =============================================================================
// Security Constants
// =============================================================================

/**
 * Default security settings for notifiers
 *
 * All notifier plugins should respect these defaults.
 */
export const NOTIFIER_SECURITY_DEFAULTS = {
  /** Default timeout for external API calls (ms) */
  DEFAULT_TIMEOUT_MS: 10000,

  /** Maximum timeout allowed (ms) */
  MAX_TIMEOUT_MS: 30000,

  /** Maximum recipients per request */
  MAX_RECIPIENTS_PER_REQUEST: 50,

  /** Maximum body size (bytes) */
  MAX_BODY_SIZE: 1024 * 1024, // 1MB

  /** Maximum subject length (chars) */
  MAX_SUBJECT_LENGTH: 998,

  /** Allow localhost in production */
  ALLOW_LOCALHOST_IN_PRODUCTION: false,

  /** Maximum retries for transient failures */
  MAX_RETRIES: 3,

  /** Retry delay base (ms) */
  RETRY_DELAY_BASE_MS: 1000,
} as const;
