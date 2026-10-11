/**
 * Identity assurance (NIST SP 800-63A): the IAL a person's identity was proofed at, and the IAL a
 * request requires.
 *
 * The IAL is read from the subject's evidence each time it is needed, never stored on the subject:
 * the highest level among the evidence that is verified (at a time not in the future), not revoked,
 * not expired, and recorded under the NIST framework. Without such evidence a person is IAL1 (no
 * proofing). Evidence comes from an administrator, from the organisation's provisioning (SCIM, CSV,
 * the tenant's default for accounts it creates); a person never raises their own IAL.
 */

import type { DatabaseAdapter } from '../db/adapter';
import type { IAL } from '../types/settings/assurance-levels';

/** The framework IAL evidence is recorded under. Evidence under another framework is kept but not counted. */
export const IAL_FRAMEWORK = 'nist_800_63';

/**
 * The framework of evidence recorded but not in force yet: an administrator's evidence is recorded
 * as pending, audited, then put in force, so the audit always describes evidence that is stored.
 */
export const IAL_FRAMEWORK_PENDING = 'nist_800_63:pending';

/** The IALs, lowest first. */
export const IAL_LEVELS: readonly IAL[] = ['IAL1', 'IAL2', 'IAL3'];

const ORDER: Record<IAL, number> = { IAL1: 1, IAL2: 2, IAL3: 3 };

export function isIAL(value: unknown): value is IAL {
  return typeof value === 'string' && Object.hasOwn(ORDER, value);
}

/** Whether `actual` meets `required`. */
export function meetsIAL(actual: IAL, required: IAL): boolean {
  return ORDER[actual] >= ORDER[required];
}

/** The higher of two levels. */
export function maxIAL(a: IAL, b: IAL): IAL {
  return ORDER[a] >= ORDER[b] ? a : b;
}

/** The fields of an evidence row the IAL is computed from. */
export interface IALEvidence {
  id: string;
  assurance_framework: string | null;
  assurance_level: string | null;
  verified_at: number | string | null;
  expires_at: number | string | null;
  revoked_at: number | string | null;
}

/**
 * Where a piece of evidence stands now: `active` counts toward the IAL (under the NIST framework);
 * `pending` is not verified yet (no verification time, one in the future, or not put in force).
 */
export type IALEvidenceStatus = 'active' | 'pending' | 'expired' | 'revoked';

export function ialEvidenceStatus(evidence: IALEvidence, now: number): IALEvidenceStatus {
  const revokedAt = time(evidence.revoked_at);
  const expiresAt = time(evidence.expires_at);
  const verifiedAt = time(evidence.verified_at);
  if (revokedAt !== null) return 'revoked';
  if (expiresAt !== null && expiresAt <= now) return 'expired';
  if (evidence.assurance_framework === IAL_FRAMEWORK_PENDING) return 'pending';
  if (verifiedAt === null || verifiedAt > now) return 'pending';
  return 'active';
}

/** An epoch-ms time as a number (PostgreSQL returns BIGINT as text); null when absent or not a time. */
function time(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = Number(value);
  return Number.isFinite(ms) ? ms : null;
}

/** What an account is given when it is created: a level proofed at `verifiedAt` by a source. */
export interface InitialAssuranceEvidence {
  level: IAL;
  evidenceType: string;
  issuerRef: string;
  verifiedAt: number;
  expiresAt?: number | null;
  /**
   * Names the evidence by its content (see {@link assuranceEvidenceId}) instead of by its source:
   * the tenant and the subject, then these parts. A claim a client asserts (SCIM, CSV) is named
   * the same whether it is made when the account is created or later, so identical content
   * never becomes a second piece of evidence, and never re-activates a revoked one.
   */
  contentId?: { kind: string; parts: ReadonlyArray<string | number | null> };
}

/**
 * The id of the evidence an account is created with. It is fixed by the tenant, the subject and the
 * source, so a retried creation records it once. (Evidence ids are the table's key alone, hence the
 * tenant is part of the hash.)
 */
export async function initialAssuranceEvidenceId(
  tenantId: string,
  subjectId: string,
  source: { evidenceType: string; issuerRef: string }
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      [tenantId, subjectId, source.evidenceType, source.issuerRef].join('\u0000')
    )
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
  return `assurance-evidence:initial:${hex}`;
}

/**
 * The id of evidence named by what it is: a kind (`scim`, `import`) and the parts that make it
 * that evidence (the tenant, the subject, who asserted it, the claim). The same parts give the
 * same id, so recording it again is recognised, including after it was revoked: identical
 * content never becomes a second piece of evidence. (Evidence ids are the table's key alone, so
 * the tenant belongs among the parts.)
 */
export async function assuranceEvidenceId(
  kind: string,
  parts: ReadonlyArray<string | number | null>
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([kind, ...parts]))
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
  return `assurance-evidence:${kind}:${hex}`;
}

/**
 * The evidence an account is created with could not be recorded after the account was written.
 * The creation is unfinished (it is resumed by running the same creation again, which records
 * the evidence once), so the caller must not treat it as an ordinary failure.
 */
