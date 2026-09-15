import { expect, it, vi } from 'vitest';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import {
  encodeKeyManagerTenantBackupRow,
  KEY_MANAGER_TENANT_BACKUP_DATASET,
} from '@authrim/ar-lib-core/services/tenant-portability/key-manager-dataset';
import { emptyKeyManagerTenantBackupSnapshot } from '@authrim/ar-lib-core/services/tenant-portability/key-manager-portability';
import { encodePortablePublicAsset } from '@authrim/ar-lib-core/services/tenant-portability/phase5-record-datasets';
import {
  DIRECTORY_CONNECTOR_SECRETS_DATASET,
  encodeDirectoryConnectorSecretBackupRow,
  encodeSamlLocalSigningBackupRow,
  SAML_LOCAL_SIGNING_DATASET,
} from '../tenant-backup-phase4-record-datasets';
import { exportPortableUpstreamProviderSecretsRow } from '@authrim/ar-lib-core/services/tenant-portability/portable-upstream-provider-secrets';
import type { Phase3OtherStoreSource } from '../tenant-backup-phase3-other-stores';
import type { Phase4OtherStorePorts } from '../tenant-backup-phase4-other-stores';
import {
  createPhase5OtherStoreHandlers,
  type Phase5OtherStorePorts,
} from '../tenant-backup-phase5-other-stores';

const context = {
  lease: { tenantId: 'tenant-a' },
  signal: new AbortController().signal,
} as TenantBackupStepContext;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trimEnd();
const text = (value: string) => ['text', value] as const;
const integer = (value: number) => ['integer', String(value)] as const;

async function fixture() {
  const phase4Rows = {
    'core.oauth_clients': JSON.stringify({
      tenant_id: text('tenant-a'),
      client_id: text('client-a'),
      logout_webhook_secret_encrypted: ['null', null],
    }),
    'core.upstream_providers': await exportPortableUpstreamProviderSecretsRow(
      JSON.stringify({
        id: text('provider-a'),
        tenant_id: text('tenant-a'),
        client_secret_encrypted: text(''),
        private_key_jwk_encrypted: ['null', null],
        public_key_jwk: ['null', null],
      }),
      undefined
    ),
  };
  const phase4RecordRows = {
    [SAML_LOCAL_SIGNING_DATASET.id]: decode(
      encodeSamlLocalSigningBackupRow('tenant-a', { tenantId: 'tenant-a' })
    ),
    [DIRECTORY_CONNECTOR_SECRETS_DATASET.id]: decode(
      encodeDirectoryConnectorSecretBackupRow('tenant-a', 'campus', {
        active: {
          keyId: 'kid-a',
          secret: 'secret-a',
          createdAt: '2026-09-15T00:00:00.000Z',
        },
      })
    ),
  };
  const keyManagerRow = decode(
    await encodeKeyManagerTenantBackupRow('tenant-a', emptyKeyManagerTenantBackupSnapshot())
  );
  const phase4: Phase4OtherStorePorts = {
    load: vi.fn(async (_context, _digest, _purpose, datasetId) => ({
      policy: {
        dataset: { id: datasetId },
        verificationIgnoredColumns:
          datasetId === 'core.oauth_clients'
            ? ['logout_webhook_secret_encrypted']
            : ['client_secret_encrypted', 'private_key_jwk_encrypted'],
      } as never,
      manifest: {} as never,
      target: {
        verifySidecarValue: vi.fn(async (...args: unknown[]) => {
          const field = args[3] as string;
          const matches = args[4] as (stored: string | null) => Promise<boolean>;
          expect(await matches(field === 'client_secret_encrypted' ? '' : null)).toBe(true);
        }),
      } as never,
      readNextValidatedRow: async ({ sourceCursor }: { sourceCursor: string | null }) =>
        sourceCursor === null
          ? { rowJson: phase4Rows[datasetId as keyof typeof phase4Rows], nextCursor: 'row:1' }
          : null,
    })),
    loadKeyManager: vi.fn(async () => ({
      policy: { dataset: KEY_MANAGER_TENANT_BACKUP_DATASET } as never,
      manifest: {} as never,
      readNextValidatedRow: async ({ sourceCursor }: { sourceCursor: string | null }) =>
        sourceCursor === null ? { rowJson: keyManagerRow, nextCursor: 'row:1' } : null,
    })),
    importKeyManager: vi.fn(async () => {}),
    verifyKeyManager: vi.fn(async () => true),
    loadRecord: vi.fn(async (_context, _digest, _purpose, datasetId) => ({
      policy: { dataset: { id: datasetId } } as never,
      manifest: {} as never,
      readNextValidatedRow: async ({ sourceCursor }: { sourceCursor: string | null }) =>
        sourceCursor === null
          ? {
              rowJson: phase4RecordRows[datasetId as keyof typeof phase4RecordRows],
              nextCursor: 'row:1',
            }
          : null,
    })),
    validateSamlBundle: vi.fn(async () => {}),
    importSamlBundle: vi.fn(async () => {}),
    verifySamlBundle: vi.fn(async () => true),
    importDirectorySecret: vi.fn(async () => {}),
    verifyDirectorySecret: vi.fn(async () => true),
  };

  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', png));
  const digest = [...sha].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const phase5Rows = {
    'core.webhook_configs': JSON.stringify({
      id: text('webhook-a'),
      tenant_id: text('tenant-a'),
      secret_encrypted: ['null', null],
    }),
    'admin.credential_secret_bodies': JSON.stringify({ envelope_json: text('{}') }),
    'admin.logging_key_material_bodies': JSON.stringify({ envelope_json: text('{}') }),
    'flows-ui.public_assets': decode(
      await encodePortablePublicAsset({
        tenantId: 'tenant-a',
        key: 'public/tenant-a/login-ui/logo/logo.png',
        contentType: 'image/png',
        sha256: digest,
        bytes: png,
      })
    ),
    'integrations.plugin_runner_configuration': JSON.stringify({
      tenant_id: text('tenant-a'),
      installation_id: text('installation-a'),
      plugin_id: text('plugin-a'),
      version_digest: text('a'.repeat(64)),
      contract_version: integer(1),
      config_json: text('{}'),
    }),
    'placement-rebuild.logical_target_plan': JSON.stringify({
      tenant_id: text('tenant-a'),
      plan_json: text(
        JSON.stringify({
          version: 1,
          databaseRoles: ['tenant_core'],
          rebuild: ['lookup'],
          externalPrerequisiteIds: [],
        })
      ),
    }),
  };
  const source = (datasetId: keyof typeof phase5Rows): Omit<Phase3OtherStoreSource, 'target'> => ({
    policy: {
      dataset: { id: datasetId },
      ...([
        'core.webhook_configs',
        'admin.credential_secret_bodies',
        'admin.logging_key_material_bodies',
      ].includes(datasetId)
        ? {
            verificationIgnoredColumns:
              datasetId === 'core.webhook_configs' ? ['secret_encrypted'] : ['envelope_json'],
          }
        : {}),
    } as never,
    manifest: {} as never,
    readNextValidatedRow: async ({ sourceCursor }: { sourceCursor: string | null }) =>
      sourceCursor === null ? { rowJson: phase5Rows[datasetId], nextCursor: 'row:1' } : null,
  });
  const ports = {
    phase4,
    loadSqlite: vi.fn(async (_context, _digest, _purpose, datasetId) => ({
      ...source(datasetId),
      target: {
        verifySidecarValue: vi.fn(async (...args: unknown[]) => {
          const matches = args[4] as (stored: string | null) => Promise<boolean>;
          expect(await matches(null)).toBe(true);
        }),
      } as never,
    })),
    loadRecord: vi.fn(async (_context, _digest, _purpose, datasetId) => source(datasetId)),
    restoreAdminEnvelope: vi.fn(async () => {}),
    verifyAdminEnvelope: vi.fn(async () => true),
    importAsset: vi.fn(async () => {}),
    verifyAsset: vi.fn(async () => true),
    importPlugin: vi.fn(async () => {}),
    verifyPlugin: vi.fn(async () => true),
    prepareLogicalTarget: vi.fn(async () => {}),
    verifyLogicalTarget: vi.fn(async () => true),
  } satisfies Phase5OtherStorePorts;
  return ports;
}

