import { createHash } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  executeD1Batch,
  type D1BatchExecutionResult,
  type D1BatchStatement,
} from './cloudflare.js';
import type { ControlKeyState } from './lock.js';
import type { ControlStagedSigningKey } from './control-generated-state.js';

const SAFE_ENVIRONMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_KEY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const BASE64_KEY = /^[A-Za-z0-9+/_-]+={0,2}$/u;

type KeyPurpose = 'runtime_registry' | 'smoke_rpc';

interface Ed25519Jwk extends Record<string, unknown> {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  d?: string;
  kid: string;
  alg?: 'EdDSA';
  use?: string;
}

interface ExistingStateRow extends Record<string, unknown> {
  active_signing_purposes: unknown;
  malformed_signing_purposes: unknown;
  lookup_state_count: unknown;
}

interface ReflectedSigningRow extends Record<string, unknown> {
  key_purpose: unknown;
  slot: unknown;
  key_id: unknown;
  public_jwk_json: unknown;
  public_key_fingerprint: unknown;
  state: unknown;
}

interface ReflectedLookupRow extends Record<string, unknown> {
  state_revision: unknown;
  rotation_state: unknown;
  write_mode: unknown;
  current_key_generation: unknown;
  current_key_id: unknown;
  current_key_slot: unknown;
  current_key_fingerprint: unknown;
}

export type ControlKeyStateBatchExecutor = (
  databaseId: string,
  batch: readonly D1BatchStatement[]
) => Promise<D1BatchExecutionResult[]>;

export interface InitialControlKeyStateResult {
  initialized: boolean;
  operationId: string | null;
  fingerprints: {
    runtimeRegistry: string;
    smokeRpc: string;
    lookupHmac: string;
  } | null;
}

function rows<T extends Record<string, unknown>>(
  results: readonly D1BatchExecutionResult[],
  index: number,
  code: string
): T[] {
  const value = results[index]?.results;
  if (!Array.isArray(value)) throw new Error(code);
  return value as T[];
}

function integer(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(code);
  return value as number;
}

function parseJwk(value: string, privateKey: boolean, code: string): Ed25519Jwk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(code);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(code);
  const jwk = parsed as Partial<Ed25519Jwk>;
  if (
    jwk.kty !== 'OKP' ||
    jwk.crv !== 'Ed25519' ||
    typeof jwk.x !== 'string' ||
    jwk.x.length !== 43 ||
    typeof jwk.kid !== 'string' ||
    !SAFE_KEY_ID.test(jwk.kid) ||
    (jwk.alg !== undefined && jwk.alg !== 'EdDSA') ||
    (privateKey ? typeof jwk.d !== 'string' || jwk.d.length !== 43 : jwk.d !== undefined)
  ) {
    throw new Error(code);
  }
  return jwk as Ed25519Jwk;
}

function publicJwk(privateJwk: Ed25519Jwk, serializedJwks: string, code: string): Ed25519Jwk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedJwks);
  } catch {
    throw new Error(code);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(code);
  const keys = (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) throw new Error(code);
  const matches = keys.filter(
    (candidate) =>
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      (candidate as { kid?: unknown }).kid === privateJwk.kid
  );
  if (matches.length !== 1) throw new Error(code);
  const selected = parseJwk(JSON.stringify(matches[0]), false, code);
  if (selected.x !== privateJwk.x) throw new Error(code);
  return selected;
}

function jwkFingerprint(jwk: Ed25519Jwk): string {
  return createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    .digest('hex');
}

function hmacFingerprint(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 43 ||
    normalized.length > 256 ||
    !BASE64_KEY.test(normalized) ||
    Buffer.from(normalized, 'base64').byteLength < 32
  ) {
    throw new Error('lookup_hmac_initial_key_invalid');
  }
  return createHash('sha256').update(normalized).digest('hex');
}

function signingPrivateFile(purpose: KeyPurpose, slot: 'A' | 'B'): string {
  if (purpose === 'runtime_registry') {
    return slot === 'A'
      ? 'tenant_runtime_registry_signing_private.jwk.json'
      : 'runtime_registry_signing_jwk_slot_b.private.jwk.json';
  }
  return `smoke_rpc_signing_jwk_slot_${slot.toLowerCase()}.private.jwk.json`;
}

function signingPublicFile(purpose: KeyPurpose): string {
  return purpose === 'runtime_registry'
    ? 'tenant_runtime_registry_verify.jwks.json'
    : 'control_smoke_verify.jwks.json';
}

