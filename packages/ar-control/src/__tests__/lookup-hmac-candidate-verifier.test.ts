import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  LOOKUP_HMAC_VERIFICATION_BINDINGS,
  LookupHmacCandidateVerifier,
  lookupHmacVerificationErrorCode,
  type DistributingLookupHmacRotation,
  type LookupHmacCandidateEvidence,
  type LookupHmacCandidateVerificationRepository,
} from '../lookup-hmac-candidate-verifier';
import type { ControlEnv, RuntimeSmokeServiceBinding } from '../types';

let smokePrivate: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  smokePrivate = { ...(await exportJWK(pair.privateKey)), kid: 'smoke-v1', alg: 'EdDSA' };
});

const rotation: DistributingLookupHmacRotation = {
  environmentId: 'test',
  operationId: 'hmac-rotation-1',
  current: {
    generation: 1,
    keyId: 'lookup-v1',
    slot: 'A',
    fingerprint: 'a'.repeat(64),
  },
  candidate: {
    generation: 2,
    keyId: 'lookup-v2',
    slot: 'B',
    fingerprint: 'b'.repeat(64),
  },
};

function repository(
  distributing: DistributingLookupHmacRotation[] = [rotation],
  awaitingGeneration: DistributingLookupHmacRotation[] = []
) {
  const evidence: LookupHmacCandidateEvidence[] = [];
  const value: LookupHmacCandidateVerificationRepository = {
    listDistributing: vi.fn(async () => distributing),
    listAwaitingGeneration: vi.fn(async () => awaitingGeneration),
    record: vi.fn(async (entry: LookupHmacCandidateEvidence) => {
      evidence.push(entry);
    }),
  };
  return { value, evidence };
}

function env(mismatchedComponent?: string, rejectBind = false): ControlEnv {
  const value: ControlEnv = {
    CONTROL_DB: {} as D1Database,
    MIGRATION_RELEASES: {} as ControlEnv['MIGRATION_RELEASES'],
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_D1_API_TOKEN: 'd1-token',
    CLOUDFLARE_WORKERS_API_TOKEN: 'workers-token',
    SMOKE_RPC_SIGNING_JWK_SLOT_A: JSON.stringify(smokePrivate),
    SMOKE_RPC_SIGNING_ACTIVE_SLOT: 'A',
    SMOKE_RPC_SIGNING_ACTIVE_KID: 'smoke-v1',
  };
  for (const [component, bindingName] of Object.entries(LOOKUP_HMAC_VERIFICATION_BINDINGS)) {
    const verifyLookupHmacCandidate = vi.fn(async (input: unknown) => {
      const request = input as {
        operationId: string;
        current: DistributingLookupHmacRotation['current'];
        candidate: DistributingLookupHmacRotation['candidate'];
        testVector: string;
      };
      expect(request.testVector).toBe('authrim-control-lookup-hmac-v1');
      return {
        ok: true as const,
        purpose: 'lookup_hmac' as const,
        operationId: request.operationId,
        targetWorker: `test-${component}`,
        current: {
          ...request.current,
          digest: component === mismatchedComponent ? 'c'.repeat(64) : 'd'.repeat(64),
        },
        candidate: { ...request.candidate, digest: 'e'.repeat(64) },
        verifiedAt: 1_800_000_000,
      };
    });
    if (rejectBind) {
      Object.defineProperty(verifyLookupHmacCandidate, 'bind', {
        value: () => {
          throw new Error('rpc_proxy_bind_not_supported');
        },
      });
    }
    const binding = {
      smokeTenantBinding: vi.fn(),
      verifyLookupHmacCandidate,
      observeLookupHmacGeneration: vi.fn(async (input: unknown) => {
        const request = input as {
          operationId: string;
          current: DistributingLookupHmacRotation['candidate'];
          previous: DistributingLookupHmacRotation['current'];
        };
        return {
          ok: true as const,
          purpose: 'lookup_hmac_generation' as const,
          operationId: request.operationId,
          targetWorker: `test-${component}`,
          stateRevision: 2,
          current: request.current,
          previous: request.previous,
          observedAt: 1_800_000_000,
        };
      }),
    } satisfies RuntimeSmokeServiceBinding;
    Object.assign(value, { [bindingName]: binding });
  }
  return value;
}

describe('LookupHmacCandidateVerifier', () => {
  it('extracts only allowlisted codes from wrapped RPC failures', () => {
    expect(
      lookupHmacVerificationErrorCode(
        new Error('The RPC receiver threw: Error: runtime_lookup_hmac_verification_key_mismatch')
      )
    ).toBe('runtime_lookup_hmac_verification_key_mismatch');
    expect(
      lookupHmacVerificationErrorCode(
        new Error('rpc_failed', {
          cause: new Error('control_lookup_hmac_candidate_service_missing'),
        })
      )
    ).toBe('control_lookup_hmac_candidate_service_missing');
    expect(lookupHmacVerificationErrorCode(new Error('secret=do-not-record'))).toBe(
      'control_lookup_hmac_candidate_verification_failed'
    );
  });

  it('records consistent non-secret evidence for every Lookup HMAC consumer', async () => {
    const state = repository();
    const result = await new LookupHmacCandidateVerifier(
      state.value,
      env(),
      () => 1_800_000_000
    ).reconcile();

    expect(result).toEqual({ attempted: 5, succeeded: 5, failed: 0 });
    expect(state.evidence).toHaveLength(5);
    expect(state.evidence.every((entry) => entry.status === 'succeeded')).toBe(true);
    expect(JSON.stringify(state.evidence)).not.toContain(smokePrivate.d);
  });

  it('invokes RPC proxy methods directly without Function.bind', async () => {
    const state = repository();
    const result = await new LookupHmacCandidateVerifier(
      state.value,
      env(undefined, true),
      () => 1_800_000_000
    ).reconcile();

    expect(result).toEqual({ attempted: 5, succeeded: 5, failed: 0 });
  });

  it('fails only the divergent target and records a redacted code', async () => {
    const state = repository();
    const result = await new LookupHmacCandidateVerifier(
      state.value,
      env('ar-token'),
      () => 1_800_000_000
    ).reconcile();

    expect(result).toEqual({ attempted: 5, succeeded: 4, failed: 1 });
    expect(state.evidence).toContainEqual(
      expect.objectContaining({
        workerScriptName: 'test-ar-token',
        status: 'failed',
        errorCode: 'control_lookup_hmac_candidate_digest_mismatch',
        currentDigest: null,
        candidateDigest: null,
      })
    );
  });

  it('records active-generation observation only after each target resolves the signed state', async () => {
    const state = repository([], [rotation]);
    const result = await new LookupHmacCandidateVerifier(
      state.value,
      env(),
      () => 1_800_000_000
    ).reconcile();

    expect(result).toEqual({ attempted: 5, succeeded: 5, failed: 0 });
    expect(state.evidence).toHaveLength(5);
    expect(state.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'generation',
          status: 'succeeded',
          observedStateRevision: 2,
          currentDigest: null,
          candidateDigest: null,
        }),
      ])
    );
  });
});
