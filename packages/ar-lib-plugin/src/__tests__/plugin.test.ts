/**
 * Plugin Architecture Tests
 *
 * Tests for the core plugin infrastructure.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { CapabilityRegistry, globalRegistry } from '../core/registry';
import { zodToJSONSchema, validatePluginConfig, extractFormFieldHints } from '../core/schema';
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
