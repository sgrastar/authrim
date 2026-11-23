/**
 * Admin step-up: which admin operations need fresh evidence (L1, L2), and the single-use receipts
 * that let an L2 operation through.
 *
 * - L0: a valid session. Every operation not in the catalog below.
 * - L1: a passkey verified within the fresh-auth window (sign-in or in-session re-authentication).
 * - L2: a fresh passkey and a fresh, independent second factor. Proven by a receipt bound to the
 *   admin, the session, the home and target tenants, the level and the server-built operation
 *   hash, used once.
 *
 * The catalog is the floor: a tenant may raise an operation (`security.admin_step_up_overrides`)
 * but never lower it. Only a human admin session can meet L1 or L2; machine and agent callers
 * are refused for those operations.
 *
 * An L2 request first leaves a requirement (`createAdminStepUpRequirement`). The receipt is issued
 * against it once the session's evidence is fresh, by consuming it: concurrent issuance yields one
 * receipt. Evidence that is not yet fresh leaves the requirement in place, so the admin can
 * re-authenticate and ask again.
 */

import type { Env } from '../types/env';
import type { AdminAuthContext } from '../types/admin';
import type {
  Challenge,
  ChallengeType,
  StoreChallengeRequest,
} from '../durable-objects/ChallengeStore';
import { arrayBufferToBase64Url, generateSecureRandomString } from '../utils/crypto';
import { getChallengeStoreByChallengeId } from '../utils/challenge-sharding';

export type AdminStepUpLevel = 'L0' | 'L1' | 'L2';

/** The tenant setting holding an operation → level map that raises the catalog. */
export const ADMIN_STEP_UP_OVERRIDES_KEY = 'security.admin_step_up_overrides';

/** How long a verified factor counts as fresh, and how long an L2 receipt may live at most. */
export const ADMIN_STEP_UP_EVIDENCE_WINDOW_MS = 5 * 60 * 1000;
export const ADMIN_STEP_UP_REQUIREMENT_TTL_SECONDS = 5 * 60;
export const ADMIN_STEP_UP_RECEIPT_TTL_SECONDS = 2 * 60;

/** The request header that carries an L2 receipt. */
export const ADMIN_STEP_UP_RECEIPT_HEADER = 'authrim-step-up-receipt';

const REQUIREMENT_TYPE: ChallengeType = 'admin_step_up_requirement';
const RECEIPT_TYPE: ChallengeType = 'admin_step_up_receipt';
const REQUIREMENT_PREFIX = 'asr_';
const RECEIPT_PREFIX = 'asp_';
const ID_PATTERN = /^as[rp]_[A-Za-z0-9_-]{32,64}$/u;

/**
 * The operations that need more than a session, at their lowest level. Operations not listed are
 * L0; a route that is not wired to the gate is not protected whatever is listed here.
 */
export const ADMIN_STEP_UP_OPERATIONS = {
  'client.secret.rotate': 'L1',
  'client.trust.activate': 'L2',
  'client.trust.disable': 'L1',
  'sessions.revoke_all': 'L1',
  'admin.passkey.add': 'L1',
  'tenant.delete': 'L2',
  'admin.role.grant': 'L2',
  'admin.role.revoke': 'L2',
  'signing_key.rotate': 'L2',
  'federation.trust.update': 'L2',
  'federation.trust.activate': 'L2',
  'federation.trust.disable': 'L1',
  'dr.restore': 'L2',
  'tenant.jurisdiction.update': 'L2',
  'webhook.destination.update': 'L2',
  'admin.second_factor.add': 'L2',
  'admin.second_factor.remove': 'L2',
  'audit.retention.shorten': 'L2',
  'admin_step_up.policy.relax': 'L2',
  'admin.grace.extend': 'L2',
  'admin.recovery.settings.update': 'L2',
  'admin_credential.revoke': 'L2',
  // Changing which wallet types may authenticate for credential issuance, or the roots they are
  // trusted through.
  'wallet_allowlist.update': 'L2',
  'machine.permission.grant': 'L2',
  'admin.email.update': 'L2',
  // Publishing a logging policy settles where logs go and, by replacing the routing rules for the
  // scopes it covers, which retention applies.
  'logging.policy.publish': 'L2',
  // Exporting logs with their sensitive detail or payload.
  'log.sensitive.export': 'L2',
  // Turning on the platform switch that lets a machine principal receive an admin invitation's
  // enrollment code in the API response instead of by e-mail.
  'admin_invitation.code_handoff.enable': 'L2',
  // Taking a tenant off the platform's list of tenants an all-tenants machine scope does not
  // include (`machine_access.all_scope_excluded_tenants`), or emptying the list.
  'machine_access.excluded_tenants.relax': 'L2',
  // Naming a protected tenant (one a machine's all-tenants scope does not include) in a machine
  // principal's or credential's tenant scope, and creating or changing a platform principal.
  'machine.protected_grant': 'L2',
} as const satisfies Record<string, Exclude<AdminStepUpLevel, 'L0'>>;

