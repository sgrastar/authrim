/**
 * Which operation a creation whose key is derived from its request goes to: its key's generations.
 *
 * An auth sign-up's idempotency key is fixed by what the person asked for (the tenant, the flow,
 * the address, the runtime user), and so is a SCIM create's sent without an Idempotency-Key. The
 * same request after the account was deleted (by an administrator, by SCIM, or by the clean-up of
 * unfinished sign-ups) has the key of the first one. Its first operation succeeded long ago;
 * acquiring it again would hand back the deleted account. Each such key therefore has
 * generations: the key itself (generation 0), then `<key>:g<n>`. (A key the caller chose, as the
 * administrator's create and an explicit SCIM Idempotency-Key, keeps the plain replay contract;
 * so does a guest's, whose key is its browser's resume credential: the deletion leaves that
 * credential's device row, which a new account could not take over.)
 * A request goes to the newest generation the operations table holds:
 *
 * - its account was never written, or is not deleted: that generation (the same request again,
 *   or a resume of it, reaches the same operation, as before);
 * - its account is being deleted, or is deleted but its directory removal has not finished: a
 *   retryable refusal. The Lookup reservations of its address are released only by that removal,
 *   so a new account of the same address could not reserve it until then (see below);
 * - its account is deleted and every directory removal of it succeeded: the next generation,
 *   created by `acquire` (the table's unique (tenant, actor, key) admits one row: two sign-ups at
 *   once both land on the winner's row, as one request).
 *
 * A generation is made only after the one before it was seen removed, and an account's lifecycle
 * never goes back from `deleted`, so the newest generation is the only one that can still be live.
 * At most MAX_ACCOUNT_CREATION_GENERATIONS: past that the request is refused (a fixed key
 * re-created that often is not a person signing up again).
 *
 * Why not advance while the old account is still `deleting`: the deletion holds the address's
 * email_exact reservation until its directory removal is published, and the tombstone, the
 * erasure and the runtime user's removal run in that same saga. A new generation made before then
 * would try to reserve the address against the old account's reservation and be blocked for good
 * (`directory_identifier_reservation_conflict`), and its PII writes would race the erasure of the
 * same tenant's rows. Waiting for the removal costs the person one retry, after which the address
 * is free and the old account's PII is gone.
 */
import type { Env } from '@authrim/ar-lib-core';
import type {
  AccountCreationOperation,
  AccountCreationOperationRepository,
} from './account-creation-operation';
import {
  findAccountDeletionStateOnTenantShards,
  type AccountDeletionStateOnShard,
} from './cross-shard-account-list';

export const MAX_ACCOUNT_CREATION_GENERATIONS = 32;

/** The previous generation's account is still being deleted: retry once that has finished. */
export const ACCOUNT_CREATION_PREVIOUS_ACCOUNT_DELETING =
  'account_creation_previous_account_deleting';
/** The key has used all its generations. */
export const ACCOUNT_CREATION_GENERATIONS_EXHAUSTED = 'account_creation_generations_exhausted';

export function accountCreationGenerationKey(idempotencyKey: string, generation: number): string {
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    generation >= MAX_ACCOUNT_CREATION_GENERATIONS
  ) {
    throw new Error(ACCOUNT_CREATION_GENERATIONS_EXHAUSTED);
  }
  return generation === 0 ? idempotencyKey : `${idempotencyKey}:g${generation}`;
}

/** What became of a generation's account. */
export type PreviousAccountState = 'live' | 'deleting' | 'removed';

export type PreviousAccountStateReader = (
  operation: AccountCreationOperation
) => Promise<PreviousAccountState>;

/** Statuses whose account has been written (its row exists from then on: rows are never purged). */
const WRITTEN_STATUSES: ReadonlySet<AccountCreationOperation['status']> = new Set([
  'directory_pending',
  'succeeded',
]);

/**
 * The generation's state from its account as the tenant's current core shards hold it.
 *
 * - No row: the account is still to be written (or resumed) while the operation is before its
 *   write; once the operation says it was written, a missing row is refused (fail closed: it is
 *   not proof of a deletion).
 * - `deleting`, or `deleted` with a directory removal not yet succeeded: being deleted.
 * - `deleted` with every removal succeeded: removed. Also `deleted` with no removal row at all:
 *   a deletion writes its removals in the same batch as the move to `deleting`
 *   (insertPreparedAccountDirectoryRemovals), so a deleted account without them is one whose
 *   routing outbox was not carried over (a tenant backup rebuilds it, and the target's Lookup is
 *   rebuilt from the restored rows, which give a deleted, erased account no route and no
 *   reservation).
 */
export function classifyPreviousAccount(
  operation: Pick<AccountCreationOperation, 'status'>,
  found: AccountDeletionStateOnShard | null
): PreviousAccountState {
  if (!found) return WRITTEN_STATUSES.has(operation.status) ? 'deleting' : 'live';
  if (found.lifecycleState === 'deleting') return 'deleting';
  if (found.lifecycleState !== 'deleted') return 'live';
  if (found.removals.total === 0) return 'removed';
  return found.removals.succeeded === found.removals.total ? 'removed' : 'deleting';
}

/** Reads the account on the tenant's current core shards (not the operation's first route). */
export function previousAccountStateReader(env: Env): PreviousAccountStateReader {
  return async (operation) => {
    // Never published: nothing was written anywhere yet (or it is resumed by its own request).
    if (!operation.publication && !WRITTEN_STATUSES.has(operation.status)) return 'live';
    return classifyPreviousAccount(
      operation,
      await findAccountDeletionStateOnTenantShards(env, operation.tenantId, operation.accountId)
    );
  };
}

/**
 * The key of the generation the request goes to (see the module's comment). Throws
 * ACCOUNT_CREATION_PREVIOUS_ACCOUNT_DELETING (retryable) or ACCOUNT_CREATION_GENERATIONS_EXHAUSTED.
 */
export async function resolveAccountCreationGenerationKey(input: {
  repository: Pick<AccountCreationOperationRepository, 'findByIdempotencyKeys'>;
  tenantId: string;
  actorId: string;
  idempotencyKey: string;
  /** Only operations of the same request are its generations (another's key is left to acquire). */
  requestHash: string;
  readPreviousAccount: PreviousAccountStateReader;
}): Promise<string> {
  const keys = Array.from({ length: MAX_ACCOUNT_CREATION_GENERATIONS }, (_, generation) =>
    accountCreationGenerationKey(input.idempotencyKey, generation)
  );
  const operations = await input.repository.findByIdempotencyKeys({
    tenantId: input.tenantId,
    actorId: input.actorId,
    idempotencyKeys: keys,
  });
  let newest = -1;
  let newestOperation: AccountCreationOperation | undefined;
  for (const operation of operations) {
    if (operation.requestHash !== input.requestHash) continue;
    const generation = keys.indexOf(operation.idempotencyKey);
    if (generation > newest) {
      newest = generation;
      newestOperation = operation;
    }
  }
  if (!newestOperation) return keys[0];
  const state = await input.readPreviousAccount(newestOperation);
  if (state === 'live') return keys[newest];
  if (state === 'deleting') throw new Error(ACCOUNT_CREATION_PREVIOUS_ACCOUNT_DELETING);
  if (newest + 1 >= MAX_ACCOUNT_CREATION_GENERATIONS) {
    throw new Error(ACCOUNT_CREATION_GENERATIONS_EXHAUSTED);
  }
  return keys[newest + 1];
}
