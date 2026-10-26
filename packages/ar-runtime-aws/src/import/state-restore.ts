import { createHash } from 'node:crypto';
import type { AccountAuthenticationLifecycle } from '@authrim/ar-lib-core';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import {
  PostgresPersistentNameIDRegistry,
  validateSAMLPersistentNameIDRecord,
} from '../storage/postgres-persistent-nameid';
import type { PostgresQueryClient } from '../storage/postgres-transient-state';

const TENANT_ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const USER_ID = /^[a-zA-Z0-9_-][a-zA-Z0-9._:-]{0,255}$/u;
const CREDENTIAL_ID = /^[a-zA-Z0-9_.:-]{1,256}$/u;
const BUNDLE_ID = /^[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const NAMEID_KEY = /^saml:persistent-nameid:tenant:([^:]+):sp:([^:]+):subject:([^:]+)$/u;
const LIFECYCLES = new Set<AccountAuthenticationLifecycle>([
  'active',
  'suspended',
  'locked',
  'deleting',
  'deleted',
  'inactive',
]);
const BATCH_ROWS = 200;

export interface VerifiedAwsAccountAuthState {
  tenantId: string;
  userId: string;
  accountId: string;
  lifecycle: AccountAuthenticationLifecycle;
  lifecycleVersionMs: number;
  lifecycleOperationId: string | null;
  revokedAfterMs: number | null;
  lastLoginAtMs: number | null;
}

export interface VerifiedAwsPasskeyCounter {
  tenantId: string;
  passkeyId: string;
  userId: string;
  /** Raw WebAuthn credential ID, checked against the source Core passkey row. */
  credentialId: string;
  /** Canonical decimal to avoid lossy JSON serialization of a source D1 integer. */
  counter: string;
  updatedAtMs: number;
}

export interface VerifiedAwsPersistentNameID {
  tenantId: string;
  registryKey: string;
  valueJson: string;
  createdAtMs: number;
}

/** Captured and authenticated separately from the tenant bundle, at the same source boundary. */
export interface VerifiedAwsStateSupplement {
  receipt: {
    tenantId: string;
    issuer: string;
    productVersion: string;
    bundleId: string;
    snapshotId: string;
    inventoryDigestSha256: string;
    supplementSha256: string;
  };
  accountAuthStates: readonly VerifiedAwsAccountAuthState[];
  passkeyCounters: readonly VerifiedAwsPasskeyCounter[];
  /** Source registry inventory is complete even when the list is empty. */
  persistentNameIdsComplete: true;
  persistentNameIds: readonly VerifiedAwsPersistentNameID[];
}

/** Extracted independently from verified Core/PII rows, never from the supplement itself. */
export interface AwsStateSourceExpectations {
  users: readonly { userId: string }[];
  accounts: readonly {
    accountId: string;
    userId: string;
    lifecycle: AccountAuthenticationLifecycle;
  }[];
  passkeys: readonly {
    passkeyId: string;
    userId: string;
    credentialId: string;
    sourceCounter: string;
  }[];
}

/** Provides one exclusive pg Client/PoolClient. The callback owns BEGIN/COMMIT/ROLLBACK. */
export interface DedicatedStateRestoreConnection {
  withDedicatedConnection<T>(run: (client: PostgresQueryClient) => Promise<T>): Promise<T>;
}

export interface AwsStateRestoreReceipt {
  tenantId: string;
  source: TenantBundleManifest['source'];
  bundleId: string;
  snapshotId: string;
  inventoryDigestSha256: string;
  supplementSha256: string;
  accountAuthStates: number;
  passkeyCounters: number;
  persistentNameIds: number;
}

function invalid(): never {
  // The input contains credential state and NameIDs. Never return a source value in an error.
  throw new Error('aws_state_restore_invalid');
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positiveMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nullableMs(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function safeText(value: unknown, max = 512): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function isArray(value: unknown): boolean {
  return Array.isArray(value);
}

function counter(value: unknown): number {
  if (typeof value !== 'string' || !DECIMAL.test(value)) invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== value) invalid();
  return parsed;
}

function exactKeys(value: object, names: readonly string[]): boolean {
  const found = Object.keys(value).sort();
  const expected = [...names].sort();
  return found.length === expected.length && found.every((name, index) => name === expected[index]);
}

function canonicalPayload(supplement: VerifiedAwsStateSupplement): string {
  return JSON.stringify({
    accountAuthStates: [...supplement.accountAuthStates]
      .sort((a, b) => compare(a.userId, b.userId))
      .map((row) => ({
        tenantId: row.tenantId,
        userId: row.userId,
        accountId: row.accountId,
        lifecycle: row.lifecycle,
        lifecycleVersionMs: row.lifecycleVersionMs,
        lifecycleOperationId: row.lifecycleOperationId,
        revokedAfterMs: row.revokedAfterMs,
        lastLoginAtMs: row.lastLoginAtMs,
      })),
    passkeyCounters: [...supplement.passkeyCounters]
      .sort((a, b) => compare(a.credentialId, b.credentialId))
      .map((row) => ({
        tenantId: row.tenantId,
        passkeyId: row.passkeyId,
        userId: row.userId,
        credentialId: row.credentialId,
        counter: row.counter,
        updatedAtMs: row.updatedAtMs,
      })),
    persistentNameIdsComplete: supplement.persistentNameIdsComplete,
    persistentNameIds: [...supplement.persistentNameIds]
      .sort((a, b) => compare(a.registryKey, b.registryKey))
      .map((row) => ({
        tenantId: row.tenantId,
        registryKey: row.registryKey,
        valueJson: row.valueJson,
        createdAtMs: row.createdAtMs,
      })),
  });
}

/** Digest to pin in a separately authenticated source supplement receipt. */
export function awsStateSupplementPayloadSha256(supplement: VerifiedAwsStateSupplement): string {
  return createHash('sha256').update(canonicalPayload(supplement)).digest('hex');
}

function assertSource(
  manifest: TenantBundleManifest,
  supplement: VerifiedAwsStateSupplement,
  expected: AwsStateSourceExpectations
): void {
  const { receipt } = supplement;
  const tenantId = manifest.source.tenantId;
  if (
    !TENANT_ID.test(tenantId) ||
    !receipt ||
    receipt.tenantId !== tenantId ||
    receipt.issuer !== manifest.source.issuer ||
    receipt.productVersion !== manifest.source.productVersion ||
    receipt.bundleId !== manifest.bundleId ||
    !BUNDLE_ID.test(receipt.bundleId) ||
    receipt.snapshotId !== manifest.snapshotId ||
    receipt.inventoryDigestSha256 !== manifest.inventoryDigestSha256 ||
    !SHA256.test(receipt.inventoryDigestSha256) ||
    !SHA256.test(receipt.supplementSha256) ||
    !isArray(supplement.accountAuthStates) ||
    !isArray(supplement.passkeyCounters) ||
    supplement.persistentNameIdsComplete !== true ||
    !isArray(supplement.persistentNameIds) ||
    !isArray(expected.users) ||
    !isArray(expected.accounts) ||
    !isArray(expected.passkeys)
  )
    invalid();

  const userIds = new Set<string>();
  for (const user of expected.users) {
    if (!USER_ID.test(user.userId) || userIds.has(user.userId)) invalid();
    userIds.add(user.userId);
  }
  const accounts = new Map<string, AwsStateSourceExpectations['accounts'][number]>();
  for (const account of expected.accounts) {
    if (
      !USER_ID.test(account.userId) ||
      account.accountId !== `account:${account.userId}` ||
      !LIFECYCLES.has(account.lifecycle) ||
      accounts.has(account.userId) ||
      !userIds.has(account.userId)
    )
      invalid();
    accounts.set(account.userId, account);
  }
  // An imported user without a lifecycle row could otherwise acquire a fresh active state later.
  if (accounts.size !== userIds.size || supplement.accountAuthStates.length !== accounts.size)
    invalid();
  const seenAccounts = new Set<string>();
  for (const row of supplement.accountAuthStates) {
    const source = accounts.get(row.userId);
    if (
      !exactKeys(row, [
        'tenantId',
        'userId',
        'accountId',
        'lifecycle',
        'lifecycleVersionMs',
        'lifecycleOperationId',
        'revokedAfterMs',
        'lastLoginAtMs',
      ]) ||
      row.tenantId !== tenantId ||
      !source ||
      seenAccounts.has(row.userId) ||
      row.accountId !== source.accountId ||
      row.lifecycle !== source.lifecycle ||
      !positiveMs(row.lifecycleVersionMs) ||
      row.lifecycleVersionMs > manifest.boundaryUnixMs ||
      (row.lifecycleOperationId !== null && !safeText(row.lifecycleOperationId)) ||
      !nullableMs(row.revokedAfterMs) ||
      !nullableMs(row.lastLoginAtMs) ||
      (row.revokedAfterMs !== null && row.revokedAfterMs > manifest.boundaryUnixMs) ||
      (row.lastLoginAtMs !== null && row.lastLoginAtMs > manifest.boundaryUnixMs)
    )
      invalid();
    seenAccounts.add(row.userId);
  }

  const passkeys = new Map<string, AwsStateSourceExpectations['passkeys'][number]>();
  const passkeyIds = new Set<string>();
  const webAuthnCredentialIds = new Set<string>();
  for (const source of expected.passkeys) {
    if (
      !CREDENTIAL_ID.test(source.passkeyId) ||
      !USER_ID.test(source.userId) ||
      !CREDENTIAL_ID.test(source.credentialId) ||
      !userIds.has(source.userId) ||
      passkeyIds.has(source.passkeyId) ||
      webAuthnCredentialIds.has(source.credentialId)
    )
      invalid();
    counter(source.sourceCounter);
    passkeyIds.add(source.passkeyId);
    webAuthnCredentialIds.add(source.credentialId);
    passkeys.set(source.passkeyId, source);
  }
  if (supplement.passkeyCounters.length !== passkeys.size) invalid();
  const seenCredentials = new Set<string>();
  for (const row of supplement.passkeyCounters) {
    const source = passkeys.get(row.passkeyId);
    if (
      !exactKeys(row, [
        'tenantId',
        'passkeyId',
        'userId',
        'credentialId',
        'counter',
        'updatedAtMs',
      ]) ||
      row.tenantId !== tenantId ||
      !source ||
      seenCredentials.has(row.credentialId) ||
      row.userId !== source.userId ||
      row.passkeyId !== source.passkeyId ||
      row.credentialId !== source.credentialId ||
      !positiveMs(row.updatedAtMs) ||
      row.updatedAtMs > manifest.boundaryUnixMs ||
      counter(row.counter) < counter(source.sourceCounter)
    )
      invalid();
    seenCredentials.add(row.credentialId);
  }

  const seenNameIds = new Set<string>();
  for (const row of supplement.persistentNameIds) {
    const match = NAMEID_KEY.exec(row.registryKey);
    let record: ReturnType<typeof validateSAMLPersistentNameIDRecord>;
    try {
      record = validateSAMLPersistentNameIDRecord(row.registryKey, row.valueJson);
    } catch {
      return invalid();
    }
    if (
      !exactKeys(row, ['tenantId', 'registryKey', 'valueJson', 'createdAtMs']) ||
      row.tenantId !== tenantId ||
      match?.[1] !== tenantId ||
      record.tenantId !== tenantId ||
      !userIds.has(record.subjectId) ||
      seenNameIds.has(row.registryKey) ||
      !positiveMs(row.createdAtMs) ||
      row.createdAtMs > manifest.boundaryUnixMs ||
      record.createdAt !== row.createdAtMs
    )
      invalid();
    seenNameIds.add(row.registryKey);
  }
  if (awsStateSupplementPayloadSha256(supplement) !== receipt.supplementSha256) invalid();
}

/** Validate a pinned source capture before opening any AWS database connection. */
export function assertVerifiedAwsStateSource(input: {
  manifest: TenantBundleManifest;
  supplement: VerifiedAwsStateSupplement;
  expected: AwsStateSourceExpectations;
}): void {
  try {
    assertSource(
      structuredClone(input.manifest),
      structuredClone(input.supplement),
      structuredClone(input.expected)
    );
  } catch {
    invalid();
  }
}

async function hasTenantRows(
  db: PostgresQueryClient,
  table: string,
  tenantId: string
): Promise<boolean> {
  const result = await db.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${table} WHERE tenant_id = $1) AS present`,
    [tenantId]
  );
  return result.rows[0]?.present === true;
}

async function insertAccounts(
  db: PostgresQueryClient,
  rows: readonly VerifiedAwsAccountAuthState[]
): Promise<void> {
  for (let from = 0; from < rows.length; from += BATCH_ROWS) {
    const page = rows.slice(from, from + BATCH_ROWS);
    const values = page.flatMap((row) => [
      row.tenantId,
      row.userId,
      row.accountId,
      row.lifecycle,
      row.lifecycleVersionMs,
      row.lifecycleOperationId,
      row.revokedAfterMs,
      row.lastLoginAtMs,
    ]);
    const tuples = page.map(
      (_, index) =>
        `(${Array.from({ length: 8 }, (_, column) => `$${index * 8 + column + 1}`).join(',')})`
    );
    const inserted = await db.query<{
      tenant_id: string;
      user_id: string;
      account_id: string;
      lifecycle: string;
      lifecycle_version_ms: string | number;
      lifecycle_operation_id: string | null;
      revoked_after_ms: string | number | null;
      last_login_at_ms: string | number | null;
    }>(
      `INSERT INTO authrim_aws_account_auth_state
       (tenant_id,user_id,account_id,lifecycle,lifecycle_version_ms,
        lifecycle_operation_id,revoked_after_ms,last_login_at_ms)
       VALUES ${tuples.join(',')}
       RETURNING tenant_id,user_id,account_id,lifecycle,lifecycle_version_ms,
                 lifecycle_operation_id,revoked_after_ms,last_login_at_ms`,
      values
    );
    if (inserted.rows.length !== page.length) invalid();
    const byUser = new Map(page.map((row) => [row.userId, row]));
    for (const row of inserted.rows) {
      const source = byUser.get(row.user_id);
      if (
        !source ||
        row.tenant_id !== source.tenantId ||
        row.account_id !== source.accountId ||
        row.lifecycle !== source.lifecycle ||
        String(row.lifecycle_version_ms) !== String(source.lifecycleVersionMs) ||
        row.lifecycle_operation_id !== source.lifecycleOperationId ||
        (row.revoked_after_ms === null ? null : String(row.revoked_after_ms)) !==
          (source.revokedAfterMs === null ? null : String(source.revokedAfterMs)) ||
        (row.last_login_at_ms === null ? null : String(row.last_login_at_ms)) !==
          (source.lastLoginAtMs === null ? null : String(source.lastLoginAtMs))
      )
        invalid();
    }
  }
}

async function insertCounters(
  db: PostgresQueryClient,
  rows: readonly VerifiedAwsPasskeyCounter[]
): Promise<void> {
  for (let from = 0; from < rows.length; from += BATCH_ROWS) {
    const page = rows.slice(from, from + BATCH_ROWS);
    const values = page.flatMap((row) => [
      row.tenantId,
      row.userId,
      row.passkeyId,
      row.counter,
      row.updatedAtMs,
    ]);
    const tuples = page.map(
      (_, index) =>
        `(${Array.from({ length: 5 }, (_, column) => `$${index * 5 + column + 1}`).join(',')})`
    );
    const inserted = await db.query<{
      tenant_id: string;
      user_id: string;
      credential_id: string;
      counter: string | number;
      updated_at_ms: string | number;
    }>(
      `INSERT INTO authrim_aws_passkey_counters
       (tenant_id,user_id,credential_id,counter,updated_at_ms)
       VALUES ${tuples.join(',')}
       RETURNING tenant_id,user_id,credential_id,counter,updated_at_ms`,
      values
    );
    if (inserted.rows.length !== page.length) invalid();
    const byCredential = new Map(page.map((row) => [row.passkeyId, row]));
    for (const row of inserted.rows) {
      const source = byCredential.get(row.credential_id);
      if (
        !source ||
        row.tenant_id !== source.tenantId ||
        row.user_id !== source.userId ||
        String(row.counter) !== source.counter ||
        String(row.updated_at_ms) !== String(source.updatedAtMs)
      )
        invalid();
    }
  }
}

async function assertRowsRestored(
  db: PostgresQueryClient,
  supplement: VerifiedAwsStateSupplement,
  tenantId: string,
  mode: 'staging' | 'live'
): Promise<void> {
  for (const [table, count] of [
    ['authrim_aws_account_auth_state', supplement.accountAuthStates.length],
    ['authrim_aws_passkey_counters', supplement.passkeyCounters.length],
    ['authrim_aws_saml_persistent_nameids', supplement.persistentNameIds.length],
  ] as const) {
    const result = await db.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM ${table} WHERE tenant_id = $1`,
      [tenantId]
    );
    const observed = Number(result.rows[0]?.count);
    if (
      !Number.isSafeInteger(observed) ||
      (mode === 'live' && table === 'authrim_aws_saml_persistent_nameids'
        ? observed < count
        : observed !== count)
    )
      invalid();
  }

  for (let from = 0; from < supplement.accountAuthStates.length; from += BATCH_ROWS) {
    const page = supplement.accountAuthStates.slice(from, from + BATCH_ROWS);
    const found = await db.query<{
      user_id: string;
      account_id: string;
      lifecycle: string;
      lifecycle_version_ms: string | number;
      lifecycle_operation_id: string | null;
      revoked_after_ms: string | number | null;
      last_login_at_ms: string | number | null;
    }>(
      `SELECT user_id,account_id,lifecycle,lifecycle_version_ms,lifecycle_operation_id,
              revoked_after_ms,last_login_at_ms
       FROM authrim_aws_account_auth_state
       WHERE tenant_id = $1 AND user_id = ANY($2::text[])`,
      [tenantId, page.map((row) => row.userId)]
    );
    if (found.rows.length !== page.length) invalid();
    const source = new Map(page.map((row) => [row.userId, row]));
    for (const row of found.rows) {
      const original = source.get(row.user_id);
      if (
        !original ||
        row.account_id !== original.accountId ||
        row.lifecycle !== original.lifecycle ||
        String(row.lifecycle_version_ms) !== String(original.lifecycleVersionMs) ||
        row.lifecycle_operation_id !== original.lifecycleOperationId ||
        (row.revoked_after_ms === null ? null : String(row.revoked_after_ms)) !==
          (original.revokedAfterMs === null ? null : String(original.revokedAfterMs)) ||
        (row.last_login_at_ms === null ? null : String(row.last_login_at_ms)) !==
          (original.lastLoginAtMs === null ? null : String(original.lastLoginAtMs))
      )
        invalid();
    }
  }

  for (let from = 0; from < supplement.passkeyCounters.length; from += BATCH_ROWS) {
    const page = supplement.passkeyCounters.slice(from, from + BATCH_ROWS);
    const found = await db.query<{
      user_id: string;
      credential_id: string;
      counter: string | number;
      updated_at_ms: string | number;
    }>(
      `SELECT user_id,credential_id,counter,updated_at_ms
       FROM authrim_aws_passkey_counters
       WHERE tenant_id = $1 AND credential_id = ANY($2::text[])`,
      [tenantId, page.map((row) => row.passkeyId)]
    );
    if (found.rows.length !== page.length) invalid();
    const source = new Map(page.map((row) => [row.passkeyId, row]));
    for (const row of found.rows) {
      const original = source.get(row.credential_id);
      if (
        !original ||
        row.user_id !== original.userId ||
        (mode === 'live'
          ? counter(String(row.counter)) < counter(original.counter) ||
            Number(row.updated_at_ms) < original.updatedAtMs ||
            !Number.isSafeInteger(Number(row.updated_at_ms))
          : String(row.counter) !== original.counter ||
            String(row.updated_at_ms) !== String(original.updatedAtMs))
      )
        invalid();
    }
  }

  for (let from = 0; from < supplement.persistentNameIds.length; from += BATCH_ROWS) {
    const page = supplement.persistentNameIds.slice(from, from + BATCH_ROWS);
    const found = await db.query<{
      registry_key: string;
      value_json: string;
      created_at_ms: string | number;
    }>(
      `SELECT registry_key,value_json,created_at_ms
       FROM authrim_aws_saml_persistent_nameids
       WHERE tenant_id = $1 AND registry_key = ANY($2::text[])`,
      [tenantId, page.map((row) => row.registryKey)]
    );
    if (found.rows.length !== page.length) invalid();
    const source = new Map(page.map((row) => [row.registryKey, row]));
    for (const row of found.rows) {
      const original = source.get(row.registry_key);
      if (
        !original ||
        row.value_json !== original.valueJson ||
        String(row.created_at_ms) !== String(original.createdAtMs)
      )
        invalid();
    }
  }

  if (mode === 'live') {
    const userIds = new Set(supplement.accountAuthStates.map((row) => row.userId));
    let cursor = '';
    for (;;) {
      const page = await db.query<{
        registry_key: string;
        value_json: string;
        created_at_ms: string | number;
      }>(
        `SELECT registry_key,value_json,created_at_ms
         FROM authrim_aws_saml_persistent_nameids
         WHERE tenant_id = $1 AND registry_key > $2
         ORDER BY registry_key LIMIT $3`,
        [tenantId, cursor, BATCH_ROWS]
      );
      if (page.rows.length === 0) break;
      for (const row of page.rows) {
        let record: ReturnType<typeof validateSAMLPersistentNameIDRecord>;
        try {
          record = validateSAMLPersistentNameIDRecord(row.registry_key, row.value_json);
        } catch {
          return invalid();
        }
        if (
          record.tenantId !== tenantId ||
          !userIds.has(record.subjectId) ||
          row.registry_key <= cursor ||
          String(record.createdAt) !== String(row.created_at_ms)
        )
          invalid();
        cursor = row.registry_key;
      }
      if (page.rows.length < BATCH_ROWS) break;
    }
  }
}

