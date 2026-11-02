import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { CredentialOfferStore, type CreateCredentialOfferInput } from '../CredentialOfferStore';
import { VCI_INITIAL_SCHEMA } from '../../../common/primary-key-schema';
import { createSqliteState } from './sqlite-storage';

const TENANT = 'tenant-a';
const ADMIN = 'admin-1';
const NOW = 1_700_000_000_000;

function offerInput(
  id: string,
  overrides: Partial<CreateCredentialOfferInput> = {}
): CreateCredentialOfferInput {
  return {
    id,
    tenantId: TENANT,
    userId: ADMIN,
    subjectKind: 'admin',
    credentialProfileId: 'admin',
    credentialProfileVersion: 1,
    credentialProfileSnapshotHash: 'snapshot-hash',
    credentialConfigurationId: 'AuthrimAdminCredential',
    mappingVersionId: 'admin',
    mappingSnapshotHash: 'mapping-hash',
    claimManifestHash: 'manifest-hash',
    claims: {},
    preAuthorizedCodeHash: `code-${id}`,
    txCodeHash: `tx-${id}`,
    createdAt: NOW,
    expiresAt: NOW + 300_000,
    ...overrides,
  };
}

function newStore(db?: DatabaseSync) {
  const harness = createSqliteState(db);
  const store = new CredentialOfferStore(harness.state, {} as never);
  return { ...harness, store };
}

/** Takes an offer through the token exchange: pending → processing → consumed. */
function consume(store: CredentialOfferStore, id: string, claimsExpiresAt = NOW + 120_000): void {
  const reserved = store.reserveOfferRpc({
    id,
    tenantId: TENANT,
    preAuthorizedCodeHash: `code-${id}`,
    txCodeHash: `tx-${id}`,
    now: NOW + 1_000,
  });
  if (!reserved.reserved) throw new Error(`reserve failed: ${reserved.reason}`);
  // completeOfferRpc compares claimsExpiresAt with the real clock, so keep it in the future.
  expect(
    store.completeOfferRpc({
      id,
      tenantId: TENANT,
      reservationId: reserved.reservationId,
      claimsExpiresAt: Date.now() + (claimsExpiresAt - NOW),
    })
  ).toBe(true);
}

describe('CredentialOfferStore schema upgrade', () => {
  it('adds the new columns and table to an old store without losing rows', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(VCI_INITIAL_SCHEMA);
    db.prepare(
      `INSERT INTO credential_offers (id, tenant_id, user_id, credential_profile_id,
         credential_profile_version, credential_profile_snapshot_hash, credential_configuration_id,
         mapping_version_id, mapping_snapshot_hash, claim_manifest_hash, claims_json, code_hash,
         status, created_at, expires_at)
       VALUES ('old-offer', 'tenant-a', 'user-1', 'p', 1, 's', 'AuthrimIdentityCredential', 'm',
         'h', 'c', '{"given_name":"Alice"}', 'code', 'pending', ?, ?)`
    ).run(NOW, NOW + 60_000);

    const { store, ready } = newStore(db);
    await ready();

    const old = store.getOfferRpc({ id: 'old-offer', tenantId: TENANT, now: NOW + 1 });
    expect(old).toMatchObject({
      id: 'old-offer',
      subjectKind: 'end_user',
      claims: { given_name: 'Alice' },
      status: 'pending',
    });
    const columns = db.prepare(`PRAGMA table_info("credential_offers")`).all() as {
      name: string;
    }[];
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['subject_kind', 'fetched_at'])
    );
    expect(
      db.prepare(`SELECT name FROM sqlite_schema WHERE name = 'credential_offer_issuances'`).all()
    ).toHaveLength(1);
  });

  it('runs after the primary-key rebuild of a legacy store and keeps its rows', async () => {
    const db = new DatabaseSync(':memory:');
    // The pre-rebuild shape: the primary keys are not declared NOT NULL.
    db.exec(VCI_INITIAL_SCHEMA.replaceAll('PRIMARY KEY NOT NULL', 'PRIMARY KEY'));
    db.prepare(
      `INSERT INTO credential_offers (id, tenant_id, user_id, credential_profile_id,
         credential_profile_version, credential_profile_snapshot_hash, credential_configuration_id,
         mapping_version_id, mapping_snapshot_hash, claim_manifest_hash, claims_json, code_hash,
         status, created_at, expires_at)
       VALUES ('legacy-offer', 'tenant-a', 'user-1', 'p', 1, 's', 'AuthrimIdentityCredential', 'm',
         'h', 'c', '{}', 'code', 'pending', ?, ?)`
    ).run(NOW, NOW + 60_000);

    const { store, ready } = newStore(db);
    await ready();

    expect(store.getOfferRpc({ id: 'legacy-offer', tenantId: TENANT, now: NOW + 1 })).toMatchObject(
      {
        subjectKind: 'end_user',
      }
    );
    const idColumn = (
      db.prepare(`PRAGMA table_info("credential_offers")`).all() as {
        name: string;
        notnull: number;
      }[]
    ).find((column) => column.name === 'id');
    expect(idColumn?.notnull).toBe(1);
  });

  it('is idempotent across restarts of the same store', async () => {
    const db = new DatabaseSync(':memory:');
    const first = newStore(db);
    await first.ready();
    first.store.createOfferRpc(offerInput('offer-a'));
    const second = newStore(db);
    await second.ready();
    expect(
      second.store.getOfferRpc({ id: 'offer-a', tenantId: TENANT, now: NOW + 1 })
    ).toMatchObject({
      subjectKind: 'admin',
    });
  });

  it('keeps the offer status constraint untouched', async () => {
    const { db, ready } = newStore();
    await ready();
    const sql = (
      db.prepare(`SELECT sql FROM sqlite_schema WHERE name = 'credential_offers'`).get() as {
        sql: string;
      }
    ).sql;
    expect(sql).toContain(
      "CHECK (status IN ('pending','processing','consumed','locked','expired'))"
    );
  });
});

