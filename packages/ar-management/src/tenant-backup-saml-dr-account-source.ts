import type { Env } from '@authrim/ar-lib-core';
import { getSessionRevocationStore } from '@authrim/ar-lib-core/services/session-revocation-store';
import {
  validateSamlDrNameIdAccount,
  validateSamlDrNameIdRecord,
} from '@authrim/ar-lib-core/services/saml-dr-nameid-registry';
import type {
  SamlDrAccountAuthState,
  SamlDrPasskeyCounter,
  SamlDrPersistentNameId,
} from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-snapshot';
import type { SamlDrAccountSnapshotPage } from '@authrim/ar-lib-core/durable-objects/saml-dr-account-snapshot';

export interface SamlDrAccountSourceInventory {
  tenantId: string;
  userId: string;
  accountId: string;
  passkeys: readonly {
    passkeyId: string;
    credentialId: string;
    counter: number | string;
    updatedAtMs: number;
  }[];
}

export interface SamlDrAccountSourceBoundary {
  tenantId: string;
  snapshotId: string;
  boundaryUnixMs: number;
}

export interface SamlDrAccountSourceCapture {
  accountAuthStates: SamlDrAccountAuthState[];
  passkeyCounters: SamlDrPasskeyCounter[];
  persistentNameIds: SamlDrPersistentNameId[];
}

function invalid(): never {
  throw new Error('saml_dr_account_source_invalid');
}

function isArray(value: unknown): boolean {
  return Array.isArray(value);
}

function instant(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function counter(value: number | string): bigint {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(text) || text.length > 10) invalid();
  const parsed = BigInt(text);
  if (parsed > 0xffff_ffffn) invalid();
  return parsed;
}

function authState(page: SamlDrAccountSnapshotPage, maximum: number): SamlDrAccountAuthState {
  const state = page.state;
  if (
    page.initialized !== true ||
    !state ||
    state.lifecycle === null ||
    !['active', 'suspended', 'locked', 'deleting', 'deleted', 'inactive'].includes(
      state.lifecycle
    ) ||
    !instant(state.lifecycleVersionMs, maximum) ||
    (state.lifecycleOperationId !== null &&
      (typeof state.lifecycleOperationId !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,256}$/u.test(state.lifecycleOperationId))) ||
    (state.revokedAfterMs !== null && !instant(state.revokedAfterMs, maximum)) ||
    (state.lastLoginAtMs !== null && !instant(state.lastLoginAtMs, maximum))
  )
    invalid();
  return {
    tenantId: page.tenantId,
    userId: page.userId,
    accountId: page.accountId,
    lifecycle: state.lifecycle,
    lifecycleVersionMs: state.lifecycleVersionMs,
    lifecycleOperationId: state.lifecycleOperationId,
    revokedAfterMs: state.revokedAfterMs,
    lastLoginAtMs: state.lastLoginAtMs,
  };
}

async function settledBatches<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
  keepGoing = false
) {
  let failed = false;
  for (let from = 0; from < items.length; from += 8) {
    const outcomes = await Promise.allSettled(items.slice(from, from + 8).map(run));
    if (outcomes.some((result) => result.status === 'rejected')) failed = true;
    if (failed && !keepGoing) break;
  }
  if (failed) invalid();
}

/**
 * The caller supplies the frozen Core inventory and owns shared writer admission. No live Core
 * reads, account initialization, KV fallback, or inferred zero counters occur in this adapter.
 */
