import type { AccountAuthenticationSnapshot } from './SessionRevocationStore';
import type { SamlDrPersistentNameId } from '../services/tenant-portability/saml-dr-snapshot';
import {
  assertSamlDrNameIdAuthority,
  normalizeSamlDrPersistentNameId,
  SAML_DR_NAMEID_MAX_RECORDS,
  SAML_DR_NAMEID_RECORD_PREFIX,
} from './saml-dr-nameid-registry';

const SNAPSHOT_PREFIX = 'saml-dr-account-snapshot:';
const COUNTER_PREFIX = 'passkey-counter:';
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;
const SAFE_TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_USER_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,255}$/u;
export const SAML_DR_ACCOUNT_SNAPSHOT_PAGE_SIZE = 128;
export const SAML_DR_ACCOUNT_SNAPSHOT_MAX_COUNTERS = 1_024;
export const SAML_DR_ACCOUNT_SNAPSHOT_NAMEID_PAGE_SIZE = 2;

export interface SamlDrAccountSnapshotIdentity {
  tenantId: string;
  userId: string;
  accountId: string;
  snapshotId: string;
  boundaryUnixMs: number;
}

export interface SamlDrPasskeyCounter {
  /** Core passkeys.id, never the WebAuthn credential_id. */
  credentialId: string;
  counter: number;
  updatedAtMs: number;
}

export interface SamlDrAccountSnapshotPage extends SamlDrAccountSnapshotIdentity {
  initialized: boolean;
  state: AccountAuthenticationSnapshot;
  passkeyCounters: SamlDrPasskeyCounter[];
  totalPasskeyCounters: number;
  nameIdRegistryInitialized: true;
  persistentNameIds: SamlDrPersistentNameId[];
  totalPersistentNameIds: number;
  nextCursor: string | null;
}

interface SnapshotManifest extends SamlDrAccountSnapshotIdentity {
  version: 1;
  state: AccountAuthenticationSnapshot;
  totalPasskeyCounters: number;
  nameIdRegistryInitialized: true;
  totalPersistentNameIds: number;
}

export interface SamlDrAccountSnapshotTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string; limit: number }): Promise<Map<string, T>>;
}

export interface SamlDrAccountSnapshotStorage {
  transaction<T>(callback: (storage: SamlDrAccountSnapshotTransaction) => Promise<T>): Promise<T>;
}

function fail(reason: string): never {
  throw new Error(`saml_dr_account_snapshot_${reason}`);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function copyIdentity(input: SamlDrAccountSnapshotIdentity): SamlDrAccountSnapshotIdentity {
  if (
    !input ||
    typeof input.tenantId !== 'string' ||
    !SAFE_TENANT_ID.test(input.tenantId) ||
    typeof input.userId !== 'string' ||
    !SAFE_USER_ID.test(input.userId) ||
    typeof input.accountId !== 'string' ||
    !SAFE_TENANT_ID.test(input.accountId) ||
    input.accountId !== `account:${input.userId}` ||
    typeof input.snapshotId !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,128}$/u.test(input.snapshotId) ||
    !Number.isSafeInteger(input.boundaryUnixMs) ||
    input.boundaryUnixMs < 0
  )
    fail('identity_invalid');
  return {
    tenantId: input.tenantId,
    userId: input.userId,
    accountId: input.accountId,
    snapshotId: input.snapshotId,
    boundaryUnixMs: input.boundaryUnixMs,
  };
}

function prefix(input: SamlDrAccountSnapshotIdentity): string {
  return `${SNAPSHOT_PREFIX}${encodeURIComponent(input.snapshotId)}:`;
}

function timestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail('state_invalid');
  return value;
}

