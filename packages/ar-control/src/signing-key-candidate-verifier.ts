import { signRuntimeRegistrySnapshotPayloadJws } from '@authrim/ar-lib-core';
import { getTenantDatabaseBindingPrefix } from '@authrim/ar-lib-core/services/tenant-database-naming';
import { runtimeRegistryPrivateJwkForSlot } from './lookup-registry-publisher';
import { signControlRuntimeSmokeRequestWithKey } from './runtime-smoke-signer';
import type { ControlEnv, RuntimeSmokeServiceBinding } from './types';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_WORKER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SAFE_ERROR = /^(?:runtime|control|lookup)_[a-z0-9_]{1,119}$/u;

function keyRotationTestBinding(environmentId: string): string {
  return `${getTenantDatabaseBindingPrefix(environmentId)}_KEY_ROTATION_TEST`;
}
type RuntimeRegistryPrivateJwk = Exclude<
  Parameters<typeof signRuntimeRegistrySnapshotPayloadJws>[0]['privateJwk'],
  string
>;

export type SigningKeyVerificationPurpose = 'runtime_registry' | 'smoke_rpc';

export interface StagedSigningKeyRow {
  environmentId: string;
  purpose: SigningKeyVerificationPurpose;
  slot: 'A' | 'B';
  keyId: string;
}

export interface SigningKeyVerificationEvidence {
  staged: StagedSigningKeyRow;
  workerScriptName: string;
  status: 'succeeded' | 'failed';
  errorCode: string | null;
  verifiedAt: number | null;
}

export interface SigningKeyVerificationRepository {
  listStaged(): Promise<StagedSigningKeyRow[]>;
  record(evidence: SigningKeyVerificationEvidence, now: number): Promise<void>;
}

export interface SigningKeyCandidateVerificationSummary {
  attempted: number;
  succeeded: number;
  failed: number;
}

const SERVICE_BINDINGS = {
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
} as const satisfies Readonly<Record<string, keyof ControlEnv>>;

const REGISTRY_COMPONENTS = new Set([
  'ar-lib-core',
  'ar-discovery',
  'ar-auth',
  'ar-token',
  'ar-userinfo',
  'ar-management',
  'ar-saml',
  'ar-bridge',
  'ar-vc',
  'ar-plugin-runner',
]);

function targets(purpose: SigningKeyVerificationPurpose) {
  return Object.entries(SERVICE_BINDINGS).filter(
    ([component]) => purpose === 'smoke_rpc' || REGISTRY_COMPONENTS.has(component)
  );
}

function validateStaged(row: StagedSigningKeyRow): void {
  if (
    !SAFE_ID.test(row.environmentId) ||
    (row.purpose !== 'runtime_registry' && row.purpose !== 'smoke_rpc') ||
    (row.slot !== 'A' && row.slot !== 'B') ||
    !SAFE_ID.test(row.keyId)
  ) {
    throw new Error('control_signing_key_verification_staged_state_invalid');
  }
}

type CandidateVerificationBinding = RuntimeSmokeServiceBinding & {
  verifyControlKeyCandidate: NonNullable<RuntimeSmokeServiceBinding['verifyControlKeyCandidate']>;
};

function service(env: ControlEnv, bindingName: keyof ControlEnv): CandidateVerificationBinding {
  const binding = env[bindingName] as RuntimeSmokeServiceBinding | undefined;
  if (!binding || typeof binding.verifyControlKeyCandidate !== 'function') {
    throw new Error('control_signing_key_verification_service_missing');
  }
  return binding as CandidateVerificationBinding;
}

function errorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return SAFE_ERROR.test(code) ? code : 'control_signing_key_candidate_verification_failed';
}

export class D1SigningKeyVerificationRepository implements SigningKeyVerificationRepository {
  constructor(private readonly db: D1Database) {}

  async listStaged(): Promise<StagedSigningKeyRow[]> {
    const result = await this.db
      .prepare(
        `SELECT environment_id, key_purpose, upper(slot) AS slot, key_id
           FROM control_signing_key_metadata
          WHERE state = 'staged'
          ORDER BY environment_id, key_purpose
          LIMIT 2`
      )
      .all<{
        environment_id: string;
        key_purpose: SigningKeyVerificationPurpose;
        slot: 'A' | 'B';
        key_id: string;
      }>();
    return result.results.map((row) => ({
      environmentId: row.environment_id,
      purpose: row.key_purpose,
      slot: row.slot,
      keyId: row.key_id,
    }));
  }

