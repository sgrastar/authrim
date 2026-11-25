import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { argRec, callArg } from './helpers/mock-args';

const m = vi.hoisted(() => ({
  resolveByIdentifier: vi.fn(),
  probe: vi.fn(),
  lock: vi.fn(),
  ensureDb: vi.fn(),
  findLinked: vi.fn(),
  queryOne: vi.fn(),
  assertHeld: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (original) => {
  const actual = await original<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveAccountDataContextByIdentifier: m.resolveByIdentifier,
    probeAccountForProviderDataDeletion: m.probe,
    withLoginMethodRemovalLock: m.lock,
    ensureDatabaseAdapter: m.ensureDb,
  };
});
vi.mock('../services/linked-identity-store', () => ({ findLinkedIdentity: m.findLinked }));

import {
  ProviderDataDeletionError,
  linkedIdentityRemovalOperationId,
  unlinkProviderSubject,
} from '../services/provider-data-deletion';

const ACCOUNT = {
  accountId: 'account:user-a',
  legacyUserId: 'user-a',
  piiDb: { pii: 1 },
  coreDb: { core: 1 },
};
const INPUT = {
  tenantId: 'tenant-a',
  providerId: 'provider-fb',
  providerUserId: 'fb-user',
  requestIssuedAt: 1_700_000_000,
};
const IDENTITY = {
  id: 'link-a',
  userId: 'user-a',
  providerId: 'provider-fb',
  providerUserId: 'fb-user',
  linkedAt: 1_700_000_000_000,
};

function makeEnv(extra: Record<string, unknown> = {}): Env {
  return {
    EXTERNAL_IDP_ACCOUNT_PROVISIONER: { removeExternalIdpRoute: m.remove },
    ...extra,
  } as unknown as Env;
}

async function expectedOperation() {
  return linkedIdentityRemovalOperationId('tenant-a', ACCOUNT.accountId, 'link-a');
}

beforeEach(() => {
  vi.clearAllMocks();
  m.resolveByIdentifier.mockReset().mockResolvedValue(ACCOUNT);
  m.findLinked.mockReset().mockResolvedValue(IDENTITY);
  m.queryOne.mockReset().mockResolvedValue(null);
  m.ensureDb.mockReset().mockReturnValue({ queryOne: m.queryOne });
  m.assertHeld.mockReset().mockResolvedValue(undefined);
  m.lock
    .mockReset()
    .mockImplementation(
      async (_env: unknown, _t: string, _u: string, fn: (l: unknown) => Promise<unknown>) =>
        fn({ owner: 'lease-owner', assertHeld: m.assertHeld })
    );
  m.remove
    .mockReset()
    .mockImplementation(async (req: { operationId: string; accountId: string }) => ({
      operationId: req.operationId,
      accountId: req.accountId,
      status: 202,
    }));
  m.probe.mockReset();
});

describe('linkedIdentityRemovalOperationId', () => {
  it('derives the same operation as the account page from tenant, account and link', async () => {
    const { digest, operationId } = await linkedIdentityRemovalOperationId('t', 'a', 'l');
    // SHA-256 of "t\0a\0l"
    const bytes = new TextEncoder().encode('t\u0000a\u0000l');
    const expected = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('');
    expect(digest).toBe(expected);
    expect(operationId).toBe(`external-idp-route-remove-${expected.slice(0, 32)}`);
  });
});

describe('finding the account', () => {
  it('asks the Lookup directory primary for active, suspended or locked accounts', async () => {
    await unlinkProviderSubject(makeEnv(), INPUT);
    expect(m.resolveByIdentifier).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      indexKind: 'external_subject',
      identifier: { issuer: 'provider-fb', subject: 'fb-user' },
      acceptLifecycle: 'restricted',
      freshRoute: true,
    });
  });

  it('answers no_link when no route names the subject, and rethrows other failures', async () => {
    m.resolveByIdentifier.mockRejectedValue(new Error('account_data_route_not_found'));
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).resolves.toEqual({ outcome: 'no_link' });
    expect(m.findLinked).not.toHaveBeenCalled();
    m.resolveByIdentifier.mockRejectedValue(new Error('lookup down'));
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).rejects.toThrow('lookup down');
    m.resolveByIdentifier.mockRejectedValue('account_data_route_not_found');
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).rejects.toBe(
      'account_data_route_not_found'
    );
  });
});

