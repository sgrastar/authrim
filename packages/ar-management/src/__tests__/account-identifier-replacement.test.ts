import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAccountSession: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  batch: vi.fn(),
  findById: vi.fn(),
  notification: vi.fn(),
  resume: vi.fn(),
  warn: vi.fn(),
  repositoryCreate: vi.fn(),
  createBlindIndexes: vi.fn(),
}));

vi.mock('../account-page', () => ({
  requireAccountSession: mocks.requireAccountSession,
}));

vi.mock('../lookup-bucket-write-route', () => ({
  createLookupBucketWriteResolver: vi.fn(async () => vi.fn()),
}));

vi.mock('../identifier-replacement-coordinator', () => ({
  IdentifierReplacementCoordinator: vi.fn(function CoordinatorMock() {
    return { resume: mocks.resume };
  }),
  isPermanentIdentifierReplacementFailure: vi.fn(
    (error: unknown) =>
      error instanceof Error && error.message === 'identifier_replacement_reservation_conflict'
  ),
}));

vi.mock('../identifier-replacement-credential-revocation', () => ({
  revokeIdentifierReplacementCredentials: vi.fn(),
}));

vi.mock('../lookup-hmac-runtime', () => ({
  loadLookupHmacRuntimeKeys: vi.fn(async () => ({ readKeys: [] })),
}));

vi.mock('../identifier-replacement-operation', () => ({
  IdentifierReplacementOperationRepository: vi.fn(function OperationRepositoryMock() {
    return { create: mocks.repositoryCreate };
  }),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
    createPIIContextFromHono: vi.fn(() => ({
      defaultPiiAdapter: {
        queryOne: mocks.queryOne,
        execute: mocks.execute,
        batch: mocks.batch,
      },
    })),
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    CanonicalRuntimeUserStore: vi.fn(function RuntimeUserStoreMock() {
      return { findById: mocks.findById };
    }),
    produceNotificationDelivery: mocks.notification,
    createLookupBlindIndexes: mocks.createBlindIndexes,
    getLogger: vi.fn(() => ({
      module: () => ({ warn: mocks.warn }),
    })),
  };
});

import {
  completeAccountIdentifierReplacementHandler,
  getAccountIdentifierReplacementHandler,
  startAccountIdentifierReplacementHandler,
} from '../account-identifier-replacement';

function context(input: { body?: unknown; id?: string; idempotencyKey?: string } = {}) {
  const responseHeaders = new Headers();
  return {
    env: {
      OTP_HMAC_SECRET: 'test-identifier-replacement-secret-32-bytes',
      EMAIL_FROM: 'noreply@example.com',
    },
    req: {
      json: vi.fn(async () => input.body ?? {}),
      header: vi.fn((name: string) =>
        name === 'Idempotency-Key' ? input.idempotencyKey : undefined
      ),
      param: vi.fn(() => input.id),
    },
    header: (name: string, value: string) => responseHeaders.set(name, value),
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...Object.fromEntries(responseHeaders) },
      }),
  };
}

const currentSession = () => ({
  sessionId: 'session-current',
  userId: 'account-a',
  createdAt: Date.now() - 60_000,
  expiresAt: Date.now() + 60_000,
  authTime: Math.floor(Date.now() / 1000),
});

