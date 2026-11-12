/**
 * Information release consent: a person's consent to the information (OIDC claims) a service
 * is given about them. Asked per service, on the consent screen shared with document consent.
 *
 * The approval travels with the grant, as its scope does: the authorization code, the access
 * token (a claim only the server sets), the refresh token family and the ID token carry the
 * claim names this authorization was approved for, and every place that releases claims gives
 * no more than that. Two authorizations for the same service (two tabs, two devices) therefore
 * never change each other's approval. The record kept with the scope consent
 * (`oauth_client_consents.release_*`) only decides whether the next authorization asks again,
 * and is what the person sees and withdraws.
 */
import type { DatabaseAdapter } from '../db/adapter';
import type { AccountInformationRelease } from '../types/consent';
import {
  AUTHORIZATION_SERVER_COMPUTED_CLAIMS,
  AUTHORIZATION_SERVER_GRANT_CLAIMS,
  OIDC_PROTOCOL_ENVELOPE_CLAIMS,
} from './destination-profile-consent';

/** When the person is asked again. */
export type InformationReleaseAsk = 'once' | 'every_time' | 'when_items_change';

/** A service connection's information release consent setting. */
export interface InformationReleaseConsentSetting {
  /** Off: no screen; the required items are released, the optional ones are not. */
  enabled: boolean;
  ask: InformationReleaseAsk;
  /** Whether the screen shows the values released, or only what they are. */
  show_values: boolean;
  /** A consent statement explaining why the service is given the information (shown only). */
  purpose_statement_id: string | null;
}

/** The setting a service has unless set otherwise: asked once, with the values shown. */
export const DEFAULT_INFORMATION_RELEASE_CONSENT: InformationReleaseConsentSetting = {
  enabled: true,
  ask: 'once',
  show_values: true,
  purpose_statement_id: null,
};

const ASK_VALUES: readonly InformationReleaseAsk[] = ['once', 'every_time', 'when_items_change'];
const STATEMENT_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a setting given to the Admin API. Every field is optional and falls back to the
 * default; anything else is an error message.
 */
export function parseInformationReleaseConsentSetting(
  value: unknown
): { ok: true; setting: InformationReleaseConsentSetting } | { ok: false; error: string } {
  if (value === null || value === undefined) {
    return { ok: true, setting: { ...DEFAULT_INFORMATION_RELEASE_CONSENT } };
  }
  if (!isRecord(value)) {
    return { ok: false, error: 'information_release_consent must be an object' };
  }
  const allowed = new Set(['enabled', 'ask', 'show_values', 'purpose_statement_id']);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    return { ok: false, error: `information_release_consent.${unknown} is not a known setting` };
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    return { ok: false, error: 'information_release_consent.enabled must be a boolean' };
  }
  if (value.show_values !== undefined && typeof value.show_values !== 'boolean') {
    return { ok: false, error: 'information_release_consent.show_values must be a boolean' };
  }
  if (value.ask !== undefined && !ASK_VALUES.includes(value.ask as InformationReleaseAsk)) {
    return {
      ok: false,
      error: `information_release_consent.ask must be one of ${ASK_VALUES.join(', ')}`,
    };
  }
  const purpose = value.purpose_statement_id;
  if (
    purpose !== undefined &&
    purpose !== null &&
    (typeof purpose !== 'string' || !STATEMENT_ID.test(purpose))
  ) {
    return {
      ok: false,
      error: 'information_release_consent.purpose_statement_id must be a statement ID or null',
    };
  }
  return {
    ok: true,
    setting: {
      enabled: value.enabled ?? DEFAULT_INFORMATION_RELEASE_CONSENT.enabled,
      ask:
        (value.ask as InformationReleaseAsk | undefined) ?? DEFAULT_INFORMATION_RELEASE_CONSENT.ask,
      show_values: value.show_values ?? DEFAULT_INFORMATION_RELEASE_CONSENT.show_values,
      purpose_statement_id: purpose ?? null,
    },
  };
}

