import {
  validateSamlDrNameIdAccount,
  validateSamlDrNameIdRecord,
  parseSamlDrNameIdRegistryKey,
  type SamlDrNameIdAccountIdentity,
  type SamlDrNameIdRegistryInitialization,
} from '../services/saml-dr-nameid-registry';
import type { SamlDrPersistentNameId } from '../services/tenant-portability/saml-dr-snapshot';
import type {
  SamlDrAccountSnapshotStorage,
  SamlDrAccountSnapshotTransaction,
} from './saml-dr-account-snapshot';

export const SAML_DR_NAMEID_AUTHORITY_KEY = 'saml-dr-nameid-authority';
export const SAML_DR_NAMEID_RECORD_PREFIX = 'saml-dr-nameid-record:';
export const SAML_DR_NAMEID_MAX_RECORDS = 1_024;

function fail(reason: string): never {
  throw new Error(`saml_dr_nameid_${reason}`);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assertIdentity(value: unknown, expected: SamlDrNameIdAccountIdentity): void {
  const item = object(value);
  if (
    !item ||
    item.tenantId !== expected.tenantId ||
    item.userId !== expected.userId ||
    item.accountId !== expected.accountId
  )
    fail('identity_mismatch');
}

/** Requires an explicit fresh-account marker and an exact pinned account identity. */
export async function assertSamlDrNameIdAuthority(
  storage: SamlDrAccountSnapshotTransaction,
  expected: SamlDrNameIdAccountIdentity
): Promise<void> {
  const authority = object(await storage.get(SAML_DR_NAMEID_AUTHORITY_KEY));
  if (!authority) fail('authority_missing');
  assertIdentity(authority, expected);
  if (
    authority.version !== 1 ||
    authority.freshAccount !== true ||
    typeof authority.initializationId !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,128}$/u.test(authority.initializationId) ||
    typeof authority.initializedAtMs !== 'number' ||
    !Number.isSafeInteger(authority.initializedAtMs) ||
    authority.initializedAtMs < 1
  )
    fail('authority_invalid');
  assertIdentity(await storage.get('identity'), expected);
}

export async function initializeSamlDrNameIdRegistry(
  storage: SamlDrAccountSnapshotStorage,
  input: SamlDrNameIdRegistryInitialization
): Promise<void> {
  const identity = validateSamlDrNameIdAccount(input);
  if (
    input.freshAccount !== true ||
    typeof input.initializationId !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,128}$/u.test(input.initializationId) ||
    !Number.isSafeInteger(input.initializedAtMs) ||
    input.initializedAtMs < 1
  )
    fail('initialization_invalid');
  const expected = {
    ...identity,
    version: 1,
    freshAccount: true,
    initializationId: input.initializationId,
    initializedAtMs: input.initializedAtMs,
  };
  await storage.transaction(async (transaction) => {
    const existing = object(await transaction.get(SAML_DR_NAMEID_AUTHORITY_KEY));
    if (existing) {
      await assertSamlDrNameIdAuthority(transaction, identity);
      if (
        existing.initializationId !== expected.initializationId ||
        existing.initializedAtMs !== expected.initializedAtMs
      )
        fail('initialization_conflict');
      return;
    }
    // DO-local emptiness cannot certify a legacy KV account. The provisioning caller must
    // explicitly know this is a new account; existing accounts/migration are unsupported.
    if ((await transaction.list({ prefix: '', limit: 1 })).size > 0) fail('target_not_empty');
    await transaction.put('identity', identity);
    await transaction.put(SAML_DR_NAMEID_AUTHORITY_KEY, expected);
  });
}

function checkedRecord(
  input: SamlDrNameIdAccountIdentity & { registryKey: string; valueJson: string }
): SamlDrPersistentNameId & { nameId: string } {
  const identity = validateSamlDrNameIdAccount(input);
  const record = validateSamlDrNameIdRecord(input.registryKey, input.valueJson);
  assertIdentity(record, identity);
  return {
    tenantId: identity.tenantId,
    registryKey: input.registryKey,
    valueJson: input.valueJson,
    createdAtMs: record.createdAtMs,
    nameId: record.nameId,
  };
}

async function storageKey(registryKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(registryKey));
  return `${SAML_DR_NAMEID_RECORD_PREFIX}${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

export function normalizeSamlDrPersistentNameId(
  value: unknown,
  expected: SamlDrNameIdAccountIdentity
): SamlDrPersistentNameId {
  const item = object(value);
  if (
    !item ||
    Object.keys(item).sort().join(',') !== 'createdAtMs,registryKey,tenantId,valueJson' ||
    item.tenantId !== expected.tenantId ||
    typeof item.registryKey !== 'string' ||
    typeof item.valueJson !== 'string'
  )
    fail('record_invalid');
  const row = checkedRecord({
    ...expected,
    registryKey: item.registryKey,
    valueJson: item.valueJson,
  });
  if (row.createdAtMs !== item.createdAtMs) fail('record_invalid');
  return {
    tenantId: row.tenantId,
    registryKey: row.registryKey,
    valueJson: row.valueJson,
    createdAtMs: row.createdAtMs,
  };
}

export async function getSamlDrNameId(
  storage: SamlDrAccountSnapshotStorage,
  input: SamlDrNameIdAccountIdentity & { registryKey: string }
): Promise<string | null> {
  const expected = validateSamlDrNameIdAccount(input);
  const registry = parseSamlDrNameIdRegistryKey(input.registryKey);
  assertIdentity(registry, expected);
  const key = await storageKey(registry.registryKey);
  return storage.transaction(async (transaction) => {
    await assertSamlDrNameIdAuthority(transaction, expected);
    const saved = await transaction.get(key);
    if (saved === undefined) return null;
    const row = normalizeSamlDrPersistentNameId(saved, expected);
    if (row.registryKey !== registry.registryKey) fail('record_invalid');
    return row.valueJson;
  });
}

export async function putSamlDrNameId(
  storage: SamlDrAccountSnapshotStorage,
  input: SamlDrNameIdAccountIdentity & { registryKey: string; valueJson: string }
): Promise<void> {
  const expected = validateSamlDrNameIdAccount(input);
  const incoming = checkedRecord(input);
  const key = await storageKey(incoming.registryKey);
  await storage.transaction(async (transaction) => {
    await assertSamlDrNameIdAuthority(transaction, expected);
    const existing = await transaction.get(key);
    if (existing !== undefined) {
      const saved = normalizeSamlDrPersistentNameId(existing, expected);
      if (saved.registryKey !== incoming.registryKey) fail('record_invalid');
      const parsed = validateSamlDrNameIdRecord(saved.registryKey, saved.valueJson);
      if (parsed.nameId !== incoming.nameId) fail('conflict');
      // Concurrent creation of the same deterministic NameID must preserve its first timestamp.
      return;
    }
    if (
      (
        await transaction.list({
          prefix: SAML_DR_NAMEID_RECORD_PREFIX,
          limit: SAML_DR_NAMEID_MAX_RECORDS,
        })
      ).size >= SAML_DR_NAMEID_MAX_RECORDS
    )
      fail('record_limit');
    await transaction.put(key, {
      tenantId: incoming.tenantId,
      registryKey: incoming.registryKey,
      valueJson: incoming.valueJson,
      createdAtMs: incoming.createdAtMs,
    } satisfies SamlDrPersistentNameId);
  });
}
