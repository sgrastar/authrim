/**
 * Conformance Mode Configuration Tests
 *
 * Tests for:
 * - getConformanceConfig: KV > env > default priority
 * - isConformanceMode: convenience check
 * - shouldUseBuiltinForms: form rendering decision
 * - getConformanceConfigSource: debugging info
 * - createConfigurationError: error response
 */

import { describe, it, expect, vi } from 'vitest';
import {
  getConformanceConfig,
  isConformanceMode,
  shouldUseBuiltinForms,
  getConformanceConfigSource,
  createConfigurationError,
  DEFAULT_CONFORMANCE_CONFIG,
} from '../conformance-config';

describe('Conformance Mode Configuration', () => {
  // Mock KV storage
  const createMockSettings = (data: Record<string, unknown> | null) => ({
    get: vi.fn().mockResolvedValue(data ? JSON.stringify(data) : null),
  });

  describe('getConformanceConfig', () => {
    describe('priority: KV > env > default', () => {
      it('should return KV config when available', async () => {
        const mockSettings = createMockSettings({
          conformance: { enabled: true, useBuiltinForms: false },
        });

        const result = await getConformanceConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
          ENABLE_CONFORMANCE_MODE: 'false', // Should be ignored
        });

        expect(result.enabled).toBe(true);
        expect(result.useBuiltinForms).toBe(false);
      });

      it('should return env config when KV not configured', async () => {
        const mockSettings = createMockSettings(null);

        const result = await getConformanceConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
          ENABLE_CONFORMANCE_MODE: 'true',
        });

        expect(result.enabled).toBe(true);
        expect(result.useBuiltinForms).toBe(true); // Enabled when env conformance is true
      });

      it('should return default when neither KV nor env configured', async () => {
        const mockSettings = createMockSettings(null);

        const result = await getConformanceConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
        });

        expect(result).toEqual(DEFAULT_CONFORMANCE_CONFIG);
        expect(result.enabled).toBe(false);
        expect(result.useBuiltinForms).toBe(true);
      });

      it('should return default when SETTINGS is undefined', async () => {
        const result = await getConformanceConfig({});

        expect(result).toEqual(DEFAULT_CONFORMANCE_CONFIG);
      });
    });

    describe('KV partial config handling', () => {
      it('should use default for missing enabled field', async () => {
        const mockSettings = createMockSettings({
          conformance: { useBuiltinForms: false },
        });

        const result = await getConformanceConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
        });

        expect(result.enabled).toBe(DEFAULT_CONFORMANCE_CONFIG.enabled);
        expect(result.useBuiltinForms).toBe(false);
      });

      it('should use default for missing useBuiltinForms field', async () => {
        const mockSettings = createMockSettings({
          conformance: { enabled: true },
        });

        const result = await getConformanceConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
        });

        expect(result.enabled).toBe(true);
        expect(result.useBuiltinForms).toBe(DEFAULT_CONFORMANCE_CONFIG.useBuiltinForms);
      });
    });

    describe('env boolean parsing', () => {
      it('should parse "true" as true', async () => {
        const result = await getConformanceConfig({
          ENABLE_CONFORMANCE_MODE: 'true',
        });

        expect(result.enabled).toBe(true);
      });

      it('should parse "TRUE" as true (case insensitive)', async () => {
        const result = await getConformanceConfig({
          ENABLE_CONFORMANCE_MODE: 'TRUE',
        });

        expect(result.enabled).toBe(true);
      });

      it('should parse "1" as true', async () => {
        const result = await getConformanceConfig({
          ENABLE_CONFORMANCE_MODE: '1',
        });

        expect(result.enabled).toBe(true);
      });

      it('should parse "false" as false', async () => {
        const result = await getConformanceConfig({
          ENABLE_CONFORMANCE_MODE: 'false',
        });

        expect(result.enabled).toBe(false);
      });

      it('should parse "0" as false', async () => {
        const result = await getConformanceConfig({
          ENABLE_CONFORMANCE_MODE: '0',
        });

        expect(result.enabled).toBe(false);
      });

      it('should parse any other value as false', async () => {
        const result = await getConformanceConfig({
          ENABLE_CONFORMANCE_MODE: 'invalid',
        });

        expect(result.enabled).toBe(false);
      });
    });

    describe('error handling', () => {
      it('stays disabled when KV cannot be read, even if env enables it', async () => {
        const mockSettings = {
          get: vi.fn().mockRejectedValue(new Error('KV error')),
        };

        const result = await getConformanceConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
          ENABLE_CONFORMANCE_MODE: 'true',
        });

        expect(result).toEqual({ enabled: false, useBuiltinForms: false });
      });

      it('stays disabled when the stored settings are not valid JSON', async () => {
        const mockSettings = {
          get: vi.fn().mockResolvedValue('invalid json'),
        };

        const result = await getConformanceConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
          ENABLE_CONFORMANCE_MODE: 'true',
        });

        expect(result.enabled).toBe(false);
      });

      it('stays disabled when the older settings cannot be read, even if the Settings API enables it', async () => {
        const mockSettings = {
          get: vi.fn(async (key: string) => {
            if (key === 'system_settings') return 'invalid json';
            if (key === 'settings:platform:feature-flags') {
              return JSON.stringify({
                'feature.conformance_enabled': true,
                'feature.conformance_use_builtin_forms': true,
              });
            }
            return null;
          }),
        };

        const result = await getConformanceConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
        });

        expect(result).toEqual({ enabled: false, useBuiltinForms: false });
      });

      it('stays disabled when the Settings API cannot be read, even if older settings enable it', async () => {
        const documents: Record<string, string> = {
          system_settings: JSON.stringify({
            conformance: { enabled: true, useBuiltinForms: true },
          }),
        };
        const mockSettings = {
          get: vi.fn(async (key: string) => {
            if (key === 'settings:platform:feature-flags') throw new Error('KV error');
            return documents[key] ?? null;
          }),
        };

        const result = await getConformanceConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
          ENABLE_CONFORMANCE_MODE: 'true',
        });

        expect(result).toEqual({ enabled: false, useBuiltinForms: false });
      });
    });
  });

  describe('isConformanceMode', () => {
    it('should return true when conformance is enabled', async () => {
      const mockSettings = createMockSettings({
        conformance: { enabled: true },
      });

      const result = await isConformanceMode({
        SETTINGS: mockSettings as unknown as KVNamespace,
      });

      expect(result).toBe(true);
    });

    it('should return false when conformance is disabled', async () => {
      const mockSettings = createMockSettings({
        conformance: { enabled: false },
      });

      const result = await isConformanceMode({
        SETTINGS: mockSettings as unknown as KVNamespace,
      });

      expect(result).toBe(false);
    });

    it('should return false by default', async () => {
      const result = await isConformanceMode({});

      expect(result).toBe(false);
    });
  });

  describe('shouldUseBuiltinForms', () => {
    it('should return true when both enabled and useBuiltinForms are true', async () => {
      const mockSettings = createMockSettings({
        conformance: { enabled: true, useBuiltinForms: true },
      });

      const result = await shouldUseBuiltinForms({
        SETTINGS: mockSettings as unknown as KVNamespace,
      });

      expect(result).toBe(true);
    });

    it('should return false when enabled but useBuiltinForms is false', async () => {
      const mockSettings = createMockSettings({
        conformance: { enabled: true, useBuiltinForms: false },
      });

      const result = await shouldUseBuiltinForms({
        SETTINGS: mockSettings as unknown as KVNamespace,
      });

      expect(result).toBe(false);
    });

    it('should return false when disabled even if useBuiltinForms is true', async () => {
      const mockSettings = createMockSettings({
        conformance: { enabled: false, useBuiltinForms: true },
      });

      const result = await shouldUseBuiltinForms({
        SETTINGS: mockSettings as unknown as KVNamespace,
      });

      expect(result).toBe(false);
    });

    it('should return false by default', async () => {
      const result = await shouldUseBuiltinForms({});

      // Default: enabled=false, so result is false regardless of useBuiltinForms
      expect(result).toBe(false);
    });
  });

  describe('getConformanceConfigSource', () => {
    it('should return "kv" when KV has conformance config', async () => {
      const mockSettings = createMockSettings({
        conformance: { enabled: true },
      });

      const source = await getConformanceConfigSource({
        SETTINGS: mockSettings as unknown as KVNamespace,
        ENABLE_CONFORMANCE_MODE: 'true',
      });

      expect(source).toBe('kv');
    });

    it('should return "env" when only env configured', async () => {
      const mockSettings = createMockSettings(null);

      const source = await getConformanceConfigSource({
        SETTINGS: mockSettings as unknown as KVNamespace,
        ENABLE_CONFORMANCE_MODE: 'true',
      });

      expect(source).toBe('env');
    });

    it('should return "default" when nothing configured', async () => {
      const mockSettings = createMockSettings(null);

      const source = await getConformanceConfigSource({
        SETTINGS: mockSettings as unknown as KVNamespace,
      });

      expect(source).toBe('default');
    });

    it('should return "env" even when ENABLE_CONFORMANCE_MODE is "false"', async () => {
      const mockSettings = createMockSettings(null);

      const source = await getConformanceConfigSource({
        SETTINGS: mockSettings as unknown as KVNamespace,
        ENABLE_CONFORMANCE_MODE: 'false',
      });

      // env var is defined, even if value is "false"
      expect(source).toBe('env');
    });

    it('should handle KV error gracefully', async () => {
      const mockSettings = {
        get: vi.fn().mockRejectedValue(new Error('KV error')),
      };

      const source = await getConformanceConfigSource({
        SETTINGS: mockSettings as unknown as KVNamespace,
        ENABLE_CONFORMANCE_MODE: 'true',
      });

      expect(source).toBe('env');
    });
  });

  describe('createConfigurationError', () => {
    it('should return correct error object', () => {
      const error = createConfigurationError();

      expect(error).toEqual({
        error: 'configuration_error',
        error_description: 'UI_URL is not configured and conformance mode is disabled',
      });
    });

    it('should have correct error type', () => {
      const error = createConfigurationError();

      expect(error.error).toBe('configuration_error');
    });

    it('should have descriptive error message', () => {
      const error = createConfigurationError();

      expect(error.error_description).toContain('UI_URL');
      expect(error.error_description).toContain('conformance mode');
    });
  });

  describe('DEFAULT_CONFORMANCE_CONFIG', () => {
    it('should have safe defaults (disabled)', () => {
      expect(DEFAULT_CONFORMANCE_CONFIG.enabled).toBe(false);
    });

    it('should have useBuiltinForms true (for when enabled)', () => {
      expect(DEFAULT_CONFORMANCE_CONFIG.useBuiltinForms).toBe(true);
    });
  });
});
