/**
 * Refresh token family matrix through the REAL RefreshTokenRotator Durable Object.
 *
 * Lifecycle under test: absent → version 1 → version N → absent (expired/revoked/theft).
 * There is no persistent compromised state; theft is observed as family deletion plus
 * exactly one synchronous critical audit (event_log INSERT + audit queue enqueue).
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createSecurityMatrixEnv, type SecurityMatrixEnvKit } from '../fixtures/env';
import { CallLedger } from '../fixtures/call-ledger';
import { installFrozenNow, restoreRealClock } from '../fixtures/deterministic-clock';
import { REFRESH_CASE_TABLE, decideRefresh } from './cases';
import {
  FROZEN_NOW,
  buildRefreshObservation,
  eventLogInsertCount,
  expectedRefreshObservation,
  prepareRefreshSequence,
  refreshMutationCandidate,
  runRefreshOp,
  seedRefreshRow,
  type RefreshObservation,
} from './refresh-observation';

describe('state-transition Matrix R: refresh token family', () => {
  let kit: SecurityMatrixEnvKit;
  let ledger: CallLedger;

  beforeEach(async () => {
    installFrozenNow(FROZEN_NOW);
    ledger = new CallLedger();
    kit = await createSecurityMatrixEnv(ledger);
  });

  afterEach(() => {
    restoreRealClock();
  });

  for (const entry of REFRESH_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const seeded = await seedRefreshRow(kit, ledger, entry);
      await seeded.drain();
      await prepareRefreshSequence(seeded, entry);
      await seeded.drain();
      ledger.reset();
      const runResult = await runRefreshOp(seeded, entry);
      const observation = await buildRefreshObservation(kit, ledger, seeded, entry, runResult);
      const preDrainCount = observation.criticalAudits;
      await seeded.drain();
      observation.postDrainAudits = eventLogInsertCount(ledger) - preDrainCount;
      const expected = expectedRefreshObservation(entry, decideRefresh(entry.dimensions as never));
      expect(observation, entry.id).toEqual(expected);
    });
  }

  it('every refresh case carries a discriminating mutation witness', () => {
    expect.hasAssertions();
    for (const entry of REFRESH_CASE_TABLE) {
      const base = decideRefresh(entry.dimensions as never);
      const baseSignature = JSON.stringify(base);
      if (entry.mutationIds.length === 0) continue;
      for (const mutationId of entry.mutationIds) {
        const mutant = refreshMutationCandidate(entry, mutationId);
        expect(JSON.stringify(mutant), `${entry.id} mutation ${mutationId}`).not.toBe(
          baseSignature
        );
      }
    }
  });

  it('oracle sensitivity: corrupted real refresh observations are rejected per domain', async () => {
    expect.hasAssertions();
    const representatives = REFRESH_CASE_TABLE.filter((entry) => {
      const decision = decideRefresh(entry.dimensions as never);
      return (
        decision.criticalAudits === 1 ||
        decision.postDrainAudits === 1 ||
        decision.outcome === 'success'
      );
    }).slice(0, 12);
    for (const entry of representatives) {
      const seeded = await seedRefreshRow(kit, ledger, entry);
      await seeded.drain();
      await prepareRefreshSequence(seeded, entry);
      await seeded.drain();
      ledger.reset();
      const runResult = await runRefreshOp(seeded, entry);
      const observed = await buildRefreshObservation(kit, ledger, seeded, entry, runResult);
      const preDrainCount = observed.criticalAudits;
      await seeded.drain();
      observed.postDrainAudits = eventLogInsertCount(ledger) - preDrainCount;
      const expected = expectedRefreshObservation(entry, decideRefresh(entry.dimensions as never));
      expect(observed).toEqual(expected);
      const domains: Array<keyof RefreshObservation> = [
        'outcome',
        'errorCode',
        'familyExists',
        'familyVersion',
        'criticalAudits',
        'postDrainAudits',
        'valid',
        'revoked',
      ];
      for (const domain of domains) {
        const corrupted = { ...observed };
        if (domain === 'outcome')
          corrupted.outcome = corrupted.outcome === 'success' ? 'error' : 'success';
        if (domain === 'errorCode')
          corrupted.errorCode = corrupted.errorCode === null ? 'storage' : null;
        if (domain === 'familyExists') corrupted.familyExists = !corrupted.familyExists;
        if (domain === 'familyVersion')
          corrupted.familyVersion = (corrupted.familyVersion ?? 0) + 1;
        if (domain === 'criticalAudits') corrupted.criticalAudits = corrupted.criticalAudits + 1;
        if (domain === 'postDrainAudits') corrupted.postDrainAudits = corrupted.postDrainAudits + 1;
        if (domain === 'valid')
          corrupted.valid = corrupted.valid === null ? true : !corrupted.valid;
        if (domain === 'revoked')
          corrupted.revoked = corrupted.revoked === null ? true : !corrupted.revoked;
        expect(corrupted, `${entry.id} domain ${domain}`).not.toEqual(expected);
      }
    }
  });
});
