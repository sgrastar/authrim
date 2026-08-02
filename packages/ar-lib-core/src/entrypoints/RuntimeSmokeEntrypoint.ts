import { WorkerEntrypoint } from 'cloudflare:workers';
import { decodeProtectedHeader } from 'jose';
import {
  inspectRuntimeSmokeBinding,
  verifyRuntimeSmokeRequest,
  type RuntimeSmokeResult,
  type RuntimeSmokeVersionMetadata,
} from '../services/control-plane/runtime-smoke-rpc.js';
import {
  loadTenantRuntimeRegistryVerificationKeysFromEnv,
  verifyRuntimeRegistrySnapshotPayloadJws,
} from '../services/tenant-runtime-registry-snapshot.js';
import {
  createLookupBlindIndex,
  fingerprintLookupHmacKey,
  loadVerifiedLookupHmacKeyState,
  resolveLookupHmacKeys,
} from '../services/lookup-directory/index.js';

const SAFE_ENVIRONMENT = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_WORKER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const EXPOSED_ERROR = /^runtime_smoke_[a-z0-9_]+$/u;
const EXPOSED_KEY_VERIFICATION_ERROR = /^runtime_key_verification_[a-z0-9_]+$/u;
const SAFE_KEY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const MAX_TEST_PAYLOAD_BYTES = 1024;
const LOOKUP_HMAC_TEST_VECTOR = 'authrim-control-lookup-hmac-v1';
const LOOKUP_HMAC_TEST_BINDING = 'TDB_LOOKUP_HMAC_TEST';
const HEX_DIGEST = /^[a-f0-9]{64}$/u;

export interface RuntimeSmokeEntrypointEnv {
  AUTHRIM_ENVIRONMENT_NAME?: string;
  AUTHRIM_WORKER_SCRIPT_NAME?: string;
  CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS?: string;
  TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS?: string;
  TENANT_RUNTIME_REGISTRY?: {
    get(key: string): Promise<string | null>;
  };
  LOOKUP_HMAC_KEY_SLOT_A?: string;
  LOOKUP_HMAC_KEY_SLOT_B?: string;
  CONTROL_SMOKE_VERSION?: RuntimeSmokeVersionMetadata;
  [binding: string]: unknown;
}

export interface RuntimeControlKeyVerificationResult {
  purpose: 'smoke_rpc' | 'runtime_registry';
  keyId: string;
  targetWorker: string;
  verifiedAt: number;
}

export interface RuntimeLookupHmacKeyMetadata {
  generation: number;
  keyId: string;
  slot: 'A' | 'B';
  fingerprint: string;
}

export interface RuntimeLookupHmacCandidateVerificationSuccess {
  ok: true;
  purpose: 'lookup_hmac';
  operationId: string;
  targetWorker: string;
  current: RuntimeLookupHmacKeyMetadata & { digest: string };
  candidate: RuntimeLookupHmacKeyMetadata & { digest: string };
  verifiedAt: number;
}

export interface RuntimeLookupHmacVerificationFailure {
  ok: false;
  errorCode: string;
}

export type RuntimeLookupHmacCandidateVerificationResult =
  | RuntimeLookupHmacCandidateVerificationSuccess
  | RuntimeLookupHmacVerificationFailure;

export interface RuntimeLookupHmacGenerationObservationSuccess {
  ok: true;
  purpose: 'lookup_hmac_generation';
  operationId: string;
  targetWorker: string;
  stateRevision: number;
  current: RuntimeLookupHmacKeyMetadata;
  previous: RuntimeLookupHmacKeyMetadata;
  observedAt: number;
}

export type RuntimeLookupHmacGenerationObservationResult =
  | RuntimeLookupHmacGenerationObservationSuccess
  | RuntimeLookupHmacVerificationFailure;

export interface RuntimeSmokeEntrypointProps {
  caller: 'ar-control';
  audience: 'authrim-runtime-smoke-v1';
  environmentId: string;
  targetWorker: string;
}