async function writeSensitive(path: string, value: string): Promise<void> {
  await writeFile(path, value, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

function publicFromPrivate(privateJwk: Ed25519Jwk, code: string): Ed25519Jwk {
  const { d: _private, ...publicKey } = privateJwk;
  return parseJwk(JSON.stringify(publicKey), false, code);
}

async function localSigningPublicKey(input: {
  keysDir: string;
  purpose: KeyPurpose;
  slot: 'A' | 'B';
  keyId: string;
  fingerprint: string;
}): Promise<Ed25519Jwk> {
  const code = `control_${input.purpose}_local_key_mismatch`;
  const privateKey = parseJwk(
    await readFile(join(input.keysDir, signingPrivateFile(input.purpose, input.slot)), 'utf8'),
    true,
    code
  );
  const publicKey = publicFromPrivate(privateKey, code);
  if (
    privateKey.kid !== input.keyId ||
    publicKey.kid !== input.keyId ||
    jwkFingerprint(publicKey) !== input.fingerprint
  ) {
    throw new Error(code);
  }
  return publicKey;
}

export async function reconcileLocalControlKeyFiles(input: {
  keysDir: string;
  controlKeyState: ControlKeyState;
  stagedSigningKeys?: readonly ControlStagedSigningKey[];
}): Promise<void> {
  for (const purpose of ['runtime_registry', 'smoke_rpc'] as const) {
    const state =
      purpose === 'runtime_registry'
        ? input.controlKeyState.runtimeRegistry
        : input.controlKeyState.smokeRpc;
    const active = await localSigningPublicKey({
      keysDir: input.keysDir,
      purpose,
      slot: state.activeSlot,
      keyId: state.activeKeyId,
      fingerprint: state.activeFingerprint,
    });
    const keys = [active];
    const staged = input.stagedSigningKeys?.filter((candidate) => candidate.purpose === purpose);
    if (staged && staged.length > 1) {
      throw new Error(`control_${purpose}_staged_key_conflict`);
    }
    if (state.previousSlot && state.previousKeyId && state.previousFingerprint) {
      keys.push(
        await localSigningPublicKey({
          keysDir: input.keysDir,
          purpose,
          slot: state.previousSlot,
          keyId: state.previousKeyId,
          fingerprint: state.previousFingerprint,
        })
      );
    }
    const candidate = staged?.[0];
    if (candidate) {
      if (
        candidate.slot === state.activeSlot ||
        candidate.keyId === state.activeKeyId ||
        candidate.fingerprint === state.activeFingerprint ||
        candidate.slot === state.previousSlot ||
        candidate.keyId === state.previousKeyId ||
        candidate.fingerprint === state.previousFingerprint
      ) {
        throw new Error(`control_${purpose}_staged_key_conflict`);
      }
      keys.push(
        await localSigningPublicKey({
          keysDir: input.keysDir,
          purpose,
          slot: candidate.slot,
          keyId: candidate.keyId,
          fingerprint: candidate.fingerprint,
        })
      );
    }
    await writeSensitive(
      join(input.keysDir, signingPublicFile(purpose)),
      JSON.stringify({ keys }, null, 2)
    );
    if (purpose === 'runtime_registry') {
      await writeSensitive(
        join(input.keysDir, 'tenant_runtime_registry_signing_key_id.txt'),
        state.activeKeyId
      );
    }
  }

  const lookup = input.controlKeyState.lookupHmac;
  const activeLookupKey = await readFile(
    join(input.keysDir, `lookup_hmac_key_slot_${lookup.activeSlot.toLowerCase()}.txt`),
    'utf8'
  );
  if (hmacFingerprint(activeLookupKey) !== lookup.activeFingerprint) {
    throw new Error('control_lookup_hmac_local_active_key_mismatch');
  }
  if (lookup.previousSlot && lookup.previousFingerprint) {
    const previousLookupKey = await readFile(
      join(input.keysDir, `lookup_hmac_key_slot_${lookup.previousSlot.toLowerCase()}.txt`),
      'utf8'
    );
    if (hmacFingerprint(previousLookupKey) !== lookup.previousFingerprint) {
      throw new Error('control_lookup_hmac_local_previous_key_mismatch');
    }
  }
}

async function signingMaterial(input: {
  keysDir: string;
  purpose: KeyPurpose;
}): Promise<{ keyId: string; publicJwk: Ed25519Jwk; fingerprint: string }> {
  const runtime = input.purpose === 'runtime_registry';
  const privatePath = runtime
    ? 'tenant_runtime_registry_signing_private.jwk.json'
    : 'smoke_rpc_signing_jwk_slot_a.private.jwk.json';
  const publicPath = runtime
    ? 'tenant_runtime_registry_verify.jwks.json'
    : 'control_smoke_verify.jwks.json';
  const privateJwk = parseJwk(
    await readFile(join(input.keysDir, privatePath), 'utf8'),
    true,
    `${input.purpose}_initial_private_key_invalid`
  );
  const publicKey = publicJwk(
    privateJwk,
    await readFile(join(input.keysDir, publicPath), 'utf8'),
    `${input.purpose}_initial_public_key_invalid`
  );
  if (runtime) {
    const keyId = (
      await readFile(join(input.keysDir, 'tenant_runtime_registry_signing_key_id.txt'), 'utf8')
    ).trim();
    if (keyId !== privateJwk.kid) throw new Error('runtime_registry_initial_key_id_mismatch');
  }
  return {
    keyId: privateJwk.kid,
    publicJwk: publicKey,
    fingerprint: jwkFingerprint(publicKey),
  };
}

function assertReflectedSigning(
  reflected: readonly ReflectedSigningRow[],
  expected: ReadonlyMap<KeyPurpose, { keyId: string; publicJwk: Ed25519Jwk; fingerprint: string }>
): void {
  if (reflected.length !== 2) throw new Error('control_key_state_initialization_reflection_failed');
  for (const purpose of ['runtime_registry', 'smoke_rpc'] as const) {
    const row = reflected.find((candidate) => candidate.key_purpose === purpose);
    const key = expected.get(purpose);
    if (
      !row ||
      !key ||
      row.slot !== 'a' ||
      row.key_id !== key.keyId ||
      row.public_key_fingerprint !== key.fingerprint ||
      row.state !== 'active' ||
      row.public_jwk_json !== JSON.stringify(key.publicJwk)
    ) {
      throw new Error('control_key_state_initialization_reflection_failed');
    }
  }
}

export async function initializeControlKeyState(input: {
  controlDatabaseId: string;
  environmentId: string;
  keysDir: string;
  actorId?: string;
  now?: number;
  executeBatch?: ControlKeyStateBatchExecutor;
}): Promise<InitialControlKeyStateResult> {
  if (!SAFE_ENVIRONMENT_ID.test(input.environmentId)) {
    throw new Error('control_key_state_environment_invalid');
  }
  const execute = input.executeBatch ?? executeD1Batch;
  const current = await execute(input.controlDatabaseId, [
    {
      sql: `SELECT
        (SELECT COUNT(DISTINCT key_purpose) FROM control_signing_key_metadata
          WHERE environment_id = ? AND state = 'active') AS active_signing_purposes,
        (SELECT COUNT(*) FROM (
          SELECT key_purpose FROM control_signing_key_metadata
           WHERE environment_id = ? AND state = 'active'
           GROUP BY key_purpose HAVING COUNT(*) <> 1
        )) AS malformed_signing_purposes,
        (SELECT COUNT(*) FROM control_lookup_hmac_key_states
          WHERE environment_id = ?) AS lookup_state_count`,
      params: [input.environmentId, input.environmentId, input.environmentId],
    },
  ]);
  const existing = rows<ExistingStateRow>(current, 0, 'control_key_state_preflight_invalid')[0];
  if (!existing) throw new Error('control_key_state_preflight_invalid');
  const activePurposes = integer(
    existing.active_signing_purposes,
    'control_key_state_preflight_invalid'
  );
  const malformedPurposes = integer(
    existing.malformed_signing_purposes,
    'control_key_state_preflight_invalid'
  );
  const lookupCount = integer(existing.lookup_state_count, 'control_key_state_preflight_invalid');
  if (activePurposes === 2 && malformedPurposes === 0 && lookupCount === 1) {
    return { initialized: false, operationId: null, fingerprints: null };
  }
  if (activePurposes !== 0 || malformedPurposes !== 0 || lookupCount !== 0) {
    throw new Error('control_key_state_partial_initialization');
  }

  const [runtimeRegistry, smokeRpc, lookupSecret] = await Promise.all([
    signingMaterial({ keysDir: input.keysDir, purpose: 'runtime_registry' }),
    signingMaterial({ keysDir: input.keysDir, purpose: 'smoke_rpc' }),
    readFile(join(input.keysDir, 'lookup_hmac_key_slot_a.txt'), 'utf8'),
  ]);
  const lookupFingerprint = hmacFingerprint(lookupSecret);
  const digest = createHash('sha256')
    .update([runtimeRegistry.fingerprint, smokeRpc.fingerprint, lookupFingerprint].join('\0'))
    .digest('hex');
  const operationId = `op_key_init_${digest.slice(0, 32)}`;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 1) throw new Error('control_key_state_time_invalid');
  const actorId = input.actorId ?? 'setup:key-init';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,199}$/u.test(actorId)) {
    throw new Error('control_key_state_actor_invalid');
  }
  const signing = new Map<KeyPurpose, typeof runtimeRegistry>([
    ['runtime_registry', runtimeRegistry],
    ['smoke_rpc', smokeRpc],
  ]);
  const batch: D1BatchStatement[] = [
    {
      sql: `INSERT OR IGNORE INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, requested_by_id, attempt_count, created_at, started_at,
        completed_at, updated_at
      ) VALUES (?, ?, 'initialize_key_state', ?, 'succeeded', 'setup', ?, 1, ?, ?, ?, ?)`,
      params: [
        operationId,
        input.environmentId,
        `initialize-key-state:${digest}`,
        actorId,
        now,
        now,
        now,
        now,
      ],
    },
    ...[...signing.entries()].map(([purpose, key]) => ({
      sql: `INSERT OR IGNORE INTO control_signing_key_metadata (
        environment_id, key_purpose, slot, key_id, public_jwk_json,
        public_key_fingerprint, state, active_key_guard, activated_at, updated_at
      ) VALUES (?, ?, 'a', ?, ?, ?, 'active', 'active', ?, ?)`,
      params: [
        input.environmentId,
        purpose,
        key.keyId,
        JSON.stringify(key.publicJwk),
        key.fingerprint,
        now,
        now,
      ],
    })),
    {
      sql: `INSERT OR IGNORE INTO control_lookup_hmac_key_states (
        environment_id, state_revision, rotation_state, write_mode,
        current_key_generation, current_key_id, current_key_slot,
        current_key_fingerprint, updated_at
      ) VALUES (?, 1, 'stable', 'current_only', 1, ?, 'A', ?, ?)`,
      params: [input.environmentId, `lookup-${digest.slice(0, 16)}-g1`, lookupFingerprint, now],
    },
    {
      sql: `INSERT OR IGNORE INTO control_audit_events (
        event_id, environment_id, operation_id, event_type, actor_type, actor_id,
        resource_kind, resource_id, outcome, redacted_payload_json, created_at
      ) VALUES (?, ?, ?, 'control.key_state.initialized', 'setup', ?,
                'key_metadata', ?, 'succeeded', ?, ?)`,
      params: [
        `audit:${operationId}:initialized`,
        input.environmentId,
        operationId,
        actorId,
        input.environmentId,
        JSON.stringify({
          runtime_registry_fingerprint: runtimeRegistry.fingerprint,
          smoke_rpc_fingerprint: smokeRpc.fingerprint,
          lookup_hmac_fingerprint: lookupFingerprint,
        }),
        now,
      ],
    },
    {
      sql: `SELECT key_purpose, slot, key_id, public_jwk_json,
                   public_key_fingerprint, state
              FROM control_signing_key_metadata
             WHERE environment_id = ? AND state = 'active'
             ORDER BY key_purpose`,
      params: [input.environmentId],
    },
    {
      sql: `SELECT state_revision, rotation_state, write_mode,
                   current_key_generation, current_key_id, current_key_slot,
                   current_key_fingerprint
              FROM control_lookup_hmac_key_states WHERE environment_id = ?`,
      params: [input.environmentId],
    },
  ];
  const result = await execute(input.controlDatabaseId, batch);
  assertReflectedSigning(
    rows<ReflectedSigningRow>(result, 5, 'control_key_state_reflection_invalid'),
    signing
  );
  const lookup = rows<ReflectedLookupRow>(result, 6, 'control_key_state_reflection_invalid')[0];
  if (
    !lookup ||
    lookup.state_revision !== 1 ||
    lookup.rotation_state !== 'stable' ||
    lookup.write_mode !== 'current_only' ||
    lookup.current_key_generation !== 1 ||
    lookup.current_key_slot !== 'A' ||
    lookup.current_key_fingerprint !== lookupFingerprint
  ) {
    throw new Error('control_key_state_initialization_reflection_failed');
  }
  return {
    initialized: true,
    operationId,
    fingerprints: {
      runtimeRegistry: runtimeRegistry.fingerprint,
      smokeRpc: smokeRpc.fingerprint,
      lookupHmac: lookupFingerprint,
    },
  };
}
