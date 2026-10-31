/**
 * The AAL a SAML AuthnRequest asks for through its RequestedAuthnContext, and the AuthnContext
 * class reference an assertion carries for the AAL a sign-in reached.
 *
 * The tenant's table (`assurance.saml_authn_context_aal`) says which AAL an AuthnContextClassRef
 * stands for. A class reference in the table is read as the lowest AAL the sign-in may have, and
 * the request's Comparison (SAML Core 3.3.2.2.1) says how the listed references combine:
 *
 * | Comparison | The sign-in must reach                        | The assertion may carry                        |
 * | ---------- | --------------------------------------------- | ---------------------------------------------- |
 * | exact      | the lowest AAL among the references           | one of the references                          |
 * | minimum    | the lowest AAL among the references           | a reference at least as strong as one of them  |
 * | better     | one level above the lowest AAL among them     | a reference stronger than one of them          |
 * | maximum    | nothing (no step-up)                          | the strongest reference not above the highest  |
 *
 * (`better` follows SAML Core with its errata: stronger than any one of the contexts listed, so
 * `better [AAL1, AAL3]` is met by AAL2 and `better [AAL3]` cannot be met.)
 *
 * Only the references the table lists are interpreted here; the others a request names are left
 * to the IdP's existing handling. A request that names a listed reference is held to its AAL even
 * when it names others too: the table is never bypassed by listing an unlisted reference beside
 * it, and the reference finally put in the assertion is checked against the AAL reached
 * (`assertSAMLClassRefReached`).
 */

import { meetsAAL, type AAL, type AssuranceLevel } from '@authrim/ar-lib-core';
import type { SAMLAuthnRequest } from '@authrim/ar-lib-core';
import {
  resolveSAMLAuthnContextClassRef,
  SAMLAuthnContextPolicyError,
  type SAMLAuthnContextResolutionOptions,
} from './authn-context';

type RequestedAuthnContext = NonNullable<SAMLAuthnRequest['requestedAuthnContext']>;
export type SAMLAuthnContextComparison = NonNullable<RequestedAuthnContext['comparison']>;

const LEVEL: Record<AAL, number> = { AAL1: 1, AAL2: 2, AAL3: 3 };
const BY_LEVEL: AAL[] = ['AAL1', 'AAL2', 'AAL3'];

export interface SAMLMappedClassRef {
  ref: string;
  aal: AAL;
}

export type SAMLRequestedAssurance =
  /** Nothing in the request is mapped by the table: handled as it always was. */
  | { kind: 'unmapped' }
  | {
      kind: 'mapped';
      comparison: SAMLAuthnContextComparison;
      /** The requested references the table lists, in the order requested. */
      refs: SAMLMappedClassRef[];
      /** The lowest AAL the sign-in may have, or null when the request sets no lower bound. */
      requiredAal: AAL | null;
      /** Nothing the IdP can reach satisfies the request (better than the highest AAL). */
      unsatisfiable: boolean;
    };

export function resolveSAMLAssuranceAuthnContext(input: {
  requested: SAMLAuthnRequest['requestedAuthnContext'];
  /** `assurance.saml_authn_context_aal`, parsed. */
  classRefAal: Readonly<Record<string, AAL>>;
}): SAMLRequestedAssurance {
  const requestedRefs = input.requested?.authnContextClassRef ?? [];
  const refs: SAMLMappedClassRef[] = [];
  for (const ref of requestedRefs) {
    if (Object.hasOwn(input.classRefAal, ref)) {
      if (!refs.some((entry) => entry.ref === ref)) refs.push({ ref, aal: input.classRefAal[ref] });
    }
  }
  if (refs.length === 0) return { kind: 'unmapped' };

  const comparison = input.requested?.comparison ?? 'exact';
  const levels = refs.map((entry) => LEVEL[entry.aal]);
  const lowest = Math.min(...levels);
  switch (comparison) {
    case 'maximum':
      return { kind: 'mapped', comparison, refs, requiredAal: null, unsatisfiable: false };
    case 'better':
      return {
        kind: 'mapped',
        comparison,
        refs,
        // Stronger than any one of them: one level above the weakest.
        requiredAal: BY_LEVEL[lowest] ?? null,
        unsatisfiable: lowest >= LEVEL.AAL3,
      };
    default:
      return {
        kind: 'mapped',
        comparison,
        refs,
        requiredAal: BY_LEVEL[lowest - 1],
        unsatisfiable: false,
      };
  }
}

/**
 * The class reference an assertion carries for a sign-in that reached `actual`: the strongest
 * reference of the table the sign-in meets (the reverse lookup of the AAL), restricted to those
 * the request's Comparison accepts when the request was mapped. Among references of the same
 * strength the one requested first wins, then the one listed first in the table. Null when no
 * reference of the table fits.
 */
export function selectSAMLAssuranceClassRef(input: {
  actual: AssuranceLevel;
  classRefAal: Readonly<Record<string, AAL>>;
  request?: SAMLRequestedAssurance;
}): string | null {
  const request = input.request?.kind === 'mapped' ? input.request : undefined;
  const requestedOrder = request?.refs.map((entry) => entry.ref) ?? [];
  let best: { ref: string; level: number; order: number } | null = null;
  let tableOrder = 0;
  for (const [ref, aal] of Object.entries(input.classRefAal)) {
    tableOrder += 1;
    if (!meetsAAL(input.actual, aal)) continue;
    if (request && !acceptedByComparison(request, ref, aal)) continue;
    const requestedAt = requestedOrder.indexOf(ref);
    const order = requestedAt >= 0 ? requestedAt : requestedOrder.length + tableOrder;
    const level = LEVEL[aal];
    if (!best || level > best.level || (level === best.level && order < best.order)) {
      best = { ref, level, order };
    }
  }
  return best?.ref ?? null;
}

