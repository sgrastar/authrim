/**
 * Characterization of the proof-nonce state machine of CredentialOfferStore
 * (AWS portability design, step P1).
 *
 *   issued -> processing -> consumed        (release / lease takeover: back to issued)
 *   issued | processing past expiry -> expired (by the alarm only)
 *
 * Pins today's behaviour on the `node:sqlite` harness, including the points where a second backend has
 * to be deliberately identical (what `reserve`, `complete`, `release` and the alarm each do about
 * expiry, and how the proof fingerprint is kept and released). The clock is fixed: `release` and the
 * alarm read `Date.now()`, `reserve` reads the time it is given. Must pass on unchanged code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialOfferStore } from '../CredentialOfferStore';
import { createSqliteState } from './sqlite-storage';

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe('CredentialOfferStore proof nonce characterization', () => {
  let store: CredentialOfferStore;
  let sql: SqlStorage;
  const now = NOW;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createSqliteState();
    store = new CredentialOfferStore(harness.state, {} as never);
    sql = harness.state.storage.sql;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function nonce(id: string, expiresIn = 300_000, tenantId = TENANT): void {
    store.createProofNonceRpc({
      id,
      tenantId,
      nonceHash: `hash-${id}`,
      createdAt: now - 1_000,
      expiresAt: now + expiresIn,
    });
  }

  function reserve(
    id: string,
    fingerprint: string,
    at = now,
    extra: { tenantId?: string; nonceHash?: string; leaseMs?: number; jti?: string } = {}
  ) {
    return store.reserveProofNonceRpc({
      id,
      tenantId: extra.tenantId ?? TENANT,
      nonceHash: extra.nonceHash ?? `hash-${id}`,
      proofFingerprint: fingerprint,
      accessTokenJti: extra.jti ?? `jti-${fingerprint}`,
      now: at,
      ...(extra.leaseMs === undefined ? {} : { leaseMs: extra.leaseMs }),
    });
  }

  function mustReserve(id: string, fingerprint: string, at = now, leaseMs?: number): string {
    const result = reserve(id, fingerprint, at, leaseMs === undefined ? {} : { leaseMs });
    if (!result.reserved) throw new Error(`reserve failed: ${result.reason}`);
    return result.reservationId;
  }

  const complete = (id: string, reservationId: string, tenantId = TENANT) =>
    store.completeProofNonceRpc({ id, tenantId, reservationId });
  const release = (id: string, reservationId: string, tenantId = TENANT) =>
    store.releaseProofNonceRpc({ id, tenantId, reservationId });

  function row(id: string) {
    return sql
      .exec<{
        status: string;
        proof_fingerprint: string | null;
        reservation_id: string | null;
        lease_expires_at: number | null;
        expires_at: number;
      }>(
        `SELECT status, proof_fingerprint, reservation_id, lease_expires_at, expires_at
           FROM proof_nonces WHERE id = ?`,
        id
      )
      .toArray()[0];
  }

  describe('reserve', () => {
    it('lets exactly one of two reservations of the same nonce win', () => {
      nonce('n1');
      const first = reserve('n1', 'fp-1');
      const second = reserve('n1', 'fp-2');
      expect([first.reserved, second.reserved]).toEqual([true, false]);
      expect(second).toEqual({ reserved: false, reason: 'unavailable' });
    });

    it('distinguishes not_found, invalid_nonce and unavailable', () => {
      nonce('n1');
      expect(reserve('missing', 'fp-1')).toEqual({ reserved: false, reason: 'not_found' });
      expect(reserve('n1', 'fp-1', now, { tenantId: OTHER_TENANT })).toEqual({
        reserved: false,
        reason: 'not_found',
      });
      expect(reserve('n1', 'fp-1', now, { nonceHash: 'wrong' })).toEqual({
        reserved: false,
        reason: 'invalid_nonce',
      });
    });

    it('refuses by the time it is given, without writing expired', () => {
      nonce('n1', 10_000);
      // Exactly at the expiry the nonce is no longer usable.
      expect(reserve('n1', 'fp-1', now + 10_000)).toEqual({
        reserved: false,
        reason: 'unavailable',
      });
      expect(row('n1').status).toBe('issued');
      // A request that carries an earlier time still reserves: only the alarm persists expiry.
      expect(reserve('n1', 'fp-1', now + 9_999).reserved).toBe(true);
    });

    it('cuts the lease at the nonce expiry and clamps a requested lease to 5 s .. 120 s', () => {
      nonce('short', 10_000);
      mustReserve('short', 'fp-s', now);
      expect(row('short').lease_expires_at).toBe(now + 10_000);

      nonce('tiny');
      mustReserve('tiny', 'fp-t', now, 1);
      expect(row('tiny').lease_expires_at).toBe(now + 5_000);

      nonce('huge');
      mustReserve('huge', 'fp-h', now, 10 * 60_000);
      expect(row('huge').lease_expires_at).toBe(now + 120_000);
    });

    it('never reserves a consumed nonce again', () => {
      nonce('n1');
      expect(complete('n1', mustReserve('n1', 'fp-1'))).toBe(true);
      expect(reserve('n1', 'fp-2', now + 1_000)).toEqual({
        reserved: false,
        reason: 'unavailable',
      });
    });
  });

  describe('storage failure during reserve', () => {
    it('is reported as replayed_proof, indistinguishable from a real replay (today)', () => {
      nonce('n1');
      // Everything up to the reserving UPDATE works; the UPDATE itself throws.
      const realExec = sql.exec.bind(sql);
      const failing = vi.spyOn(sql, 'exec').mockImplementation(((
        query: string,
        ...bindings: unknown[]
      ) => {
        if (/UPDATE proof_nonces SET status = 'processing'/.test(query)) {
          throw new Error('storage failure');
        }
        return realExec(query, ...bindings);
      }) as typeof sql.exec);
      expect(reserve('n1', 'fp-1')).toEqual({ reserved: false, reason: 'replayed_proof' });
      failing.mockRestore();
      // Nothing was written: the nonce can still be reserved.
      expect(reserve('n1', 'fp-1').reserved).toBe(true);
    });
  });

  describe('proof fingerprint', () => {
    it('is unique across OTHER nonce rows', () => {
      nonce('n1');
      nonce('n2');
      mustReserve('n1', 'fp-shared');
      expect(reserve('n2', 'fp-shared')).toEqual({ reserved: false, reason: 'replayed_proof' });
    });

    it('is cleared on release, so the same proof can be reserved on another nonce', () => {
      nonce('n1');
      nonce('n2');
      const reservation = mustReserve('n1', 'fp-shared');
      expect(release('n1', reservation)).toBe(true);
      expect(row('n1').proof_fingerprint).toBeNull();
      // Another nonce takes the released proof: this fails if release kept it.
      expect(reserve('n2', 'fp-shared').reserved).toBe(true);
    });

    it('is kept by a consumed nonce', () => {
      nonce('n1');
      nonce('n2');
      const reservation = mustReserve('n1', 'fp-shared');
      expect(complete('n1', reservation)).toBe(true);
      expect(row('n1').status).toBe('consumed');
      expect(reserve('n2', 'fp-shared')).toEqual({ reserved: false, reason: 'replayed_proof' });
    });
  });

  describe('lease', () => {
    it('releases an expired lease BEFORE it examines the input, so the old owner can no longer complete', () => {
      nonce('n1');
      const first = mustReserve('n1', 'fp-1', now, 5_000);
      // Lease over; the new request has a wrong nonce hash and is refused ...
      expect(reserve('n1', 'fp-2', now + 5_000, { nonceHash: 'wrong' })).toEqual({
        reserved: false,
        reason: 'invalid_nonce',
      });
      // ... but the old reservation and its fingerprint are already gone.
      expect(row('n1')).toMatchObject({
        status: 'issued',
        proof_fingerprint: null,
        reservation_id: null,
      });
      expect(complete('n1', first)).toBe(false);
    });

    it('does not invalidate a reservation merely because its lease ran out: complete does not read the lease', () => {
      nonce('n1');
      const first = mustReserve('n1', 'fp-1', now, 5_000);
      // The lease end is in the past (the clock has moved on) and nobody reserved or swept.
      vi.setSystemTime(now + 60_000);
      expect(row('n1').lease_expires_at).toBeLessThan(Date.now());
      expect(complete('n1', first)).toBe(true);
    });

    it('takes over with a new reservation id; the same fingerprint may be reused by the taker', () => {
      nonce('n1');
      const first = mustReserve('n1', 'fp-1', now, 5_000);
      const second = mustReserve('n1', 'fp-1', now + 5_000);
      expect(second).not.toBe(first);
      expect(row('n1').proof_fingerprint).toBe('fp-1');
      expect(complete('n1', first)).toBe(false);
      expect(complete('n1', second)).toBe(true);
    });

    it('takes over with a DIFFERENT fingerprint, and another nonce may then use the old one', () => {
      nonce('n1');
      nonce('n2');
      const first = mustReserve('n1', 'fp-old', now, 5_000);
      const second = mustReserve('n1', 'fp-new', now + 5_000);
      expect(row('n1').proof_fingerprint).toBe('fp-new');
      expect(complete('n1', first)).toBe(false);
      expect(reserve('n2', 'fp-old', now + 5_001).reserved).toBe(true);
      expect(reserve('n2', 'fp-new', now + 5_001)).toEqual({
        reserved: false,
        reason: 'unavailable',
      });
      expect(complete('n1', second)).toBe(true);
    });
  });

  describe('complete and release', () => {
    it('complete needs the owner and the processing state only: it does not look at expiry', () => {
      nonce('n1', 10_000);
      const reservation = mustReserve('n1', 'fp-1');
      expect(complete('n1', reservation, OTHER_TENANT)).toBe(false);
      expect(complete('n1', 'other')).toBe(false);
      // The nonce is in the past by now (the alarm has not run): still completes.
      vi.setSystemTime(now + 20_000);
      expect(row('n1').expires_at).toBeLessThan(Date.now());
      expect(complete('n1', reservation)).toBe(true);
    });

    it('release needs the owner and works up to 1 ms before the nonce expiry, not at the expiry', () => {
      nonce('before', 10_000);
      nonce('at', 10_000);
      const reservationBefore = mustReserve('before', 'fp-b');
      const reservationAt = mustReserve('at', 'fp-a');
      expect(release('before', 'other')).toBe(false);
      vi.setSystemTime(now + 9_999);
      expect(release('before', reservationBefore)).toBe(true);
      vi.setSystemTime(now + 10_000);
      expect(release('at', reservationAt)).toBe(false);
    });
  });

  describe('alarm', () => {
    async function runAlarmAt(at: number): Promise<void> {
      vi.setSystemTime(at);
      await store.alarm();
    }

    it('marks an expired processing nonce expired and drops its reservation, so the old owner cannot complete', async () => {
      nonce('n1', 10_000);
      const reservation = mustReserve('n1', 'fp-1');
      await runAlarmAt(now + 10_000);
      expect(row('n1')).toMatchObject({ status: 'expired', reservation_id: null });
      expect(complete('n1', reservation)).toBe(false);
    });

    it('keeps the fingerprint of an expired nonce that carried a proof exactly until retention (strict <)', async () => {
      nonce('n1', 10_000);
      nonce('n2', 3 * DAY);
      mustReserve('n1', 'fp-shared');
      const retentionEnd = now + 10_000 + DAY;

      await runAlarmAt(now + 10_000);
      expect(row('n1')).toMatchObject({ status: 'expired', proof_fingerprint: 'fp-shared' });
      expect(reserve('n2', 'fp-shared', now + 10_000)).toEqual({
        reserved: false,
        reason: 'replayed_proof',
      });

      // At exactly expires_at + retention the row is still there ...
      await runAlarmAt(retentionEnd);
      expect(row('n1')).toBeDefined();
      expect(reserve('n2', 'fp-shared', retentionEnd)).toEqual({
        reserved: false,
        reason: 'replayed_proof',
      });
      // ... and 1 ms later it is gone, so another nonce may use the fingerprint.
      await runAlarmAt(retentionEnd + 1);
      expect(row('n1')).toBeUndefined();
      expect(reserve('n2', 'fp-shared', retentionEnd + 1).reserved).toBe(true);
    });

    it('deletes an expired nonce without a fingerprint at once, so it becomes not_found', async () => {
      nonce('unused', 10_000);
      nonce('released', 10_000);
      const reservation = mustReserve('released', 'fp-r');
      expect(release('released', reservation)).toBe(true);
      await runAlarmAt(now + 10_000);
      expect(row('unused')).toBeUndefined();
      expect(row('released')).toBeUndefined();
      expect(reserve('unused', 'fp-x', now + 10_000)).toEqual({
        reserved: false,
        reason: 'not_found',
      });
    });

    it('decides what happens to the fingerprint of an expired lease by which of reserve and alarm comes first', async () => {
      // Two independent, identical cases: same expiry, same lease, correct hash.
      for (const id of ['first-reserve', 'first-alarm']) {
        nonce(id, 10_000);
        mustReserve(id, `fp-${id}`, now, 5_000);
      }
      nonce('taker-a', 3 * DAY);
      nonce('taker-b', 3 * DAY);

      // (1) reserve first, after lease end and after the nonce expiry: refused as unavailable ...
      expect(reserve('first-reserve', 'fp-other', now + 10_000)).toEqual({
        reserved: false,
        reason: 'unavailable',
      });
      // ... but the fingerprint was cleared before the refusal.
      expect(row('first-reserve')).toMatchObject({ status: 'issued', proof_fingerprint: null });
      expect(reserve('taker-a', 'fp-first-reserve', now + 10_000).reserved).toBe(true);

      // (2) alarm first: the nonce expires with its fingerprint intact.
      await runAlarmAt(now + 10_000);
      expect(row('first-alarm')).toMatchObject({
        status: 'expired',
        proof_fingerprint: 'fp-first-alarm',
      });
      expect(reserve('taker-b', 'fp-first-alarm', now + 10_000)).toEqual({
        reserved: false,
        reason: 'replayed_proof',
      });
    });
  });

  describe('more boundaries', () => {
    it('after a release the SAME nonce can be reserved again with the same proof, and completed under the new reservation', () => {
      nonce('n1');
      const first = mustReserve('n1', 'fp-1');
      expect(release('n1', first)).toBe(true);
      const second = mustReserve('n1', 'fp-1', now + 1_000);
      expect(second).not.toBe(first);
      expect(complete('n1', first)).toBe(false);
      expect(complete('n1', second)).toBe(true);
    });

    it('keeps the new fingerprint of a takeover unique against a nonce that has not reserved anything yet', () => {
      nonce('n1');
      nonce('n3');
      mustReserve('n1', 'fp-old', now, 5_000);
      mustReserve('n1', 'fp-new', now + 5_000);
      expect(reserve('n3', 'fp-new', now + 5_001)).toEqual({
        reserved: false,
        reason: 'replayed_proof',
      });
    });

    it('uses a 30 s lease when none is requested (a long-lived nonce): no takeover at 29_999 ms, takeover at 30_000 ms', () => {
      nonce('n1', 10 * 60_000);
      mustReserve('n1', 'fp-1', now);
      expect(row('n1').lease_expires_at).toBe(now + 30_000);
      expect(reserve('n1', 'fp-2', now + 29_999)).toEqual({
        reserved: false,
        reason: 'unavailable',
      });
      expect(reserve('n1', 'fp-2', now + 30_000).reserved).toBe(true);
    });

    it('a refused release at the exact expiry changes nothing: the owner can still complete', () => {
      nonce('n1', 10_000);
      const reservation = mustReserve('n1', 'fp-1');
      vi.setSystemTime(now + 10_000);
      expect(release('n1', reservation)).toBe(false);
      expect(row('n1').status).toBe('processing');
      expect(complete('n1', reservation)).toBe(true);
    });

    it('release and complete are keyed by tenant as well as by the reservation id', () => {
      nonce('n1');
      const reservation = mustReserve('n1', 'fp-1');
      expect(release('n1', reservation, OTHER_TENANT)).toBe(false);
      expect(complete('n1', reservation, OTHER_TENANT)).toBe(false);
      expect(row('n1').status).toBe('processing');
      expect(complete('n1', reservation)).toBe(true);
    });

    it('releases a fingerprint after retention only when an alarm runs (time alone does not free it)', async () => {
      nonce('n1', 10_000);
      nonce('n2', 3 * DAY);
      mustReserve('n1', 'fp-shared');
      const retentionEnd = now + 10_000 + DAY;
      vi.setSystemTime(now + 10_000);
      await store.alarm();
      // Past the retention, before any further alarm: still held.
      expect(reserve('n2', 'fp-shared', retentionEnd + 1)).toEqual({
        reserved: false,
        reason: 'replayed_proof',
      });
      vi.setSystemTime(retentionEnd + 1);
      await store.alarm();
      expect(reserve('n2', 'fp-shared', retentionEnd + 1).reserved).toBe(true);
    });
  });

  describe('what decides a duplicate, and what the release/alarm conditions look at', () => {
    it('only the proof fingerprint decides a duplicate: same proof with another token jti is refused, another proof with the same jti is accepted', () => {
      nonce('n1');
      nonce('n2');
      nonce('n3');
      expect(reserve('n1', 'fp-1', now, { jti: 'jti-A' }).reserved).toBe(true);
      expect(reserve('n2', 'fp-1', now, { jti: 'jti-B' })).toEqual({
        reserved: false,
        reason: 'replayed_proof',
      });
      expect(reserve('n3', 'fp-3', now, { jti: 'jti-A' }).reserved).toBe(true);
    });

    it('release does not look at the lease: the owner can release after the lease ran out while the nonce is alive', () => {
      nonce('n1', 60_000);
      const reservation = mustReserve('n1', 'fp-1', now, 5_000);
      vi.setSystemTime(now + 5_000);
      expect(release('n1', reservation)).toBe(true);
      expect(reserve('n1', 'fp-1', now + 5_001).reserved).toBe(true);
    });

    it('time alone does not free a fingerprint after retention: it needs an alarm (the clock is already past retention at the first query)', async () => {
      nonce('n1', 10_000);
      nonce('n2', 3 * DAY);
      mustReserve('n1', 'fp-shared');
      vi.setSystemTime(now + 10_000);
      await store.alarm();
      const afterRetention = now + 10_000 + DAY + 1;
      vi.setSystemTime(afterRetention);
      expect(reserve('n2', 'fp-shared', afterRetention)).toEqual({
        reserved: false,
        reason: 'replayed_proof',
      });
      await store.alarm();
      expect(reserve('n2', 'fp-shared', afterRetention).reserved).toBe(true);
    });
  });

  describe('an expired lease is released only for the nonce that is reserved', () => {
    it('another nonce still cannot use the fingerprint of an untouched expired lease, and its owner can still complete', () => {
      nonce('n1');
      nonce('n2');
      const reservation = mustReserve('n1', 'fp-1', now, 5_000);
      // Exactly at the lease end nobody has reserved n1 again: the fingerprint is still held.
      expect(reserve('n2', 'fp-1', now + 5_000)).toEqual({
        reserved: false,
        reason: 'replayed_proof',
      });
      expect(complete('n1', reservation)).toBe(true);
    });
  });
});
