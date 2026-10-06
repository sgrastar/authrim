/**
 * Authentication assurance (NIST SP 800-63-4): the AAL an authentication reached, the AAL a
 * request requires, and the `acr` values Authrim issues for them.
 *
 * The AAL is computed from the methods completed in one authentication (or one step-up), never
 * from what a client asks for:
 *
 * | Methods (amr)                         | AAL  |
 * | ------------------------------------- | ---- |
 * | passkey / webauthn (a sign-in)         | AAL2 (phishing-resistant; AAL3 needs a verified hardware attestation, which Authrim does not check) |
 * | pwd (directory included)              | AAL1 |
 * | TOTP alone                            | AAL1 |
 * | email code alone                      | AAL0 (NIST SP 800-63B-4 accepts no email authenticator; never a second factor) |
 * | pwd + TOTP                            | AAL2 |
 * | did                                   | AAL1 |
 * | external IdP / SAML                   | the upstream acr mapped by `assurance.upstream_acr_mappings`, else AAL1 |
 * | guest / anonymous                     | AAL0 |
 *
 * AAL0 means no NIST AAL: the session may still have authenticated someone (an email code, or a
 * passkey just registered: registration with attestation `none` carries no signature, so it
 * proves no key until the passkey signs in), but at no level an assurance requirement can rely on. Unknown methods add nothing, and `mfa` or
 * `hwk` from anywhere but Authrim's own checks are not trusted.
 */

import type { AAL, FAL } from '../types/settings/assurance-levels';

/** An AAL, with AAL0 for a session that authenticated no one (a guest). */
export type AssuranceLevel = 'AAL0' | AAL;

/** The prefix of the `acr` values Authrim issues: `urn:authrim:aal:1` and so on. */
export const AAL_ACR_PREFIX = 'urn:authrim:aal:';

/** The `acr` values Authrim issues, lowest first (AAL0 is never issued as an acr). */
export const AAL_ACR_VALUES = [1, 2, 3].map((level) => `${AAL_ACR_PREFIX}${level}`);

const ORDER: Record<AssuranceLevel, number> = { AAL0: 0, AAL1: 1, AAL2: 2, AAL3: 3 };
const LEVELS: AssuranceLevel[] = ['AAL0', 'AAL1', 'AAL2', 'AAL3'];

export function isAssuranceLevel(value: unknown): value is AssuranceLevel {
  return typeof value === 'string' && Object.hasOwn(ORDER, value);
}

/** The higher of two levels. */
export function maxAAL(a: AssuranceLevel, b: AssuranceLevel): AssuranceLevel {
  return ORDER[a] >= ORDER[b] ? a : b;
}

/** Whether `actual` meets `required`. */
export function meetsAAL(actual: AssuranceLevel, required: AssuranceLevel): boolean {
  return ORDER[actual] >= ORDER[required];
}

/** The acr Authrim issues for a level (none for AAL0). */
export function aalToAcr(level: AssuranceLevel): string | null {
  return level === 'AAL0' ? null : `${AAL_ACR_PREFIX}${ORDER[level]}`;
}

/** The level of one of Authrim's own acr values (null for any other acr). */
export function acrToAAL(acr: string): AAL | null {
  if (!acr.startsWith(AAL_ACR_PREFIX)) return null;
  const level = LEVELS[Number(acr.slice(AAL_ACR_PREFIX.length))];
  return level && level !== 'AAL0' && aalToAcr(level) === acr ? level : null;
}

/** What one authentication (or step-up) is known by. */
export interface AuthenticationEvidence {
  /** The methods completed in this authentication (`amr`). */
  amr: readonly string[];
  /**
   * Methods in `amr` whose possession was not proven (a passkey just registered with attestation
   * none, recorded as `unverified_amr` in the session): they count for nothing.
   */
  unverifiedMethods?: readonly string[];
  /** For a login at an external IdP or a SAML IdP: the acr (or AuthnContextClassRef) it gave. */
  upstreamAcr?: string | null;
  /** `assurance.upstream_acr_mappings`: an upstream acr to the AAL it is taken for. */
  upstreamAcrMappings?: Readonly<Record<string, AAL>>;
}

