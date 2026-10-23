/**
 * The status of one end user's account as the Core database alone holds it, for investigating a
 * sign-in problem without personal data (the PII-free investigation surface).
 *
 * This module is given one Core `DatabaseAdapter` and nothing else: no Hono context, environment
 * or PII adapter reaches it, so it cannot read the PII store. It reads only Core tables and drops
 * the Core columns that may still identify the person: user-chosen names (passkey and device
 * names, TOTP labels, account and subject display labels), IP addresses, user agents, external
 * subject identifiers, contact values and free-text reasons.
 *
 * A part Core does not record is reported as not recorded, never as an empty list or a zero
 * count, so that "unknown here" is not read as "none".
 */
import {
  SIGN_IN_ATTEMPT_FAILED_EVENT,
  SIGN_IN_ATTEMPT_METHODS,
  SIGN_IN_ATTEMPT_REASON_CODES,
  investigationSubjectHashes,
  resolveAccountRegistrationState,
  type DatabaseAdapter,
  type InvestigationSubjectHmacKeys,
} from '@authrim/ar-lib-core';
import { resolveAaguidAuthenticator } from '@authrim/ar-lib-core/webauthn/aaguid-metadata';
import { toMilliseconds, VALID_USER_LIFECYCLE_STATES } from './admin-shared';

/** At most this many devices are listed (the counts cover all of them). */
export const SUBJECT_STATUS_LIST_LIMIT = 50;

const PASSKEY_TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card']);
const DEVICE_PLATFORMS = new Set(['ios', 'android', 'macos', 'windows']);
/**
 * The account states and statuses Core records (authentication lifecycle, deletion, and the
 * custom-claim user lifecycle). Stored values are returned only from these closed sets: anything
 * else is `other`, so no text stored in an account's metadata is echoed.
 */
const ACCOUNT_STATES = new Set([
  'active',
  'inactive',
  'suspended',
  'locked',
  'deleting',
  'deleted',
  ...VALID_USER_LIFECYCLE_STATES,
]);
const TOTP_STATUSES = new Set(['pending', 'active', 'disabled']);

function closed(value: unknown, allowed: ReadonlySet<string>): string {
  return typeof value === 'string' && allowed.has(value) ? value : 'other';
}

/**
 * A part of the status Core does not hold. Sessions live in the session store (Durable Objects);
 * the Core `sessions` table is no longer written. Linked providers live in the PII store; Core's
 * `identity_bindings` is not written by the linking flows.
 */
export interface NotRecordedInCore {
  available: false;
  reason: 'not_recorded_in_core';
}

const NOT_RECORDED_IN_CORE: NotRecordedInCore = {
  available: false,
  reason: 'not_recorded_in_core',
};

export interface SubjectStatus {
  account: {
    registration_state: 'guest' | 'registered';
    is_guest: boolean;
    lifecycle_state: string;
    status: string;
    suspended_at: number | null;
    suspended_until: number | null;
    locked_at: number | null;
    locked_until: number | null;
    created_at: number | null;
    updated_at: number | null;
    last_login_at: number | null;
    guest_deletion_due_at: number | null;
  };
  legal_hold: { active: boolean };
  credentials: {
    password: { configured: boolean };
    /** Whether an email contact is registered and verified; the address is not read. */
    email: { registered: boolean; verified: boolean };
    passkeys: Array<{
      provider_name: string | null;
      transports: string[];
      created_at: number | null;
      last_used_at: number | null;
    }>;
    totp: Array<{
      status: string;
      created_at: number | null;
      activated_at: number | null;
      last_used_at: number | null;
    }>;
  };
  sessions: NotRecordedInCore;
  devices: {
    available: true;
    total: number;
    active: number;
    items: Array<{
      platform: string | null;
      created_at: number | null;
      last_used_at: number | null;
      expires_at: number | null;
      use_count: number;
      active: boolean;
      revoked_at: number | null;
    }>;
  };
  linked_providers: NotRecordedInCore;
}

interface AccountRow {
  id: string;
  lifecycle_state: string;
  registration_state: 'guest' | 'registered' | null;
  primary_subject_id: string | null;
  metadata_json: string | null;
  created_at: number | null;
  updated_at: number | null;
}

function parseObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function metadataTime(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? toMilliseconds(value) : null;
}

function statusOf(lifecycleState: string, metadata: Record<string, unknown>): string {
  if (typeof metadata.status === 'string' && metadata.status.trim()) {
    return closed(metadata.status, ACCOUNT_STATES);
  }
  if (lifecycleState === 'active') return 'active';
  if (['suspended', 'locked', 'deleted'].includes(lifecycleState)) return lifecycleState;
  return 'inactive';
}

function transportsOf(value: string | null): string[] {
  let parsed: unknown = [];
  try {
    parsed = value ? (JSON.parse(value) as unknown) : [];
  } catch {
    parsed = [];
  }
  return Array.isArray(parsed)
    ? [
        ...new Set(
          (parsed as unknown[]).filter(
            (item): item is string => typeof item === 'string' && PASSKEY_TRANSPORTS.has(item)
          )
        ),
      ]
    : [];
}

/**
 * The status of `userId`'s end-user account in `tenantId`, read from `core` alone. null when the
 * tenant has no end-user account for the user in this database: admin and service accounts are
 * not end users, so they are not answered for here.
 */
export async function readCoreSubjectStatus(
  core: DatabaseAdapter,
  tenantId: string,
  userId: string,
  nowMs: number = Date.now()
): Promise<SubjectStatus | null> {
  const account = await core.queryOne<AccountRow>(
    `SELECT id, lifecycle_state, registration_state, primary_subject_id,
            metadata_json, created_at, updated_at
       FROM identity_accounts
      WHERE tenant_id = ? AND legacy_user_id = ? AND account_type = 'user'
      LIMIT 1`,
    [tenantId, userId]
  );
  if (!account) return null;

  const [guestLifecycle, legalHold, emailContacts, passkeys, totp, devices] = await Promise.all([
    core.queryOne<{ phase: string; deletion_due_at: number | null }>(
      `SELECT phase, deletion_due_at FROM guest_account_lifecycle
        WHERE tenant_id = ? AND user_id = ?`,
      [tenantId, userId]
    ),
    core.queryOne<{ id: string }>(
      `SELECT id FROM legal_holds
        WHERE tenant_id = ? AND subject_type = 'account' AND subject_id = ? AND state = 'active'
        LIMIT 1`,
      [tenantId, account.id]
    ),
    // Only the presence and verification of an email contact point, never its value (held in
    // the PII store).
    account.primary_subject_id
      ? core.query<{ verification_state: string }>(
          `SELECT verification_state FROM contact_points
            WHERE tenant_id = ? AND subject_id = ? AND (account_id = ? OR account_id IS NULL)
              AND contact_type = 'email' AND lifecycle_state = 'active'`,
          [tenantId, account.primary_subject_id, account.id]
        )
      : Promise.resolve([] as Array<{ verification_state: string }>),
    core.query<{
      aaguid: string | null;
      transports: string | null;
      created_at: number | null;
      last_used_at: number | null;
    }>(
      `SELECT aaguid, transports, created_at, last_used_at FROM passkeys
        WHERE tenant_id = ? AND user_id = ?
        ORDER BY created_at DESC`,
      [tenantId, userId]
    ),
    core.query<{
      status: string;
      created_at: number | null;
      activated_at: number | null;
      last_used_at: number | null;
    }>(
      `SELECT status, created_at, activated_at, last_used_at FROM totp_credentials
        WHERE tenant_id = ? AND user_id = ?
        ORDER BY created_at DESC`,
      [tenantId, userId]
    ),
    core.query<{
      device_platform: string | null;
      created_at: number | null;
      last_used_at: number | null;
      expires_at: number | null;
      use_count: number | null;
      is_active: number | null;
      revoked_at: number | null;
    }>(
      `SELECT device_platform, created_at, last_used_at, expires_at, use_count, is_active,
              revoked_at
         FROM device_secrets
        WHERE tenant_id = ? AND user_id = ?
        ORDER BY created_at DESC`,
      [tenantId, userId]
    ),
  ]);

  const metadata = parseObject(account.metadata_json);
  const registrationState = resolveAccountRegistrationState(
    account.registration_state ?? 'registered',
    (guestLifecycle?.phase as Parameters<typeof resolveAccountRegistrationState>[1]) ?? null
  );
  const deviceIsActive = (device: (typeof devices)[number]) =>
    device.is_active === 1 &&
    !device.revoked_at &&
    (toMilliseconds(device.expires_at) ?? 0) > nowMs;

  return {
    account: {
      registration_state: registrationState,
      is_guest: registrationState === 'guest',
      lifecycle_state: closed(account.lifecycle_state, ACCOUNT_STATES),
      status: statusOf(account.lifecycle_state, metadata),
      suspended_at: metadataTime(metadata, 'suspended_at'),
      suspended_until: metadataTime(metadata, 'suspended_until'),
      locked_at: metadataTime(metadata, 'locked_at'),
      locked_until: metadataTime(metadata, 'locked_until'),
      created_at: toMilliseconds(account.created_at),
      updated_at: toMilliseconds(account.updated_at),
      last_login_at: metadataTime(metadata, 'last_login_at'),
      guest_deletion_due_at: toMilliseconds(guestLifecycle?.deletion_due_at ?? null),
    },
    legal_hold: { active: legalHold !== null },
    credentials: {
      password: {
        configured: typeof metadata.password_hash === 'string' && metadata.password_hash !== '',
      },
      email: {
        registered: emailContacts.length > 0,
        verified: emailContacts.some((contact) => contact.verification_state === 'verified'),
      },
      passkeys: passkeys.map((passkey) => ({
        provider_name: resolveAaguidAuthenticator(passkey.aaguid)?.name ?? null,
        transports: transportsOf(passkey.transports),
        created_at: toMilliseconds(passkey.created_at),
        last_used_at: toMilliseconds(passkey.last_used_at),
      })),
      totp: totp.map((credential) => ({
        status: closed(credential.status, TOTP_STATUSES),
        created_at: toMilliseconds(credential.created_at),
        activated_at: toMilliseconds(credential.activated_at),
        last_used_at: toMilliseconds(credential.last_used_at),
      })),
    },
    sessions: NOT_RECORDED_IN_CORE,
    devices: {
      available: true,
      total: devices.length,
      active: devices.filter(deviceIsActive).length,
      items: devices.slice(0, SUBJECT_STATUS_LIST_LIMIT).map((device) => ({
        platform: device.device_platform
          ? DEVICE_PLATFORMS.has(device.device_platform)
            ? device.device_platform
            : 'other'
          : null,
        created_at: toMilliseconds(device.created_at),
        last_used_at: toMilliseconds(device.last_used_at),
        expires_at: toMilliseconds(device.expires_at),
        use_count: Number(device.use_count ?? 0),
        active: deviceIsActive(device),
        revoked_at: toMilliseconds(device.revoked_at),
      })),
    },
    linked_providers: NOT_RECORDED_IN_CORE,
  };
}

