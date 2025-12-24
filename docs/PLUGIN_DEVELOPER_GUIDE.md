# Authrim Plugin Developer Guide

**Version:** 1.0.0
**Audience:** Plugin Developers
**Last Updated:** 2024-12-24

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Creating Your First Plugin](#2-creating-your-first-plugin)
3. [Notifier Plugins](#3-notifier-plugins)
4. [Identity Provider Plugins](#4-identity-provider-plugins)
5. [Authenticator Plugins](#5-authenticator-plugins)
6. [Configuration Schema](#6-configuration-schema)
7. [Testing Plugins](#7-testing-plugins)
8. [Best Practices](#8-best-practices)
9. [Troubleshooting](#9-troubleshooting)
10. [Examples](#10-examples)

---

## 1. Getting Started

### 1.1 Prerequisites

- Node.js 18+ or Bun
- TypeScript 5.0+
- Familiarity with Zod schema validation
- Understanding of async/await patterns

### 1.2 Installation

```bash
# Using pnpm (recommended)
pnpm add @authrim/ar-lib-plugin zod

# Using npm
npm install @authrim/ar-lib-plugin zod

# Using bun
bun add @authrim/ar-lib-plugin zod
```

### 1.3 Core Concepts

| Concept | Description |
|---------|-------------|
| **Plugin** | A module implementing `AuthrimPlugin` interface |
| **Capability** | A feature provided by a plugin (e.g., `notifier.email`) |
| **Registry** | Central storage for all registered capabilities |
| **Context** | Runtime environment providing access to storage, policy, config |
| **Handler** | The actual implementation that processes requests |

### 1.4 Plugin Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│                     Plugin Lifecycle                         │
├─────────────────────────────────────────────────────────────┤
│  1. LOAD                                                     │
│     ├── Validate config against schema                       │
│     └── Create plugin instance                               │
├─────────────────────────────────────────────────────────────┤
│  2. INITIALIZE (optional)                                    │
│     ├── Connect to external services                         │
│     ├── Warm up caches                                       │
│     └── Validate dependencies                                │
├─────────────────────────────────────────────────────────────┤
│  3. REGISTER                                                 │
│     ├── Register capabilities with registry                  │
│     └── Must be synchronous, no side effects                 │
├─────────────────────────────────────────────────────────────┤
│  4. ACTIVE                                                   │
│     └── Plugin handles requests via registered handlers      │
├─────────────────────────────────────────────────────────────┤
│  5. SHUTDOWN (optional)                                      │
│     ├── Close connections                                    │
│     └── Cleanup resources                                    │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Creating Your First Plugin

### 2.1 Basic Plugin Structure

```typescript
import { z } from 'zod';
import type {
  AuthrimPlugin,
  PluginContext,
  CapabilityRegistry,
  HealthStatus,
} from '@authrim/ar-lib-plugin';

// 1. Define configuration schema
const configSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  endpoint: z.string().url().default('https://api.example.com'),
  timeout: z.number().int().min(1000).max(30000).default(10000),
});

type MyPluginConfig = z.infer<typeof configSchema>;

// 2. Create the plugin
export const myPlugin: AuthrimPlugin<MyPluginConfig> = {
  // Required: Unique identifier
  id: 'my-custom-plugin',

  // Required: Semantic version
  version: '1.0.0',

  // Required: Capabilities this plugin provides
  capabilities: ['notifier.custom'],

  // Optional: Mark as official
  official: false,

  // Required: Configuration schema
  configSchema,

  // Optional: UI metadata
  meta: {
    name: 'My Custom Plugin',
    description: 'A custom notification plugin',
    category: 'notification',
    icon: 'bell',
    documentationUrl: 'https://docs.example.com',
  },

  // Optional: Initialize external connections
  async initialize(ctx: PluginContext, config: MyPluginConfig): Promise<void> {
    ctx.logger.info('Initializing plugin', { pluginId: this.id });

    // Validate external service connectivity
    const response = await fetch(`${config.endpoint}/health`, {
      signal: AbortSignal.timeout(config.timeout),
    });

    if (!response.ok) {
      throw new Error(`Service unavailable: ${response.status}`);
    }

    ctx.logger.info('Plugin initialized successfully');
  },

  // Required: Register capabilities
  register(registry: CapabilityRegistry, config: MyPluginConfig): void {
    registry.registerNotifier('custom', {
      async send(notification) {
        // Implementation here
        const response = await fetch(`${config.endpoint}/send`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            to: notification.to,
            message: notification.body,
          }),
          signal: AbortSignal.timeout(config.timeout),
        });

        if (!response.ok) {
          return {
            success: false,
            error: `API error: ${response.status}`,
            retryable: response.status >= 500,
          };
        }

        const result = await response.json();
        return {
          success: true,
          messageId: result.id,
        };
      },
    });
  },

  // Optional: Health check
  async healthCheck(): Promise<HealthStatus> {
    return {
      status: 'healthy',
      timestamp: Date.now(),
    };
  },

  // Optional: Cleanup
  async shutdown(): Promise<void> {
    // Close connections, cleanup resources
  },
};
```

### 2.2 Registering Your Plugin

```typescript
import { createPluginContext, createPluginLoader, globalRegistry } from '@authrim/ar-lib-plugin';
import { myPlugin } from './my-plugin';

// In your Worker initialization
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Create plugin context
    const ctx = await createPluginContext(env, {
      tenantId: 'default',
    });

    // Create plugin loader
    const loader = createPluginLoader(globalRegistry);

    // Load configuration (from KV, env, or defaults)
    const config = await ctx.config.get(myPlugin.id, myPlugin.configSchema);

    // Load the plugin
    await loader.loadPlugin(myPlugin, ctx, config);

    // Now the plugin is active and capabilities are registered
    const notifier = globalRegistry.getNotifier('custom');
    if (notifier) {
      await notifier.send({
        channel: 'custom',
        to: 'user@example.com',
        body: 'Hello from Authrim!',
      });
    }

    return new Response('OK');
  },
};
```

---

## 3. Notifier Plugins

### 3.1 NotifierHandler Interface

```typescript
interface NotifierHandler {
  /**
   * Send a notification
   */
  send(notification: Notification): Promise<SendResult>;

  /**
   * Check if this handler supports the given options (optional)
   */
  supports?(options: NotificationOptions): boolean;
}
```

### 3.2 Notification Object

```typescript
interface Notification {
  channel: string;           // 'email', 'sms', 'push', 'webhook'
  to: string;                // Recipient address
  from?: string;             // Sender (optional, use default)
  subject?: string;          // Subject line (email)
  body: string;              // Message content
  replyTo?: string;          // Reply-to address (email)
  cc?: string[];             // CC recipients (email)
  bcc?: string[];            // BCC recipients (email)
  templateId?: string;       // Template identifier
  templateVars?: Record<string, unknown>;  // Template variables
  metadata?: Record<string, unknown>;      // Custom metadata
}
```

### 3.3 SendResult Object

```typescript
interface SendResult {
  success: boolean;          // Whether send succeeded
  messageId?: string;        // Provider's message ID
  error?: string;            // Error message if failed
  errorCode?: string;        // Provider's error code
  retryable?: boolean;       // Can this be retried?
  providerResponse?: unknown; // Raw provider response
}
```

### 3.4 Example: Twilio SMS Plugin

```typescript
import { z } from 'zod';
import type { AuthrimPlugin, Notification, SendResult } from '@authrim/ar-lib-plugin';

const configSchema = z.object({
  accountSid: z.string().min(1),
  authToken: z.string().min(1),
  fromNumber: z.string().regex(/^\+[1-9]\d{1,14}$/, 'Invalid phone number format'),
  timeout: z.number().default(10000),
});

type TwilioConfig = z.infer<typeof configSchema>;

export const twilioSmsPlugin: AuthrimPlugin<TwilioConfig> = {
  id: 'notifier-twilio-sms',
  version: '1.0.0',
  capabilities: ['notifier.sms'],
  configSchema,

  meta: {
    name: 'Twilio SMS',
    description: 'Send SMS via Twilio',
    category: 'notification',
    documentationUrl: 'https://www.twilio.com/docs/sms',
  },

  register(registry, config) {
    registry.registerNotifier('sms', {
      async send(notification: Notification): Promise<SendResult> {
        const { accountSid, authToken, fromNumber, timeout } = config;

        const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
        const auth = btoa(`${accountSid}:${authToken}`);

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${auth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              From: fromNumber,
              To: notification.to,
              Body: notification.body,
            }),
            signal: AbortSignal.timeout(timeout),
          });

          const result = await response.json();

          if (!response.ok) {
            return {
              success: false,
              error: result.message || 'Unknown error',
              errorCode: result.code?.toString(),
              retryable: response.status >= 500,
            };
          }

          return {
            success: true,
            messageId: result.sid,
            providerResponse: result,
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            retryable: true,
          };
        }
      },

      supports(options) {
        // Only support SMS channel
        return options.channel === 'sms';
      },
    });
  },

  async healthCheck(ctx, config) {
    // Verify Twilio credentials
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config?.accountSid}.json`;

    try {
      const response = await fetch(url, {
        headers: {
          'Authorization': `Basic ${btoa(`${config?.accountSid}:${config?.authToken}`)}`,
        },
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        return { status: 'healthy', timestamp: Date.now() };
      }

      return {
        status: 'unhealthy',
        message: `Twilio API returned ${response.status}`,
        timestamp: Date.now(),
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        message: error instanceof Error ? error.message : 'Connection failed',
        timestamp: Date.now(),
      };
    }
  },
};
```

---

## 4. Identity Provider Plugins

### 4.1 IdPHandler Interface

```typescript
interface IdPHandler {
  /**
   * Generate authorization URL for OAuth flow
   */
  getAuthorizationUrl(params: IdPAuthParams): Promise<string>;

  /**
   * Exchange authorization code for tokens
   */
  exchangeCode(params: IdPExchangeParams): Promise<IdPTokenResult>;

  /**
   * Fetch user information using access token
   */
  getUserInfo(accessToken: string): Promise<IdPUserInfo>;

  /**
   * Validate and decode ID token (optional)
   */
  validateIdToken?(idToken: string): Promise<IdPClaims>;
}
```

### 4.2 IdP Parameter Types

```typescript
interface IdPAuthParams {
  redirectUri: string;
  state: string;
  nonce?: string;
  scopes?: string[];
  extraParams?: Record<string, string>;
}

interface IdPExchangeParams {
  code: string;
  redirectUri: string;
  codeVerifier?: string;  // For PKCE
}

interface IdPTokenResult {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn?: number;
  tokenType: string;
  scope?: string;
}

interface IdPUserInfo {
  sub: string;            // Subject identifier
  email?: string;
  emailVerified?: boolean;
  name?: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
  locale?: string;
  [key: string]: unknown; // Additional claims
}
```

### 4.3 Example: GitHub OAuth Plugin

```typescript
import { z } from 'zod';
import type { AuthrimPlugin, IdPAuthParams, IdPExchangeParams } from '@authrim/ar-lib-plugin';

const configSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scopes: z.array(z.string()).default(['read:user', 'user:email']),
});

type GitHubConfig = z.infer<typeof configSchema>;

export const githubIdpPlugin: AuthrimPlugin<GitHubConfig> = {
  id: 'idp-github',
  version: '1.0.0',
  capabilities: ['idp.github'],
  configSchema,

  meta: {
    name: 'GitHub',
    description: 'Sign in with GitHub',
    category: 'identity',
    icon: 'github',
  },

  register(registry, config) {
    registry.registerIdP('github', {
      async getAuthorizationUrl(params: IdPAuthParams): Promise<string> {
        const url = new URL('https://github.com/login/oauth/authorize');
        url.searchParams.set('client_id', config.clientId);
        url.searchParams.set('redirect_uri', params.redirectUri);
        url.searchParams.set('state', params.state);
        url.searchParams.set('scope', (params.scopes ?? config.scopes).join(' '));

        if (params.extraParams) {
          for (const [key, value] of Object.entries(params.extraParams)) {
            url.searchParams.set(key, value);
          }
        }

        return url.toString();
      },

      async exchangeCode(params: IdPExchangeParams) {
        const response = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code: params.code,
            redirect_uri: params.redirectUri,
          }),
        });

        const result = await response.json();

        if (result.error) {
          throw new Error(`GitHub OAuth error: ${result.error_description || result.error}`);
        }

        return {
          accessToken: result.access_token,
          tokenType: result.token_type || 'bearer',
          scope: result.scope,
        };
      },

      async getUserInfo(accessToken: string) {
        // Fetch user profile
        const userResponse = await fetch('https://api.github.com/user', {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/vnd.github.v3+json',
          },
        });

        if (!userResponse.ok) {
          throw new Error(`GitHub API error: ${userResponse.status}`);
        }

        const user = await userResponse.json();

        // Fetch emails (may require additional scope)
        let email: string | undefined;
        let emailVerified = false;

        try {
          const emailResponse = await fetch('https://api.github.com/user/emails', {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Accept': 'application/vnd.github.v3+json',
            },
          });

          if (emailResponse.ok) {
            const emails = await emailResponse.json();
            const primary = emails.find((e: any) => e.primary);
            if (primary) {
              email = primary.email;
              emailVerified = primary.verified;
            }
          }
        } catch {
          // Email fetch failed, continue without it
        }

        return {
          sub: user.id.toString(),
          email,
          emailVerified,
          name: user.name || user.login,
          picture: user.avatar_url,
          preferredUsername: user.login,
        };
      },
    });
  },
};
```

---

## 5. Authenticator Plugins

### 5.1 AuthenticatorHandler Interface

```typescript
interface AuthenticatorHandler {
  /**
   * Create an authentication challenge
   */
  createChallenge(params: AuthChallengeParams): Promise<AuthChallengeResult>;

