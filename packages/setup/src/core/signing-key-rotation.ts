import { createHash, randomBytes } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateEd25519JwkKeyPair, type JWK } from './keys.js';
import type { ControlKeyState } from './lock.js';
import {
  executeD1Batch,
  type D1BatchExecutionResult,
  type D1BatchStatement,
} from './cloudflare.js';

const SAFE_ENVIRONMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_ACTOR_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,199}$/u;
const SAFE_KEY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/u;
const SAFE_WORKER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const MINIMUM_PREVIOUS_KEY_AGE_SECONDS = 60 * 60;

export type ControlSigningKeyPurpose = 'runtime_registry' | 'smoke_rpc';
export type SigningKeyRotationBatchExecutor = (
  databaseId: string,
  batch: readonly D1BatchStatement[]
) => Promise<D1BatchExecutionResult[]>;

interface MetadataRow extends Record<string, unknown> {
  slot: unknown;
  key_id: unknown;
  public_jwk_json: unknown;
  public_key_fingerprint: unknown;
  state: unknown;
  updated_at: unknown;
}

interface Ed25519PublicJwk extends JWK {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  alg: 'EdDSA';
}

export interface StagedSigningKeyRotation {
  purpose: ControlSigningKeyPurpose;
  activeSlot: 'A' | 'B';
  candidateSlot: 'A' | 'B';
  activeKeyId: string;
  candidateKeyId: string;
  activeFingerprint: string;
  candidateFingerprint: string;
  privateSecretName:
    | 'RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A'
    | 'RUNTIME_REGISTRY_SIGNING_JWK_SLOT_B'
    | 'SMOKE_RPC_SIGNING_JWK_SLOT_A'
    | 'SMOKE_RPC_SIGNING_JWK_SLOT_B';
  verifyingSecretName:
    | 'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS'
    | 'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS';
  operationId: string;
  resumed: boolean;
}

function resultRows<T extends Record<string, unknown>>(
  results: readonly D1BatchExecutionResult[],
  index: number,
  code: string
): T[] {
  const value = results[index]?.results;
  if (!Array.isArray(value)) throw new Error(code);
  return value as T[];
}

function parsePublicJwk(serialized: unknown, code: string): Ed25519PublicJwk {
  if (typeof serialized !== 'string') throw new Error(code);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(code);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(code);
  const jwk = parsed as Partial<Ed25519PublicJwk>;
  if (
    jwk.kty !== 'OKP' ||
    jwk.crv !== 'Ed25519' ||
    typeof jwk.x !== 'string' ||
    !BASE64URL_43.test(jwk.x) ||
    typeof jwk.kid !== 'string' ||
    !SAFE_KEY_ID.test(jwk.kid) ||
    jwk.alg !== 'EdDSA' ||
    typeof jwk.d === 'string'
  ) {
    throw new Error(code);
  }
  return jwk as Ed25519PublicJwk;
}

function fingerprint(jwk: Ed25519PublicJwk): string {
  return createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    .digest('hex');
}

function publicFromGenerated(value: JWK): Ed25519PublicJwk {
  return parsePublicJwk(JSON.stringify(value), 'signing_key_rotation_generated_key_invalid');
}

function purposeState(
  state: ControlKeyState,
  purpose: ControlSigningKeyPurpose
): ControlKeyState['runtimeRegistry'] {
  return purpose === 'runtime_registry' ? state.runtimeRegistry : state.smokeRpc;
}

function privateFile(purpose: ControlSigningKeyPurpose, slot: 'A' | 'B'): string {
  if (purpose === 'runtime_registry') {
    return slot === 'A'
      ? 'tenant_runtime_registry_signing_private.jwk.json'
      : 'runtime_registry_signing_jwk_slot_b.private.jwk.json';
  }
  return `smoke_rpc_signing_jwk_slot_${slot.toLowerCase()}.private.jwk.json`;
}

function publicFile(purpose: ControlSigningKeyPurpose): string {
  return purpose === 'runtime_registry'
    ? 'tenant_runtime_registry_verify.jwks.json'
    : 'control_smoke_verify.jwks.json';
}

