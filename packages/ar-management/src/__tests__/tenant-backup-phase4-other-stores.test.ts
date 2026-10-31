import { expect, it, vi } from 'vitest';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import {
  encodeKeyManagerTenantBackupRow,
  KEY_MANAGER_TENANT_BACKUP_DATASET,
} from '@authrim/ar-lib-core/services/tenant-portability/key-manager-dataset';
import { emptyKeyManagerTenantBackupSnapshot } from '@authrim/ar-lib-core/services/tenant-portability/key-manager-portability';
import {
  DIRECTORY_CONNECTOR_SECRETS_DATASET,
  encodeDirectoryConnectorSecretBackupRow,
  encodeSamlLocalSigningBackupRow,
  SAML_LOCAL_SIGNING_DATASET,
} from '../tenant-backup-phase4-record-datasets';
import { exportPortableUpstreamProviderSecretsRow } from '@authrim/ar-lib-core/services/tenant-portability/portable-upstream-provider-secrets';
import {
  createPhase4OtherStoreHandlers,
  type Phase4OtherStorePorts,
} from '../tenant-backup-phase4-other-stores';

const context = {
  lease: { tenantId: 'tenant-a' },
  signal: new AbortController().signal,
} as TenantBackupStepContext;

async function fixture() {
  const rows = {
    'core.oauth_clients': JSON.stringify({
      tenant_id: ['text', 'tenant-a'],
      client_id: ['text', 'client-a'],
      logout_webhook_secret_encrypted: ['null', null],
    }),
    'core.upstream_providers': await exportPortableUpstreamProviderSecretsRow(
      JSON.stringify({
        id: ['text', 'provider-a'],
        tenant_id: ['text', 'tenant-a'],
        client_secret_encrypted: ['text', ''],
        private_key_jwk_encrypted: ['null', null],
        public_key_jwk: ['null', null],
      }),
      undefined
    ),
  } as const;
  const verifySidecarValue = vi.fn(async (...args: unknown[]) => {
    const field = args[3] as string;
    const matches = args[4] as (stored: string | null) => Promise<boolean>;
    expect(await matches(field === 'client_secret_encrypted' ? '' : null)).toBe(true);
  });
  const load = vi.fn<Phase4OtherStorePorts['load']>(
    async (_context, _digest, _purpose, datasetId) => ({
      policy: {
        dataset: { id: datasetId },
        verificationIgnoredColumns:
          datasetId === 'core.oauth_clients'
            ? ['logout_webhook_secret_encrypted']
            : ['client_secret_encrypted', 'private_key_jwk_encrypted'],
      } as never,
      manifest: {} as never,
      target: { verifySidecarValue } as never,
      readNextValidatedRow: async ({ sourceCursor }) =>
        sourceCursor === null ? { rowJson: rows[datasetId], nextCursor: 'row:1' } : null,
    })
  );
  const keyManagerRow = new TextDecoder()
    .decode(
      await encodeKeyManagerTenantBackupRow('tenant-a', emptyKeyManagerTenantBackupSnapshot())
    )
    .trimEnd();
  const loadKeyManager = vi.fn<Phase4OtherStorePorts['loadKeyManager']>(async () => ({
    policy: { dataset: KEY_MANAGER_TENANT_BACKUP_DATASET } as never,
    manifest: {} as never,
    readNextValidatedRow: async ({ sourceCursor }) =>
      sourceCursor === null ? { rowJson: keyManagerRow, nextCursor: 'row:1' } : null,
  }));
  const importKeyManager = vi.fn(async () => {});
  const verifyKeyManager = vi.fn(async () => true);
  const recordRows = {
    [SAML_LOCAL_SIGNING_DATASET.id]: new TextDecoder()
      .decode(encodeSamlLocalSigningBackupRow('tenant-a', { tenantId: 'tenant-a' }))
      .trimEnd(),
    [DIRECTORY_CONNECTOR_SECRETS_DATASET.id]: new TextDecoder()
      .decode(
        encodeDirectoryConnectorSecretBackupRow('tenant-a', 'campus', {
          active: {
            keyId: 'kid-a',
            secret: 'wwsec_a',
            createdAt: '2026-09-15T00:00:00.000Z',
          },
        })
      )
      .trimEnd(),
  };
  const loadRecord = vi.fn<Phase4OtherStorePorts['loadRecord']>(
    async (_context, _digest, _purpose, datasetId) => ({
      policy: {
        dataset:
          datasetId === SAML_LOCAL_SIGNING_DATASET.id
            ? SAML_LOCAL_SIGNING_DATASET
            : DIRECTORY_CONNECTOR_SECRETS_DATASET,
      } as never,
      manifest: {} as never,
      readNextValidatedRow: async ({ sourceCursor }) =>
        sourceCursor === null ? { rowJson: recordRows[datasetId], nextCursor: 'row:1' } : null,
    })
  );
  const validateSamlBundle = vi.fn(async () => {});
  const importSamlBundle = vi.fn(async () => {});
  const verifySamlBundle = vi.fn(async () => true);
  const importDirectorySecret = vi.fn(async () => {});
  const verifyDirectorySecret = vi.fn(async () => true);
  return {
    load,
    loadKeyManager,
    importKeyManager,
    verifyKeyManager,
    loadRecord,
    validateSamlBundle,
    importSamlBundle,
    verifySamlBundle,
    importDirectorySecret,
    verifyDirectorySecret,
    verifySidecarValue,
  };
}