export interface AwsStateReadbackInput {
  manifest: TenantBundleManifest;
  supplement: VerifiedAwsStateSupplement;
  expected: AwsStateSourceExpectations;
  receipt: AwsStateRestoreReceipt;
  connection: DedicatedStateRestoreConnection;
}

async function assertStateReadback(
  input: AwsStateReadbackInput,
  mode: 'staging' | 'live'
): Promise<void> {
  try {
    const manifest = structuredClone(input.manifest);
    const supplement = structuredClone(input.supplement);
    const expected = structuredClone(input.expected);
    const receipt = structuredClone(input.receipt);
    assertSource(manifest, supplement, expected);
    if (
      receipt.tenantId !== manifest.source.tenantId ||
      receipt.source.tenantId !== manifest.source.tenantId ||
      receipt.source.issuer !== manifest.source.issuer ||
      receipt.source.productVersion !== manifest.source.productVersion ||
      receipt.bundleId !== manifest.bundleId ||
      receipt.snapshotId !== manifest.snapshotId ||
      receipt.inventoryDigestSha256 !== manifest.inventoryDigestSha256 ||
      receipt.supplementSha256 !== supplement.receipt.supplementSha256 ||
      receipt.accountAuthStates !== supplement.accountAuthStates.length ||
      receipt.passkeyCounters !== supplement.passkeyCounters.length ||
      receipt.persistentNameIds !== supplement.persistentNameIds.length
    )
      invalid();
    await input.connection.withDedicatedConnection(async (db) => {
      let begun = false;
      try {
        await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', []);
        begun = true;
        await assertRowsRestored(db, supplement, manifest.source.tenantId, mode);
        await db.query('COMMIT', []);
        begun = false;
      } catch {
        if (begun) await db.query('ROLLBACK', []).catch(() => undefined);
        return invalid();
      }
    });
  } catch {
    return invalid();
  }
}

