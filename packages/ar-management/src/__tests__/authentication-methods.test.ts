/**
 * Authentication Methods API Tests
 *
 * Tests for the public authentication methods endpoint:
 * - GET /api/auth/authentication-methods
 *
 * Verifies:
 * - All methods enabled/disabled combinations
 * - External login provider fetching from EXTERNAL_IDP service binding
 * - UI config from settings-v2 (AUTHRIM_CONFIG KV) and legacy fallback
 * - 503 when no methods available
 * - Cache-Control header
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoist mock logger
const { mockLogger, mockResolveAuthCorePersistenceAdapterFromEnv } = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    module: vi.fn().mockReturnThis(),
  };
  return {
    mockLogger: logger,
    mockResolveAuthCorePersistenceAdapterFromEnv: vi.fn(),
  };
});

// Mock getLogger from ar-lib-core
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => mockLogger,
    resolveAuthCorePersistenceAdapterFromEnv: mockResolveAuthCorePersistenceAdapterFromEnv,
    readAuthenticationMethodsCacheRevision: async (
      env: Pick<Env, 'SETTINGS'>,
      tenantId: string
    ) => {
      const settings = env.SETTINGS;
      if (!settings) return '0.0';
      const [globalRevision, tenantRevision] = await Promise.all([
        settings.get('cache:authentication-methods:v1:revision:global'),
        settings.get(`cache:authentication-methods:v1:revision:tenant:${tenantId}`),
      ]);
      return `${globalRevision || '0'}.${tenantRevision || '0'}`;
    },
  };
});

import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { deriveEncryptionKey, encryptSecretFields } from '@authrim/ar-lib-plugin';
import { getAuthenticationMethodsHandler } from '../authentication-methods';

// =============================================================================
// Mock helpers
// =============================================================================

function createMockKV(data: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(data));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({
      keys: Array.from(store.keys()).map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    })),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

interface MockExternalIdpOptions {
  providers?: Array<{
    id: string;
    name: string;
    slug?: string;
    providerType?: string;
    enabled?: boolean;
    iconUrl?: string;
    iconName?: string;
    buttonColor?: string;
    buttonText?: string;
  }>;
  shouldFail?: boolean;
}

function createMockExternalIdp(options: MockExternalIdpOptions = {}) {
  const { providers = [], shouldFail = false } = options;
  return {
    fetch: vi.fn(async () => {
      if (shouldFail) {
        return new Response('Internal Server Error', { status: 500 });
      }
      return new Response(JSON.stringify({ providers }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  };
}

function createMockEdgeCache() {
  const store = new Map<string, Response>();
  return {
    match: vi.fn(async (request: Request) => store.get(request.url)?.clone()),
    put: vi.fn(async (request: Request, response: Response) => {
      store.set(request.url, response.clone());
    }),
  };
}

interface CreateTestAppOptions {
  settingsKV?: KVNamespace;
  configKV?: KVNamespace;
  externalIdp?: ReturnType<typeof createMockExternalIdp> | null;
}

function createTestApp(options: CreateTestAppOptions = {}) {
  const settingsKV = options.settingsKV ?? createMockKV();
  const configKV = options.configKV ?? createMockKV();
  const externalIdp = options.externalIdp !== undefined ? options.externalIdp : null;

  const app = new Hono<{ Bindings: Env }>();
  app.get('/api/auth/authentication-methods', getAuthenticationMethodsHandler);

  const mockEnv = {
    SETTINGS: settingsKV,
    AUTHRIM_CONFIG: configKV,
    EXTERNAL_IDP: externalIdp,
  } as unknown as Env;

  return { app, mockEnv, settingsKV, configKV };
}

// =============================================================================
// Tests
// =============================================================================

describe('Authentication Methods API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAuthCorePersistenceAdapterFromEnv.mockResolvedValue({
      query: vi.fn(async () => []),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { caches?: unknown }).caches;
  });

  // ===========================================================================
  // Default behavior
  // ===========================================================================

  describe('GET /api/auth/authentication-methods (defaults)', () => {
    it('should return passkey-only built-in methods by default', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.methods.passkey.enabled).toBe(true);
      expect(body.methods.passkey.capabilities).toEqual(['conditional', 'discoverable']);
      expect(body.methods.emailCode.enabled).toBe(false);
      expect(body.methods.emailCode.steps).toEqual([]);
      expect(body.methods.totp).toMatchObject({
        enabled: false,
        loginEnabled: false,
        signupEnabled: false,
        reauthEnabled: false,
        accountLinkEnabled: false,
        preset: 'compatible',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        window: 1,
        defaultAcr: 'urn:authrim:aal:2',
        requirement: { mode: 'optional' },
        steps: [],
      });
      expect(body.methods.directoryPassword.enabled).toBe(false);
      expect(body.methods.directoryPassword.label).toBe('Organization ID');
      expect(body.methods.directoryPassword.steps).toEqual([]);
      // No EXTERNAL_IDP → external login disabled
      expect(body.methods.external.enabled).toBe(false);
      expect(body.methods.external.providers).toEqual([]);
    });

    it('should return default UI config', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(body.ui.theme).toBe('light');
      expect(body.ui.variant).toBe('beige');
      expect(body.ui.branding.brandName).toBe('Authrim');
      expect(body.ui.branding.logoUrl).toBeNull();
      expect(body.ui.branding.faviconUrl).toBeNull();
      expect(body.ui.themeTemplate).toBe('meridian');
      expect(body.ui.pageTemplate).toMatchObject({
        layout: 'centered_card',
        logoLayout: 'stack',
        topbarPosition: 'below_card',
        themeToggleEnabled: true,
        languageSelectEnabled: true,
        headerStyle: 'center',
        footerStyle: 'simple',
        splitFrame: 'full',
        splitPanelSide: 'left',
        splitPanelWidth: 'narrow',
        splitBackgroundMode: 'shared',
        loginPanelBackgroundColor: '',
        loginPanelBackgroundGradientColor: '',
        loginPanelBackgroundOpacity: 70,
        brandContentMode: 'logo_copy',
        brandPosition: 'center',
        brandAlign: 'left',
      });
      expect(body.ui.supportedLocales).toEqual([
        'en',
        'ja',
        'zh-CN',
        'zh-TW',
        'es',
        'pt',
        'fr',
        'de',
        'ko',
        'ru',
        'id',
        'ar',
        'it',
        'th',
        'vi',
        'hi',
        'bn',
        'tr',
        'sw',
        'am',
        'pl',
      ]);
      expect(body.ui.selfService).toEqual({
        accountPageEnabled: true,
        accountPagePath: '/account',
      });
    });

    it('should expose configured Account Page path in UI config', async () => {
      const settingsKV = createMockKV({
        'settings:tenant:default:self-service': JSON.stringify({
          'self-service.account_page_enabled': true,
          'self-service.account_page_path': '/mypage',
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(body.ui.selfService).toEqual({
        accountPageEnabled: true,
        accountPagePath: '/mypage',
      });
    });

    it('should return default appearance config', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(body.ui.appearance.backgroundImageUrl).toBeNull();
      expect(body.ui.appearance.loginPanelBackgroundImageUrl).toBeNull();
      expect(body.ui.appearance.thumbnailUrl).toBeNull();
      expect(body.ui.appearance.customCss).toBeNull();
      expect(body.ui.appearance.headerText).toBeNull();
      expect(body.ui.appearance.textLocalizations).toEqual({});
      expect(body.ui.appearance.footerText).toBeNull();
      expect(body.ui.appearance.footerLinks).toEqual([]);
      expect(body.ui.appearance.customBlocks).toEqual([]);
    });

    it('should include meta with cacheTTL and revision', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(body.meta.cacheTTL).toBe(60);
      expect(body.meta.revision).toBeDefined();
      // revision should be a valid ISO date string
      expect(new Date(body.meta.revision).toISOString()).toBe(body.meta.revision);
    });

    it('should set no-store Cache-Control header', async () => {
      const { app, mockEnv } = createTestApp();

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);

      expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
      expect(res.headers.get('Server-Timing')).toBeNull();
    });

    it('should reuse edge cache entries while the authentication methods revision is unchanged', async () => {
      const edgeCache = createMockEdgeCache();
      const globalWithCaches = globalThis as unknown as {
        caches: { default: ReturnType<typeof createMockEdgeCache> };
      };
      globalWithCaches.caches = { default: edgeCache };
      const externalIdp = createMockExternalIdp({
        providers: [{ id: 'ggl-123', name: 'Google', slug: 'google', enabled: true }],
      });
      const settingsKV = createMockKV({
        'cache:authentication-methods:v1:revision:tenant:default': 'tenant-rev-1',
      });
      const { app, mockEnv } = createTestApp({ settingsKV, externalIdp });

      const first = await app.request(
        'https://first.test.authrim.com/api/auth/authentication-methods',
        { method: 'GET' },
        mockEnv
      );
      const second = await app.request(
        'https://first.test.authrim.com/api/auth/authentication-methods',
        { method: 'GET' },
        mockEnv
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.headers.get('X-Authrim-Authentication-Methods-Cache')).toBe('miss');
      expect(second.headers.get('X-Authrim-Authentication-Methods-Cache')).toBe('hit');
      expect(second.headers.get('Cache-Control')).toBe('public, max-age=60');
      expect(second.headers.get('Cloudflare-CDN-Cache-Control')).toBe('public, max-age=86400');
      expect(edgeCache.match).toHaveBeenCalledTimes(2);
      expect(edgeCache.put).toHaveBeenCalledTimes(1);
      expect(externalIdp.fetch).toHaveBeenCalledTimes(1);
      await expect(second.json()).resolves.toMatchObject({
        methods: {
          external: {
            enabled: true,
          },
        },
      });
    });

    it('should emit diagnostic timing when diagnostics are enabled and a session header is present', async () => {
      const edgeCache = createMockEdgeCache();
      const globalWithCaches = globalThis as unknown as {
        caches: { default: ReturnType<typeof createMockEdgeCache> };
      };
      globalWithCaches.caches = { default: edgeCache };
      const settingsKV = createMockKV({
        'cache:authentication-methods:v1:revision:tenant:default': 'tenant-rev-1',
      });
      const { app, mockEnv } = createTestApp({ settingsKV });
      mockEnv.AUTHRIM_DIAGNOSTIC_TIMING_ENABLED = 'true';

      const res = await app.request(
        'https://first.test.authrim.com/api/auth/authentication-methods',
        {
          method: 'GET',
          headers: { 'X-Diagnostic-Session-Id': 'diag-session-1' },
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('X-Authrim-Diagnostic-Session-Id')).toBe('diag-session-1');
      expect(res.headers.get('Server-Timing')).toContain('revision_read;dur=');
      expect(res.headers.get('Server-Timing')).toContain('cache_match;dur=');
      expect(res.headers.get('Server-Timing')).toContain('handler_total;dur=');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Authentication methods diagnostics',
        expect.objectContaining({
          diagnosticSessionId: 'diag-session-1',
          cacheStatus: 'miss',
          edgeCacheEnabled: true,
          clientScoped: false,
        })
      );
    });

    it('should isolate edge cache entries by client_id', async () => {
      const edgeCache = createMockEdgeCache();
      const globalWithCaches = globalThis as unknown as {
        caches: { default: ReturnType<typeof createMockEdgeCache> };
      };
      globalWithCaches.caches = { default: edgeCache };
      let providerCounter = 0;
      const externalIdp = {
        fetch: vi.fn(async () => {
          providerCounter += 1;
          return new Response(
            JSON.stringify({
              providers: [
                {
                  id: `provider-${providerCounter}`,
                  name: `Provider ${providerCounter}`,
                  slug: `provider-${providerCounter}`,
                  enabled: true,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }),
      };
      const settingsKV = createMockKV({
        'cache:authentication-methods:v1:revision:tenant:default': 'tenant-rev-1',
      });
      const { app, mockEnv } = createTestApp({ settingsKV, externalIdp });

      const firstClient = await app.request(
        'https://first.test.authrim.com/api/auth/authentication-methods?client_id=client-a',
        { method: 'GET' },
        mockEnv
      );
      const secondClient = await app.request(
        'https://first.test.authrim.com/api/auth/authentication-methods?client_id=client-b',
        { method: 'GET' },
        mockEnv
      );
      const firstClientAgain = await app.request(
        'https://first.test.authrim.com/api/auth/authentication-methods?client_id=client-a',
        { method: 'GET' },
        mockEnv
      );

      expect(firstClient.headers.get('X-Authrim-Authentication-Methods-Cache')).toBe('miss');
      expect(secondClient.headers.get('X-Authrim-Authentication-Methods-Cache')).toBe('miss');
      expect(firstClientAgain.headers.get('X-Authrim-Authentication-Methods-Cache')).toBe('hit');
      expect(externalIdp.fetch).toHaveBeenCalledTimes(2);
      await expect(firstClientAgain.json()).resolves.toMatchObject({
        methods: {
          external: {
            providers: [expect.objectContaining({ id: 'provider-1' })],
          },
        },
      });
    });

    it('should miss the edge cache after the authentication methods revision changes', async () => {
      const edgeCache = createMockEdgeCache();
      const globalWithCaches = globalThis as unknown as {
        caches: { default: ReturnType<typeof createMockEdgeCache> };
      };
      globalWithCaches.caches = { default: edgeCache };
      let providerCounter = 0;
      const externalIdp = {
        fetch: vi.fn(async () => {
          providerCounter += 1;
          return new Response(
            JSON.stringify({
              providers: [
                {
                  id: `provider-${providerCounter}`,
                  name: `Provider ${providerCounter}`,
                  slug: `provider-${providerCounter}`,
                  enabled: true,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }),
      };
      const settingsKV = createMockKV({
        'cache:authentication-methods:v1:revision:tenant:default': 'tenant-rev-1',
      });
      const { app, mockEnv } = createTestApp({ settingsKV, externalIdp });

      const beforeRevisionChange = await app.request(
        'https://first.test.authrim.com/api/auth/authentication-methods',
        { method: 'GET' },
        mockEnv
      );
      await settingsKV.put(
        'cache:authentication-methods:v1:revision:tenant:default',
        'tenant-rev-2'
      );
      const afterRevisionChange = await app.request(
        'https://first.test.authrim.com/api/auth/authentication-methods',
        { method: 'GET' },
        mockEnv
      );
      const afterRevisionChangeAgain = await app.request(
        'https://first.test.authrim.com/api/auth/authentication-methods',
        { method: 'GET' },
        mockEnv
      );

      expect(beforeRevisionChange.headers.get('X-Authrim-Authentication-Methods-Cache')).toBe(
        'miss'
      );
      expect(afterRevisionChange.headers.get('X-Authrim-Authentication-Methods-Cache')).toBe(
        'miss'
      );
      const afterRevisionChangeAgainCacheStatus = afterRevisionChangeAgain.headers.get(
        'X-Authrim-Authentication-Methods-Cache'
      );
      expect(afterRevisionChangeAgainCacheStatus).toBe('hit');
      expect(externalIdp.fetch).toHaveBeenCalledTimes(2);
      await expect(afterRevisionChangeAgain.json()).resolves.toMatchObject({
        methods: {
          external: {
            providers: [expect.objectContaining({ id: 'provider-2' })],
          },
        },
      });
    });
  });

  // ===========================================================================
  // Method enable/disable via system settings
  // ===========================================================================

  describe('method toggling via SETTINGS KV', () => {
    it('should disable passkey when advanced.passkeyEnabled is false', async () => {
      const settingsKV = createMockKV({
        system_settings: JSON.stringify({
          advanced: { passkeyEnabled: false, magicLinkEnabled: true },
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(body.methods.passkey.enabled).toBe(false);
      expect(body.methods.passkey.capabilities).toEqual([]);
      expect(body.methods.emailCode.enabled).toBe(true);
    });

    it('should disable emailCode when advanced.magicLinkEnabled is false', async () => {
      const settingsKV = createMockKV({
        system_settings: JSON.stringify({
          advanced: { passkeyEnabled: true, magicLinkEnabled: false },
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(body.methods.passkey.enabled).toBe(true);
      expect(body.methods.emailCode.enabled).toBe(false);
      expect(body.methods.emailCode.steps).toEqual([]);
    });

    it('should expose per-usage built-in method switches from authentication-methods settings', async () => {
      const settingsKV = createMockKV({
        'settings:tenant:default:authentication-methods': JSON.stringify({
          'authentication-methods.passkey.login_enabled': true,
          'authentication-methods.passkey.signup_enabled': true,
          'authentication-methods.passkey.reauth_enabled': true,
          'authentication-methods.passkey.account_link_enabled': true,
          'authentication-methods.email_otp.login_enabled': false,
          'authentication-methods.email_otp.signup_enabled': false,
          'authentication-methods.email_otp.reauth_enabled': true,
          'authentication-methods.email_otp.account_link_enabled': true,
          'authentication-methods.totp.login_enabled': true,
          'authentication-methods.totp.signup_enabled': false,
          'authentication-methods.totp.reauth_enabled': true,
          'authentication-methods.totp.account_link_enabled': true,
          'authentication-methods.totp.preset': 'strong',
          'authentication-methods.totp.default_acr': 'urn:authrim:aal:3',
          'authentication-methods.totp.requirement_policy': JSON.stringify({ mode: 'required' }),
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.methods.emailCode).toMatchObject({
        enabled: true,
        loginEnabled: false,
        signupEnabled: false,
        reauthEnabled: true,
        accountLinkEnabled: true,
      });
      expect(body.methods.totp).toMatchObject({
        enabled: true,
        loginEnabled: true,
        signupEnabled: false,
        reauthEnabled: true,
        accountLinkEnabled: true,
        preset: 'strong',
        algorithm: 'SHA256',
        digits: 8,
        period: 30,
        window: 1,
        defaultAcr: 'urn:authrim:aal:3',
        requirement: { mode: 'required' },
        steps: ['identifier', 'code'],
      });
    });

    it('should enable directory password from directory connector settings without exposing connector secrets', async () => {
      const settingsKV = createMockKV({
        system_settings: JSON.stringify({
          advanced: { passkeyEnabled: false, magicLinkEnabled: false },
        }),
        'settings:tenant:default:directory-connectors': JSON.stringify({
          enabled: true,
          default_connector_id: 'campus',
          auto_provision: false,
          connectors: [
            {
              id: 'campus',
              endpoint_url: 'https://wordwarden.example.com',
              auth_mode: 'hmac',
              connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
              key_id: 'kid-active',
              secret_ref: 'env:WORDWARDEN_SECRET',
              timeouts: { request_ms: 2500 },
              attribute_names: ['mail'],
            },
          ],
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV, externalIdp: null });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.methods.passkey.enabled).toBe(false);
      expect(body.methods.emailCode.enabled).toBe(false);
      expect(body.methods.directoryPassword).toEqual({
        enabled: true,
        label: 'Organization ID',
        steps: ['username', 'password'],
      });
      expect(JSON.stringify(body)).not.toContain('secret');
      expect(JSON.stringify(body)).not.toContain('endpoint');
      expect(JSON.stringify(body)).not.toContain('connector_id');
    });

    it('should enable directory password from outbound relay directory connector settings', async () => {
      const settingsKV = createMockKV({
        system_settings: JSON.stringify({
          advanced: { passkeyEnabled: false, magicLinkEnabled: false },
        }),
        'settings:tenant:default:directory-connectors': JSON.stringify({
          enabled: true,
          default_connector_id: 'campus',
          auto_provision: false,
          connectors: [
            {
              id: 'campus',
              transport: 'relay',
              endpoint_url: '',
              auth_mode: 'hmac',
              connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
              key_id: 'kid-active',
              secret_ref: 'env:WORDWARDEN_SECRET',
              timeouts: { request_ms: 2500 },
              attribute_names: ['mail'],
            },
          ],
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV, externalIdp: null });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.methods.passkey.enabled).toBe(false);
      expect(body.methods.emailCode.enabled).toBe(false);
      expect(body.methods.directoryPassword).toEqual({
        enabled: true,
        label: 'Organization ID',
        steps: ['username', 'password'],
      });
      expect(JSON.stringify(body)).not.toContain('secret');
      expect(JSON.stringify(body)).not.toContain('endpoint');
      expect(JSON.stringify(body)).not.toContain('connector_id');
    });

    it('should not enable directory password from legacy authentication-methods keys', async () => {
      const settingsKV = createMockKV({
        'settings:tenant:default:authentication-methods': JSON.stringify({
          'authentication-methods.directory_password.enabled': true,
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV, externalIdp: null });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.methods.directoryPassword).toEqual({
        enabled: false,
        label: 'Organization ID',
        steps: [],
      });
    });

    it('should not expose directory password when the configured connector is incomplete', async () => {
      const settingsKV = createMockKV({
        'settings:tenant:default:directory-connectors': JSON.stringify({
          enabled: true,
          default_connector_id: 'campus',
          auto_provision: false,
          connectors: [{ id: 'campus' }],
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV, externalIdp: null });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.methods.directoryPassword).toEqual({
        enabled: false,
        label: 'Organization ID',
        steps: [],
      });
    });

    it('should expose Turnstile site key but never the secret key', async () => {
      const settingsKV = createMockKV({
        'settings:tenant:default:authentication-methods': JSON.stringify({
          'authentication-methods.human_verification.provider':
            'human-verification-cloudflare-turnstile',
          'authentication-methods.human_verification.login_enabled': true,
        }),
        'plugins:enabled:human-verification-cloudflare-turnstile:tenant:default': 'true',
        'plugins:config:human-verification-cloudflare-turnstile:tenant:default': JSON.stringify({
          siteKey: '0x4AAAAAA_site_key',
          secretKey: '0x4AAAAAA_secret_key',
          failurePolicy: 'fail_closed',
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.methods.humanVerification).toMatchObject({
        enabled: true,
        provider: 'turnstile',
        siteKey: '0x4AAAAAA_site_key',
        loginEnabled: true,
        signupEnabled: false,
        reauthEnabled: false,
        failurePolicy: 'fail_closed',
      });
      expect(JSON.stringify(body)).not.toContain('0x4AAAAAA_secret_key');
    });

    it('should expose selected reCAPTCHA provider metadata without the secret key', async () => {
      const settingsKV = createMockKV({
        'settings:tenant:default:authentication-methods': JSON.stringify({
          'authentication-methods.human_verification.provider':
            'human-verification-google-recaptcha',
          'authentication-methods.human_verification.login_enabled': true,
        }),
        'plugins:enabled:human-verification-google-recaptcha:tenant:default': 'true',
        'plugins:config:human-verification-google-recaptcha:tenant:default': JSON.stringify({
          siteKey: 'recaptcha-site-key',
          secretKey: 'recaptcha-secret-key',
          widgetMode: 'score',
          scoreThreshold: 0.7,
          failurePolicy: 'fail_open',
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.methods.humanVerification).toMatchObject({
        enabled: true,
        provider: 'recaptcha',
        siteKey: 'recaptcha-site-key',
        loginEnabled: true,
        failurePolicy: 'fail_closed',
        widget: {
          mode: 'score',
        },
      });
      expect(JSON.stringify(body)).not.toContain('recaptcha-secret-key');
      expect(JSON.stringify(body)).not.toContain('scoreThreshold');
    });

    it('should expose selected hCaptcha provider metadata without the secret key', async () => {
      const settingsKV = createMockKV({
        'settings:tenant:default:authentication-methods': JSON.stringify({
          'authentication-methods.human_verification.provider': 'human-verification-hcaptcha',
          'authentication-methods.human_verification.signup_enabled': true,
        }),
        'plugins:enabled:human-verification-hcaptcha:tenant:default': 'true',
        'plugins:config:human-verification-hcaptcha:tenant:default': JSON.stringify({
          siteKey: 'hcaptcha-site-key',
          secretKey: 'hcaptcha-secret-key',
          widgetMode: 'invisible',
          failurePolicy: 'fail_closed',
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.methods.humanVerification).toMatchObject({
        enabled: true,
        provider: 'hcaptcha',
        siteKey: 'hcaptcha-site-key',
        loginEnabled: false,
        signupEnabled: true,
        failurePolicy: 'fail_closed',
        widget: {
          mode: 'invisible',
        },
      });
      expect(JSON.stringify(body)).not.toContain('hcaptcha-secret-key');
    });

    it('should not expose hCaptcha as configured when the encrypted secret cannot be decrypted', async () => {
      const encryptionKey = await deriveEncryptionKey('a'.repeat(32));
      const encryptedConfig = await encryptSecretFields(
        {
          siteKey: 'hcaptcha-site-key',
          secretKey: 'hcaptcha-secret-key',
        },
        ['secretKey'],
        encryptionKey
      );
      const settingsKV = createMockKV({
        'settings:tenant:default:authentication-methods': JSON.stringify({
          'authentication-methods.human_verification.provider': 'human-verification-hcaptcha',
          'authentication-methods.human_verification.signup_enabled': true,
        }),
        'plugins:enabled:human-verification-hcaptcha:tenant:default': 'true',
        'plugins:config:human-verification-hcaptcha:tenant:default':
          JSON.stringify(encryptedConfig),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.methods.humanVerification).toMatchObject({
        enabled: true,
        provider: 'hcaptcha',
        siteKey: null,
        signupEnabled: true,
      });
      expect(JSON.stringify(body)).not.toContain('hcaptcha-secret-key');
      expect(JSON.stringify(body)).not.toContain('enc:v1');
    });
  });

  // ===========================================================================
  // External login providers
  // ===========================================================================

  describe('external login providers via EXTERNAL_IDP', () => {
    it('should return external login providers when EXTERNAL_IDP is available', async () => {
      const externalIdp = createMockExternalIdp({
        providers: [
          {
            id: 'ggl-123',
            name: 'Google',
            slug: 'google',
            providerType: 'oidc',
            enabled: true,
            iconName: 'globe',
          },
          { id: 'ghb-456', name: 'GitHub', slug: 'github', providerType: 'oauth2', enabled: true },
        ],
      });
      const { app, mockEnv } = createTestApp({ externalIdp });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(body.methods.external.enabled).toBe(true);
      expect(body.methods.external.providers).toHaveLength(2);
      expect(body.methods.external.providers[0]).toMatchObject({
        id: 'google',
        name: 'Google',
        type: 'oidc',
        startMode: 'oauth_redirect',
        startUrl: '/api/external/google/start',
        iconName: 'globe',
      });
      expect(body.methods.external.providers[1]).toMatchObject({
        id: 'github',
        type: 'oauth2',
        startMode: 'oauth_redirect',
      });
    });

    it('should include enabled SAML IdP providers as external login providers', async () => {
      mockResolveAuthCorePersistenceAdapterFromEnv.mockResolvedValue({
        query: vi.fn(async () => [
          {
            id: 'saml-idp-1',
            name: 'Campus SAML',
            config_json: JSON.stringify({
              logoUrl: 'https://campus.example/logo.png',
              iconName: 'graduation-cap',
            }),
          },
        ]),
      });
      const { app, mockEnv } = createTestApp();

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(body.methods.external.enabled).toBe(true);
      expect(body.methods.external.providers).toContainEqual(
        expect.objectContaining({
          id: 'saml:saml-idp-1',
          name: 'Campus SAML',
          type: 'saml',
          startMode: 'saml_sp',
          iconUrl: 'https://campus.example/logo.png',
          iconName: 'graduation-cap',
          startUrl: '/saml/sp/login?idp=saml-idp-1',
        })
      );
    });

    it('should normalize legacy URL providers to managed OAuth redirect mode', async () => {
      const settingsKV = createMockKV({
        'settings:tenant:default:authentication-methods': JSON.stringify({
          'authentication-methods.external_providers': [
            {
              id: 'wallet-vp',
              name: 'Wallet Presentation',
              type: 'vc',
              startMode: 'url',
              startUrl: '/vp/login',
              iconName: 'none',
              enabled: true,
            },
          ],
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(body.methods.external.enabled).toBe(true);
      expect(body.methods.external.providers).toContainEqual(
        expect.objectContaining({
          id: 'wallet-vp',
          name: 'Wallet Presentation',
          type: 'vc',
          startMode: 'oauth_redirect',
          startUrl: '/vp/login',
          iconName: 'none',
        })
      );
    });

    it('should keep managed external providers available for human-verification protected usages', async () => {
      const settingsKV = createMockKV({
        'settings:tenant:default:authentication-methods': JSON.stringify({
          'authentication-methods.human_verification.provider':
            'human-verification-cloudflare-turnstile',
          'authentication-methods.human_verification.login_enabled': true,
          'authentication-methods.human_verification.signup_enabled': true,
          'authentication-methods.human_verification.reauth_enabled': true,
          'authentication-methods.external_providers': [
            {
              id: 'wallet-vp',
              name: 'Wallet Presentation',
              type: 'vc',
              startMode: 'url',
              startUrl: '/vp/login',
              enabled: true,
            },
          ],
        }),
        'plugins:enabled:human-verification-cloudflare-turnstile:tenant:default': 'true',
        'plugins:config:human-verification-cloudflare-turnstile:tenant:default': JSON.stringify({
          siteKey: '0x4AAAAAA_site_key',
          secretKey: '0x4AAAAAA_secret_key',
          failurePolicy: 'fail_closed',
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.methods.humanVerification.enabled).toBe(true);
      expect(body.methods.external.providers).toContainEqual(
        expect.objectContaining({
          id: 'wallet-vp',
          startMode: 'oauth_redirect',
        })
      );
    });

    it('should filter out disabled providers', async () => {
      const externalIdp = createMockExternalIdp({
        providers: [
          { id: 'ggl-123', name: 'Google', slug: 'google', enabled: true },
          { id: 'msft-789', name: 'Microsoft', slug: 'microsoft', enabled: false },
        ],
      });
      const { app, mockEnv } = createTestApp({ externalIdp });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(body.methods.external.providers).toHaveLength(1);
      expect(body.methods.external.providers[0].name).toBe('Google');
    });

    it('should return external login disabled when EXTERNAL_IDP fetch fails', async () => {
      const externalIdp = createMockExternalIdp({ shouldFail: true });
      const { app, mockEnv } = createTestApp({ externalIdp });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(body.methods.external.enabled).toBe(false);
      expect(body.methods.external.providers).toEqual([]);
    });

    it('should call EXTERNAL_IDP with tenant and forwarded request host', async () => {
      const externalIdp = createMockExternalIdp({
        providers: [{ id: 'ggl-123', name: 'Google', slug: 'google', enabled: true }],
      });
      const { app, mockEnv } = createTestApp({ externalIdp });

      await app.request(
        'https://first.test.authrim.com/api/auth/authentication-methods',
        { method: 'GET' },
        mockEnv
      );

      expect(externalIdp.fetch).toHaveBeenCalledWith(
        'https://external-idp/api/external/providers',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Accept: 'application/json',
            'X-Tenant-Id': 'default',
            'X-Authrim-Forwarded-Host': 'first.test.authrim.com',
            'X-Forwarded-Host': 'first.test.authrim.com',
            'X-Forwarded-Proto': 'https',
          }),
        })
      );
    });

    it('should use the public external-provider discovery surface', async () => {
      const externalIdp = createMockExternalIdp({
        providers: [{ id: 'ggl-123', name: 'Google', slug: 'google', enabled: true }],
      });
      const { app, mockEnv } = createTestApp({ externalIdp });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(body.methods.external.enabled).toBe(true);
      expect(body.methods.external.providers).toHaveLength(1);
    });

    it('should skip bridge provider discovery when external provider usage is explicitly empty', async () => {
      const externalIdp = createMockExternalIdp({
        providers: [{ id: 'ggl-123', name: 'Google', slug: 'google', enabled: true }],
      });
      const settingsKV = createMockKV({
        'settings:tenant:default:authentication-methods': JSON.stringify({
          'authentication-methods.external_provider_usage': [],
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV, externalIdp });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(externalIdp.fetch).not.toHaveBeenCalled();
      expect(body.methods.external.enabled).toBe(false);
      expect(body.methods.external.providers).toEqual([]);
    });
  });

  // ===========================================================================
  // All methods disabled → 503
  // ===========================================================================

  describe('no methods available', () => {
    it('should return 503 when all methods are disabled', async () => {
      const settingsKV = createMockKV({
        system_settings: JSON.stringify({
          advanced: { passkeyEnabled: false, magicLinkEnabled: false },
        }),
      });
      // No EXTERNAL_IDP → no external login
      const { app, mockEnv } = createTestApp({ settingsKV, externalIdp: null });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);

      expect(res.status).toBe(503);
      const body = (await res.json()) as any;

      expect(body.error.code).toBe('NO_AUTHENTICATION_METHOD_AVAILABLE');
      expect(body.error.message).toBeDefined();
    });

    it('should log a warning when no methods are available', async () => {
      const settingsKV = createMockKV({
        system_settings: JSON.stringify({
          advanced: { passkeyEnabled: false, magicLinkEnabled: false },
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);

      expect(mockLogger.warn).toHaveBeenCalledWith('No authentication method available', {});
    });
  });

  // ===========================================================================
  // UI config from settings-v2 (AUTHRIM_CONFIG KV)
  // ===========================================================================

  describe('UI config from settings-v2', () => {
    it('expands the legacy default locale set to include newly supported locales', async () => {
      const settingsKV = createMockKV({
        'settings:platform:login-ui': JSON.stringify({
          'login-ui.supported_locales': 'en,ja,zh-CN,zh-TW,es,pt,fr,de,ko,ru,id',
          'login-ui.default_locale': 'en',
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.ui.supportedLocales).toEqual([
        'am',
        'ar',
        'bn',
        'zh-CN',
        'zh-TW',
        'en',
        'fr',
        'de',
        'hi',
        'id',
        'it',
        'ja',
        'ko',
        'pl',
        'pt',
        'ru',
        'es',
        'sw',
        'th',
        'tr',
        'vi',
      ]);
      expect(body.ui.defaultLocale).toBe('en');
      expect(body.ui.primaryLocales).toEqual(['en', 'zh-CN', 'hi', 'es', 'ar', 'fr']);
      expect(body.ui.showEnglishLanguageNames).toBe(false);
    });

    it('inherits platform language settings when tenant settings are absent', async () => {
      const settingsKV = createMockKV({
        'settings:platform:login-ui': JSON.stringify({
          'login-ui.supported_locales': 'en,de',
          'login-ui.default_locale': 'de',
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.ui.supportedLocales).toEqual(['en', 'de']);
      expect(body.ui.defaultLocale).toBe('de');
      expect(body.ui.primaryLocales).toEqual([]);
    });

    it('preserves manually configured primary languages instead of recalculating them', async () => {
      const settingsKV = createMockKV({
        'settings:platform:login-ui': JSON.stringify({
          'login-ui.primary_locales': ['pl', 'ja'],
          'login-ui.show_english_language_names': true,
        }),
        'settings:tenant:default:login-ui': JSON.stringify({
          'login-ui.brand_name': 'Tenant Brand',
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.ui.primaryLocales).toEqual(['ja', 'pl']);
      expect(body.ui.showEnglishLanguageNames).toBe(true);
    });

    it('preserves an explicit zero-primary-language selection', async () => {
      const settingsKV = createMockKV({
        'settings:platform:login-ui': JSON.stringify({
          'login-ui.primary_locales': [],
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.ui.primaryLocales).toEqual([]);
    });

    it('does not expose disabled configured languages as primary languages', async () => {
      const settingsKV = createMockKV({
        'settings:platform:login-ui': JSON.stringify({
          'login-ui.supported_locales': 'en,ja,zh-CN,zh-TW,es,pt,fr,de,ko,ru,ar',
          'login-ui.primary_locales': ['pl', 'en'],
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.ui.primaryLocales).toEqual(['en']);
    });

    it('applies client Login UI overrides for DCR-generated client identifiers', async () => {
      const clientId = `client_${'a'.repeat(128)}`;
      const settingsKV = createMockKV({
        'settings:tenant:default:login-ui': JSON.stringify({
          'login-ui.brand_name': 'Tenant App',
        }),
        [`settings:client:default:${clientId}:login-ui`]: JSON.stringify({
          'login-ui.brand_name': 'DCR Client App',
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request(
        `/api/auth/authentication-methods?client_id=${encodeURIComponent(clientId)}`,
        { method: 'GET' },
        mockEnv
      );
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.ui.branding.brandName).toBe('DCR Client App');
    });

    it('should use settings-v2 KV values when available', async () => {
      const settingsKV = createMockKV({
        'settings:tenant:default:login-ui': JSON.stringify({
          'login-ui.theme': 'dark',
          'login-ui.variant': 'navy',
          'login-ui.theme_template': 'fullbleed-glass',
          'login-ui.page_layout': 'fullbleed_card',
          'login-ui.font_family': 'mono',
          'login-ui.font_scale': 'spacious',
          'login-ui.background_color': '#0b1220',
          'login-ui.accent_color': '#336699',
          'login-ui.title_color': '#111827',
          'login-ui.text_color': '#1f2937',
          'login-ui.copy_color': '#4b5563',
          'login-ui.logo_layout': 'row',
          'login-ui.logo_display': 'image',
          'login-ui.brand_panel_title': 'Secure access',
          'login-ui.brand_panel_text': 'Use your organization account.',
          'login-ui.header_enabled': false,
          'login-ui.subtitle_enabled': false,
          'login-ui.footer_enabled': false,
          'login-ui.powered_by_enabled': false,
          'login-ui.auth_switch_link_enabled': false,
          'login-ui.topbar_position': 'bottom_right',
          'login-ui.theme_toggle_enabled': false,
          'login-ui.language_select_enabled': true,
          'login-ui.language_switcher_position': 'top_right',
          'login-ui.header_style': 'bar',
          'login-ui.footer_style': 'bar',
          'login-ui.split_frame': 'card',
          'login-ui.split_panel_side': 'right',
          'login-ui.split_panel_width': 'narrow',
          'login-ui.split_background_mode': 'panel',
          'login-ui.login_panel_background_color': '#223344',
          'login-ui.login_panel_background_gradient_color': '#445566',
          'login-ui.login_panel_background_opacity': 42,
          'login-ui.brand_content_mode': 'logo',
          'login-ui.brand_position': 'bottom',
          'login-ui.brand_align': 'center',
          'login-ui.brand_name': 'My App',
          'login-ui.logo_url': 'https://example.com/logo.png',
          'login-ui.favicon_url': 'https://example.com/favicon.ico',
          'login-ui.thumbnail_url': 'https://example.com/thumb.webp',
          'login-ui.supported_locales': 'en,ja,fr',
          'login-ui.default_locale': 'fr',
          'login-ui.background_image_url': 'https://example.com/bg.jpg',
          'login-ui.login_panel_background_image_url': 'https://example.com/panel.jpg',
          'login-ui.custom_css': '.auth-page { background: #fff; }',
          'login-ui.header_text': 'Welcome',
          'login-ui.text_localizations': JSON.stringify({
            en: {
              tagline: '  Identity at every edge  ',
              loginTitle: '  Sign in to Example  ',
              registrationTitle: 'Create an Example account',
              accountTitle: 'Your Example account',
              brandPanelTitle: 'Welcome back',
              brandPanelText: '   ',
              unsupportedField: 'Ignored',
            },
            ja: { tagline: 'あらゆる場所のアイデンティティ', footerText: 'Authrim提供' },
            fr: { tagline: '   ' },
            unsupported: { tagline: 'Ignored' },
          }),
          'login-ui.footer_text': '© 2025 My App',
          'login-ui.footer_links': JSON.stringify([
            { label: 'Privacy', url: 'https://example.com/privacy' },
          ]),
          'login-ui.custom_blocks': JSON.stringify([
            { position: 'above-form', type: 'text', content: 'Hello' },
          ]),
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(body.ui.theme).toBe('dark');
      expect(body.ui.variant).toBe('navy');
      expect(body.ui.branding.brandName).toBe('My App');
      expect(body.ui.branding.logoUrl).toBe('https://example.com/logo.png');
      expect(body.ui.branding.faviconUrl).toBe('https://example.com/favicon.ico');
      expect(body.ui.themeTemplate).toBe('fullbleed-glass');
      expect(body.ui.pageTemplate).toMatchObject({
        layout: 'fullbleed_card',
        fontFamily: 'mono',
        fontScale: 'spacious',
        backgroundColor: '#0b1220',
        accentColor: '#336699',
        titleColor: '#111827',
        textColor: '#1f2937',
        copyColor: '#4b5563',
        logoLayout: 'row',
        logoDisplay: 'image',
        brandPanelTitle: 'Secure access',
        brandPanelText: 'Use your organization account.',
        headerEnabled: false,
        subtitleEnabled: false,
        footerEnabled: false,
        poweredByEnabled: false,
        authSwitchLinkEnabled: false,
        topbarPosition: 'bottom_right',
        themeToggleEnabled: false,
        languageSelectEnabled: true,
        languageSwitcherPosition: 'top_right',
        headerStyle: 'bar',
        footerStyle: 'bar',
        splitFrame: 'card',
        splitPanelSide: 'right',
        splitPanelWidth: 'narrow',
        splitBackgroundMode: 'panel',
        loginPanelBackgroundColor: '#223344',
        loginPanelBackgroundGradientColor: '#445566',
        loginPanelBackgroundOpacity: 42,
        brandContentMode: 'logo',
        brandPosition: 'bottom',
        brandAlign: 'center',
      });
      expect(body.ui.supportedLocales).toEqual(['en', 'ja', 'fr']);
      expect(body.ui.defaultLocale).toBe('fr');
      expect(body.ui.appearance.backgroundImageUrl).toBe('https://example.com/bg.jpg');
      expect(body.ui.appearance.loginPanelBackgroundImageUrl).toBe('https://example.com/panel.jpg');
      expect(body.ui.appearance.thumbnailUrl).toBe('https://example.com/thumb.webp');
      expect(body.ui.appearance.customCss).toBe('.auth-page { background: #fff; }');
      expect(body.ui.appearance.headerText).toBe('Welcome');
      expect(body.ui.appearance.textLocalizations).toEqual({
        en: {
          tagline: 'Identity at every edge',
          loginTitle: 'Sign in to Example',
          registrationTitle: 'Create an Example account',
          accountTitle: 'Your Example account',
          brandPanelTitle: 'Welcome back',
          brandPanelText: '',
        },
        ja: { tagline: 'あらゆる場所のアイデンティティ', footerText: 'Authrim提供' },
        fr: { tagline: '' },
      });
      expect(body.ui.appearance.footerText).toBe('© 2025 My App');
      expect(body.ui.appearance.footerLinks).toEqual([
        { label: 'Privacy', url: 'https://example.com/privacy' },
      ]);
      expect(body.ui.appearance.customBlocks).toEqual([
        { position: 'above-form', type: 'text', content: 'Hello' },
      ]);
    });

    it('should fall back to legacy system_settings.loginUI', async () => {
      const settingsKV = createMockKV({
        system_settings: JSON.stringify({
          general: { siteName: 'Legacy App', logoUrl: 'https://legacy.com/logo.png' },
          loginUI: { theme: 'dark', variant: 'slate', supportedLocales: ['en'] },
        }),
      });
      // Empty configKV → no settings-v2
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(body.ui.theme).toBe('dark');
      expect(body.ui.variant).toBe('slate');
      expect(body.ui.branding.brandName).toBe('Legacy App');
      expect(body.ui.branding.logoUrl).toBe('https://legacy.com/logo.png');
      expect(body.ui.branding.faviconUrl).toBeNull();
      expect(body.ui.supportedLocales).toEqual(['en']);
      // Legacy fallback returns default appearance values
      expect(body.ui.appearance.backgroundImageUrl).toBeNull();
      expect(body.ui.appearance.customCss).toBeNull();
      expect(body.ui.appearance.headerText).toBeNull();
      expect(body.ui.appearance.footerText).toBeNull();
      expect(body.ui.appearance.footerLinks).toEqual([]);
      expect(body.ui.appearance.customBlocks).toEqual([]);
    });

    it('should prioritize settings-v2 over legacy settings', async () => {
      const settingsKV = createMockKV({
        system_settings: JSON.stringify({
          general: { siteName: 'Legacy App' },
          loginUI: { theme: 'light', variant: 'beige' },
        }),
        'settings:tenant:default:login-ui': JSON.stringify({
          'login-ui.theme': 'dark',
          'login-ui.variant': 'navy',
          'login-ui.brand_name': 'Settings V2 App',
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);
      const body = (await res.json()) as any;

      expect(body.ui.theme).toBe('dark');
      expect(body.ui.variant).toBe('navy');
      expect(body.ui.branding.brandName).toBe('Settings V2 App');
    });
  });

  // ===========================================================================
  // Error handling
  // ===========================================================================

  describe('error handling', () => {
    it('should gracefully handle KV read failure and return defaults', async () => {
      // getSystemSettings catches KV errors internally and returns {}
      // This results in default settings (passkey-only built-in methods)
      const settingsKV = {
        get: vi.fn(async () => {
          throw new Error('KV read failed');
        }),
      } as unknown as KVNamespace;
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);

      // Handler is resilient — KV failure falls back to defaults
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.methods.passkey.enabled).toBe(true);
      expect(body.methods.emailCode.enabled).toBe(false);
    });

    it('should handle invalid JSON in system_settings gracefully', async () => {
      const settingsKV = createMockKV({
        system_settings: '{invalid json}',
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);

      // Should not crash — falls back to empty settings → defaults
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.methods.passkey.enabled).toBe(true);
      expect(body.methods.emailCode.enabled).toBe(false);
    });

    it('should handle invalid JSON in settings-v2 gracefully', async () => {
      const settingsKV = createMockKV({
        'settings:tenant:default:login-ui': '{bad json}',
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);

      // Should fall through to legacy → defaults
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.ui.theme).toBe('light');
      expect(body.ui.variant).toBe('beige');
      expect(body.ui.appearance.footerLinks).toEqual([]);
      expect(body.ui.appearance.customBlocks).toEqual([]);
    });

    it('should handle invalid JSON in footer_links and custom_blocks gracefully', async () => {
      const settingsKV = createMockKV({
        'settings:tenant:default:login-ui': JSON.stringify({
          'login-ui.theme': 'dark',
          'login-ui.footer_links': '{not an array}',
          'login-ui.custom_blocks': 'invalid',
        }),
      });
      const { app, mockEnv } = createTestApp({ settingsKV });

      const res = await app.request('/api/auth/authentication-methods', { method: 'GET' }, mockEnv);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.ui.theme).toBe('dark');
      expect(body.ui.appearance.footerLinks).toEqual([]);
      expect(body.ui.appearance.customBlocks).toEqual([]);
    });
  });
});