describe('CredentialOfferStore issuance state machine', () => {
  let store: CredentialOfferStore;
  let db: DatabaseSync;

  beforeEach(async () => {
    const harness = newStore();
    await harness.ready();
    store = harness.store;
    db = harness.db;
    store.createOfferRpc(offerInput('offer-a'));
  });

  const claim = (jti = 'jti-1', now = Date.now(), id = 'offer-a') =>
    store.claimIssuanceRpc({ id, tenantId: TENANT, accessTokenJti: jti, now });

  it('refuses to claim an offer whose token has not been exchanged', () => {
    expect(claim()).toBe(false);
  });

  it('grants exactly one claim for two concurrent claims', async () => {
    consume(store, 'offer-a');
    const results = await Promise.all([
      Promise.resolve().then(() => claim('jti-1')),
      Promise.resolve().then(() => claim('jti-2')),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM credential_offer_issuances`).get()).toEqual({
      n: 1,
    });
    // The same token cannot claim again either.
    expect(claim('jti-1')).toBe(false);
    expect(claim('jti-2')).toBe(false);
  });

  it('does not claim an offer of another tenant or after the token window', () => {
    consume(store, 'offer-a', NOW + 5_000);
    expect(
      store.claimIssuanceRpc({
        id: 'offer-a',
        tenantId: 'tenant-b',
        accessTokenJti: 'j',
        now: Date.now(),
      })
    ).toBe(false);
    expect(claim('jti-1', Date.now() + 10 * 60_000)).toBe(false);
  });

  it('completes issuing → issued once, with the matching token only', () => {
    consume(store, 'offer-a');
    const now = Date.now();
    expect(claim('jti-1', now)).toBe(true);
    expect(
      store.completeIssuanceRpc({
        id: 'offer-a',
        tenantId: TENANT,
        accessTokenJti: 'other',
        holderJkt: 'thumb',
        now,
      })
    ).toBe(false);
    expect(
      store.completeIssuanceRpc({
        id: 'offer-a',
        tenantId: TENANT,
        accessTokenJti: 'jti-1',
        holderJkt: 'thumb',
        now,
      })
    ).toBe(true);
    // issued is final: it cannot fail or complete again
    expect(
      store.failIssuanceRpc({ id: 'offer-a', tenantId: TENANT, accessTokenJti: 'jti-1', now })
    ).toBe(false);
    expect(
      store.completeIssuanceRpc({
        id: 'offer-a',
        tenantId: TENANT,
        accessTokenJti: 'jti-1',
        holderJkt: 'thumb2',
        now,
      })
    ).toBe(false);
    expect(
      store.getAdminOfferProgressRpc({ id: 'offer-a', tenantId: TENANT, userId: ADMIN, now })
    ).toMatchObject({ state: 'issued', holderKeyThumbprint: 'thumb' });
  });

  it('fails issuing → failed and never becomes claimable again', () => {
    consume(store, 'offer-a');
    const now = Date.now();
    expect(claim('jti-1', now)).toBe(true);
    expect(
      store.failIssuanceRpc({ id: 'offer-a', tenantId: TENANT, accessTokenJti: 'jti-1', now })
    ).toBe(true);
    expect(claim('jti-1', now + 1)).toBe(false);
    expect(claim('jti-2', now + 1)).toBe(false);
    expect(
      store.getAdminOfferProgressRpc({ id: 'offer-a', tenantId: TENANT, userId: ADMIN, now })
    ).toMatchObject({ state: 'failed' });
  });

  it('turns a stale issuing lease into failed, not back into claimable', () => {
    consume(store, 'offer-a');
    const now = Date.now();
    expect(claim('jti-1', now)).toBe(true);
    const later = now + 61_000;
    expect(
      store.getAdminOfferProgressRpc({ id: 'offer-a', tenantId: TENANT, userId: ADMIN, now: later })
    ).toMatchObject({ state: 'failed' });
    expect(
      store.completeIssuanceRpc({
        id: 'offer-a',
        tenantId: TENANT,
        accessTokenJti: 'jti-1',
        holderJkt: 'thumb',
        now: later,
      })
    ).toBe(false);
    expect(claim('jti-2', later)).toBe(false);
  });

  it('refuses completion after the lease ran out even before any sweep', () => {
    consume(store, 'offer-a');
    const now = Date.now();
    claim('jti-1', now);
    expect(
      store.completeIssuanceRpc({
        id: 'offer-a',
        tenantId: TENANT,
        accessTokenJti: 'jti-1',
        holderJkt: 'thumb',
        now: now + 60_000,
      })
    ).toBe(false);
  });

  it('sweeps stale leases in the alarm and keeps rows needed by status reads', async () => {
    consume(store, 'offer-a');
    const now = Date.now();
    claim('jti-1', now - 120_000);
    await store.alarm();
    expect(
      db.prepare(`SELECT status FROM credential_offer_issuances WHERE offer_id = 'offer-a'`).get()
    ).toEqual({ status: 'failed' });
    expect(
      store.getAdminOfferProgressRpc({ id: 'offer-a', tenantId: TENANT, userId: ADMIN, now })
    ).toMatchObject({ state: 'failed' });
  });

  it('records the first fetch only', () => {
    expect(store.markOfferFetchedRpc({ id: 'offer-a', tenantId: TENANT, now: NOW + 10 })).toBe(
      true
    );
    expect(store.markOfferFetchedRpc({ id: 'offer-a', tenantId: TENANT, now: NOW + 20 })).toBe(
      false
    );
    expect(
      db.prepare(`SELECT fetched_at FROM credential_offers WHERE id = 'offer-a'`).get()
    ).toEqual({ fetched_at: NOW + 10 });
  });
});

describe('CredentialOfferStore admin offer progress', () => {
  let store: CredentialOfferStore;

  beforeEach(async () => {
    const harness = newStore();
    await harness.ready();
    store = harness.store;
    store.createOfferRpc(offerInput('offer-a'));
  });

  const progress = (
    overrides: Partial<{ tenantId: string; userId: string; id: string; now: number }> = {}
  ) =>
    store.getAdminOfferProgressRpc({
      id: 'offer-a',
      tenantId: TENANT,
      userId: ADMIN,
      now: NOW + 1,
      ...overrides,
    });

  it('maps pending, fetched and token_issued', () => {
    expect(progress()).toEqual({ offerId: 'offer-a', state: 'pending', expiresAt: NOW + 300_000 });
    store.markOfferFetchedRpc({ id: 'offer-a', tenantId: TENANT, now: NOW + 2 });
    expect(progress()?.state).toBe('fetched');
    consume(store, 'offer-a');
    expect(progress()?.state).toBe('token_issued');
  });

  it('reports expired and locked', () => {
    expect(progress({ now: NOW + 301_000 })?.state).toBe('expired');
    store.createOfferRpc(offerInput('offer-b', { maxAttempts: 1 }));
    store.reserveOfferRpc({
      id: 'offer-b',
      tenantId: TENANT,
      preAuthorizedCodeHash: 'code-offer-b',
      txCodeHash: 'wrong',
      now: NOW + 5,
    });
    expect(progress({ id: 'offer-b' })?.state).toBe('locked');
  });

  it('returns null for another admin, another tenant, an unknown offer or an end-user offer', () => {
    expect(progress({ userId: 'admin-2' })).toBeNull();
    expect(progress({ tenantId: 'tenant-b' })).toBeNull();
    expect(progress({ id: 'missing' })).toBeNull();
    store.createOfferRpc(offerInput('offer-user', { subjectKind: 'end_user', userId: ADMIN }));
    expect(progress({ id: 'offer-user' })).toBeNull();
  });
});
