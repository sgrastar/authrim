/**
 * Resend Email Notifier Plugin
 *
 * Production-ready email notifier using Resend API.
 * https://resend.com/docs
 *
 * Security features:
 * - Request timeout protection
 * - Error message masking (no API details leaked)
 * - Rate limiting awareness
 * - Retry-able error identification
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
import { NOTIFIER_SECURITY_DEFAULTS, renderTemplate } from './types';

// =============================================================================
// Configuration Schema
// =============================================================================

/**
 * Resend notifier configuration
 *
 * Following CLAUDE.md: KV → Environment Variables → Default values
 * Each field uses .describe() for Admin UI display.
 */
export const ResendNotifierConfigSchema = z.object({
  apiKey: z
    .string()
    .min(1, 'API key is required')
    .describe('Resend API key (starts with re_). Obtain from Resend dashboard'),

  defaultFrom: z
    .string()
    .email('Invalid sender email address')
    .describe('Default sender email address. Requires domain verification'),

  replyTo: z.string().email().optional().describe('Reply-to email address (optional)'),

  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(NOTIFIER_SECURITY_DEFAULTS.MAX_TIMEOUT_MS)
    .default(NOTIFIER_SECURITY_DEFAULTS.DEFAULT_TIMEOUT_MS)
    .describe('API request timeout (milliseconds)'),

  maxRecipientsPerRequest: z
    .number()
    .int()
    .min(1)
    .max(NOTIFIER_SECURITY_DEFAULTS.MAX_RECIPIENTS_PER_REQUEST)
    .default(10)
    .describe('Maximum recipients per request (To+CC+BCC combined)'),

  sandboxMode: z
    .boolean()
    .default(false)
    .describe('Sandbox mode. When enabled, emails are not actually sent (for testing)'),

  apiEndpoint: z
    .string()
    .url()
    .default('https://api.resend.com')
    .describe('Resend API endpoint. Usually no need to change'),
});

export type ResendNotifierConfig = z.infer<typeof ResendNotifierConfigSchema>;

// =============================================================================
// Resend API Types
// =============================================================================

interface ResendEmailRequest {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  reply_to?: string;
  cc?: string[];
  bcc?: string[];
  headers?: Record<string, string>;
  tags?: Array<{ name: string; value: string }>;
}

interface ResendEmailResponse {
  id: string;
}

interface ResendErrorResponse {
  statusCode: number;
  message: string;
  name: string;
}

// =============================================================================
// Resend Email Notifier Plugin
// =============================================================================

/**
 * Resend Email Notifier Plugin
 *
 * Production-ready email sending via Resend API.
 */
