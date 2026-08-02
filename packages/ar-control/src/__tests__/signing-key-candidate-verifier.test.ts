import { decodeProtectedHeader, exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SIGNING_KEY_VERIFICATION_TARGETS,
  SigningKeyCandidateVerifier,
  type SigningKeyVerificationEvidence,
  type SigningKeyVerificationRepository,
  type StagedSigningKeyRow,
} from '../signing-key-candidate-verifier';
import type { ControlEnv, RuntimeSmokeServiceBinding } from '../types';

let smokePrivate: JWK;
let registryPrivate: JWK;

beforeAll(async () => {
  const smoke = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const registry = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  smokePrivate = { ...(await exportJWK(smoke.privateKey)), kid: 'smoke-v2', alg: 'EdDSA' };
  registryPrivate = {
    ...(await exportJWK(registry.privateKey)),
    kid: 'registry-v2',
    alg: 'EdDSA',
  };
});

const BINDINGS = {
  'ar-lib-core': 'SMOKE_AR_LIB_CORE',
  'ar-discovery': 'SMOKE_AR_DISCOVERY',
  'ar-auth': 'SMOKE_AR_AUTH',
  'ar-token': 'SMOKE_AR_TOKEN',
  'ar-userinfo': 'SMOKE_AR_USERINFO',
  'ar-management': 'SMOKE_AR_MANAGEMENT',
  'ar-agent-access': 'SMOKE_AR_AGENT_ACCESS',
  'ar-async': 'SMOKE_AR_ASYNC',
  'ar-policy': 'SMOKE_AR_POLICY',
  'ar-saml': 'SMOKE_AR_SAML',
  'ar-bridge': 'SMOKE_AR_BRIDGE',
  'ar-vc': 'SMOKE_AR_VC',
  'ar-plugin-runner': 'SMOKE_AR_PLUGIN_RUNNER',
} as const;

function repository(staged: StagedSigningKeyRow[]) {
  const evidence: SigningKeyVerificationEvidence[] = [];
  const value: SigningKeyVerificationRepository = {
    listStaged: vi.fn(async () => staged),
    record: vi.fn(async (entry: SigningKeyVerificationEvidence) => {
      evidence.push(entry);
    }),
  };
  return { value, evidence };
}

function controlEnv(failingComponent?: string): ControlEnv {
  const env: ControlEnv = {
    CONTROL_DB: {} as D1Database,
    MIGRATION_RELEASES: {} as ControlEnv['MIGRATION_RELEASES'],
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_D1_API_TOKEN: 'd1-token',
    CLOUDFLARE_WORKERS_API_TOKEN: 'workers-token',
    SMOKE_RPC_SIGNING_JWK_SLOT_B: JSON.stringify(smokePrivate),
    RUNTIME_REGISTRY_SIGNING_JWK_SLOT_B: JSON.stringify(registryPrivate),
  };
  for (const [component, bindingName] of Object.entries(BINDINGS)) {
    if (component === failingComponent) continue;
    const targetWorker = `test-${component}`;
    const binding = {
      smokeTenantBinding: vi.fn(),
      verifyControlKeyCandidate: vi.fn(async (input: unknown) => {
        const record = input as { purpose: 'smoke_rpc' | 'runtime_registry'; token: string };
        return {
          purpose: record.purpose,
          keyId: decodeProtectedHeader(record.token).kid as string,
          targetWorker,
          verifiedAt: 1_800_000_000,
        };
      }),
    } satisfies RuntimeSmokeServiceBinding;
    Object.assign(env, { [bindingName]: binding });
  }
  return env;
}

describe('SigningKeyCandidateVerifier', () => {
  it('verifies every smoke RPC target and records only public evidence', async () => {
    const staged: StagedSigningKeyRow = {
      environmentId: 'test',
      purpose: 'smoke_rpc',
      slot: 'B',
      keyId: 'smoke-v2',
    };
    const state = repository([staged]);
    const result = await new SigningKeyCandidateVerifier(
      state.value,
      controlEnv(),
      () => 1_800_000_000
    ).reconcile();

    expect(result).toEqual({
      attempted: SIGNING_KEY_VERIFICATION_TARGETS.smokeRpc.length,
      succeeded: SIGNING_KEY_VERIFICATION_TARGETS.smokeRpc.length,
      failed: 0,
    });
    expect(state.evidence).toHaveLength(SIGNING_KEY_VERIFICATION_TARGETS.smokeRpc.length);
    expect(state.evidence.every((entry) => entry.status === 'succeeded')).toBe(true);
    expect(JSON.stringify(state.evidence)).not.toContain(smokePrivate.d);
  });

  it('uses the narrower Runtime Registry target set and the candidate registry slot', async () => {
    const state = repository([
      {
        environmentId: 'test',
        purpose: 'runtime_registry',
        slot: 'B',
        keyId: 'registry-v2',
      },
    ]);
    const result = await new SigningKeyCandidateVerifier(
      state.value,
      controlEnv(),
      () => 1_800_000_000
    ).reconcile();

    expect(result).toEqual({
      attempted: SIGNING_KEY_VERIFICATION_TARGETS.runtimeRegistry.length,
      succeeded: SIGNING_KEY_VERIFICATION_TARGETS.runtimeRegistry.length,
      failed: 0,
    });
    expect(SIGNING_KEY_VERIFICATION_TARGETS.runtimeRegistry).not.toContain('ar-agent-access');
    expect(SIGNING_KEY_VERIFICATION_TARGETS.runtimeRegistry).not.toContain('ar-async');
    expect(SIGNING_KEY_VERIFICATION_TARGETS.runtimeRegistry).not.toContain('ar-policy');
  });

  it('records a redacted failure and keeps the candidate staged for retry', async () => {
    const state = repository([
      {
        environmentId: 'test',
        purpose: 'smoke_rpc',
        slot: 'B',
        keyId: 'smoke-v2',
      },
    ]);
    const result = await new SigningKeyCandidateVerifier(
      state.value,
      controlEnv('ar-token'),
      () => 1_800_000_000
    ).reconcile();

    expect(result.failed).toBe(1);
    expect(state.evidence).toContainEqual(
      expect.objectContaining({
        workerScriptName: 'test-ar-token',
        status: 'failed',
        errorCode: 'control_signing_key_verification_service_missing',
        verifiedAt: null,
      })
    );
  });
});
