/**
 * Cloudflare Email Service Notifier Plugin
 *
 * Sends transactional email through the Cloudflare Workers `send_email`
 * binding. Domain onboarding remains manual in the Cloudflare dashboard.
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

export const CloudflareNotifierConfigSchema = z.object({
  defaultFrom: z
    .string()
    .email('Invalid sender email address')
    .describe(
      'Default sender email address. The domain must be onboarded to Cloudflare Email Service'
    ),

  fromName: z.string().optional().describe('Sender display name (optional)'),

  replyTo: z.string().email().optional().describe('Reply-to email address (optional)'),

  maxRecipientsPerRequest: z
    .number()
    .int()
    .min(1)
    .max(NOTIFIER_SECURITY_DEFAULTS.MAX_RECIPIENTS_PER_REQUEST)
    .default(50)
    .describe('Maximum recipients per request (Cloudflare currently allows up to 50 recipients)'),
});

export type CloudflareNotifierConfig = z.infer<typeof CloudflareNotifierConfigSchema>;

interface CloudflareEmailBinding {
  send(message: {
    to: string | string[];
    from: string | { email: string; name: string };
    subject: string;
    html?: string;
    text?: string;
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string | { email: string; name: string };
    headers?: Record<string, string>;
  }): Promise<{ messageId?: string }>;
}

function getEmailBinding(ctx?: PluginContext): CloudflareEmailBinding | undefined {
  const candidate =
    ctx?.env && 'EMAIL' in ctx.env ? (ctx.env as Record<string, unknown>).EMAIL : undefined;
  if (!candidate || typeof candidate !== 'object') {
    return undefined;
  }

  const send = (candidate as { send?: unknown }).send;
  if (typeof send !== 'function') {
    return undefined;
  }

  return candidate as CloudflareEmailBinding;
}

function getEmailBindingFromRuntime(handler: { __authrimWorkerEnv?: Record<string, unknown> }) {
  const env = handler.__authrimWorkerEnv;
  const candidate = env?.EMAIL;
  if (!candidate || typeof candidate !== 'object') {
    return undefined;
  }

  const send = (candidate as { send?: unknown }).send;
  if (typeof send !== 'function') {
    return undefined;
  }

  return candidate as CloudflareEmailBinding;
}

function resolveBody(notification: Notification): { html: string; text?: string } {
  const body = notification.templateVars
    ? renderTemplate(notification.body, notification.templateVars)
    : notification.body;
  const textBody = notification.metadata?.textBody;
  return {
    html: body,
    text: typeof textBody === 'string' ? textBody : undefined,
  };
}

function normalizeRecipients(values?: string[]): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  return Array.from(new Set(values));
}

function getRecipientCount(notification: Notification): number {
  return 1 + (notification.cc?.length ?? 0) + (notification.bcc?.length ?? 0);
}

function resolveFrom(
  notification: Notification,
  config: CloudflareNotifierConfig
): string | { email: string; name: string } {
  const email = notification.from || config.defaultFrom;
  return config.fromName ? { email, name: config.fromName } : email;
}

function resolveReplyTo(
  notification: Notification,
  config: CloudflareNotifierConfig
): string | { email: string; name: string } | undefined {
  const replyTo = notification.replyTo || config.replyTo;
  if (!replyTo) {
    return undefined;
  }
  return config.fromName ? { email: replyTo, name: config.fromName } : replyTo;
}

function createCloudflareHandler(config: CloudflareNotifierConfig): {
  __authrimWorkerEnv?: Record<string, unknown>;
  send(notification: Notification): Promise<SendResult>;
} {
  return {
    async send(notification: Notification): Promise<SendResult> {
      const binding = getEmailBindingFromRuntime(this);
      if (!binding) {
        return {
          success: false,
          error: 'Cloudflare Email Service binding `EMAIL` is not configured',
          retryable: false,
        };
      }

      if (notification.channel !== 'email') {
        return {
          success: false,
          error: 'Cloudflare Email Service only supports email notifications',
          retryable: false,
        };
      }

      if (!notification.subject) {
        return {
          success: false,
          error: 'Email subject is required',
          retryable: false,
        };
      }

      const recipientCount = getRecipientCount(notification);
      if (recipientCount > config.maxRecipientsPerRequest) {
        return {
          success: false,
          error: `Recipient count exceeds configured maximum (${config.maxRecipientsPerRequest})`,
          retryable: false,
        };
      }

      const { html, text } = resolveBody(notification);
      const headers =
        notification.metadata?.headers && typeof notification.metadata.headers === 'object'
          ? (notification.metadata.headers as Record<string, string>)
          : undefined;

      try {
        const response = await binding.send({
          to: notification.to,
          from: resolveFrom(notification, config),
          subject: notification.subject,
          html,
          text,
          cc: normalizeRecipients(notification.cc),
          bcc: normalizeRecipients(notification.bcc),
          replyTo: resolveReplyTo(notification, config),
          headers,
        });

        return {
          success: true,
          messageId: response.messageId || crypto.randomUUID(),
          providerResponse: response,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Cloudflare email send failed',
          retryable: true,
        };
      }
    },
  };
}

export const cloudflareEmailPlugin: AuthrimPlugin<CloudflareNotifierConfig> = {
  id: 'notifier-cloudflare',
  version: '1.0.0',
  capabilities: ['notifier.email'],
  official: true,
  configSchema: CloudflareNotifierConfigSchema,
  meta: {
    name: 'Cloudflare Email Service',
    description:
      'Transactional email sending through the native Cloudflare Workers Email Service binding.',
    category: 'notification',
    author: {
      name: 'Authrim',
      url: 'https://authrim.com',
    },
    license: 'MIT',
    icon: 'mail',
    tags: ['email', 'cloudflare', 'workers', 'transactional', 'otp'],
    documentationUrl: 'https://developers.cloudflare.com/email-service/',
    repositoryUrl: 'https://github.com/sgrastar/authrim',
    externalDependencies: [
      {
        name: 'Cloudflare Email Service',
        url: 'https://developers.cloudflare.com/email-service/',
        required: true,
        description:
          'Requires a Workers Paid plan plus Cloudflare DNS/domain onboarding for the sender domain',
      },
    ],
    minAuthrimVersion: '1.0.0',
    stability: 'beta',
    adminNotes: `
## Setup Steps
1. Enable Cloudflare Email Service for your domain in the Cloudflare dashboard
2. Use Cloudflare DNS for the sender domain
3. Deploy Authrim with the \`EMAIL\` send_email binding
4. Configure the sender address here if you need to override the bootstrap default

## Notes
- Cloudflare Email Service currently requires a Workers Paid plan
- Domain onboarding is still manual in the Cloudflare dashboard
- Authrim intentionally does not lock sender addresses in Wrangler so the sender can be changed later from plugin settings
    `.trim(),
  },

  register(registry: CapabilityRegistry, config: CloudflareNotifierConfig) {
    const handler = createCloudflareHandler(config);
    registry.registerNotifier('email', handler, this.id);
  },

  async initialize(ctx: PluginContext, config: CloudflareNotifierConfig): Promise<void> {
    const binding = getEmailBinding(ctx);
    if (!binding) {
      throw new Error('Cloudflare Email Service binding `EMAIL` is not configured');
    }

    ctx.logger.info('[cloudflare-email] Cloudflare Email Service notifier initialized', {
      defaultFrom: config.defaultFrom,
      fromName: config.fromName,
      maxRecipientsPerRequest: config.maxRecipientsPerRequest,
    });
  },

  async healthCheck(ctx?: PluginContext, config?: CloudflareNotifierConfig): Promise<HealthStatus> {
    if (!config) {
      return {
        status: 'unhealthy',
        message: 'Configuration not available',
      };
    }

    const binding = getEmailBinding(ctx);
    if (!binding) {
      return {
        status: 'unhealthy',
        message: 'Cloudflare Email Service binding `EMAIL` is missing',
      };
    }

    return {
      status: 'healthy',
      message: 'Cloudflare Email Service binding is available',
      checks: {
        binding: {
          status: 'pass',
          message: 'EMAIL binding is configured',
        },
        sender: {
          status: 'pass',
          message: `Default sender: ${config.defaultFrom}`,
        },
      },
      timestamp: Date.now(),
    };
  },
};