export class InitialAssuranceRecordError extends Error {
  constructor(cause?: unknown) {
    super('initial_assurance_record_failed');
    this.name = 'InitialAssuranceRecordError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * The assignment every write of `identity_subjects.updated_at` uses (with its value twice among
 * the parameters): the column only moves forward, and strictly so, even when the writer read its
 * clock before another writer (such as a change of evidence) moved it. The SCIM resource version
 * is made of it, so a delayed write cannot make an old ETag valid again.
 */
export const SUBJECT_UPDATED_AT_FORWARD_SQL =
  'updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END';

/** A person's IAL, with the evidence it rests on (none for IAL1 without evidence). */
export interface EffectiveIAL {
  level: IAL;
  /** The evidence the level rests on: the most recently verified at that level. */
  evidenceId: string | null;
  verifiedAt: number | null;
}

/** The IAL the evidence supports now. */
export function computeEffectiveIAL(evidence: readonly IALEvidence[], now: number): EffectiveIAL {
  let best: EffectiveIAL = { level: 'IAL1', evidenceId: null, verifiedAt: null };
  for (const row of evidence) {
    if (row.assurance_framework !== IAL_FRAMEWORK || !isIAL(row.assurance_level)) continue;
    if (ialEvidenceStatus(row, now) !== 'active') continue;
    const level = row.assurance_level;
    const verifiedAt = time(row.verified_at)!;
    const higher = ORDER[level] > ORDER[best.level];
    const sameLevelNewer =
      ORDER[level] === ORDER[best.level] &&
      (best.verifiedAt === null || verifiedAt > best.verifiedAt);
    if (higher || sameLevelNewer) {
      best = { level, evidenceId: row.id, verifiedAt };
    }
  }
  return best;
}

/**
 * The IAL a request requires: the highest of the scopes' requirements and the given minimums (a
 * client's, an SP's). Null when nothing above IAL1 is required, so no evidence needs to be read.
 */
export function requiredIAL(input: {
  scopes?: readonly string[];
  scopeRequirements?: Record<string, IAL>;
  minimums?: ReadonlyArray<IAL | null | undefined>;
}): IAL | null {
  let required: IAL = 'IAL1';
  const requirements = input.scopeRequirements;
  for (const scope of input.scopes ?? []) {
    // Only the map's own names: a scope such as toString is never a requirement.
    const level = requirements && Object.hasOwn(requirements, scope) ? requirements[scope] : null;
    if (isIAL(level)) required = maxIAL(required, level);
  }
  for (const level of input.minimums ?? []) {
    if (isIAL(level)) required = maxIAL(required, level);
  }
  return required === 'IAL1' ? null : required;
}

/** `assurance.scope_ial_requirements`, as saved (a scope to the IAL it needs). */
export function parseScopeIALRequirements(value: unknown): Record<string, IAL> {
  // A map without a prototype, so a scope such as __proto__ or toString is only ever a name.
  const result = Object.create(null) as Record<string, IAL>;
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
  for (const [name, level] of Object.entries(parsed as Record<string, unknown>)) {
    if (name !== '' && isIAL(level)) result[name] = level;
  }
  return result;
}

/**
 * Why a saved scope-to-IAL map is not valid (null when it is). Used by the Settings API, so
 * runtime never meets a map it would read differently.
 */
export function ialMapProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'must be an object of names to IAL1, IAL2 or IAL3';
  }
  for (const [name, level] of Object.entries(value as Record<string, unknown>)) {
    if (name.trim() === '' || name !== name.trim()) return 'names must be non-empty and unpadded';
    if (!isIAL(level)) return `${name} must map to IAL1, IAL2 or IAL3`;
  }
  return null;
}

/** The most values one IAL may be released with. */
export const MAX_ASSURANCE_VALUES_PER_IAL = 16;

/**
 * `assurance.ial_assurance_values`, as saved: the assurance values (URIs, such as GakuNin's
 * `https://www.gakunin.jp/profile/IAL2`) released for each IAL.
 */
export function parseIALAssuranceValues(value: unknown): Partial<Record<IAL, string[]>> {
  const result: Partial<Record<IAL, string[]>> = {};
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
  for (const level of IAL_LEVELS) {
    const values = Object.hasOwn(parsed, level) ? (parsed as Record<string, unknown>)[level] : null;
    if (!Array.isArray(values)) continue;
    const uris = values.filter(
      (uri): uri is string => typeof uri === 'string' && isAbsoluteUri(uri)
    );
    if (uris.length > 0) result[level] = uris;
  }
  return result;
}

/** Why a saved IAL-to-values map is not valid (null when it is). */
export function ialAssuranceValuesProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'must be an object of IAL1, IAL2 or IAL3 to lists of URIs';
  }
  for (const [level, values] of Object.entries(value as Record<string, unknown>)) {
    if (!isIAL(level)) return `${level} is not IAL1, IAL2 or IAL3`;
    if (!Array.isArray(values) || values.length === 0) return `${level} must be a non-empty list`;
    if (values.length > MAX_ASSURANCE_VALUES_PER_IAL) {
      return `${level} has more than ${MAX_ASSURANCE_VALUES_PER_IAL} values`;
    }
    for (const uri of values) {
      if (typeof uri !== 'string' || !isAbsoluteUri(uri)) {
        return `${level} values must be absolute URIs`;
      }
    }
    if (new Set(values).size !== values.length) return `${level} values must be unique`;
  }
  return null;
}