export function createSamlDrAccountSnapshotSource(
  env: Pick<Env, 'SESSION_REVOCATION_STORE' | 'AUTH_RUNTIME_PORTS'> & {
    ENABLE_SAML_DR_EXPORT?: string;
  },
  inventory: readonly SamlDrAccountSourceInventory[]
) {
  if (env.ENABLE_SAML_DR_EXPORT !== 'true' || env.AUTH_RUNTIME_PORTS || !isArray(inventory))
    invalid();
  const accounts = structuredClone(inventory);
  const seenUsers = new Set<string>();
  const seenPasskeys = new Set<string>();
  const seenCredentials = new Set<string>();
  const tenantId = accounts[0]?.tenantId;
  for (const account of accounts) {
    validateSamlDrNameIdAccount(account);
    if (
      account.tenantId !== tenantId ||
      seenUsers.has(account.userId) ||
      !isArray(account.passkeys) ||
      account.passkeys.length > 1024
    )
      invalid();
    seenUsers.add(account.userId);
    for (const passkey of account.passkeys) {
      if (
        typeof passkey.passkeyId !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,256}$/u.test(passkey.passkeyId) ||
        typeof passkey.credentialId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,2048}$/u.test(passkey.credentialId) ||
        seenPasskeys.has(passkey.passkeyId) ||
        seenCredentials.has(passkey.credentialId) ||
        !instant(passkey.updatedAtMs)
      )
        invalid();
      counter(passkey.counter);
      seenPasskeys.add(passkey.passkeyId);
      seenCredentials.add(passkey.credentialId);
    }
  }
  const boundary = (input: SamlDrAccountSourceBoundary) => {
    if (
      !input ||
      typeof input.tenantId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.tenantId) ||
      (tenantId !== undefined && input.tenantId !== tenantId) ||
      typeof input.snapshotId !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,128}$/u.test(input.snapshotId) ||
      !instant(input.boundaryUnixMs)
    )
      invalid();
    return {
      tenantId: input.tenantId,
      snapshotId: input.snapshotId,
      boundaryUnixMs: input.boundaryUnixMs,
    };
  };
  const request = (account: SamlDrAccountSourceInventory, input: SamlDrAccountSourceBoundary) => ({
    ...input,
    userId: account.userId,
    accountId: account.accountId,
  });
  const store = (account: SamlDrAccountSourceInventory) =>
    getSessionRevocationStore(env, account.tenantId, account.userId);

  return {
    async start(
      input: SamlDrAccountSourceBoundary,
      assertHeld: () => Promise<void>
    ): Promise<void> {
      const frozen = boundary(input);
      await assertHeld();
      await settledBatches(accounts, async (account) => {
        await assertHeld();
        await store(account).startSamlDrSnapshotRpc(request(account, frozen));
        await assertHeld();
      });
      await assertHeld();
    },
    async read(input: SamlDrAccountSourceBoundary): Promise<SamlDrAccountSourceCapture> {
      const frozen = boundary(input);
      const result: SamlDrAccountSourceCapture = {
        accountAuthStates: [],
        passkeyCounters: [],
        persistentNameIds: [],
      };
      const allRegistryKeys = new Set<string>();
      for (const account of accounts) {
        const expectedPasskeys = new Map(account.passkeys.map((row) => [row.passkeyId, row]));
        const seen = new Set<string>();
        let savedState: SamlDrAccountAuthState | undefined;
        let totals: { counters: number; nameIds: number } | undefined;
        let nameIdCount = 0;
        for (let pageIndex = 0; pageIndex < 512; pageIndex += 1) {
          const page = await store(account)
            .readSamlDrSnapshotPageRpc({
              ...request(account, frozen),
              ...(pageIndex > 0 ? { cursor: String(pageIndex) } : {}),
            })
            .catch(() => invalid());
          if (
            !page ||
            page.tenantId !== frozen.tenantId ||
            page.userId !== account.userId ||
            page.accountId !== account.accountId ||
            page.snapshotId !== frozen.snapshotId ||
            page.boundaryUnixMs !== frozen.boundaryUnixMs ||
            page.nameIdRegistryInitialized !== true ||
            !Number.isSafeInteger(page.totalPasskeyCounters) ||
            page.totalPasskeyCounters < 0 ||
            page.totalPasskeyCounters > 1024 ||
            !Number.isSafeInteger(page.totalPersistentNameIds) ||
            page.totalPersistentNameIds < 0 ||
            page.totalPersistentNameIds > 1024 ||
            !isArray(page.passkeyCounters) ||
            !isArray(page.persistentNameIds)
          )
            invalid();
          const state = authState(page, frozen.boundaryUnixMs);
          if (savedState && JSON.stringify(state) !== JSON.stringify(savedState)) invalid();
          savedState ??= state;
          totals ??= { counters: page.totalPasskeyCounters, nameIds: page.totalPersistentNameIds };
          if (
            totals.counters !== page.totalPasskeyCounters ||
            totals.nameIds !== page.totalPersistentNameIds ||
            totals.counters !== expectedPasskeys.size
          )
            invalid();
          const pages = Math.max(
            1,
            Math.ceil(totals.counters / 128),
            Math.ceil(totals.nameIds / 2)
          );
          if (
            pageIndex >= pages ||
            page.passkeyCounters.length !==
              Math.max(0, Math.min(128, totals.counters - pageIndex * 128)) ||
            page.persistentNameIds.length !==
              Math.max(0, Math.min(2, totals.nameIds - pageIndex * 2)) ||
            page.nextCursor !== (pageIndex + 1 < pages ? String(pageIndex + 1) : null)
          )
            invalid();
          for (const row of page.passkeyCounters) {
            const expected = expectedPasskeys.get(row.credentialId);
            if (
              !expected ||
              seen.has(row.credentialId) ||
              !instant(row.updatedAtMs, frozen.boundaryUnixMs) ||
              expected.updatedAtMs > frozen.boundaryUnixMs ||
              counter(row.counter) < counter(expected.counter)
            )
              invalid();
            seen.add(row.credentialId);
            result.passkeyCounters.push({
              tenantId: frozen.tenantId,
              userId: account.userId,
              passkeyId: row.credentialId,
              credentialId: expected.credentialId,
              counter: counter(row.counter).toString(),
              updatedAtMs: row.updatedAtMs,
            });
          }
          for (const row of page.persistentNameIds) {
            if (
              !row ||
              row.tenantId !== frozen.tenantId ||
              !instant(row.createdAtMs, frozen.boundaryUnixMs) ||
              allRegistryKeys.has(row.registryKey)
            )
              invalid();
            const parsed = validateSamlDrNameIdRecord(row.registryKey, row.valueJson);
            if (
              parsed.tenantId !== frozen.tenantId ||
              parsed.userId !== account.userId ||
              parsed.createdAtMs !== row.createdAtMs
            )
              invalid();
            allRegistryKeys.add(row.registryKey);
            nameIdCount += 1;
            result.persistentNameIds.push({
              tenantId: row.tenantId,
              registryKey: row.registryKey,
              valueJson: row.valueJson,
              createdAtMs: row.createdAtMs,
            });
          }
          if (page.nextCursor === null) break;
        }
        if (
          !savedState ||
          !totals ||
          seen.size !== expectedPasskeys.size ||
          nameIdCount !== totals.nameIds
        )
          invalid();
        result.accountAuthStates.push(savedState);
      }
      return result;
    },
    async release(input: SamlDrAccountSourceBoundary): Promise<void> {
      const frozen = boundary(input);
      await settledBatches(
        accounts,
        (account) => store(account).releaseSamlDrSnapshotRpc(request(account, frozen)),
        true
      );
    },
    async assertReleased(input: SamlDrAccountSourceBoundary): Promise<void> {
      const frozen = boundary(input);
      await settledBatches(
        accounts,
        (account) => store(account).assertSamlDrSnapshotReleasedRpc(request(account, frozen)),
        true
      );
    },
  };
}