  /**
   * Verify the authentication response
   */
  verifyResponse(params: AuthVerifyParams): Promise<AuthVerifyResult>;

  /**
   * Check if this authenticator supports given options (optional)
   */
  supports?(options: AuthOptions): boolean;
}
```

### 5.2 Authenticator Parameter Types

```typescript
interface AuthChallengeParams {
  userId: string;
  sessionId: string;
  metadata?: Record<string, unknown>;
}

interface AuthChallengeResult {
  challengeId: string;
  challenge: unknown;       // Authenticator-specific challenge data
  expiresAt: number;        // Unix timestamp
  metadata?: Record<string, unknown>;
}

interface AuthVerifyParams {
  challengeId: string;
  response: unknown;        // User's response to challenge
  userId: string;
  sessionId: string;
}

interface AuthVerifyResult {
  success: boolean;
  userId?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}
```

### 5.3 Example: TOTP Authenticator Plugin

```typescript
import { z } from 'zod';
import type { AuthrimPlugin, AuthChallengeParams, AuthVerifyParams } from '@authrim/ar-lib-plugin';

const configSchema = z.object({
  issuer: z.string().default('Authrim'),
  period: z.number().int().default(30),
  digits: z.number().int().min(6).max(8).default(6),
  algorithm: z.enum(['SHA1', 'SHA256', 'SHA512']).default('SHA1'),
  window: z.number().int().default(1),  // Accept codes within this window
});