const PASSKEY_METHODS = new Set(['passkey', 'webauthn']);
const FEDERATED_METHODS = new Set(['external_idp', 'saml', 'fed']);

/** The AAL an authentication reached (see the table above). */
export function computeAAL(evidence: AuthenticationEvidence): AssuranceLevel {
  const unverified = new Set(evidence.unverifiedMethods ?? []);
  const amr = new Set(evidence.amr.filter((method) => !unverified.has(method)));
  let level: AssuranceLevel = 'AAL0';

  if ([...amr].some((method) => FEDERATED_METHODS.has(method))) {
    const mappings = evidence.upstreamAcrMappings;
    const mapped =
      evidence.upstreamAcr && mappings && Object.hasOwn(mappings, evidence.upstreamAcr)
        ? mappings[evidence.upstreamAcr]
        : undefined;
    level = maxAAL(level, mapped ?? 'AAL1');
  }

  const passkey = [...amr].some((method) => PASSKEY_METHODS.has(method));
  const password = amr.has('pwd');
  // TOTP is marked `totp` (with `otp`); a bare `otp` is an emailed code, which counts for nothing.
  const totp = amr.has('totp');

  if (passkey) level = maxAAL(level, 'AAL2');
  if (password && totp) level = maxAAL(level, 'AAL2');
  if (password || totp || amr.has('did')) level = maxAAL(level, 'AAL1');
  return level;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

/**
 * The assurance evidence a session records: its `amr`, the methods in it no AAL counts
 * (`unverified_amr`), and the acr an external or SAML IdP gave (`upstream_acr`).
 */
export function sessionAssuranceEvidence(
  data: Record<string, unknown> | undefined,
  upstreamAcrMappings?: Readonly<Record<string, AAL>>
): AuthenticationEvidence {
  const upstreamAcr = data?.upstream_acr;
  const amr = stringList(data?.amr);
  // A marker of unproven methods that cannot be read leaves every method unproven.
  const unverified = data?.unverified_amr;
  const unverifiedMethods =
    unverified === undefined
      ? []
      : Array.isArray(unverified) && unverified.every((entry) => typeof entry === 'string')
        ? stringList(unverified)
        : amr;
  return {
    amr,
    unverifiedMethods,
    upstreamAcr: typeof upstreamAcr === 'string' && upstreamAcr ? upstreamAcr : null,
    upstreamAcrMappings,
  };
}

/**
 * The evidence of a step-up: the factors the session had already proven, with the one just
 * completed (one authentication session, two factors). A factor the earlier session had not proven
 * stays unproven; one the step-up proves is proven.
 */
export function mergeStepUpEvidence(
  prior: AuthenticationEvidence,
  current: AuthenticationEvidence
): AuthenticationEvidence {
  const priorUnverified = new Set(prior.unverifiedMethods ?? []);
  const currentUnverified = new Set(current.unverifiedMethods ?? []);
  const priorProven = prior.amr.filter((method) => !priorUnverified.has(method));
  const amr = [...new Set([...priorProven, ...current.amr])];
  // Unproven: what the step-up recorded unproven and the session had not proven before. What the
  // session had not proven is left out of amr unless the step-up completed it.
  const unverifiedMethods = [...currentUnverified].filter(
    (method) => !priorProven.includes(method)
  );
  return {
    amr,
    unverifiedMethods,
    upstreamAcr: current.upstreamAcr ?? prior.upstreamAcr ?? null,
    upstreamAcrMappings: current.upstreamAcrMappings ?? prior.upstreamAcrMappings,
  };
}

/**
 * The FAL assurance enforces (`assurance.default_fal`), or null while assurance is off.
 *
 * - FAL2 and above, with `fal2_requires_dpop`: every token issued to a user is sender-constrained
 *   with DPoP (the token request carries a DPoP proof), and none is issued from the front channel.
 * - FAL3, with `fal3_requires_par`: the authorization request is pushed (PAR) and carries a signed
 *   request object.
 */
export function enforcedFAL(settings: Record<string, unknown>): FAL | null {
  if (settings['assurance.enabled'] !== true) return null;
  const fal = settings['assurance.default_fal'];
  return fal === 'FAL2' || fal === 'FAL3' ? fal : 'FAL1';
}

/** Whether every token issued to a user must be bound to a DPoP key. */
export function falRequiresDpop(settings: Record<string, unknown>): boolean {
  const fal = enforcedFAL(settings);
  return (fal === 'FAL2' || fal === 'FAL3') && settings['assurance.fal2_requires_dpop'] === true;
}

/** Whether an authorization request must be pushed (PAR) with a signed request object. */
export function falRequiresSignedPushedRequest(settings: Record<string, unknown>): boolean {
  return enforcedFAL(settings) === 'FAL3' && settings['assurance.fal3_requires_par'] === true;
}

/** `assurance.scope_aal_requirements`, as saved (a scope to the AAL it needs). */
export function parseScopeAALRequirements(value: unknown): Record<string, AAL> {
  return parseAALMap(value);
}

/** `assurance.upstream_acr_mappings`, as saved (an upstream acr to the AAL it is taken for). */
export function parseUpstreamAcrMappings(value: unknown): Record<string, AAL> {
  return parseAALMap(value);
}

/**
 * `assurance.outbound_acr_mappings`, as saved: an acr from another vocabulary (InCommon, GakuNin,
 * eIDAS) that Authrim may return when a client asks for it, to the AAL it requires. Names the
 * Settings API refuses (see outboundAcrMappingsProblem) are left out.
 */
export function parseOutboundAcrMappings(value: unknown): Record<string, AAL> {
  const map = parseAALMap(value);
  for (const name of Object.keys(map)) {
    if (outboundAcrNameProblem(name)) delete map[name];
  }
  return map;
}

/**
 * A saved map of names to AAL1..AAL3. The Settings API refuses anything else; a value that is not
 * such a map still reads as no requirement rather than throwing at runtime.
 */
function parseAALMap(value: unknown): Record<string, AAL> {
  // A map without a prototype, so a name such as __proto__ or toString is only ever a name.
  const result = Object.create(null) as Record<string, AAL>;
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
  for (const [name, level] of Object.entries(parsed as Record<string, unknown>)) {
    if (name !== '' && (level === 'AAL1' || level === 'AAL2' || level === 'AAL3')) {
      result[name] = level;
    }
  }
  return result;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Why a saved AAL map is not valid (null when it is): an object of non-empty names to AAL1, AAL2
 * or AAL3. Used by the Settings API, so runtime never meets a map it would read differently.
 */
export function aalMapProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'must be an object of names to AAL1, AAL2 or AAL3';
  }
  for (const [name, level] of Object.entries(value as Record<string, unknown>)) {
    if (name.trim() === '' || name !== name.trim()) return 'names must be non-empty and unpadded';
    if (level !== 'AAL1' && level !== 'AAL2' && level !== 'AAL3') {
      return `${name} must map to AAL1, AAL2 or AAL3`;
    }
  }
  return null;
}