/**
 * The setting a service has, read from its stored value. A value that cannot be read is the
 * default (asked once): the secure reading, never "not asked".
 */
export function readInformationReleaseConsentSetting(
  value: unknown
): InformationReleaseConsentSetting {
  let source = value;
  if (typeof value === 'string') {
    try {
      source = JSON.parse(value);
    } catch {
      source = null;
    }
  }
  const parsed = parseInformationReleaseConsentSetting(source);
  return parsed.ok ? parsed.setting : { ...DEFAULT_INFORMATION_RELEASE_CONSENT };
}

/**
 * The access token, refresh family and ID token claim carrying the claim names the grant was
 * approved for. Only the server sets it: a mapping or claims parameter can never produce it.
 */
export const RELEASE_APPROVAL_CLAIM = 'authrim_release';

/**
 * Claims the authorization server sets itself, not information about the person a mapping
 * releases: the protocol envelope (the same set the Destination Profile filter keeps), the grant
 * claims, the RBAC claims (from the tenant's role settings) and the account lifecycle. Only these
 * pass without an approval; every other claim, `authrim_`-prefixed or not, is held to it.
 */
const SERVER_SET_CLAIMS = new Set([
  'sub',
  ...OIDC_PROTOCOL_ENVELOPE_CLAIMS,
  ...AUTHORIZATION_SERVER_GRANT_CLAIMS,
  ...AUTHORIZATION_SERVER_COMPUTED_CLAIMS,
]);

/** Whether a claim is information about the person (what release consent is about). */
export function isReleasedInformationClaim(name: string): boolean {
  return !SERVER_SET_CLAIMS.has(name);
}

/** A piece of information that could be released, as the screen and the checks see it. */
export interface ReleaseCandidate {
  name: string;
  /** Required by the service: released, or the authorization does not go on. */
  required: boolean;
}

/** The candidates in a set of claims: their names, required unless the service says optional. */
export function releaseCandidatesOf(
  claims: Record<string, unknown>,
  optional: ReadonlySet<string>
): ReleaseCandidate[] {
  return Object.keys(claims)
    .filter(isReleasedInformationClaim)
    .sort()
    .map((name) => ({ name, required: !optional.has(name) }));
}

/** Merge candidates from several places (ID token, UserInfo): required anywhere is required. */
export function mergeReleaseCandidates(...lists: ReleaseCandidate[][]): ReleaseCandidate[] {
  const merged = new Map<string, ReleaseCandidate>();
  for (const list of lists) {
    for (const candidate of list) {
      const known = merged.get(candidate.name);
      merged.set(candidate.name, {
        name: candidate.name,
        required: candidate.required || known?.required === true,
      });
    }
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Entries of an approval that stand for more than one claim: everything (the service's trust),
 * or the claims the service requires (a service that does not ask). Neither is a claim name.
 */
export const RELEASE_APPROVE_ALL = '*';
export const RELEASE_APPROVE_REQUIRED = '@required';

/** Where an approval came from: the person, or the service's trust (no screen). */
export type ReleaseApprovalBasis = 'user' | 'trust' | 'not_asked';

/** What is kept of the last decision on a service (`oauth_client_consents.release_*`). */
export interface ReleaseConsentRecord {
  presented: string[];
  approved: string[];
  declined: string[];
  mode: InformationReleaseAsk | null;
  basis: ReleaseApprovalBasis | null;
  decidedAt: number | null;
}

function readNames(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((name): name is string => typeof name === 'string'))].sort()
      : [];
  } catch {
    return [];
  }
}