async function complete(
  run: (cursor: string | null) => Promise<{ cursor: string | null; done: boolean }>
) {
  let cursor: string | null = null;
  for (let step = 1; step <= 24; step += 1) {
    const result = await run(cursor);
    if (result.done) return step;
    expect(result.cursor).not.toBe(cursor);
    cursor = result.cursor;
  }
  throw new Error('handler_did_not_complete');
}

it('restores and verifies Phase 4 plus all Phase 5 sidecars in stable resumable order', async () => {
  const ports = await fixture();
  const handlers = createPhase5OtherStoreHandlers({}, ports);
  await expect(
    complete((cursor) => handlers.restoreOtherStores(context, 'ab'.repeat(32), cursor))
  ).resolves.toBe(22);
  await expect(
    complete((cursor) => handlers.verifyOtherStores(context, 'ab'.repeat(32), cursor))
  ).resolves.toBe(22);
  expect(ports.importAsset).toHaveBeenCalledOnce();
  expect(ports.verifyAsset).toHaveBeenCalledOnce();
  expect(ports.importPlugin).toHaveBeenCalledOnce();
  expect(ports.verifyPlugin).toHaveBeenCalledOnce();
  expect(ports.prepareLogicalTarget).toHaveBeenCalledOnce();
  expect(ports.verifyLogicalTarget).toHaveBeenCalledOnce();
  expect(ports.restoreAdminEnvelope).toHaveBeenCalledTimes(2);
  expect(ports.verifyAdminEnvelope).toHaveBeenCalledTimes(2);
});

it('rejects a restore cursor reused for verification', async () => {
  const ports = await fixture();
  const handlers = createPhase5OtherStoreHandlers({}, ports);
  const first = await handlers.restoreOtherStores(context, 'ab'.repeat(32), null);
  await expect(handlers.verifyOtherStores(context, 'ab'.repeat(32), first.cursor)).rejects.toThrow(
    'backup_phase5_other_store_invalid'
  );
});
