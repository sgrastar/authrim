import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import { updateTokenEmbeddingSettings } from '../routes/settings/token-embedding';

function contextFor(body: Record<string, unknown>) {
  const values = new Map<string, string>();
  const put = vi.fn(async (key: string, value: string) => {
    values.set(key, value);
  });
  const context = {
    env: {
      SETTINGS: {
        get: vi.fn(async (key: string) => values.get(key) ?? null),
        put,
      },
    },
    req: { json: vi.fn().mockResolvedValue(body) },
    get: vi.fn().mockReturnValue(undefined),
    json: vi.fn((payload: unknown, status = 200) => ({ payload, status })),
  } as unknown as Context;
  return { context, put, values };
}

describe('token embedding settings update', () => {
  it('validates the complete request before writing any feature flag', async () => {
    const { context, put } = contextFor({
      policy_embedding_enabled: true,
      max_resource_permissions: 1001,
    });

    await expect(updateTokenEmbeddingSettings(context)).resolves.toMatchObject({
      status: 400,
      payload: {
        error: 'invalid_request',
        error_description: 'max_resource_permissions must be an integer between 1 and 1000',
      },
    });
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    [{ policy_embedding_enabled: 'false' }, 'policy_embedding_enabled must be a boolean'],
    [
      { max_embedded_permissions: 1.5 },
      'max_embedded_permissions must be an integer between 1 and 500',
    ],
    [{ max_custom_claims: 0 }, 'max_custom_claims must be an integer between 1 and 100'],
  ])('rejects invalid runtime input %j without side effects', async (body, description) => {
    const { context, put } = contextFor(body);

    await expect(updateTokenEmbeddingSettings(context)).resolves.toMatchObject({
      status: 400,
      payload: { error_description: description },
    });
    expect(put).not.toHaveBeenCalled();
  });

  it('persists a fully valid update and returns the effective values', async () => {
    const { context, values } = contextFor({
      policy_embedding_enabled: true,
      custom_claims_enabled: false,
      id_level_permissions_enabled: true,
      max_embedded_permissions: 75,
      max_resource_permissions: 250,
      max_custom_claims: 30,
    });

    await expect(updateTokenEmbeddingSettings(context)).resolves.toMatchObject({
      status: 200,
      payload: {
        policy_embedding_enabled: true,
        custom_claims_enabled: false,
        id_level_permissions_enabled: true,
        limits: {
          max_embedded_permissions: 75,
          max_resource_permissions: 250,
          max_custom_claims: 30,
        },
        last_updated: expect.any(String),
      },
    });
    expect(values.get('policy:flags:ENABLE_POLICY_EMBEDDING')).toBe('true');
    expect(values.get('config:max_resource_permissions')).toBe('250');
    expect(values.get('config:token_embedding:last_updated')).toEqual(expect.any(String));
  });
});