function pendingPrivateFile(
  purpose: ControlSigningKeyPurpose,
  slot: 'A' | 'B',
  keyId: string
): string {
  return `.${privateFile(purpose, slot)}.staged.${keyId}`;
}

function privateSecretName(
  purpose: ControlSigningKeyPurpose,
  slot: 'A' | 'B'
): StagedSigningKeyRotation['privateSecretName'] {
  return `${purpose === 'runtime_registry' ? 'RUNTIME_REGISTRY' : 'SMOKE_RPC'}_SIGNING_JWK_SLOT_${slot}`;
}

function verifyingSecretName(
  purpose: ControlSigningKeyPurpose
): StagedSigningKeyRotation['verifyingSecretName'] {
  return purpose === 'runtime_registry'
    ? 'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS'
    : 'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS';
}

function validateInput(input: { environmentId: string; actorId: string; now: number }): void {
  if (!SAFE_ENVIRONMENT_ID.test(input.environmentId)) {
    throw new Error('signing_key_rotation_environment_invalid');
  }
  if (!SAFE_ACTOR_ID.test(input.actorId)) throw new Error('signing_key_rotation_actor_invalid');
  if (!Number.isSafeInteger(input.now) || input.now < 1) {
    throw new Error('signing_key_rotation_time_invalid');
  }
}

function metadataRow(rows: readonly MetadataRow[], slot: 'A' | 'B'): MetadataRow | undefined {
  return rows.find((row) => row.slot === slot.toLowerCase());
}

