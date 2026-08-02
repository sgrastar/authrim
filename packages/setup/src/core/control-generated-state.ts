import type { AuthrimLock, ControlKeyState } from './lock.js';
import { queryD1Rows } from './cloudflare.js';
import { isControlGeneratedDatabaseBinding } from './tenant-database.js';

const SAFE_ENVIRONMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_DATABASE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SAFE_DATABASE_ID = /^[a-fA-F0-9-]{16,64}$/u;
const SAFE_KEY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const HEX_DIGEST = /^[a-f0-9]{64}$/u;

interface ControlGeneratedD1Row extends Record<string, unknown> {
  binding_name: unknown;
  deterministic_name: unknown;
  provider_resource_id: unknown;
  observed_state: unknown;
  provisioning_state: unknown;
}

interface ControlGeneratedKeyRow extends Record<string, unknown> {
  row_kind: unknown;
  key_purpose: unknown;
  slot: unknown;
  key_id: unknown;
  fingerprint: unknown;
  key_state: unknown;
  state_revision: unknown;
  generation: unknown;
  previous_slot: unknown;
  previous_key_id: unknown;
  previous_fingerprint: unknown;
  previous_generation: unknown;
  updated_at: unknown;
}

export interface ControlGeneratedD1Binding {
  binding: string;
  name: string;
  id: string;
}

type SigningKeyState = ControlKeyState['runtimeRegistry'];

export interface ControlStagedSigningKey {
  purpose: 'runtime_registry' | 'smoke_rpc';
  slot: 'A' | 'B';
  keyId: string;
  fingerprint: string;
  updatedAt: number;
}

function requiredPositiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(code);
  return value as number;
}

function requiredKeyId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SAFE_KEY_ID.test(value)) throw new Error(code);
  return value;
}

function requiredFingerprint(value: unknown, code: string): string {
  if (typeof value !== 'string' || !HEX_DIGEST.test(value)) throw new Error(code);
  return value;
}

function requiredSlot(value: unknown, code: string): 'A' | 'B' {
  if (value !== 'A' && value !== 'B') throw new Error(code);
  return value;
}

function parseSigningKeyState(
  rows: readonly ControlGeneratedKeyRow[],
  purpose: 'runtime_registry' | 'smoke_rpc'
): SigningKeyState {
  const purposeRows = rows.filter(
    (row) => row.row_kind === 'signing' && row.key_purpose === purpose
  );
  const activeRows = purposeRows.filter((row) => row.key_state === 'active');
  const previousRows = purposeRows.filter((row) => row.key_state === 'previous');
  if (activeRows.length !== 1 || previousRows.length > 1 || purposeRows.length === 0) {
    throw new Error(`control_generated_${purpose}_key_state_incomplete`);
  }
  if (purposeRows.some((row) => row.key_state !== 'active' && row.key_state !== 'previous')) {
    throw new Error(`control_generated_${purpose}_key_state_invalid`);
  }
  const active = activeRows[0];
  const previous = previousRows[0];
  const result: SigningKeyState = {
    activeSlot: requiredSlot(active.slot, `control_generated_${purpose}_active_slot_invalid`),
    activeKeyId: requiredKeyId(active.key_id, `control_generated_${purpose}_active_key_invalid`),
    activeFingerprint: requiredFingerprint(
      active.fingerprint,
      `control_generated_${purpose}_active_fingerprint_invalid`
    ),
    updatedAt: Math.max(
      ...purposeRows.map((row) =>
        requiredPositiveInteger(row.updated_at, `control_generated_${purpose}_updated_at_invalid`)
      )
    ),
  };
  if (previous) {
    result.previousSlot = requiredSlot(
      previous.slot,
      `control_generated_${purpose}_previous_slot_invalid`
    );
    result.previousKeyId = requiredKeyId(
      previous.key_id,
      `control_generated_${purpose}_previous_key_invalid`
    );
    result.previousFingerprint = requiredFingerprint(
      previous.fingerprint,
      `control_generated_${purpose}_previous_fingerprint_invalid`
    );
    if (
      result.previousSlot === result.activeSlot ||
      result.previousKeyId === result.activeKeyId ||
      result.previousFingerprint === result.activeFingerprint
    ) {
      throw new Error(`control_generated_${purpose}_key_state_conflict`);
    }
  }
  return result;
}