  async record(evidence: SigningKeyVerificationEvidence, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO control_signing_key_verifications (
           environment_id, key_purpose, key_id, slot, worker_script_name,
           status, attempt_count, last_error_code, verified_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(environment_id, key_purpose, key_id, worker_script_name)
         DO UPDATE SET
           slot = excluded.slot,
           status = excluded.status,
           attempt_count = control_signing_key_verifications.attempt_count + 1,
           last_error_code = excluded.last_error_code,
           verified_at = excluded.verified_at,
           updated_at = excluded.updated_at`
      )
      .bind(
        evidence.staged.environmentId,
        evidence.staged.purpose,
        evidence.staged.keyId,
        evidence.staged.slot.toLowerCase(),
        evidence.workerScriptName,
        evidence.status,
        evidence.errorCode,
        evidence.verifiedAt,
        now
      )
      .run();
  }
}

export class SigningKeyCandidateVerifier {
  constructor(
    private readonly repository: SigningKeyVerificationRepository,
    private readonly env: ControlEnv,
    private readonly now: () => number
  ) {}

  async reconcile(): Promise<SigningKeyCandidateVerificationSummary> {
    const stagedRows = await this.repository.listStaged();
    const summary: SigningKeyCandidateVerificationSummary = {
      attempted: 0,
      succeeded: 0,
      failed: 0,
    };
    for (const staged of stagedRows) {
      validateStaged(staged);
      for (const [component, bindingName] of targets(staged.purpose)) {
        summary.attempted += 1;
        const workerScriptName = `${staged.environmentId}-${component}`;
        if (!SAFE_WORKER.test(workerScriptName)) {
          throw new Error('control_signing_key_verification_target_invalid');
        }
        try {
          const result = await this.verifyTarget(
            staged,
            workerScriptName,
            service(this.env, bindingName)
          );
          if (
            result.purpose !== staged.purpose ||
            result.keyId !== staged.keyId ||
            result.targetWorker !== workerScriptName ||
            !Number.isSafeInteger(result.verifiedAt) ||
            result.verifiedAt < 1
          ) {
            throw new Error('control_signing_key_verification_result_mismatch');
          }
          await this.repository.record(
            {
              staged,
              workerScriptName,
              status: 'succeeded',
              errorCode: null,
              verifiedAt: result.verifiedAt,
            },
            this.now()
          );
          summary.succeeded += 1;
        } catch (error) {
          await this.repository.record(
            {
              staged,
              workerScriptName,
              status: 'failed',
              errorCode: errorCode(error),
              verifiedAt: null,
            },
            this.now()
          );
          summary.failed += 1;
        }
      }
    }
    return summary;
  }

  private async verifyTarget(
    staged: StagedSigningKeyRow,
    workerScriptName: string,
    binding: CandidateVerificationBinding
  ) {
    if (staged.purpose === 'smoke_rpc') {
      const token = await signControlRuntimeSmokeRequestWithKey({
        env: this.env,
        slot: staged.slot,
        keyId: staged.keyId,
        now: this.now(),
        request: {
          environmentId: staged.environmentId,
          operationId: `keyverify-${staged.slot.toLowerCase()}-${this.now()}`,
          attempt: 1,
          targetWorker: workerScriptName,
          bindingRef: keyRotationTestBinding(staged.environmentId),
          expectedMigrationGeneration: 1,
          dataRole: 'tenant_core/default',
          residencyPartition: 'default',
        },
      });
      return binding.verifyControlKeyCandidate({ purpose: 'smoke_rpc', token });
    }

    const payload = new TextEncoder().encode(
      `authrim-key-verification:${staged.environmentId}:${staged.keyId}:${workerScriptName}`
    );
    const token = await signRuntimeRegistrySnapshotPayloadJws({
      payload,
      privateJwk: runtimeRegistryPrivateJwkForSlot(
        this.env,
        staged.slot,
        staged.keyId
      ) as RuntimeRegistryPrivateJwk,
      keyId: staged.keyId,
    });
    return binding.verifyControlKeyCandidate({
      purpose: 'runtime_registry',
      token,
      payload,
      keyId: staged.keyId,
    });
  }
}

export const SIGNING_KEY_VERIFICATION_TARGETS = {
  runtimeRegistry: targets('runtime_registry').map(([component]) => component),
  smokeRpc: targets('smoke_rpc').map(([component]) => component),
} as const;