type TOTPConfig = z.infer<typeof configSchema>;

export const totpAuthenticatorPlugin: AuthrimPlugin<TOTPConfig> = {
  id: 'authenticator-totp',
  version: '1.0.0',
  capabilities: ['authenticator.totp'],
  configSchema,

  meta: {
    name: 'TOTP Authenticator',
    description: 'Time-based One-Time Password (RFC 6238)',
    category: 'authentication',
  },

  register(registry, config) {
    registry.registerAuthenticator('totp', {
      async createChallenge(params: AuthChallengeParams) {
        // For TOTP, the challenge is simply requesting the current code
        // The actual secret is stored with the user's credential
        const challengeId = crypto.randomUUID();

        return {
          challengeId,
          challenge: {
            type: 'totp',
            digits: config.digits,
            period: config.period,
            message: `Enter your ${config.digits}-digit authenticator code`,
          },
          expiresAt: Date.now() + (config.period * 2 * 1000),  // 2 periods
        };
      },

      async verifyResponse(params: AuthVerifyParams) {
        const { response, userId } = params;

        // Type guard for response
        if (typeof response !== 'object' || response === null) {
          return { success: false, error: 'Invalid response format' };
        }

        const { code, secret } = response as { code?: string; secret?: string };

        if (!code || !secret) {
          return { success: false, error: 'Missing code or secret' };
        }

        // Verify TOTP code (simplified - use a proper library in production)
        const isValid = verifyTOTP(secret, code, {
          period: config.period,
          digits: config.digits,
          algorithm: config.algorithm,
          window: config.window,
        });

        if (isValid) {
          return {
            success: true,
            userId,
            metadata: {
              verifiedAt: Date.now(),
              method: 'totp',
            },
          };
        }

        return {
          success: false,
          error: 'Invalid or expired code',
        };
      },

      supports(options) {
        return options.type === 'totp' || options.type === 'otp';
      },
    });
  },
};