/** Repeatable-read verification for the activation boundary after staged imports finish. */
export async function assertVerifiedAwsStateRestored(input: AwsStateReadbackInput): Promise<void> {
  return assertStateReadback(input, 'staging');
}

/** Allows only runtime passkey counter advances and valid new NameIDs after activation. */
export async function assertAwsLiveStateCompatible(input: AwsStateReadbackInput): Promise<void> {
  return assertStateReadback(input, 'live');
}

/** Restores only the three durable AWS authentication state tables on one staging connection. */
export async function restoreVerifiedAwsState(input: {
  manifest: TenantBundleManifest;
  supplement: VerifiedAwsStateSupplement;
  expected: AwsStateSourceExpectations;
  connection: DedicatedStateRestoreConnection;
}): Promise<AwsStateRestoreReceipt> {
  try {
    const manifest = structuredClone(input.manifest);
    const supplement = structuredClone(input.supplement);
    const expected = structuredClone(input.expected);
    assertSource(manifest, supplement, expected);
    const tenantId = manifest.source.tenantId;
    const receipt: AwsStateRestoreReceipt = {
      tenantId,
      source: { ...manifest.source },
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
      inventoryDigestSha256: manifest.inventoryDigestSha256,
      supplementSha256: supplement.receipt.supplementSha256,
      accountAuthStates: supplement.accountAuthStates.length,
      passkeyCounters: supplement.passkeyCounters.length,
      persistentNameIds: supplement.persistentNameIds.length,
    };
    await input.connection.withDedicatedConnection(async (db) => {
      let begun = false;
      try {
        await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE', []);
        begun = true;
        await db.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('authrim_aws_state_restore:' || $1, 0))`,
          [tenantId]
        );
        for (const table of [
          'authrim_aws_account_auth_state',
          'authrim_aws_passkey_counters',
          'authrim_aws_saml_persistent_nameids',
        ]) {
          if (await hasTenantRows(db, table, tenantId)) invalid();
        }
        await insertAccounts(db, supplement.accountAuthStates);
        await insertCounters(db, supplement.passkeyCounters);
        const nameIds = new PostgresPersistentNameIDRegistry(db);
        for (const row of supplement.persistentNameIds) {
          await nameIds.put({ tenantId, key: row.registryKey, value: row.valueJson });
          if ((await nameIds.get({ tenantId, key: row.registryKey })) !== row.valueJson) invalid();
        }
        await assertRowsRestored(db, supplement, tenantId, 'staging');
        await db.query('COMMIT', []);
        begun = false;
      } catch {
        if (begun) await db.query('ROLLBACK', []).catch(() => undefined);
        return invalid();
      }
    });
    return receipt;
  } catch {
    return invalid();
  }
}
