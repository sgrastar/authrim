/**
 * The SCIM assurance extension of the User resource,
 * `urn:authrim:params:scim:schemas:extension:assurance:1.0:User`: what a provisioning client
 * asserts about how well a person's identity was proofed.
 *
 *   { "ial": "IAL2", "verifiedAt": "2026-09-01T09:00:00+09:00", "expiresAt": "2027-09-01T00:00:00Z" }
 *
 * `ial` is IAL1, IAL2 or IAL3 (NIST SP 800-63A). `verifiedAt` (when the identity was proofed) is
 * required: a client cannot make a person's proofing look recent by leaving it out. `expiresAt`
 * is optional. It may be in the past, so a person whose claim has lapsed can still be updated
 * (the claim then counts for nothing).
 */

import { SCIM_SCHEMAS } from '../types/scim';

export const SCIM_ASSURANCE_ATTRIBUTES = ['ial', 'verifiedAt', 'expiresAt'] as const;

const IALS = ['IAL1', 'IAL2', 'IAL3'] as const;
export type ScimAssuranceLevel = (typeof IALS)[number];

/** A client's claim as the server keeps it: times in epoch milliseconds. */
export interface ScimAssuranceClaim {
  ial: ScimAssuranceLevel;
  verifiedAt: number;
  expiresAt: number | null;
}

/** How far ahead of the server's clock a `verifiedAt` may be, for clocks that differ a little. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** xs:dateTime as SCIM (RFC 7643 3.3.5) carries it: a date, a time and a zone. */
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether year, month and day name a day that exists (28 to 31 days, leap years included). */
function isCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= days;
}

/**
 * A calendar date (`2026-09-01`) as the epoch milliseconds of its start in UTC. A day that does
 * not exist (February 31, February 29 of a year that is not a leap year, month 13) is not a date:
 * `Date.parse` would roll it over into the next month, so the fields are checked first.
 */
export function parseIsoDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = DATE.exec(value);
  if (!match || !isCalendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isSafeInteger(ms) ? ms : null;
}

/**
 * A date-time with a time zone (`2026-09-01T09:00:00+09:00`) as epoch milliseconds. Every field
 * is checked to be what it names (an existing day, an hour below 24, minutes and seconds below
 * 60, a zone offset below 24 hours) before it is parsed, so nothing is rolled over.
 */
export function parseIsoDateTime(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const match = DATE_TIME.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  if (
    !isCalendarDay(Number(year), Number(month), Number(day)) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59))
  ) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isSafeInteger(ms) ? ms : null;
}

const parseDateTime = parseIsoDateTime;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads the extension of a SCIM User. An absent (or null) extension is no claim. A claim that is
 * not valid is refused whole, with why (no partial claim is ever taken).
 */
export function parseScimAssuranceExtension(
  value: unknown,
  now: number = Date.now()
): { claim: ScimAssuranceClaim | null; errors: string[] } {
  const schema = SCIM_SCHEMAS.ASSURANCE_USER;
  if (value === undefined || value === null) return { claim: null, errors: [] };
  if (!isRecord(value)) return { claim: null, errors: [`${schema} must be an object`] };
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!(SCIM_ASSURANCE_ATTRIBUTES as readonly string[]).includes(key)) {
      errors.push(`${schema}.${key} is not an attribute of the extension`);
    }
  }
  const ial = value.ial;
  if (typeof ial !== 'string' || !(IALS as readonly string[]).includes(ial)) {
    errors.push(`${schema}.ial must be IAL1, IAL2 or IAL3`);
  }
  const verifiedAt = parseDateTime(value.verifiedAt);
  if (verifiedAt === null) {
    errors.push(`${schema}.verifiedAt must be a date-time with a time zone`);
  } else if (verifiedAt > now + CLOCK_SKEW_MS) {
    errors.push(`${schema}.verifiedAt must not be in the future`);
  }
  let expiresAt: number | null = null;
  if (value.expiresAt !== undefined && value.expiresAt !== null) {
    expiresAt = parseDateTime(value.expiresAt);
    if (expiresAt === null) {
      errors.push(`${schema}.expiresAt must be a date-time with a time zone`);
    } else if (verifiedAt !== null && expiresAt <= verifiedAt) {
      errors.push(`${schema}.expiresAt must be after verifiedAt`);
    }
  }
  if (errors.length > 0 || verifiedAt === null) return { claim: null, errors };
  return { claim: { ial: ial as ScimAssuranceLevel, verifiedAt, expiresAt }, errors: [] };
}

/** A claim as the extension a client reads. */
export function scimAssuranceExtensionValue(claim: ScimAssuranceClaim): Record<string, string> {
  return {
    ial: claim.ial,
    verifiedAt: new Date(claim.verifiedAt).toISOString(),
    ...(claim.expiresAt === null ? {} : { expiresAt: new Date(claim.expiresAt).toISOString() }),
  };
}