/**
 * Operations the platform's enforcement switch (`security.admin_step_up_enforced`) never turns
 * off: turning it off is itself one of them, and the second-factor operations were protected
 * before the switch existed.
 */
export const ADMIN_STEP_UP_ALWAYS_ENFORCED: ReadonlySet<AdminStepUpOperation> = new Set([
  'admin_step_up.policy.relax',
  // The roots a wallet is trusted through: never switched off, never exempt for a machine.
  'wallet_allowlist.update',
  'admin.second_factor.add',
  'admin.second_factor.remove',
  // A machine can never switch the code handoff on, exemption or not.
  'admin_invitation.code_handoff.enable',
  // A machine can never lift the protection of a tenant, exemption or not.
  'machine_access.excluded_tenants.relax',
  // Never switched off, never exempt: these grants are made by a signed-in platform admin only.
  'machine.protected_grant',
]);

/** The platform setting that turns route enforcement on (default) or, during a migration, off. */
export const ADMIN_STEP_UP_ENFORCED_KEY = 'security.admin_step_up_enforced';

/** The platform setting that lets admins present Keyring through the browser's DC API. */
export const ADMIN_KEYRING_DC_API_KEY = 'security.admin_keyring_dc_api';

// =============================================================================
// Allowed second-factor kinds
// =============================================================================

/** The tenant setting that lists which kinds of second factor satisfy L2 in that tenant. */
export const ADMIN_SECOND_FACTOR_ALLOWED_KINDS_KEY = 'security.admin_second_factor_allowed_kinds';

/**
 * How strong a second factor is, as a tenant names it in the allowed list:
 * - `hardware`: a device-bound security key, or the holder key of a Keyring credential.
 * - `totp`: a code from an authenticator app. Independent of the passkey, but a person can be
 *   tricked into typing it, and a copy of its secret works anywhere.
 * A synced passkey is no kind: it is refused outright, not a strength a tenant can allow.
 */
export type AdminSecondFactorStrength = 'hardware' | 'totp';

export const ADMIN_SECOND_FACTOR_STRENGTHS: readonly AdminSecondFactorStrength[] = [
  'hardware',
  'totp',
];

/** What a tenant allows until it says otherwise. */
export const DEFAULT_ADMIN_SECOND_FACTOR_ALLOWED_KINDS: readonly AdminSecondFactorStrength[] = [
  'hardware',
];

/** The strength of a stored second-factor kind, or null for a kind this code does not know. */
export function adminSecondFactorStrength(kind: string): AdminSecondFactorStrength | null {
  switch (kind) {
    case 'webauthn_credential':
    case 'keyring_holder_key':
      return 'hardware';
    case 'totp':
      return 'totp';
    default:
      return null;
  }
}

function isSecondFactorStrength(value: unknown): value is AdminSecondFactorStrength {
  return value === 'hardware' || value === 'totp';
}

/**
 * The problem with a value for `security.admin_second_factor_allowed_kinds`, or null: a list of
 * known strengths without duplicates that always includes `hardware`, so a tenant cannot lock
 * every admin out of L2 by emptying it.
 */
export function adminSecondFactorAllowedKindsProblem(value: unknown): string | null {
  const key = ADMIN_SECOND_FACTOR_ALLOWED_KINDS_KEY;
  if (!Array.isArray(value)) return `${key} must be a list of second-factor kinds`;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isSecondFactorStrength(entry)) {
      return `${key}: unknown kind ${typeof entry === 'string' ? entry : typeof entry}`;
    }
    if (seen.has(entry)) return `${key}: ${entry} is listed twice`;
    seen.add(entry);
  }
  if (!seen.has('hardware')) return `${key} must include hardware`;
  return null;
}

/**
 * The strengths a tenant allows. A value that is not a valid list is read as the default
 * (hardware only): an unreadable list never widens what is accepted.
 */