// Helper function (use a proper TOTP library in production)
function verifyTOTP(
  secret: string,
  code: string,
  options: { period: number; digits: number; algorithm: string; window: number }
): boolean {
  // Implementation would use crypto.subtle.sign() for HMAC
  // This is a placeholder - use a library like 'otpauth' or 'speakeasy'
  return code.length === options.digits;
}
```

---

## 6. Configuration Schema

### 6.1 Zod Schema Best Practices

```typescript
import { z } from 'zod';

const configSchema = z.object({
  // Required fields - no default
  apiKey: z.string().min(1, 'API key is required'),

  // Optional with default
  timeout: z.number().int().positive().default(10000),

  // String with validation
  endpoint: z.string().url('Must be a valid URL'),

  // Enum with default
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Array with constraints
  allowedDomains: z.array(z.string()).min(1).max(100).default([]),

  // Nested object
  retry: z.object({
    maxAttempts: z.number().int().min(0).max(10).default(3),
    backoffMs: z.number().int().positive().default(1000),
  }).default({}),

  // Union type
  auth: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('apiKey'),
      key: z.string(),
    }),
    z.object({
      type: z.literal('oauth'),
      clientId: z.string(),
      clientSecret: z.string(),
    }),
  ]),

  // Sensitive field (will be masked in logs)
  secretKey: z.string().min(1).describe('Sensitive: API secret key'),
});
```

### 6.2 JSON Schema Generation

The plugin system automatically converts Zod schemas to JSON Schema for Admin UI:

```typescript
import { zodToJSONSchema, extractPluginSchema } from '@authrim/ar-lib-plugin';

