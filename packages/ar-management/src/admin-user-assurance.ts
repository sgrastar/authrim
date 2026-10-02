/**
 * Identity assurance of a person, as an administrator sees and records it: the IAL their evidence
 * supports now, and the evidence itself (recorded by an administrator, by provisioning, or as the
 * tenant's default for accounts the organisation creates).
 *
 * An administrator records evidence of a proofing they checked; the proofing record itself stays
 * where it is kept, referred to by a hash or an opaque reference only. Recording raises the IAL:
 * the evidence is stored as pending, audited as stored, and only then put in force, so no evidence
 * is in force unaudited and no audit describes evidence other than the one stored. Revoking lowers
 * the IAL: it takes effect first, recording who revoked it, and its audit (completed by a retry when
 * it fails) names them.
 */

import type { Context } from 'hono';
import {
  CanonicalIdentityRepository,
  IAL_FRAMEWORK_PENDING,
  computeEffectiveIAL,
  createAuditLogFromContext,
  createAuthContextFromHono,
  ensureDatabaseAdapter,
  getTenantIdFromContext,
  getTenantMetadataContextFromHono,
  ialEvidenceStatus,
  isDatabaseSource,
  isIAL,
  type AssuranceEvidenceRow,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { getAdminAuth } from './admin-tenant-access';
import { logSanitizedError } from './admin-shared';
import { CrossShardAccountExactSearchService } from './cross-shard-account-list';
import { usesRoutedAccountStorage } from './tenant-routed-storage';

/** How an administrator saw the identity proofed. Provisioning and policy sources are not theirs to record. */
export const ADMIN_EVIDENCE_TYPES = [
  'admin_attestation',
  'document_check',
  'in_person_check',
  'remote_supervised_check',
] as const;

const SAFE_IDEMPOTENCY_KEY = /^[^\u0000-\u001f\u007f]{8,128}$/u;
const EVIDENCE_HASH = /^[A-Za-z0-9+/=_:-]{16,256}$/u;
/**
 * Where the proofing record is kept: an opaque reference (an id, a urn, an object key), never the
 * record or anything about the person. No spaces, queries, fragments, percent-encoding, @ or data.
 */
const STORAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,255}$/u;
const FORBIDDEN_REF_SCHEMES = /^(data|javascript|vbscript|file|mailto|tel):/iu;
const MAX_EVIDENCE_LISTED = 100;

const EVIDENCE_FIELDS = [
  'assurance_level',
  'evidence_type',
  'verified_at',
  'expires_at',
  'evidence_hash',
  'evidence_storage_ref',
];

interface AccountScope {
  tenantId: string;
  userId: string;
  subjectId: string;
  adapter: DatabaseAdapter;
}

class AccountNotFound extends Error {}

/**
 * The person's account and the store that holds it, suspended or locked too: evidence of a person
 * is read and revoked whatever their account's state (deleted accounts are not found).
 */
async function accountScope(c: Context<{ Bindings: Env }>): Promise<AccountScope> {
  const tenantId = getTenantIdFromContext(c);
  const requestedId = c.req.param('id');
  if (!requestedId) throw new AccountNotFound();
  let adapter: DatabaseAdapter;
  if (usesRoutedAccountStorage(getTenantMetadataContextFromHono(c))) {
    const routes = await new CrossShardAccountExactSearchService(c.env).find({
      tenantId,
      identifier: requestedId,
      purpose: 'admin_view',
    });
    if (routes.length === 0) throw new AccountNotFound();
    if (routes.length !== 1 || routes[0].legacyUserId !== requestedId) {
      throw new Error('assurance_account_route_invalid');
    }
    const source = (c.env as unknown as Record<string, unknown>)[routes[0].coreBindingRef];
    if (!isDatabaseSource(source)) throw new Error('assurance_account_binding_unavailable');
    adapter = ensureDatabaseAdapter(source, 'admin-user-assurance-core');
  } else {
    adapter = createAuthContextFromHono(c, tenantId).coreAdapter;
  }
  const account = await adapter.queryOne<{
    legacy_user_id: string | null;
    primary_subject_id: string | null;
    lifecycle_state: string | null;
  }>(
    `SELECT legacy_user_id, primary_subject_id, lifecycle_state FROM identity_accounts
      WHERE tenant_id = ? AND legacy_user_id = ?
      LIMIT 1`,
    [tenantId, requestedId],
    { consistencyClass: 'primary_required' }
  );
  if (
    !account?.primary_subject_id ||
    !account.legacy_user_id ||
    account.lifecycle_state === 'deleting' ||
    account.lifecycle_state === 'deleted'
  ) {
    throw new AccountNotFound();
  }
  return {
    tenantId,
    userId: account.legacy_user_id,
    subjectId: account.primary_subject_id,
    adapter,
  };
}

function actorId(c: Context<{ Bindings: Env }>): string | null {
  const auth = getAdminAuth(c);
  return auth?.actorId ?? auth?.userId ?? null;
}