describe('account identifier replacement handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAccountSession.mockResolvedValue(currentSession());
    mocks.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.findById.mockResolvedValue({ email: 'old@example.com' });
    mocks.notification.mockResolvedValue({ delivery: 'delivered' });
    mocks.resume.mockResolvedValue({ state: 'completed' });
    mocks.repositoryCreate.mockResolvedValue({ state: 'directory_pending' });
    mocks.createBlindIndexes.mockResolvedValue([
      {
        indexKind: 'email_exact',
        normalizationVersion: 1,
        hmacKeyGeneration: 1,
        virtualBucket: 1,
        digest: 'a'.repeat(64),
      },
    ]);
  });

  it('requires recent reauthentication before persisting a challenge', async () => {
    mocks.requireAccountSession.mockResolvedValue({
      ...currentSession(),
      authTime: Math.floor(Date.now() / 1000) - 301,
    });

    const response = await startAccountIdentifierReplacementHandler(
      context({ body: { email: 'new@example.com' } }) as never
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'reauthentication_required',
      reauth_required: true,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('marks the PII challenge failed when notification dispatch throws', async () => {
    mocks.notification.mockRejectedValue(new Error('provider secret leaked in error'));

    const response = await startAccountIdentifierReplacementHandler(
      context({ body: { email: 'new@example.com' } }) as never
    );

    expect(response.status).toBe(503);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.execute.mock.calls[1]?.[0]).toContain('SET delivery_state = ?');
    expect(mocks.execute.mock.calls[1]?.[1]?.[0]).toBe('failed');
  });

  it('recovers operation creation from a correctly consumed challenge without consuming twice', async () => {
    const challengeId = 'identifier-replacement-00000000-0000-4000-8000-000000000000';
    const code = '123456';
    const now = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('test-identifier-replacement-secret-32-bytes'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${challengeId}\0${code}`)
    );
    const verifier = Array.from(new Uint8Array(signature), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
    mocks.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      tenant_id: 'tenant-a',
      account_id: 'account-a',
      normalized_value_json: JSON.stringify('new@example.com'),
      value_sha256: 'b'.repeat(64),
      otp_verifier: verifier,
      delivery_state: 'sent',
      attempt_count: 5,
      attempt_limit: 5,
      expires_at: now - 20,
      consumed_at: now - 30,
      initiating_session_ref: 'session-current',
      recent_reauth_verified_at: now - 60,
    });

    const response = await completeAccountIdentifierReplacementHandler(
      context({
        body: { challenge_id: challengeId, code },
        idempotencyKey: 'recovery-key-00000000',
      }) as never
    );

    expect(response.status).toBe(200);
    expect(mocks.repositoryCreate).toHaveBeenCalledTimes(1);
    expect(
      mocks.execute.mock.calls.some(([sql]) =>
        String(sql).includes('UPDATE identity_identifier_replacement_challenges')
      )
    ).toBe(false);
  });

  it('fails closed before resuming an operation owned by another account', async () => {
    mocks.queryOne.mockResolvedValueOnce(null);
    const response = await getAccountIdentifierReplacementHandler(
      context({ id: 'identifier-replacement:00000000-0000-4000-8000-000000000000' }) as never
    );

    expect(response.status).toBe(404);
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it('resumes a scoped operation and exposes only a fixed repair code', async () => {
    mocks.queryOne
      .mockResolvedValueOnce({
        operation_id: 'identifier-replacement:operation',
        state: 'directory_pending',
        next_attempt_at: null,
        outbox_status: 'pending',
        lease_expires_at: null,
      })
      .mockResolvedValueOnce({
        operation_id: 'identifier-replacement:00000000-0000-4000-8000-000000000000',
        state: 'blocked_forward_repair',
        error_code: 'raw-provider-error',
        created_at: 1,
        updated_at: 2,
        completed_at: null,
      });
    mocks.resume.mockRejectedValue(new Error('raw-provider-error'));

    const response = await getAccountIdentifierReplacementHandler(
      context({ id: 'identifier-replacement:00000000-0000-4000-8000-000000000000' }) as never
    );
    const body = (await response.json()) as { operation: { error_code: string } };

    expect(response.status).toBe(200);
    expect(body.operation.error_code).toBe('identifier_replacement_forward_repair');
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ errorCode: 'identifier_replacement_resume_failed' })
    );
  });

  it('does not rerun a failed coordinator before its retry deadline', async () => {
    mocks.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    mocks.queryOne
      .mockResolvedValueOnce({
        operation_id: 'identifier-replacement:operation',
        state: 'directory_pending',
        next_attempt_at: Math.floor(Date.now() / 1000) + 30,
        outbox_status: 'retry',
        lease_expires_at: null,
      })
      .mockResolvedValueOnce({
        operation_id: 'identifier-replacement:00000000-0000-4000-8000-000000000000',
        state: 'directory_pending',
        error_code: 'identifier_replacement_retryable',
        created_at: 1,
        updated_at: 2,
        completed_at: null,
      });

    const response = await getAccountIdentifierReplacementHandler(
      context({ id: 'identifier-replacement:00000000-0000-4000-8000-000000000000' }) as never
    );

    expect(response.status).toBe(200);
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it('cancels a pre-switch operation on a permanent reservation conflict', async () => {
    mocks.queryOne
      .mockResolvedValueOnce({
        operation_id: 'identifier-replacement:operation',
        state: 'directory_pending',
      })
      .mockResolvedValueOnce({ state: 'directory_pending' })
      .mockResolvedValueOnce({
        operation_id: 'identifier-replacement:00000000-0000-4000-8000-000000000000',
        state: 'canceled',
        error_code: 'identifier_replacement_permanent_failure',
        created_at: 1,
        updated_at: 2,
        completed_at: null,
      });
    mocks.resume.mockRejectedValue(new Error('identifier_replacement_reservation_conflict'));

    const response = await getAccountIdentifierReplacementHandler(
      context({ id: 'identifier-replacement:00000000-0000-4000-8000-000000000000' }) as never
    );

    expect(response.status).toBe(200);
    expect(mocks.batch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ params: expect.arrayContaining(['canceled']) }),
      ])
    );
  });
});