describe('an account that is not active, suspended or locked', () => {
  const inactive = () =>
    new Error('lookup_destination_revalidation_failed', { cause: 'account_inactive' });
  const base = { userId: 'user-a', accountId: 'account:user-a' };

  beforeEach(() => {
    m.resolveByIdentifier.mockRejectedValue(inactive());
  });

  it('probes the account and what remains of the subject, read-only', async () => {
    m.probe.mockResolvedValue({
      lifecycleState: 'deleted',
      legacyUserId: 'user-a',
      accountId: 'account:user-a',
      providerDataRemains: false,
    });
    await unlinkProviderSubject(makeEnv(), INPUT);
    const subject = { issuer: 'provider-fb', subject: 'fb-user' };
    expect(m.probe).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      account: subject,
      remains: subject,
    });
  });

  it.each([
    ['deleted and erased', 'deleted', false, false, 'account_deleted'],
    ['deleted but data remains', 'deleted', true, false, 'account_inactive'],
    ['deleting under a hold', 'deleting', false, true, 'retained'],
    ['deleting without a hold', 'deleting', false, false, 'account_inactive'],
    ['deleting with data remaining under a hold', 'deleting', true, true, 'retained'],
    ['in another state', 'archived', false, true, 'account_inactive'],
  ])('answers %s', async (_n, lifecycleState, providerDataRemains, legalHoldActive, outcome) => {
    m.probe.mockResolvedValue({
      lifecycleState,
      legacyUserId: 'user-a',
      accountId: 'account:user-a',
      providerDataRemains,
      legalHoldActive,
    });
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).resolves.toEqual({ outcome, ...base });
  });

  it('answers no_link when the account route is gone by then', async () => {
    m.probe.mockRejectedValue(new Error('account_data_route_not_found'));
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).resolves.toEqual({ outcome: 'no_link' });
  });

  it('answers account_inactive, without an account, when it became inactive again', async () => {
    m.probe.mockRejectedValue(inactive());
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).resolves.toEqual({
      outcome: 'account_inactive',
    });
  });

  it('rethrows any other probe failure', async () => {
    m.probe.mockRejectedValue(new Error('probe down'));
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).rejects.toThrow('probe down');
  });

  it.each([
    ['another message', new Error('x', { cause: 'account_inactive' })],
    ['another cause', new Error('lookup_destination_revalidation_failed', { cause: 'other' })],
    ['no cause', new Error('lookup_destination_revalidation_failed')],
    [
      'not an Error',
      { message: 'lookup_destination_revalidation_failed', cause: 'account_inactive' },
    ],
  ])('treats an error with %s as a failure', async (_n, error) => {
    m.resolveByIdentifier.mockRejectedValue(error);
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).rejects.toBe(error);
    expect(m.probe).not.toHaveBeenCalled();
  });
});