/** Why a saved outbound acr map is not valid (null when it is). */
export function outboundAcrMappingsProblem(value: unknown): string | null {
  const problem = aalMapProblem(value);
  if (problem) return problem;
  for (const name of Object.keys(value as Record<string, unknown>)) {
    const nameProblem = outboundAcrNameProblem(name);
    if (nameProblem) return `${name} ${nameProblem}`;
  }
  return null;
}

const MAX_ACR_LENGTH = 512;

/**
 * Why a name cannot be an outbound acr: acr_values are space-separated, so one with a space could
 * never be asked for, and Authrim's own values (urn:authrim:, any case) are built in.
 */
function outboundAcrNameProblem(name: string): string | null {
  if (name.length > MAX_ACR_LENGTH) return `is longer than ${MAX_ACR_LENGTH} characters`;
  if (/\s/.test(name)) return 'contains whitespace';
  if (name.toLowerCase().startsWith('urn:authrim:')) return "is one of Authrim's own acr values";
  return null;
}

/**
 * `assurance.saml_authn_context_aal`, as saved: SAML AuthnContextClassRef values (absolute URIs)
 * to the AAL each stands for.
 */
export function parseSAMLAuthnContextAAL(value: unknown): Record<string, AAL> {
  const map = parseAALMap(value);
  for (const name of Object.keys(map)) {
    if (!isAbsoluteUri(name)) delete map[name];
  }
  return map;
}