function normalizeState(value: unknown): AccountAuthenticationSnapshot {
  const state = value === undefined ? {} : record(value);
  if (!state) fail('state_invalid');
  const lifecycle = state.lifecycle ?? null;
  if (
    lifecycle !== null &&
    !['active', 'suspended', 'locked', 'deleting', 'deleted', 'inactive'].includes(
      lifecycle as string
    )
  )
    fail('state_invalid');
  const lifecycleVersionMs = timestamp(state.lifecycleVersionMs);
  const lifecycleOperationId = state.lifecycleOperationId ?? null;
  if (
    (lifecycle === null) !== (lifecycleVersionMs === null) ||
    (lifecycleOperationId !== null &&
      (typeof lifecycleOperationId !== 'string' || !SAFE_ID.test(lifecycleOperationId))) ||
    (lifecycle === null && lifecycleOperationId !== null)
  )
    fail('state_invalid');
  return {
    revokedAfterMs: timestamp(state.revokedAfterMs),
    lastLoginAtMs: timestamp(state.lastLoginAtMs),
    lifecycle: lifecycle as AccountAuthenticationSnapshot['lifecycle'],
    lifecycleVersionMs,
    lifecycleOperationId,
  };
}

function counter(credentialId: string, value: unknown): SamlDrPasskeyCounter {
  const stored = record(value);
  if (
    !SAFE_ID.test(credentialId) ||
    !stored ||
    typeof stored.counter !== 'number' ||
    !Number.isSafeInteger(stored.counter) ||
    stored.counter < 0 ||
    stored.counter > 0xffff_ffff
  )
    fail('counter_invalid');
  const updatedAtMs = timestamp(stored.updatedAtMs);
  if (updatedAtMs === null) fail('counter_invalid');
  return { credentialId, counter: stored.counter, updatedAtMs };
}

function manifest(value: unknown, input: SamlDrAccountSnapshotIdentity): SnapshotManifest {
  const item = record(value);
  if (
    !item ||
    item.version !== 1 ||
    item.tenantId !== input.tenantId ||
    item.userId !== input.userId ||
    item.accountId !== input.accountId ||
    item.snapshotId !== input.snapshotId ||
    item.boundaryUnixMs !== input.boundaryUnixMs ||
    typeof item.totalPasskeyCounters !== 'number' ||
    !Number.isSafeInteger(item.totalPasskeyCounters) ||
    item.totalPasskeyCounters < 0 ||
    item.totalPasskeyCounters > SAML_DR_ACCOUNT_SNAPSHOT_MAX_COUNTERS ||
    item.nameIdRegistryInitialized !== true ||
    typeof item.totalPersistentNameIds !== 'number' ||
    !Number.isSafeInteger(item.totalPersistentNameIds) ||
    item.totalPersistentNameIds < 0 ||
    item.totalPersistentNameIds > SAML_DR_NAMEID_MAX_RECORDS
  )
    fail('identity_mismatch');
  return {
    ...input,
    version: 1,
    state: normalizeState(item.state),
    totalPasskeyCounters: item.totalPasskeyCounters,
    nameIdRegistryInitialized: true,
    totalPersistentNameIds: item.totalPersistentNameIds,
  };
}