describe('an account that holds no link to remove', () => {
  it('looks the link up in the account PII database', async () => {
    await unlinkProviderSubject(makeEnv(), INPUT);
    expect(m.findLinked).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      'provider-fb',
      'fb-user',
      ACCOUNT.piiDb
    );
  });

  it('reports no_link when no unlink of the subject is open', async () => {
    m.findLinked.mockResolvedValue(null);
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).resolves.toEqual({ outcome: 'no_link' });
    expect(m.ensureDb).toHaveBeenCalledWith(
      ACCOUNT.piiDb,
      'external-idp-data-deletion-open-unlink'
    );
    const sql = String(callArg(m.queryOne, 0, 0));
    expect(sql).toContain('FROM external_identifier_unlink_operations');
    expect(sql).toContain("state IN ('pending', 'directory_pending', 'blocked')");
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(sql).toContain('LIMIT 1');
    const params = callArg(m.queryOne, 0, 1) as string[];
    expect(params[0]).toBe('tenant-a');
    expect(params[1]).toBe('account:user-a');
    expect(params[2]).toMatch(/^[0-9a-f]{64}$/);
    expect(params[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(params[2]).not.toBe(params[3]);
    expect(callArg(m.queryOne, 0, 2)).toEqual({ consistencyClass: 'primary_required' });
  });

  it('reports a still-running unlink as pending', async () => {
    m.findLinked.mockResolvedValue(null);
    m.queryOne.mockResolvedValue({ operation_id: 'op-open', state: 'directory_pending' });
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).resolves.toEqual({
      outcome: 'unlink_pending',
      userId: 'user-a',
      accountId: 'account:user-a',
      unlinkOperationId: 'op-open',
    });
  });

  it('flags a stopped unlink for the administrator', async () => {
    m.findLinked.mockResolvedValue(null);
    m.queryOne.mockResolvedValue({ operation_id: 'op-open', state: 'blocked' });
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).resolves.toMatchObject({
      outcome: 'unlink_pending',
      attention: 'unlink_blocked',
    });
  });

  it.each([
    ['a request that already removed it', { mayRemoveLink: false }, IDENTITY],
    [
      'a link made in a later second than the request',
      {},
      { ...IDENTITY, linkedAt: 1_700_000_001_000 },
    ],
  ])('leaves %s alone', async (_n, extra, identity) => {
    m.findLinked.mockResolvedValue(identity);
    await expect(unlinkProviderSubject(makeEnv(), { ...INPUT, ...extra })).resolves.toEqual({
      outcome: 'no_link',
    });
    expect(m.lock).not.toHaveBeenCalled();
  });

  it.each([
    ['the request second', 1_700_000_000_999],
    ['an earlier second', 1_699_999_999_000],
    ['an unknown time', Number.NaN],
  ])('removes a link made at %s', async (_n, linkedAt) => {
    m.findLinked.mockResolvedValue({ ...IDENTITY, linkedAt });
    const res = await unlinkProviderSubject(makeEnv(), INPUT);
    expect(res.outcome).toBe('unlink_pending');
  });

  it('removes the link when mayRemoveLink is not given', async () => {
    await expect(
      unlinkProviderSubject(makeEnv(), { ...INPUT, mayRemoveLink: true })
    ).resolves.toMatchObject({
      outcome: 'unlink_pending',
    });
  });

  it.each([
    ['another user', { ...IDENTITY, userId: 'user-b' }],
    ['another provider', { ...IDENTITY, providerId: 'other' }],
  ])('refuses a link of %s', async (_n, identity) => {
    m.findLinked.mockResolvedValue(identity);
    const err = await unlinkProviderSubject(makeEnv(), INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderDataDeletionError);
    expect((err as Error).message).toBe('provider_data_deletion_account_mismatch');
  });

  it('refuses to run without the account provisioner', async () => {
    const err = await unlinkProviderSubject(
      makeEnv({ EXTERNAL_IDP_ACCOUNT_PROVISIONER: undefined }),
      INPUT
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderDataDeletionError);
    expect((err as Error).message).toBe('external_idp_account_provisioner_unavailable');
    expect(m.lock).not.toHaveBeenCalled();
  });
});