/** Read the release columns of an `oauth_client_consents` row (null when nothing was decided). */
export function readReleaseConsentRecord(row: {
  release_presented_json?: string | null;
  release_approved_json?: string | null;
  release_declined_json?: string | null;
  release_mode?: string | null;
  release_basis?: string | null;
  release_decided_at?: number | null;
}): ReleaseConsentRecord | null {
  if (row.release_decided_at === null || row.release_decided_at === undefined) return null;
  const mode = ASK_VALUES.includes(row.release_mode as InformationReleaseAsk)
    ? (row.release_mode as InformationReleaseAsk)
    : null;
  const basis =
    row.release_basis === 'user' ||
    row.release_basis === 'trust' ||
    row.release_basis === 'not_asked'
      ? row.release_basis
      : null;
  return {
    presented: readNames(row.release_presented_json),
    approved: readNames(row.release_approved_json),
    declined: readNames(row.release_declined_json),
    mode,
    basis,
    decidedAt: Number(row.release_decided_at),
  };
}

/**
 * The information release decision recorded with a service consent, as the account page shows it
 * (undefined when none was recorded, or the record cannot be read).
 */
export function accountInformationRelease(row: {
  release_approved_json?: string | null;
  release_declined_json?: string | null;
  release_basis?: string | null;
  release_decided_at?: number | null;
}): AccountInformationRelease | undefined {
  const record = readReleaseConsentRecord(row);
  if (!record || !record.basis || !Number.isSafeInteger(record.decidedAt)) return undefined;
  const isMarker = (name: string) =>
    name === RELEASE_APPROVE_ALL || name === RELEASE_APPROVE_REQUIRED;
  // The person's own items are shown as they were recorded; a record that cannot be read is not
  // shown as "nothing approved".
  const strictNames = (value: string | null | undefined): string[] | null => {
    if (typeof value !== 'string') return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) && parsed.every((name) => typeof name === 'string')
        ? parsed.filter((name) => !isMarker(name))
        : null;
    } catch {
      return null;
    }
  };
  if (record.basis !== 'user') {
    return {
      basis: record.basis,
      approved: [],
      declined: [],
      decidedAt: record.decidedAt as number,
    };
  }
  const approved = strictNames(row.release_approved_json);
  const declined = strictNames(row.release_declined_json);
  if (!approved || !declined) return undefined;
  return { basis: 'user', approved, declined, decidedAt: record.decidedAt as number };
}

/**
 * The approval an authorization gets without asking the person, if it does: the service's trust
 * approves everything; a service that does not ask releases its required claims only. Null: the
 * person's own decision is needed (asked, or reused).
 */
export function automaticReleaseApproval(
  setting: InformationReleaseConsentSetting,
  trusted: boolean
): { basis: Exclude<ReleaseApprovalBasis, 'user'>; approval: string[] } | null {
  if (trusted) return { basis: 'trust', approval: [RELEASE_APPROVE_ALL] };
  if (!setting.enabled) return { basis: 'not_asked', approval: [RELEASE_APPROVE_REQUIRED] };
  return null;
}

/**
 * The approval a grant that does not go through the consent screen gets (device flow, CIBA,
 * native SSO): the automatic one, else the person's last decision on the service unless it is
 * asked every time (each authorization is asked then, and these are not). Null: none, so only
 * protocol claims are released and a required claim refuses the release.
 */
export function releaseApprovalWithoutScreen(
  setting: InformationReleaseConsentSetting,
  record: ReleaseConsentRecord | null,
  trusted: boolean
): string[] | null {
  const automatic = automaticReleaseApproval(setting, trusted);
  if (automatic) return automatic.approval;
  if (!record || setting.ask === 'every_time' || record.basis !== 'user') return null;
  return [...record.approved];
}

/**
 * The person's earlier decision, when it still answers this authorization's candidates: every
 * required candidate was approved and every optional one answered; asked "when the items
 * change", the candidates are the ones shown then; asked "every time", never. Only the person's
 * own decision is reused (one the service's trust, or a setting that did not ask, made for them
 * answers nothing once that no longer holds). Returns the approval for this authorization: the
 * earlier approval among today's candidates.
 */