function pageCount(total: number, size = SAML_DR_ACCOUNT_SNAPSHOT_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

function totalPages(manifest: SnapshotManifest): number {
  return Math.max(
    pageCount(manifest.totalPasskeyCounters),
    pageCount(manifest.totalPersistentNameIds, SAML_DR_ACCOUNT_SNAPSHOT_NAMEID_PAGE_SIZE)
  );
}

/**
 * Called only by the existing tenant snapshot participant while its covered writers are held.
 * This local snapshot does not prove cross-store admission or writer coverage; its caller does.
 * It never initializes the source identity/state and never captures sessions or private keys.
 */
export async function startSamlDrAccountSnapshot(
  storage: SamlDrAccountSnapshotStorage,
  input: SamlDrAccountSnapshotIdentity
): Promise<void> {
  const expected = copyIdentity(input);
  await storage.transaction(async (transaction) => {
    const base = prefix(expected);
    const existing = await transaction.get(`${base}manifest`);
    if (existing !== undefined) {
      manifest(existing, expected);
      return;
    }
    const identity = await transaction.get('identity');
    const sourceIdentity = record(identity);
    if (
      identity !== undefined &&
      (!sourceIdentity ||
        sourceIdentity.tenantId !== expected.tenantId ||
        sourceIdentity.userId !== expected.userId ||
        sourceIdentity.accountId !== expected.accountId)
    )
      fail('identity_mismatch');
    if ((await transaction.get('external-provider-identity')) !== undefined)
      fail('identity_mismatch');
    await assertSamlDrNameIdAuthority(transaction, expected);
    const sourceState = await transaction.get('state');
    const entries = await transaction.list<unknown>({
      prefix: COUNTER_PREFIX,
      limit: SAML_DR_ACCOUNT_SNAPSHOT_MAX_COUNTERS + 1,
    });
    if (entries.size > SAML_DR_ACCOUNT_SNAPSHOT_MAX_COUNTERS) fail('counter_limit');
    if (identity === undefined && (sourceState !== undefined || entries.size > 0))
      fail('identity_missing');
    const state = normalizeState(sourceState);
    const counters = [...entries].map(([key, value]) =>
      counter(key.slice(COUNTER_PREFIX.length), value)
    );
    if (counters.length > 0 && state.lifecycle === null) fail('state_uninitialized');
    const nameIdEntries = await transaction.list<unknown>({
      prefix: SAML_DR_NAMEID_RECORD_PREFIX,
      limit: SAML_DR_NAMEID_MAX_RECORDS + 1,
    });
    if (nameIdEntries.size > SAML_DR_NAMEID_MAX_RECORDS) fail('nameid_limit');
    const nameIds = [...nameIdEntries.values()]
      .map((value) => normalizeSamlDrPersistentNameId(value, expected))
      .sort((left, right) =>
        left.registryKey < right.registryKey ? -1 : left.registryKey > right.registryKey ? 1 : 0
      );
    if (new Set(nameIds.map((row) => row.registryKey)).size !== nameIds.length)
      fail('nameid_invalid');
    for (let page = 0; page < pageCount(counters.length); page += 1) {
      await transaction.put(
        `${base}page:${page}`,
        counters.slice(
          page * SAML_DR_ACCOUNT_SNAPSHOT_PAGE_SIZE,
          (page + 1) * SAML_DR_ACCOUNT_SNAPSHOT_PAGE_SIZE
        )
      );
    }
    for (
      let page = 0;
      page < pageCount(nameIds.length, SAML_DR_ACCOUNT_SNAPSHOT_NAMEID_PAGE_SIZE);
      page += 1
    ) {
      await transaction.put(
        `${base}nameids:${page}`,
        nameIds.slice(
          page * SAML_DR_ACCOUNT_SNAPSHOT_NAMEID_PAGE_SIZE,
          (page + 1) * SAML_DR_ACCOUNT_SNAPSHOT_NAMEID_PAGE_SIZE
        )
      );
    }
    await transaction.put(`${base}manifest`, {
      ...expected,
      version: 1,
      state,
      totalPasskeyCounters: counters.length,
      nameIdRegistryInitialized: true,
      totalPersistentNameIds: nameIds.length,
    } satisfies SnapshotManifest);
  });
}

/** Read immutable pages after the caller has released its cross-store write hold. */
export async function readSamlDrAccountSnapshotPage(
  storage: SamlDrAccountSnapshotStorage,
  input: SamlDrAccountSnapshotIdentity & { cursor?: string }
): Promise<SamlDrAccountSnapshotPage> {
  const expected = copyIdentity(input);
  const { cursor } = input;
  if (
    cursor !== undefined &&
    (typeof cursor !== 'string' || !/^(0|[1-9][0-9]{0,2})$/u.test(cursor))
  )
    fail('cursor_invalid');
  const pageIndex = cursor === undefined ? 0 : Number(cursor);
  return storage.transaction(async (transaction) => {
    const base = prefix(expected);
    const raw = await transaction.get(`${base}manifest`);
    if (raw === undefined) fail('missing');
    const saved = manifest(raw, expected);
    if (pageIndex >= totalPages(saved)) fail('cursor_invalid');
    const values =
      pageIndex < pageCount(saved.totalPasskeyCounters)
        ? await transaction.get<unknown>(`${base}page:${pageIndex}`)
        : [];
    const expectedSize = Math.max(
      0,
      Math.min(
        SAML_DR_ACCOUNT_SNAPSHOT_PAGE_SIZE,
        saved.totalPasskeyCounters - pageIndex * SAML_DR_ACCOUNT_SNAPSHOT_PAGE_SIZE
      )
    );
    if (!Array.isArray(values) || values.length !== expectedSize) fail('page_invalid');
    const passkeyCounters = values.map((value) => {
      const item = record(value);
      if (!item || typeof item.credentialId !== 'string') fail('page_invalid');
      return counter(item.credentialId, item);
    });
    if (
      passkeyCounters.some(
        (item, index) => index > 0 && item.credentialId <= passkeyCounters[index - 1].credentialId
      )
    )
      fail('page_invalid');
    const nameIdValues =
      pageIndex < pageCount(saved.totalPersistentNameIds, SAML_DR_ACCOUNT_SNAPSHOT_NAMEID_PAGE_SIZE)
        ? await transaction.get<unknown>(`${base}nameids:${pageIndex}`)
        : [];
    const expectedNameIdSize = Math.max(
      0,
      Math.min(
        SAML_DR_ACCOUNT_SNAPSHOT_NAMEID_PAGE_SIZE,
        saved.totalPersistentNameIds - pageIndex * SAML_DR_ACCOUNT_SNAPSHOT_NAMEID_PAGE_SIZE
      )
    );
    if (!Array.isArray(nameIdValues) || nameIdValues.length !== expectedNameIdSize)
      fail('page_invalid');
    const persistentNameIds = nameIdValues.map((value) =>
      normalizeSamlDrPersistentNameId(value, expected)
    );
    return {
      ...expected,
      initialized: saved.state.lifecycle !== null,
      state: saved.state,
      passkeyCounters,
      totalPasskeyCounters: saved.totalPasskeyCounters,
      nameIdRegistryInitialized: true,
      persistentNameIds,
      totalPersistentNameIds: saved.totalPersistentNameIds,
      nextCursor: pageIndex + 1 < totalPages(saved) ? String(pageIndex + 1) : null,
    };
  });
}

export async function releaseSamlDrAccountSnapshot(
  storage: SamlDrAccountSnapshotStorage,
  input: SamlDrAccountSnapshotIdentity
): Promise<void> {
  const expected = copyIdentity(input);
  await storage.transaction(async (transaction) => {
    const base = prefix(expected);
    const raw = await transaction.get(`${base}manifest`);
    if (raw === undefined) {
      if ((await transaction.list({ prefix: base, limit: 1 })).size > 0) fail('manifest_missing');
      return;
    }
    const saved = manifest(raw, expected);
    for (let page = 0; page < pageCount(saved.totalPasskeyCounters); page += 1)
      await transaction.delete(`${base}page:${page}`);
    for (
      let page = 0;
      page < pageCount(saved.totalPersistentNameIds, SAML_DR_ACCOUNT_SNAPSHOT_NAMEID_PAGE_SIZE);
      page += 1
    )
      await transaction.delete(`${base}nameids:${page}`);
    await transaction.delete(`${base}manifest`);
  });
}

export async function assertSamlDrAccountSnapshotReleased(
  storage: SamlDrAccountSnapshotStorage,
  input: SamlDrAccountSnapshotIdentity
): Promise<void> {
  const expected = copyIdentity(input);
  await storage.transaction(async (transaction) => {
    if ((await transaction.list({ prefix: prefix(expected), limit: 1 })).size > 0)
      fail('not_released');
  });
}