export function resolveAdminSecondFactorAllowedKinds(
  value: unknown
): ReadonlySet<AdminSecondFactorStrength> {
  if (adminSecondFactorAllowedKindsProblem(value) !== null) {
    return new Set(DEFAULT_ADMIN_SECOND_FACTOR_ALLOWED_KINDS);
  }
  return new Set(value as AdminSecondFactorStrength[]);
}

/** Whether a second factor of this stored kind satisfies L2 under the allowed strengths. */
export function isAdminSecondFactorKindAllowed(
  kind: string,
  allowed: ReadonlySet<AdminSecondFactorStrength>
): boolean {
  const strength = adminSecondFactorStrength(kind);
  return strength !== null && allowed.has(strength);
}

/** The stored second-factor kinds that count under the allowed strengths. */
export function adminSecondFactorKindsAllowedBy(
  allowed: ReadonlySet<AdminSecondFactorStrength>
): string[] {
  const kinds: string[] = [];
  if (allowed.has('hardware')) kinds.push('webauthn_credential', 'keyring_holder_key');
  if (allowed.has('totp')) kinds.push('totp');
  return kinds;
}

/** Whether `after` allows a strength that `before` did not (a change that weakens the policy). */
export function widensAdminSecondFactorKinds(before: unknown, after: unknown): boolean {
  const was = resolveAdminSecondFactorAllowedKinds(before);
  const now = resolveAdminSecondFactorAllowedKinds(after);
  for (const strength of now) if (!was.has(strength)) return true;
  return false;
}

/**
 * The permission that lets a machine principal perform one operation without a human step-up.
 * Held by exact name only: no wildcard (`*`, `admin:*`) carries it.
 */
export function adminStepUpExemptPermission(operation: AdminStepUpOperation): string {
  return `admin:step_up_exempt:${operation}`;
}

export type AdminStepUpOperation = keyof typeof ADMIN_STEP_UP_OPERATIONS;

const LEVEL_RANK: Record<AdminStepUpLevel, number> = { L0: 0, L1: 1, L2: 2 };

export function isAdminStepUpOperation(value: string): value is AdminStepUpOperation {
  return Object.prototype.hasOwnProperty.call(ADMIN_STEP_UP_OPERATIONS, value);
}

function isRaisableLevel(value: unknown): value is 'L1' | 'L2' {
  return value === 'L1' || value === 'L2';
}

/**
 * The problem with a value for `security.admin_step_up_overrides`, or null: an object of known
 * operations to L1 or L2, none below the operation's own level.
 */
export function adminStepUpOverridesProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return `${ADMIN_STEP_UP_OVERRIDES_KEY} must be an object of operation to L1 or L2`;
  }
  for (const [operation, level] of Object.entries(value)) {
    if (!isAdminStepUpOperation(operation)) {
      return `${ADMIN_STEP_UP_OVERRIDES_KEY}: unknown operation ${operation}`;
    }
    if (!isRaisableLevel(level)) {
      return `${ADMIN_STEP_UP_OVERRIDES_KEY}: ${operation} must be L1 or L2`;
    }
    if (LEVEL_RANK[level] < LEVEL_RANK[ADMIN_STEP_UP_OPERATIONS[operation]]) {
      return `${ADMIN_STEP_UP_OVERRIDES_KEY}: ${operation} cannot be lowered below ${ADMIN_STEP_UP_OPERATIONS[operation]}`;
    }
  }
  return null;
}

/**
 * The level an operation needs: the catalog's, raised by the tenant's override when that is
 * higher. Anything unreadable in the overrides is ignored (it can only raise, never lower).
 */
export function resolveAdminStepUpLevel(
  operation: AdminStepUpOperation,
  overrides?: unknown
): Exclude<AdminStepUpLevel, 'L0'> {
  const floor = ADMIN_STEP_UP_OPERATIONS[operation];
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return floor;
  const entries = new Map<string, unknown>(Object.entries(overrides));
  const raised = entries.get(operation);
  // The old trust operation protected containment too. A missing new override inherits that
  // tenant decision; an explicit new override can deliberately choose the new catalog floor.
  const inherited =
    (operation === 'federation.trust.activate' || operation === 'federation.trust.disable') &&
    !isRaisableLevel(raised)
      ? entries.get('federation.trust.update')
      : undefined;
  const requested = isRaisableLevel(raised) ? raised : inherited;
  return isRaisableLevel(requested) && LEVEL_RANK[requested] > LEVEL_RANK[floor]
    ? requested
    : floor;
}

// =============================================================================
// Operation hash
// =============================================================================

