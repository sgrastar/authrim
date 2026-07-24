import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockSessionStore,
  mockGetSessionStoreBySessionId,
  mockGetTenantIdFromContext,
  mockCoreAdapter,
} = vi.hoisted(() => {
  const sessionStore = {
    getSessionRpc: vi.fn(),
  };
  return {
    mockSessionStore: sessionStore,
    mockGetSessionStoreBySessionId: vi.fn().mockReturnValue({ stub: sessionStore }),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    mockCoreAdapter: {
      queryOne: vi.fn().mockResolvedValue(null),
      query: vi.fn().mockResolvedValue([]),
      execute: vi.fn().mockResolvedValue({ changes: 1 }),
    },
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: mockGetSessionStoreBySessionId,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mockCoreAdapter })),
    isShardedSessionId: vi.fn((sessionId: string) => sessionId.startsWith('g1:')),
    getLogger: () => ({
      module: () => ({
        error: vi.fn(),
      }),
    }),
  };
});

import { getAccountCapabilitiesHandler } from '../account-capabilities';

function createMockContext(cookie?: string, env: Partial<Env> = {}) {
  const headers = new Headers();
  const request = new Request('https://op.example.com/api/account/capabilities', {
    headers: cookie ? { Cookie: cookie } : {},
  });
  return {
    env: env as Env,
    req: {
      method: 'GET',
      url: request.url,
      raw: request,
      header: (name: string) => request.headers.get(name) ?? undefined,
    },
    header: (name: string, value: string) => {
      headers.set(name, value);
    },
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...Object.fromEntries(headers.entries()),
        },
      }),
  } as any;
}

