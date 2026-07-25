/**
 * UI Configuration Manager Tests
 *
 * Tests for:
 * - getUIConfig: KV > env > null priority
 * - buildUIUrl: URL building with tenant_hint
 * - getUIRoutingConfig: Routing configuration
 * - evaluatePolicyRedirect: Policy evaluation
 * - getRoleBasedPath: Role-based path overrides
 * - buildUIUrlWithOverrides: Full URL building with overrides
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getUIConfig,
  getUIRoutingConfig,
  getUIConfigSource,
  buildUIUrl,
  getRoleBasedPath,
  evaluatePolicyRedirect,
  buildUIUrlWithOverrides,
  DEFAULT_UI_PATHS,
  type UIConfig,
  type UIRoutingConfig,
} from '../ui-config';

describe('UI Configuration Manager', () => {
  // Mock KV storage
  const createMockSettings = (data: Record<string, unknown> | null) => ({
    get: vi.fn().mockResolvedValue(data ? JSON.stringify(data) : null),
  });

  describe('getUIConfig', () => {
    describe('priority: KV > env > null', () => {
      it('should return KV config when available', async () => {
        const mockSettings = createMockSettings({
          ui: {
            baseUrl: 'https://login.kv.example.com/',
            paths: { login: '/custom-login' },
          },
        });

        const result = await getUIConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
          UI_URL: 'https://login.env.example.com',
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
          ui: { baseUrl: 'https://login.example.com/' },
        });

        const result = await getUIConfig({
          SETTINGS: mockSettings as unknown as KVNamespace,
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

  describe('getUIConfigSource', () => {
    it('should return "kv" when KV has ui.baseUrl', async () => {
      const mockSettings = createMockSettings({
        ui: { baseUrl: 'https://login.example.com' },
      });

      const source = await getUIConfigSource({
        SETTINGS: mockSettings as unknown as KVNamespace,
        UI_URL: 'https://login.env.example.com',
      });

      expect(source).toBe('kv');
    });

    it('should return "env" when only env configured', async () => {
      const mockSettings = createMockSettings(null);

      const source = await getUIConfigSource({
        SETTINGS: mockSettings as unknown as KVNamespace,
        UI_URL: 'https://login.env.example.com',
      });

      expect(source).toBe('env');
    });

    it('should return "none" when nothing configured', async () => {
      const mockSettings = createMockSettings(null);

      const source = await getUIConfigSource({
        SETTINGS: mockSettings as unknown as KVNamespace,
      });

      expect(source).toBe('none');
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

  describe('getUIRoutingConfig', () => {
    it('should return routing config from KV', async () => {
      const mockSettings = createMockSettings({
        routing: {
          rolePathOverrides: {
            admin: { login: '/admin/login' },
          },
          policyRedirects: [
            {
              conditions: [{ field: 'org_type', operator: 'eq', value: 'enterprise' }],
              redirectPath: '/enterprise/dashboard',
            },
          ],
        },
      });

      const result = await getUIRoutingConfig({
        SETTINGS: mockSettings as unknown as KVNamespace,
      });

      expect(result).not.toBeNull();
      expect(result!.rolePathOverrides?.admin?.login).toBe('/admin/login');
      expect(result!.policyRedirects).toHaveLength(1);
    });

    it('should return null when SETTINGS not provided', async () => {
      const result = await getUIRoutingConfig({});
      expect(result).toBeNull();
    });

    it('should return null when KV has no routing config', async () => {
      const mockSettings = createMockSettings({ ui: { baseUrl: 'https://example.com' } });

      const result = await getUIRoutingConfig({
        SETTINGS: mockSettings as unknown as KVNamespace,
      });

      expect(result).toBeNull();
    });

    it('should handle KV error gracefully', async () => {
      const mockSettings = {
        get: vi.fn().mockRejectedValue(new Error('KV error')),
      };

      const result = await getUIRoutingConfig({
        SETTINGS: mockSettings as unknown as KVNamespace,
      });

      expect(result).toBeNull();
    });
  });

  describe('getRoleBasedPath', () => {
    const routingConfig: UIRoutingConfig = {
      rolePathOverrides: {
        admin: { login: '/admin/login', consent: '/admin/consent' },
        support: { login: '/support/login' },
      },
    };

    it('should return override for matching role', () => {
      const path = getRoleBasedPath(routingConfig, ['admin'], 'login');
      expect(path).toBe('/admin/login');
    });

    it('should return first matching role in list', () => {
      // User has both roles, admin comes first in the array
      const path = getRoleBasedPath(routingConfig, ['admin', 'support'], 'login');
      expect(path).toBe('/admin/login');
    });

    it('should check roles in order (first match wins)', () => {
      // User has support first, then admin
      const path = getRoleBasedPath(routingConfig, ['support', 'admin'], 'login');
      expect(path).toBe('/support/login');
    });

    it('should return undefined for non-overridden path', () => {
      const path = getRoleBasedPath(routingConfig, ['admin'], 'error');
      expect(path).toBeUndefined();
    });

    it('should return undefined for non-matching role', () => {
      const path = getRoleBasedPath(routingConfig, ['user'], 'login');
      expect(path).toBeUndefined();
    });

    it('should return undefined when routingConfig is null', () => {
      const path = getRoleBasedPath(null, ['admin'], 'login');
      expect(path).toBeUndefined();
    });

    it('should return undefined when rolePathOverrides is undefined', () => {
      const path = getRoleBasedPath({}, ['admin'], 'login');
      expect(path).toBeUndefined();
    });
  });

  describe('evaluatePolicyRedirect', () => {
    describe('basic condition evaluation', () => {
      it('should return redirect path when "eq" condition matches', () => {
        const routingConfig: UIRoutingConfig = {
          policyRedirects: [
            {
              conditions: [{ field: 'org_type', operator: 'eq', value: 'enterprise' }],
              redirectPath: '/enterprise/dashboard',
            },
          ],
        };

        const result = evaluatePolicyRedirect(routingConfig, { org_type: 'enterprise' });
        expect(result).toBe('/enterprise/dashboard');
      });

      it('should return undefined when "eq" condition does not match', () => {
        const routingConfig: UIRoutingConfig = {
          policyRedirects: [
            {
              conditions: [{ field: 'org_type', operator: 'eq', value: 'enterprise' }],
              redirectPath: '/enterprise/dashboard',
            },
          ],
        };

        const result = evaluatePolicyRedirect(routingConfig, { org_type: 'startup' });
        expect(result).toBeUndefined();
      });

      it('should return undefined when "ne" condition matches value', () => {
        const routingConfig: UIRoutingConfig = {
          policyRedirects: [
            {
              conditions: [{ field: 'user_type', operator: 'ne', value: 'guest' }],
              redirectPath: '/member/home',
            },
          ],
        };

        const result = evaluatePolicyRedirect(routingConfig, { user_type: 'guest' });
        expect(result).toBeUndefined();
      });

      it('should return redirect path when "ne" condition does not match', () => {
        const routingConfig: UIRoutingConfig = {
          policyRedirects: [
            {
              conditions: [{ field: 'user_type', operator: 'ne', value: 'guest' }],
              redirectPath: '/member/home',
            },
          ],
        };

        const result = evaluatePolicyRedirect(routingConfig, { user_type: 'member' });
        expect(result).toBe('/member/home');
      });

      it('should handle "in" operator', () => {
        const routingConfig: UIRoutingConfig = {
          policyRedirects: [
            {
              conditions: [{ field: 'plan', operator: 'in', value: ['pro', 'enterprise'] }],
              redirectPath: '/premium/dashboard',
            },
          ],
        };

        expect(evaluatePolicyRedirect(routingConfig, { plan: 'pro' })).toBe('/premium/dashboard');
        expect(evaluatePolicyRedirect(routingConfig, { plan: 'free' })).toBeUndefined();
      });

      it('should handle "not_in" operator', () => {
        const routingConfig: UIRoutingConfig = {
          policyRedirects: [
            {
              conditions: [{ field: 'plan', operator: 'not_in', value: ['blocked', 'suspended'] }],
              redirectPath: '/dashboard',
            },
          ],
        };

        expect(evaluatePolicyRedirect(routingConfig, { plan: 'pro' })).toBe('/dashboard');
        expect(evaluatePolicyRedirect(routingConfig, { plan: 'blocked' })).toBeUndefined();
      });

      it('should handle "contains" operator', () => {
        const routingConfig: UIRoutingConfig = {
          policyRedirects: [
            {
              conditions: [{ field: 'email_domain_hash', operator: 'contains', value: 'corp' }],
              redirectPath: '/corporate',
            },
          ],
        };

        expect(evaluatePolicyRedirect(routingConfig, { email_domain_hash: 'acme-corp' })).toBe(
          '/corporate'
        );
        expect(
          evaluatePolicyRedirect(routingConfig, { email_domain_hash: 'gmail' })
        ).toBeUndefined();
      });
    });

    describe('role field handling (array context value)', () => {
      it('should match "eq" when role is in roles array', () => {
        const routingConfig: UIRoutingConfig = {
          policyRedirects: [
            {
              conditions: [{ field: 'role', operator: 'eq', value: 'admin' }],
              redirectPath: '/admin/panel',
            },
          ],
        };

        expect(evaluatePolicyRedirect(routingConfig, { roles: ['user', 'admin'] })).toBe(
          '/admin/panel'
        );
      });

      it('should not match "eq" when role is not in roles array', () => {
        const routingConfig: UIRoutingConfig = {
          policyRedirects: [
            {
              conditions: [{ field: 'role', operator: 'eq', value: 'admin' }],
              redirectPath: '/admin/panel',
            },
          ],
        };

        expect(evaluatePolicyRedirect(routingConfig, { roles: ['user'] })).toBeUndefined();
      });

      it('should match "in" when any role is in value array', () => {
        const routingConfig: UIRoutingConfig = {
          policyRedirects: [
            {
              conditions: [{ field: 'role', operator: 'in', value: ['admin', 'moderator'] }],
              redirectPath: '/staff/panel',
            },
          ],
        };

        expect(evaluatePolicyRedirect(routingConfig, { roles: ['user', 'moderator'] })).toBe(
          '/staff/panel'
        );
      });
    });

    describe('multiple conditions (AND logic)', () => {
      it('should require all conditions to match', () => {
        const routingConfig: UIRoutingConfig = {
          policyRedirects: [
            {
              conditions: [
                { field: 'org_type', operator: 'eq', value: 'enterprise' },
                { field: 'plan', operator: 'eq', value: 'premium' },
              ],
              redirectPath: '/enterprise-premium',
            },
          ],
        };

        // Both match
        expect(
          evaluatePolicyRedirect(routingConfig, { org_type: 'enterprise', plan: 'premium' })
        ).toBe('/enterprise-premium');

        // Only one matches
        expect(
          evaluatePolicyRedirect(routingConfig, { org_type: 'enterprise', plan: 'free' })
        ).toBeUndefined();
      });
    });

    describe('priority handling', () => {
      it('should evaluate higher priority rules first', () => {
        const routingConfig: UIRoutingConfig = {
          policyRedirects: [
            {
              conditions: [{ field: 'org_type', operator: 'eq', value: 'enterprise' }],
              redirectPath: '/enterprise-low',
              priority: 1,
            },
            {
              conditions: [{ field: 'org_type', operator: 'eq', value: 'enterprise' }],
              redirectPath: '/enterprise-high',
              priority: 10,
            },
          ],
        };

        const result = evaluatePolicyRedirect(routingConfig, { org_type: 'enterprise' });
        expect(result).toBe('/enterprise-high');
      });

      it('should default priority to 0', () => {
        const routingConfig: UIRoutingConfig = {
          policyRedirects: [
            {
              conditions: [{ field: 'org_type', operator: 'eq', value: 'enterprise' }],
              redirectPath: '/enterprise-default',
            },
            {
              conditions: [{ field: 'org_type', operator: 'eq', value: 'enterprise' }],
              redirectPath: '/enterprise-one',
              priority: 1,
            },
          ],
        };

        const result = evaluatePolicyRedirect(routingConfig, { org_type: 'enterprise' });
        expect(result).toBe('/enterprise-one');
      });
    });

    describe('edge cases', () => {
      it('should return undefined when routingConfig is null', () => {
        const result = evaluatePolicyRedirect(null, { org_type: 'enterprise' });
        expect(result).toBeUndefined();
      });

      it('should return undefined when policyRedirects is empty', () => {
        const result = evaluatePolicyRedirect({ policyRedirects: [] }, { org_type: 'enterprise' });
        expect(result).toBeUndefined();
      });

      it('should return undefined when context field is undefined', () => {
        const routingConfig: UIRoutingConfig = {
          policyRedirects: [
            {
              conditions: [{ field: 'org_type', operator: 'eq', value: 'enterprise' }],
              redirectPath: '/enterprise',
            },
          ],
        };

        const result = evaluatePolicyRedirect(routingConfig, {});
        expect(result).toBeUndefined();
      });
    });
  });

  describe('buildUIUrlWithOverrides', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should return null when UI not configured', async () => {
      const mockSettings = createMockSettings(null);

      const result = await buildUIUrlWithOverrides(
        {
          SETTINGS: mockSettings as unknown as KVNamespace,
        },
        'login'
      );

      expect(result).toBeNull();
    });

    it('should build URL without overrides', async () => {
      const mockSettings = createMockSettings({
        ui: { baseUrl: 'https://login.example.com' },
      });

      const result = await buildUIUrlWithOverrides(
        {
          SETTINGS: mockSettings as unknown as KVNamespace,
        },
        'login'
      );

      expect(result).toBe('https://login.example.com/login');
    });

    it('should apply role-based path override', async () => {
      const mockSettings = createMockSettings({
        ui: { baseUrl: 'https://login.example.com' },
        routing: {
          rolePathOverrides: {
            admin: { login: '/admin/login' },
          },
        },
      });

      const result = await buildUIUrlWithOverrides(
        { SETTINGS: mockSettings as unknown as KVNamespace },
        'login',
        undefined,
        { roles: ['admin'] }
      );

      expect(result).toBe('https://login.example.com/admin/login');
    });

    it('should add tenant_hint to URL', async () => {
      const mockSettings = createMockSettings({
        ui: { baseUrl: 'https://login.example.com' },
      });

      const result = await buildUIUrlWithOverrides(
        { SETTINGS: mockSettings as unknown as KVNamespace },
        'login',
        { state: 'xyz' },
        undefined,
        'acme'
      );

      expect(result).toContain('state=xyz');
      expect(result).toContain('tenant_hint=acme');
    });

    it('should combine all parameters', async () => {
      const mockSettings = createMockSettings({
        ui: { baseUrl: 'https://login.example.com' },
        routing: {
          rolePathOverrides: {
            admin: { login: '/admin/login' },
          },
        },
      });

      const result = await buildUIUrlWithOverrides(
        { SETTINGS: mockSettings as unknown as KVNamespace },
        'login',
        { state: 'abc' },
        { roles: ['admin'] },
        'acme'
      );

      expect(result).toContain('/admin/login');
      expect(result).toContain('state=abc');
      expect(result).toContain('tenant_hint=acme');
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
