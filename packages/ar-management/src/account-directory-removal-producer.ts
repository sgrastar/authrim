import {
  createLookupBlindIndexes,
  insertPreparedAccountDirectoryRemovals,
  markAccountDirectoryRemovalReady,
  validateAccountDirectoryPublication,
  validateAccountDirectoryRemovalPublication,
  type AccountDirectoryPublication,
  type AccountDirectoryPublishResult,
  type AccountDirectoryRemovalPublication,
  type DatabaseAdapter,
  type Env,
  type LookupBlindIndex,
} from '@authrim/ar-lib-core';
import { loadLookupHmacRuntimeKeys } from './lookup-hmac-runtime';

const MAX_INDEXES_PER_REMOVAL = 24;

interface EmailRow {
  value_json: string | null;
}

interface ExternalSubjectRow {
  provider_id: string;
  provider_user_id: string;
}

interface PasskeySubjectRow {
  credential_id: string;
  rp_id: string;
}

interface AnonymousDeviceSubjectRow {
  device_id_hash: string;
}

interface AccountRouteRow {
  id: string;
  account_route_generation: number | string;
  payload_json: string;
}

export interface PrepareAccountDirectoryRemovalInput {
  tenantId: string;
  userId: string;
  core: DatabaseAdapter;
  pii: DatabaseAdapter;
}

function hex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function operationPrefix(tenantId: string, accountId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`account-delete\0${tenantId}\0${accountId}`)
  );
  return `account-delete:${hex(digest).slice(0, 32)}`;
}

function parseEmail(row: EmailRow | null): string | null {
  if (!row?.value_json) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.value_json) as unknown;
  } catch {
    throw new Error('account_directory_removal_email_invalid');
  }
  if (typeof value !== 'string') throw new Error('account_directory_removal_email_invalid');
  return value;
}

function indexIdentity(index: LookupBlindIndex): string {
  return `${index.indexKind}:${index.normalizationVersion}:${index.hmacKeyGeneration}:${index.digest}`;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result.length > 0 ? result : [[]];
}

async function activeRoute(
  core: DatabaseAdapter,
  tenantId: string,
  accountId: string
): Promise<AccountDirectoryPublication> {
  const row = await core.queryOne<AccountRouteRow>(
    `SELECT account.id, account.account_route_generation, outbox.payload_json
      FROM identity_accounts account
      JOIN account_routing_outbox outbox
         ON outbox.tenant_id = account.tenant_id AND outbox.account_id = account.id
        AND outbox.event_kind = 'account_created'
        AND outbox.route_generation = account.account_route_generation
      WHERE account.tenant_id = ? AND account.id = ?
        AND account.lifecycle_state IN ('active', 'deprovisioned')
        AND account.directory_publication_state = 'active'
      ORDER BY CASE outbox.status WHEN 'succeeded' THEN 0 ELSE 1 END, outbox.outbox_id
      LIMIT 1`,
    [tenantId, accountId]
  );
  if (!row || row.id !== accountId) throw new Error('account_directory_removal_route_missing');
  const publication = await validateAccountDirectoryPublication(
    JSON.parse(row.payload_json) as AccountDirectoryPublication
  );
  if (
    publication.tenantId !== tenantId ||
    publication.accountId !== accountId ||
    publication.routeProjection.accountRouteGeneration !== Number(row.account_route_generation)
  ) {
    throw new Error('account_directory_removal_route_mismatch');
  }
  return publication;
}

async function existingRemovals(
  core: DatabaseAdapter,
  tenantId: string,
  accountId: string
): Promise<AccountDirectoryRemovalPublication[]> {
  const rows = await core.query<{ payload_json: string }>(
    `SELECT payload_json FROM account_routing_outbox
      WHERE tenant_id = ? AND account_id = ? AND event_kind = 'account_deleted'
      ORDER BY outbox_id`,
    [tenantId, accountId]
  );
  return Promise.all(
    rows.map((row) =>
      validateAccountDirectoryRemovalPublication(
        JSON.parse(row.payload_json) as AccountDirectoryRemovalPublication
      )
    )
  );
}

