/**
 * Deleted accounts' records (users_pii_tombstone) and what they are used for.
 *
 * A deletion keeps, on the PII side, when, by whom and why the account was deleted, its retention
 * deadline, and a keyed fingerprint of its email (see createTombstoneEmailIndex), made with the
 * tombstone keyring (TOMBSTONE_HMAC_KEYRING, see tombstone-hmac-keyring). Nothing in it
 * gives the address back; the fingerprint answers only "was this address deleted?", made again
 * from an address someone presents: the tenant's re-registration block and the administrator's
 * check of an address.
 *
 * - account-lifecycle.deletion.tombstone_retention_days: how long a new record is kept.
 * - account-lifecycle.deletion.block_reregistration: refuse sign-up (and administrator creation)
 *   with an address whose record is within its retention.
 */

import { ensureDatabaseAdapter, type DatabaseAdapter } from '../db';
import { TombstoneRepository, type Tombstone } from '../repositories/pii/tombstone';
import type { Env } from '../types/env';
import { createLogger } from '../utils/logger';
import { resolveEffectiveSettings } from './effective-settings';
import { createTombstoneEmailIndex, normalizeLookupEmail } from './lookup-directory/blind-index';
import { resolveTenantAssignedDatabaseSourcesFromRegistry } from './tenant-database-resolver';
import { loadTombstoneHmacKeysFromEnv, type TombstoneHmacKeys } from './tombstone-hmac-keyring';

const log = createLogger().module('ACCOUNT-TOMBSTONE');

const RETENTION_KEY = 'account-lifecycle.deletion.tombstone_retention_days';
const BLOCK_KEY = 'account-lifecycle.deletion.block_reregistration';
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;
/** A tenant's PII stores are searched together; the same bound the tombstone admin API uses. */
const MAX_PII_STORES = 32;
const PII_STORE_CONCURRENCY = 4;

export interface AccountTombstonePolicy {
  retentionDays: number;
  blockReregistration: boolean;
}

/** What the functions here read; each may be replaced (tests, callers with their own cache). */
export interface AccountTombstoneDependencies {
  loadKeys?: (env: Env) => TombstoneHmacKeys | Promise<TombstoneHmacKeys>;
  resolvePiiStores?: (env: Env, tenantId: string) => Promise<DatabaseAdapter[]>;
}

/** Whether a retention-days value is one a tombstone may be given (a whole 1 to 3650). */
export function isValidTombstoneRetentionDays(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_RETENTION_DAYS &&
    value <= MAX_RETENTION_DAYS
  );
}

/**
 * The tenant's deleted-account policy: settings (tenant), else environment, else default.
 * Throws when the settings cannot be read or hold an invalid value, so that a deletion does not
 * quietly keep its record for a shorter time than the tenant chose.
 */
export async function resolveAccountTombstonePolicy(
  env: Pick<Env, 'SETTINGS'>,
  tenantId: string,
  options: { fresh?: boolean } = {}
): Promise<AccountTombstonePolicy> {
  const values = await resolveEffectiveSettings(env, 'account-lifecycle', {
    tenantId,
    fresh: options.fresh,
  });
  const retentionDays = values[RETENTION_KEY];
  const block = values[BLOCK_KEY];
  if (!isValidTombstoneRetentionDays(retentionDays) || typeof block !== 'boolean') {
    throw new Error('account_tombstone_policy_invalid');
  }
  return { retentionDays, blockReregistration: block };
}

async function defaultPiiStores(env: Env, tenantId: string): Promise<DatabaseAdapter[]> {
  const stores = await resolveTenantAssignedDatabaseSourcesFromRegistry(env, {
    tenantId,
    role: 'tenant_pii',
    dataRole: 'tenant_pii',
    maxStores: MAX_PII_STORES,
    concurrency: PII_STORE_CONCURRENCY,
  });
  return stores.map((store, index) =>
    ensureDatabaseAdapter(store.source, `account-tombstone-pii:${index}`)
  );
}

