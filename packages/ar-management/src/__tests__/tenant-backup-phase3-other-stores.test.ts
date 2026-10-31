import { expect, it, vi } from 'vitest';
import { encryptValue } from '@authrim/ar-lib-core';
import { exportPortableOauthClientSecretRow } from '@authrim/ar-lib-core/services/tenant-portability/portable-client-secret';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import {
  createPhase3OtherStoreHandlers,
  type Phase3OtherStorePorts,
} from '../tenant-backup-phase3-other-stores';

const sourceKey = '11'.repeat(32);
const targetKey = '22'.repeat(32);
const context = {
  signal: new AbortController().signal,
} as TenantBackupStepContext;

async function fixture() {
  const source = await encryptValue('fixture-secret', sourceKey, 'AES-256-GCM', 1);
  const rowJson = await exportPortableOauthClientSecretRow(
    JSON.stringify({
      tenant_id: ['text', 'tenant-a'],
      client_id: ['text', 'client-a'],
      logout_webhook_secret_encrypted: ['text', source.encrypted],
    }),
    sourceKey
  );
  let stored: string | null = null;
  const target = {
    writeSidecarText: vi.fn(async (...args: unknown[]) => {
      const value = args[4];
      const matches = args[5] as (value: string) => Promise<boolean>;
      if (typeof value !== 'string') throw new Error('expected_ciphertext');
      stored = value;
      expect(await matches(value)).toBe(true);
    }),
    verifySidecarValue: vi.fn(async (...args: unknown[]) => {
      const matches = args[4] as (value: string | null) => Promise<boolean>;
      expect(await matches(stored)).toBe(true);
    }),
  };
  const load = vi.fn<Phase3OtherStorePorts['load']>(async (_context, _digest, _purpose) => ({
    policy: {
      dataset: { id: 'core.oauth_clients' },
      verificationIgnoredColumns: ['logout_webhook_secret_encrypted'],
    } as never,
    manifest: {} as never,
    target: target as never,
    readNextValidatedRow: async ({ sourceCursor }) =>
      sourceCursor === null ? { rowJson, nextCursor: 'row:1' } : null,
  }));
  return { target, load, getStored: () => stored };
}

it('restores and verifies client secrets one durable row at a time', async () => {
  const state = await fixture();
  const handlers = createPhase3OtherStoreHandlers(
    { RP_TOKEN_ENCRYPTION_KEY: targetKey },
    { load: state.load }
  );
  const first = await handlers.restoreOtherStores(context, 'ab'.repeat(32), null);
  expect(first.done).toBe(false);
  expect(first.cursor).not.toContain('fixture-secret');
  expect(await handlers.restoreOtherStores(context, 'ab'.repeat(32), first.cursor)).toEqual({
    cursor: null,
    done: true,
  });
  const verify = await handlers.verifyOtherStores(context, 'ab'.repeat(32), null);
  expect(verify.done).toBe(false);
  expect(await handlers.verifyOtherStores(context, 'ab'.repeat(32), verify.cursor)).toEqual({
    cursor: null,
    done: true,
  });
  expect(state.target.writeSidecarText).toHaveBeenCalledTimes(1);
  expect(state.target.verifySidecarValue).toHaveBeenCalledTimes(1);
  expect(state.getStored()).not.toBeNull();
  expect(state.load.mock.calls.map((call) => call[2])).toEqual([
    'restore',
    'restore',
    'verify',
    'verify',
  ]);
});

it('rejects a cursor from the other phase and a stalled source cursor', async () => {
  const state = await fixture();
  const handlers = createPhase3OtherStoreHandlers(
    { PII_ENCRYPTION_KEY: targetKey, PII_ENCRYPTION_KEY_VERSION: '2' },
    { load: state.load }
  );
  const first = await handlers.restoreOtherStores(context, 'ab'.repeat(32), null);
  await expect(handlers.verifyOtherStores(context, 'ab'.repeat(32), first.cursor)).rejects.toThrow(
    'backup_phase3_other_store_invalid'
  );
  state.load.mockResolvedValueOnce({
    ...(await state.load(context, 'ab'.repeat(32), 'restore')),
    readNextValidatedRow: async () => ({ rowJson: '{}', nextCursor: 'same' }),
  });
  const stalled = JSON.stringify({
    version: 1,
    datasetId: 'core.oauth_clients',
    purpose: 'restore',
    sourceCursor: 'same',
  });
  await expect(handlers.restoreOtherStores(context, 'ab'.repeat(32), stalled)).rejects.toThrow(
    'backup_phase3_other_store_invalid'
  );
});

it('restores an explicitly absent secret without requiring an encryption key', async () => {
  const verifySidecarValue = vi.fn(async (...args: unknown[]) => {
    const matches = args[4] as (value: string | null) => Promise<boolean>;
    expect(await matches(null)).toBe(true);
  });
  const handlers = createPhase3OtherStoreHandlers(
    {},
    {
      async load() {
        return {
          policy: {
            dataset: { id: 'core.oauth_clients' },
            verificationIgnoredColumns: ['logout_webhook_secret_encrypted'],
          } as never,
          manifest: {} as never,
          target: { verifySidecarValue } as never,
          async readNextValidatedRow({ sourceCursor }) {
            return sourceCursor === null
              ? {
                  rowJson: JSON.stringify({
                    tenant_id: ['text', 'tenant-a'],
                    client_id: ['text', 'client-a'],
                    logout_webhook_secret_encrypted: ['null', null],
                  }),
                  nextCursor: 'row:1',
                }
              : null;
          },
        };
      },
    }
  );
  const result = await handlers.restoreOtherStores(context, 'ab'.repeat(32), null);
  expect(result.done).toBe(false);
  expect(typeof result.cursor).toBe('string');
  expect(verifySidecarValue).toHaveBeenCalledTimes(1);
});