function acceptedByComparison(
  request: Extract<SAMLRequestedAssurance, { kind: 'mapped' }>,
  ref: string,
  aal: AAL
): boolean {
  const levels = request.refs.map((entry) => LEVEL[entry.aal]);
  switch (request.comparison) {
    case 'exact':
      return request.refs.some((entry) => entry.ref === ref);
    case 'minimum':
      return LEVEL[aal] >= Math.min(...levels);
    case 'better':
      return LEVEL[aal] > Math.min(...levels);
    case 'maximum':
      return LEVEL[aal] <= Math.max(...levels);
  }
}

/**
 * What the class reference finally put in an assertion is checked against: the AAL the sign-in
 * reached, and the table of references with their AAL. No reference of the table may be issued
 * to a sign-in below its AAL, whichever path chose it (the SP's static or session choice, the
 * existing handling of the request, or the table itself).
 */
export interface SAMLClassRefGuard {
  reached: AssuranceLevel;
  classRefAal: Readonly<Record<string, AAL>>;
  /**
   * How the request was read through the table. A request read through it (`mapped`) is answered
   * with a reference its Comparison accepts, in every mode.
   */
  request?: SAMLRequestedAssurance;
}

function aboveReached(guard: SAMLClassRefGuard, ref: string): boolean {
  return Object.hasOwn(guard.classRefAal, ref) && !meetsAAL(guard.reached, guard.classRefAal[ref]);
}

/**
 * The request without the references of the table that the sign-in is below, for the existing
 * handling to choose among the rest. A request whose references are all withheld is refused.
 */
export function withholdUnreachedClassRefs<
  T extends Pick<SAMLAuthnRequest, 'requestedAuthnContext'>,
>(request: T, guard: SAMLClassRefGuard): T {
  const requested = request.requestedAuthnContext;
  const refs = requested?.authnContextClassRef;
  if (!requested || !refs || refs.length === 0) return request;
  const allowed = refs.filter((ref) => !aboveReached(guard, ref));
  if (allowed.length === 0) {
    throw new SAMLAuthnContextPolicyError(
      'Requested AuthnContext cannot be satisfied by the sign-in',
      requested
    );
  }
  if (allowed.length === refs.length) return request;
  return { ...request, requestedAuthnContext: { ...requested, authnContextClassRef: allowed } };
}

/** Refuses a class reference of the table that the sign-in is below. */
export function assertSAMLClassRefReached(
  guard: SAMLClassRefGuard,
  ref: string,
  requested: SAMLAuthnRequest['requestedAuthnContext']
): void {
  if (aboveReached(guard, ref)) {
    throw new SAMLAuthnContextPolicyError(
      'The AuthnContext to issue is above what the sign-in reached',
      requested ?? { comparison: undefined, authnContextClassRef: undefined }
    );
  }
}

/**
 * Whether a reference fits a request read through the table: a listed one by the Comparison of
 * its AAL; an unlisted one only if the request named it (a reference's strength is not known to
 * the table, and nothing is stronger than itself, so `better` never accepts it).
 */
function fitsMappedRequest(
  request: Extract<SAMLRequestedAssurance, { kind: 'mapped' }>,
  classRefAal: Readonly<Record<string, AAL>>,
  requestedRefs: readonly string[],
  ref: string
): boolean {
  if (Object.hasOwn(classRefAal, ref)) {
    return acceptedByComparison(request, ref, classRefAal[ref]);
  }
  return request.comparison !== 'better' && requestedRefs.includes(ref);
}

/**
 * The class reference for an assertion: the one the assurance check chose (SPs in `assurance`
 * mode), else the existing choice among the references the sign-in has reached. Whichever it
 * is:
 * - a reference of the table above the AAL reached is never issued (refused with a NoAuthnContext
 *   policy error);
 * - for a request read through the table, the reference must fit the request's Comparison. If the
 *   existing choice does not (it returned the very reference a `better` request asked to be
 *   bettered), the reference of the table that fits and the sign-in has reached is used instead,
 *   and if there is none the request is refused the same way.
 */
export function chooseSAMLAuthnContextClassRef(
  authnRequest: SAMLAuthnRequest,
  options: SAMLAuthnContextResolutionOptions,
  assurance?: { classRef?: string; guard: SAMLClassRefGuard }
): string {
  const guard = assurance?.guard;
  let ref =
    assurance?.classRef ??
    resolveSAMLAuthnContextClassRef(
      guard ? withholdUnreachedClassRefs(authnRequest, guard) : authnRequest,
      options
    );
  if (guard) {
    const requested = authnRequest.requestedAuthnContext;
    assertSAMLClassRefReached(guard, ref, requested);
    const mapped = guard.request?.kind === 'mapped' ? guard.request : undefined;
    if (
      mapped &&
      !fitsMappedRequest(mapped, guard.classRefAal, requested?.authnContextClassRef ?? [], ref)
    ) {
      const fitting = selectSAMLAssuranceClassRef({
        actual: guard.reached,
        classRefAal: guard.classRefAal,
        request: mapped,
      });
      if (!fitting) {
        throw new SAMLAuthnContextPolicyError(
          'No AuthnContext fits the request and the sign-in',
          requested ?? { comparison: undefined, authnContextClassRef: undefined }
        );
      }
      ref = fitting;
    }
  }
  return ref;
}
