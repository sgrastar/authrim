import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  getJITProvisioningConfig,
  updateJITProvisioningConfig,
} from '../routes/settings/jit-provisioning';
import { updateCheckApiAuditSetting } from '../routes/settings/check-api-audit';
import { updateRegionShards } from '../routes/settings/region-shards';

function context(options: {
  body?: unknown;
  stored?: string | null;
  parameter?: string;
  useAuthrimConfig?: boolean;
}) {
  const values = new Map<string, string>();
  if (options.stored !== undefined && options.stored !== null) {
    values.set('jit_provisioning_config', options.stored);
  }
  const kv = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => values.set(key, value)),
    delete: vi.fn(async (key: string) => values.delete(key)),
  };
  return {
    context: {
      env: options.useAuthrimConfig ? { AUTHRIM_CONFIG: kv } : { SETTINGS: kv },
      req: {
        json: vi.fn().mockResolvedValue(options.body),
        param: vi.fn().mockReturnValue(options.parameter),
      },
      get: vi.fn().mockReturnValue(undefined),
      json: vi.fn((payload: unknown, status = 200) => ({ payload, status })),
    } as unknown as Context<{ Bindings: Env }>,
    kv,
    values,
  };
}

describe('JIT provisioning settings trust boundary', () => {
  it.each([
    JSON.stringify({ enabled: 'false' }),
    JSON.stringify({ enabled: true, rate_limit: null }),
    JSON.stringify({ enabled: true, allowed_provider_ids: [''] }),
    '{',
  ])('falls back to safe defaults for corrupted persisted config %s', async (stored) => {
    const { context: c } = context({ stored });
    const result = (await getJITProvisioningConfig(c)) as unknown as {
      payload: { source: string; config: { enabled: boolean } };
    };

    expect(result.payload.source).toBe('default');
    expect(typeof result.payload.config.enabled).toBe('boolean');
  });

  it.each([
    [null, 'configuration must be an object'],
    [{ rate_limit: null }, 'rate_limit must be an object'],
    [{ rate_limit: { max_per_minute: 1.5 } }, 'must be a positive integer'],
    [{ rate_limit: { max_per_hour: Number.POSITIVE_INFINITY } }, 'must be a positive integer'],
    [{ allowed_provider_ids: ['google', ''] }, 'must be an array of non-empty strings'],
    [{ default_role_id: ' ' }, 'default_role_id must not be empty'],
  ])('rejects invalid update %# without writing', async (body, message) => {
    const { context: c, kv } = context({ body });
    const result = (await updateJITProvisioningConfig(c)) as unknown as {
      status: number;
      payload: { error_description: string };
    };

    expect(result.status).toBe(400);
    expect(result.payload.error_description).toContain(message);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('merges a valid partial update into validated defaults', async () => {
    const { context: c, values } = context({
      stored: JSON.stringify({ enabled: 'corrupt' }),
      body: { enabled: true, rate_limit: { max_per_minute: 25 } },
    });

    await expect(updateJITProvisioningConfig(c)).resolves.toMatchObject({
      status: 200,
      payload: {
        config: {
          enabled: true,
          rate_limit: { max_per_minute: 25, max_per_hour: expect.any(Number) },
        },
      },
    });
    const saved = JSON.parse(values.get('jit_provisioning_config') ?? '{}') as Record<
      string,
      unknown
    >;
    expect(saved.enabled).toBe(true);
  });
});

describe('audit and region numeric settings', () => {
  it('rejects fractional audit retention without writing KV', async () => {
    const { context: c, kv } = context({
      body: { value: 1.5 },
      parameter: 'CHECK_API_AUDIT_RETENTION_DAYS',
      useAuthrimConfig: true,
    });

    await expect(updateCheckApiAuditSetting(c)).resolves.toMatchObject({
      status: 400,
      payload: { error_description: 'CHECK_API_AUDIT_RETENTION_DAYS must be an integer' },
    });
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('rejects fractional region shard counts before tenant/config resolution', async () => {
    const { context: c, kv } = context({
      body: { totalShards: 1.5, regionDistribution: { wnam: 100 } },
      useAuthrimConfig: true,
    });

    const response = await updateRegionShards(c);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
    expect(kv.put).not.toHaveBeenCalled();
  });
});
