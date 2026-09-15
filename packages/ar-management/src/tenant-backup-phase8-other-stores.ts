import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { phase8RestoreHoldReason } from '@authrim/ar-lib-core/services/tenant-portability/phase8-restore-holds';
import { PHASE8_RESTORED_SENSITIVE_COLUMNS } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-references';
import {
  restorePortableTotpSecret,
  verifyPortableTotpSecret,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-totp-secret';
import {
  restorePortableOperationalLogDetail,
  verifyPortableOperationalLogDetail,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-operational-log-detail';
import {
  restorePortableLinkedIdentityTokens,
  verifyPortableLinkedIdentityTokens,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-linked-identity-tokens';
import {
  restorePortablePiiLogValues,
  verifyPortablePiiLogValues,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-pii-log-values';
import type { Phase3OtherStoreSource } from './tenant-backup-phase3-other-stores';
import {
  createPhase5OtherStoreHandlers,
  type Phase5OtherStorePorts,
} from './tenant-backup-phase5-other-stores';
import type { Env } from '@authrim/ar-lib-core';
import {
  decodePortableUserAvatar,
  USER_AVATARS_DATASET,
} from '@authrim/ar-lib-core/services/tenant-portability/phase5-record-datasets';

type Purpose = 'restore' | 'verify';
const USER_AVATAR_DATASET_ID = 'users.public_avatars' as const;
type DatasetId =
  | 'core.notification_delivery_intents'
  | 'core.operational_logs'
  | 'core.totp_credentials'
  | 'pii.linked_identities'
  | 'pii.pii_log'
  | 'users.public_avatars';

type SqlDatasetId = Exclude<DatasetId, typeof USER_AVATAR_DATASET_ID>;

const DATASETS: readonly DatasetId[] = [
  'core.notification_delivery_intents',
  'core.operational_logs',
  'core.totp_credentials',
  'pii.linked_identities',
  'pii.pii_log',
  USER_AVATAR_DATASET_ID,
];

interface Cursor {
  version: 1;
  purpose: Purpose;
  stage: 'phase5' | 'phase8';
  datasetId: DatasetId | null;
  sourceCursor: string | null;
}

export interface Phase8OtherStorePorts extends Phase5OtherStorePorts {
  loadPhase8Sqlite(
    context: TenantBackupStepContext,
    planDigest: string,
    purpose: Purpose,
    datasetId: SqlDatasetId
  ): Promise<Phase3OtherStoreSource>;
  loadPhase8Record(
    context: TenantBackupStepContext,
    planDigest: string,
    purpose: Purpose,
    datasetId: typeof USER_AVATAR_DATASET_ID
  ): Promise<Omit<Phase3OtherStoreSource, 'target'>>;
  restorePhase8Envelope(
    context: TenantBackupStepContext,
    datasetId: SqlDatasetId,
    source: Phase3OtherStoreSource,
    rowJson: string
  ): Promise<void>;
  verifyPhase8Envelope(
    context: TenantBackupStepContext,
    datasetId: SqlDatasetId,
    source: Phase3OtherStoreSource,
    rowJson: string
  ): Promise<boolean>;
}

function invalid(): never {
  throw new Error('backup_phase8_other_store_invalid');
}

function encode(cursor: Cursor): string {
  const value = JSON.stringify(cursor);
  if (value.length > 4096) invalid();
  return value;
}

function parse(value: string | null, purpose: Purpose): Cursor {
  if (value === null)
    return { version: 1, purpose, stage: 'phase5', datasetId: null, sourceCursor: null };
  try {
    const cursor = JSON.parse(value) as Cursor;
    if (
      !cursor ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor) ||
      Object.keys(cursor).sort().join(',') !== 'datasetId,purpose,sourceCursor,stage,version' ||
      cursor.version !== 1 ||
      cursor.purpose !== purpose ||
      !['phase5', 'phase8'].includes(cursor.stage) ||
      (cursor.stage === 'phase5' && cursor.datasetId !== null) ||
      (cursor.stage === 'phase8' && !DATASETS.includes(cursor.datasetId as DatasetId)) ||
      (cursor.sourceCursor !== null &&
        (typeof cursor.sourceCursor !== 'string' ||
          !cursor.sourceCursor ||
          cursor.sourceCursor.length > 3072))
    )
      invalid();
    return cursor;
  } catch {
    return invalid();
  }
}

function advance(datasetId: DatasetId, purpose: Purpose) {
  const index = DATASETS.indexOf(datasetId) + 1;
  return index === DATASETS.length
    ? { cursor: null, done: true }
    : {
        cursor: encode({
          version: 1,
          purpose,
          stage: 'phase8',
          datasetId: DATASETS[index],
          sourceCursor: null,
        }),
        done: false,
      };
}

function targetKeyVersion(env: Pick<Env, 'PII_ENCRYPTION_KEY_VERSION'>): number {
  const value = env.PII_ENCRYPTION_KEY_VERSION ?? '1';
  if (!/^[1-9][0-9]{0,8}$/.test(value)) invalid();
  return Number(value);
}

/** Apply target-environment ciphertext only after the portable rows are fenced in staging. */
export function createPhase8OtherStoreHandlers(
  env: Pick<Env, 'RP_TOKEN_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY_VERSION'>,
  ports: Phase8OtherStorePorts
) {
  const phase5 = createPhase5OtherStoreHandlers(env, ports);
  const run = async (
    context: TenantBackupStepContext,
    planDigest: string,
    cursorValue: string | null,
    purpose: Purpose
  ): Promise<{ cursor: string | null; done: boolean }> => {
    if (!/^[a-f0-9]{64}$/.test(planDigest)) invalid();
    const cursor = parse(cursorValue, purpose);
    context.signal.throwIfAborted();
    if (cursor.stage === 'phase5') {
      const result =
        purpose === 'restore'
          ? await phase5.restoreOtherStores(context, planDigest, cursor.sourceCursor)
          : await phase5.verifyOtherStores(context, planDigest, cursor.sourceCursor);
      if (!result.done)
        return {
          cursor: encode({ ...cursor, sourceCursor: result.cursor }),
          done: false,
        };
      return {
        cursor: encode({
          version: 1,
          purpose,
          stage: 'phase8',
          datasetId: DATASETS[0],
          sourceCursor: null,
        }),
        done: false,
      };
    }

    const datasetId = cursor.datasetId ?? invalid();
    if (datasetId === USER_AVATAR_DATASET_ID) {
      const source = await ports.loadPhase8Record(context, planDigest, purpose, datasetId);
      if (source.policy.dataset.id !== datasetId) invalid();
      const row = await source.readNextValidatedRow({ sourceCursor: cursor.sourceCursor });
      context.signal.throwIfAborted();
      if (row === null) return advance(datasetId, purpose);
      if (!row.nextCursor || row.nextCursor === cursor.sourceCursor) invalid();
      const avatar = await decodePortableUserAvatar(row.rowJson, context.lease.tenantId);
      if (purpose === 'restore') await ports.importAsset(context, avatar);
      else if (!(await ports.verifyAsset(context, avatar))) invalid();
      context.signal.throwIfAborted();
      return { cursor: encode({ ...cursor, sourceCursor: row.nextCursor }), done: false };
    }
    const source = await ports.loadPhase8Sqlite(context, planDigest, purpose, datasetId);
    if (source.policy.dataset.id !== datasetId) invalid();
    const expectedColumns = PHASE8_RESTORED_SENSITIVE_COLUMNS[datasetId] ?? invalid();
    const ignored = source.policy.verificationIgnoredColumns ?? [];
    if (
      expectedColumns.some((column) => !ignored.includes(column)) ||
      ignored.some((column) => !expectedColumns.includes(column))
    )
      invalid();
    const row = await source.readNextValidatedRow({ sourceCursor: cursor.sourceCursor });
    context.signal.throwIfAborted();
    if (row === null) return advance(datasetId, purpose);
    if (!row.nextCursor || row.nextCursor === cursor.sourceCursor) invalid();

    // The SQL restore intentionally omitted quarantined work, so its sidecar must do the same.
    if (phase8RestoreHoldReason(datasetId, row.rowJson) === null) {
      if (
        datasetId === 'core.totp_credentials' ||
        datasetId === 'core.operational_logs' ||
        datasetId === 'pii.linked_identities' ||
        datasetId === 'pii.pii_log'
      ) {
        const common = {
          target: source.target,
          policy: source.policy,
          manifest: source.manifest,
          rowJson: row.rowJson,
          targetKey: env.PII_ENCRYPTION_KEY,
          targetKeyVersion: targetKeyVersion(env),
        };
        if (datasetId === 'pii.linked_identities') {
          const linked = {
            target: source.target,
            policy: source.policy,
            manifest: source.manifest,
            rowJson: row.rowJson,
            targetKey: env.RP_TOKEN_ENCRYPTION_KEY,
          };
          if (purpose === 'restore') await restorePortableLinkedIdentityTokens(linked);
          else await verifyPortableLinkedIdentityTokens(linked);
        } else if (datasetId === 'pii.pii_log') {
          const pii = {
            ...common,
            targetKey: env.PII_ENCRYPTION_KEY,
          };
          const mode =
            purpose === 'restore'
              ? await restorePortablePiiLogValues(pii)
              : await verifyPortablePiiLogValues(pii);
          if (mode === 'external') {
            if (purpose === 'restore')
              await ports.restorePhase8Envelope(context, datasetId, source, row.rowJson);
            else if (!(await ports.verifyPhase8Envelope(context, datasetId, source, row.rowJson)))
              invalid();
          }
        } else if (datasetId === 'core.totp_credentials') {
          if (purpose === 'restore') await restorePortableTotpSecret(common);
          else await verifyPortableTotpSecret(common);
        } else if (purpose === 'restore') await restorePortableOperationalLogDetail(common);
        else await verifyPortableOperationalLogDetail(common);
      } else if (purpose === 'restore')
        await ports.restorePhase8Envelope(context, datasetId, source, row.rowJson);
      else if (!(await ports.verifyPhase8Envelope(context, datasetId, source, row.rowJson)))
        invalid();
    }
    context.signal.throwIfAborted();
    return { cursor: encode({ ...cursor, sourceCursor: row.nextCursor }), done: false };
  };
  return {
    restoreOtherStores: (
      context: TenantBackupStepContext,
      planDigest: string,
      cursor: string | null
    ) => run(context, planDigest, cursor, 'restore'),
    verifyOtherStores: (
      context: TenantBackupStepContext,
      planDigest: string,
      cursor: string | null
    ) => run(context, planDigest, cursor, 'verify'),
  };
}