describe('Account Page capabilities API', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-23T00:00:00Z'));
    vi.clearAllMocks();
    mockSessionStore.getSessionRpc.mockResolvedValue({
      id: 'g1:apac:3:session_current',
      tenantId: 'default',
      userId: 'user-001',
      createdAt: 1_777_000_000_000,
      expiresAt: Date.now() + 60_000,
      data: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requires an Account Page cookie session', async () => {
    const response = await getAccountCapabilitiesHandler(createMockContext());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body.error).toBe('unauthorized');
    expect(mockGetSessionStoreBySessionId).not.toHaveBeenCalled();
  });

  it('returns available and planned capabilities without enabling Phase 4E high-risk features', async () => {
    const response = await getAccountCapabilitiesHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_current')
    );
    const body = (await response.json()) as {
      capabilities: Array<Record<string, unknown>>;
      sections: Array<Record<string, unknown>>;
      theme: Record<string, unknown>;
      account_page: {
        definition: { schema_version: string; screens: Array<Record<string, unknown>> };
        screens: Array<Record<string, unknown>>;
        version: number;
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'profile.name', status: 'available' }),
        expect.objectContaining({ id: 'passkeys.manage', status: 'available' }),
        expect.objectContaining({
          id: 'email.change',
          status: 'planned',
          requires_reauth: true,
          planned_phase: '4E-1',
        }),
        expect.objectContaining({
          id: 'account.deletion',
          status: 'planned',
          requires_reauth: true,
          planned_phase: '4E-2',
        }),
      ])
    );
    expect(body.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'profile', status: 'available' }),
        expect.objectContaining({ id: 'danger', status: 'planned' }),
      ])
    );
    expect(body.theme).toMatchObject({
      version: 1,
      scope: 'login-ui',
      source: 'default',
      account_page_overrides_supported: true,
    });
    expect(body.account_page).toMatchObject({
      version: 0,
      definition: {
        schema_version: 'authrim.account_page.v1',
      },
    });
    expect(body.account_page.definition.screens).toEqual(
      expect.arrayContaining([expect.objectContaining({ screen_key: 'account_profile' })])
    );
  });

  it('returns the published composition and only its configured account screens', async () => {
    mockCoreAdapter.query.mockResolvedValueOnce([
      {
        id: 'screen-profile',
        tenant_id: 'default',
        screen_key: 'account_profile',
        display_name: 'Profile',
        description: null,
        screen_kind: 'account',
        fields_json:
          '[{"field":"account.profile","label":"Profile","required":false,"block_type":"account_profile_widget","order":10}]',
        localizations_json: '{}',
        settings_json: '{"canvas_layout":"wide"}',
        is_active: 1,
        is_system: 1,
        created_at: 0,
        updated_at: 0,
      },
      {
        id: 'screen-passkeys',
        tenant_id: 'default',
        screen_key: 'account_passkeys',
        display_name: 'Passkeys',
        description: null,
        screen_kind: 'account',
        fields_json: '[]',
        localizations_json: '{}',
        settings_json: '{"canvas_layout":"wide"}',
        is_active: 1,
        is_system: 1,
        created_at: 0,
        updated_at: 0,
      },
    ]);
    const settings = {
      'login-ui.account_page_published': JSON.stringify({
        schema_version: 'authrim.account_page.v1',
        title: 'Your account',
        screens: [
          { id: 'profile', screen_key: 'account_profile', width: 'half', enabled: true },
          { id: 'invalid', screen_key: '../invalid', width: 'full', enabled: true },
        ],
      }),
      'login-ui.account_page_published_version': 3,
      'login-ui.account_page_published_at': '2026-07-22T00:00:00.000Z',
    };
    const response = await getAccountCapabilitiesHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_current', {
        SETTINGS: { get: vi.fn().mockResolvedValue(JSON.stringify(settings)) } as never,
      })
    );
    const body = (await response.json()) as {
      theme: { source: string };
      account_page: {
        version: number;
        definition: { title?: string; screens: Array<Record<string, unknown>> };
        screens: Array<{ screen_key: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.theme.source).toBe('published_account_page');
    expect(body.account_page.version).toBe(3);
    expect(body.account_page.definition).toMatchObject({
      title: 'Your account',
      screens: [{ id: 'profile', screen_key: 'account_profile', width: 'half', enabled: true }],
    });
    expect(body.account_page.screens).toHaveLength(1);
    expect(body.account_page.screens[0].screen_key).toBe('account_profile');
  });

  it('uses the active theme account page and its immutable published screen snapshot', async () => {
    const snapshot = {
      id: 'snapshot-profile',
      tenant_id: 'default',
      screen_key: 'account_profile',
      display_name: 'Published profile',
      description: null,
      screen_kind: 'account',
      fields: [
        {
          field: 'account.profile',
          label: 'Frozen label',
          required: false,
          block_type: 'account_profile_widget',
          block_id: 'profile-widget',
          order: 10,
        },
        {
          field: 'auth.passkey',
          label: 'Injected action',
          required: false,
          block_type: 'auth_widget',
          order: 20,
        },
      ],
      localizations: {
        ja: {
          fields: {
            'profile-widget': {
              label: 'プロフィール',
              block_type: 'account_totp_widget',
              href: 'javascript:alert(1)',
            },
          },
        },
      },
      settings: { canvas_layout: 'wide' },
      is_active: true,
      is_system: false,
      created_at: 1,
      updated_at: 1,
    };
    const definition = {
      schema_version: 'authrim.account_page.v1',
      screens: [
        {
          id: 'profile',
          screen_key: 'account_profile',
          width: 'full',
          enabled: true,
          condition: 'always',
        },
      ],
      resolved_at: '2026-07-22T00:00:00.000Z',
      screen_snapshots: { account_profile: snapshot },
    };
    const settings = {
      'login-ui.account_pages': JSON.stringify({
        schema_version: 'authrim.account_pages.v1',
        default_page_id: 'default-page',
        pages: [
          {
            id: 'default-page',
            name: 'Default',
            published: definition,
            published_version: 1,
            published_at: definition.resolved_at,
          },
          {
            id: 'brand-page',
            name: 'Brand',
            published: definition,
            published_version: 4,
            published_at: definition.resolved_at,
          },
        ],
      }),
      'login-ui.custom_themes': JSON.stringify({
        active: 'brand-theme',
        themes: [{ id: 'brand-theme', account_page_id: 'brand-page' }],
      }),
    };
    const response = await getAccountCapabilitiesHandler(
      createMockContext('authrim_session=g1%3Aapac%3A3%3Asession_current', {
        SETTINGS: { get: vi.fn().mockResolvedValue(JSON.stringify(settings)) } as never,
      })
    );
    const body = (await response.json()) as any;

    expect(body.account_page).toMatchObject({ page_id: 'brand-page', name: 'Brand', version: 4 });
    expect(body.account_page.screens[0]).toMatchObject({ display_name: 'Published profile' });
    expect(body.account_page.screens[0].fields).toHaveLength(1);
    expect(body.account_page.screens[0].localizations.ja.fields['profile-widget']).toEqual({
      label: 'プロフィール',
    });
    expect(mockCoreAdapter.query).not.toHaveBeenCalled();
  });
});