// Extract full schema info
const schemaInfo = extractPluginSchema(myPlugin);
console.log(schemaInfo);
// {
//   pluginId: 'my-plugin',
//   version: '1.0.0',
//   configSchema: { type: 'object', properties: {...} },
//   meta: { name: '...', ... }
// }

// Or convert just the schema
const jsonSchema = zodToJSONSchema(configSchema);
```

### 6.3 Form Field Hints

Add descriptions for better UI:

```typescript
const configSchema = z.object({
  apiKey: z.string()
    .min(1)
    .describe('Your API key from the provider dashboard'),

  webhookUrl: z.string()
    .url()
    .describe('URL to receive webhook callbacks'),

  enableDebug: z.boolean()
    .default(false)
    .describe('Enable verbose logging for troubleshooting'),
});
```

---

## 7. Testing Plugins

### 7.1 Unit Testing

```typescript
import { describe, it, expect, vi } from 'vitest';
import { CapabilityRegistry } from '@authrim/ar-lib-plugin';
import { myPlugin } from './my-plugin';

describe('MyPlugin', () => {
  it('should register notifier capability', () => {
    const registry = new CapabilityRegistry();
    const config = { apiKey: 'test-key', endpoint: 'https://api.example.com' };

    myPlugin.register(registry, config);

    expect(registry.getNotifier('custom')).toBeDefined();
    expect(registry.listCapabilities()).toContain('notifier.custom');
  });

  it('should send notification successfully', async () => {
    const registry = new CapabilityRegistry();
    const config = { apiKey: 'test-key', endpoint: 'https://api.example.com' };

    // Mock fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'msg-123' }),
    });

    myPlugin.register(registry, config);
    const notifier = registry.getNotifier('custom')!;

    const result = await notifier.send({
      channel: 'custom',
      to: 'user@example.com',
      body: 'Test message',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg-123');
  });

  it('should handle API errors gracefully', async () => {
    const registry = new CapabilityRegistry();
    const config = { apiKey: 'test-key', endpoint: 'https://api.example.com' };

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    myPlugin.register(registry, config);
    const notifier = registry.getNotifier('custom')!;

    const result = await notifier.send({
      channel: 'custom',
      to: 'user@example.com',
      body: 'Test message',
    });

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
  });
});
```

### 7.2 Integration Testing

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPluginContext, createPluginLoader, CapabilityRegistry } from '@authrim/ar-lib-plugin';
import { myPlugin } from './my-plugin';

describe('MyPlugin Integration', () => {
  let ctx: PluginContext;
  let loader: PluginLoader;
  let registry: CapabilityRegistry;

  beforeAll(async () => {
    // Use mock env for testing
    const mockEnv = {
      DB: createMockD1(),
      AUTHRIM_CONFIG: createMockKV(),
    };

    ctx = await createPluginContext(mockEnv, { tenantId: 'test' });
    registry = new CapabilityRegistry();
    loader = createPluginLoader(registry);
  });

  it('should initialize and register successfully', async () => {
    const config = {
      apiKey: process.env.TEST_API_KEY!,
      endpoint: 'https://api.example.com',
    };

    const result = await loader.loadPlugin(myPlugin, ctx, config);

    expect(result.success).toBe(true);
    expect(loader.getStatus(myPlugin.id)?.status).toBe('active');
  });

  it('should pass health check', async () => {
    const health = await myPlugin.healthCheck?.(ctx);

    expect(health?.status).toBe('healthy');
  });
});
```

