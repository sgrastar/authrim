import type { Env } from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';
import worker, { createTrackedExecutionContext } from '../index';

function createMockKV(): KVNamespace {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [] }),
  } as unknown as KVNamespace;
}

describe('Admin API compatibility surface', () => {
  it('drains deferred effects, including work registered by another deferred effect', async () => {
    const platformEffects: Promise<unknown>[] = [];
    const tracked = createTrackedExecutionContext({
      waitUntil(effect: Promise<unknown>) {
        platformEffects.push(effect);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext);
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const second = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    }).then(() => tracked.context!.waitUntil(second));
    tracked.context!.waitUntil(first);
    let drained = false;
    const drain = tracked.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    finishFirst();
    await Promise.resolve();
    expect(drained).toBe(false);
    finishSecond();
    await drain;
    expect(drained).toBe(true);
    expect(platformEffects).toHaveLength(2);
  });

  it('preserves an undefined deferred rejection instead of treating it as success', async () => {
    const tracked = createTrackedExecutionContext({
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext);
    tracked.context!.waitUntil(Promise.reject(undefined));

    await expect(tracked.drain()).rejects.toBeUndefined();
  });

  it('returns the removed admin session endpoint error before admin authentication', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/admin/sessions/me', {
        headers: {
          'X-Tenant-Id': 'tenant-a',
        },
      }),
      {
        DEFAULT_TENANT_ID: 'tenant-a',
        AUTHRIM_CONFIG: createMockKV(),
      } as unknown as Env
    );
    const payload = (await response.json()) as {
      error?: string;
      error_uri?: string;
      error_details?: {
        code?: string;
        severity?: string;
        retryable?: boolean;
      };
    };

    expect(response.status).toBe(404);
    expect(payload.error).toBe('legacy_endpoint_not_supported');
    expect(payload.error_uri).toBe(
      'https://docs.authrim.com/errors/error-codes#legacy-endpoint-not-supported'
    );
    expect(payload.error_details).toMatchObject({
      code: 'legacy_endpoint_not_supported',
      severity: 'fatal',
      retryable: false,
    });
  });

  it('fails closed before dispatching a mutating request when backup admission is denied', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/admin/sessions/me', {
        method: 'POST',
        headers: { 'X-Tenant-Id': 'tenant-a' },
      }),
      {
        DEFAULT_TENANT_ID: 'tenant-a',
        AUTHRIM_CONFIG: createMockKV(),
        TENANT_BACKUP_WRAPPING_KEY: 'enabled',
        CONTROL: {
          acquireEnvironmentBackupMutationPermit: vi.fn(async () => ({ admitted: false })),
          completeEnvironmentBackupMutationPermit: vi.fn(async () => {}),
        },
      } as unknown as Env
    );

    await expect(response.json()).resolves.toMatchObject({ error: 'backup_mutation_unavailable' });
    expect(response.status).toBe(503);
  });

  it('holds an environment permit until a mutating request finishes', async () => {
    const acquire = vi.fn(async (_input: { permitId: string }) => ({ admitted: true }));
    const complete = vi.fn(async (_input: { permitId: string }) => {});
    const response = await worker.fetch(
      new Request('https://example.com/api/admin/sessions/me', {
        method: 'POST',
        headers: { 'X-Tenant-Id': 'tenant-a' },
      }),
      {
        DEFAULT_TENANT_ID: 'tenant-a',
        AUTHRIM_CONFIG: createMockKV(),
        TENANT_BACKUP_WRAPPING_KEY: 'enabled',
        CONTROL: {
          acquireEnvironmentBackupMutationPermit: acquire,
          completeEnvironmentBackupMutationPermit: complete,
        },
      } as unknown as Env
    );

    expect(response.status).toBe(403);
    expect(acquire).toHaveBeenCalledWith({ permitId: expect.any(String) });
    expect(complete).toHaveBeenCalledWith({ permitId: acquire.mock.calls[0]![0].permitId });
  });
});