export function reusableReleaseApproval(
  setting: InformationReleaseConsentSetting,
  record: ReleaseConsentRecord | null,
  candidates: readonly ReleaseCandidate[]
): string[] | null {
  if (!record || setting.ask === 'every_time' || record.basis !== 'user') return null;
  const approved = new Set(record.approved);
  const declined = new Set(record.declined);
  for (const candidate of candidates) {
    if (candidate.required && !approved.has(candidate.name)) return null;
    if (!approved.has(candidate.name) && !declined.has(candidate.name)) return null;
  }
  if (setting.ask === 'when_items_change') {
    const shown = new Set(record.presented);
    if (shown.size !== candidates.length || candidates.some((item) => !shown.has(item.name))) {
      return null;
    }
  }
  return candidates.filter((item) => approved.has(item.name)).map((item) => item.name);
}

/** The approval a grant carries, read from its claim or stored state (null when it has none). */
export function readReleaseApproval(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((name): name is string => typeof name === 'string'))].sort();
}

/**
 * Hold claims to the approval the grant carries: claims about the person that were not approved
 * are left out; a required one that was not approved stops the release (the service must ask
 * for authorization again). Protocol claims pass. A grant that carries no approval releases no
 * information about the person.
 */
export function applyReleaseApproval(
  claims: Record<string, unknown>,
  optional: ReadonlySet<string>,
  approval: readonly string[] | null
): { ok: true; claims: Record<string, unknown> } | { ok: false; missing: string[] } {
  const approved = new Set(approval ?? []);
  const all = approved.has(RELEASE_APPROVE_ALL);
  const requiredOnly = approved.has(RELEASE_APPROVE_REQUIRED);
  const missing: string[] = [];
  const released: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(claims)) {
    if (
      !isReleasedInformationClaim(name) ||
      all ||
      approved.has(name) ||
      (requiredOnly && !optional.has(name))
    ) {
      released[name] = value;
    } else if (!optional.has(name)) {
      missing.push(name);
    }
  }
  return missing.length > 0
    ? { ok: false, missing: missing.sort() }
    : { ok: true, claims: released };
}

/**
 * An identifier of what the screen showed: the candidates, whether each is required, and the
 * version of the statement explaining the purpose. The answer is taken only for what was shown.
 */
export async function releasePresentationKey(
  candidates: readonly ReleaseCandidate[],
  purposeVersion: string | null
): Promise<string> {
  const canonical = JSON.stringify({
    items: [...candidates]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((item) => [item.name, item.required]),
    purpose: purposeVersion,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Read the person's last decision on a service, from the primary (never a cache), with the scope
 * consent it was written with: none when that consent has expired or was given under another
 * withdrawal generation than `consentGeneration` (the current one).
 */
export async function findReleaseConsentRecord(
  account: DatabaseAdapter,
  input: {
    tenantId: string;
    userId: string;
    clientId: string;
    consentGeneration: number;
    nowMs?: number;
  }
): Promise<ReleaseConsentRecord | null> {
  const row = await account.queryOne<{
    release_presented_json: string | null;
    release_approved_json: string | null;
    release_declined_json: string | null;
    release_mode: string | null;
    release_basis: string | null;
    release_decided_at: number | null;
    expires_at: number | null;
    consent_generation: number | null;
  }>(
    `SELECT release_presented_json, release_approved_json, release_declined_json, release_mode,
            release_basis, release_decided_at, expires_at, consent_generation
       FROM oauth_client_consents
      WHERE tenant_id = ? AND user_id = ? AND client_id = ?`,
    [input.tenantId, input.userId, input.clientId],
    { consistencyClass: 'primary_required' }
  );
  if (!row) return null;
  if (Number(row.consent_generation ?? 0) !== input.consentGeneration) return null;
  if (row.expires_at !== null && row.expires_at <= (input.nowMs ?? Date.now())) return null;
  return readReleaseConsentRecord(row);
}
