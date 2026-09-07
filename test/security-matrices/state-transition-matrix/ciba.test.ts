/**
 * CIBA matrices through the REAL CIBARequestStore (C-S) and the real token endpoint
 * tokenHandler (C-T).
 *
 * poll / ping / push delivery modes; nonce and authenticated ACR storage and
 * propagation into the issued ID token; the mark-token-issued reservation boundary
 * (a non-successful reservation fails closed with zero signing, zero refresh-family
 * creation, zero issued-token registration, and no success events).
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  createSecurityMatrixEnv,
  seedClientRow,
  seedRegionShardConfig,
  type SecurityMatrixEnvKit,
} from '../fixtures/env';
import { CallLedger } from '../fixtures/call-ledger';
import { installFrozenNow, restoreRealClock } from '../fixtures/deterministic-clock';
import {
  CIBA_STORE_CASE_TABLE,
  CIBA_TOKEN_CASE_TABLE,
  decideCibaStore,
  decideCibaToken,
} from './cases';
import {
  CLIENT_ID,
  FROZEN_NOW,
  SECRET,
  buildCibaObservation,
  cibaMutationCandidate,
  decodeIdTokenClaims,
  expectedCibaObservation,
  hashSecret,
  runCibaStoreOp,
  runCibaTokenOp,
  seedCibaState,
  seedCibaTokenStore,
  seedRegionShardConfigForeign,
} from './ciba-observation';

describe('state-transition Matrix C-S: CIBA store owner', () => {
  let kit: SecurityMatrixEnvKit;
  let ledger: CallLedger;

  beforeEach(async () => {
    installFrozenNow(FROZEN_NOW);
    ledger = new CallLedger();
    kit = await createSecurityMatrixEnv(ledger);
    seedRegionShardConfig(kit);
  });

  afterEach(() => {
    restoreRealClock();
  });

  for (const entry of CIBA_STORE_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const namespace = await seedCibaState(kit, ledger, entry);
      ledger.reset();
      const runResult = await runCibaStoreOp(namespace, entry);
      const observation = await buildCibaObservation(kit, ledger, namespace, entry, {
        response: runResult.response,
        error: runResult.error,
        surface: 'store',
      });
      const expected = expectedCibaObservation(entry, decideCibaStore(entry.dimensions as never));
      expect(observation, entry.id).toEqual(expected);
    });
  }

  it('every CIBA store case carries a discriminating mutation witness', () => {
    expect.hasAssertions();
    for (const entry of CIBA_STORE_CASE_TABLE) {
      const base = decideCibaStore(entry.dimensions as never);
      const baseSignature = JSON.stringify(base);
      if (entry.mutationIds.length === 0) continue;
      for (const mutationId of entry.mutationIds) {
        const mutant = cibaMutationCandidate(entry, mutationId);
        expect(JSON.stringify(mutant), `${entry.id} mutation ${mutationId}`).not.toBe(
          baseSignature
        );
      }
    }
  });
});

describe('state-transition Matrix C-T: CIBA token endpoint', () => {
  let kit: SecurityMatrixEnvKit;
  let ledger: CallLedger;

  beforeEach(async () => {
    installFrozenNow(FROZEN_NOW);
    ledger = new CallLedger();
    kit = await createSecurityMatrixEnv(ledger);
    seedRegionShardConfig(kit);
    seedRegionShardConfigForeign(kit);
    const secretHash = await hashSecret(SECRET);
    seedClientRow(kit, {
      client_id: CLIENT_ID,
      token_endpoint_auth_method: 'client_secret_post',
      client_secret_hash: secretHash,
      default_resource: 'svc://matrix-api',
      grant_types: 'urn:openid:params:grant-type:ciba',
      backchannel_token_delivery_mode: 'poll',
    });
    seedClientRow(kit, {
      client_id: 'other-ciba-client',
      token_endpoint_auth_method: 'client_secret_post',
      client_secret_hash: await hashSecret('other-secret'),
      default_resource: 'svc://matrix-api',
      grant_types: 'urn:openid:params:grant-type:ciba',
      backchannel_token_delivery_mode: 'poll',
    });
    kit.coreAdapter.addBehavior({
      match: (sql) => sql.includes('FROM identity_accounts') && sql.includes('legacy_user_id'),
      result: () => [
        {
          id: 'account-user-001',
          tenant_id: 'default',
          subject_id: 'subject-user-001',
          legacy_user_id: 'user-001',
          account_type: 'end_user',
          lifecycle_state: 'active',
          created_at: 1700000000,
          updated_at: 1700000000,
        },
      ],
    });
  });

  afterEach(() => {
    restoreRealClock();
  });

  for (const entry of CIBA_TOKEN_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const { namespace, seededNonce, seededAcr, stubState, stubTokenIssued, reservationCalled } =
        await seedCibaTokenStore(kit, ledger, entry);
      ledger.reset();
      const tokenResult = await runCibaTokenOp(kit, ledger, entry);
      const observation = await buildCibaObservation(kit, ledger, namespace, entry, {
        response: null,
        surface: 'token',
        ...tokenResult,
        observedState: stubState(),
        observedTokenIssued: stubTokenIssued(),
        observedReservationCalled: reservationCalled(),
        observedNonce: seededNonce,
        observedAcr: seededAcr,
      });
      const expected = expectedCibaObservation(entry, decideCibaToken(entry.dimensions as never));
      expect(observation, entry.id).toEqual(expected);
    });
  }

  it('every CIBA token case carries a discriminating mutation witness', () => {
    expect.hasAssertions();
    for (const entry of CIBA_TOKEN_CASE_TABLE) {
      const base = decideCibaToken(entry.dimensions as never);
      const baseSignature = JSON.stringify(base);
      if (entry.mutationIds.length === 0) continue;
      for (const mutationId of entry.mutationIds) {
        const mutant = cibaMutationCandidate(entry, mutationId);
        expect(JSON.stringify(mutant), `${entry.id} mutation ${mutationId}`).not.toBe(
          baseSignature
        );
      }
    }
  });

  it('the issued ID token carries the stored nonce and authenticated ACR', async () => {
    expect.hasAssertions();
    const entry = CIBA_TOKEN_CASE_TABLE.find(
      (row) =>
        String(row.dimensions.state) === 'approved' &&
        String(row.dimensions.nonce) === 'present' &&
        String(row.dimensions.acr) === 'matching'
    ) as (typeof CIBA_TOKEN_CASE_TABLE)[number];
    const { namespace, seededNonce, seededAcr, stubState, stubTokenIssued, reservationCalled } =
      await seedCibaTokenStore(kit, ledger, entry);
    ledger.reset();
    const tokenResult = await runCibaTokenOp(kit, ledger, entry);
    const claims = decodeIdTokenClaims(tokenResult.bodyText);
    expect(tokenResult.status).toBe(200);
    expect(claims?.nonce).toBe(seededNonce);
    expect(claims?.acr).toBe(seededAcr);
    const expected = expectedCibaObservation(entry, decideCibaToken(entry.dimensions as never));
    const observation = await buildCibaObservation(kit, ledger, namespace, entry, {
      response: null,
      surface: 'token',
      ...tokenResult,
      observedState: stubState(),
      observedTokenIssued: stubTokenIssued(),
      observedReservationCalled: reservationCalled(),
      observedNonce: seededNonce,
      observedAcr: seededAcr,
    });
    expect(observation, entry.id).toEqual(expected);
  });
});
