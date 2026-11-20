import { describe, expect, it, vi } from 'vitest';
import type { StoreChallengeRequest } from '@authrim/ar-lib-core';
import { provisionAccount, provisionGuestAccount } from '../account-provisioning';
import {
  OPERATION_ID,
  TENANT_ID,
  accountContext,
  sha256HexOf,
} from './helpers/mut-account-context';

type ProvisionInput = Parameters<typeof provisionAccount>[1];

function input(runtimeUser: Record<string, unknown> = {}): ProvisionInput {
  return {
    tenantId: TENANT_ID,
    candidateUserId: 'user-a',
    flow: 'email_code',
    email: 'person@example.com',
    runtimeUser: {
      active: true,
      emailVerified: false,
      userType: 'end_user',
      sourceRef: 'auth:email_code',
      ...runtimeUser,
    },
  };
}

const ready = () =>
  vi.fn().mockResolvedValue({
    status: 201,
    operationId: OPERATION_ID,
    accountId: 'account:user-a',
    userId: 'user-a',
  });

describe('account provisioning request', () => {
  it('sends the full request with a digest of the canonical stable fields', async () => {
    const provision = ready();
    const { c } = accountContext({ provision });
    await provisionAccount(c, input({ tags: ['b', 1, true, null] }));
    const canonical =
      '{"email":"person@example.com","flow":"email_code","runtimeUser":{"active":true,' +
      '"emailVerified":false,"sourceRef":"auth:email_code","tags":["b",1,true,null],' +
      '"userType":"end_user"},"schemaVersion":1,"tenantId":"tenant-a"}';
    const request = provision.mock.calls[0][0] as Record<string, unknown>;
    expect(request.operationId).toMatch(/^account-create-[0-9a-f-]{36}$/u);
    expect(request).toEqual({
      schemaVersion: 1,
      operationId: request.operationId,
      idempotencyKey: `auth-account:${await sha256HexOf(canonical)}`,
      tenantId: TENANT_ID,
      candidateUserId: 'user-a',
      flow: 'email_code',
      email: 'person@example.com',
      runtimeUser: input({ tags: ['b', 1, true, null] }).runtimeUser,
    });
  });

  it('accepts the same object or array reached twice without a cycle', async () => {
    const shared = ['x'];
    const sharedObject = { k: 1 };
    const provision = ready();
    const { c } = accountContext({ provision });
    await expect(
      provisionAccount(c, input({ a: shared, b: shared, c: sharedObject, d: sharedObject }))
    ).resolves.toMatchObject({ status: 'ready' });
  });

  it.each([
    ['a non-finite number', () => ({ score: Number.NaN })],
    ['an infinite number', () => ({ score: Number.POSITIVE_INFINITY })],
    ['an undefined value', () => ({ missing: undefined })],
    ['a function', () => ({ fn: () => 1 })],
    [
      'a cyclic array',
      () => {
        const list: unknown[] = [];
        list.push(list);
        return { list };
      },
    ],
    [
      'a cyclic object',
      () => {
        const node: Record<string, unknown> = {};
        node.self = node;
        return { node };
      },
    ],
  ])('refuses %s before calling the provisioner', async (_label, extra) => {
    const provision = ready();
    const { c } = accountContext({ provision });
    await expect(provisionAccount(c, input(extra()))).rejects.toThrow(
      'account_provisioning_value_invalid'
    );
    expect(provision).not.toHaveBeenCalled();
  });

  it('refuses without a provisioner', async () => {
    const { c } = accountContext({ withoutProvisioner: true });
    await expect(provisionAccount(c, input())).rejects.toThrow('account_provisioner_unavailable');
  });

  it('does not retry a non-Error rejection', async () => {
    const provision = vi.fn().mockRejectedValue('auth_account_provisioning_internal_error');
    const { c } = accountContext({ provision });
    await expect(provisionAccount(c, input())).rejects.toBe(
      'auth_account_provisioning_internal_error'
    );
    expect(provision).toHaveBeenCalledOnce();
  });

  it('answers a pending email account without a resume user id', async () => {
    const store = vi.fn().mockResolvedValue({ success: true });
    const { c } = accountContext({ store });
    const result = await provisionAccount(c, input());
    if (result.status !== 'pending') throw new Error('expected pending');
    const body = await result.response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual([
      'expires_in',
      'provisioning_token',
      'retry_after_ms',
      'status',
      'status_endpoint',
    ]);
    expect(body.expires_in).toBe(300);
    const stored = store.mock.calls[0][0] as StoreChallengeRequest;
    expect(stored.challenge).toBe(await sha256HexOf(body.provisioning_token as string));
  });
});