### 7.3 Mocking PluginContext

```typescript
import { vi } from 'vitest';
import type { PluginContext } from '@authrim/ar-lib-plugin';

function createMockContext(): PluginContext {
  return {
    storage: {
      provider: 'cloudflare',
      user: {
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      // ... other stores
    } as any,

    policy: {
      provider: 'builtin',
      check: vi.fn().mockResolvedValue({ allowed: true }),
    } as any,

    config: {
      get: vi.fn(),
      getForTenant: vi.fn(),
      set: vi.fn(),
    },

    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },

    audit: {
      log: vi.fn(),
    },

    tenantId: 'test-tenant',
    env: {} as any,
  };
}
```

---

## 8. Best Practices

### 8.1 Error Handling

```typescript
// DO: Return structured errors
async send(notification: Notification): Promise<SendResult> {
  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      const error = await response.text();
      return {
        success: false,
        error: `API error: ${response.status}`,
        errorCode: response.status.toString(),
        retryable: response.status >= 500,
        providerResponse: error,
      };
    }

    return { success: true, messageId: '...' };
  } catch (error) {
    // Distinguish between retryable and non-retryable errors
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';
    const isNetwork = error instanceof TypeError;

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      retryable: isTimeout || isNetwork,
    };
  }
}

// DON'T: Throw unhandled exceptions
async send(notification: Notification): Promise<SendResult> {
  const response = await fetch(url, options);  // Will throw on network error!
  const result = await response.json();
  return { success: true, messageId: result.id };
}
```