export async function prepareAccountDirectoryRemoval(
  env: Env,
  input: PrepareAccountDirectoryRemovalInput,
  now = Math.floor(Date.now() / 1000)
): Promise<AccountDirectoryRemovalPublication[]> {
  if (!Number.isSafeInteger(now) || now < 1) throw new Error('invalid_directory_removal_time');
  const accountId = `account:${input.userId}`;
  const existing = await existingRemovals(input.core, input.tenantId, accountId);
  if (existing.length > 0) return existing;

  const route = await activeRoute(input.core, input.tenantId, accountId);
  const [emailRow, externalSubjects, passkeySubjects, anonymousDevices, runtimeKeys] =
    await Promise.all([
      input.pii.queryOne<EmailRow>(
        `SELECT value_json FROM identity_sensitive_values
        WHERE tenant_id = ? AND owner_type = 'runtime_user' AND owner_id = ?
          AND value_key = 'email' AND lifecycle_state = 'active'`,
        [input.tenantId, input.userId]
      ),
      input.pii.query<ExternalSubjectRow>(
        `SELECT provider_id, provider_user_id FROM linked_identities
        WHERE tenant_id = ? AND user_id = ? ORDER BY provider_id, provider_user_id`,
        [input.tenantId, input.userId]
      ),
      input.core.query<PasskeySubjectRow>(
        `SELECT credential_id, rp_id FROM passkeys
        WHERE tenant_id = ? AND user_id = ? AND rp_id IS NOT NULL AND rp_id <> ''
        ORDER BY rp_id, credential_id`,
        [input.tenantId, input.userId]
      ),
      input.core.query<AnonymousDeviceSubjectRow>(
        `SELECT device_id_hash FROM anonymous_devices
          WHERE tenant_id = ? AND user_id = ? AND is_active = TRUE
          ORDER BY device_id_hash`,
        [input.tenantId, input.userId]
      ),
      loadLookupHmacRuntimeKeys(env),
    ]);
  const email = parseEmail(emailRow);
  const accountIndexes = await createLookupBlindIndexes(
    'account_id',
    accountId,
    runtimeKeys.readKeys
  );
  const removable = [
    ...(email ? await createLookupBlindIndexes('email_exact', email, runtimeKeys.readKeys) : []),
    ...(
      await Promise.all(
        [
          ...externalSubjects.map((subject) => ({
            issuer: subject.provider_id,
            subject: subject.provider_user_id,
          })),
          ...passkeySubjects.map((passkey) => ({
            issuer: `urn:authrim:passkey:${passkey.rp_id.toLowerCase()}`,
            subject: passkey.credential_id,
          })),
          ...anonymousDevices.map((device) => ({
            issuer: 'urn:authrim:anonymous-device:v1',
            subject: device.device_id_hash,
          })),
        ].map((subject) =>
          createLookupBlindIndexes('external_subject', subject, runtimeKeys.readKeys)
        )
      )
    ).flat(),
  ];
  const uniqueRemovable = Array.from(
    new Map(removable.map((index) => [indexIdentity(index), index])).values()
  ).sort((left, right) => indexIdentity(left).localeCompare(indexIdentity(right)));
  const prefix = await operationPrefix(input.tenantId, accountId);
  const publications = await Promise.all(
    chunks(uniqueRemovable, MAX_INDEXES_PER_REMOVAL - accountIndexes.length).map((chunk, index) =>
      validateAccountDirectoryRemovalPublication({
        operationId: `${prefix}:${index + 1}`,
        tenantId: input.tenantId,
        accountId,
        idempotencyKey: `${prefix}:${index + 1}`,
        routeProjection: route.routeProjection,
        scope: 'account',
        indexes: [...accountIndexes, ...chunk],
      })
    )
  );
  await insertPreparedAccountDirectoryRemovals(input.core, publications, now);
  return publications;
}

export async function markAccountDirectoryRemovalsReady(
  core: DatabaseAdapter,
  publications: readonly AccountDirectoryRemovalPublication[],
  now = Math.floor(Date.now() / 1000)
): Promise<void> {
  for (const publication of publications) {
    await markAccountDirectoryRemovalReady(core, publication.operationId, now);
  }
}

