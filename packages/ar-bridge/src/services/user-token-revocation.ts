/**
 * Revoking every stored upstream token of a user, before a PII-only deletion erases them
 * (ar-management's `DELETE /api/admin/users/:id/pii`, through the admin entrypoint's RPC).
 *
 * Once the ciphertext is erased the grants can no longer be revoked, so they are revoked first,
 * best-effort: an identity whose provider has no revocation endpoint, refuses, cannot be reached
 * or is not done within the time limit is answered as such, and the deletion goes on. The time
 * limit is for the whole call: the identities run side by side (at most
 * `MAX_CONCURRENT_REVOCATIONS` at a time; one not yet started at the deadline is not started).
 * Every provider request also ends by the deadline (it is aborted then; the provider may still
 * have revoked), so nothing is left running, and holding connections, once the call answered.
 *
 * The tokens are read once: a token stored after that read (a sign-in through the provider while
 * the deletion runs) is erased without being revoked. Closing that window would take a lock that
 * sign-ins share with the deletion; it is left open (it lasts at most the time limit).
 *
 * Only the user's active linked identities are read (as the erasure only erases those), and only
 * those that hold a stored token are revoked; the others need no provider call. Nothing logged or
 * answered holds a token, a linked identity id or the person's subject at the provider.
 */

import {
  createLogger,
  isValidPersistedUserId,
  normalizeExternalIdpTokenRevocationTimeoutMs,
  resolveAccountDataContext,
  type Env,
  USER_TOKEN_REVOCATION_TIMED_OUT,
  type LinkedIdentityTokenRevocationEntry,
  type LinkedIdentityTokenRevocationOutcome,
  type RevokeUserLinkedIdentityTokensInput,
  type RevokeUserLinkedIdentityTokensResult,
} from '@authrim/ar-lib-core';
import type { LinkedIdentity } from '../types';
import { listLinkedIdentities } from './linked-identity-store';
import { revokeLinkedIdentityTokens, type TokenRevocationResult } from './token-revocation';

const log = createLogger().module('USER-TOKEN-REVOCATION');

/** Tenant ids as the account data routes accept them (user ids: `isValidPersistedUserId`). */
const SAFE_TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

/**
 * Identities revoked at the same time. Each holds an outbound connection (a Worker invocation
 * has six), so some are kept free.
 */
const MAX_CONCURRENT_REVOCATIONS = 4;

export class UserTokenRevocationInputError extends Error {}
export class UserTokenRevocationTimeoutError extends Error {}

function parseInput(input: unknown): RevokeUserLinkedIdentityTokensInput {
  const value = input as Partial<RevokeUserLinkedIdentityTokensInput> | null;
  if (
    !value ||
    typeof value !== 'object' ||
    value.schemaVersion !== 1 ||
    typeof value.tenantId !== 'string' ||
    !SAFE_TENANT_ID.test(value.tenantId) ||
    !isValidPersistedUserId(value.userId)
  ) {
    throw new UserTokenRevocationInputError('user_token_revocation_input_invalid');
  }
  return {
    schemaVersion: 1,
    tenantId: value.tenantId,
    userId: value.userId,
    timeoutMs: normalizeExternalIdpTokenRevocationTimeoutMs(value.timeoutMs),
  };
}

function outcomeOf(result: TokenRevocationResult): LinkedIdentityTokenRevocationOutcome {
  if (!result.success) return 'failed';
  if (!result.accessTokenRevoked && !result.refreshTokenRevoked) return 'not_supported';
  return result.errors.length > 0 ? 'partially_revoked' : 'revoked';
}

const TIMED_OUT = Symbol('timed_out');

export async function revokeUserLinkedIdentityTokens(
  env: Env,
  rawInput: unknown
): Promise<RevokeUserLinkedIdentityTokensResult> {
  const input = parseInput(rawInput);
  // One deadline for the whole call, from its start: the reads race it too, and every provider
  // request ends by it. So the call answers within the time limit, before the caller stops
  // waiting (the limit and a grace period), and nothing of it is left running then.
  const deadlineMs = Date.now() + input.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve(TIMED_OUT);
    }, input.timeoutMs);
  });
  try {
    const reads = (async () => {
      const account = await resolveAccountDataContext(env, {
        tenantId: input.tenantId,
        accountId: `account:${input.userId}`,
      });
      if (account.legacyUserId !== input.userId) {
        throw new Error('user_token_revocation_account_mismatch');
      }
      // Past the deadline, the next read is not started.
      if (expired) return [];
      return (await listLinkedIdentities(env, input.tenantId, input.userId, account.piiDb)).filter(
        (identity) =>
          identity.tenantId === input.tenantId &&
          identity.userId === input.userId &&
          Boolean(identity.accessTokenEncrypted || identity.refreshTokenEncrypted)
      );
    })();
    const read = await Promise.race([reads, deadline]);
    if (read === TIMED_OUT) {
      void reads.catch(() => undefined);
      // Not an empty answer: the caller must not take it for "nothing to revoke".
      throw new UserTokenRevocationTimeoutError(USER_TOKEN_REVOCATION_TIMED_OUT);
    }
    return await revokeIdentities(env, read, deadlineMs, deadline, () => expired);
  } finally {
    clearTimeout(timer);
  }
}

async function revokeIdentities(
  env: Env,
  identities: LinkedIdentity[],
  deadlineMs: number,
  deadline: Promise<typeof TIMED_OUT>,
  isExpired: () => boolean
): Promise<RevokeUserLinkedIdentityTokensResult> {
  if (identities.length === 0) return { schemaVersion: 1, identities: [] };
  const entries: LinkedIdentityTokenRevocationEntry[] = identities.map((identity) => ({
    providerId: identity.providerId,
    outcome: 'timed_out',
  }));
  let next = 0;
  const worker = async () => {
    while (next < identities.length && !isExpired()) {
      const index = next++;
      const revocation = revokeLinkedIdentityTokens(env, identities[index], { deadlineMs }).catch(
        (): TokenRevocationResult => ({
          success: false,
          accessTokenRevoked: false,
          refreshTokenRevoked: false,
          errors: ['revocation_failed'],
        })
      );
      const settled = await Promise.race([revocation, deadline]);
      if (settled === TIMED_OUT) return;
      entries[index] = { providerId: identities[index].providerId, outcome: outcomeOf(settled) };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_REVOCATIONS, identities.length) }, () => worker())
  );

  const notRevoked = entries.filter((entry) => entry.outcome !== 'revoked').length;
  if (notRevoked > 0) {
    log.warn('Some upstream tokens were not revoked before erasure', {
      identities: entries.length,
      notRevoked,
    });
  }
  return { schemaVersion: 1, identities: entries };
}
