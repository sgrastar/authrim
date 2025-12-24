/**
 * Console Notifier Plugin
 *
 * Development-only notifier that logs notifications to the console.
 * Useful for local development and testing.
 *
 * WARNING: Do not use in production - no actual notifications are sent!
 */

import { z } from 'zod';
import type {
  AuthrimPlugin,
  PluginContext,
  Notification,
  SendResult,
  HealthStatus,
} from '../../core/types';
import { CapabilityRegistry } from '../../core/registry';

// =============================================================================
// Configuration Schema
// =============================================================================

/**
 * Console notifier configuration
 */
export const ConsoleNotifierConfigSchema = z.object({
  /** Prefix for log messages */
  prefix: z.string().default('[AUTHRIM-NOTIFY]'),

  /** Include timestamp in logs */
  includeTimestamp: z.boolean().default(true),

  /** Log level */
  logLevel: z.enum(['debug', 'info', 'warn']).default('info'),

  /** Pretty print JSON payloads */
  prettyPrint: z.boolean().default(true),

  /** Simulate delay (ms) - useful for testing timeout handling */
  simulateDelayMs: z.number().int().min(0).max(5000).default(0),

  /** Simulate failure rate (0-1) - useful for testing error handling */
  simulateFailureRate: z.number().min(0).max(1).default(0),
});

export type ConsoleNotifierConfig = z.infer<typeof ConsoleNotifierConfigSchema>;

// =============================================================================
// Console Notifier Plugin
// =============================================================================

/**
 * Console Notifier Plugin
 *
 * Logs all notifications to console. For development and testing only.
 */
export const consoleNotifierPlugin: AuthrimPlugin<ConsoleNotifierConfig> = {
  id: 'notifier-console',
  version: '1.0.0',
  capabilities: ['notifier.email', 'notifier.sms', 'notifier.push'],
  official: true,
  configSchema: ConsoleNotifierConfigSchema,

  meta: {
    name: 'Console Notifier',
    description: 'Logs notifications to console (development only)',
    icon: 'terminal',
    category: 'notification',
    documentationUrl: 'https://docs.authrim.com/plugins/notifier-console',
  },

  register(registry: CapabilityRegistry, config: ConsoleNotifierConfig) {
    const handler = createConsoleNotifierHandler(config);

    // Register for all channels
    registry.registerNotifier('email', handler, this.id);
    registry.registerNotifier('sms', handler, this.id);
    registry.registerNotifier('push', handler, this.id);
  },

  async initialize(ctx: PluginContext, config: ConsoleNotifierConfig): Promise<void> {
    // Log initialization
    const logFn = getLogFunction(config.logLevel);
    logFn(`${config.prefix} Console Notifier initialized`, {
      channels: ['email', 'sms', 'push'],
      config: {
        includeTimestamp: config.includeTimestamp,
        logLevel: config.logLevel,
        simulateDelayMs: config.simulateDelayMs,
        simulateFailureRate: config.simulateFailureRate,
      },
    });

    // Warn if used in production
    if (ctx.env.ENVIRONMENT === 'production') {
      console.warn(
        `${config.prefix} ⚠️ WARNING: Console Notifier is enabled in production! ` +
          'No actual notifications will be sent. This is likely a configuration error.'
      );
    }
  },

  async healthCheck(): Promise<HealthStatus> {
    return {
      status: 'healthy',
      message: 'Console notifier is always healthy (logs to console)',
    };
  },
};

// =============================================================================
// Handler Implementation
// =============================================================================

function createConsoleNotifierHandler(config: ConsoleNotifierConfig) {
  const logFn = getLogFunction(config.logLevel);

  return {
    async send(notification: Notification): Promise<SendResult> {
      const timestamp = config.includeTimestamp ? new Date().toISOString() : '';
      const messageId = `console-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      // Simulate delay if configured
      if (config.simulateDelayMs > 0) {
        await sleep(config.simulateDelayMs);
      }

      // Simulate failure if configured
      if (config.simulateFailureRate > 0 && Math.random() < config.simulateFailureRate) {
        const error = 'Simulated failure (simulateFailureRate is configured)';
        logFn(`${config.prefix} ${timestamp} ❌ NOTIFICATION FAILED`, {
          channel: notification.channel,
          to: notification.to,
          error,
        });

        return {
          success: false,
          error,
        };
      }

      // Format the notification for logging
      const logData = formatNotificationForLog(notification, config.prettyPrint);

      // Log the notification
      logFn(`${config.prefix} ${timestamp} 📧 NOTIFICATION SENT`, {
        messageId,
        channel: notification.channel,
        to: notification.to,
        subject: notification.subject,
        ...logData,
      });

      return {
        success: true,
        messageId,
      };
    },

    supports(): boolean {
      // Console notifier supports all options
      return true;
    },
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

function getLogFunction(level: 'debug' | 'info' | 'warn'): typeof console.log {
  switch (level) {
    case 'debug':
      return console.debug;
    case 'info':
      return console.info;
    case 'warn':
      return console.warn;
    default:
      return console.info;
  }
}

function formatNotificationForLog(
  notification: Notification,
  prettyPrint: boolean
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  // Add body preview (truncated for readability)
  if (notification.body) {
    const bodyPreview =
      notification.body.length > 200 ? notification.body.slice(0, 200) + '...' : notification.body;
    data.bodyPreview = bodyPreview;
    data.bodyLength = notification.body.length;
  }

  // Add template info if present
  if (notification.templateId) {
    data.templateId = notification.templateId;
  }
  if (notification.templateVars) {
    data.templateVars = prettyPrint
      ? notification.templateVars
      : JSON.stringify(notification.templateVars);
  }

  // Add metadata if present
  if (notification.metadata) {
    data.metadata = prettyPrint ? notification.metadata : JSON.stringify(notification.metadata);
  }

  return data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Export
// =============================================================================

export default consoleNotifierPlugin;