function iso(value: number | string | null): string | null {
  if (value === null) return null;
  const ms = Number(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function evidenceView(row: AssuranceEvidenceRow, now: number) {
  return {
    evidence_id: row.id,
    evidence_type: row.evidence_type,
    issuer_ref: row.issuer_ref,
    assurance_framework: row.assurance_framework,
    assurance_level: row.assurance_level,
    evidence_hash: row.evidence_hash,
    evidence_storage_ref: row.evidence_storage_ref,
    verified_at: iso(row.verified_at),
    expires_at: iso(row.expires_at),
    revoked_at: iso(row.revoked_at),
    revoked_by: row.revoked_by,
    created_at: iso(row.created_at),
    status: ialEvidenceStatus(row, now),
  };
}

/** What the audit says of a piece of evidence: always read from the stored row. */
function auditedEvidence(row: AssuranceEvidenceRow) {
  return {
    evidence_id: row.id,
    evidence_type: row.evidence_type,
    issuer_ref: row.issuer_ref,
    assurance_level: row.assurance_level,
    evidence_hash: row.evidence_hash,
    evidence_storage_ref: row.evidence_storage_ref,
    verified_at: iso(row.verified_at),
    expires_at: iso(row.expires_at),
  };
}

function notFound(c: Context<{ Bindings: Env }>, what = 'account') {
  return c.json(
    { error: 'not_found', error_description: `The requested ${what} was not found` },
    404
  );
}

function invalidRequest(c: Context<{ Bindings: Env }>, description: string) {
  return c.json({ error: 'invalid_request', error_description: description }, 400);
}

function unavailable(c: Context<{ Bindings: Env }>, description: string) {
  return c.json({ error: 'temporarily_unavailable', error_description: description }, 503);
}

async function scopeOrResponse(
  c: Context<{ Bindings: Env }>,
  failure: string
): Promise<AccountScope | Response> {
  try {
    return await accountScope(c);
  } catch (error) {
    if (error instanceof AccountNotFound) return notFound(c);
    logSanitizedError('User assurance account lookup failed', error);
    return unavailable(c, failure);
  }
}

/** GET /api/admin/users/:id/assurance */
export async function adminUserAssuranceGetHandler(c: Context<{ Bindings: Env }>) {
  const scope = await scopeOrResponse(c, 'The identity assurance cannot be read now; try again');
  if (scope instanceof Response) return scope;
  try {
    const rows = await new CanonicalIdentityRepository(
      scope.adapter,
      scope.tenantId
    ).listAssuranceEvidenceForSubject(scope.subjectId, { includeRevoked: true });
    const now = Date.now();
    const effective = computeEffectiveIAL(rows, now);
    return c.json({
      effective_ial: {
        level: effective.level,
        evidence_id: effective.evidenceId,
        verified_at: iso(effective.verifiedAt),
      },
      evidence: rows.slice(0, MAX_EVIDENCE_LISTED).map((row) => evidenceView(row, now)),
      truncated: rows.length > MAX_EVIDENCE_LISTED,
    });
  } catch (error) {
    logSanitizedError('User assurance read failed', error);
    return unavailable(c, 'The identity assurance cannot be read now; try again');
  }
}

function parseTime(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** POST /api/admin/users/:id/assurance/evidence */
export async function adminUserAssuranceEvidenceCreateHandler(c: Context<{ Bindings: Env }>) {
  const actor = actorId(c);
  if (!actor) return c.json({ error: 'access_denied' }, 403);
  const key = c.req.header('Idempotency-Key')?.trim() ?? '';
  if (!SAFE_IDEMPOTENCY_KEY.test(key)) {
    return invalidRequest(c, 'A valid Idempotency-Key header is required');
  }
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return invalidRequest(c, 'The body must be a JSON object');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return invalidRequest(c, 'The body must be a JSON object');
  }
  for (const name of Object.keys(body)) {
    if (!EVIDENCE_FIELDS.includes(name)) {
      return invalidRequest(c, `${name} is not a field of evidence`);
    }
  }
  const level = body.assurance_level;
  if (!isIAL(level)) return invalidRequest(c, 'assurance_level must be IAL1, IAL2 or IAL3');
  const type = body.evidence_type;
  if (!(ADMIN_EVIDENCE_TYPES as readonly unknown[]).includes(type)) {
    return invalidRequest(c, `evidence_type must be one of ${ADMIN_EVIDENCE_TYPES.join(', ')}`);
  }
  const givenVerifiedAt = body.verified_at === undefined ? undefined : parseTime(body.verified_at);
  if (
    body.verified_at !== undefined &&
    (givenVerifiedAt === undefined || givenVerifiedAt === null)
  ) {
    return invalidRequest(c, 'verified_at must be a time');
  }
  const expiresAt = parseTime(body.expires_at);
  if (expiresAt === undefined) return invalidRequest(c, 'expires_at must be a time');
  const hash = body.evidence_hash ?? null;
  if (hash !== null && (typeof hash !== 'string' || !EVIDENCE_HASH.test(hash))) {
    return invalidRequest(c, 'evidence_hash must be a hash of 16 to 256 characters');
  }
  const storageRef = body.evidence_storage_ref ?? null;
  if (
    storageRef !== null &&
    (typeof storageRef !== 'string' ||
      !STORAGE_REF.test(storageRef) ||
      FORBIDDEN_REF_SCHEMES.test(storageRef))
  ) {
    return invalidRequest(
      c,
      'evidence_storage_ref must be an opaque reference (letters, digits and ._~:/-), never the record itself'
    );
  }

  const scope = await scopeOrResponse(c, 'The evidence cannot be recorded now; try again');
  if (scope instanceof Response) return scope;
  const { tenantId, userId, subjectId, adapter } = scope;
  const repository = new CanonicalIdentityRepository(adapter, tenantId);
  // The key names the evidence: a retry finds what the first attempt stored, and the same key with
  // other evidence is refused.
  const evidenceId = `assurance-evidence:${await sha256Hex(`${tenantId}\0${subjectId}\0${key}`)}`;
  const issuerRef = `admin:${actor}`;
  try {
    let stored = await repository.findAssuranceEvidence(evidenceId);
    const created = !stored;
    if (!stored) {
      // New evidence: its times are checked against now (a retry is answered from what is stored).
      const now = Date.now();
      const verifiedAt = givenVerifiedAt ?? now;
      if (verifiedAt > now) {
        return invalidRequest(c, 'verified_at must be a time that is not in the future');
      }
      if (expiresAt !== null && expiresAt <= now) {
        return invalidRequest(c, 'expires_at must be a future time');
      }
      // Stored as pending: not in force until it is audited.
      stored = await repository.createAssuranceEvidence({
        id: evidenceId,
        subject_id: subjectId,
        evidence_type: type as string,
        issuer_ref: issuerRef,
        assurance_framework: IAL_FRAMEWORK_PENDING,
        assurance_level: level,
        evidence_hash: hash as string | null,
        evidence_storage_ref: storageRef as string | null,
        verified_at: verifiedAt,
        expires_at: expiresAt,
      });
    }
    if (
      stored.subject_id !== subjectId ||
      stored.evidence_type !== type ||
      stored.issuer_ref !== issuerRef ||
      stored.assurance_level !== level ||
      stored.evidence_hash !== hash ||
      stored.evidence_storage_ref !== storageRef ||
      stored.expires_at !== expiresAt ||
      (givenVerifiedAt !== undefined && stored.verified_at !== givenVerifiedAt)
    ) {
      return c.json(
        {
          error: 'conflict',
          error_description: 'The Idempotency-Key was used for other evidence',
        },
        409
      );
    }
    // Pending evidence is audited as stored, then put in force. Evidence already in force (or
    // revoked since) was audited before it was.
    if (stored.assurance_framework === IAL_FRAMEWORK_PENDING && stored.revoked_at === null) {
      await createAuditLogFromContext(
        c,
        'user.assurance.evidence_recorded',
        'user',
        userId,
        auditedEvidence(stored),
        'warning',
        `user.assurance.evidence_recorded.${evidenceId}`,
        stored.created_at
      );
      await repository.activateAssuranceEvidence(evidenceId);
      stored = await repository.findAssuranceEvidence(evidenceId);
      if (!stored) throw new Error('assurance_evidence_not_recorded');
    }
    return c.json(evidenceView(stored, Date.now()), created ? 201 : 200);
  } catch (error) {
    logSanitizedError('User assurance evidence record failed', error);
    return unavailable(c, 'The evidence cannot be recorded now; try again with the same key');
  }
}

/** POST /api/admin/users/:id/assurance/evidence/:evidenceId/revoke */
export async function adminUserAssuranceEvidenceRevokeHandler(c: Context<{ Bindings: Env }>) {
  const actor = actorId(c);
  if (!actor) return c.json({ error: 'access_denied' }, 403);
  const evidenceId = c.req.param('evidenceId') ?? '';
  const scope = await scopeOrResponse(c, 'The evidence cannot be revoked now; try again');
  if (scope instanceof Response) return scope;
  const { tenantId, userId, subjectId, adapter } = scope;
  const repository = new CanonicalIdentityRepository(adapter, tenantId);
  try {
    const found = await repository.findAssuranceEvidence(evidenceId);
    if (!found || found.subject_id !== subjectId) return notFound(c, 'evidence');
    // Revoked first, recording who revoked it: it lowers the IAL, which never waits on the audit.
    // A retry of a revocation whose audit failed finds it revoked and audits it then, naming the
    // one who revoked it.
    await repository.revokeAssuranceEvidence(evidenceId, `admin:${actor}`);
    const revoked = await repository.findAssuranceEvidence(evidenceId);
    if (!revoked || revoked.revoked_at === null) throw new Error('assurance_evidence_not_revoked');
    await createAuditLogFromContext(
      c,
      'user.assurance.evidence_revoked',
      'user',
      userId,
      {
        ...auditedEvidence(revoked),
        revoked_by: revoked.revoked_by,
        revoked_at: iso(revoked.revoked_at),
      },
      'warning',
      `user.assurance.evidence_revoked.${evidenceId}`,
      revoked.revoked_at
    );
    return c.json(evidenceView(revoked, Date.now()));
  } catch (error) {
    logSanitizedError('User assurance evidence revoke failed', error);
    return unavailable(c, 'The evidence revocation could not be completed; try again');
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