/**
 * The assurance values released for a person at `level`: those of every IAL up to it, lowest
 * first and without repeats, as REFEDS releases them (a person at IAL2 also meets IAL1).
 */
export function assuranceValuesForIAL(
  level: IAL,
  values: Partial<Record<IAL, string[]>>
): string[] {
  const released: string[] = [];
  for (const each of IAL_LEVELS) {
    if (ORDER[each] > ORDER[level]) break;
    for (const uri of values[each] ?? []) {
      if (!released.includes(uri)) released.push(uri);
    }
  }
  return released;
}

/** The claims verified_claims may carry: the person's OpenID Connect standard claims that proofing verifies. */
export const IDA_CLAIMS = [
  'name',
  'given_name',
  'family_name',
  'middle_name',
  'birthdate',
  'gender',
  'address',
  'email',
  'phone_number',
] as const;
export type IDAClaim = (typeof IDA_CLAIMS)[number];

/** `assurance.ida_profile`: what verified_claims are released under. */
export interface IDAProfile {
  trustFramework: string;
  /** The `assurance_level` value given for each IAL (none: the field is left out). */
  assuranceLevels: Partial<Record<IAL, string>>;
  claims: IDAClaim[];
}

const IDA_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The saved IDA profile, or null when none is set (or it is not one runtime would use). */
export function parseIDAProfile(value: unknown): IDAProfile | null {
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  if (idaProfileProblem(parsed, { allowEmpty: false })) return null;
  const profile = parsed as {
    trust_framework: string;
    assurance_levels?: Record<string, string>;
    claims: IDAClaim[];
  };
  const assuranceLevels: Partial<Record<IAL, string>> = {};
  for (const level of IAL_LEVELS) {
    const named = profile.assurance_levels?.[level];
    if (typeof named === 'string') assuranceLevels[level] = named;
  }
  return { trustFramework: profile.trust_framework, assuranceLevels, claims: profile.claims };
}

/**
 * Why a saved IDA profile is not valid (null when it is). An empty object is valid and releases
 * nothing.
 */
export function idaProfileProblem(
  value: unknown,
  options: { allowEmpty?: boolean } = {}
): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'must be an object';
  const entries = value as Record<string, unknown>;
  if (Object.keys(entries).length === 0) {
    return options.allowEmpty === false ? 'is empty' : null;
  }
  for (const key of Object.keys(entries)) {
    if (!['trust_framework', 'assurance_levels', 'claims'].includes(key)) {
      return `${key} is not a field of the profile`;
    }
  }
  if (typeof entries.trust_framework !== 'string' || !IDA_VALUE.test(entries.trust_framework)) {
    return 'trust_framework must be 1 to 64 letters, digits or _.:-';
  }
  if (entries.assurance_levels !== undefined) {
    const levels = entries.assurance_levels;
    if (!levels || typeof levels !== 'object' || Array.isArray(levels)) {
      return 'assurance_levels must be an object of IAL2 or IAL3 to a value';
    }
    for (const [level, named] of Object.entries(levels as Record<string, unknown>)) {
      if (level !== 'IAL2' && level !== 'IAL3')
        return 'assurance_levels names must be IAL2 or IAL3';
      if (typeof named !== 'string' || !IDA_VALUE.test(named)) {
        return `assurance_levels.${level} must be 1 to 64 letters, digits or _.:-`;
      }
    }
  }
  const claims = entries.claims;
  if (!Array.isArray(claims) || claims.length === 0) return 'claims must be a non-empty list';
  for (const claim of claims) {
    if (!(IDA_CLAIMS as readonly unknown[]).includes(claim)) {
      return `claims may only name ${IDA_CLAIMS.join(', ')}`;
    }
  }
  if (new Set(claims).size !== claims.length) return 'claims must be unique';
  return null;
}

/**
 * A person's IAL now, read from the evidence of the subject their account belongs to. `adapter`
 * must be the store that holds that person's canonical identity. A read error is thrown: it is never
 * taken for "no evidence".
 */
export async function resolveUserEffectiveIAL(
  adapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  now: number = Date.now()
): Promise<EffectiveIAL> {
  const evidence = await adapter.query<IALEvidence>(
    `SELECT e.id, e.assurance_framework, e.assurance_level, e.verified_at, e.expires_at,
            e.revoked_at
       FROM identity_accounts a
       JOIN assurance_evidence e
         ON e.tenant_id = a.tenant_id AND e.subject_id = a.primary_subject_id
      WHERE a.tenant_id = ? AND a.legacy_user_id = ? AND e.revoked_at IS NULL`,
    [tenantId, userId]
  );
  return computeEffectiveIAL(evidence, now);
}

function isAbsoluteUri(value: string): boolean {
  if (value.length > 512 || value !== value.trim()) return false;
  // An absolute URI: a scheme, then something after it (an https URL or a urn).
  return /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(value);
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
