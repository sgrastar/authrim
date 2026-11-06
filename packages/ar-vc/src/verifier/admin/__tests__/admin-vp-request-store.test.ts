import { beforeEach, describe, expect, it } from 'vitest';
import { createSqliteState } from '../../../issuer/durable-objects/__tests__/sqlite-storage';
import {
  ADMIN_VP_CONSUME_WINDOW_MS,
  AdminVPRequestTable,
  type AdminVPRequestInput,
} from '../admin-vp-request-store';

const T0 = 1_800_000_000_000;
const JKT = 'A'.repeat(43);

function input(overrides: Partial<AdminVPRequestInput> = {}): AdminVPRequestInput {
  return {
    id: 'req-1',
    tenantId: 'tenant-1',
    adminUserId: 'admin-1',
    sessionId: 'session-1',
    purpose: 'step_up',
    holderJkts: [JKT],
    nonce: 'nonce-1',
    matchCode: '07',
    clientId: 'decentralized_identifier:did:web:idp.example.com',
    credentialIssuer: 'https://idp.example.com',
    transactionData: 'td',
    requestObject: 'header.payload.signature',
    createdAt: T0,
    expiresAt: T0 + 300_000,
    ...overrides,
  };
}

describe('AdminVPRequestTable', () => {
  let table: AdminVPRequestTable;

  beforeEach(() => {
    const { state } = createSqliteState();
    table = new AdminVPRequestTable(state.storage.sql);
    table.initialize();
    table.initialize(); // idempotent
  });

  function reserve(fingerprint = 'fp-1', now = T0 + 1_000) {
    const result = table.reserve('req-1', 'tenant-1', fingerprint, now);
    if (!result.reserved) throw new Error(`not reserved: ${result.reason}`);
    return result;
  }

  it('serves the request object only while it can be answered', () => {
    table.create(input());
    expect(table.requestObject('req-1', 'tenant-1', T0)).toBe('header.payload.signature');
    expect(table.requestObject('req-1', 'tenant-2', T0)).toBeNull();
    reserve();
    expect(table.requestObject('req-1', 'tenant-1', T0 + 2_000)).toBeNull();
  });

  it('validates what it stores', () => {
    expect(() => table.create(input({ matchCode: '7' }))).toThrow('admin_vp_invalid_match_code');
    expect(() => table.create(input({ holderJkts: [] }))).toThrow(
      'admin_vp_no_registered_holder_key'
    );
    expect(() => table.create(input({ purpose: 'login' as never }))).toThrow();
    expect(() => table.create(input({ expiresAt: T0 }))).toThrow('admin_vp_invalid_expiry');
    expect(() => table.create(input({ context: { big: 'x'.repeat(3000) } }))).toThrow(
      'admin_vp_invalid_context'
    );
    expect(() => table.create(input({ context: { n: 1 as never } }))).toThrow(
      'admin_vp_invalid_context'
    );
    // Enrolment may start with no registered key.
    expect(() =>
      table.create(input({ id: 'req-2', purpose: 'enroll', holderJkts: [] }))
    ).not.toThrow();
  });

  it('reserves a response once and reports a resend of the same response as replayed', () => {
    table.create(input());
    const first = reserve();
    expect(first.request).toMatchObject({
      status: 'processing',
      matchCode: '07',
      holderJkts: [JKT],
    });
    expect(table.reserve('req-1', 'tenant-1', 'fp-1', T0 + 2_000)).toEqual({
      reserved: false,
      reason: 'replayed',
    });
    expect(table.reserve('req-1', 'tenant-1', 'fp-other', T0 + 2_000)).toEqual({
      reserved: false,
      reason: 'unavailable',
    });
  });

  it('refuses a response already used for another request', () => {
    table.create(input());
    table.create(input({ id: 'req-2' }));
    reserve('fp-1');
    expect(table.reserve('req-2', 'tenant-1', 'fp-1', T0 + 2_000)).toEqual({
      reserved: false,
      reason: 'replayed',
    });
  });

  it('hands the verified result over once, to the session that asked for it', () => {
    table.create(input({ context: { mode: 'step_up', approvingFactorId: null } }));
    const { reservationId } = reserve();
    expect(
      table.complete(
        'req-1',
        'tenant-1',
        reservationId,
        { holderJkt: JKT, credentialId: 'c-1' },
        T0 + 3_000
      )
    ).toBe(true);
    expect(table.status('req-1', 'tenant-1', 'admin-1', 'session-1', T0 + 4_000)).toMatchObject({
      status: 'verified',
    });
    // Another session or admin sees nothing and consumes nothing.
    expect(table.status('req-1', 'tenant-1', 'admin-1', 'session-2', T0 + 4_000)).toBeNull();
    expect(table.consume('req-1', 'tenant-1', 'admin-2', 'session-1', T0 + 4_000)).toBeNull();
    expect(table.consume('req-1', 'tenant-1', 'admin-1', 'session-2', T0 + 4_000)).toBeNull();

    expect(table.consume('req-1', 'tenant-1', 'admin-1', 'session-1', T0 + 4_000)).toEqual({
      purpose: 'step_up',
      context: { mode: 'step_up', approvingFactorId: null },
      holderJkt: JKT,
      credentialId: 'c-1',
      verifiedAt: T0 + 3_000,
    });
    expect(table.consume('req-1', 'tenant-1', 'admin-1', 'session-1', T0 + 5_000)).toBeNull();
    expect(table.status('req-1', 'tenant-1', 'admin-1', 'session-1', T0 + 5_000)).toMatchObject({
      status: 'consumed',
    });
  });

  it('does not hand over a result older than the consume window', () => {
    table.create(input());
    const { reservationId } = reserve();
    table.complete('req-1', 'tenant-1', reservationId, { holderJkt: JKT, credentialId: 'c-1' }, T0);
    expect(
      table.consume('req-1', 'tenant-1', 'admin-1', 'session-1', T0 + ADMIN_VP_CONSUME_WINDOW_MS)
    ).toBeNull();
  });

  it('completes only with its own reservation', () => {
    table.create(input());
    reserve();
    expect(
      table.complete('req-1', 'tenant-1', 'someone-else', { holderJkt: JKT, credentialId: 'c' }, T0)
    ).toBe(false);
  });

  it('keeps a failed request failed: a wrong code is not retried', () => {
    table.create(input());
    const { reservationId } = reserve();
    expect(table.fail('req-1', 'tenant-1', reservationId, 'match_code_mismatch')).toBe(true);
    expect(table.status('req-1', 'tenant-1', 'admin-1', 'session-1', T0 + 2_000)).toEqual({
      status: 'failed',
      expiresAt: T0 + 300_000,
      errorCode: 'match_code_mismatch',
    });
    expect(table.reserve('req-1', 'tenant-1', 'fp-2', T0 + 2_000)).toEqual({
      reserved: false,
      reason: 'unavailable',
    });
    expect(table.consume('req-1', 'tenant-1', 'admin-1', 'session-1', T0 + 2_000)).toBeNull();
  });

  it('gives a request back after an infrastructure error, for the same response again', () => {
    table.create(input());
    const { reservationId } = reserve('fp-1');
    expect(table.release('req-1', 'tenant-1', reservationId, T0 + 2_000)).toBe(true);
    expect(table.reserve('req-1', 'tenant-1', 'fp-1', T0 + 3_000).reserved).toBe(true);
  });

  it('takes a request over once the lease of a stuck verification ran out', () => {
    table.create(input());
    reserve('fp-1', T0);
    expect(table.reserve('req-1', 'tenant-1', 'fp-2', T0 + 10_000).reserved).toBe(false);
    expect(table.reserve('req-1', 'tenant-1', 'fp-2', T0 + 31_000).reserved).toBe(true);
  });

  it('expires requests that were not answered in time', () => {
    table.create(input());
    expect(table.reserve('req-1', 'tenant-1', 'fp', T0 + 300_000)).toEqual({
      reserved: false,
      reason: 'expired',
    });
    expect(table.status('req-1', 'tenant-1', 'admin-1', 'session-1', T0 + 300_001)).toMatchObject({
      status: 'expired',
    });
    expect(table.requestObject('req-1', 'tenant-1', T0 + 300_001)).toBeNull();
  });

  it('keeps a Digital Credentials API request off the QR paths', () => {
    expect(() => table.create(input({ mode: 'dc_api' }))).toThrow(
      'admin_vp_invalid_dc_api_request'
    );
    table.create(
      input({
        mode: 'dc_api',
        matchCode: '',
        expectedOrigin: 'https://console.example.com',
        encryptionJwk: '{"kty":"EC"}',
      })
    );
    // Never fetched by reference, never answered by a wallet's direct_post.
    expect(table.requestObject('req-1', 'tenant-1', T0)).toBeNull();
    expect(table.reserve('req-1', 'tenant-1', 'fp', T0 + 1_000)).toEqual({
      reserved: false,
      reason: 'not_found',
    });
    const reserved = table.reserve('req-1', 'tenant-1', 'fp', T0 + 1_000, 'dc_api');
    expect(reserved).toMatchObject({
      reserved: true,
      request: {
        mode: 'dc_api',
        encryptionJwk: '{"kty":"EC"}',
        expectedOrigin: 'https://console.example.com',
        matchCode: '',
      },
    });
  });

  it('adds the Digital Credentials API columns to a table created before them', () => {
    const { state, db } = createSqliteState();
    db.exec(`CREATE TABLE admin_vp_requests (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, admin_user_id TEXT NOT NULL,
      session_id TEXT NOT NULL, purpose TEXT NOT NULL, holder_jkts_json TEXT NOT NULL,
      nonce TEXT NOT NULL, match_code TEXT NOT NULL, client_id TEXT NOT NULL,
      credential_issuer TEXT NOT NULL, transaction_data TEXT NOT NULL, request_object TEXT NOT NULL,
      context_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, reservation_id TEXT,
      lease_expires_at INTEGER, response_fingerprint TEXT, result_holder_jkt TEXT,
      result_credential_id TEXT, error_code TEXT, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, verified_at INTEGER, consumed_at INTEGER)`);
    const old = new AdminVPRequestTable(state.storage.sql);
    old.initialize();
    old.initialize();
    old.create(input());
    expect(old.requestObject('req-1', 'tenant-1', T0)).toBe('header.payload.signature');
  });

  it('sweeps due requests and plans the next look', () => {
    table.create(input());
    table.create(input({ id: 'req-2', expiresAt: T0 + 600_000 }));
    expect(table.sweep(T0 + 400_000)).toBe(T0 + 600_000);
    expect(table.status('req-1', 'tenant-1', 'admin-1', 'session-1', T0 + 400_000)).toMatchObject({
      status: 'expired',
    });
    // A day after expiry the row is gone.
    table.sweep(T0 + 300_000 + 24 * 60 * 60 * 1000 + 1);
    expect(table.status('req-1', 'tenant-1', 'admin-1', 'session-1', T0)).toBeNull();
  });
});
