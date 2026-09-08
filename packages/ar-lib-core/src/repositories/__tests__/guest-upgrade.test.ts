import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { GuestUpgradeRepository } from '../guest-upgrade';

describe.each(['d1', 'postgresql'])('guest upgrade operations (%s schema)', (dialect) => {
  let db: DatabaseSync;
  let operations: GuestUpgradeRepository;
  let otherTenant: GuestUpgradeRepository;
  const token = 'a'.repeat(64);
  const input = {
    operationId: 'op-1',
    userId: 'user-1',
    clientId: 'client-1',
    sessionId: 'session-1',
    requestTokenHash: token,
    method: 'email' as const,
    payloadJson: JSON.stringify({ email: 'test@example.org' }),
    verifier: 'hmac-code',
    now: 100,
    expiresAt: 700,
  };
  const proof = {
    operationId: 'op-1',
    userId: 'user-1',
    sessionId: 'session-1',
    requestTokenHash: token,
    verifier: 'hmac-code',
    now: 101,
  };
  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    db.exec(
      readFileSync(
        new URL(
          `../../../../../migrations/pii/${dialect}/002_guest_upgrade_operations.sql`,
          import.meta.url
        ),
        'utf8'
      )
    );
    const adapter = {
      async execute(sql: string, values: unknown[] = []) {
        return {
          success: true,
          rowsAffected: Number(db.prepare(sql).run(...(values as SQLInputValue[])).changes),
        };
      },
      async queryOne<T>(sql: string, values: unknown[] = []) {
        return (db.prepare(sql).get(...(values as SQLInputValue[])) ?? null) as T | null;
      },
    } as DatabaseAdapter;
    operations = new GuestUpgradeRepository(adapter, 'tenant-1');
    otherTenant = new GuestUpgradeRepository(adapter, 'tenant-2');
    await operations.create(input);
  });
  afterEach(() => db.close());
  it('binds proof to account, session, tenant, and request token', async () => {
    expect(await operations.verifyEmail({ ...proof, userId: 'different' })).toBe(false);
    expect(await operations.verifyEmail({ ...proof, sessionId: 'different' })).toBe(false);
    expect(await operations.verifyEmail({ ...proof, requestTokenHash: 'b'.repeat(64) })).toBe(
      false
    );
    expect(await otherTenant.verifyEmail(proof)).toBe(false);
    expect((await operations.get('op-1'))?.attempt_count).toBe(0);
    expect(await operations.verifyEmail(proof)).toBe(true);
    expect(await operations.verifyEmail(proof)).toBe(false);
  });
  it('limits attempts and erases abandoned sensitive proof', async () => {
    for (let attempt = 0; attempt < 5; attempt++)
      expect(await operations.verifyEmail({ ...proof, verifier: 'wrong' })).toBe(false);
    expect(await operations.verifyEmail(proof)).toBe(false);
    expect(await operations.get('op-1')).toMatchObject({ state: 'canceled', attempt_count: 5 });
    expect(await operations.cancelUncommitted('op-1', 110)).toBe(true);
    expect(await operations.get('op-1')).toMatchObject({
      proof_payload_json: null,
      challenge_verifier: null,
    });
  });
  it('rejects proof at the exact expiration boundary', async () => {
    expect(await operations.verifyEmail({ ...proof, now: 700 })).toBe(false);
    expect(await operations.leaseCommit('op-1', 'worker-1', 700)).toBe(false);
  });
  it('serializes commit leases and allows recovery without renewing the proof TTL', async () => {
    await operations.verifyEmail(proof);
    expect(await operations.leaseCommit('op-1', 'worker-1', 102)).toBe(true);
    expect(await operations.leaseCommit('op-1', 'worker-2', 161)).toBe(false);
    expect(await operations.leaseCommit('op-1', 'worker-2', 162)).toBe(true);
    expect(await operations.complete('op-1', 'worker-1', 163)).toBe(false);
    expect(await operations.cancelUncommitted('op-1', 163)).toBe(false);
    expect(await otherTenant.complete('op-1', 'worker-2', 163)).toBe(false);
    expect(await operations.complete('op-1', 'worker-2', 164)).toBe(true);
    expect(await operations.get('op-1')).toMatchObject({
      state: 'completed',
      proof_payload_json: null,
      challenge_verifier: null,
      expires_at: 700,
    });
    expect(await operations.leaseCommit('op-1', 'worker-3', 1000)).toBe(false);
  });
  it('does not cancel a verified proof that may already be committed in core', async () => {
    await operations.verifyEmail(proof);
    expect(await operations.cancelUncommitted('op-1', 110)).toBe(false);
  });
  it('binds verified passkey material to its original challenge', async () => {
    await operations.create({
      ...input,
      operationId: 'passkey-1',
      method: 'passkey',
      verifier: 'webauthn-challenge',
    });
    const passkeyProof = {
      ...proof,
      operationId: 'passkey-1',
      challenge: 'wrong',
      verifiedPayloadJson: '{"credentialId":"key-1"}',
    };
    expect(await operations.verifyPasskey(passkeyProof)).toBe(false);
    expect(await operations.verifyEmail({ ...proof, operationId: 'passkey-1' })).toBe(false);
    expect(
      await operations.verifyPasskey({ ...passkeyProof, challenge: 'webauthn-challenge' })
    ).toBe(true);
    expect(
      await operations.verifyPasskey({ ...passkeyProof, challenge: 'webauthn-challenge' })
    ).toBe(false);
  });
});