async function writeSensitive(path: string, value: string): Promise<void> {
  await writeFile(path, value, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

function parsePrivateJwk(
  serialized: string,
  code: string
): JWK & {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  d: string;
  kid: string;
  alg: 'EdDSA';
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(code);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(code);
  const jwk = parsed as Partial<JWK>;
  if (
    jwk.kty !== 'OKP' ||
    jwk.crv !== 'Ed25519' ||
    typeof jwk.x !== 'string' ||
    !BASE64URL_43.test(jwk.x) ||
    typeof jwk.d !== 'string' ||
    !BASE64URL_43.test(jwk.d) ||
    typeof jwk.kid !== 'string' ||
    !SAFE_KEY_ID.test(jwk.kid) ||
    jwk.alg !== 'EdDSA'
  ) {
    throw new Error(code);
  }
  return jwk as ReturnType<typeof parsePrivateJwk>;
}

async function promoteStagedPrivateKey(input: {
  keysDir: string;
  purpose: ControlSigningKeyPurpose;
  slot: 'A' | 'B';
  keyId: string;
  publicKey: Ed25519PublicJwk;
}): Promise<void> {
  const code = 'signing_key_rotation_staged_private_key_mismatch';
  const slotPath = join(input.keysDir, privateFile(input.purpose, input.slot));
  const pendingPath = join(
    input.keysDir,
    pendingPrivateFile(input.purpose, input.slot, input.keyId)
  );
  const matches = (serialized: string): boolean => {
    const privateJwk = parsePrivateJwk(serialized, code);
    return (
      privateJwk.kid === input.keyId &&
      privateJwk.x === input.publicKey.x &&
      privateJwk.d.length === 43
    );
  };
  const slotValue = await readFile(slotPath, 'utf8').catch(() => null);
  if (slotValue !== null) {
    try {
      if (matches(slotValue)) return;
    } catch {
      // A previous key may still occupy the inactive slot until the Control commit succeeds.
    }
  }
  const pendingValue = await readFile(pendingPath, 'utf8').catch(() => null);
  if (pendingValue === null || !matches(pendingValue)) throw new Error(code);
  await rename(pendingPath, slotPath);
  await chmod(slotPath, 0o600);
}

function validateActiveRow(
  row: MetadataRow | undefined,
  expected: ControlKeyState['runtimeRegistry'],
  code: string
): Ed25519PublicJwk {
  if (
    !row ||
    row.state !== 'active' ||
    row.key_id !== expected.activeKeyId ||
    row.public_key_fingerprint !== expected.activeFingerprint
  ) {
    throw new Error(code);
  }
  const publicJwk = parsePublicJwk(row.public_jwk_json, code);
  if (fingerprint(publicJwk) !== expected.activeFingerprint) throw new Error(code);
  return publicJwk;
}

export async function stageControlSigningKeyRotation(input: {
  controlDatabaseId: string;
  environmentId: string;
  keysDir: string;
  purpose: ControlSigningKeyPurpose;
  controlKeyState: ControlKeyState;
  actorId?: string;
  now?: number;
  executeBatch?: SigningKeyRotationBatchExecutor;
}): Promise<StagedSigningKeyRotation> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const actorId = input.actorId ?? 'setup:key-rotation';
  validateInput({ environmentId: input.environmentId, actorId, now });
  const current = purposeState(input.controlKeyState, input.purpose);
  const candidateSlot = current.activeSlot === 'A' ? 'B' : 'A';
  if (
    current.previousSlot === candidateSlot &&
    now - current.updatedAt < MINIMUM_PREVIOUS_KEY_AGE_SECONDS
  ) {
    throw new Error('signing_key_rotation_previous_key_rollback_window_active');
  }
  const execute = input.executeBatch ?? executeD1Batch;
  const preflight = await execute(input.controlDatabaseId, [
    {
      sql: `SELECT slot, key_id, public_jwk_json, public_key_fingerprint, state, updated_at
              FROM control_signing_key_metadata
             WHERE environment_id = ? AND key_purpose = ?
             ORDER BY slot`,
      params: [input.environmentId, input.purpose],
    },
  ]);
  const metadata = resultRows<MetadataRow>(preflight, 0, 'signing_key_rotation_preflight_invalid');
  const activePublic = validateActiveRow(
    metadataRow(metadata, current.activeSlot),
    current,
    'signing_key_rotation_active_metadata_mismatch'
  );
  const inactive = metadataRow(metadata, candidateSlot);
  if (inactive?.state === 'staged') {
    const candidatePublic = parsePublicJwk(
      inactive.public_jwk_json,
      'signing_key_rotation_staged_metadata_invalid'
    );
    if (
      typeof inactive.key_id !== 'string' ||
      typeof inactive.public_key_fingerprint !== 'string' ||
      !HEX_DIGEST.test(inactive.public_key_fingerprint) ||
      fingerprint(candidatePublic) !== inactive.public_key_fingerprint
    ) {
      throw new Error('signing_key_rotation_staged_metadata_invalid');
    }
    await promoteStagedPrivateKey({
      keysDir: input.keysDir,
      purpose: input.purpose,
      slot: candidateSlot,
      keyId: inactive.key_id,
      publicKey: candidatePublic,
    });
    await writeSensitive(
      join(input.keysDir, publicFile(input.purpose)),
      JSON.stringify({ keys: [activePublic, candidatePublic] }, null, 2)
    );
    const operationId = `op_key_stage_${createHash('sha256')
      .update(`${input.environmentId}\0${input.purpose}\0${inactive.key_id}`)
      .digest('hex')
      .slice(0, 32)}`;
    return {
      purpose: input.purpose,
      activeSlot: current.activeSlot,
      candidateSlot,
      activeKeyId: current.activeKeyId,
      candidateKeyId: inactive.key_id,
      activeFingerprint: current.activeFingerprint,
      candidateFingerprint: inactive.public_key_fingerprint,
      privateSecretName: privateSecretName(input.purpose, candidateSlot),
      verifyingSecretName: verifyingSecretName(input.purpose),
      operationId,
      resumed: true,
    };
  }
  if (inactive && inactive.state !== 'previous' && inactive.state !== 'retired') {
    throw new Error('signing_key_rotation_inactive_slot_unavailable');
  }

  const keyId = `${input.purpose.replace('_', '-')}-${now}-${randomBytes(4).toString('hex')}`;
  const generated = generateEd25519JwkKeyPair(keyId);
  const candidatePublic = publicFromGenerated(generated.publicJwk);
  const candidateFingerprint = fingerprint(candidatePublic);
  const operationId = `op_key_stage_${createHash('sha256')
    .update(`${input.environmentId}\0${input.purpose}\0${keyId}`)
    .digest('hex')
    .slice(0, 32)}`;
  const pendingPath = join(input.keysDir, pendingPrivateFile(input.purpose, candidateSlot, keyId));
  await writeSensitive(pendingPath, JSON.stringify(generated.privateJwk, null, 2));
  const staged = await execute(input.controlDatabaseId, [
    {
      sql: `DELETE FROM control_signing_key_metadata
             WHERE environment_id = ? AND key_purpose = ? AND slot = ?
               AND state IN ('previous', 'retired') AND updated_at <= ?
               AND EXISTS (
                 SELECT 1 FROM control_signing_key_metadata active
                  WHERE active.environment_id = ? AND active.key_purpose = ?
                    AND active.state = 'active' AND active.slot = ?
                    AND active.key_id = ? AND active.public_key_fingerprint = ?
               )`,
      params: [
        input.environmentId,
        input.purpose,
        candidateSlot.toLowerCase(),
        now - MINIMUM_PREVIOUS_KEY_AGE_SECONDS,
        input.environmentId,
        input.purpose,
        current.activeSlot.toLowerCase(),
        current.activeKeyId,
        current.activeFingerprint,
      ],
    },
    {
      sql: `UPDATE control_signing_key_metadata
               SET updated_at = ?
             WHERE environment_id = ? AND key_purpose = ? AND state = 'active'
               AND slot = ? AND key_id = ? AND public_key_fingerprint = ?`,
      params: [
        now,
        input.environmentId,
        input.purpose,
        current.activeSlot.toLowerCase(),
        current.activeKeyId,
        current.activeFingerprint,
      ],
    },
    {
      sql: `INSERT INTO control_signing_key_metadata (
        environment_id, key_purpose, slot, key_id, public_jwk_json,
        public_key_fingerprint, state, active_key_guard, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, 'staged', 'slot:' || ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_signing_key_metadata
          WHERE environment_id = ? AND key_purpose = ? AND state = 'active'
            AND slot = ? AND key_id = ? AND public_key_fingerprint = ?
            AND updated_at = ?
       )`,
      params: [
        input.environmentId,
        input.purpose,
        candidateSlot.toLowerCase(),
        keyId,
        JSON.stringify(candidatePublic),
        candidateFingerprint,
        candidateSlot.toLowerCase(),
        now,
        input.environmentId,
        input.purpose,
        current.activeSlot.toLowerCase(),
        current.activeKeyId,
        current.activeFingerprint,
        now,
      ],
    },
    {
      sql: `INSERT OR IGNORE INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, requested_by_id, attempt_count, created_at, started_at,
        completed_at, updated_at
      )
      SELECT ?, ?, 'stage_signing_key', ?, 'succeeded', 'setup', ?, 1, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_signing_key_metadata
          WHERE environment_id = ? AND key_purpose = ? AND state = 'staged'
            AND slot = ? AND key_id = ? AND public_key_fingerprint = ?
       )`,
      params: [
        operationId,
        input.environmentId,
        `stage-signing-key:${input.purpose}:${keyId}`,
        actorId,
        now,
        now,
        now,
        now,
        input.environmentId,
        input.purpose,
        candidateSlot.toLowerCase(),
        keyId,
        candidateFingerprint,
      ],
    },
    {
      sql: `INSERT OR IGNORE INTO control_audit_events (
        event_id, environment_id, operation_id, event_type, actor_type, actor_id,
        resource_kind, resource_id, outcome, redacted_payload_json, created_at
      )
      SELECT ?, ?, ?, 'control.signing_key.staged', 'setup', ?,
             'signing_key', ?, 'succeeded', ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_signing_key_metadata
          WHERE environment_id = ? AND key_purpose = ? AND state = 'staged'
            AND slot = ? AND key_id = ? AND public_key_fingerprint = ?
       )`,
      params: [
        `audit:${operationId}:staged`,
        input.environmentId,
        operationId,
        actorId,
        `${input.purpose}:${candidateSlot}`,
        JSON.stringify({
          purpose: input.purpose,
          slot: candidateSlot,
          fingerprint: candidateFingerprint,
        }),
        now,
        input.environmentId,
        input.purpose,
        candidateSlot.toLowerCase(),
        keyId,
        candidateFingerprint,
      ],
    },
    {
      sql: `SELECT slot, key_id, public_jwk_json, public_key_fingerprint, state, updated_at
              FROM control_signing_key_metadata
             WHERE environment_id = ? AND key_purpose = ?
               AND state IN ('active', 'staged') ORDER BY state, slot`,
      params: [input.environmentId, input.purpose],
    },
  ]);
  const reflectedRows = resultRows<MetadataRow>(
    staged,
    5,
    'signing_key_rotation_stage_reflection_invalid'
  );
  const reflected = reflectedRows.find((row) => row.state === 'staged');
  const reflectedActive = reflectedRows.find((row) => row.state === 'active');
  if (
    reflectedRows.length !== 2 ||
    !reflected ||
    reflected.state !== 'staged' ||
    reflected.key_id !== keyId ||
    reflected.public_key_fingerprint !== candidateFingerprint ||
    !reflectedActive ||
    reflectedActive.slot !== current.activeSlot.toLowerCase() ||
    reflectedActive.key_id !== current.activeKeyId ||
    reflectedActive.public_key_fingerprint !== current.activeFingerprint ||
    reflectedActive.updated_at !== now
  ) {
    throw new Error('signing_key_rotation_stage_reflection_failed');
  }
  await promoteStagedPrivateKey({
    keysDir: input.keysDir,
    purpose: input.purpose,
    slot: candidateSlot,
    keyId,
    publicKey: candidatePublic,
  });
  await writeSensitive(
    join(input.keysDir, publicFile(input.purpose)),
    JSON.stringify({ keys: [activePublic, candidatePublic] }, null, 2)
  );
  return {
    purpose: input.purpose,
    activeSlot: current.activeSlot,
    candidateSlot,
    activeKeyId: current.activeKeyId,
    candidateKeyId: keyId,
    activeFingerprint: current.activeFingerprint,
    candidateFingerprint,
    privateSecretName: privateSecretName(input.purpose, candidateSlot),
    verifyingSecretName: verifyingSecretName(input.purpose),
    operationId,
    resumed: false,
  };
}

export async function activateControlSigningKeyRotation(input: {
  controlDatabaseId: string;
  environmentId: string;
  keysDir: string;
  staged: StagedSigningKeyRotation;
  expectedWorkerScriptNames: readonly string[];
  actorId?: string;
  now?: number;
  executeBatch?: SigningKeyRotationBatchExecutor;
}): Promise<void> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const actorId = input.actorId ?? 'setup:key-rotation';
  validateInput({ environmentId: input.environmentId, actorId, now });
  const expectedWorkers = [...new Set(input.expectedWorkerScriptNames)];
  if (
    expectedWorkers.length === 0 ||
    expectedWorkers.length > 32 ||
    expectedWorkers.length !== input.expectedWorkerScriptNames.length ||
    expectedWorkers.some((worker) => !SAFE_WORKER.test(worker))
  ) {
    throw new Error('signing_key_rotation_verification_targets_invalid');
  }
  const expectedWorkersJson = JSON.stringify(expectedWorkers);
  const execute = input.executeBatch ?? executeD1Batch;
  const operationId = input.staged.operationId.replace('op_key_stage_', 'op_key_activate_');
  const activated = await execute(input.controlDatabaseId, [
    {
      sql: `UPDATE control_signing_key_metadata
               SET state = 'previous', active_key_guard = 'slot:' || slot, updated_at = ?
             WHERE environment_id = ? AND key_purpose = ? AND state = 'active'
               AND slot = ? AND key_id = ? AND public_key_fingerprint = ?
               AND EXISTS (
                 SELECT 1 FROM control_signing_key_metadata candidate
                  WHERE candidate.environment_id = ? AND candidate.key_purpose = ?
                    AND candidate.state = 'staged' AND candidate.slot = ?
                    AND candidate.key_id = ? AND candidate.public_key_fingerprint = ?
               )
               AND (SELECT COUNT(DISTINCT value) FROM json_each(?)) = ?
               AND NOT EXISTS (
                 SELECT 1 FROM json_each(?) expected
                  WHERE NOT EXISTS (
                    SELECT 1 FROM control_signing_key_verifications verification
                     WHERE verification.environment_id = ?
                       AND verification.key_purpose = ?
                       AND verification.key_id = ?
                       AND verification.slot = ?
                       AND verification.worker_script_name = expected.value
                       AND verification.status = 'succeeded'
                  )
               )`,
      params: [
        now,
        input.environmentId,
        input.staged.purpose,
        input.staged.activeSlot.toLowerCase(),
        input.staged.activeKeyId,
        input.staged.activeFingerprint,
        input.environmentId,
        input.staged.purpose,
        input.staged.candidateSlot.toLowerCase(),
        input.staged.candidateKeyId,
        input.staged.candidateFingerprint,
        expectedWorkersJson,
        expectedWorkers.length,
        expectedWorkersJson,
        input.environmentId,
        input.staged.purpose,
        input.staged.candidateKeyId,
        input.staged.candidateSlot.toLowerCase(),
      ],
    },
    {
      sql: `UPDATE control_signing_key_metadata
               SET state = 'active', active_key_guard = 'active', activated_at = ?, updated_at = ?
             WHERE environment_id = ? AND key_purpose = ? AND state IN ('staged', 'active')
               AND slot = ? AND key_id = ? AND public_key_fingerprint = ?
               AND (
                 state = 'active' OR EXISTS (
                   SELECT 1 FROM control_signing_key_metadata previous
                    WHERE previous.environment_id = ? AND previous.key_purpose = ?
                      AND previous.state = 'previous' AND previous.slot = ?
                      AND previous.key_id = ? AND previous.public_key_fingerprint = ?
                 )
               )
               AND (SELECT COUNT(DISTINCT value) FROM json_each(?)) = ?
               AND NOT EXISTS (
                 SELECT 1 FROM json_each(?) expected
                  WHERE NOT EXISTS (
                    SELECT 1 FROM control_signing_key_verifications verification
                     WHERE verification.environment_id = ?
                       AND verification.key_purpose = ?
                       AND verification.key_id = ?
                       AND verification.slot = ?
                       AND verification.worker_script_name = expected.value
                       AND verification.status = 'succeeded'
                  )
               )`,
      params: [
        now,
        now,
        input.environmentId,
        input.staged.purpose,
        input.staged.candidateSlot.toLowerCase(),
        input.staged.candidateKeyId,
        input.staged.candidateFingerprint,
        input.environmentId,
        input.staged.purpose,
        input.staged.activeSlot.toLowerCase(),
        input.staged.activeKeyId,
        input.staged.activeFingerprint,
        expectedWorkersJson,
        expectedWorkers.length,
        expectedWorkersJson,
        input.environmentId,
        input.staged.purpose,
        input.staged.candidateKeyId,
        input.staged.candidateSlot.toLowerCase(),
      ],
    },
    {
      sql: `INSERT OR IGNORE INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, requested_by_id, attempt_count, created_at, started_at,
        completed_at, updated_at
      )
      SELECT ?, ?, 'activate_signing_key', ?, 'succeeded', 'setup', ?, 1, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_signing_key_metadata
          WHERE environment_id = ? AND key_purpose = ? AND state = 'active'
            AND slot = ? AND key_id = ? AND public_key_fingerprint = ?
            AND EXISTS (
              SELECT 1 FROM control_signing_key_metadata previous
               WHERE previous.environment_id = ? AND previous.key_purpose = ?
                 AND previous.state = 'previous' AND previous.slot = ?
                 AND previous.key_id = ? AND previous.public_key_fingerprint = ?
            )
       )`,
      params: [
        operationId,
        input.environmentId,
        `activate-signing-key:${input.staged.purpose}:${input.staged.candidateKeyId}`,
        actorId,
        now,
        now,
        now,
        now,
        input.environmentId,
        input.staged.purpose,
        input.staged.candidateSlot.toLowerCase(),
        input.staged.candidateKeyId,
        input.staged.candidateFingerprint,
        input.environmentId,
        input.staged.purpose,
        input.staged.activeSlot.toLowerCase(),
        input.staged.activeKeyId,
        input.staged.activeFingerprint,
      ],
    },
    {
      sql: `INSERT OR IGNORE INTO control_audit_events (
        event_id, environment_id, operation_id, event_type, actor_type, actor_id,
        resource_kind, resource_id, outcome, redacted_payload_json, created_at
      )
      SELECT ?, ?, ?, 'control.signing_key.activated', 'setup', ?,
             'signing_key', ?, 'succeeded', ?, ?
       WHERE EXISTS (
         SELECT 1 FROM control_signing_key_metadata
          WHERE environment_id = ? AND key_purpose = ? AND state = 'active'
            AND slot = ? AND key_id = ? AND public_key_fingerprint = ?
            AND EXISTS (
              SELECT 1 FROM control_signing_key_metadata previous
               WHERE previous.environment_id = ? AND previous.key_purpose = ?
                 AND previous.state = 'previous' AND previous.slot = ?
                 AND previous.key_id = ? AND previous.public_key_fingerprint = ?
            )
       )`,
      params: [
        `audit:${operationId}:activated`,
        input.environmentId,
        operationId,
        actorId,
        `${input.staged.purpose}:${input.staged.candidateSlot}`,
        JSON.stringify({
          purpose: input.staged.purpose,
          active_slot: input.staged.candidateSlot,
          active_fingerprint: input.staged.candidateFingerprint,
          previous_fingerprint: input.staged.activeFingerprint,
        }),
        now,
        input.environmentId,
        input.staged.purpose,
        input.staged.candidateSlot.toLowerCase(),
        input.staged.candidateKeyId,
        input.staged.candidateFingerprint,
        input.environmentId,
        input.staged.purpose,
        input.staged.activeSlot.toLowerCase(),
        input.staged.activeKeyId,
        input.staged.activeFingerprint,
      ],
    },
    {
      sql: `SELECT slot, key_id, public_jwk_json, public_key_fingerprint, state, updated_at
              FROM control_signing_key_metadata
             WHERE environment_id = ? AND key_purpose = ?
               AND state IN ('active', 'previous') ORDER BY state, slot`,
      params: [input.environmentId, input.staged.purpose],
    },
  ]);
  const reflected = resultRows<MetadataRow>(
    activated,
    4,
    'signing_key_rotation_activation_reflection_invalid'
  );
  const active = reflected.find((row) => row.state === 'active');
  const previous = reflected.find((row) => row.state === 'previous');
  if (
    reflected.length !== 2 ||
    active?.slot !== input.staged.candidateSlot.toLowerCase() ||
    active.key_id !== input.staged.candidateKeyId ||
    active.public_key_fingerprint !== input.staged.candidateFingerprint ||
    previous?.slot !== input.staged.activeSlot.toLowerCase() ||
    previous.key_id !== input.staged.activeKeyId ||
    previous.public_key_fingerprint !== input.staged.activeFingerprint
  ) {
    throw new Error('signing_key_rotation_activation_reflection_failed');
  }
  if (input.staged.purpose === 'runtime_registry') {
    await writeSensitive(
      join(input.keysDir, 'tenant_runtime_registry_signing_key_id.txt'),
      input.staged.candidateKeyId
    );
  }
}

export const SIGNING_KEY_PREVIOUS_ROLLBACK_WINDOW_SECONDS = MINIMUM_PREVIOUS_KEY_AGE_SECONDS;
