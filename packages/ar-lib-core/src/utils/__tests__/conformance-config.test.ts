/**
 * Conformance Mode Configuration Tests
 *
 * Tests for:
 * - getConformanceConfig: KV > env > default priority
 * - isConformanceMode: convenience check
 * - createConfigurationError: error response
 */

import { describe, it, expect, vi } from 'vitest';
import {
  getConformanceConfig,
  isConformanceMode,
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
          'feature.conformance_enabled': true,
        });

        const result = await getConformanceConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
          ENABLE_CONFORMANCE_MODE: 'false', // Should be ignored
        });

        expect(result.enabled).toBe(true);
      });

      it('should return env config when KV not configured', async () => {
        const mockSettings = createMockSettings(null);

        const result = await getConformanceConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
          ENABLE_CONFORMANCE_MODE: 'true',
        });

        expect(result.enabled).toBe(true);
      });

      it('should return default when neither KV nor env configured', async () => {
        const mockSettings = createMockSettings(null);

        const result = await getConformanceConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
        });

        expect(result).toEqual(DEFAULT_CONFORMANCE_CONFIG);
        expect(result.enabled).toBe(false);
      });

      it('should return default when SETTINGS is undefined', async () => {
        const result = await getConformanceConfig({});

        expect(result).toEqual(DEFAULT_CONFORMANCE_CONFIG);
      });
    });

    describe('KV partial config handling', () => {
      it('should use default for missing enabled field', async () => {
        const mockSettings = createMockSettings({ 'feature.enable_flow_engine': true });

        const result = await getConformanceConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
        });

        expect(result.enabled).toBe(DEFAULT_CONFORMANCE_CONFIG.enabled);
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

        expect(result).toEqual({ enabled: false });
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

      it('stays disabled when the Settings API cannot be read, even if env enables it', async () => {
        const mockSettings = {
          get: vi.fn(async (key: string) => {
            if (key === 'settings:platform:feature-flags') throw new Error('KV error');
            return null;
          }),
        };

        const result = await getConformanceConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
          ENABLE_CONFORMANCE_MODE: 'true',
        });

        expect(result).toEqual({ enabled: false });
      });
    });
  });

  describe('isConformanceMode', () => {
    it('should return true when conformance is enabled', async () => {
      const mockSettings = createMockSettings({ 'feature.conformance_enabled': true });

      const result = await isConformanceMode({
        SETTINGS: mockSettings as unknown as KVNamespace,
      });

      expect(result).toBe(true);
    });

    it('should return false when conformance is disabled', async () => {
      const mockSettings = createMockSettings({ 'feature.conformance_enabled': false });

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
  });
});