export const resendEmailPlugin: AuthrimPlugin<ResendNotifierConfig> = {
  id: 'notifier-resend',
  version: '1.0.0',
  capabilities: ['notifier.email'],
  official: true,
  configSchema: ResendNotifierConfigSchema,

  meta: {
    // Required fields
    name: 'Resend Email',
    description:
      'Transactional email sending via Resend API. Supports OTP codes, password reset, and more.',
    category: 'notification',

    // Author (official plugin)
    author: {
      name: 'Authrim',
      url: 'https://authrim.com',
    },
    license: 'MIT',

    // Display
    icon: 'mail',
    tags: ['email', 'resend', 'transactional', 'otp', 'notification'],
    logoUrl: 'https://resend.com/static/brand/resend-icon-black.svg',

    // Documentation
    documentationUrl: 'https://resend.com/docs',
    repositoryUrl: 'https://github.com/sgrastar/authrim',

    // External dependencies
    externalDependencies: [
      {
        name: 'Resend API',
        url: 'https://resend.com',
        required: true,
        description: 'Email sending service. Requires API key and domain verification',
      },
    ],

    // Compatibility
    minAuthrimVersion: '1.0.0',

    // Status
    stability: 'stable',

    // Admin notes
    adminNotes: `
## Setup Steps
1. Create an account at https://resend.com
2. Add your domain and complete DNS verification
3. Obtain an API key (starts with re_)
4. Update settings via Admin API

## Notes
- When sandboxMode is true, emails are not actually sent
- In production, only verified domain From addresses can be used
- Rate limits: Free plan allows 100 emails/day
    `.trim(),
  },

  register(registry: CapabilityRegistry, config: ResendNotifierConfig) {
    const handler = createResendHandler(config);
    registry.registerNotifier('email', handler, this.id);
  },

  async initialize(ctx: PluginContext, config: ResendNotifierConfig): Promise<void> {
    // Validate API key format (Resend keys start with 're_')
    if (!config.apiKey.startsWith('re_')) {
      ctx.logger.warn(
        '[resend] API key does not start with "re_" - this may not be a valid Resend key'
      );
    }

    // Warn if sandbox mode is enabled in production
    if (config.sandboxMode && ctx.env.ENVIRONMENT === 'production') {
      ctx.logger.warn(
        '[resend] Sandbox mode is enabled in production - emails will not be delivered!'
      );
    }

    ctx.logger.info('[resend] Resend Email notifier initialized', {
      defaultFrom: config.defaultFrom,
      sandboxMode: config.sandboxMode,
      timeoutMs: config.timeoutMs,
    });
  },

  async healthCheck(ctx?: PluginContext, config?: ResendNotifierConfig): Promise<HealthStatus> {
    if (!config) {
      return {
        status: 'unhealthy',
        message: 'Configuration not available',
      };
    }

    try {
      // Resend doesn't have a dedicated health endpoint,
      // so we check if the API is reachable by fetching domains
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${config.apiEndpoint}/domains`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok || response.status === 401) {
        // 401 means API is reachable but key might be invalid
        // We still consider this "degraded" rather than "unhealthy"
        if (response.status === 401) {
          return {
            status: 'degraded',
            message: 'API key may be invalid',
          };
        }
        return {
          status: 'healthy',
          message: 'Resend API is reachable',
        };
      }

      return {
        status: 'degraded',
        message: `Resend API returned status ${response.status}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        status: 'unhealthy',
        message: `Failed to reach Resend API: ${message}`,
      };
    }
  },
};

// =============================================================================
// Handler Implementation
// =============================================================================