export async function eraseAccountPiiAfterDirectoryRemovalPrepared(
  pii: DatabaseAdapter,
  input: { tenantId: string; userId: string },
  now = Math.floor(Date.now() / 1000)
): Promise<void> {
  if (!Number.isSafeInteger(now) || now < 1) throw new Error('invalid_directory_removal_time');
  const accountId = `account:${input.userId}`;
  const statements = [
    {
      sql: `UPDATE identity_identifier_replacement_operations
          SET state = 'canceled', error_code = 'account_deleted', lease_owner = NULL,
              lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
        WHERE tenant_id = ? AND account_id = ? AND state NOT IN ('completed', 'canceled')`,
      params: [now, input.tenantId, accountId],
    },
    {
      sql: `UPDATE identity_identifier_replacement_outbox
          SET status = 'blocked', error_code = 'account_deleted', lease_owner = NULL,
              lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
        WHERE tenant_id = ? AND account_id = ? AND status IN ('pending', 'leased', 'retry')`,
      params: [now, input.tenantId, accountId],
    },
    {
      sql: `UPDATE identity_identifier_replacement_history
          SET old_value_json = NULL, new_value_json = NULL, raw_values_erased_at = ?
        WHERE raw_values_erased_at IS NULL AND operation_id IN (
          SELECT operation_id FROM identity_identifier_replacement_operations
           WHERE tenant_id = ? AND account_id = ? AND state IN ('completed', 'canceled')
        )`,
      params: [now, input.tenantId, accountId],
    },
    {
      sql: `UPDATE identity_identifier_replacement_challenges
          SET normalized_value_json = 'null', raw_value_erased_at = ?, updated_at = ?
        WHERE tenant_id = ? AND account_id = ? AND raw_value_erased_at IS NULL`,
      params: [now, now, input.tenantId, accountId],
    },
    {
      sql: `UPDATE external_identifier_unlink_operations
          SET state = 'blocked', issuer_json = NULL, subject_json = NULL,
              raw_values_erased_at = ?, error_code = 'account_deleted',
              lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?
        WHERE tenant_id = ? AND account_id = ? AND state <> 'completed'`,
      params: [now, now, input.tenantId, accountId],
    },
    {
      sql: `UPDATE identity_sensitive_values
          SET value_json = NULL, lifecycle_state = 'deleted', updated_at = ?
        WHERE tenant_id = ? AND owner_type = 'runtime_user' AND owner_id = ?`,
      params: [now, input.tenantId, input.userId],
    },
    {
      sql: 'DELETE FROM linked_identities WHERE tenant_id = ? AND user_id = ?',
      params: [input.tenantId, input.userId],
    },
    {
      sql: `DELETE FROM pairwise_subject_identifiers
        WHERE tenant_id = ? AND user_id = ? AND EXISTS (
          SELECT 1 FROM users_pii AS tenant_parent
           WHERE tenant_parent.id = pairwise_subject_identifiers.user_id
             AND tenant_parent.tenant_id = ?
        )`,
      params: [input.tenantId, input.userId, input.tenantId],
    },
    {
      sql: `DELETE FROM subject_identifiers
        WHERE tenant_id = ? AND subject_id = ?`,
      params: [input.tenantId, input.userId],
    },
  ];
  const results = await pii.batch(statements);
  if (results.length !== statements.length || results.some((result) => !result.success)) {
    throw new Error('account_pii_erasure_batch_failed');
  }
}

export async function attemptImmediateAccountDirectoryRemovals(
  binding: Env['ACCOUNT_DIRECTORY'],
  publications: readonly AccountDirectoryRemovalPublication[]
): Promise<AccountDirectoryPublishResult[]> {
  const results: AccountDirectoryPublishResult[] = [];
  for (const publication of publications) {
    if (binding?.removeAccountDirectory) {
      try {
        const result = await binding.removeAccountDirectory(publication);
        if (
          result.status === 201 &&
          result.accountId === publication.accountId &&
          result.operationId === publication.operationId
        ) {
          results.push(result);
          continue;
        }
      } catch {
        // The routing outbox owns retry.
      }
    }
    results.push({
      status: 202,
      accountId: publication.accountId,
      operationId: publication.operationId,
    });
  }
  return results;
}