async function runToCompletion(
  run: (cursor: string | null) => Promise<{ cursor: string | null; done: boolean }>
) {
  let cursor: string | null = null;
  for (let step = 0; step < 12; step += 1) {
    const result = await run(cursor);
    if (result.done) return step + 1;
    expect(result.cursor).not.toBe(cursor);
    cursor = result.cursor;
  }
  throw new Error('handler_did_not_complete');
}

it('walks the Phase 3 and Phase 4 secret datasets in a stable resumable order', async () => {
  const state = await fixture();
  const handlers = createPhase4OtherStoreHandlers({}, state);
  expect(
    await runToCompletion((cursor) => handlers.restoreOtherStores(context, 'ab'.repeat(32), cursor))
  ).toBe(10);
  expect(
    await runToCompletion((cursor) => handlers.verifyOtherStores(context, 'ab'.repeat(32), cursor))
  ).toBe(10);
  expect(state.load.mock.calls.map((call) => [call[2], call[3]])).toEqual([
    ['restore', 'core.oauth_clients'],
    ['restore', 'core.oauth_clients'],
    ['restore', 'core.upstream_providers'],
    ['restore', 'core.upstream_providers'],
    ['verify', 'core.oauth_clients'],
    ['verify', 'core.oauth_clients'],
    ['verify', 'core.upstream_providers'],
    ['verify', 'core.upstream_providers'],
  ]);
  expect(state.verifySidecarValue).toHaveBeenCalledTimes(6);
  expect(state.importKeyManager).toHaveBeenCalledOnce();
  expect(state.verifyKeyManager).toHaveBeenCalledOnce();
  expect(state.importSamlBundle).toHaveBeenCalledOnce();
  expect(state.verifySamlBundle).toHaveBeenCalledOnce();
  expect(state.importDirectorySecret).toHaveBeenCalledOnce();
  expect(state.verifyDirectorySecret).toHaveBeenCalledOnce();
});

it('rejects cross-purpose cursors and installed policy mismatches', async () => {
  const state = await fixture();
  const handlers = createPhase4OtherStoreHandlers({}, state);
  const first = await handlers.restoreOtherStores(context, 'ab'.repeat(32), null);
  await expect(handlers.verifyOtherStores(context, 'ab'.repeat(32), first.cursor)).rejects.toThrow(
    'backup_phase4_other_store_invalid'
  );
  state.load.mockResolvedValueOnce({
    ...(await state.load(context, 'ab'.repeat(32), 'restore', 'core.oauth_clients')),
    policy: { dataset: { id: 'core.upstream_providers' } } as never,
  });
  await expect(handlers.restoreOtherStores(context, 'ab'.repeat(32), null)).rejects.toThrow(
    'backup_phase4_other_store_invalid'
  );
});