### 8.2 Timeout Management

```typescript
// Always use timeouts for external calls
const response = await fetch(url, {
  signal: AbortSignal.timeout(config.timeout),  // Built-in timeout
});

// For custom timeout handling
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), config.timeout);

try {
  const response = await fetch(url, { signal: controller.signal });
  // ...
} finally {
  clearTimeout(timeoutId);
}
```

### 8.3 Logging

```typescript
register(registry, config) {
  const { logger } = this;  // Access via closure or passed context

  registry.registerNotifier('email', {
    async send(notification) {
      // Log operation start
      logger.info('Sending notification', {
        channel: notification.channel,
        to: notification.to,  // Be careful with PII
      });

      try {
        // ... send logic

        logger.info('Notification sent', {
          messageId: result.id,
          channel: notification.channel,
        });

        return { success: true, messageId: result.id };
      } catch (error) {
        // Log errors with context
        logger.error('Notification failed', {
          channel: notification.channel,
          error: error instanceof Error ? error.message : 'Unknown',
        });

        return { success: false, error: '...' };
      }
    },
  });
}
```

### 8.4 Security

```typescript
// 1. Never log sensitive data
logger.info('Request', {
  apiKey: config.apiKey,  // DON'T DO THIS
});

logger.info('Request', {
  apiKeyPrefix: config.apiKey.slice(0, 8) + '...',  // Better
});

// 2. Validate URLs to prevent SSRF
function validateUrl(url: string): boolean {
  const parsed = new URL(url);
  const forbidden = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
  return !forbidden.includes(parsed.hostname);
}

// 3. Set appropriate timeouts
const SECURITY_DEFAULTS = {
  timeout: 10000,          // 10 seconds max
  maxRetries: 3,           // Limit retries
  maxPayload: 1024 * 1024, // 1MB max
};

// 4. Sanitize user input in templates
function sanitizeForEmail(input: string): string {
  return input.replace(/[<>]/g, '');  // Basic XSS prevention
}
```

### 8.5 Resource Cleanup

```typescript
export const myPlugin: AuthrimPlugin<Config> = {
  // ...

  async initialize(ctx, config) {
    // Open connection
    this.client = new SomeClient(config);
    await this.client.connect();
  },

  async shutdown() {
    // Always clean up
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
  },
};
```

---

## 9. Troubleshooting

### 9.1 Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "Capability already registered" | Duplicate registration | Ensure plugin is loaded only once |
| "KV namespace not available" | Missing env binding | Check wrangler.toml bindings |
| "Config validation failed" | Invalid config | Check Zod schema and config values |
| "Initialize timeout" | Slow external service | Increase timeout or check connectivity |
| "Health check failed" | Service unavailable | Verify credentials and endpoint |

### 9.2 Debugging

```typescript
// Enable debug logging
const ctx = await createPluginContext(env, {
  tenantId: 'default',
  logger: new ConsoleLogger('[DEBUG]'),  // Custom prefix
});

// Check plugin status
const status = loader.getStatus('my-plugin');
console.log('Plugin status:', status);
// { pluginId: 'my-plugin', status: 'active', loadedAt: 1234567890 }

// List all capabilities
console.log('Capabilities:', globalRegistry.listCapabilities());
// ['notifier.email', 'notifier.sms', 'idp.github']
```