/** Why a saved AuthnContextClassRef-to-AAL map is not valid (null when it is). */
export function samlAuthnContextAALProblem(value: unknown): string | null {
  const problem = aalMapProblem(value);
  if (problem) return problem;
  for (const name of Object.keys(value as Record<string, unknown>)) {
    if (!isAbsoluteUri(name)) return `${name} is not an absolute URI`;
  }
  return null;
}

function isAbsoluteUri(value: string): boolean {
  return value.length <= 512 && /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(value);
}

/** What an authorization request asks of the authentication. */
export interface AssuranceRequest {
  /** `assurance.default_aal`: what every authorization requires (not for a guest login). */
  defaultAAL: AAL;
  /** The scopes requested. */
  scopes: readonly string[];
  /** `assurance.scope_aal_requirements`. */
  scopeRequirements: Readonly<Record<string, AAL>>;
  /**
   * An essential `acr` claim request (`claims` parameter), when there is one: its `value` or
   * `values`, or null when it names none. Only one naming values fails when unmet (OIDC Core
   * 5.5.1.1); one naming none asks for an acr Authrim gives when it has one.
   */
  essentialAcr?: { values: readonly string[] | null } | null;
  /** The voluntary `acr_values`. */
  acrValues: readonly string[];
  /**
   * `assurance.outbound_acr_mappings`: the other acr values Authrim issues, each counted at its
   * AAL wherever one of Authrim's own values would be.
   */
  outboundAcrMappings?: Readonly<Record<string, AAL>>;
  /** Whether the user can be shown UI (not `prompt=none`). */
  interactive: boolean;
  /** A guest login: the default does not apply (guests are AAL0 by design). */
  guest?: boolean;
}

export interface RequiredAssurance {
  /** The level the authentication must reach, or the request fails (AAL0: nothing required). */
  mandatory: AssuranceLevel;
  /** The level to reach by re-authenticating when the user can be asked; never fails alone. */
  target: AssuranceLevel;
  /** Whether the acr claim was requested as essential. */
  essential: boolean;
  /**
   * The values of an essential acr request that Authrim issues (its own and the outbound-mapped
   * ones): the acr issued must be one of them (see selectAcr). Null when no values are named (any
   * acr Authrim issues will do).
   */
  essentialAcrs: string[] | null;
  /** An essential acr request names values, none of which Authrim issues: it cannot be met. */
  unsatisfiable: boolean;
}

/**
 * The AAL a request requires. Mandatory: the default (AAL1 is the baseline every non-guest login
 * has always passed, so only a higher default is required; never for a guest), the requirements
 * of the requested scopes, and the lowest of the essential acr values Authrim issues (any of them
 * satisfies the request). The target adds the most preferred voluntary acr_value Authrim issues
 * (acr_values are in order of preference), for an interactive request only. The values Authrim
 * issues are its own and those `assurance.outbound_acr_mappings` maps, at the AAL mapped.
 */
