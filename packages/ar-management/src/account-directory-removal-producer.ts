import {
  createLookupBlindIndexes,
  guestDirectoryRemovalOperationPrefix,
  CanonicalIdentityRepository,
  captureAccountDeletionSnapshot,
  deleteAnonymizationMappingStatement,
  forgetCachedAnonymizedUserId,
  insertPreparedAccountDirectoryRemovals,
  markAccountDirectoryRemovalReady,
  validateAccountDirectoryPublication,
  validateAccountDirectoryRemovalPublication,
  type AccountDirectoryPublication,
  type AccountDirectoryPublishResult,
  type AccountDirectoryRemovalPublication,
  type DatabaseAdapter,
  type Env,
  type GuestDeletionProgress,
  type GuestDeletionReceiptV2,
  type LookupBlindIndex,
  type LookupBlindIndexKey,
} from '@authrim/ar-lib-core';
import { loadLookupHmacRuntimeKeys } from './lookup-hmac-runtime';
import { createLookupBucketWriteResolver } from './lookup-bucket-write-route';

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

interface GuestResumeCredentialSubjectRow {
  resume_credential_hash: string;
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
  const [emailRow, externalSubjects, passkeySubjects, guestResumeCredentials, runtimeKeys] =
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
      input.core.query<GuestResumeCredentialSubjectRow>(
        `SELECT resume_credential_hash FROM guest_devices
          WHERE tenant_id = ? AND user_id = ? AND is_active = TRUE
          ORDER BY resume_credential_hash`,
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
          ...guestResumeCredentials.map((credential) => ({
            issuer: 'urn:authrim:guest-resume:v1',
            subject: credential.resume_credential_hash,
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
  input: { tenantId: string; userId: string; core: DatabaseAdapter },
  now = Math.floor(Date.now() / 1000)
): Promise<void> {
  if (!Number.isSafeInteger(now) || now < 1) throw new Error('invalid_directory_removal_time');
  const account = await new CanonicalIdentityRepository(
    input.core,
    input.tenantId
  ).findAccountByLegacyUserId(input.userId, {
    includeInactive: true,
    consistencyClass: 'primary_required',
  });
  if (account) await captureAccountDeletionSnapshot(pii, account);
  const accountId = `account:${input.userId}`;
  const statements = [
    {
      sql: `UPDATE guest_upgrade_operations SET state = CASE WHEN state = 'completed' THEN state ELSE 'canceled' END, proof_payload_json = NULL, reservation_publication_json = NULL, challenge_verifier = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE tenant_id = ? AND user_id = ?`,
      params: [now, input.tenantId, input.userId],
    },
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
    // The user's audit pseudonym: without it the unified event log's records of the user no
    // longer lead to the user. Deletion and anonymization write the tombstone before this, so a
    // late audit write does not create the mapping again.
    deleteAnonymizationMappingStatement(input.tenantId, input.userId),
  ];
  const results = await pii.batch(statements);
  if (results.length !== statements.length || results.some((result) => !result.success)) {
    throw new Error('account_pii_erasure_batch_failed');
  }
  forgetCachedAnonymizedUserId(input.tenantId, input.userId);
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

// Guest-specific bounded capture. Ordinary deletion above keeps its existing contract.
export interface GuestDirectoryCapturePage {
  publications: AccountDirectoryRemovalPublication[];
  cursor: string | null;
  highWater: string | null;
  done: boolean;
}
const GUEST_CAPTURE_PAGE = 8;
function guestSourceBytes(db: DatabaseAdapter, column: string): string {
  return db.getType() === 'postgres'
    ? `octet_length(${column})`
    : `length(CAST(${column} AS BLOB))`;
}
async function guestRemovalOperation(
  route: GuestDeletionReceiptV2,
  source: string
): Promise<string> {
  const suffix = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return `${await guestDirectoryRemovalOperationPrefix(route)}${hex(suffix).slice(0, 32)}`;
}
/** Pinned key generations must remain available; a rotation never silently changes a captured page. */
export async function guestDirectoryCaptureKeys(
  env: Env,
  generations: readonly number[]
): Promise<LookupBlindIndexKey[]> {
  const runtime = await loadLookupHmacRuntimeKeys(env, { bypassCache: true });
  const keys = generations.map((generation) =>
    runtime.readKeys.find((key) => key.generation === generation)
  );
  if (keys.some((key) => !key)) throw new Error('guest_directory_hmac_generation_unavailable');
  return keys.filter((key): key is LookupBlindIndexKey => !!key);
}
/** One frozen source page, no complete-account materialization or Promise.all fanout. */
export async function captureGuestDirectoryPage(input: {
  route: GuestDeletionReceiptV2;
  progress: GuestDeletionProgress;
  core: DatabaseAdapter;
  pii: DatabaseAdapter;
  keys: readonly LookupBlindIndexKey[];
}): Promise<GuestDirectoryCapturePage> {
  const { route, progress, core, pii } = input;
  if (
    route.execution.phase !== 'erasure_started' ||
    input.keys.length < 1 ||
    input.keys.length > 2 ||
    input.keys.some((key) => !progress.pinnedHmacGenerations.includes(key.generation))
  )
    throw new Error('guest_directory_capture_invalid');
  const accountIndexes = await createLookupBlindIndexes('account_id', route.accountId, input.keys);
  const publication = async (
    source: string,
    indexes: LookupBlindIndex[]
  ): Promise<AccountDirectoryRemovalPublication> => {
    const operationId = await guestRemovalOperation(route, source);
    return validateAccountDirectoryRemovalPublication({
      operationId,
      idempotencyKey: operationId,
      tenantId: route.tenantId,
      accountId: route.accountId,
      routeProjection: route.routeProjection,
      scope: 'account',
      indexes: [...accountIndexes, ...indexes],
    });
  };
  if (progress.stage === 'capture_email') {
    const row = await pii.queryOne<{ value_json: string | null; value_bytes: number | string }>(
      `SELECT CASE WHEN ${guestSourceBytes(pii, 'value_json')}<=4096 THEN value_json ELSE NULL END AS value_json,${guestSourceBytes(pii, 'value_json')} AS value_bytes
       FROM identity_sensitive_values WHERE tenant_id=? AND owner_type='runtime_user' AND owner_id=? AND value_key='email' AND lifecycle_state='active'`,
      [route.tenantId, route.userId],
      { consistencyClass: 'primary_required' }
    );
    if (row && Number(row.value_bytes) > 4096) throw new Error('guest_directory_email_invalid');
    const email = parseEmail(row);
    return {
      publications: [
        await publication(
          'account',
          email ? await createLookupBlindIndexes('email_exact', email, input.keys) : []
        ),
      ],
      cursor: null,
      highWater: null,
      done: true,
    };
  }
  const kind = progress.stage;
  let source: DatabaseAdapter, table: string, columns: string, predicate: string;
  if (kind === 'capture_linked') {
    source = pii;
    table = 'linked_identities';
    columns = `id,CASE WHEN ${guestSourceBytes(pii, 'provider_id')}<=2048 THEN provider_id ELSE NULL END AS issuer,CASE WHEN ${guestSourceBytes(pii, 'provider_user_id')}<=1024 THEN provider_user_id ELSE NULL END AS subject`;
    predicate = 'tenant_id=? AND user_id=?';
  } else if (kind === 'capture_passkeys') {
    source = core;
    table = 'passkeys';
    columns =
      "id,CASE WHEN rp_id IS NULL OR rp_id='' THEN 0 ELSE 1 END AS directory_eligible,CASE WHEN length(rp_id)<=253 THEN rp_id ELSE NULL END AS issuer,CASE WHEN length(credential_id)<=1024 THEN credential_id ELSE NULL END AS subject";
    predicate = 'tenant_id=? AND user_id=?';
  } else if (kind === 'capture_resume') {
    source = core;
    table = 'guest_devices';
    columns = "id,'urn:authrim:guest-resume:v1' AS issuer,resume_credential_hash AS subject";
    predicate = 'tenant_id=? AND user_id=?';
  } else throw new Error('guest_directory_capture_invalid');
  const high =
    progress.highWater ??
    (
      await source.queryOne<{ high: string | null }>(
        `SELECT MAX(id) AS high FROM ${table} WHERE ${predicate}`,
        [route.tenantId, route.userId],
        { consistencyClass: 'primary_required' }
      )
    )?.high ??
    null;
  if (high === null) return { publications: [], cursor: null, highWater: null, done: true };
  if (typeof high !== 'string' || new TextEncoder().encode(high).length > 256)
    throw new Error('guest_directory_capture_invalid');
  const rows = await source.query<{
    id: string;
    issuer: string | null;
    subject: string | null;
    directory_eligible?: number;
  }>(
    `SELECT ${columns} FROM ${table} WHERE ${predicate} AND id>? AND id<=? ORDER BY id LIMIT ?`,
    [route.tenantId, route.userId, progress.cursor ?? '', high, GUEST_CAPTURE_PAGE],
    { consistencyClass: 'primary_required' }
  );
  const publications: AccountDirectoryRemovalPublication[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (!row.id || new TextEncoder().encode(row.id).length > 256)
      throw new Error('guest_directory_subject_invalid');
    // The existing directory contract has no RP-derived index for these legitimate credentials.
    // Keep their PKs in the cursor and later drain every credential, including skipped rows.
    if (kind === 'capture_passkeys' && row.directory_eligible === 0) continue;
    if (!row.issuer || !row.subject) throw new Error('guest_directory_subject_invalid');
    const issuer =
      kind === 'capture_passkeys' ? `urn:authrim:passkey:${row.issuer.toLowerCase()}` : row.issuer;
    bytes += new TextEncoder().encode(row.id + issuer + row.subject).length;
    if (bytes > 32768) throw new Error('guest_directory_capture_budget_exceeded');
    publications.push(
      await publication(
        `${kind}:${row.id}`,
        await createLookupBlindIndexes(
          'external_subject',
          { issuer, subject: row.subject },
          input.keys
        )
      )
    );
  }
  const cursor = rows.at(-1)?.id ?? progress.cursor;
  return { publications, cursor, highWater: high, done: rows.length === 0 || cursor === high };
}

interface GuestReservationIdentity {
  virtual_bucket: number | string;
  tenant_id: string;
  index_kind: string;
  normalization_version: number | string;
  hmac_key_generation: number | string;
  identifier_blind_digest: string;
  account_id: string;
  operation_id: string;
  reservation_state: string;
}
/** One original upgrade page; owned/absent rows retain the same-op released sentinel. */
export async function releaseGuestReservationPage(
  env: Env,
  input: {
    route: GuestDeletionReceiptV2;
    progress: GuestDeletionProgress;
    pii: DatabaseAdapter;
  }
): Promise<{ cursor: string | null; highWater: string | null; done: boolean }> {
  const { route, progress, pii } = input;
  if (progress.stage !== 'release_reservations' || route.execution.phase !== 'erasure_started')
    throw new Error('guest_reservation_page_invalid');
  const high =
    progress.highWater ??
    (
      await pii.queryOne<{ high: string | null }>(
        `SELECT MAX(operation_id) AS high FROM guest_upgrade_operations WHERE tenant_id=? AND user_id=?`,
        [route.tenantId, route.userId],
        { consistencyClass: 'primary_required' }
      )
    )?.high ??
    null;
  if (high === null) return { cursor: null, highWater: null, done: true };
  const bytes =
    pii.getType() === 'postgres'
      ? 'octet_length(reservation_publication_json)'
      : 'length(CAST(reservation_publication_json AS BLOB))';
  const row = await pii.queryOne<{
    operation_id: string;
    method: string;
    request_token_hash: string;
    reservation_publication_json: string | null;
    publication_bytes: number | string | null;
    created_at: number | string;
  }>(
    `SELECT operation_id,method,request_token_hash,CASE WHEN ${bytes}<=4096 THEN reservation_publication_json ELSE NULL END AS reservation_publication_json,${bytes} AS publication_bytes,created_at
      FROM guest_upgrade_operations WHERE tenant_id=? AND user_id=? AND operation_id>? AND operation_id<=? ORDER BY operation_id LIMIT 1`,
    [route.tenantId, route.userId, progress.cursor ?? '', high],
    { consistencyClass: 'primary_required' }
  );
  if (!row) return { cursor: progress.cursor, highWater: high, done: true };
  if (
    new TextEncoder().encode(row.operation_id).length > 256 ||
    Number(row.publication_bytes) > 4096
  )
    throw new Error('guest_reservation_page_invalid');
  if (row.reservation_publication_json) {
    const publication = await validateAccountDirectoryPublication(
      JSON.parse(row.reservation_publication_json) as AccountDirectoryPublication
    );
    if (
      publication.operationId !==
        (row.method === 'email'
          ? `account-email-addition:${row.operation_id}`
          : `guest-upgrade-route:${row.operation_id}`) ||
      publication.idempotencyKey !== row.request_token_hash ||
      publication.tenantId !== route.tenantId ||
      publication.accountId !== route.accountId ||
      publication.routeProjection.accountRouteGeneration !== route.accountRouteGeneration ||
      publication.indexes.length > 6
    )
      throw new Error('guest_reservation_owner_changed');
    const lookupForBucket = await createLookupBucketWriteResolver(env);
    const now = Math.floor(Date.now() / 1000),
      created = Number(row.created_at);
    if (!Number.isSafeInteger(created) || created < 0)
      throw new Error('guest_reservation_page_invalid');
    for (const index of publication.indexes.filter((entry) => entry.indexKind !== 'account_id')) {
      const lookup = (await lookupForBucket(index.virtualBucket)).withSession('first-primary');
      await lookup
        .prepare(
          `INSERT INTO lookup_identifier_reservations(virtual_bucket,tenant_id,index_kind,normalization_version,hmac_key_generation,identifier_blind_digest,account_id,reservation_state,operation_id,lease_expires_at,created_at,updated_at,released_at)
        VALUES(?,?,?,?,?,?,?,'released',?,NULL,?,?,?) ON CONFLICT(virtual_bucket,tenant_id,index_kind,normalization_version,hmac_key_generation,identifier_blind_digest)
        DO UPDATE SET reservation_state='released',lease_expires_at=NULL,released_at=COALESCE(lookup_identifier_reservations.released_at,excluded.released_at),updated_at=excluded.updated_at
        WHERE lookup_identifier_reservations.account_id=excluded.account_id AND lookup_identifier_reservations.operation_id=excluded.operation_id AND lookup_identifier_reservations.reservation_state IN ('reserved','released')`
        )
        .bind(
          index.virtualBucket,
          publication.tenantId,
          index.indexKind,
          index.normalizationVersion,
          index.hmacKeyGeneration,
          index.digest,
          publication.accountId,
          publication.operationId,
          created,
          now,
          now
        )
        .run();
      // The write resolver compares fresh primary reflection across a migration's mirror too.
      const identityParams = [
        index.virtualBucket,
        publication.tenantId,
        index.indexKind,
        index.normalizationVersion,
        index.hmacKeyGeneration,
        index.digest,
      ];
      const reflected = await lookup
        .prepare(
          `SELECT virtual_bucket,tenant_id,index_kind,normalization_version,hmac_key_generation,identifier_blind_digest,account_id,operation_id,reservation_state FROM lookup_identifier_reservations WHERE virtual_bucket=? AND tenant_id=? AND index_kind=? AND normalization_version=? AND hmac_key_generation=? AND identifier_blind_digest=?`
        )
        .bind(...identityParams)
        .first<GuestReservationIdentity>();
      const validNumber = (value: unknown) =>
        (typeof value === 'number' ||
          (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value))) &&
        Number.isSafeInteger(Number(value)) &&
        Number(value) >= 0;
      const validIdentity = (value: unknown) =>
        typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(value);
      const matchesIndex = (value: GuestReservationIdentity) =>
        value.tenant_id === publication.tenantId &&
        validNumber(value.virtual_bucket) &&
        Number(value.virtual_bucket) === index.virtualBucket &&
        value.index_kind === index.indexKind &&
        validNumber(value.normalization_version) &&
        Number(value.normalization_version) === index.normalizationVersion &&
        validNumber(value.hmac_key_generation) &&
        Number(value.hmac_key_generation) === index.hmacKeyGeneration &&
        value.identifier_blind_digest === index.digest &&
        validIdentity(value.account_id) &&
        validIdentity(value.operation_id);
      if (!reflected || !matchesIndex(reflected))
        throw new Error('guest_reservation_release_unverified');
      if (
        reflected.account_id === publication.accountId &&
        reflected.operation_id === publication.operationId &&
        reflected.reservation_state === 'released'
      ) {
        // One mirror may have committed the same release on an earlier retry. Its original release
        // timestamp can differ; the converged ownership/state proof is the existing owned contract.
        continue;
      }
      // pinReservation precedes reserve: a normal 409 can leave this publication unowned.
      // Only regular, converged different operations are positive non-ownership evidence. The SQL
      // above never changes their rows; future generic old-op replay remains its existing limit.
      if (
        reflected.operation_id === publication.operationId ||
        !['reserved', 'committed', 'releasing', 'released'].includes(reflected.reservation_state)
      )
        throw new Error('guest_reservation_release_unverified');
    }
  }
  return { cursor: row.operation_id, highWater: high, done: row.operation_id === high };
}