describe('removing the link under the lease', () => {
  it('takes the removal lease of the account user', async () => {
    const env = makeEnv();
    await unlinkProviderSubject(env, INPUT);
    expect(m.lock).toHaveBeenCalledWith(env, 'tenant-a', 'user-a', expect.any(Function));
  });

  it('asks the saga for the same operation as the account page, as a restricted account may be', async () => {
    const { digest, operationId } = await expectedOperation();
    const res = await unlinkProviderSubject(makeEnv(), INPUT);
    expect(argRec(m.remove)).toEqual({
      schemaVersion: 1,
      operationId,
      idempotencyKey: `auth-external-idp-route-remove:${digest}`,
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
      userId: 'user-a',
      linkedIdentityId: 'link-a',
      providerId: 'provider-fb',
      providerUserId: 'fb-user',
      removalLeaseOwner: 'lease-owner',
      restrictedAccountAllowed: true,
    });
    expect(res).toEqual({
      outcome: 'unlink_pending',
      userId: 'user-a',
      accountId: 'account:user-a',
      linkedIdentityId: 'link-a',
      unlinkOperationId: operationId,
    });
    expect(m.assertHeld).toHaveBeenCalledTimes(1);
  });

  it('answers unlinked when the cleanup already finished (201)', async () => {
    m.remove.mockImplementation(async (req: { operationId: string; accountId: string }) => ({
      operationId: req.operationId,
      accountId: req.accountId,
      status: 201,
    }));
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).resolves.toMatchObject({
      outcome: 'unlinked',
    });
  });

  it('re-reads the link under the lease and leaves a replaced link alone', async () => {
    m.findLinked
      .mockResolvedValueOnce(IDENTITY)
      .mockResolvedValueOnce({ ...IDENTITY, id: 'link-newer' });
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).resolves.toEqual({ outcome: 'no_link' });
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.findLinked).toHaveBeenCalledTimes(2);
  });

  it('treats a link removed under the lease as no link', async () => {
    m.findLinked.mockResolvedValueOnce(IDENTITY).mockResolvedValueOnce(null);
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).resolves.toEqual({ outcome: 'no_link' });
    expect(m.remove).not.toHaveBeenCalled();
  });

  it('reports a request still open after a change under the lease', async () => {
    m.findLinked
      .mockResolvedValueOnce(IDENTITY)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    m.queryOne.mockResolvedValue({ operation_id: 'op-x', state: 'pending' });
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).resolves.toMatchObject({
      outcome: 'unlink_pending',
      unlinkOperationId: 'op-x',
    });
  });

  it('asks the payload guard under the lease and leaves the link when it was removed', async () => {
    const alreadyRemoved = vi.fn().mockResolvedValue(true);
    const markRemoved = vi.fn();
    await expect(
      unlinkProviderSubject(makeEnv(), { ...INPUT, payloadGuard: { alreadyRemoved, markRemoved } })
    ).resolves.toEqual({ outcome: 'no_link' });
    expect(alreadyRemoved).toHaveBeenCalledTimes(1);
    expect(markRemoved).not.toHaveBeenCalled();
    expect(m.remove).not.toHaveBeenCalled();
  });

  it('marks the payload removed after the saga accepted, before looking for a late hold', async () => {
    const order: string[] = [];
    const markRemoved = vi.fn(async () => void order.push('mark'));
    m.remove.mockImplementation(async (req: { operationId: string; accountId: string }) => {
      order.push('remove');
      return { operationId: req.operationId, accountId: req.accountId, status: 202 };
    });
    m.queryOne.mockImplementation(async () => {
      order.push('hold-check');
      return null;
    });
    await unlinkProviderSubject(makeEnv(), {
      ...INPUT,
      payloadGuard: { alreadyRemoved: async () => false, markRemoved },
    });
    expect(order).toEqual(['hold-check', 'remove', 'mark', 'hold-check']);
  });

  it('keeps everything under an active legal hold, and does not even take the lease check further', async () => {
    m.queryOne.mockResolvedValue({ id: 'hold-1' });
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).resolves.toEqual({
      outcome: 'retained',
      userId: 'user-a',
      accountId: 'account:user-a',
      linkedIdentityId: 'link-a',
    });
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.assertHeld).not.toHaveBeenCalled();
    expect(m.ensureDb).toHaveBeenCalledWith(ACCOUNT.coreDb, 'external-idp-data-deletion-hold');
    expect(String(callArg(m.queryOne, 0, 0))).toContain("subject_type = 'account'");
    expect(String(callArg(m.queryOne, 0, 0))).toContain("state = 'active'");
    expect(callArg(m.queryOne, 0, 1)).toEqual(['tenant-a', 'account:user-a']);
    expect(callArg(m.queryOne, 0, 2)).toEqual({ consistencyClass: 'primary_required' });
  });

  it('flags a hold placed while the link was being removed', async () => {
    m.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'hold-late' });
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).resolves.toMatchObject({
      outcome: 'unlink_pending',
      attention: 'hold_placed_during_unlink',
    });
  });

  it('does not continue when the lease was lost', async () => {
    m.assertHeld.mockRejectedValue(new Error('lease_lost'));
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).rejects.toThrow('lease_lost');
    expect(m.remove).not.toHaveBeenCalled();
  });

  it('propagates a busy account', async () => {
    m.lock.mockRejectedValue(new Error('login_method_removal_in_progress'));
    await expect(unlinkProviderSubject(makeEnv(), INPUT)).rejects.toThrow(
      'login_method_removal_in_progress'
    );
  });

  it.each([
    ['another operation', { operationId: 'other' }],
    ['another account', { accountId: 'account:other' }],
    ['status 200', { status: 200 }],
    ['status 500', { status: 500 }],
  ])('refuses a saga answer with %s', async (_n, override) => {
    m.remove.mockImplementation(async (req: { operationId: string; accountId: string }) => ({
      operationId: req.operationId,
      accountId: req.accountId,
      status: 202,
      ...override,
    }));
    const err = await unlinkProviderSubject(makeEnv(), INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderDataDeletionError);
    expect((err as Error).message).toBe('external_idp_route_removal_response_invalid');
  });
});