function authorizedIdentity(
  env: RuntimeSmokeEntrypointEnv,
  props: RuntimeSmokeEntrypointProps
): { environmentId: string; targetWorker: string } {
  if (
    props?.caller !== 'ar-control' ||
    props.audience !== 'authrim-runtime-smoke-v1' ||
    typeof props.environmentId !== 'string' ||
    !SAFE_ENVIRONMENT.test(props.environmentId) ||
    typeof props.targetWorker !== 'string' ||
    !SAFE_WORKER.test(props.targetWorker) ||
    env.AUTHRIM_ENVIRONMENT_NAME !== props.environmentId ||
    env.AUTHRIM_WORKER_SCRIPT_NAME !== props.targetWorker
  ) {
    throw new Error('runtime_smoke_caller_unauthorized');
  }
  return {
    environmentId: props.environmentId,
    targetWorker: props.targetWorker,
  };
}

function exactRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('runtime_key_verification_input_invalid');
  }
  return input as Record<string, unknown>;
}

function protectedKeyId(token: string): string {
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new Error('runtime_key_verification_header_invalid');
  }
  if (typeof header.kid !== 'string' || !SAFE_KEY_ID.test(header.kid)) {
    throw new Error('runtime_key_verification_header_invalid');
  }
  return header.kid;
}

function lookupHmacMetadata(value: unknown): RuntimeLookupHmacKeyMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('runtime_lookup_hmac_verification_input_invalid');
  }
  const metadata = value as Record<string, unknown>;
  if (
    Object.keys(metadata).sort().join(',') !== 'fingerprint,generation,keyId,slot' ||
    !Number.isSafeInteger(metadata.generation) ||
    (metadata.generation as number) < 1 ||
    typeof metadata.keyId !== 'string' ||
    !SAFE_KEY_ID.test(metadata.keyId) ||
    (metadata.slot !== 'A' && metadata.slot !== 'B') ||
    typeof metadata.fingerprint !== 'string' ||
    !HEX_DIGEST.test(metadata.fingerprint)
  ) {
    throw new Error('runtime_lookup_hmac_verification_input_invalid');
  }
  return metadata as unknown as RuntimeLookupHmacKeyMetadata;
}

export class RuntimeSmokeEntrypoint extends WorkerEntrypoint<
  RuntimeSmokeEntrypointEnv,
  RuntimeSmokeEntrypointProps
