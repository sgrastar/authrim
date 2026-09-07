/**
 * Matrix R-B: registry and binding resolution through the production
 * `resolveTenantDatabaseSourceFromRegistry` over signed runtime-registry snapshots.
 *
 * BOTH tenants (alpha/beta) are exercised across registry-tenant, owner, snapshot,
 * binding, provider, and cache states. After a successful resolution the selected
 * DatabaseSource receives a minimal real query so the actual binding operation is
 * observed in the ledger. Required groups 2 (host tenant × registry tenant × binding
 * owner) and 4 (allocation scope × owner tenant × data role) are covered; the
 * independent checker verifies 100% coverage.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { decideRoutingRb } from './cases';
import {
  checkRbObservation,
  corruptRbObservationDomain,
  RB_OBSERVATION_DOMAINS,
} from './observation';
import {
  RB_CASE_TABLE,
  rbBeforeEach,
  rbAfterEach,
  seedRbRow,
  buildRbObservation,
  expectedRbObservation,
  assertRbObservation,
  rbMutationCandidate,
  rbSecurityEventWritten,
  rbSecretLeakScan,
} from './rb-harness';

const FROZEN_NOW = 1700000000;

describe('runtime-topology Matrix R-B: registry and binding resolution', () => {
  beforeEach(() => {
    rbBeforeEach(FROZEN_NOW);
  });

  afterEach(() => {
    rbAfterEach();
  });

  for (const entry of RB_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const seeded = await seedRbRow(entry);
      const cacheHit = String(entry.dimensions.cacheState) === 'warm';
      const result = await seeded.run();
      const securityEventWritten = rbSecurityEventWritten(seeded.kit.ledger);
      const observation = await buildRbObservation(
        entry,
        result,
        cacheHit,
        securityEventWritten,
        seeded.kit.ledger
      );
      observation.secretLeak = rbSecretLeakScan(
        seeded.kit.ledger,
        result,
        seeded.secrets,
        seeded.requestCache
      );
      observation.foreignTenantAccess = observation.tenantAccessSet.some(
        (tenant) => tenant !== String(entry.dimensions.tenantHost)
      );
      if (observation.outcome === 'error' && observation.errorCode !== 'binding_access_threw') {
        // No partial cache population when resolution itself failed. A binding-access
        // failure happens after a legitimate successful resolution, so its request cache
        // entry is expected.
        expect(seeded.requestCache.size, 'request cache must stay empty on failure').toBe(0);
      }
      const expected = expectedRbObservation(entry, decideRoutingRb(entry.dimensions as never));
      assertRbObservation(observation, expected);
    });
  }

  it('oracle sensitivity: corrupted real R-B observations are rejected per domain', async () => {
    expect.hasAssertions();
    const representatives = RB_CASE_TABLE.filter((entry) => {
      const decision = decideRoutingRb(entry.dimensions as never);
      if (decision.outcome === 'resolved') return true;
      if (decision.rejectionLayer === 'signature') return true;
      if (decision.rejectionLayer === 'route') return true;
      if (decision.rejectionLayer === 'expiry') return true;
      if (decision.rejectionLayer === 'generation') return true;
      if (decision.rejectionLayer === 'snapshot') return true;
      if (decision.rejectionLayer === 'binding') return true;
      if (decision.rejectionLayer === 'binding-access') return true;
      return false;
    });
    expect(representatives.length).toBeGreaterThanOrEqual(6);
    for (const entry of representatives.slice(0, 10)) {
      const seeded = await seedRbRow(entry);
      const result = await seeded.run();
      const securityEventWritten = rbSecurityEventWritten(seeded.kit.ledger);
      const observation = await buildRbObservation(
        entry,
        result,
        false,
        securityEventWritten,
        seeded.kit.ledger
      );
      observation.secretLeak = rbSecretLeakScan(
        seeded.kit.ledger,
        result,
        seeded.secrets,
        seeded.requestCache
      );
      observation.foreignTenantAccess = observation.tenantAccessSet.some(
        (tenant) => tenant !== String(entry.dimensions.tenantHost)
      );
      const expected = expectedRbObservation(entry, decideRoutingRb(entry.dimensions as never));
      const mismatches = checkRbObservation(observation, expected);
      expect(
        mismatches,
        `real observation of ${entry.id} mismatches: ${mismatches.join(', ')}`
      ).toEqual([]);
      for (const domain of RB_OBSERVATION_DOMAINS) {
        const corrupted = corruptRbObservationDomain(expected, domain);
        expect(
          checkRbObservation(corrupted, expected).length,
          `domain ${domain} on ${entry.id}`
        ).toBeGreaterThan(0);
      }
    }
  });

  it('every R-B case carries a discriminating mutation witness', () => {
    expect.hasAssertions();
    for (const entry of RB_CASE_TABLE) {
      const base = decideRoutingRb(entry.dimensions as never);
      const baseSignature = JSON.stringify(base);
      expect(entry.mutationIds.length, `${entry.id} needs mutation witnesses`).toBeGreaterThan(0);
      for (const mutationId of entry.mutationIds) {
        const mutant = rbMutationCandidate(entry, mutationId);
        expect(JSON.stringify(mutant), `${entry.id} mutation ${mutationId}`).not.toBe(
          baseSignature
        );
      }
    }
  });
});