export interface AdminStepUpOperationDescriptor {
  operation: AdminStepUpOperation;
  /** The tenant the operation acts on. */
  targetTenantId: string;
  /** The resources it acts on; order and duplicates do not matter. */
  targetIds?: string[];
  /** What it does to them (the request's effective parameters). */
  params?: Record<string, unknown>;
  /** The version of the resource it was built against, when the resource has one. */
  resourceVersion?: string | number;
  /**
   * Other catalog operations this same request also performs (e.g. a destination change that
   * also shortens retention). The request needs the highest level among all of them, and a
   * machine principal needs the exemption for each, so one exempt operation cannot carry another.
   */
  alsoCovers?: AdminStepUpOperation[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    // No prototype, so a `__proto__` key is kept as data like any other.
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) sorted[key] = canonicalize(entry);
    }
    return sorted;
  }
  return value;
}

/**
 * The hash a receipt is bound to, built by the server from what the operation will do: key order
 * in the parameters and the order of the target IDs do not change it; any value does.
 */
export async function createAdminStepUpOperationHash(
  descriptor: AdminStepUpOperationDescriptor
): Promise<string> {
  const canonical = JSON.stringify(
    canonicalize({
      v: 1,
      operation: descriptor.operation,
      target_tenant_id: descriptor.targetTenantId,
      target_ids: [...new Set(descriptor.targetIds ?? [])].sort(),
      params: descriptor.params ?? {},
      resource_version: descriptor.resourceVersion ?? null,
      // Present only when used, so descriptors without it hash as before.
      ...(descriptor.alsoCovers && descriptor.alsoCovers.length > 0
        ? { also_covers: [...new Set(descriptor.alsoCovers)].sort() }
        : {}),
    })
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return arrayBufferToBase64Url(digest);
}

// =============================================================================
// Evidence
// =============================================================================

export type AdminStepUpFactor = 'passkey' | 'second_factor';

export interface AdminStepUpEvidence {
  /** Factors that are missing or no longer fresh for the level. */
  missing: AdminStepUpFactor[];
  /** When the evidence stops being fresh enough for the level (ms), when it is satisfied. */
  freshUntil?: number;
}

/** A human admin session, the only caller that can meet L1 or L2. */
export function isAdminStepUpHumanSession(
  auth: AdminAuthContext
): auth is AdminAuthContext & { sessionId: string } {
  return (
    auth.authMethod === 'session' &&
    (!auth.actorType || auth.actorType === 'human') &&
    typeof auth.sessionId === 'string' &&
    auth.sessionId.length > 0
  );
}

function freshUntil(verifiedAt: number | undefined, now: number): number | null {
  if (typeof verifiedAt !== 'number' || verifiedAt > now) return null;
  const until = verifiedAt + ADMIN_STEP_UP_EVIDENCE_WINDOW_MS;
  return until > now ? until : null;
}

/** Until when (ms) each factor the session verified stays fresh, or null when it is not fresh. */
export interface AdminStepUpFreshness {
  passkeyFreshUntil: number | null;
  secondFactorFreshUntil: number | null;
}

/** How fresh the session's passkey and second factor are now. */
export function describeAdminStepUpFreshness(
  auth: AdminAuthContext,
  now: number
): AdminStepUpFreshness {
  return {
    passkeyFreshUntil:
      auth.mfaVerified === true ? freshUntil(auth.authenticationTimeMs, now) : null,
    secondFactorFreshUntil: auth.secondFactorId
      ? freshUntil(auth.secondFactorVerifiedAtMs, now)
      : null,
  };
}

/**
 * Which factors a human session still needs for a level. L1 needs a fresh passkey; L2 also needs
 * a fresh registered second factor. The evidence holds until the older of the two goes stale.
 */
export function evaluateAdminStepUpEvidence(
  auth: AdminAuthContext,
  level: Exclude<AdminStepUpLevel, 'L0'>,
  now: number
): AdminStepUpEvidence {
  const { passkeyFreshUntil: passkeyUntil, secondFactorFreshUntil: secondFactorUntil } =
    describeAdminStepUpFreshness(auth, now);
  const missing: AdminStepUpFactor[] = [];
  if (passkeyUntil === null) missing.push('passkey');
  let until = passkeyUntil;
  if (level === 'L2') {
    if (secondFactorUntil === null) missing.push('second_factor');
    else if (until !== null) until = Math.min(until, secondFactorUntil);
  }
  return missing.length === 0 && until !== null ? { missing, freshUntil: until } : { missing };
}

// =============================================================================
// Requirements and receipts
// =============================================================================

export interface AdminStepUpBinding {
  adminUserId: string;
  sessionId: string;
  /** The session's own tenant, where the requirement and receipt are kept. */
  homeTenantId: string;
  targetTenantId: string;
  level: Exclude<AdminStepUpLevel, 'L0'>;
  operation: AdminStepUpOperation;
  operationHash: string;
}

interface StoredBinding extends AdminStepUpBinding {
  version: 1;
}

export class AdminStepUpError extends Error {
  constructor(
    readonly code:
      | 'step_up_required'
      | 'invalid_step_up'
      | 'step_up_evidence_required'
      | 'step_up_unavailable',
    message: string,
    readonly missing?: AdminStepUpFactor[]
  ) {
    super(message);
    this.name = 'AdminStepUpError';
  }
}

interface StepUpChallengeStore {
  storeChallengeRpc(request: StoreChallengeRequest): Promise<unknown>;
  getChallengeRpc(id: string): Promise<Challenge | null>;
  consumeChallengeRpc(request: {
    id: string;
    tenantId: string;
    type: ChallengeType;
  }): Promise<{ metadata?: Record<string, unknown> }>;
}

async function store(env: Env, id: string, tenantId: string): Promise<StepUpChallengeStore> {
  const stub: unknown = await getChallengeStoreByChallengeId(env, id, tenantId);
  return stub as StepUpChallengeStore;
}

function newId(prefix: string): string {
  return `${prefix}${generateSecureRandomString(32)}`;
}

function isStoredBinding(value: unknown): value is StoredBinding {
  if (!value || typeof value !== 'object') return false;
  const binding = value as Record<string, unknown>;
  return (
    binding.version === 1 &&
    typeof binding.adminUserId === 'string' &&
    typeof binding.sessionId === 'string' &&
    typeof binding.homeTenantId === 'string' &&
    typeof binding.targetTenantId === 'string' &&
    (binding.level === 'L1' || binding.level === 'L2') &&
    typeof binding.operation === 'string' &&
    typeof binding.operationHash === 'string'
  );
}

function sameBinding(a: AdminStepUpBinding, b: AdminStepUpBinding): boolean {
  return (
    a.adminUserId === b.adminUserId &&
    a.sessionId === b.sessionId &&
    a.homeTenantId === b.homeTenantId &&
    a.targetTenantId === b.targetTenantId &&
    a.level === b.level &&
    a.operation === b.operation &&
    a.operationHash === b.operationHash
  );
}

function bindingOf(binding: AdminStepUpBinding): StoredBinding {
  return {
    version: 1,
    adminUserId: binding.adminUserId,
    sessionId: binding.sessionId,
    homeTenantId: binding.homeTenantId,
    targetTenantId: binding.targetTenantId,
    level: binding.level,
    operation: binding.operation,
    operationHash: binding.operationHash,
  };
}

/** Leave a requirement for an operation that was refused for want of a receipt. */
export async function createAdminStepUpRequirement(
  env: Env,
  binding: AdminStepUpBinding,
  now: number = Date.now()
): Promise<{ stepUpId: string; expiresAt: number }> {
  const stepUpId = newId(REQUIREMENT_PREFIX);
  await (
    await store(env, stepUpId, binding.homeTenantId)
  ).storeChallengeRpc({
    id: stepUpId,
    tenantId: binding.homeTenantId,
    type: REQUIREMENT_TYPE,
    userId: binding.adminUserId,
    challenge: stepUpId,
    ttl: ADMIN_STEP_UP_REQUIREMENT_TTL_SECONDS,
    metadata: { ...bindingOf(binding) },
  });
  return { stepUpId, expiresAt: now + ADMIN_STEP_UP_REQUIREMENT_TTL_SECONDS * 1000 };
}

export interface IssueAdminStepUpReceiptInput {
  stepUpId: string;
  auth: AdminAuthContext;
  /**
   * Whether the session's second factor is still registered and not revoked, checked at issuance
   * for L2 (the session row was read before this request's work began). The binding says which
   * tenant the receipt is for, so the check can also hold the factor's kind to that tenant's
   * allowed second-factor kinds.
   */
  isSecondFactorActive?: (
    adminUserId: string,
    secondFactorId: string,
    binding: AdminStepUpBinding
  ) => Promise<boolean>;
  now?: number;
}

/**
 * Issue the receipt for a requirement left for this admin's session, once the session's evidence
 * meets the requirement's level. The requirement is consumed by the one issuance that succeeds.
 */
export async function issueAdminStepUpReceipt(
  env: Env,
  input: IssueAdminStepUpReceiptInput
): Promise<{ receipt: string; expiresAt: number; binding: AdminStepUpBinding }> {
  const now = input.now ?? Date.now();
  const auth = input.auth;
  const homeTenantId = auth.sessionTenantId;
  if (
    !ID_PATTERN.test(input.stepUpId) ||
    !input.stepUpId.startsWith(REQUIREMENT_PREFIX) ||
    !isAdminStepUpHumanSession(auth) ||
    !homeTenantId
  ) {
    throw new AdminStepUpError('invalid_step_up', 'Step-up request was not found');
  }

  const requirementStore = await store(env, input.stepUpId, homeTenantId);
  const stored = await requirementStore.getChallengeRpc(input.stepUpId);
  if (
    !stored ||
    stored.type !== REQUIREMENT_TYPE ||
    stored.tenantId !== homeTenantId ||
    stored.consumed ||
    stored.expiresAt <= now ||
    !isStoredBinding(stored.metadata) ||
    stored.metadata.adminUserId !== auth.userId ||
    stored.metadata.sessionId !== auth.sessionId ||
    stored.metadata.homeTenantId !== homeTenantId
  ) {
    throw new AdminStepUpError('invalid_step_up', 'Step-up request was not found');
  }
  const binding = stored.metadata;

  const evidence = evaluateAdminStepUpEvidence(auth, binding.level, now);
  if (evidence.missing.length > 0 || evidence.freshUntil === undefined) {
    throw new AdminStepUpError(
      'step_up_evidence_required',
      'Fresh evidence is required for this step-up',
      evidence.missing
    );
  }
  if (binding.level === 'L2') {
    const factorId = auth.secondFactorId;
    if (!factorId || !input.isSecondFactorActive) {
      throw new AdminStepUpError('step_up_evidence_required', 'Second factor is required', [
        'second_factor',
      ]);
    }
    const { version: _version, ...plainBinding } = bindingOf(binding);
    if (!(await input.isSecondFactorActive(auth.userId, factorId, plainBinding))) {
      throw new AdminStepUpError('step_up_evidence_required', 'Second factor was revoked', [
        'second_factor',
      ]);
    }
  }

  try {
    await requirementStore.consumeChallengeRpc({
      id: input.stepUpId,
      tenantId: homeTenantId,
      type: REQUIREMENT_TYPE,
    });
  } catch {
    throw new AdminStepUpError('invalid_step_up', 'Step-up request was already used');
  }

  // Never outlasts the evidence it was issued on.
  const expiresAt = Math.min(now + ADMIN_STEP_UP_RECEIPT_TTL_SECONDS * 1000, evidence.freshUntil);
  const receipt = newId(RECEIPT_PREFIX);
  await (
    await store(env, receipt, homeTenantId)
  ).storeChallengeRpc({
    id: receipt,
    tenantId: homeTenantId,
    type: RECEIPT_TYPE,
    userId: auth.userId,
    challenge: receipt,
    ttl: ADMIN_STEP_UP_RECEIPT_TTL_SECONDS,
    notAfterMs: expiresAt,
    metadata: { ...bindingOf(binding) },
  });
  return { receipt, expiresAt, binding: bindingOf(binding) };
}

/**
 * Use a receipt for the operation it was issued for. It is consumed first, so a receipt
 * presented for anything else is spent as well.
 */
export async function consumeAdminStepUpReceipt(
  env: Env,
  receipt: string,
  expected: AdminStepUpBinding
): Promise<void> {
  if (!ID_PATTERN.test(receipt) || !receipt.startsWith(RECEIPT_PREFIX)) {
    throw new AdminStepUpError('step_up_required', 'Step-up receipt is invalid');
  }
  let metadata: Record<string, unknown> | undefined;
  try {
    ({ metadata } = await (
      await store(env, receipt, expected.homeTenantId)
    ).consumeChallengeRpc({
      id: receipt,
      tenantId: expected.homeTenantId,
      type: RECEIPT_TYPE,
    }));
  } catch {
    throw new AdminStepUpError('step_up_required', 'Step-up receipt is invalid or already used');
  }
  if (!isStoredBinding(metadata) || !sameBinding(metadata, expected)) {
    throw new AdminStepUpError('step_up_required', 'Step-up receipt does not match this operation');
  }
}
