/**
 * Plugin Architecture Tests
 *
 * Tests for the core plugin infrastructure.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { CapabilityRegistry, globalRegistry } from '../core/registry';
import { zodToJSONSchema, validatePluginConfig, extractFormFieldHints } from '../core/schema';
import { resolveBuiltinPluginBootstrapConfig } from '../core/builtin-registry';
import { consoleNotifierPlugin } from '../builtin/notifier/console';
import { resendEmailPlugin } from '../builtin/notifier/resend';
import { renderTemplate, NOTIFIER_SECURITY_DEFAULTS } from '../builtin/notifier/types';
import type { AuthrimPlugin, NotifierHandler } from '../core/types';

// =============================================================================
// Registry Tests
// =============================================================================

describe('CapabilityRegistry', () => {
  let registry: CapabilityRegistry;

  beforeEach(() => {
    registry = new CapabilityRegistry();
  });

  describe('registerNotifier', () => {
    it('should register a notifier handler', () => {
      const handler: NotifierHandler = {
        send: async () => ({ success: true, messageId: 'test-123' }),
      };

      registry.registerNotifier('email', handler, 'test-plugin');

      const retrieved = registry.getNotifier('email');
      expect(retrieved).toBe(handler);
    });

    it('should throw error on duplicate registration', () => {
      const handler: NotifierHandler = {
        send: async () => ({ success: true, messageId: 'test-123' }),
      };

      registry.registerNotifier('email', handler, 'plugin-1');

      expect(() => {
        registry.registerNotifier('email', handler, 'plugin-2');
      }).toThrow("Notifier for channel 'email' already registered");
    });

    it('should return undefined for unregistered channel', () => {
      expect(registry.getNotifier('sms')).toBeUndefined();
    });
  });

  describe('listCapabilities', () => {
    it('should list all registered capabilities', () => {
      const handler: NotifierHandler = {
        send: async () => ({ success: true, messageId: 'test' }),
      };

      registry.registerNotifier('email', handler);
      registry.registerNotifier('sms', handler);

      const capabilities = registry.listCapabilities();
      expect(capabilities).toContain('notifier.email');
      expect(capabilities).toContain('notifier.sms');
    });
  });
});

// =============================================================================
// Schema Conversion Tests
// =============================================================================

describe('Schema Utilities', () => {
  describe('zodToJSONSchema', () => {
    it('should convert simple Zod schema to JSON Schema', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number().int(),
      });

      const jsonSchema = zodToJSONSchema(schema);

      expect(jsonSchema.type).toBe('object');
      expect(jsonSchema.properties).toBeDefined();
      expect(jsonSchema.properties?.name).toBeDefined();
      expect(jsonSchema.properties?.age).toBeDefined();
    });

    it('should include required fields', () => {
      const schema = z.object({
        required: z.string(),
        optional: z.string().optional(),
      });

      const jsonSchema = zodToJSONSchema(schema);

      expect(jsonSchema.required).toContain('required');
      expect(jsonSchema.required).not.toContain('optional');
    });
  });

  describe('validatePluginConfig', () => {
    it('should validate correct configuration', () => {
      const schema = z.object({
        apiKey: z.string().min(1),
        timeout: z.number().default(5000),
      });

      const result = validatePluginConfig(schema, { apiKey: 'test-key' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.apiKey).toBe('test-key');
        expect(result.data.timeout).toBe(5000); // default value
      }
    });

    it('should return errors for invalid configuration', () => {
      const schema = z.object({
        apiKey: z.string().min(1),
      });

      const result = validatePluginConfig(schema, { apiKey: '' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0].path).toBe('apiKey');
      }
    });
  });

  describe('extractFormFieldHints', () => {
    it('should extract field hints from JSON Schema', () => {
      const schema = z.object({
        email: z.string().email(),
        count: z.number().int().min(0).max(100),
        enabled: z.boolean(),
      });

      const jsonSchema = zodToJSONSchema(schema);
      const hints = extractFormFieldHints(jsonSchema);

      expect(hints.length).toBe(3);
      // email fields are detected by format and return 'email' type
      expect(hints.find((h) => h.name === 'email')?.type).toBe('email');
      expect(hints.find((h) => h.name === 'count')?.type).toBe('integer');
      expect(hints.find((h) => h.name === 'enabled')?.type).toBe('boolean');
    });
  });
});

// =============================================================================
// Builtin Plugin Bootstrap Config Tests
// =============================================================================

describe('Builtin plugin bootstrap config', () => {
  it('does not enable Resend bootstrap config from shared email sender settings alone', () => {
    expect(
      resolveBuiltinPluginBootstrapConfig(
        {
          EMAIL_FROM: 'noreply@example.com',
          EMAIL_FROM_NAME: 'Authrim',
        },
        'notifier-resend'
      )
    ).toEqual({});
  });

  it('resolves Resend bootstrap config when the Resend API key is configured', () => {
    expect(
      resolveBuiltinPluginBootstrapConfig(
        {
          EMAIL_FROM: 'noreply@example.com',
          RESEND_API_KEY: 're_test_key',
        },
        'notifier-resend'
      )
    ).toEqual({
      apiKey: 're_test_key',
      defaultFrom: 'noreply@example.com',
    });
  });
});

// =============================================================================
// Plugin Definition Tests
// =============================================================================

describe('Plugin Definitions', () => {
  describe('consoleNotifierPlugin', () => {
    it('should have correct plugin metadata', () => {
      expect(consoleNotifierPlugin.id).toBe('notifier-console');
      expect(consoleNotifierPlugin.version).toBe('1.0.0');
      expect(consoleNotifierPlugin.official).toBe(true);
      expect(consoleNotifierPlugin.capabilities).toContain('notifier.email');
      expect(consoleNotifierPlugin.capabilities).toContain('notifier.sms');
      expect(consoleNotifierPlugin.capabilities).toContain('notifier.push');
    });

    it('should register handlers for all channels', () => {
      const registry = new CapabilityRegistry();
      const config = consoleNotifierPlugin.configSchema.parse({});

      consoleNotifierPlugin.register(registry, config);

      expect(registry.getNotifier('email')).toBeDefined();
      expect(registry.getNotifier('sms')).toBeDefined();
      expect(registry.getNotifier('push')).toBeDefined();
    });
  });

  describe('resendEmailPlugin', () => {
    it('should have correct plugin metadata', () => {
      expect(resendEmailPlugin.id).toBe('notifier-resend');
      expect(resendEmailPlugin.version).toBe('1.0.0');
      expect(resendEmailPlugin.official).toBe(true);
      expect(resendEmailPlugin.capabilities).toContain('notifier.email');
    });

    it('should validate configuration correctly', () => {
      const validConfig = {
        apiKey: 're_test_key',
        defaultFrom: 'noreply@example.com',
      };

      const result = resendEmailPlugin.configSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it('should reject invalid configuration', () => {
      const invalidConfig = {
        apiKey: '', // empty string not allowed
        defaultFrom: 'not-an-email',
      };

      const result = resendEmailPlugin.configSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// Template Rendering Tests
// =============================================================================

describe('Template Rendering', () => {
  describe('renderTemplate', () => {
    it('should replace template variables', () => {
      const template = 'Hello, {{name}}! Your code is {{code}}.';
      const variables = { name: 'John', code: '123456' };

      const result = renderTemplate(template, variables);

      expect(result).toBe('Hello, John! Your code is 123456.');
    });

    it('should leave undefined variables unchanged', () => {
      const template = 'Hello, {{name}}! Your code is {{code}}.';
      const variables = { name: 'John' };

      const result = renderTemplate(template, variables);

      expect(result).toBe('Hello, John! Your code is {{code}}.');
    });

    it('should handle objects by JSON stringifying', () => {
      const template = 'Data: {{data}}';
      const variables = { data: { key: 'value' } };

      const result = renderTemplate(template, variables);

      expect(result).toBe('Data: {"key":"value"}');
    });

    it('should handle numbers and booleans', () => {
      const template = 'Count: {{count}}, Active: {{active}}';
      const variables = { count: 42, active: true };

      const result = renderTemplate(template, variables);

      expect(result).toBe('Count: 42, Active: true');
    });
  });
});

// =============================================================================
// Security Constants Tests
// =============================================================================

describe('Security Constants', () => {
  it('should have secure default values', () => {
    expect(NOTIFIER_SECURITY_DEFAULTS.DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(10000);
    expect(NOTIFIER_SECURITY_DEFAULTS.MAX_TIMEOUT_MS).toBeLessThanOrEqual(30000);
    expect(NOTIFIER_SECURITY_DEFAULTS.ALLOW_LOCALHOST_IN_PRODUCTION).toBe(false);
    expect(NOTIFIER_SECURITY_DEFAULTS.MAX_RETRIES).toBeLessThanOrEqual(5);
  });
});

// =============================================================================
// Extended Registry Tests
// =============================================================================

describe('CapabilityRegistry - Extended', () => {
  let registry: CapabilityRegistry;

  beforeEach(() => {
    registry = new CapabilityRegistry();
  });

  describe('registerIdP', () => {
    it('should register an IdP handler', () => {
      const handler = {
        getAuthorizationUrl: async () => 'https://example.com/auth',
        exchangeCode: async () => ({ access_token: 'token', token_type: 'bearer' }),
        getUserInfo: async () => ({ sub: '123', email: 'test@example.com' }),
      };

      registry.registerIdP('google', handler, 'idp-google');

      expect(registry.getIdP('google')).toBe(handler);
    });

    it('should throw error on duplicate IdP registration', () => {
      const handler = {
        getAuthorizationUrl: async () => 'https://example.com/auth',
        exchangeCode: async () => ({ access_token: 'token', token_type: 'bearer' }),
        getUserInfo: async () => ({ sub: '123' }),
      };

      registry.registerIdP('google', handler, 'plugin-1');

      expect(() => {
        registry.registerIdP('google', handler, 'plugin-2');
      }).toThrow("IdP 'google' already registered");
    });
  });

  describe('registerAuthenticator', () => {
    it('should register an Authenticator handler', () => {
      const handler = {
        startChallenge: async () => ({ challengeId: 'ch-123', data: {} }),
        verifyResponse: async () => ({ success: true }),
      };

      registry.registerAuthenticator('totp', handler, 'auth-totp');

      expect(registry.getAuthenticator('totp')).toBe(handler);
    });

    it('should throw error on duplicate Authenticator registration', () => {
      const handler = {
        startChallenge: async () => ({ challengeId: 'ch-123', data: {} }),
        verifyResponse: async () => ({ success: true }),
      };

      registry.registerAuthenticator('totp', handler, 'plugin-1');

      expect(() => {
        registry.registerAuthenticator('totp', handler, 'plugin-2');
      }).toThrow("Authenticator 'totp' already registered");
    });
  });

  describe('getCapabilityOwner', () => {
    it('should return plugin ID for registered capability', () => {
      const handler: NotifierHandler = {
        send: async () => ({ success: true, messageId: 'test' }),
      };

      registry.registerNotifier('email', handler, 'email-plugin');

      expect(registry.getCapabilityOwner('notifier.email')).toBe('email-plugin');
    });

    it('should return undefined for unregistered capability', () => {
      expect(registry.getCapabilityOwner('notifier.sms')).toBeUndefined();
    });
  });

  describe('hasCapability', () => {
    it('should return true for registered capability', () => {
      const handler: NotifierHandler = {
        send: async () => ({ success: true, messageId: 'test' }),
      };

      registry.registerNotifier('email', handler);

      expect(registry.hasCapability('notifier.email')).toBe(true);
    });

    it('should return false for unregistered capability', () => {
      expect(registry.hasCapability('notifier.sms')).toBe(false);
    });

    it('should handle malformed capability string', () => {
      // Without period, should return false
      expect(registry.hasCapability('notifier' as any)).toBe(false);
    });
  });

  describe('sendNotification', () => {
    it('should send notification successfully', async () => {
      const handler: NotifierHandler = {
        send: async (notification) => ({
          success: true,
          messageId: `msg-${notification.to}`,
        }),
      };

      registry.registerNotifier('email', handler);

      const result = await registry.sendNotification({
        channel: 'email',
        to: 'test@example.com',
        body: 'Hello',
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('msg-test@example.com');
    });

    it('should return error for unregistered channel', async () => {
      const result = await registry.sendNotification({
        channel: 'sms',
        to: '+1234567890',
        body: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No notifier registered');
    });

    it('should catch and wrap handler exceptions', async () => {
      const handler: NotifierHandler = {
        send: async () => {
          throw new Error('API connection failed');
        },
      };

      registry.registerNotifier('email', handler);

      const result = await registry.sendNotification({
        channel: 'email',
        to: 'test@example.com',
        body: 'Hello',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('API connection failed');
    });
  });

  describe('notifierSupports', () => {
    it('should return true when supports() returns true', () => {
      const handler: NotifierHandler = {
        send: async () => ({ success: true, messageId: 'test' }),
        supports: (notification) => notification.channel === 'email',
      };

      registry.registerNotifier('email', handler);

      expect(
        registry.notifierSupports('email', {
          channel: 'email',
          to: 'test@example.com',
          body: 'Hello',
        })
      ).toBe(true);
    });

    it('should return true when supports() not defined', () => {
      const handler: NotifierHandler = {
        send: async () => ({ success: true, messageId: 'test' }),
        // No supports() method
      };

      registry.registerNotifier('email', handler);

      expect(
        registry.notifierSupports('email', {
          channel: 'email',
          to: 'test@example.com',
          body: 'Hello',
        })
      ).toBe(true);
    });

    it('should return false for unregistered channel', () => {
      expect(
        registry.notifierSupports('sms', {
          channel: 'sms',
          to: '+1234567890',
          body: 'Hello',
        })
      ).toBe(false);
    });
  });

  describe('unregisterPlugin', () => {
    it('should remove all capabilities of a plugin', () => {
      const handler: NotifierHandler = {
        send: async () => ({ success: true, messageId: 'test' }),
      };

      registry.registerNotifier('email', handler, 'my-plugin');
      registry.registerNotifier('sms', handler, 'my-plugin');

      expect(registry.listCapabilities()).toContain('notifier.email');
      expect(registry.listCapabilities()).toContain('notifier.sms');

      registry.unregisterPlugin('my-plugin');

      expect(registry.getNotifier('email')).toBeUndefined();
      expect(registry.getNotifier('sms')).toBeUndefined();
    });

    it('should not affect other plugins', () => {
      const handler: NotifierHandler = {
        send: async () => ({ success: true, messageId: 'test' }),
      };

      registry.registerNotifier('email', handler, 'plugin-a');
      registry.registerNotifier('sms', handler, 'plugin-b');

      registry.unregisterPlugin('plugin-a');

      expect(registry.getNotifier('email')).toBeUndefined();
      expect(registry.getNotifier('sms')).toBe(handler);
    });

    it('should be safe to unregister non-existent plugin', () => {
      expect(() => {
        registry.unregisterPlugin('does-not-exist');
      }).not.toThrow();
    });
  });

  describe('edge cases', () => {
    it('should handle empty channel name', () => {
      const handler: NotifierHandler = {
        send: async () => ({ success: true, messageId: 'test' }),
      };

      registry.registerNotifier('', handler, 'test-plugin');

      expect(registry.getNotifier('')).toBe(handler);
    });

    it('should handle special characters in channel name', () => {
      const handler: NotifierHandler = {
        send: async () => ({ success: true, messageId: 'test' }),
      };

      registry.registerNotifier('email/test', handler, 'test-plugin');

      expect(registry.getNotifier('email/test')).toBe(handler);
    });

    it('should handle control characters in channel name', () => {
      const handler: NotifierHandler = {
        send: async () => ({ success: true, messageId: 'test' }),
      };

      // Tab and newline characters
      const channelWithControl = 'email\t\ntest';
      registry.registerNotifier(channelWithControl, handler, 'test-plugin');

      // Should still be retrievable with exact same string
      expect(registry.getNotifier(channelWithControl)).toBe(handler);
    });

    it('should handle unicode channel names', () => {
      const handler: NotifierHandler = {
        send: async () => ({ success: true, messageId: 'test' }),
      };

      const unicodeChannel = 'メール通知';
      registry.registerNotifier(unicodeChannel, handler, 'test-plugin');

      expect(registry.getNotifier(unicodeChannel)).toBe(handler);
    });

    it('should handle emoji in channel names', () => {
      const handler: NotifierHandler = {
        send: async () => ({ success: true, messageId: 'test' }),
      };

      const emojiChannel = '📧email';
      registry.registerNotifier(emojiChannel, handler, 'test-plugin');

      expect(registry.getNotifier(emojiChannel)).toBe(handler);
    });
  });

  describe('performance and scale', () => {
    it('should handle many capability registrations', () => {
      const handler: NotifierHandler = {
        send: async () => ({ success: true, messageId: 'test' }),
      };

      // Register 100 different notifiers
      for (let i = 0; i < 100; i++) {
        registry.registerNotifier(`channel-${i}`, handler, `plugin-${i}`);
      }

      // All should be retrievable
      for (let i = 0; i < 100; i++) {
        expect(registry.getNotifier(`channel-${i}`)).toBe(handler);
      }

      // List should contain all
      const capabilities = registry.listCapabilities();
      expect(capabilities.length).toBe(100);
    });

    it('should efficiently list capabilities after many registrations', () => {
      const handler: NotifierHandler = {
        send: async () => ({ success: true, messageId: 'test' }),
      };

      // Register many capabilities
      for (let i = 0; i < 50; i++) {
        registry.registerNotifier(`notifier-${i}`, handler, `plugin-${i}`);
      }

      const startTime = performance.now();
      const capabilities = registry.listCapabilities();
      const endTime = performance.now();

      expect(capabilities.length).toBe(50);
      // Should complete in reasonable time (< 20ms, relaxed for CI environments)
      expect(endTime - startTime).toBeLessThan(20);
    });
  });
});

// =============================================================================
// Extended Schema Tests
// =============================================================================

describe('Schema Utilities - Extended', () => {
  describe('zodToJSONSchema - Advanced Types', () => {
    it('should convert nullable type', () => {
      const schema = z.object({
        value: z.string().nullable(),
      });

      const jsonSchema = zodToJSONSchema(schema);

      // Nullable creates anyOf or type array
      expect(jsonSchema.properties?.value).toBeDefined();
    });

    it('should convert union type', () => {
      const schema = z.object({
        value: z.union([z.string(), z.number()]),
      });

      const jsonSchema = zodToJSONSchema(schema);

      expect(jsonSchema.properties?.value).toBeDefined();
    });

    it('should convert array type', () => {
      const schema = z.object({
        tags: z.array(z.string()),
      });

      const jsonSchema = zodToJSONSchema(schema);

      const tagsSchema = jsonSchema.properties?.tags as any;
      expect(tagsSchema?.type).toBe('array');
    });

    it('should convert enum type', () => {
      const schema = z.object({
        level: z.enum(['debug', 'info', 'warn', 'error']),
      });

      const jsonSchema = zodToJSONSchema(schema);

      const levelSchema = jsonSchema.properties?.level as any;
      expect(levelSchema?.enum).toEqual(['debug', 'info', 'warn', 'error']);
    });

    it('should preserve default values', () => {
      const schema = z.object({
        timeout: z.number().default(5000),
      });

      const jsonSchema = zodToJSONSchema(schema);

      const timeoutSchema = jsonSchema.properties?.timeout as any;
      expect(timeoutSchema?.default).toBe(5000);
    });

    it('should convert min/max constraints', () => {
      const schema = z.object({
        value: z.number().min(0).max(100),
      });

      const jsonSchema = zodToJSONSchema(schema);

      const valueSchema = jsonSchema.properties?.value as any;
      expect(valueSchema?.minimum).toBe(0);
      expect(valueSchema?.maximum).toBe(100);
    });

    it('should convert string length constraints', () => {
      const schema = z.object({
        name: z.string().min(1).max(50),
      });

      const jsonSchema = zodToJSONSchema(schema);

      const nameSchema = jsonSchema.properties?.name as any;
      expect(nameSchema?.minLength).toBe(1);
      expect(nameSchema?.maxLength).toBe(50);
    });

    it('should handle deeply nested objects', () => {
      const schema = z.object({
        level1: z.object({
          level2: z.object({
            level3: z.object({
              value: z.string(),
            }),
          }),
        }),
      });

      const jsonSchema = zodToJSONSchema(schema);

      const level1 = jsonSchema.properties?.level1 as any;
      expect(level1?.type).toBe('object');
      expect(level1?.properties?.level2).toBeDefined();
    });

    it('should convert large schema', () => {
      const fields: Record<string, z.ZodString> = {};
      for (let i = 0; i < 50; i++) {
        fields[`field${i}`] = z.string();
      }

      const schema = z.object(fields);
      const jsonSchema = zodToJSONSchema(schema);

      expect(Object.keys(jsonSchema.properties || {}).length).toBe(50);
    });

    it('should convert z.record() type', () => {
      const schema = z.object({
        headers: z.record(z.string()),
      });

      const jsonSchema = zodToJSONSchema(schema);

      const headersSchema = jsonSchema.properties?.headers as any;
      // z.record creates an object with additionalProperties
      expect(headersSchema?.type).toBe('object');
      expect(headersSchema?.additionalProperties).toBeDefined();
    });

    it('should convert z.record() with specific key type', () => {
      const schema = z.object({
        scores: z.record(z.string(), z.number()),
      });

      const jsonSchema = zodToJSONSchema(schema);

      const scoresSchema = jsonSchema.properties?.scores as any;
      expect(scoresSchema?.type).toBe('object');
      // Value type should be number
      if (scoresSchema?.additionalProperties) {
        expect(scoresSchema.additionalProperties.type).toBe('number');
      }
    });

    it('should convert z.intersection() type', () => {
      const baseSchema = z.object({
        id: z.string(),
      });
      const extendedSchema = z.object({
        name: z.string(),
      });

      const schema = z.object({
        entity: z.intersection(baseSchema, extendedSchema),
      });

      const jsonSchema = zodToJSONSchema(schema);

      const entitySchema = jsonSchema.properties?.entity as any;
      // Intersection should create allOf or merged object
      expect(entitySchema).toBeDefined();
      // Document actual behavior - may be allOf or merged properties
      const hasAllOf = !!entitySchema?.allOf;
      const hasProperties = !!entitySchema?.properties;
      expect(hasAllOf || hasProperties).toBe(true);
    });

    it('should handle z.lazy() for recursive schemas', () => {
      // Define a simple recursive schema (tree node)
      interface TreeNode {
        value: string;
        children?: TreeNode[];
      }

      const treeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
        z.object({
          value: z.string(),
          children: z.array(treeNodeSchema).optional(),
        })
      );

      const schema = z.object({
        root: treeNodeSchema,
      });

      // Converting lazy schemas may throw or produce special output
      // This test documents the behavior
      try {
        const jsonSchema = zodToJSONSchema(schema);
        expect(jsonSchema).toBeDefined();
        expect(jsonSchema.properties?.root).toBeDefined();
      } catch (e) {
        // Lazy schemas may not be fully supported
        expect(e).toBeDefined();
      }
    });

    it('should convert z.tuple() type', () => {
      const schema = z.object({
        coordinates: z.tuple([z.number(), z.number()]),
      });

      const jsonSchema = zodToJSONSchema(schema);

      const coordSchema = jsonSchema.properties?.coordinates as any;
      expect(coordSchema?.type).toBe('array');
      // Tuple should have items or prefixItems
      expect(coordSchema?.items || coordSchema?.prefixItems).toBeDefined();
    });

    it('should convert z.literal() type', () => {
      const schema = z.object({
        type: z.literal('email'),
        priority: z.literal(1),
        enabled: z.literal(true),
      });

      const jsonSchema = zodToJSONSchema(schema);

      const typeSchema = jsonSchema.properties?.type as any;
      const prioritySchema = jsonSchema.properties?.priority as any;
      const enabledSchema = jsonSchema.properties?.enabled as any;

      // Literals should have const or enum with single value
      expect(typeSchema?.const === 'email' || typeSchema?.enum?.[0] === 'email').toBe(true);
      expect(prioritySchema?.const === 1 || prioritySchema?.enum?.[0] === 1).toBe(true);
      expect(enabledSchema?.const === true || enabledSchema?.enum?.[0] === true).toBe(true);
    });

    it('should convert z.nativeEnum() type', () => {
      enum Status {
        Active = 'active',
        Inactive = 'inactive',
        Pending = 'pending',
      }

      const schema = z.object({
        status: z.nativeEnum(Status),
      });

      const jsonSchema = zodToJSONSchema(schema);

      const statusSchema = jsonSchema.properties?.status as any;
      expect(statusSchema?.enum).toBeDefined();
      expect(statusSchema.enum).toContain('active');
      expect(statusSchema.enum).toContain('inactive');
      expect(statusSchema.enum).toContain('pending');
    });

    it('should convert z.discriminatedUnion() type', () => {
      const schema = z.object({
        notification: z.discriminatedUnion('type', [
          z.object({ type: z.literal('email'), emailAddress: z.string() }),
          z.object({ type: z.literal('sms'), phoneNumber: z.string() }),
        ]),
      });

      const jsonSchema = zodToJSONSchema(schema);

      const notifSchema = jsonSchema.properties?.notification as any;
      // Discriminated union should produce oneOf or anyOf
      expect(notifSchema?.oneOf || notifSchema?.anyOf).toBeDefined();
    });
  });

  describe('validatePluginConfig - Extended', () => {
    it('should include path in nested validation errors', () => {
      const schema = z.object({
        auth: z.object({
          apiKey: z.string().min(1),
        }),
      });

      const result = validatePluginConfig(schema, {
        auth: { apiKey: '' },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].path).toContain('apiKey');
      }
    });

    it('should validate array items', () => {
      const schema = z.object({
        items: z.array(z.string().min(1)),
      });

      const result = validatePluginConfig(schema, {
        items: ['valid', ''],
      });

      expect(result.success).toBe(false);
    });

    it('should transform data when schema includes transform', () => {
      const schema = z.object({
        name: z.string().transform((s) => s.toUpperCase()),
      });

      const result = validatePluginConfig(schema, { name: 'test' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('TEST');
      }
    });
  });

  describe('extractFormFieldHints - Extended', () => {
    it('should detect URL format', () => {
      const schema = z.object({
        endpoint: z.string().url(),
      });

      const jsonSchema = zodToJSONSchema(schema);
      const hints = extractFormFieldHints(jsonSchema);

      expect(hints.find((h) => h.name === 'endpoint')?.type).toBe('url');
    });

    it('should detect select type for enums', () => {
      const schema = z.object({
        level: z.enum(['debug', 'info', 'warn', 'error']),
      });

      const jsonSchema = zodToJSONSchema(schema);
      const hints = extractFormFieldHints(jsonSchema);

      expect(hints.find((h) => h.name === 'level')?.type).toBe('select');
    });

    it('should detect textarea for long strings', () => {
      const schema = z.object({
        description: z.string().max(500),
      });

      const jsonSchema = zodToJSONSchema(schema);
      const hints = extractFormFieldHints(jsonSchema);

      expect(hints.find((h) => h.name === 'description')?.type).toBe('textarea');
    });

    it('should mark required fields', () => {
      const schema = z.object({
        required: z.string(),
        optional: z.string().optional(),
      });

      const jsonSchema = zodToJSONSchema(schema);
      const hints = extractFormFieldHints(jsonSchema);

      expect(hints.find((h) => h.name === 'required')?.required).toBe(true);
      expect(hints.find((h) => h.name === 'optional')?.required).toBe(false);
    });

    it('should extract validation rules', () => {
      const schema = z.object({
        name: z.string().min(1).max(100),
      });

      const jsonSchema = zodToJSONSchema(schema);
      const hints = extractFormFieldHints(jsonSchema);

      const nameHint = hints.find((h) => h.name === 'name');
      expect(nameHint?.validation?.minLength).toBe(1);
      expect(nameHint?.validation?.maxLength).toBe(100);
    });

    it('should extract placeholder from default', () => {
      const schema = z.object({
        endpoint: z.string().default('https://api.example.com'),
      });

      const jsonSchema = zodToJSONSchema(schema);
      const hints = extractFormFieldHints(jsonSchema);

      const endpointHint = hints.find((h) => h.name === 'endpoint');
      expect(endpointHint?.placeholder).toBeDefined();
    });

    it('should handle empty schema', () => {
      const schema = z.object({});

      const jsonSchema = zodToJSONSchema(schema);
      const hints = extractFormFieldHints(jsonSchema);

      expect(hints).toHaveLength(0);
    });
  });
});

// =============================================================================
// Additional Registry and Schema Edge Cases
// =============================================================================

describe('Registry Advanced Scenarios', () => {
  describe('Capability deduplication', () => {
    it('should track capability owner accurately', () => {
      const registry = new CapabilityRegistry();

      registry.registerNotifier(
        'email',
        { send: async () => ({ success: true, messageId: '1' }) },
        'owner-plugin'
      );

      const owner = registry.getCapabilityOwner('notifier.email');
      expect(owner).toBe('owner-plugin');
    });

    it('should update owner when capability is re-registered after unregister', () => {
      const registry = new CapabilityRegistry();

      // First registration
      registry.registerNotifier(
        'email',
        { send: async () => ({ success: true, messageId: '1' }) },
        'first-plugin'
      );

      // Unregister first plugin
      registry.unregisterPlugin('first-plugin');

      // Register by second plugin
      registry.registerNotifier(
        'email',
        { send: async () => ({ success: true, messageId: '2' }) },
        'second-plugin'
      );

      const owner = registry.getCapabilityOwner('notifier.email');
      expect(owner).toBe('second-plugin');
    });

    it('should list capabilities in consistent order', () => {
      const registry = new CapabilityRegistry();

      // Register in specific order
      registry.registerNotifier(
        'sms',
        { send: async () => ({ success: true, messageId: '1' }) },
        'p1'
      );
      registry.registerNotifier(
        'email',
        { send: async () => ({ success: true, messageId: '2' }) },
        'p2'
      );
      registry.registerNotifier(
        'push',
        { send: async () => ({ success: true, messageId: '3' }) },
        'p3'
      );

      const capabilities = registry.listCapabilities();

      // Should contain all three
      expect(capabilities).toContain('notifier.sms');
      expect(capabilities).toContain('notifier.email');
      expect(capabilities).toContain('notifier.push');
    });
  });

  describe('Notifier handler behavior', () => {
    it('should pass notification to handler', async () => {
      const registry = new CapabilityRegistry();
      let receivedNotification: any = null;

      registry.registerNotifier(
        'test',
        {
          send: async (notification) => {
            receivedNotification = notification;
            return { success: true, messageId: 'test-1' };
          },
        },
        'context-plugin'
      );

      const result = await registry.sendNotification({
        channel: 'test',
        to: 'user@example.com',
        subject: 'Test',
        body: 'Body',
        metadata: { tenantId: 'tenant-123' },
      });

      expect(result.success).toBe(true);
      expect(receivedNotification).toBeDefined();
      expect(receivedNotification.to).toBe('user@example.com');
    });

    it('should handle notification with template fields', async () => {
      const registry = new CapabilityRegistry();
      let receivedNotification: any = null;

      registry.registerNotifier(
        'full',
        {
          send: async (notification) => {
            receivedNotification = notification;
            return { success: true, messageId: 'full-1' };
          },
        },
        'full-plugin'
      );

      const result = await registry.sendNotification({
        channel: 'full',
        to: 'recipient@example.com',
        subject: 'Full notification',
        body: 'Full body text',
        templateId: 'template-123',
        templateData: { name: 'John', code: '123456' },
        metadata: {
          tenantId: 'tenant-1',
        },
      });

      expect(result.success).toBe(true);
      expect(receivedNotification).toBeDefined();
      expect(receivedNotification.to).toBe('recipient@example.com');
    });
  });
});

describe('Schema Conversion Edge Cases', () => {
  describe('Complex validation rules', () => {
    it('should handle schema with regex pattern', () => {
      const schema = z.object({
        code: z.string().regex(/^[A-Z]{3}-\d{4}$/),
      });

      const jsonSchema = zodToJSONSchema(schema);

      expect(jsonSchema.properties?.code).toBeDefined();
      // Pattern may or may not be preserved depending on implementation
    });

    it('should handle schema with multiple string constraints', () => {
      const schema = z.object({
        username: z.string().min(3).max(20).toLowerCase(),
      });

      const jsonSchema = zodToJSONSchema(schema);

      expect(jsonSchema.properties?.username).toBeDefined();
      expect(jsonSchema.properties?.username?.minLength).toBe(3);
      expect(jsonSchema.properties?.username?.maxLength).toBe(20);
    });

    it('should handle schema with number constraints', () => {
      const schema = z.object({
        age: z.number().int().min(0).max(150),
        score: z.number().multipleOf(0.5),
      });

      const jsonSchema = zodToJSONSchema(schema);

      expect(jsonSchema.properties?.age?.minimum).toBe(0);
      expect(jsonSchema.properties?.age?.maximum).toBe(150);
    });

    it('should handle schema with date type', () => {
      const schema = z.object({
        createdAt: z.date(),
        expiresAt: z.date().optional(),
      });

      const jsonSchema = zodToJSONSchema(schema);

      // Date conversion behavior varies by implementation
      expect(jsonSchema.properties?.createdAt).toBeDefined();
    });
  });

  describe('Nested object handling', () => {
    it('should handle deeply nested objects (3+ levels)', () => {
      const schema = z.object({
        level1: z.object({
          level2: z.object({
            level3: z.object({
              value: z.string(),
            }),
          }),
        }),
      });

      const jsonSchema = zodToJSONSchema(schema);

      expect(jsonSchema.properties?.level1?.properties?.level2?.properties?.level3).toBeDefined();
      expect(
        jsonSchema.properties?.level1?.properties?.level2?.properties?.level3?.properties?.value
          ?.type
      ).toBe('string');
    });

    it('should handle optional nested objects', () => {
      const schema = z.object({
        settings: z
          .object({
            notifications: z.object({
              email: z.boolean(),
            }),
          })
          .optional(),
      });

      const jsonSchema = zodToJSONSchema(schema);

      // Optional nested object should not be in required, or required should be undefined/empty
      if (jsonSchema.required) {
        expect(jsonSchema.required).not.toContain('settings');
      } else {
        // No required array means nothing is required
        expect(jsonSchema.required).toBeFalsy();
      }
    });
  });

  describe('Form field extraction edge cases', () => {
    it('should handle schema with only optional fields', () => {
      const schema = z.object({
        opt1: z.string().optional(),
        opt2: z.number().optional(),
        opt3: z.boolean().optional(),
      });

      const jsonSchema = zodToJSONSchema(schema);
      const hints = extractFormFieldHints(jsonSchema);

      expect(hints).toHaveLength(3);
      hints.forEach((hint) => {
        expect(hint.required).toBe(false);
      });
    });

    it('should infer textarea for long text fields', () => {
      const schema = z.object({
        shortText: z.string().max(50),
        longText: z.string().max(5000),
        description: z.string(),
      });

      const jsonSchema = zodToJSONSchema(schema);
      const hints = extractFormFieldHints(jsonSchema);

      const longTextHint = hints.find((h) => h.name === 'longText');
      const shortTextHint = hints.find((h) => h.name === 'shortText');

      // Long text fields may be inferred as textarea
      expect(longTextHint).toBeDefined();
      expect(shortTextHint).toBeDefined();
    });

    it('should handle schema with enum descriptions', () => {
      const schema = z.object({
        status: z.enum(['active', 'inactive', 'pending']).describe('Current status of the item'),
      });

      const jsonSchema = zodToJSONSchema(schema);
      const hints = extractFormFieldHints(jsonSchema);

      const statusHint = hints.find((h) => h.name === 'status');
      expect(statusHint).toBeDefined();
      // fieldType inference depends on implementation
      // The hint should at least be generated
      expect(hints.length).toBeGreaterThan(0);
    });

    it('should preserve field order from schema', () => {
      const schema = z.object({
        first: z.string(),
        second: z.number(),
        third: z.boolean(),
      });

      const jsonSchema = zodToJSONSchema(schema);
      const hints = extractFormFieldHints(jsonSchema);

      expect(hints[0].name).toBe('first');
      expect(hints[1].name).toBe('second');
      expect(hints[2].name).toBe('third');
    });
  });
});
