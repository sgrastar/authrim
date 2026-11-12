import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import {
  buildSAMLLoginCancelPath,
  claimSAMLLoginCancel,
  createSAMLLoginCancelGrant,
  createSAMLLoginNonce,
  hashSAMLLoginNonce,
  isSAMLLoginNonce,
} from '../saml-login-cancel';

interface Row {
  state: string;
  saml_sp_id: string | null;
  context_json: string | null;
}

/** A one-row interaction table that applies the claim's compare-and-set as the database does. */
function fakeDb(initial: Row) {
  const row = { ...initial };
  const db = {
    queryOne: async () => ({ ...row }),
    execute: async (_sql: string, params: unknown[]) => {
      const [next, , , , expected] = params as [string, number, string, string, string];
      if (row.state === 'failed' && row.context_json === expected) {
        row.context_json = next;
        return { success: true, rowsAffected: 1 };
      }
      return { success: true, rowsAffected: 0 };
    },
  } as unknown as DatabaseAdapter;
  return { db, row };
}

async function cancelledInteraction(overrides: Partial<Row> = {}) {
  const grant = await createSAMLLoginCancelGrant();
  const { db, row } = fakeDb({
    state: 'failed',
    saml_sp_id: 'https://sp.example.test/entity',
    context_json: JSON.stringify({
      saml_request_id: 'req_1',
      saml_login_nonce_hash: 'nonce-hash',
      login_cancel: grant.context,
    }),
    ...overrides,
  });
  return { db, row, token: grant.token };
}

describe('claiming the cancel of a SAML sign-in', () => {
  it('builds a path that carries the interaction and the token', async () => {
    const { token } = await createSAMLLoginCancelGrant();
    const url = new URL(buildSAMLLoginCancelPath({ interactionId: 'i1', token }), 'https://x.test');
    expect(url.pathname).toBe('/saml/idp/login-cancel');
    expect(url.searchParams.get('interaction_id')).toBe('i1');
    expect(url.searchParams.get('token')).toBe(token);
  });

  it('gives the request and SP of the cancelled interaction, once', async () => {
    const { db, token } = await cancelledInteraction();
    const input = { interactionId: 'i1', token };
    expect(await claimSAMLLoginCancel(db, 't', input)).toEqual({
      spEntityId: 'https://sp.example.test/entity',
      requestId: 'req_1',
      loginNonceHash: 'nonce-hash',
    });
    expect(await claimSAMLLoginCancel(db, 't', input)).toBeNull();
  });

  it('lets only one of two concurrent claims win', async () => {
    const { db, token } = await cancelledInteraction();
    const input = { interactionId: 'i1', token };
    const results = await Promise.all([
      claimSAMLLoginCancel(db, 't', input),
      claimSAMLLoginCancel(db, 't', input),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('gives nothing for a wrong, missing or malformed token', async () => {
    const { db } = await cancelledInteraction();
    const other = await createSAMLLoginCancelGrant();
    expect(
      await claimSAMLLoginCancel(db, 't', { interactionId: 'i1', token: other.token })
    ).toBeNull();
    expect(await claimSAMLLoginCancel(db, 't', { interactionId: 'i1', token: '' })).toBeNull();
    expect(await claimSAMLLoginCancel(db, 't', { interactionId: 'i1', token: 'short' })).toBeNull();
    expect(
      await claimSAMLLoginCancel(db, 't', { interactionId: '', token: other.token })
    ).toBeNull();
  });

  it('gives nothing for an interaction not ended by a cancel', async () => {
    for (const state of ['active', 'created', 'completed', 'expired']) {
      const { db, token } = await cancelledInteraction({ state });
      expect(await claimSAMLLoginCancel(db, 't', { interactionId: 'i1', token })).toBeNull();
    }
    // Failed another way: no grant in its context.
    const failed = await cancelledInteraction({
      context_json: JSON.stringify({ saml_request_id: 'req_1', saml_login_nonce_hash: 'h' }),
    });
    expect(
      await claimSAMLLoginCancel(failed.db, 't', { interactionId: 'i1', token: failed.token })
    ).toBeNull();
  });

  it('gives nothing for an interaction started without a login nonce', async () => {
    const grant = await createSAMLLoginCancelGrant();
    const { db } = fakeDb({
      state: 'failed',
      saml_sp_id: 'sp',
      context_json: JSON.stringify({ saml_request_id: 'req_1', login_cancel: grant.context }),
    });
    expect(
      await claimSAMLLoginCancel(db, 't', { interactionId: 'i1', token: grant.token })
    ).toBeNull();
  });

  it('gives nothing once the grant is older than its lifetime', async () => {
    const { db, token } = await cancelledInteraction();
    const input = { interactionId: 'i1', token };
    const later = Date.now() + 5 * 60 * 1000;
    expect(
      await claimSAMLLoginCancel(db, 't', input, { nowMs: later, maxAgeMs: 60_000 })
    ).toBeNull();
    // The longest lifetime holds whatever a caller asks.
    expect(
      await claimSAMLLoginCancel(db, 't', input, {
        nowMs: Date.now() + 11 * 60 * 1000,
        maxAgeMs: 3_600_000,
      })
    ).toBeNull();
    expect(
      await claimSAMLLoginCancel(db, 't', input, { nowMs: later, maxAgeMs: 600_000 })
    ).not.toBeNull();
  });

  it('hashes a nonce for storage, and only a nonce of the right form is one', async () => {
    const { nonce, hash } = await createSAMLLoginNonce();
    expect(isSAMLLoginNonce(nonce)).toBe(true);
    expect(isSAMLLoginNonce('short')).toBe(false);
    expect(isSAMLLoginNonce(42)).toBe(false);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await hashSAMLLoginNonce(nonce)).toBe(hash);
    expect(hash).not.toContain(nonce);
  });

  it('gives nothing for an interaction that is not a SAML request’s', async () => {
    const noSp = await cancelledInteraction({ saml_sp_id: null });
    expect(
      await claimSAMLLoginCancel(noSp.db, 't', { interactionId: 'i1', token: noSp.token })
    ).toBeNull();
    const grant = await createSAMLLoginCancelGrant();
    const noRequest = fakeDb({
      state: 'failed',
      saml_sp_id: 'sp',
      context_json: JSON.stringify({ saml_login_nonce_hash: 'h', login_cancel: grant.context }),
    });
    expect(
      await claimSAMLLoginCancel(noRequest.db, 't', { interactionId: 'i1', token: grant.token })
    ).toBeNull();
  });
});
