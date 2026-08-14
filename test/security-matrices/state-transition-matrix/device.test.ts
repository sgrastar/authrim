/**
 * Device flow matrices through the REAL DeviceCodeStore (D-S) and the real token
 * endpoint tokenHandler (D-T).
 *
 * Sequences under test: pending → approved → issued; pending → denied → deleted;
 * pending/approved → expired; authorization_pending / slow_down polling; forbidden
 * transitions; wrong client; reservation fail-closed; alarm/delete idempotency; instance
 * reconstruction over the same fake durable storage.
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
  DEVICE_STORE_CASE_TABLE,
  DEVICE_TOKEN_CASE_TABLE,
  decideDeviceStore,
  decideDeviceToken,
  type StateCase,
} from './cases';
import {
  CLIENT_ID,
  DEVICE_CODE,
  FROZEN_NOW,
  buildDeviceObservation,
  deviceMutationCandidate,
  expectedDeviceObservation,
  runDeviceStoreOp,
  runDeviceTokenOp,
  seedDeviceState,
  seedDeviceTokenStore,
  seedRegionShardConfigForeign,
} from './device-observation';

describe('state-transition Matrix D-S: device flow store owner', () => {
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

  for (const entry of DEVICE_STORE_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const namespace = await seedDeviceState(kit, ledger, entry);
      ledger.reset();
      const runResult = await runDeviceStoreOp(namespace, entry);
      const observation = await buildDeviceObservation(kit, ledger, namespace, entry, {
        response: runResult.response,
        error: runResult.error,
        surface: 'store',
      });
      const expected = expectedDeviceObservation(
        entry,
        decideDeviceStore(entry.dimensions as never)
      );
      expect(observation, entry.id).toEqual(expected);
    });
  }

  it('every device store case carries a discriminating mutation witness', () => {
    expect.hasAssertions();
    for (const entry of DEVICE_STORE_CASE_TABLE) {
      const base = decideDeviceStore(entry.dimensions as never);
      const baseSignature = JSON.stringify(base);
      if (entry.mutationIds.length === 0) continue;
      for (const mutationId of entry.mutationIds) {
        const mutant = deviceMutationCandidate(entry, mutationId);
        expect(JSON.stringify(mutant), `${entry.id} mutation ${mutationId}`).not.toBe(
          baseSignature
        );
      }
    }
  });
});

describe('state-transition Matrix D-T: device flow token endpoint', () => {
  let kit: SecurityMatrixEnvKit;
  let ledger: CallLedger;

  beforeEach(async () => {
    installFrozenNow(FROZEN_NOW);
    ledger = new CallLedger();
    kit = await createSecurityMatrixEnv(ledger);
    seedRegionShardConfig(kit);
    seedRegionShardConfigForeign(kit);
    seedClientRow(kit, {
      client_id: CLIENT_ID,
      token_endpoint_auth_method: 'none',
      grant_types: 'urn:ietf:params:oauth:grant-type:device_code',
      default_resource: 'svc://matrix-api',
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

  for (const entry of DEVICE_TOKEN_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const { namespace, stubState, stubTokenIssued, reservationCalled } =
        await seedDeviceTokenStore(kit, ledger, entry);
      ledger.reset();
      const tokenResult = await runDeviceTokenOp(kit, ledger, entry);
      const observation = await buildDeviceObservation(kit, ledger, namespace, entry, {
        response: null,
        surface: 'token',
        ...tokenResult,
        observedState: stubState(),
        observedTokenIssued: stubTokenIssued(),
        observedReservationCalled: reservationCalled(),
      });
      const expected = expectedDeviceObservation(
        entry,
        decideDeviceToken(entry.dimensions as never)
      );
      expect(observation, entry.id).toEqual(expected);
    });
  }

  it('every device token case carries a discriminating mutation witness', () => {
    expect.hasAssertions();
    for (const entry of DEVICE_TOKEN_CASE_TABLE) {
      const base = decideDeviceToken(entry.dimensions as never);
      const baseSignature = JSON.stringify(base);
      if (entry.mutationIds.length === 0) continue;
      for (const mutationId of entry.mutationIds) {
        const mutant = deviceMutationCandidate(entry, mutationId);
        expect(JSON.stringify(mutant), `${entry.id} mutation ${mutationId}`).not.toBe(
          baseSignature
        );
      }
    }
  });

  it('a denied device code is deleted by the token endpoint', async () => {
    expect.hasAssertions();
    const entry = DEVICE_TOKEN_CASE_TABLE.find(
      (row) => String(row.dimensions.state) === 'denied'
    ) as StateCase;
    const namespace = await seedDeviceState(kit, ledger, entry);
    kit.env.DEVICE_CODE_STORE = namespace as never;
    ledger.reset();
    const tokenResult = await runDeviceTokenOp(kit, ledger, entry);
    expect(tokenResult.status).toBe(403);
    expect(tokenResult.error).toBe('access_denied');
    const storage = namespace.getStorage(`tenant:default:device`);
    expect(storage.snapshot().has(`d:${DEVICE_CODE}`)).toBe(false);
  });
});