describe('guest account provisioning', () => {
  const resumeCredential = { credentialHash: 'd'.repeat(64), expiresInDays: 30 };
  const guestInput = { tenantId: TENANT_ID, candidateUserId: 'candidate-a', resumeCredential };

  it('refuses without a provisioner', async () => {
    const { c } = accountContext({ withoutProvisioner: true });
    await expect(provisionGuestAccount(c, guestInput)).rejects.toThrow(
      'account_provisioner_unavailable'
    );
  });

  it('sends the guest request with an unverified runtime user and digest key', async () => {
    const provision = ready();
    const { c } = accountContext({ provision });
    await expect(provisionGuestAccount(c, guestInput)).resolves.toEqual({
      status: 'ready',
      accountId: 'account:user-a',
      userId: 'user-a',
    });
    const request = provision.mock.calls[0][0] as Record<string, unknown>;
    expect(request).toMatchObject({
      schemaVersion: 1,
      tenantId: TENANT_ID,
      candidateUserId: 'candidate-a',
      flow: 'guest',
      email: null,
      runtimeUser: {
        active: true,
        emailVerified: false,
        userType: 'end_user',
        registrationState: 'guest',
        sourceRef: 'auth:guest',
        piiFields: {},
        sensitiveValues: {},
      },
    });
    expect(request.operationId).toMatch(/^account-create-[0-9a-f-]{36}$/u);
    expect(request.idempotencyKey).toMatch(/^auth-account:[a-f0-9]{64}$/u);
  });

  it('retries one lost internal response with the same request', async () => {
    const provision = vi
      .fn()
      .mockRejectedValueOnce(new Error('auth_account_provisioning_internal_error'))
      .mockResolvedValueOnce({
        status: 201,
        operationId: OPERATION_ID,
        accountId: 'account:user-a',
        userId: 'user-a',
      });
    const { c } = accountContext({ provision });
    await expect(provisionGuestAccount(c, guestInput)).resolves.toMatchObject({ status: 'ready' });
    expect(provision.mock.calls[1][0]).toEqual(provision.mock.calls[0][0]);
  });

  it('stores a guest resume challenge and answers 202 with a token', async () => {
    const store = vi.fn().mockResolvedValue({ success: true });
    const { c } = accountContext({ store });
    const result = await provisionGuestAccount(c, guestInput);
    if (result.status !== 'pending') throw new Error('expected pending');
    expect(result.response.status).toBe(202);
    const body = await result.response.json<Record<string, unknown>>();
    expect(body.provisioning_token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(body).toEqual({
      status: 'provisioning',
      provisioning_token: body.provisioning_token,
      status_endpoint: '/api/v1/auth/account-provisioning/status',
      retry_after_ms: 500,
      expires_in: 300,
    });
    const tokenHash = await sha256HexOf(body.provisioning_token as string);
    expect(store).toHaveBeenCalledWith({
      id: `account_provisioning:${tokenHash}`,
      tenantId: TENANT_ID,
      type: 'account_provisioning_resume',
      userId: 'user-a',
      challenge: tokenHash,
      ttl: 300,
      metadata: {
        schema_version: 1,
        operation_id: OPERATION_ID,
        flow: 'guest',
        account_id: 'account:user-a',
        user_id: 'user-a',
      },
    });
  });
});