export function requiredAAL(request: AssuranceRequest): RequiredAssurance {
  let mandatory: AssuranceLevel =
    request.guest || request.defaultAAL === 'AAL1' ? 'AAL0' : request.defaultAAL;
  for (const scope of request.scopes) {
    if (Object.hasOwn(request.scopeRequirements, scope)) {
      mandatory = maxAAL(mandatory, request.scopeRequirements[scope]);
    }
  }

  const essential = Boolean(request.essentialAcr);
  let essentialAcrs: string[] | null = null;
  let unsatisfiable = false;
  if (request.essentialAcr?.values) {
    const outbound = request.outboundAcrMappings;
    essentialAcrs = request.essentialAcr.values.filter(
      (acr) => issuedAcrAAL(acr, outbound) !== null
    );
    const lowest = lowestIssuedAAL(essentialAcrs, outbound);
    if (lowest) mandatory = maxAAL(mandatory, lowest);
    else unsatisfiable = true;
  }

  let target = mandatory;
  if (request.interactive) {
    const preferred = request.acrValues
      .map((acr) => issuedAcrAAL(acr, request.outboundAcrMappings))
      .find((level) => level !== null);
    if (preferred) target = maxAAL(target, preferred);
  }
  return { mandatory, target, essential, essentialAcrs, unsatisfiable };
}

/**
 * The acr to issue for an authentication at `actual`, for a request whose requirements are
 * `required` (see requiredAAL):
 * - an essential request naming values gets the first of them (in order of preference) that the
 *   authentication meets, or null when it meets none (the request then failed);
 * - an essential request naming no values gets Authrim's value for the level (none for AAL0,
 *   which OIDC lets the request go without);
 * - otherwise the first voluntary acr_value Authrim issues and the authentication meets, else
 *   Authrim's value for the level (null for AAL0, which an essential request never accepts).
 * The values Authrim issues are its own and those of `outboundAcrMappings` (at the AAL mapped);
 * an outbound value is only ever returned to a request that named it.
 */
export function selectAcr(
  actual: AssuranceLevel,
  required: Pick<RequiredAssurance, 'essential' | 'essentialAcrs'> = {
    essential: false,
    essentialAcrs: null,
  },
  acrValues: readonly string[] = [],
  outboundAcrMappings?: Readonly<Record<string, AAL>>
): string | null {
  if (required.essential) {
    // Values named: one of them or nothing. None named: any acr will do, so the level's own.
    return required.essentialAcrs
      ? firstMet(actual, required.essentialAcrs, outboundAcrMappings)
      : aalToAcr(actual);
  }
  return firstMet(actual, acrValues, outboundAcrMappings) ?? aalToAcr(actual);
}

/**
 * The AAL an acr Authrim issues requires: one of its own values, or one the outbound map names
 * (null for any other acr).
 */
function issuedAcrAAL(acr: string, outbound?: Readonly<Record<string, AAL>>): AAL | null {
  const own = acrToAAL(acr);
  if (own) return own;
  return outbound && Object.hasOwn(outbound, acr) ? outbound[acr] : null;
}

/** The first acr Authrim issues in a list that a level meets. */
function firstMet(
  actual: AssuranceLevel,
  acrs: readonly string[],
  outbound?: Readonly<Record<string, AAL>>
): string | null {
  for (const acr of acrs) {
    const level = issuedAcrAAL(acr, outbound);
    if (level && meetsAAL(actual, level)) return acr;
  }
  return null;
}

/** The lowest level among the acr values Authrim issues in a list (others are ignored). */
function lowestIssuedAAL(
  acrs: readonly string[],
  outbound?: Readonly<Record<string, AAL>>
): AAL | null {
  let lowest: AAL | null = null;
  for (const acr of acrs) {
    const level = issuedAcrAAL(acr, outbound);
    if (level && (!lowest || ORDER[level] < ORDER[lowest])) lowest = level;
  }
  return lowest;
}
