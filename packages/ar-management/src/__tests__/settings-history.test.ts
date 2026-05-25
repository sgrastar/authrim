import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createSettingsHistoryManager: vi.fn(),
    publishEvent: vi.fn(async () => undefined),
    getLogger: vi.fn(() => ({
      module: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
    })),
    getTenantIdFromContext: vi.fn((c: { get?: (key: string) => unknown }) => {
      return (c.get?.('tenantId') as string | undefined) ?? 'default';
    }),
    calculateChanges: vi.fn((from: Record<string, unknown>, to: Record<string, unknown>) => ({
      changed: Object.keys({ ...from, ...to }).filter((key) => from[key] !== to[key]),
    })),
  };
});

import {
  calculateChanges,
  createSettingsHistoryManager,
  publishEvent,
  SETTINGS_EVENTS,
} from '@authrim/ar-lib-core';
import {
  compareSettingsVersions,
  getCurrentSettings,
  getSettingsVersion,
  listSettingsHistory,
  rollbackSettings,
} from '../routes/settings-v2/history';

type HistoryResponseBody = {
  limit?: number;
  offset?: number;
  error?: string;
  success?: boolean;
  restoredFromVersion?: number;
  currentVersion?: number;
  diff?: unknown;
};

function createMockKV(data: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(data));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (options?: { prefix?: string }) => {
      const keys = [...store.keys()]
        .filter((key) => !options?.prefix || key.startsWith(options.prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: '' };
    }),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function createMockContext(options: {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  jsonError?: Error;
  tenantId?: string;
  adminAuth?: {
    userId: string;
    roles: string[];
    org_id?: string;
  };
  adminUser?: {
    id: string;
  };
  envOverrides?: Partial<Env>;
}) {
  const kv = createMockKV();
  const store = new Map<string, unknown>([
    ['tenantId', options.tenantId ?? 'tenant_123'],
    [
      'adminAuth',
      options.adminAuth ?? {
        userId: 'admin_1',
        roles: ['system_admin'],
      },
    ],
    ['adminUser', options.adminUser ?? { id: 'admin_1' }],
  ]);

  return {
    req: {
      param: (name: string) => options.params?.[name],
      query: (name: string) => options.query?.[name],
      json: options.jsonError
        ? vi.fn().mockRejectedValue(options.jsonError)
        : vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: {
      DB: {} as D1Database,
      KV: kv,
      ...options.envOverrides,
    } as unknown as Env,
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    get: (key: string) => store.get(key),
    _kv: kv,
  };
}

describe('Settings History Handlers', () => {
  const mockHistoryManager = {
    listVersions: vi.fn(),
    getVersion: vi.fn(),
    rollback: vi.fn(),
    getLatestVersion: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSettingsHistoryManager).mockReturnValue(mockHistoryManager as never);
  });

  describe('listSettingsHistory', () => {
    it('should clamp pagination to safe bounds', async () => {
      mockHistoryManager.listVersions.mockResolvedValue({
        versions: [{ version: 3 }],
        total: 10,
      });

      const c = createMockContext({
        params: { category: 'oauth' },
        query: { limit: '500', offset: '-8' },
      });

      const response = await listSettingsHistory(c as never);
      const body = (await response.json()) as HistoryResponseBody;

      expect(mockHistoryManager.listVersions).toHaveBeenCalledWith('oauth', {
        limit: 100,
        offset: 0,
      });
      expect(body.limit).toBe(100);
      expect(body.offset).toBe(0);
    });

    it('should reject invalid pagination parameters', async () => {
      const c = createMockContext({
        params: { category: 'oauth' },
        query: { limit: 'abc', offset: '1' },
      });

      const response = await listSettingsHistory(c as never);
      expect(response.status).toBe(400);
    });

    it('should ignore tenant query overrides on tenant-scoped history routes', async () => {
      const c = createMockContext({
        params: { category: 'oauth' },
        query: { tenantId: 'tenant_other' },
        adminAuth: {
          userId: 'org_admin_1',
          roles: ['org_admin'],
          org_id: 'tenant_123',
        },
      });

      const response = await listSettingsHistory(c as never);
      const body = (await response.json()) as HistoryResponseBody;

      expect(response.status).toBe(200);
      expect(body.error).toBeUndefined();
      expect(mockHistoryManager.listVersions).toHaveBeenCalledWith('oauth', {
        limit: 50,
        offset: 0,
      });
    });
  });

  describe('getSettingsVersion', () => {
    it('should reject invalid version numbers', async () => {
      const c = createMockContext({
        params: { category: 'oauth', version: '0' },
      });

      const response = await getSettingsVersion(c as never);
      expect(response.status).toBe(400);
    });

    it('should return 404 when the requested version does not exist', async () => {
      mockHistoryManager.getVersion.mockResolvedValue(null);

      const c = createMockContext({
        params: { category: 'oauth', version: '3' },
      });

      const response = await getSettingsVersion(c as never);
      expect(response.status).toBe(404);
    });
  });

  describe('rollbackSettings', () => {
    it('should reject invalid JSON bodies', async () => {
      const c = createMockContext({
        params: { category: 'oauth' },
        jsonError: new SyntaxError('Unexpected token'),
      });

      const response = await rollbackSettings(c as never);
      expect(response.status).toBe(400);
    });

    it('should restore the target snapshot and publish rollback events', async () => {
      mockHistoryManager.rollback.mockImplementation(
        async (
          _category: string,
          _input: unknown,
          getSnapshot: () => Promise<Record<string, unknown>>,
          applySnapshot: (snapshot: Record<string, unknown>) => Promise<void>
        ) => {
          await getSnapshot();
          await applySnapshot({
            mode: 'strict',
            enabled: true,
          });
          return {
            previousVersion: 7,
            currentVersion: 8,
          };
        }
      );

      const c = createMockContext({
        params: { category: 'oauth' },
        body: { targetVersion: 5, reason: 'Rollback after regression' },
        envOverrides: {
          KV: createMockKV({
            'settings:oauth:mode': '"relaxed"',
            'settings:oauth:max_age': '300',
          }) as unknown as Env['KV'],
        },
      });

      const response = await rollbackSettings(c as never);
      const body = (await response.json()) as HistoryResponseBody;
      const kv = c.env.KV as unknown as ReturnType<typeof createMockKV>;

      expect(response.status).toBe(200);
      expect(kv.delete).toHaveBeenCalledWith('settings:oauth:mode');
      expect(kv.delete).toHaveBeenCalledWith('settings:oauth:max_age');
      expect(kv.put).toHaveBeenCalledWith('settings:oauth:mode', 'strict');
      expect(kv.put).toHaveBeenCalledWith('settings:oauth:enabled', 'true');
      expect(vi.mocked(publishEvent)).toHaveBeenCalledWith(
        c,
        expect.objectContaining({ type: SETTINGS_EVENTS.ROLLBACK_STARTED })
      );
      expect(vi.mocked(publishEvent)).toHaveBeenCalledWith(
        c,
        expect.objectContaining({ type: SETTINGS_EVENTS.ROLLBACK_COMPLETED })
      );
      expect(body).toEqual(
        expect.objectContaining({
          success: true,
          restoredFromVersion: 5,
          currentVersion: 8,
        })
      );
    });
  });

  describe('getCurrentSettings', () => {
    it('should return the current snapshot with latest version metadata', async () => {
      mockHistoryManager.getLatestVersion.mockResolvedValue({
        version: 9,
        createdAt: '2026-04-08T00:00:00.000Z',
        actorId: 'admin_2',
      });

      const c = createMockContext({
        params: { category: 'oauth' },
        envOverrides: {
          KV: createMockKV({
            'settings:oauth:access_token_ttl': '3600',
            'settings:oauth:require_pkce': 'true',
          }) as unknown as Env['KV'],
        },
      });

      const response = await getCurrentSettings(c as never);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          category: 'oauth',
          currentVersion: 9,
          settings: {
            access_token_ttl: 3600,
            require_pkce: true,
          },
          lastModifiedBy: 'admin_2',
        })
      );
    });
  });

  describe('compareSettingsVersions', () => {
    it('should require both version parameters', async () => {
      const c = createMockContext({
        params: { category: 'oauth' },
        query: { from: '1' },
      });

      const response = await compareSettingsVersions(c as never);
      expect(response.status).toBe(400);
    });

    it('should compare two versions and return a diff', async () => {
      mockHistoryManager.getVersion
        .mockResolvedValueOnce({
          version: 1,
          snapshot: { mode: 'relaxed', ttl: 300 },
          createdAt: '2026-04-01T00:00:00.000Z',
        })
        .mockResolvedValueOnce({
          version: 2,
          snapshot: { mode: 'strict', ttl: 300 },
          createdAt: '2026-04-02T00:00:00.000Z',
        });

      const c = createMockContext({
        params: { category: 'oauth' },
        query: { from: '1', to: '2' },
      });

      const response = await compareSettingsVersions(c as never);
      const body = (await response.json()) as HistoryResponseBody;

      expect(response.status).toBe(200);
      expect(vi.mocked(calculateChanges)).toHaveBeenCalledWith(
        { mode: 'relaxed', ttl: 300 },
        { mode: 'strict', ttl: 300 }
      );
      expect(body.diff).toEqual({ changed: ['mode'] });
    });
  });
});