function parseLookupHmacKeyState(row: ControlGeneratedKeyRow): ControlKeyState['lookupHmac'] {
  if (row.row_kind !== 'lookup_hmac' || row.key_purpose !== 'lookup_hmac') {
    throw new Error('control_generated_lookup_hmac_key_state_invalid');
  }
  const result: ControlKeyState['lookupHmac'] = {
    stateRevision: requiredPositiveInteger(
      row.state_revision,
      'control_generated_lookup_hmac_revision_invalid'
    ),
    activeGeneration: requiredPositiveInteger(
      row.generation,
      'control_generated_lookup_hmac_generation_invalid'
    ),
    activeSlot: requiredSlot(row.slot, 'control_generated_lookup_hmac_active_slot_invalid'),
    activeKeyId: requiredKeyId(row.key_id, 'control_generated_lookup_hmac_active_key_invalid'),
    activeFingerprint: requiredFingerprint(
      row.fingerprint,
      'control_generated_lookup_hmac_active_fingerprint_invalid'
    ),
    updatedAt: requiredPositiveInteger(
      row.updated_at,
      'control_generated_lookup_hmac_updated_at_invalid'
    ),
  };
  const previousValues = [
    row.previous_slot,
    row.previous_key_id,
    row.previous_fingerprint,
    row.previous_generation,
  ];
  if (previousValues.some((value) => value !== null)) {
    if (previousValues.some((value) => value === null)) {
      throw new Error('control_generated_lookup_hmac_previous_key_incomplete');
    }
    result.previousSlot = requiredSlot(
      row.previous_slot,
      'control_generated_lookup_hmac_previous_slot_invalid'
    );
    result.previousKeyId = requiredKeyId(
      row.previous_key_id,
      'control_generated_lookup_hmac_previous_key_invalid'
    );
    result.previousFingerprint = requiredFingerprint(
      row.previous_fingerprint,
      'control_generated_lookup_hmac_previous_fingerprint_invalid'
    );
    result.previousGeneration = requiredPositiveInteger(
      row.previous_generation,
      'control_generated_lookup_hmac_previous_generation_invalid'
    );
    if (
      result.previousSlot === result.activeSlot ||
      result.previousKeyId === result.activeKeyId ||
      result.previousFingerprint === result.activeFingerprint ||
      result.previousGeneration >= result.activeGeneration
    ) {
      throw new Error('control_generated_lookup_hmac_key_state_conflict');
    }
  }
  return result;
}

