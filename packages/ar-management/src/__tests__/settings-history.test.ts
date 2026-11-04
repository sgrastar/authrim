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
  };
});

vi.mock('@authrim/ar-lib-core/services/settings-history', () => ({
  calculateChanges: vi.fn((from: Record<string, unknown>, to: Record<string, unknown>) => ({
    changed: Object.keys({ ...from, ...to }).filter((key) => from[key] !== to[key]),
  })),
}));

const { mockRequireAdminStepUp } = vi.hoisted(() => ({ mockRequireAdminStepUp: vi.fn() }));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: mockRequireAdminStepUp,
  refuseAdminFreshAuth: vi.fn(),
}));

import { createSettingsHistoryManager, publishEvent, SETTINGS_EVENTS } from '@authrim/ar-lib-core';
import { calculateChanges } from '@authrim/ar-lib-core/services/settings-history';
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
  const env = {
    DB: {} as D1Database,
    KV: kv,
    ...options.envOverrides,
  } as unknown as Env;
  const store = new Map<string, unknown>([
    ['tenantId', options.tenantId ?? 'tenant_123'],
    [
      'tenantMetadataContext',
      {
        tenantId: options.tenantId ?? 'tenant_123',
        coreDb: env.DB,
        route: {},
      },
    ],
    [
      'adminAuth',
      options.adminAuth ?? {
        userId: 'admin_1',
        roles: ['ar_super_admin'],
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
    env,
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
    mockRequireAdminStepUp.mockReset();
    mockRequireAdminStepUp.mockResolvedValue(null);
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
          userId: 'tenant_admin_1',
          roles: ['ar_tenant_admin'],
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
    beforeEach(() => {
      mockHistoryManager.getVersion.mockResolvedValue({ version: 2, snapshot: {} });
    });

    it('should reject invalid JSON bodies', async () => {
      const c = createMockContext({
        params: { category: 'oauth' },
        jsonError: new SyntaxError('Unexpected token'),
      });

      const response = await rollbackSettings(c as never);
      expect(response.status).toBe(400);
    });

    it('uses an environment permit and waits for rollback event publication before completion', async () => {
      const acquire = vi.fn().mockResolvedValue({ admitted: false });
      const complete = vi.fn().mockResolvedValue(undefined);
      const c = createMockContext({
        params: { category: 'oauth' },
        body: { targetVersion: 1 },
        envOverrides: {
          TENANT_BACKUP_WRAPPING_KEY: 'ab'.repeat(32),
          CONTROL: {
            acquireEnvironmentBackupMutationPermit: acquire,
            completeEnvironmentBackupMutationPermit: complete,
          } as unknown as Env['CONTROL'],
        },
      });
      expect((await rollbackSettings(c as never)).status).toBe(503);
      expect(mockHistoryManager.rollback).not.toHaveBeenCalled();
      expect(publishEvent).not.toHaveBeenCalled();
      acquire.mockResolvedValue({ admitted: true });
      mockHistoryManager.rollback.mockImplementation(
        async (
          _category: string,
          _request: unknown,
          _read: unknown,
          apply: (snapshot: Record<string, unknown>) => Promise<void>
        ) => {
          await apply({ mode: 'strict' });
          return { previousVersion: 1, currentVersion: 2 };
        }
      );
      const publisher = vi.mocked(publishEvent);
      const original = publisher.getMockImplementation();
      if (!original) throw new Error('missing event mock');
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      publisher.mockImplementation(async (...args) => {
        if (args[1].type === SETTINGS_EVENTS.ROLLBACK_COMPLETED) await pending;
        return original(...args);
      });
      try {
        const execution = rollbackSettings(c as never);
        await vi.waitFor(() =>
          expect(publisher).toHaveBeenCalledWith(
            c,
            expect.objectContaining({ type: SETTINGS_EVENTS.ROLLBACK_COMPLETED })
          )
        );
        expect(complete).not.toHaveBeenCalled();
        release();
        expect((await execution).status).toBe(200);
        expect(complete).toHaveBeenCalledTimes(1);
        expect(complete.mock.calls[0]).toEqual(acquire.mock.calls[1]);
        expect(acquire.mock.calls[1][0]).toEqual({ permitId: expect.any(String) as unknown });
      } finally {
        release();
        publisher.mockImplementation(original);
      }
    });

    it.each([['security', 'admin_step_up.policy.relax']])(
      'a rollback of %s is gated as %s and restores nothing without step-up',
      async (category, operation) => {
        mockRequireAdminStepUp.mockResolvedValue(
          new Response(JSON.stringify({ error: 'step_up_required' }), { status: 403 })
        );
        const c = createMockContext({ params: { category }, body: { targetVersion: 2 } });
        const response = await rollbackSettings(c as never);
        expect(response.status).toBe(403);
        expect(mockHistoryManager.rollback).not.toHaveBeenCalled();
        expect(publishEvent).not.toHaveBeenCalled();
        expect(mockRequireAdminStepUp.mock.calls[0][1]).toEqual({
          operation,
          targetTenantId: 'tenant_123',
          params: { kind: 'settings.rollback', category, target_version: 2 },
        });
      }
    );

    it.each([
      ['a non-integer version', { targetVersion: 1.5 }, 400],
      ['a version that does not exist', { targetVersion: 99 }, 404],
    ])('%s fails before the gate is asked and restores nothing', async (_name, body, status) => {
      mockHistoryManager.getVersion.mockResolvedValue(null);
      const c = createMockContext({ params: { category: 'security' }, body });
      const response = await rollbackSettings(c as never);
      expect(response.status).toBe(status);
      expect(mockRequireAdminStepUp).not.toHaveBeenCalled();
      expect(mockHistoryManager.rollback).not.toHaveBeenCalled();
    });

    it('a target that cannot be restored fails before the gate is asked', async () => {
      mockHistoryManager.getVersion.mockResolvedValue({ version: 2, snapshot: null });
      const c = createMockContext({ params: { category: 'security' }, body: { targetVersion: 2 } });
      expect((await rollbackSettings(c as never)).status).toBe(400);
      expect(mockRequireAdminStepUp).not.toHaveBeenCalled();
      expect(mockHistoryManager.rollback).not.toHaveBeenCalled();
    });

    it('asks the gate once the target is validated, then rolls back', async () => {
      mockHistoryManager.rollback.mockResolvedValue({ previousVersion: 3, currentVersion: 4 });
      const c = createMockContext({ params: { category: 'security' }, body: { targetVersion: 2 } });
      expect((await rollbackSettings(c as never)).status).toBe(200);
      expect(mockRequireAdminStepUp).toHaveBeenCalledTimes(1);
      expect(mockHistoryManager.getVersion).toHaveBeenCalledWith('security', 2);
      expect(mockHistoryManager.rollback).toHaveBeenCalledTimes(1);
    });

    it('a rollback of another category, or with an invalid body, does not reach the gate', async () => {
      mockHistoryManager.rollback.mockResolvedValue({ previousVersion: 1, currentVersion: 2 });
      const other = createMockContext({
        params: { category: 'oauth' },
        body: { targetVersion: 2 },
      });
      expect((await rollbackSettings(other as never)).status).toBe(200);
      const invalid = createMockContext({
        params: { category: 'security' },
        body: { targetVersion: 0 },
      });
      expect((await rollbackSettings(invalid as never)).status).toBe(400);
      expect(mockRequireAdminStepUp).not.toHaveBeenCalled();
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
      // The snapshot's keys are written over, and only the keys it lacks are deleted, after.
      expect(kv.put).toHaveBeenCalledWith('settings:oauth:mode', 'strict');
      expect(kv.put).toHaveBeenCalledWith('settings:oauth:enabled', 'true');
      expect(kv.delete).toHaveBeenCalledWith('settings:oauth:max_age');
      expect(kv.delete).not.toHaveBeenCalledWith('settings:oauth:mode');
      expect(Math.min(...vi.mocked(kv.delete).mock.invocationCallOrder)).toBeGreaterThan(
        Math.max(...vi.mocked(kv.put).mock.invocationCallOrder)
      );
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
