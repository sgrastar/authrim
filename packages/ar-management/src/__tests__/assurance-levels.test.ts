import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ logger: { info: vi.fn(), error: vi.fn() } }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
}));

import {
  deleteAssuranceLevelsConfig,
  getAssuranceLevelsConfig,
  getAssuranceLevelsSettings,
  getRequiredAALForScope,
  isAssuranceLevelsEnabled,
  updateAssuranceLevelsConfig,
} from '../routes/settings/assurance-levels';

function kv(initial: string | null = null) {
  return {
    get: vi.fn().mockResolvedValue(initial),
    put: vi.fn().mockResolvedValue(undefined),
  };
}

function context(
  options: { env?: Record<string, unknown>; body?: unknown; bodyError?: boolean } = {}
) {
  return {
    env: options.env ?? {},
    req: {
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad json'))
        : vi.fn().mockResolvedValue(options.body ?? {}),
    },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

describe('assurance level settings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns secure defaults without configuration', async () => {
    const result = await getAssuranceLevelsSettings({} as never);
    expect(result).toEqual({
      settings: {
        enabled: false,
        defaultAAL: 'AAL1',
        defaultFAL: 'FAL1',
        defaultIAL: 'IAL1',
        scopeAALRequirements: {},
        includeInIdToken: true,
        includeInAccessToken: false,
        fal2RequiresDPoP: true,
        fal3RequiresPAR: true,
      },
      sources: expect.objectContaining({ enabled: 'default', defaultAAL: 'default' }),
    });
  });

  it('uses only valid environment values', async () => {
    const result = await getAssuranceLevelsSettings({
      ENABLE_NIST_ASSURANCE_LEVELS: 'true',
      DEFAULT_AAL: 'AAL3',
      DEFAULT_FAL: 'bad',
      DEFAULT_IAL: 'IAL2',
    } as never);
    expect(result.settings).toMatchObject({
      enabled: true,
      defaultAAL: 'AAL3',
      defaultFAL: 'FAL1',
      defaultIAL: 'IAL2',
    });
    expect(result.sources).toMatchObject({
      enabled: 'env',
      defaultAAL: 'env',
      defaultFAL: 'default',
      defaultIAL: 'env',
    });
  });

  it('applies valid KV values over environment values and coerces booleans strictly', async () => {
    const store = kv(
      JSON.stringify({
        assurance: {
          enabled: false,
          defaultAAL: 'AAL2',
          defaultFAL: 'FAL3',
          defaultIAL: 'IAL3',
          scopeAALRequirements: { admin: 'AAL3' },
          includeInIdToken: false,
          includeInAccessToken: true,
          fal2RequiresDPoP: false,
          fal3RequiresPAR: false,
        },
      })
    );
    const result = await getAssuranceLevelsSettings({
      SETTINGS: store,
      ENABLE_NIST_ASSURANCE_LEVELS: 'true',
      DEFAULT_AAL: 'AAL1',
    } as never);
    expect(result.settings).toMatchObject({
      enabled: false,
      defaultAAL: 'AAL2',
      defaultFAL: 'FAL3',
      defaultIAL: 'IAL3',
      scopeAALRequirements: { admin: 'AAL3' },
      includeInIdToken: false,
      includeInAccessToken: true,
      fal2RequiresDPoP: false,
      fal3RequiresPAR: false,
    });
    expect(Object.values(result.sources)).toEqual(Array(9).fill('kv'));
  });

  it.each([
    ['{'],
    [
      JSON.stringify({
        assurance: {
          defaultAAL: 'bad',
          defaultFAL: 'bad',
          defaultIAL: 'bad',
          scopeAALRequirements: null,
        },
      }),
    ],
  ])('ignores malformed or invalid KV settings %#', async (stored) => {
    const result = await getAssuranceLevelsSettings({ SETTINGS: kv(stored) } as never);
    expect(result.settings).toMatchObject({
      defaultAAL: 'AAL1',
      defaultFAL: 'FAL1',
      defaultIAL: 'IAL1',
    });
  });

  it('ignores KV read failures', async () => {
    const store = kv();
    store.get.mockRejectedValueOnce(new Error('KV unavailable'));
    await expect(getAssuranceLevelsSettings({ SETTINGS: store } as never)).resolves.toMatchObject({
      settings: { enabled: false },
    });
  });

  it('resolves enabled state and scope requirements', async () => {
    const store = kv(
      JSON.stringify({ assurance: { enabled: true, scopeAALRequirements: { admin: 'AAL2' } } })
    );
    const env = { SETTINGS: store } as never;
    await expect(isAssuranceLevelsEnabled(env)).resolves.toBe(true);
    await expect(getRequiredAALForScope(env, 'admin')).resolves.toBe('AAL2');
    await expect(getRequiredAALForScope(env, 'unknown')).resolves.toBeNull();
    await expect(getRequiredAALForScope({} as never, 'admin')).resolves.toBeNull();
  });

  it('returns annotated config metadata and handles unexpected failures', async () => {
    const response = await getAssuranceLevelsConfig(context());
    await expect(response.json()).resolves.toMatchObject({
      settings: {
        defaultAAL: { value: 'AAL1', source: 'default', validValues: ['AAL1', 'AAL2', 'AAL3'] },
      },
    });
    const store = kv();
    store.get.mockRejectedValueOnce('ignored');
    expect((await getAssuranceLevelsConfig(context({ env: { SETTINGS: store } }))).status).toBe(
      200
    );
  });

  it('requires SETTINGS KV and valid JSON for update', async () => {
    expect((await updateAssuranceLevelsConfig(context({ body: {} }))).status).toBe(500);
    expect(
      (await updateAssuranceLevelsConfig(context({ env: { SETTINGS: kv() }, bodyError: true })))
        .status
    ).toBe(400);
  });

  it.each([
    [{ defaultAAL: 'bad' }],
    [{ defaultFAL: 'bad' }],
    [{ defaultIAL: 'bad' }],
    [{ scopeAALRequirements: 'bad' }],
    [{ scopeAALRequirements: { admin: 'AAL9' } }],
  ])('rejects invalid update %#', async (body) => {
    expect(
      (await updateAssuranceLevelsConfig(context({ env: { SETTINGS: kv() }, body }))).status
    ).toBe(400);
  });

  it('merges all update fields without deleting unrelated system settings', async () => {
    const store = kv(
      JSON.stringify({ unrelated: { keep: true }, assurance: { defaultAAL: 'AAL1' } })
    );
    const body = {
      enabled: false,
      defaultAAL: 'AAL3',
      defaultFAL: 'FAL2',
      defaultIAL: 'IAL2',
      scopeAALRequirements: { admin: 'AAL3' },
      includeInIdToken: false,
      includeInAccessToken: true,
      fal2RequiresDPoP: false,
      fal3RequiresPAR: false,
    };
    const response = await updateAssuranceLevelsConfig(context({ env: { SETTINGS: store }, body }));
    expect(response.status).toBe(200);
    const saved = JSON.parse(store.put.mock.calls[0][1]);
    expect(saved).toMatchObject({ unrelated: { keep: true }, assurance: body });
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'Assurance Levels settings updated',
      expect.objectContaining({ updatedFields: Object.keys(body) })
    );
  });

  it('creates assurance object from empty storage and handles write failure', async () => {
    const store = kv(null);
    expect(
      (
        await updateAssuranceLevelsConfig(
          context({ env: { SETTINGS: store }, body: { enabled: true } })
        )
      ).status
    ).toBe(200);
    store.put.mockRejectedValueOnce(new Error('KV unavailable'));
    expect(
      (
        await updateAssuranceLevelsConfig(
          context({ env: { SETTINGS: store }, body: { enabled: false } })
        )
      ).status
    ).toBe(500);
  });

  it('requires SETTINGS KV for deletion', async () => {
    expect((await deleteAssuranceLevelsConfig(context())).status).toBe(500);
  });

  it.each([null, JSON.stringify({ unrelated: true, assurance: { enabled: true } })])(
    'deletes assurance override stored=%s',
    async (stored) => {
      const store = kv(stored);
      expect(
        (await deleteAssuranceLevelsConfig(context({ env: { SETTINGS: store } }))).status
      ).toBe(200);
      expect(store.put).toHaveBeenCalledTimes(stored ? 1 : 0);
      if (stored) expect(JSON.parse(store.put.mock.calls[0][1])).toEqual({ unrelated: true });
    }
  );

  it('handles malformed/deletion KV failures', async () => {
    const store = kv('{');
    expect((await deleteAssuranceLevelsConfig(context({ env: { SETTINGS: store } }))).status).toBe(
      500
    );
    expect(mocks.logger.error).toHaveBeenCalled();
  });
});