> {
  fetch(): Response {
    return new Response('Not Found', {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  async smokeTenantBinding(token: unknown): Promise<RuntimeSmokeResult> {
    try {
      const context = authorizedIdentity(this.env, this.ctx.props);
      const publicJwks = this.env.CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS;
      if (typeof publicJwks !== 'string' || publicJwks.length === 0) {
        throw new Error('runtime_smoke_caller_unauthorized');
      }
      const claims = await verifyRuntimeSmokeRequest(token, { ...context, publicJwks });
      return inspectRuntimeSmokeBinding({
        claims,
        binding: this.env[claims.bindingRef],
        versionMetadata: this.env.CONTROL_SMOKE_VERSION,
      });
    } catch (error) {
      if (error instanceof Error && EXPOSED_ERROR.test(error.message)) {
        throw new Error(error.message);
      }
      throw new Error('runtime_smoke_internal_error');
    }
  }

  async verifyControlKeyCandidate(input: unknown): Promise<RuntimeControlKeyVerificationResult> {
    try {
      const context = authorizedIdentity(this.env, this.ctx.props);
      const record = exactRecord(input);
      if (record.purpose === 'smoke_rpc') {
        if (
          Object.keys(record).sort().join(',') !== 'purpose,token' ||
          typeof record.token !== 'string'
        ) {
          throw new Error('runtime_key_verification_input_invalid');
        }
        const publicJwks = this.env.CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS;
        if (typeof publicJwks !== 'string' || publicJwks.length === 0) {
          throw new Error('runtime_key_verification_smoke_keys_unavailable');
        }
        await verifyRuntimeSmokeRequest(record.token, { ...context, publicJwks });
        return {
          purpose: 'smoke_rpc',
          keyId: protectedKeyId(record.token),
          targetWorker: context.targetWorker,
          verifiedAt: Math.floor(Date.now() / 1000),
        };
      }
      if (record.purpose === 'runtime_registry') {
        if (
          Object.keys(record).sort().join(',') !== 'keyId,payload,purpose,token' ||
          typeof record.token !== 'string' ||
          typeof record.keyId !== 'string' ||
          !SAFE_KEY_ID.test(record.keyId) ||
          !(record.payload instanceof Uint8Array) ||
          record.payload.byteLength < 1 ||
          record.payload.byteLength > MAX_TEST_PAYLOAD_BYTES
        ) {
          throw new Error('runtime_key_verification_input_invalid');
        }
        const keys = loadTenantRuntimeRegistryVerificationKeysFromEnv(this.env);
        if (keys.length === 0) {
          throw new Error('runtime_key_verification_registry_keys_unavailable');
        }
        const verified = await verifyRuntimeRegistrySnapshotPayloadJws({
          token: record.token,
          payload: record.payload,
          keys,
          expectedKeyId: record.keyId,
        });
        if (!verified || protectedKeyId(record.token) !== record.keyId) {
          throw new Error('runtime_key_verification_registry_signature_invalid');
        }
        return {
          purpose: 'runtime_registry',
          keyId: record.keyId,
          targetWorker: context.targetWorker,
          verifiedAt: Math.floor(Date.now() / 1000),
        };
      }
      throw new Error('runtime_key_verification_purpose_invalid');
    } catch (error) {
      if (
        error instanceof Error &&
        (EXPOSED_KEY_VERIFICATION_ERROR.test(error.message) ||
          EXPOSED_ERROR.test(error.message) ||
          error.message.startsWith('runtime_registry_snapshot_verification_'))
      ) {
        throw new Error(error.message);
      }
      throw new Error('runtime_key_verification_internal_error');
    }
  }

  async verifyLookupHmacCandidate(
    input: unknown
  ): Promise<RuntimeLookupHmacCandidateVerificationResult> {
    try {
      const context = authorizedIdentity(this.env, this.ctx.props);
      const record = exactRecord(input);
      if (
        Object.keys(record).sort().join(',') !==
          'candidate,current,operationId,purpose,testVector,token' ||
        record.purpose !== 'lookup_hmac' ||
        typeof record.operationId !== 'string' ||
        !SAFE_KEY_ID.test(record.operationId) ||
        record.testVector !== LOOKUP_HMAC_TEST_VECTOR ||
        typeof record.token !== 'string'
      ) {
        throw new Error('runtime_lookup_hmac_verification_input_invalid');
      }
      const publicJwks = this.env.CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS;
      if (typeof publicJwks !== 'string' || publicJwks.length === 0) {
        throw new Error('runtime_lookup_hmac_verification_smoke_keys_unavailable');
      }
      const claims = await verifyRuntimeSmokeRequest(record.token, { ...context, publicJwks });
      if (
        claims.operationId !== record.operationId ||
        claims.bindingRef !== LOOKUP_HMAC_TEST_BINDING ||
        claims.dataRole !== 'tenant_core/default' ||
        claims.residencyPartition !== 'default' ||
        claims.expectedMigrationGeneration !== 1
      ) {
        throw new Error('runtime_lookup_hmac_verification_token_mismatch');
      }
      const current = lookupHmacMetadata(record.current);
      const candidate = lookupHmacMetadata(record.candidate);
      if (
        current.generation >= candidate.generation ||
        current.slot === candidate.slot ||
        current.keyId === candidate.keyId
      ) {
        throw new Error('runtime_lookup_hmac_verification_metadata_invalid');
      }
      const verify = async (metadata: RuntimeLookupHmacKeyMetadata) => {
        const secret =
          metadata.slot === 'A' ? this.env.LOOKUP_HMAC_KEY_SLOT_A : this.env.LOOKUP_HMAC_KEY_SLOT_B;
        if (
          typeof secret !== 'string' ||
          (await fingerprintLookupHmacKey(secret)) !== metadata.fingerprint
        ) {
          throw new Error('runtime_lookup_hmac_verification_key_mismatch');
        }
        const index = await createLookupBlindIndex('account_id', LOOKUP_HMAC_TEST_VECTOR, {
          generation: metadata.generation,
          secret,
        });
        return { ...metadata, digest: index.digest };
      };
      const [currentResult, candidateResult] = await Promise.all([
        verify(current),
        verify(candidate),
      ]);
      return {
        ok: true,
        purpose: 'lookup_hmac',
        operationId: record.operationId,
        targetWorker: context.targetWorker,
        current: currentResult,
        candidate: candidateResult,
        verifiedAt: Math.floor(Date.now() / 1000),
      };
    } catch (error) {
      const errorCode =
        error instanceof Error &&
        (error.message.startsWith('runtime_lookup_hmac_verification_') ||
          EXPOSED_ERROR.test(error.message))
          ? error.message
          : 'runtime_lookup_hmac_verification_internal_error';
      return { ok: false, errorCode };
    }
  }

  async observeLookupHmacGeneration(
    input: unknown
  ): Promise<RuntimeLookupHmacGenerationObservationResult> {
    try {
      const context = authorizedIdentity(this.env, this.ctx.props);
      const record = exactRecord(input);
      if (
        Object.keys(record).sort().join(',') !== 'current,operationId,previous,purpose,token' ||
        record.purpose !== 'lookup_hmac_generation' ||
        typeof record.operationId !== 'string' ||
        !SAFE_KEY_ID.test(record.operationId) ||
        typeof record.token !== 'string'
      ) {
        throw new Error('runtime_lookup_hmac_generation_input_invalid');
      }
      const publicJwks = this.env.CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS;
      if (typeof publicJwks !== 'string' || publicJwks.length === 0) {
        throw new Error('runtime_lookup_hmac_generation_smoke_keys_unavailable');
      }
      const claims = await verifyRuntimeSmokeRequest(record.token, { ...context, publicJwks });
      if (
        claims.operationId !== record.operationId ||
        claims.bindingRef !== LOOKUP_HMAC_TEST_BINDING ||
        claims.dataRole !== 'tenant_core/default' ||
        claims.residencyPartition !== 'default' ||
        claims.expectedMigrationGeneration !== 1
      ) {
        throw new Error('runtime_lookup_hmac_generation_token_mismatch');
      }
      const current = lookupHmacMetadata(record.current);
      const previous = lookupHmacMetadata(record.previous);
      if (current.generation !== previous.generation + 1 || current.slot === previous.slot) {
        throw new Error('runtime_lookup_hmac_generation_metadata_invalid');
      }
      const store = this.env.TENANT_RUNTIME_REGISTRY;
      const registryJwks = this.env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS;
      if (!store || typeof store.get !== 'function' || typeof registryJwks !== 'string') {
        throw new Error('runtime_lookup_hmac_generation_state_unavailable');
      }
      const state = await loadVerifiedLookupHmacKeyState({
        store,
        environmentId: context.environmentId,
        publicJwks: registryJwks,
      });
      if (
        state.rotationState !== 'activation_dual_write' ||
        state.writeMode !== 'dual_write' ||
        state.current.generation !== current.generation ||
        state.current.keyId !== current.keyId ||
        state.current.slot !== current.slot ||
        state.current.fingerprint !== current.fingerprint ||
        !state.previous ||
        state.previous.generation !== previous.generation ||
        state.previous.keyId !== previous.keyId ||
        state.previous.slot !== previous.slot ||
        state.previous.fingerprint !== previous.fingerprint
      ) {
        throw new Error('runtime_lookup_hmac_generation_state_mismatch');
      }
      await resolveLookupHmacKeys({
        state,
        slotA: this.env.LOOKUP_HMAC_KEY_SLOT_A,
        slotB: this.env.LOOKUP_HMAC_KEY_SLOT_B,
      });
      return {
        ok: true,
        purpose: 'lookup_hmac_generation',
        operationId: record.operationId,
        targetWorker: context.targetWorker,
        stateRevision: state.generation,
        current,
        previous,
        observedAt: Math.floor(Date.now() / 1000),
      };
    } catch (error) {
      const errorCode =
        error instanceof Error &&
        (error.message.startsWith('runtime_lookup_hmac_generation_') ||
          error.message.startsWith('lookup_hmac_key_state_') ||
          EXPOSED_ERROR.test(error.message))
          ? error.message
          : 'runtime_lookup_hmac_generation_internal_error';
      return { ok: false, errorCode };
    }
  }
}

export const RUNTIME_LOOKUP_HMAC_TEST_VECTOR = LOOKUP_HMAC_TEST_VECTOR;
