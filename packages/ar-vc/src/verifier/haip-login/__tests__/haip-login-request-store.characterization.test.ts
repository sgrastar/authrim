/**
 * Characterization of HaipLoginRequestTable (AWS portability design, step P1).
 *
 * These tests pin the behaviour of the Cloudflare implementation as it is today, at the boundary values
 * the shared contract of a second backend has to reproduce. They run on the `node:sqlite` harness used
 * by the other store tests, not on a Workers `SqlStorage`. They must pass on unchanged code.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createSqliteState } from '../../../issuer/durable-objects/__tests__/sqlite-storage';
import {
  HAIP_LOGIN_CONSUME_WINDOW_MS,
  HaipLoginRequestTable,
  type HaipLoginRequestInput,
} from '../haip-login-request-store';

const T0 = 1_800_000_000_000;
const LEASE_MS = 30_000;
const BINDING = 'B'.repeat(43);
const OTHER_BINDING = 'C'.repeat(43);
const CODE_HASH = 'D'.repeat(43);
const RESULT = { adminUserId: 'admin-1', holderJkt: 'J'.repeat(43), credentialId: 'cred-1' };

function input(overrides: Partial<HaipLoginRequestInput> = {}): HaipLoginRequestInput {
  return {
    id: 'req-1',
    tenantId: 'tenant-1',
    flow: 'cross_device',
    bindingHash: BINDING,
    clientId: 'x509_hash:abc',
    credentialIssuer: 'https://idp.example.com',
    nonce: 'nonce-1',
    state: 'state-1',
    encryptionJwk: '{"kty":"EC"}',
    requestObject: 'header.payload.signature',
    createdAt: T0,
    expiresAt: T0 + 300_000,
    ...overrides,
  };
}

describe('HaipLoginRequestTable characterization', () => {
  let table: HaipLoginRequestTable;
  let sql: SqlStorage;

  beforeEach(() => {
    const { state } = createSqliteState();
    sql = state.storage.sql;
    table = new HaipLoginRequestTable(sql);
    table.initialize();
  });

  function reserve(fingerprint = 'fp-1', now = T0 + 1_000, id = 'req-1') {
    const result = table.reserve(id, 'tenant-1', fingerprint, now);
    if (!result.reserved) throw new Error(`not reserved: ${result.reason}`);
    return result;
  }

  function reasonOf(result: ReturnType<HaipLoginRequestTable['reserve']>): string {
    if (result.reserved) throw new Error('unexpectedly reserved');
    return result.reason;
  }

  function storedStatus(id = 'req-1'): string {
    return sql
      .exec<{ status: string }>('SELECT status FROM haip_login_requests WHERE id = ?', id)
      .one().status;
  }

  function leaseEnd(id = 'req-1'): number | null {
    return sql
      .exec<{
        lease_expires_at: number | null;
      }>('SELECT lease_expires_at FROM haip_login_requests WHERE id = ?', id)
      .one().lease_expires_at;
  }

  describe('consume window', () => {
    function verifiedAt(at: number): void {
      table.create(input());
      const { reservationId } = reserve('fp-1', at - 500);
      expect(table.complete('req-1', 'tenant-1', reservationId, RESULT, at)).toBe(true);
    }

    it('hands the result over up to 119_999 ms after verification and refuses at exactly 120_000 ms', () => {
      // The contract value is written here, not derived from the implementation's constant.
      expect(HAIP_LOGIN_CONSUME_WINDOW_MS).toBe(120_000);
      verifiedAt(T0 + 2_000);
      expect(
        table.consume('req-1', 'tenant-1', BINDING, undefined, T0 + 2_000 + 120_000)
      ).toBeNull();
      // The refusal at the boundary did not burn the result.
      expect(
        table.consume('req-1', 'tenant-1', BINDING, undefined, T0 + 2_000 + 119_999)
      ).toMatchObject({
        adminUserId: 'admin-1',
      });
    });

    it('does not depend on the request expiry once the result is verified', () => {
      table.create(input({ expiresAt: T0 + 10_000 }));
      const { reservationId } = reserve('fp-1', T0 + 1_000);
      expect(table.complete('req-1', 'tenant-1', reservationId, RESULT, T0 + 9_000)).toBe(true);
      // Past the request's own expiry, inside the consume window.
      expect(table.consume('req-1', 'tenant-1', BINDING, undefined, T0 + 60_000)).toMatchObject({
        credentialId: 'cred-1',
      });
    });

    it('does not burn the result on a wrong binding or a wrong tenant', () => {
      verifiedAt(T0 + 2_000);
      expect(table.consume('req-1', 'tenant-1', OTHER_BINDING, undefined, T0 + 3_000)).toBeNull();
      expect(table.consume('req-1', 'tenant-2', BINDING, undefined, T0 + 3_000)).toBeNull();
      expect(table.consume('req-1', 'tenant-1', BINDING, undefined, T0 + 3_000)).not.toBeNull();
    });

    it('decides whether a response code is needed from the STORED flow', () => {
      table.create(
        input({ flow: 'same_device', redirectUri: 'https://idp.example.com/login/wallet' })
      );
      const { reservationId } = reserve();
      table.complete(
        'req-1',
        'tenant-1',
        reservationId,
        { ...RESULT, responseCodeHash: CODE_HASH },
        T0 + 2_000
      );
      // A caller that omits the code is refused whatever it believes the flow to be.
      expect(table.consume('req-1', 'tenant-1', BINDING, undefined, T0 + 3_000)).toBeNull();
      expect(table.consume('req-1', 'tenant-1', BINDING, CODE_HASH, T0 + 3_000)).not.toBeNull();
    });

    it('a cross-device request that stored a response code still does not need it (the flow decides, not the stored code)', () => {
      table.create(input());
      const { reservationId } = reserve();
      expect(
        table.complete(
          'req-1',
          'tenant-1',
          reservationId,
          { ...RESULT, responseCodeHash: CODE_HASH },
          T0 + 2_000
        )
      ).toBe(true);
      expect(
        table.consume('req-1', 'tenant-1', BINDING, 'E'.repeat(43), T0 + 3_000)
      ).not.toBeNull();
    });

    it('ignores a response code for a cross-device request', () => {
      verifiedAt(T0 + 2_000);
      expect(
        table.consume('req-1', 'tenant-1', BINDING, 'E'.repeat(43), T0 + 3_000)
      ).not.toBeNull();
    });
  });

  describe('lease', () => {
    it('cuts the lease at the request expiry', () => {
      table.create(input({ expiresAt: T0 + 10_000 }));
      reserve('fp-1', T0 + 1_000);
      expect(leaseEnd()).toBe(T0 + 10_000);
    });

    it('sets the lease to now + 30 s when the request lives longer', () => {
      table.create(input());
      reserve('fp-1', T0 + 1_000);
      expect(leaseEnd()).toBe(T0 + 1_000 + LEASE_MS);
    });

    it('lets another answer take over exactly when the lease has run out, and the old owner can no longer finish', () => {
      table.create(input());
      const first = reserve('fp-1', T0 + 1_000);
      // One millisecond before the lease end the request is still held.
      expect(table.reserve('req-1', 'tenant-1', 'fp-2', T0 + 1_000 + LEASE_MS - 1)).toEqual({
        reserved: false,
        reason: 'unavailable',
      });
      const second = reserve('fp-2', T0 + 1_000 + LEASE_MS);
      expect(second.reservationId).not.toBe(first.reservationId);
      expect(table.complete('req-1', 'tenant-1', first.reservationId, RESULT, T0 + 40_000)).toBe(
        false
      );
      expect(table.fail('req-1', 'tenant-1', first.reservationId, 'late')).toBe(false);
      expect(table.release('req-1', 'tenant-1', first.reservationId, T0 + 40_000)).toBe(false);
      expect(table.complete('req-1', 'tenant-1', second.reservationId, RESULT, T0 + 40_000)).toBe(
        true
      );
    });

    it('does not invalidate a reservation merely because its lease ran out', () => {
      table.create(input());
      const first = reserve('fp-1', T0 + 1_000);
      // Nobody took over: the owner can still complete after the lease end.
      expect(
        table.complete('req-1', 'tenant-1', first.reservationId, RESULT, T0 + 1_000 + 2 * LEASE_MS)
      ).toBe(true);
    });

    it('clears the fingerprint on release: ANOTHER request may then hold it', () => {
      table.create(input());
      table.create(input({ id: 'req-2', nonce: 'nonce-2', state: 'state-2' }));
      const first = reserve('fp-1', T0 + 1_000);
      expect(reasonOf(table.reserve('req-2', 'tenant-1', 'fp-1', T0 + 1_500))).toBe('replayed');
      expect(table.release('req-1', 'tenant-1', first.reservationId, T0 + 2_000)).toBe(true);
      expect(table.reserve('req-2', 'tenant-1', 'fp-1', T0 + 3_000).reserved).toBe(true);
    });

    it('clears the old fingerprint on takeover: another request may use it, the taker holds the new one', () => {
      table.create(input());
      table.create(input({ id: 'req-2', nonce: 'nonce-2', state: 'state-2' }));
      reserve('fp-old', T0 + 1_000);
      reserve('fp-new', T0 + 1_000 + LEASE_MS);
      expect(table.reserve('req-2', 'tenant-1', 'fp-old', T0 + 40_000).reserved).toBe(true);
      table.create(input({ id: 'req-3', nonce: 'nonce-3', state: 'state-3' }));
      expect(reasonOf(table.reserve('req-3', 'tenant-1', 'fp-new', T0 + 40_000))).toBe('replayed');
    });

    it('refuses to release after the request has expired', () => {
      table.create(input({ expiresAt: T0 + 10_000 }));
      const first = reserve('fp-1', T0 + 1_000);
      expect(table.release('req-1', 'tenant-1', first.reservationId, T0 + 10_000)).toBe(false);
    });
  });

  describe('expiry is persisted by the operations that touch the row', () => {
    it('a request-object read past the request expiry marks it expired, so an old reservation can no longer complete', () => {
      table.create(input({ expiresAt: T0 + 10_000 }));
      const first = reserve('fp-1', T0 + 1_000);
      expect(table.requestObject('req-1', 'tenant-1', T0 + 10_000)).toBeNull();
      expect(table.complete('req-1', 'tenant-1', first.reservationId, RESULT, T0 + 10_500)).toBe(
        false
      );
      expect(table.status('req-1', 'tenant-1', BINDING, T0 + 10_500)?.status).toBe('expired');
    });

    it('a status read persists expiry even for a caller whose binding is wrong', () => {
      table.create(input({ expiresAt: T0 + 10_000 }));
      const first = reserve('fp-1', T0 + 1_000);
      expect(table.status('req-1', 'tenant-1', OTHER_BINDING, T0 + 10_000)).toBeNull();
      expect(table.complete('req-1', 'tenant-1', first.reservationId, RESULT, T0 + 10_001)).toBe(
        false
      );
    });

    it('reserve after the request expiry persists expired for a processing row (not only a returned reason)', () => {
      table.create(input({ expiresAt: T0 + 10_000 }));
      const first = reserve('fp-1', T0 + 1_000);
      expect(reasonOf(table.reserve('req-1', 'tenant-1', 'fp-2', T0 + 10_000))).toBe('expired');
      expect(storedStatus()).toBe('expired');
      expect(table.complete('req-1', 'tenant-1', first.reservationId, RESULT, T0 + 10_001)).toBe(
        false
      );
    });

    it('sweep persists expired for a processing row at its expiry, so the old owner cannot complete', () => {
      table.create(input({ expiresAt: T0 + 10_000 }));
      const first = reserve('fp-1', T0 + 1_000);
      table.sweep(T0 + 10_000);
      expect(storedStatus()).toBe('expired');
      expect(table.complete('req-1', 'tenant-1', first.reservationId, RESULT, T0 + 10_001)).toBe(
        false
      );
    });

    it('without any touching operation an overdue reservation can still complete (the window before the alarm)', () => {
      table.create(input({ expiresAt: T0 + 10_000 }));
      const first = reserve('fp-1', T0 + 1_000);
      // `complete` itself does not look at the request expiry.
      expect(table.complete('req-1', 'tenant-1', first.reservationId, RESULT, T0 + 20_000)).toBe(
        true
      );
    });

    it('the status of a row past its retention stays readable until the sweep removes it', () => {
      table.create(input());
      const aDayAndMore = T0 + 300_000 + 25 * 60 * 60 * 1000;
      expect(table.status('req-1', 'tenant-1', BINDING, aDayAndMore)?.status).toBe('expired');
      table.sweep(aDayAndMore);
      expect(table.status('req-1', 'tenant-1', BINDING, aDayAndMore)).toBeNull();
    });
  });

  describe('reserve refusal reasons', () => {
    it('distinguishes not_found, expired, replayed (same request, same response) and unavailable', () => {
      table.create(input());
      table.create(input({ id: 'req-2', nonce: 'nonce-2', state: 'state-2' }));
      expect(table.reserve('nope', 'tenant-1', 'fp', T0)).toEqual({
        reserved: false,
        reason: 'not_found',
      });
      expect(table.reserve('req-1', 'other-tenant', 'fp', T0)).toEqual({
        reserved: false,
        reason: 'not_found',
      });
      reserve('fp-1', T0 + 1_000);
      expect(table.reserve('req-1', 'tenant-1', 'fp-1', T0 + 2_000)).toEqual({
        reserved: false,
        reason: 'replayed',
      });
      expect(table.reserve('req-1', 'tenant-1', 'fp-other', T0 + 2_000)).toEqual({
        reserved: false,
        reason: 'unavailable',
      });
      expect(table.reserve('req-2', 'tenant-1', 'fp-2', T0 + 300_000)).toEqual({
        reserved: false,
        reason: 'expired',
      });
    });

    it('treats a response fingerprint held by ANOTHER request as replayed', () => {
      table.create(input());
      table.create(input({ id: 'req-2', nonce: 'nonce-2', state: 'state-2' }));
      reserve('fp-shared', T0 + 1_000, 'req-1');
      expect(table.reserve('req-2', 'tenant-1', 'fp-shared', T0 + 2_000)).toEqual({
        reserved: false,
        reason: 'replayed',
      });
    });

    it('a verified request is final: it is never reserved again', () => {
      table.create(input());
      const first = reserve('fp-1', T0 + 1_000);
      expect(table.complete('req-1', 'tenant-1', first.reservationId, RESULT, T0 + 2_000)).toBe(
        true
      );
      expect(storedStatus()).toBe('verified');
      expect(table.reserve('req-1', 'tenant-1', 'fp-2', T0 + 3_000).reserved).toBe(false);
    });
  });

  describe('tenant isolation', () => {
    it('keys every read and change by tenant', () => {
      table.create(input());
      expect(table.requestObject('req-1', 'tenant-2', T0)).toBeNull();
      expect(table.status('req-1', 'tenant-2', BINDING, T0)).toBeNull();
      const first = reserve('fp-1', T0 + 1_000);
      expect(table.complete('req-1', 'tenant-2', first.reservationId, RESULT, T0 + 2_000)).toBe(
        false
      );
      expect(table.complete('req-1', 'tenant-1', first.reservationId, RESULT, T0 + 2_000)).toBe(
        true
      );
    });
  });

  describe('more boundaries', () => {
    it('fail and release are keyed by tenant as well as by the reservation id', () => {
      table.create(input());
      const first = reserve('fp-1', T0 + 1_000);
      expect(table.fail('req-1', 'tenant-2', first.reservationId, 'x')).toBe(false);
      expect(table.release('req-1', 'tenant-2', first.reservationId, T0 + 2_000)).toBe(false);
      expect(storedStatus()).toBe('processing');
      expect(table.complete('req-1', 'tenant-1', first.reservationId, RESULT, T0 + 2_000)).toBe(
        true
      );
    });

    it('a refused release at the exact request expiry changes nothing: the owner can still complete', () => {
      table.create(input({ expiresAt: T0 + 10_000 }));
      const first = reserve('fp-1', T0 + 1_000);
      expect(table.release('req-1', 'tenant-1', first.reservationId, T0 + 10_000)).toBe(false);
      expect(storedStatus()).toBe('processing');
      expect(table.complete('req-1', 'tenant-1', first.reservationId, RESULT, T0 + 10_001)).toBe(
        true
      );
    });
  });

  describe('more refusal and retention boundaries', () => {
    it('the order of reserve and sweep at the request expiry decides whether the response fingerprint is freed', () => {
      for (const id of ['req-a', 'req-b']) {
        table.create(input({ id, nonce: `n-${id}`, state: `s-${id}`, expiresAt: T0 + 10_000 }));
        reserve(`fp-${id}`, T0 + 1_000, id);
      }
      table.create(input({ id: 'taker-a', nonce: 'n-ta', state: 's-ta' }));
      table.create(input({ id: 'taker-b', nonce: 'n-tb', state: 's-tb' }));

      // reserve first: at the request expiry the lease (cut at the expiry) has run out, so the lease
      // release clears the fingerprint before the row is expired; another request can then use it.
      expect(reasonOf(table.reserve('req-a', 'tenant-1', 'fp-other', T0 + 10_000))).toBe('expired');
      expect(table.reserve('taker-a', 'tenant-1', 'fp-req-a', T0 + 10_001).reserved).toBe(true);

      // sweep first: the row expires with its fingerprint, which stays held.
      table.sweep(T0 + 10_000);
      expect(reasonOf(table.reserve('taker-b', 'tenant-1', 'fp-req-b', T0 + 10_001))).toBe(
        'replayed'
      );
    });

    it('a verified request answers a new reserve with replayed (same response) or unavailable (another one)', () => {
      table.create(input());
      const first = reserve('fp-1', T0 + 1_000);
      expect(table.complete('req-1', 'tenant-1', first.reservationId, RESULT, T0 + 2_000)).toBe(
        true
      );
      expect(reasonOf(table.reserve('req-1', 'tenant-1', 'fp-1', T0 + 3_000))).toBe('replayed');
      expect(reasonOf(table.reserve('req-1', 'tenant-1', 'fp-2', T0 + 3_000))).toBe('unavailable');
    });

    it('deletes rows only strictly after the retention: still there at expires_at + 24 h, gone 1 ms later', () => {
      table.create(input());
      const retentionEnd = T0 + 300_000 + 24 * 60 * 60 * 1000;
      table.sweep(retentionEnd);
      expect(table.status('req-1', 'tenant-1', BINDING, retentionEnd)?.status).toBe('expired');
      table.sweep(retentionEnd + 1);
      expect(table.status('req-1', 'tenant-1', BINDING, retentionEnd + 1)).toBeNull();
    });
  });

  describe('a verified result is not expired by the touching operations', () => {
    it('status and sweep at the request expiry leave a verified row alone, so it can still be consumed in its window', () => {
      table.create(input({ expiresAt: T0 + 10_000 }));
      const first = reserve('fp-1', T0 + 1_000);
      expect(table.complete('req-1', 'tenant-1', first.reservationId, RESULT, T0 + 9_000)).toBe(
        true
      );
      table.sweep(T0 + 10_000);
      expect(table.status('req-1', 'tenant-1', BINDING, T0 + 10_000)?.status).toBe('verified');
      expect(table.consume('req-1', 'tenant-1', BINDING, undefined, T0 + 10_500)).toMatchObject({
        credentialId: 'cred-1',
      });
    });
  });
});
