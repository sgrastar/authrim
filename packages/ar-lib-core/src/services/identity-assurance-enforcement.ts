/**
 * Enforcing identity assurance (IAL) where a person is authorized or issued tokens.
 *
 * What a request requires comes from two places: the client's own minimum (applies whenever it is
 * set) and the tenant's scope-to-IAL map (applies only while `assurance.enabled`). When nothing is
 * required the person's evidence is not read at all. When something is, the IAL is read from the
 * person's evidence each time (never cached, so a revocation takes effect on the next request), and
 * a read that fails is neither "met" nor "insufficient": it is reported as unavailable, so the
 * caller refuses with a temporary error instead of treating the person as IAL1.
 */

import type { DatabaseAdapter } from '../db/adapter';
import type { IAL } from '../types/settings/assurance-levels';
import {
  meetsIAL,
  parseScopeIALRequirements,
  requiredIAL,
  resolveUserEffectiveIAL,
} from './identity-assurance';

/** The scopes of a request: a space-separated string (as OAuth carries them) or a list. */
export type ScopeInput = string | readonly string[] | null | undefined;

function scopeList(scope: ScopeInput): string[] {
  if (typeof scope === 'string') return scope.split(/\s+/).filter(Boolean);
  return scope ? scope.filter((name) => name !== '') : [];
}

/**
 * The IAL a request requires, or null when it requires none above IAL1 (then no evidence is read).
 * The client's minimum applies whether or not tenant-wide assurance is on; the scope map only
 * while it is on.
 */
export function resolveRequiredIAL(input: {
  /** The `assurance` category settings the request already read. */
  assuranceSettings: Record<string, unknown>;
  /** The scopes the request asks for or was granted. */
  scope: ScopeInput;
  /** The client's own minimum (`ClientMetadata.minimum_ial`). */
  clientMinimumIAL?: IAL | null;
}): IAL | null {
  const tenantWide = input.assuranceSettings['assurance.enabled'] === true;
  const scopes = tenantWide ? scopeList(input.scope) : [];
  return requiredIAL({
    scopes,
    scopeRequirements:
      scopes.length > 0
        ? parseScopeIALRequirements(input.assuranceSettings['assurance.scope_ial_requirements'])
        : undefined,
    minimums: [input.clientMinimumIAL],
  });
}

/** What reading a person's IAL against a requirement found. */
export type IALEvaluation =
  | { outcome: 'not_required' }
  | { outcome: 'met'; required: IAL; actual: IAL }
  | { outcome: 'insufficient'; required: IAL; actual: IAL }
  /** The evidence could not be read: neither met nor insufficient. */
  | { outcome: 'unavailable'; required: IAL; error: unknown };

/**
 * Whether the person meets `required`. With nothing required, `getAdapter` is not called and no
 * evidence is read. `getAdapter` must give the store that holds the person's canonical identity.
 * A `userId` of null is a subject with no account in the tenant (one an external issuer vouches
 * for): there is no evidence to hold, so it is IAL1 without a read.
 */
export async function evaluateUserIAL(input: {
  required: IAL | null;
  tenantId: string;
  userId: string | null;
  getAdapter: () => DatabaseAdapter | Promise<DatabaseAdapter>;
  now?: number;
}): Promise<IALEvaluation> {
  const { required } = input;
  if (required === null) return { outcome: 'not_required' };
  if (input.userId === null) return { outcome: 'insufficient', required, actual: 'IAL1' };
  try {
    const adapter = await input.getAdapter();
    const effective = await resolveUserEffectiveIAL(
      adapter,
      input.tenantId,
      input.userId,
      input.now
    );
    return meetsIAL(effective.level, required)
      ? { outcome: 'met', required, actual: effective.level }
      : { outcome: 'insufficient', required, actual: effective.level };
  } catch (error) {
    return { outcome: 'unavailable', required, error };
  }
}