function parseControlGeneratedKeyRows(
  rows: readonly ControlGeneratedKeyRow[]
): ControlKeyState | undefined {
  if (rows.length === 0) return undefined;
  const lookupRows = rows.filter((row) => row.row_kind === 'lookup_hmac');
  if (
    lookupRows.length !== 1 ||
    rows.some((row) => row.row_kind !== 'signing' && row.row_kind !== 'lookup_hmac')
  ) {
    throw new Error('control_generated_key_state_incomplete');
  }
  return {
    runtimeRegistry: parseSigningKeyState(rows, 'runtime_registry'),
    smokeRpc: parseSigningKeyState(rows, 'smoke_rpc'),
    lookupHmac: parseLookupHmacKeyState(lookupRows[0]),
  };
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseControlGeneratedD1Rows(
  rows: readonly ControlGeneratedD1Row[]
): ControlGeneratedD1Binding[] {
  const bindings = new Map<string, ControlGeneratedD1Binding>();
  for (const row of rows) {
    if (
      typeof row.binding_name !== 'string' ||
      !isControlGeneratedDatabaseBinding(row.binding_name)
    ) {
      throw new Error('control_generated_d1_invalid_binding');
    }
    if (
      typeof row.deterministic_name !== 'string' ||
      !SAFE_DATABASE_NAME.test(row.deterministic_name)
    ) {
      throw new Error(`control_generated_d1_invalid_name:${row.binding_name}`);
    }
    if (
      row.observed_state !== 'present' ||
      typeof row.provider_resource_id !== 'string' ||
      !SAFE_DATABASE_ID.test(row.provider_resource_id)
    ) {
      throw new Error(`control_generated_d1_binding_not_ready:${row.binding_name}`);
    }
    if (!['ready', 'active'].includes(String(row.provisioning_state))) {
      throw new Error(`control_generated_d1_invalid_state:${row.binding_name}`);
    }
    const binding = {
      binding: row.binding_name,
      name: row.deterministic_name,
      id: row.provider_resource_id,
    };
    const previous = bindings.get(binding.binding);
    if (previous && (previous.name !== binding.name || previous.id !== binding.id)) {
      throw new Error(`control_generated_d1_binding_conflict:${binding.binding}`);
    }
    bindings.set(binding.binding, binding);
  }
  return [...bindings.values()].sort((left, right) => left.binding.localeCompare(right.binding));
}

export async function loadControlGeneratedD1Bindings(input: {
  controlDatabaseName: string;
  environmentId: string;
  query?: typeof queryD1Rows;
}): Promise<ControlGeneratedD1Binding[]> {
  if (!input.controlDatabaseName.trim()) throw new Error('control_database_name_required');
  if (!SAFE_ENVIRONMENT_ID.test(input.environmentId)) {
    throw new Error('invalid_control_generated_environment_id');
  }
  const query = input.query ?? queryD1Rows;
  const rows = await query<ControlGeneratedD1Row>(
    input.controlDatabaseName,
    `SELECT DISTINCT
       b.binding_name,
       d.deterministic_name,
       o.provider_resource_id,
       o.observed_state,
       d.provisioning_state
     FROM control_desired_worker_binding_export b
     JOIN control_desired_resources d
       ON d.environment_id = b.environment_id
      AND d.desired_resource_id = b.logical_resource_id
     LEFT JOIN control_observed_resources o
       ON o.environment_id = d.environment_id
      AND o.desired_resource_id = d.desired_resource_id
     WHERE b.environment_id = ${sqlString(input.environmentId)}
       AND b.binding_kind = 'd1'
       AND b.binding_name LIKE 'TDB_%'
     ORDER BY b.binding_name`
  );
  return parseControlGeneratedD1Rows(rows);
}

export async function loadControlGeneratedKeyState(input: {
  controlDatabaseName: string;
  environmentId: string;
  query?: typeof queryD1Rows;
}): Promise<ControlKeyState | undefined> {
  if (!input.controlDatabaseName.trim()) throw new Error('control_database_name_required');
  if (!SAFE_ENVIRONMENT_ID.test(input.environmentId)) {
    throw new Error('invalid_control_generated_environment_id');
  }
  const query = input.query ?? queryD1Rows;
  const rows = await query<ControlGeneratedKeyRow>(
    input.controlDatabaseName,
    `SELECT
       'signing' AS row_kind,
       key_purpose,
       upper(slot) AS slot,
       key_id,
       public_key_fingerprint AS fingerprint,
       state AS key_state,
       NULL AS state_revision,
       NULL AS generation,
       NULL AS previous_slot,
       NULL AS previous_key_id,
       NULL AS previous_fingerprint,
       NULL AS previous_generation,
       updated_at
     FROM control_signing_key_metadata
     WHERE environment_id = ${sqlString(input.environmentId)}
       AND state IN ('active', 'previous')
     UNION ALL
     SELECT
       'lookup_hmac' AS row_kind,
       'lookup_hmac' AS key_purpose,
       current_key_slot AS slot,
       current_key_id AS key_id,
       current_key_fingerprint AS fingerprint,
       rotation_state AS key_state,
       state_revision,
       current_key_generation AS generation,
       previous_key_slot AS previous_slot,
       previous_key_id,
       previous_key_fingerprint,
       previous_key_generation,
       updated_at
     FROM control_lookup_hmac_key_states
     WHERE environment_id = ${sqlString(input.environmentId)}
     ORDER BY row_kind, key_purpose, key_state, slot`
  );
  return parseControlGeneratedKeyRows(rows);
}

export async function loadControlStagedSigningKeys(input: {
  controlDatabaseName: string;
  environmentId: string;
  query?: typeof queryD1Rows;
}): Promise<ControlStagedSigningKey[]> {
  if (!input.controlDatabaseName.trim()) throw new Error('control_database_name_required');
  if (!SAFE_ENVIRONMENT_ID.test(input.environmentId)) {
    throw new Error('invalid_control_generated_environment_id');
  }
  const query = input.query ?? queryD1Rows;
  const rows = await query<ControlGeneratedKeyRow>(
    input.controlDatabaseName,
    `SELECT
       'signing' AS row_kind,
       key_purpose,
       upper(slot) AS slot,
       key_id,
       public_key_fingerprint AS fingerprint,
       state AS key_state,
       NULL AS state_revision,
       NULL AS generation,
       NULL AS previous_slot,
       NULL AS previous_key_id,
       NULL AS previous_fingerprint,
       NULL AS previous_generation,
       updated_at
     FROM control_signing_key_metadata
     WHERE environment_id = ${sqlString(input.environmentId)}
       AND state = 'staged'
     ORDER BY key_purpose, slot`
  );
  const seen = new Set<ControlStagedSigningKey['purpose']>();
  return rows.map((row) => {
    if (
      row.row_kind !== 'signing' ||
      (row.key_purpose !== 'runtime_registry' && row.key_purpose !== 'smoke_rpc') ||
      row.key_state !== 'staged' ||
      seen.has(row.key_purpose)
    ) {
      throw new Error('control_generated_staged_signing_key_invalid');
    }
    seen.add(row.key_purpose);
    return {
      purpose: row.key_purpose,
      slot: requiredSlot(row.slot, 'control_generated_staged_signing_slot_invalid'),
      keyId: requiredKeyId(row.key_id, 'control_generated_staged_signing_key_invalid'),
      fingerprint: requiredFingerprint(
        row.fingerprint,
        'control_generated_staged_signing_fingerprint_invalid'
      ),
      updatedAt: requiredPositiveInteger(
        row.updated_at,
        'control_generated_staged_signing_updated_at_invalid'
      ),
    };
  });
}

function canonicalState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalState);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalState(child)])
    );
  }
  return value;
}

