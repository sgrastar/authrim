import { beforeEach, describe, expect, it } from 'vitest';
import { createSqliteState } from '../../../issuer/durable-objects/__tests__/sqlite-storage';
import {
  HAIP_LOGIN_CONSUME_WINDOW_MS,
  HaipLoginRequestTable,
  type HaipLoginRequestInput,
} from '../haip-login-request-store';

const T0 = 1_800_000_000_000;
const BINDING = 'B'.repeat(43);
const OTHER_BINDING = 'C'.repeat(43);
const CODE_HASH = 'D'.repeat(43);

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

const RESULT = { adminUserId: 'admin-1', holderJkt: 'J'.repeat(43), credentialId: 'cred-1' };

describe('HaipLoginRequestTable', () => {
  let table: HaipLoginRequestTable;

  beforeEach(() => {
    const { state } = createSqliteState();
    table = new HaipLoginRequestTable(state.storage.sql);
    table.initialize();
    table.initialize();
  });

  function reserve(fingerprint = 'fp-1', now = T0 + 1_000) {
    const result = table.reserve('req-1', 'tenant-1', fingerprint, now);
    if (!result.reserved) throw new Error(`not reserved: ${result.reason}`);
    return result;
  }

  it('serves the request object only while it can be answered, only for its tenant', () => {
    table.create(input());
    expect(table.requestObject('req-1', 'tenant-1', T0)).toBe('header.payload.signature');
    expect(table.requestObject('req-1', 'tenant-2', T0)).toBeNull();
    reserve();
    expect(table.requestObject('req-1', 'tenant-1', T0 + 2_000)).toBeNull();
    // And not after its life.
    table.create(input({ id: 'req-late' }));
    expect(table.requestObject('req-late', 'tenant-1', T0 + 300_000)).toBeNull();
  });

  it('validates what it stores', () => {
    expect(() => table.create(input({ bindingHash: 'short' }))).toThrow(
      'haip_login_invalid_binding'
    );
    expect(() => table.create(input({ flow: 'other' as never }))).toThrow(
      'haip_login_invalid_flow'
    );
    expect(() => table.create(input({ redirectUri: 'https://idp.example.com/cb' }))).toThrow(
      'haip_login_invalid_redirect_uri'
    );
    for (const redirectUri of [
      undefined,
      'http://idp.example.com/cb',
      'https://idp.example.com/cb?x=1',
      'https://idp.example.com/cb#f',
      'not a url',
    ]) {
      expect(() => table.create(input({ flow: 'same_device', redirectUri }))).toThrow(
        'haip_login_invalid_redirect_uri'
      );
    }
    expect(() => table.create(input({ expiresAt: T0 }))).toThrow('haip_login_invalid_expiry');
  });

  it('verifies a response once and hands the result over once, to the starting browser only', () => {
    table.create(input());
    const { reservationId, request } = reserve();
    expect(request).toMatchObject({ flow: 'cross_device', state: 'state-1', status: 'processing' });
    expect(table.complete('req-1', 'tenant-1', reservationId, RESULT, T0 + 2_000)).toBe(true);
    // The wrong browser sees and gets nothing; the right one gets it once.
    expect(table.status('req-1', 'tenant-1', OTHER_BINDING, T0 + 3_000)).toBeNull();
    expect(table.consume('req-1', 'tenant-1', OTHER_BINDING, undefined, T0 + 3_000)).toBeNull();
    expect(table.status('req-1', 'tenant-1', BINDING, T0 + 3_000)).toMatchObject({
      status: 'verified',
      flow: 'cross_device',
    });
    expect(table.consume('req-1', 'tenant-1', BINDING, undefined, T0 + 3_000)).toEqual({
      ...RESULT,
      verifiedAt: T0 + 2_000,
    });
    expect(table.consume('req-1', 'tenant-1', BINDING, undefined, T0 + 4_000)).toBeNull();
    expect(table.status('req-1', 'tenant-1', BINDING, T0 + 4_000)?.status).toBe('consumed');
  });

  it('does not hand over a result after its window', () => {
    table.create(input());
    const { reservationId } = reserve();
    table.complete('req-1', 'tenant-1', reservationId, RESULT, T0 + 2_000);
    expect(
      table.consume(
        'req-1',
        'tenant-1',
        BINDING,
        undefined,
        T0 + 2_000 + HAIP_LOGIN_CONSUME_WINDOW_MS + 1
      )
    ).toBeNull();
  });

  it('needs the response code of the redirect for a same-device login', () => {
    table.create(
      input({ flow: 'same_device', redirectUri: 'https://idp.example.com/login/wallet' })
    );
    const { reservationId } = reserve();
    // A same-device result without a code is never stored as verified.
    expect(table.complete('req-1', 'tenant-1', reservationId, RESULT, T0 + 2_000)).toBe(false);
    expect(
      table.complete(
        'req-1',
        'tenant-1',
        reservationId,
        { ...RESULT, responseCodeHash: CODE_HASH },
        T0 + 2_000
      )
    ).toBe(true);
    expect(table.consume('req-1', 'tenant-1', BINDING, undefined, T0 + 3_000)).toBeNull();
    expect(table.consume('req-1', 'tenant-1', BINDING, 'E'.repeat(43), T0 + 3_000)).toBeNull();
    // The right browser with the right code.
    expect(table.consume('req-1', 'tenant-1', OTHER_BINDING, CODE_HASH, T0 + 3_000)).toBeNull();
    expect(table.consume('req-1', 'tenant-1', BINDING, CODE_HASH, T0 + 3_000)).toMatchObject({
      adminUserId: 'admin-1',
    });
  });

  it('refuses a second answer, replays and answers after expiry', () => {
    table.create(input());
    const first = reserve('fp-1');
    expect(table.reserve('req-1', 'tenant-1', 'fp-1', T0 + 1_500)).toEqual({
      reserved: false,
      reason: 'replayed',
    });
    expect(table.reserve('req-1', 'tenant-1', 'fp-2', T0 + 1_500)).toEqual({
      reserved: false,
      reason: 'unavailable',
    });
    expect(table.reserve('missing', 'tenant-1', 'fp-3', T0)).toEqual({
      reserved: false,
      reason: 'not_found',
    });
    // A lease that ran out gives the request back; one past the request's life ends it.
    expect(table.reserve('req-1', 'tenant-1', 'fp-4', T0 + 60_000).reserved).toBe(true);
    expect(first.reservationId).not.toBe('');
    expect(table.reserve('req-1', 'tenant-1', 'fp-5', T0 + 400_000)).toEqual({
      reserved: false,
      reason: 'expired',
    });
  });

  it('fails for good on a refusal and gives the request back on release', () => {
    table.create(input());
    const first = reserve('fp-1');
    expect(table.fail('req-1', 'tenant-1', first.reservationId, 'invalid_credential')).toBe(true);
    expect(table.status('req-1', 'tenant-1', BINDING, T0 + 2_000)).toMatchObject({
      status: 'failed',
      errorCode: 'invalid_credential',
    });
    expect(table.reserve('req-1', 'tenant-1', 'fp-2', T0 + 3_000).reserved).toBe(false);

    table.create(input({ id: 'req-2' }));
    const second = table.reserve('req-2', 'tenant-1', 'fp-9', T0 + 1_000);
    if (!second.reserved) throw new Error('not reserved');
    expect(table.release('req-2', 'tenant-1', second.reservationId, T0 + 2_000)).toBe(true);
    expect(table.reserve('req-2', 'tenant-1', 'fp-10', T0 + 3_000).reserved).toBe(true);
    // The wrong reservation neither completes nor fails.
    expect(table.complete('req-2', 'tenant-1', 'other', RESULT, T0 + 4_000)).toBe(false);
    expect(table.fail('req-2', 'tenant-1', 'other', 'x')).toBe(false);
  });

  it('sweeps expired requests and old rows', () => {
    table.create(input());
    expect(table.sweep(T0 + 400_000)).toBe(T0 + 300_000 + 24 * 60 * 60 * 1000);
    expect(table.status('req-1', 'tenant-1', BINDING, T0 + 400_000)?.status).toBe('expired');
    expect(table.sweep(T0 + 2 * 24 * 60 * 60 * 1000)).toBeNull();
  });
});