/** At most this many recent attempts are listed, newest first. */
export const RECENT_ATTEMPTS_LIMIT = 20;

export type RecentSignInAttempts =
  | {
      available: true;
      /**
       * Only attempts made within a Flow interaction are recorded: sign-ins outside one (direct
       * API sign-in, IdP-initiated SAML, re-authentication pages) are not counted here.
       */
      coverage: 'flow_interactions';
      /** Every recorded failure of the account still held in D1, so a burst cannot hide others. */
      total: number;
      /** Whether `items` leaves out older attempts (`total` is larger). */
      truncated: boolean;
      /** The failures by method and reason, with their first and last time. */
      summary: Array<{
        method: string;
        reason_code: string;
        count: number;
        first_at: number | null;
        last_at: number | null;
      }>;
      items: Array<{
        created_at: number | null;
        method: string;
        result: 'failure';
        reason_code: string;
      }>;
    }
  | { available: false; reason: 'key_unavailable' };

/**
 * The account's recent failed sign-in attempts, from the tenant's Core database holding Flow
 * interactions (`flowCore`). Records carry only the account's subject hash, so they are found by
 * hashing the account with every key of the investigation keyring. Without a keyring nothing can
 * be found, which is reported as unavailable rather than as no attempts.
 */
// The Flow node an attempt was at is not returned: node IDs are chosen by a Flow's author and may
// carry private text.
export async function readRecentSignInAttempts(
  flowCore: DatabaseAdapter,
  keys: InvestigationSubjectHmacKeys | null,
  tenantId: string,
  userId: string
): Promise<RecentSignInAttempts> {
  if (!keys) return { available: false, reason: 'key_unavailable' };
  const hashes = await investigationSubjectHashes(keys, tenantId, userId);
  const match = `tenant_id = ? AND event_type = ? AND subject_hash IN (${hashes.map(() => '?').join(', ')})`;
  const params = [tenantId, SIGN_IN_ATTEMPT_FAILED_EVENT, ...hashes];
  const [rows, groups] = await Promise.all([
    flowCore.query<{
      created_at: number | null;
      method: string | null;
      reason_code: string | null;
    }>(
      `SELECT created_at, method, reason_code
         FROM flow_audit_events
        WHERE ${match}
        ORDER BY created_at DESC
        LIMIT ?`,
      [...params, RECENT_ATTEMPTS_LIMIT]
    ),
    // Grouped by the returned (closed) values in SQL, so stored values outside the vocabulary add
    // up under `other` and the groups are bounded by the vocabularies.
    flowCore.query<{
      method: string | null;
      reason_code: string | null;
      count: number;
      first_at: number | null;
      last_at: number | null;
    }>(
      `SELECT CASE WHEN method IN (${placeholders(SIGN_IN_ATTEMPT_METHODS)}) THEN method
                   ELSE 'other' END AS method,
              CASE WHEN reason_code IN (${placeholders(SIGN_IN_ATTEMPT_REASON_CODES)})
                   THEN reason_code ELSE 'other' END AS reason_code,
              COUNT(*) AS count, MIN(created_at) AS first_at, MAX(created_at) AS last_at
         FROM flow_audit_events
        WHERE ${match}
        GROUP BY 1, 2`,
      [...SIGN_IN_ATTEMPT_METHODS, ...SIGN_IN_ATTEMPT_REASON_CODES, ...params]
    ),
  ]);
  // The SQL already maps to the closed sets; mapping again keeps the returned values closed
  // whatever a database returns.
  const summary = new Map<string, RecentSummaryEntry>();
  for (const group of groups) {
    const method = closed(group.method, SIGN_IN_ATTEMPT_METHOD_SET);
    const reasonCode = closed(group.reason_code, SIGN_IN_ATTEMPT_REASON_SET);
    const firstAt = toMilliseconds(group.first_at);
    const lastAt = toMilliseconds(group.last_at);
    const entry = summary.get(`${method}\u0000${reasonCode}`);
    if (!entry) {
      summary.set(`${method}\u0000${reasonCode}`, {
        method,
        reason_code: reasonCode,
        count: Number(group.count),
        first_at: firstAt,
        last_at: lastAt,
      });
      continue;
    }
    entry.count += Number(group.count);
    entry.first_at = earliest(entry.first_at, firstAt);
    entry.last_at = latest(entry.last_at, lastAt);
  }
  const total = [...summary.values()].reduce((sum, entry) => sum + entry.count, 0);
  return {
    available: true,
    coverage: 'flow_interactions',
    total,
    truncated: total > rows.length,
    summary: [...summary.values()].sort(
      (left, right) => (right.last_at ?? 0) - (left.last_at ?? 0)
    ),
    items: rows.map((row) => ({
      created_at: toMilliseconds(row.created_at),
      method: closed(row.method, SIGN_IN_ATTEMPT_METHOD_SET),
      result: 'failure',
      reason_code: closed(row.reason_code, SIGN_IN_ATTEMPT_REASON_SET),
    })),
  };
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

type RecentSummaryEntry = Extract<RecentSignInAttempts, { available: true }>['summary'][number];

function earliest(left: number | null, right: number | null): number | null {
  return left === null ? right : right === null ? left : Math.min(left, right);
}

function latest(left: number | null, right: number | null): number | null {
  return left === null ? right : right === null ? left : Math.max(left, right);
}

const SIGN_IN_ATTEMPT_METHOD_SET: ReadonlySet<string> = new Set(SIGN_IN_ATTEMPT_METHODS);
const SIGN_IN_ATTEMPT_REASON_SET: ReadonlySet<string> = new Set(SIGN_IN_ATTEMPT_REASON_CODES);
