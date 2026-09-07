import { describe, expect, it } from 'vitest';
import fixture from './fixtures/phase8-dr-rehearsal.json';

const requiredOrder = [
  'quarantine_shard',
  'publish_signed_deny_generation',
  'drain_runtime_snapshots',
  'restore_d1',
  'verify_migrations',
  'rebuild_lookup_projection',
  'verify_runtime_binding',
  'reactivate_route',
];

describe('Phase 8 disaster-recovery rehearsal contract', () => {
  it('keeps D1 restore manual and routing quarantined through every verification gate', () => {
    expect(fixture.recoveryMode).toBe('manual_cloudflare_time_travel');
    expect(fixture.automaticRestoreRpc).toBe(false);
    expect(fixture.steps.map((step) => step.id)).toEqual(requiredOrder);

    const restore = fixture.steps.find((step) => step.id === 'restore_d1');
    expect(restore).toMatchObject({
      actor: 'cloudflare_operator',
      manualConfirmationRequired: true,
    });

    const drain = fixture.steps.find((step) => step.id === 'drain_runtime_snapshots');
    expect(drain).toMatchObject({ minimumSeconds: 1800 });
    expect(requiredOrder.indexOf('restore_d1')).toBeGreaterThan(
      requiredOrder.indexOf('drain_runtime_snapshots')
    );
    expect(requiredOrder.indexOf('reactivate_route')).toBeGreaterThan(
      requiredOrder.indexOf('verify_migrations')
    );
    expect(requiredOrder.indexOf('reactivate_route')).toBeGreaterThan(
      requiredOrder.indexOf('rebuild_lookup_projection')
    );
    expect(requiredOrder.indexOf('reactivate_route')).toBeGreaterThan(
      requiredOrder.indexOf('verify_runtime_binding')
    );
  });

  it('requires fail-closed, integrity, and same-generation evidence before reactivation', () => {
    const proofs = new Set(fixture.steps.flatMap((step) => step.proofs));
    for (const requiredProof of [
      'allocation_blocked',
      'activation_blocked',
      'route_resurrection_blocked',
      'registry_signature_verified',
      'latest_generation_observed',
      'manifest_checksum_verified',
      'authoritative_source_used',
      'reference_integrity_verified',
      'binding_identity_verified',
      'runtime_smoke_verified',
      'same_generation_verified',
    ]) {
      expect(proofs, requiredProof).toContain(requiredProof);
    }
  });

  it('records operator-safe evidence without secrets, provider bodies, PII, or SQL', () => {
    expect(fixture.auditEvidence).toEqual(
      expect.arrayContaining([
        'operation_id',
        'environment_id',
        'resource_id',
        'operator_id',
        'restore_bookmark_or_timestamp',
        'verification_result',
      ])
    );
    expect(fixture.prohibitedEvidence).toEqual(
      expect.arrayContaining([
        'api_token',
        'authorization_header',
        'raw_provider_response',
        'raw_email',
        'sql_text',
      ])
    );
  });
});