/**
 * The email index a new tombstone carries: made with the keyring's current key, under the
 * tombstone's own label. Null when the account has no email to keep a fingerprint of (or one the
 * lookup directory would not accept). Throws when the keyring cannot be read: every tombstone
 * that could carry an index does.
 */
export async function createTombstoneEmailIndexForDeletion(
  env: Env,
  email: string | null | undefined,
  deps: Pick<AccountTombstoneDependencies, 'loadKeys'> = {}
): Promise<string | null> {
  if (typeof email !== 'string' || email.trim() === '') return null;
  let normalized: string;
  try {
    normalized = normalizeLookupEmail(email);
  } catch {
    return null;
  }
  const keys = await (deps.loadKeys ?? loadTombstoneHmacKeysFromEnv)(env);
  return createTombstoneEmailIndex(normalized, keys.writeKey);
}

/**
 * The latest tombstone within its retention for an address, across the tenant's PII stores, or
 * null. Every generation of the keyring is tried, so a record is found whichever key made it
 * while that key stays in the keyring.
 */
export async function findActiveEmailTombstone(
  env: Env,
  input: { tenantId: string; email: string },
  deps: AccountTombstoneDependencies = {}
): Promise<Pick<Tombstone, 'deleted_at' | 'retention_until'> | null> {
  let normalized: string;
  try {
    normalized = normalizeLookupEmail(input.email);
  } catch {
    return null;
  }
  const keys = await (deps.loadKeys ?? loadTombstoneHmacKeysFromEnv)(env);
  const indexes = [
    ...new Set(
      await Promise.all(keys.readKeys.map((key) => createTombstoneEmailIndex(normalized, key)))
    ),
  ];
  const stores = await (deps.resolvePiiStores ?? defaultPiiStores)(env, input.tenantId);
  const found = await Promise.all(
    stores.map((store) =>
      new TombstoneRepository(store).findActiveByEmailIndexes(indexes, input.tenantId, store)
    )
  );
  return found.reduce<Pick<Tombstone, 'deleted_at' | 'retention_until'> | null>(
    (latest, row) => (row && (!latest || row.deleted_at > latest.deleted_at) ? row : latest),
    null
  );
}

/**
 * - allowed: the account may be created.
 * - blocked: the tenant blocks re-registration and an account with this email was deleted within
 *   the retention period.
 * - unavailable: the tenant's policy, or (once it blocks) the deletion records, could not be read;
 *   the account must not be created now. Unrelated to the address, so it may be answered as a
 *   temporary failure.
 */
export type EmailRegistrationCheck = 'allowed' | 'blocked' | 'unavailable';

/**
 * Whether a new account with this email may be created, as far as deleted accounts go. Callers
 * answer `blocked` as they answer any other unavailable sign-up (an address in use, sign-up
 * turned off), never saying the address was deleted.
 */
export async function checkEmailRegistration(
  env: Env,
  input: { tenantId: string; email: string | null | undefined },
  deps: AccountTombstoneDependencies = {}
): Promise<EmailRegistrationCheck> {
  if (typeof input.email !== 'string' || input.email.trim() === '') return 'allowed';
  let policy: AccountTombstonePolicy;
  try {
    policy = await resolveAccountTombstonePolicy(env, input.tenantId);
  } catch (error) {
    log.warn('Re-registration policy could not be read; the new account is not created', {
      tenantId: input.tenantId,
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return 'unavailable';
  }
  if (!policy.blockReregistration) return 'allowed';
  try {
    const tombstone = await findActiveEmailTombstone(
      env,
      { tenantId: input.tenantId, email: input.email },
      deps
    );
    if (!tombstone) return 'allowed';
    log.info('New account refused: the address belongs to a recently deleted account', {
      tenantId: input.tenantId,
    });
    return 'blocked';
  } catch (error) {
    log.warn('Re-registration check could not be made; the new account is not created', {
      tenantId: input.tenantId,
      errorType: error instanceof Error ? error.name : 'Unknown',
      errorCode:
        error instanceof Error && /^[a-z0-9_]{1,96}$/u.test(error.message)
          ? error.message
          : undefined,
    });
    return 'unavailable';
  }
}
