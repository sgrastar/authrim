/**
 * Cloudflare Turnstile Human Verification Plugin
 *
 * Provides bot verification configuration for Login UI surfaces. Runtime
 * validation is performed by Authrim server endpoints via Cloudflare Siteverify.
 */

import { z } from 'zod';
import type { AuthrimPlugin, HealthStatus } from '../../core/types';
import { secretField } from '../../core/security';

export const TurnstileFailurePolicySchema = z.enum(['fail_closed', 'fail_open']);

export const CloudflareTurnstileConfigSchema = z.object({
  siteKey: z
    .string()
    .min(1, 'Site key is required')
    .describe('Cloudflare Turnstile widget sitekey used by Login UI'),
  secretKey: secretField(
    z
      .string()
      .min(1, 'Secret key is required')
      .describe('Cloudflare Turnstile secret key used only for server-side Siteverify')
  ),
  expectedHostname: z
    .string()
    .optional()
    .describe('Expected hostname returned by Siteverify. Leave blank to skip hostname matching.'),
  failurePolicy: TurnstileFailurePolicySchema.default('fail_closed').describe(
    'When Siteverify is unavailable: fail_closed rejects the authentication request, fail_open allows it'
  ),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(10000)
    .default(5000)
    .describe('Siteverify request timeout in milliseconds'),
});

export type CloudflareTurnstileConfig = z.infer<typeof CloudflareTurnstileConfigSchema>;
export type TurnstileFailurePolicy = z.infer<typeof TurnstileFailurePolicySchema>;

export const cloudflareTurnstilePlugin: AuthrimPlugin<CloudflareTurnstileConfig> = {
  id: 'human-verification-cloudflare-turnstile',
  version: '1.0.0',
  capabilities: ['human_verification.turnstile'],
  official: true,
  configSchema: CloudflareTurnstileConfigSchema,
  meta: {
    name: 'Cloudflare Turnstile',
    description:
      'Human verification for Login UI flows using Cloudflare Turnstile and server-side Siteverify.',
    category: 'security',
    author: {
      name: 'Authrim',
      url: 'https://authrim.com',
    },
    license: 'MIT',
    icon: 'shield-check',
    tags: ['cloudflare', 'turnstile', 'captcha', 'bot-protection', 'login-ui'],
    documentationUrl: 'https://developers.cloudflare.com/turnstile/',
    repositoryUrl: 'https://github.com/sgrastar/authrim',
    externalDependencies: [
      {
        name: 'Cloudflare Turnstile',
        url: 'https://developers.cloudflare.com/turnstile/',
        required: true,
        description:
          'Requires a Turnstile widget sitekey and secret key from the Cloudflare dashboard.',
      },
    ],
    minAuthrimVersion: '1.0.0',
    stability: 'beta',
    adminNotes: `
## Setup
1. Create a Turnstile widget in Cloudflare.
2. Add your Login UI hostnames to the widget.
3. Configure the sitekey and secret key here.
4. Enable Login, Signup, or Re-authentication usage in Authentication Methods.

## Runtime
Authrim validates \`cf-turnstile-response\` on the server. The secret key is never returned to Login UI.
`,
  },
  register(): void {
    // Configuration-only plugin. Runtime validation is handled by Authrim auth endpoints.
  },
  async healthCheck(_ctx, config): Promise<HealthStatus> {
    const configured = Boolean(config?.siteKey && config?.secretKey);
    return {
      status: configured ? 'healthy' : 'unhealthy',
      message: configured ? 'Turnstile configuration is present' : 'Missing site key or secret key',
      timestamp: Date.now(),
    };
  },
};

export default cloudflareTurnstilePlugin;