### 9.3 Health Checks

```typescript
// Check all plugin health
const healthMap = await loader.healthCheck();
for (const [pluginId, health] of healthMap) {
  if (health.status !== 'healthy') {
    console.warn(`Plugin ${pluginId} unhealthy:`, health.message);
  }
}
```

---

## 10. Examples

### 10.1 Built-in Plugins

The `@authrim/ar-lib-plugin` package includes these built-in plugins:

#### Console Notifier (Development)

```typescript
import { consoleNotifierPlugin } from '@authrim/ar-lib-plugin';

// Logs notifications to console
// Useful for development and testing
```

**Configuration:**
```typescript
{
  prefix: '[AUTHRIM]',      // Log prefix
  includeTimestamp: true,   // Include timestamp in logs
}
```

#### Resend Email Notifier

```typescript
import { resendEmailPlugin } from '@authrim/ar-lib-plugin';

// Send emails via Resend API
```

**Configuration:**
```typescript
{
  apiKey: 're_xxxxxxxx',           // Required: Resend API key
  defaultFrom: 'noreply@example.com', // Required: Default sender
  replyTo: 'support@example.com',  // Optional: Reply-to address
  maxRecipientsPerRequest: 10,     // Optional: Batch size limit
  timeoutMs: 10000,                // Optional: Request timeout
}
```

### 10.2 Community Plugin Template

Use this template to create your own plugin:

```typescript
import { z } from 'zod';
import type {
  AuthrimPlugin,
  PluginContext,
  CapabilityRegistry,
  HealthStatus,
} from '@authrim/ar-lib-plugin';

// 1. Define your configuration schema
const configSchema = z.object({
  // Add your configuration fields here
});

type Config = z.infer<typeof configSchema>;

// 2. Export your plugin
export const myPlugin: AuthrimPlugin<Config> = {
  id: 'my-plugin-id',
  version: '1.0.0',
  capabilities: ['notifier.custom'],  // Adjust as needed
  configSchema,

  meta: {
    name: 'My Plugin',
    description: 'Description of what your plugin does',
    category: 'notification',  // or 'identity', 'authentication', 'flow'
  },

  async initialize(ctx: PluginContext, config: Config): Promise<void> {
    // Initialize external connections
  },

  register(registry: CapabilityRegistry, config: Config): void {
    // Register your handlers
  },

  async healthCheck(): Promise<HealthStatus> {
    return { status: 'healthy', timestamp: Date.now() };
  },

  async shutdown(): Promise<void> {
    // Cleanup resources
  },
};
```

---

## Appendix A: Type Definitions Quick Reference

```typescript
// Plugin types
type AuthrimPlugin<T>
type PluginCapability
type PluginCategory
type PluginMeta
type HealthStatus

// Handler types
type NotifierHandler
type IdPHandler
type AuthenticatorHandler

// Notification types
type Notification
type SendResult
type NotificationOptions

// IdP types
type IdPAuthParams
type IdPExchangeParams
type IdPTokenResult
type IdPUserInfo
type IdPClaims

// Authenticator types
type AuthChallengeParams
type AuthChallengeResult
type AuthVerifyParams
type AuthVerifyResult

// Infrastructure types
type IStorageInfra
type IPolicyInfra
type PluginContext
type PluginConfigStore

// Schema types
type JSONSchema7
type ValidationResult
type FormFieldHint
```

---

## Appendix B: Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2024-12-24 | Initial release |

---

## Getting Help

- **Documentation**: [Authrim Docs](https://docs.authrim.com)
- **GitHub Issues**: [Report bugs](https://github.com/authrim/authrim/issues)
- **Discussions**: [Community forum](https://github.com/authrim/authrim/discussions)