function sameState(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalState(left)) === JSON.stringify(canonicalState(right));
}

export function projectControlGeneratedKeyState(
  lock: AuthrimLock,
  keyState: ControlKeyState | undefined
): { lock: AuthrimLock; changed: boolean } {
  if (!keyState) return { lock, changed: false };
  const previous = lock.controlKeyState;
  if (previous) {
    for (const purpose of ['runtimeRegistry', 'smokeRpc'] as const) {
      if (keyState[purpose].updatedAt < previous[purpose].updatedAt) {
        throw new Error(`control_generated_${purpose}_key_state_stale`);
      }
      if (
        keyState[purpose].updatedAt === previous[purpose].updatedAt &&
        !sameState(keyState[purpose], previous[purpose])
      ) {
        throw new Error(`control_generated_${purpose}_key_state_conflict`);
      }
    }
    if (
      keyState.lookupHmac.stateRevision < previous.lookupHmac.stateRevision ||
      keyState.lookupHmac.updatedAt < previous.lookupHmac.updatedAt
    ) {
      throw new Error('control_generated_lookupHmac_key_state_stale');
    }
    if (
      keyState.lookupHmac.stateRevision === previous.lookupHmac.stateRevision &&
      !sameState(keyState.lookupHmac, previous.lookupHmac)
    ) {
      throw new Error('control_generated_lookupHmac_key_state_conflict');
    }
  }
  const changed = !sameState(previous, keyState);
  return {
    lock: changed ? { ...lock, controlKeyState: keyState } : lock,
    changed,
  };
}

export function projectControlGeneratedD1Bindings(
  lock: AuthrimLock,
  bindings: readonly ControlGeneratedD1Binding[]
): { lock: AuthrimLock; added: string[]; removed: string[]; changed: string[] } {
  const nextD1 = Object.fromEntries(
    Object.entries(lock.d1).filter(([binding]) => !isControlGeneratedDatabaseBinding(binding))
  );
  const previousTenantBindings = new Set(
    Object.keys(lock.d1).filter((binding) => isControlGeneratedDatabaseBinding(binding))
  );
  const added: string[] = [];
  const changed: string[] = [];
  for (const binding of bindings) {
    if (!isControlGeneratedDatabaseBinding(binding.binding)) {
      throw new Error('control_generated_d1_invalid_binding');
    }
    const previous = lock.d1[binding.binding];
    if (!previous) added.push(binding.binding);
    else if (previous.id !== binding.id || previous.name !== binding.name) {
      throw new Error(`control_generated_d1_binding_retarget_requires_approval:${binding.binding}`);
    }
    nextD1[binding.binding] = { id: binding.id, name: binding.name };
    previousTenantBindings.delete(binding.binding);
  }
  const removed = [...previousTenantBindings].sort();
  if (removed.length > 0) {
    throw new Error(`control_generated_d1_binding_removal_requires_approval:${removed[0]}`);
  }
  return {
    lock: { ...lock, d1: nextD1 },
    added: added.sort(),
    removed,
    changed: changed.sort(),
  };
}

export async function refreshLockFromControlGeneratedState(input: {
  lock: AuthrimLock;
  environmentId: string;
  query?: typeof queryD1Rows;
}): Promise<{
  lock: AuthrimLock;
  added: string[];
  removed: string[];
  changed: string[];
  keyStateChanged: boolean;
}> {
  const controlDatabaseName = input.lock.d1.CONTROL_DB?.name;
  if (!controlDatabaseName) throw new Error('control_database_name_required');
  const bindings = await loadControlGeneratedD1Bindings({
    controlDatabaseName,
    environmentId: input.environmentId,
    query: input.query,
  });
  const projected = projectControlGeneratedD1Bindings(input.lock, bindings);
  const keyState = await loadControlGeneratedKeyState({
    controlDatabaseName,
    environmentId: input.environmentId,
    query: input.query,
  });
  const keyProjection = projectControlGeneratedKeyState(projected.lock, keyState);
  return {
    ...projected,
    lock: keyProjection.lock,
    keyStateChanged: keyProjection.changed,
  };
}
