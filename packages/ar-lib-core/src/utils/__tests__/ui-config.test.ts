/**
 * UI Configuration Manager Tests
 *
 * Tests for:
 * - getUIConfig: Settings API > the older ui-config values > env > null
 * - buildUIUrl: URL building with tenant_hint
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getUIConfig, buildUIUrl, DEFAULT_UI_PATHS, type UIConfig } from '../ui-config';

describe('UI Configuration Manager', () => {
  // Mock KV storage
  const createMockSettings = (data: Record<string, unknown> | null) => ({
    get: vi.fn().mockResolvedValue(data ? JSON.stringify(data) : null),
  });

  describe('getUIConfig', () => {
    describe('priority: KV > env > null', () => {
      it('should return KV config when available', async () => {
        // The platform's Settings API values (tenant.ui_*).
        const mockSettings = createMockSettings({
          'tenant.ui_base_url': 'https://login.kv.example.com/',
          'tenant.ui_login_path': '/custom-login',
        });

        const result = await getUIConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
          UI_URL: 'https://login.env.example.com',
          ALLOWED_ORIGINS: 'https://login.kv.example.com',
        });

        expect(result).not.toBeNull();
        expect(result!.baseUrl).toBe('https://login.kv.example.com');
        expect(result!.paths.login).toBe('/custom-login');
        // Other paths should be defaults
        expect(result!.paths.consent).toBe(DEFAULT_UI_PATHS.consent);
      });

      it('should return env config when KV not configured', async () => {
        const mockSettings = createMockSettings(null);

        const result = await getUIConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
          UI_URL: 'https://login.env.example.com/',
        });

        expect(result).not.toBeNull();
        expect(result!.baseUrl).toBe('https://login.env.example.com');
        expect(result!.paths).toEqual(DEFAULT_UI_PATHS);
      });

      it('should return env config when KV has no ui.baseUrl', async () => {
        const mockSettings = createMockSettings({
          ui: { paths: { login: '/custom-login' } },
        });

        const result = await getUIConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
          UI_URL: 'https://login.env.example.com',
        });

        // Since no baseUrl in KV, falls back to env
        expect(result!.baseUrl).toBe('https://login.env.example.com');
      });

      it('should return null when neither KV nor env configured', async () => {
        const mockSettings = createMockSettings(null);

        const result = await getUIConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
        });

        expect(result).toBeNull();
      });

      it('should return null when SETTINGS is undefined', async () => {
        const result = await getUIConfig({});

        expect(result).toBeNull();
      });

      it('should handle KV error gracefully and fall back to env', async () => {
        const mockSettings = {
          get: vi.fn().mockRejectedValue(new Error('KV error')),
        };

        const result = await getUIConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
          UI_URL: 'https://login.env.example.com',
        });

        expect(result!.baseUrl).toBe('https://login.env.example.com');
      });

      it('should handle invalid JSON in KV gracefully', async () => {
        const mockSettings = {
          get: vi.fn().mockResolvedValue('invalid json'),
        };

        const result = await getUIConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
          UI_URL: 'https://login.env.example.com',
        });

        expect(result!.baseUrl).toBe('https://login.env.example.com');
      });
    });

    describe('URL normalization', () => {
      it('should remove trailing slash from KV baseUrl', async () => {
        const mockSettings = createMockSettings({
          'tenant.ui_base_url': 'https://login.example.com/',
        });

        const result = await getUIConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
          ALLOWED_ORIGINS: 'https://login.example.com',
        });

        expect(result!.baseUrl).toBe('https://login.example.com');
      });

      it('should remove trailing slash from env UI_URL', async () => {
        const result = await getUIConfig({
          UI_URL: 'https://login.example.com/',
        });

        expect(result!.baseUrl).toBe('https://login.example.com');
      });
    });
  });

  describe('buildUIUrl', () => {
    const config: UIConfig = {
      baseUrl: 'https://login.example.com',
      paths: DEFAULT_UI_PATHS,
    };

    it('should build URL for login path', () => {
      const url = buildUIUrl(config, 'login');
      expect(url).toBe('https://login.example.com/login');
    });

    it('should build URL with query parameters', () => {
      const url = buildUIUrl(config, 'login', {
        redirect_uri: 'https://app.example.com/callback',
        state: 'abc123',
      });

      expect(url).toContain('redirect_uri=https');
      expect(url).toContain('state=abc123');
    });

    it('should add tenant_hint when provided', () => {
      const url = buildUIUrl(config, 'login', undefined, 'acme');
      expect(url).toBe('https://login.example.com/login?tenant_hint=acme');
    });

    it('should combine params and tenant_hint', () => {
      const url = buildUIUrl(config, 'login', { state: 'xyz' }, 'acme');

      expect(url).toContain('state=xyz');
      expect(url).toContain('tenant_hint=acme');
    });

    it('should build URLs for all path types', () => {
      const pathKeys: Array<keyof typeof DEFAULT_UI_PATHS> = [
        'login',
        'consent',
        'reauth',
        'error',
        'device',
        'deviceAuthorize',
        'logoutComplete',
        'loggedOut',
        'register',
      ];

      for (const pathKey of pathKeys) {
        const url = buildUIUrl(config, pathKey);
        expect(url).toBe(`https://login.example.com${DEFAULT_UI_PATHS[pathKey]}`);
      }
    });
  });

  describe('DEFAULT_UI_PATHS', () => {
    it('should have all required paths defined', () => {
      expect(DEFAULT_UI_PATHS).toEqual({
        login: '/login',
        consent: '/consent',
        reauth: '/reauth',
        error: '/error',
        device: '/device',
        deviceAuthorize: '/device/authorize',
        logoutComplete: '/logout-complete',
        loggedOut: '/logged-out',
        register: '/signup',
      });
    });
  });
});

describe('getUIConfig with an unusable saved base URL', () => {
  it('falls back to UI_URL, as before, instead of failing', async () => {
    const env = {
      SETTINGS: {
        get: async () => JSON.stringify({ ui: { baseUrl: 123, paths: { login: '/x' } } }),
      } as unknown as KVNamespace,
      UI_URL: 'https://ui.example.com/',
    };

    await expect(getUIConfig(env)).resolves.toEqual({
      baseUrl: 'https://ui.example.com',
      paths: DEFAULT_UI_PATHS,
    });
  });
});
