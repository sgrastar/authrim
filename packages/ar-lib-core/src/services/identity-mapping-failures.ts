import type { DatabaseAdapter } from '../db/adapter';
import type { Env } from '../types/env';
import { IDENTITY_MAPPING_SET_ID_MAX_LENGTH } from '../types/settings/identity-mapping';
import { requireDedicatedAdminDatabaseAdapter } from './admin-database-adapter';
import type { IdentityMappingTier } from './identity-mapping-set-binding';

/** Only configuration identifiers and fixed codes: never an Error, selector or claim value. */
export interface IdentityMappingFailureContext {
  code?: string;
  tier?: IdentityMappingTier;
  setId?: string;
}

export interface IdentityMappingFailureRow {
  id: string;
  tenant_id: string;
  client_id: string;
  code: string;
  tier: IdentityMappingTier | null;
  set_id: string | null;
  first_at: number;
  last_at: number;
  count: number;
}

/** Kept explicit so an exception message or an unexpected code cannot become stored data. */
const FAILURE_CODES: ReadonlySet<string> = new Set([
  'default_setting_invalid',
  'client_selector_invalid',
  'settings_unreadable',
  'set_missing',
  'set_inactive',
  'destination_profile_invalid',
  'admin_database_unavailable',
  'policy.invalid_destination_profile_binding',
  'policy.identity_mapping_failed',
  'policy.missing_destination_subject',
  'policy.persistent_identifier_profile_not_found',
  'policy.persistent_identifier_profile_unsupported_mode',
  'policy.persistent_identifier_secret_missing',
  'policy.identity_mapping_reserved_subject',
  'policy.missing_identity_mapping_binding',
  'policy.invalid_default_identity_mapping',
  'policy.invalid_client_identity_mapping',
]);

function code(value: unknown): string {
  return typeof value === 'string' && FAILURE_CODES.has(value) ? value : 'mapping_failed';
}

function tier(value: unknown): IdentityMappingTier | null {
  return value === 'client' || value === 'tenant_default' || value === 'platform_default'
    ? value
    : null;
}

function setId(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length <= IDENTITY_MAPPING_SET_ID_MAX_LENGTH &&
    value.toLowerCase() !== 'none' &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value)
    ? value
    : null;
}

function validIdentifier(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value === value.trim() &&
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  );
}

export interface RecordIdentityMappingFailureInput {
  tenantId: string;
  clientId: string;
  code: string;
  tier?: IdentityMappingTier;
  setId?: string;
  /** Unix milliseconds. A clock rollback updates first/last without losing the count. */
  now?: number;
}

/** One SQL statement counts exactly one observed failure for the canonical nullable tuple. */
export async function recordIdentityMappingFailure(
  adapter: Pick<DatabaseAdapter, 'execute'>,
  input: RecordIdentityMappingFailureInput
): Promise<void> {
  const now = input.now ?? Date.now();
  if (
    !validIdentifier(input.tenantId, 128) ||
    !validIdentifier(input.clientId, 256) ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new Error('identity_mapping_failure_invalid');
  const failure = { code: code(input.code), tier: tier(input.tier), setId: setId(input.setId) };
  // JSON preserves tuple boundaries and nulls, unlike delimiter concatenation or NULL UNIQUE keys.
  const canonical = JSON.stringify([
    input.tenantId,
    input.clientId,
    failure.code,
    failure.tier,
    failure.setId,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const id = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const result = await adapter.execute(
    `INSERT INTO identity_mapping_failures
       (id,tenant_id,client_id,code,tier,set_id,first_at,last_at,count)
     VALUES (?,?,?,?,?,?,?,?,1)
     ON CONFLICT(id) DO UPDATE SET
       first_at=min(identity_mapping_failures.first_at,excluded.first_at),
       last_at=max(identity_mapping_failures.last_at,excluded.last_at),
       count=identity_mapping_failures.count+1
     WHERE identity_mapping_failures.tenant_id=excluded.tenant_id
       AND identity_mapping_failures.client_id=excluded.client_id
       AND identity_mapping_failures.code=excluded.code
       AND identity_mapping_failures.tier IS excluded.tier
       AND identity_mapping_failures.set_id IS excluded.set_id`,
    [id, input.tenantId, input.clientId, failure.code, failure.tier, failure.setId, now, now]
  );
  if (!result.success || result.rowsAffected !== 1)
    throw new Error('identity_mapping_failure_unavailable');
}

/** Best-effort telemetry only. Without a request lifetime there is no detached database work. */
export function scheduleIdentityMappingFailure(input: {
  env: Partial<Pick<Env, 'DB_ADMIN'>>;
  tenantId: string;
  clientId: string;
  failure: IdentityMappingFailureContext;
  /** Obtain through getWaitUntilFromContext so the request context remains bound. */
  waitUntil?: (promise: Promise<unknown>) => void;
}): void {
  try {
    if (!input.waitUntil) return;
    const observed = {
      tenantId: input.tenantId,
      clientId: input.clientId,
      code: code(input.failure.code),
      tier: tier(input.failure.tier) ?? undefined,
      setId: setId(input.failure.setId) ?? undefined,
      now: Date.now(),
    };
    let registered = false;
    const work = Promise.resolve()
      .then(() => {
        if (!registered) return;
        return recordIdentityMappingFailure(
          requireDedicatedAdminDatabaseAdapter(input.env, 'identity-mapping-failures'),
          observed
        );
      })
      .catch(() => {
        // Do not log the database exception: it may carry row values or binding details.
      });
    input.waitUntil(work);
    registered = true;
  } catch {
    // Reading bindings or registering after-response work must never replace the issue response.
  }
}