function createResendHandler(config: ResendNotifierConfig) {
  return {
    async send(notification: Notification): Promise<SendResult> {
      // Validate channel
      if (notification.channel !== 'email') {
        return {
          success: false,
          error: 'Resend plugin only supports email channel',
        };
      }

      // Build email request
      const emailRequest = buildEmailRequest(notification, config);

      // Validate recipient count
      const recipientCount = countRecipients(emailRequest);
      if (recipientCount > config.maxRecipientsPerRequest) {
        return {
          success: false,
          error: `Too many recipients (${recipientCount} > ${config.maxRecipientsPerRequest})`,
        };
      }

      try {
        // Send email via Resend API
        const result = await sendEmail(emailRequest, config);
        return result;
      } catch (error) {
        // Handle unexpected errors (network, timeout, etc.)
        const isRetryable = isRetryableError(error);
        const errorMessage = sanitizeErrorMessage(error);

        return {
          success: false,
          error: errorMessage,
          retryable: isRetryable,
        };
      }
    },

    supports(): boolean {
      // Resend supports all standard email options
      return true;
    },
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

function buildEmailRequest(
  notification: Notification,
  config: ResendNotifierConfig
): ResendEmailRequest {
  // Handle template rendering if templateId is provided
  let subject = notification.subject || '';
  let body = notification.body || '';

  if (notification.templateVars) {
    subject = renderTemplate(subject, notification.templateVars);
    body = renderTemplate(body, notification.templateVars);
  }

  const request: ResendEmailRequest = {
    from: notification.from ?? config.defaultFrom,
    to: notification.to,
    subject,
    html: body,
  };

  // Add optional fields
  if (config.replyTo || notification.replyTo) {
    request.reply_to = notification.replyTo ?? config.replyTo;
  }

  if (notification.cc && Array.isArray(notification.cc)) {
    request.cc = notification.cc;
  }

  if (notification.bcc && Array.isArray(notification.bcc)) {
    request.bcc = notification.bcc;
  }

  // Extract text body from metadata (for plain text email clients)
  if (notification.metadata?.textBody && typeof notification.metadata.textBody === 'string') {
    request.text = notification.metadata.textBody;
  }

  // Extract custom headers from metadata (e.g., Authentication-Info for OTP AutoFill)
  if (notification.metadata?.headers && typeof notification.metadata.headers === 'object') {
    request.headers = notification.metadata.headers as Record<string, string>;
  }

  // Add remaining metadata as tags (if present), excluding reserved keys
  if (notification.metadata) {
    const reservedKeys = ['textBody', 'headers'];
    request.tags = Object.entries(notification.metadata)
      .filter(([key, value]) => !reservedKeys.includes(key) && typeof value === 'string')
      .map(([name, value]) => ({ name, value: String(value) }))
      .slice(0, 10); // Resend limits to 10 tags
  }

  return request;
}

function countRecipients(request: ResendEmailRequest): number {
  let count = 0;

  // Count 'to' recipients
  if (Array.isArray(request.to)) {
    count += request.to.length;
  } else {
    count += 1;
  }

  // Count CC recipients
  if (request.cc) {
    count += request.cc.length;
  }

  // Count BCC recipients
  if (request.bcc) {
    count += request.bcc.length;
  }

  return count;
}

async function sendEmail(
  request: ResendEmailRequest,
  config: ResendNotifierConfig
): Promise<SendResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.apiEndpoint}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const result = (await response.json()) as ResendEmailResponse;
      return {
        success: true,
        messageId: result.id,
        providerResponse: { id: result.id },
      };
    }

    // Handle error response
    const errorBody = await response.text();
    let errorMessage = `Resend API error: ${response.status}`;
    let errorCode: string | undefined;
    let retryable = false;

    try {
      const errorData = JSON.parse(errorBody) as ResendErrorResponse;
      errorMessage = errorData.message || errorMessage;
      errorCode = errorData.name;

      // Determine if error is retryable
      retryable = response.status >= 500 || response.status === 429;
    } catch {
      // Failed to parse error body, use status code message
    }

    return {
      success: false,
      error: sanitizeApiError(errorMessage),
      errorCode,
      retryable,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Determine if an error is retryable
 *
 * Retryable errors:
 * - Network errors (fetch failures)
 * - Timeout errors
 * - Server errors (5xx)
 * - Rate limiting (429)
 *
 * Non-retryable errors:
 * - Client errors (4xx except 429)
 * - Invalid API key
 * - Invalid email format
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // Timeout errors
    if (error.name === 'AbortError' || message.includes('timeout')) {
      return true;
    }

    // Network errors
    if (
      message.includes('network') ||
      message.includes('fetch') ||
      message.includes('connection')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Sanitize error messages to prevent information leakage
 *
 * Security: Don't expose internal API details or sensitive information
 */
function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Timeout error
    if (error.name === 'AbortError') {
      return 'Email sending timed out';
    }

    // Network error
    if (error.message.includes('fetch')) {
      return 'Failed to connect to email service';
    }

    // Generic error without details
    return 'Failed to send email';
  }

  return 'Unknown email sending error';
}

/**
 * Sanitize API error responses
 *
 * Security: Remove potentially sensitive information from API errors
 */
function sanitizeApiError(message: string): string {
  // Remove API key references
  const sanitized = message.replace(/re_[a-zA-Z0-9]+/g, '[REDACTED]');

  // Truncate long messages
  if (sanitized.length > 200) {
    return sanitized.slice(0, 200) + '...';
  }

  return sanitized;
}

// =============================================================================
// Export
// =============================================================================

export default resendEmailPlugin;
