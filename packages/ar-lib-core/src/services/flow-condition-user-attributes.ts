/**
 * The attributes of a user that a Flow condition compares (`user.attribute`, and `birthdate` for
 * `user.age`): a few of the standard profile claims, and the tenant's custom attributes by their
 * key. Only the keys asked for are read, and a value that cannot be read throws, so no condition
 * is decided without it.
 */
import { ensureDatabaseAdapter, type DatabaseSource } from '../db';
import type { Env } from '../types/env';
import { resolveCustomClaimRuntimeSourcesFromEnv } from './custom-claims/runtime-sources';
import { CanonicalRuntimeUserStore } from '../repositories/identity/canonical-runtime-user-store';
import type { FlowConditionEvaluationUser } from '../schemas/flow-runtime';
import type { CustomClaimSchema } from './custom-claims/resolver';
import { UserCustomDataFetcher } from './custom-claims/data-fetcher';
import { FLOW_CONDITION_PROFILE_ATTRIBUTES } from '../types/flow-step-condition';

export type FlowConditionUserAttributes = NonNullable<FlowConditionEvaluationUser['attributes']>;

// The standard profile claims a condition may compare (kept with the step conditions, which the
// admin console reads without this module's database code).
export { FLOW_CONDITION_PROFILE_ATTRIBUTES };

const PROFILE_KEYS: ReadonlySet<string> = new Set(FLOW_CONDITION_PROFILE_ATTRIBUTES);

/** Where a user's attributes are: the tenant's schemas, and the user's account data. */
export interface FlowConditionUserSources {
  schemaDb: DatabaseSource;
  /** The account's core database (the profile and custom attributes that are not PII). */
  nonPiiDb: DatabaseSource;
  piiDb: DatabaseSource;
}

function addressPart(json: string | null, part: 'country' | 'region'): string | undefined {
  if (!json) return undefined;
  try {
    const address = JSON.parse(json) as unknown;
    if (!address || typeof address !== 'object' || Array.isArray(address)) return undefined;
    const value = (address as Record<string, unknown>)[part];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A stored custom attribute's value: a multi-valued one is its list (one that is not a list cannot
 * be read), any other is its text as stored.
 */
function customValue(raw: string, multi: boolean): string | string[] {
  if (!multi) return raw;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('custom_data_unreadable');
  return parsed.map(String);
}

export async function loadFlowConditionUserAttributes(
  sources: FlowConditionUserSources,
  tenantId: string,
  userId: string,
  keys: readonly string[]
): Promise<FlowConditionUserAttributes> {
  // No inherited keys: an attribute named like one (`constructor`) is unset unless it is read.
  const attributes = Object.create(null) as FlowConditionUserAttributes;
  const wanted = [...new Set(keys)];
  if (wanted.length === 0) return attributes;

  const profileKeys = wanted.filter((key) => PROFILE_KEYS.has(key));
  if (profileKeys.length > 0) {
    const users = new CanonicalRuntimeUserStore({
      coreAdapter: ensureDatabaseAdapter(sources.nonPiiDb, 'flow-condition-user-core'),
      piiAdapter: ensureDatabaseAdapter(sources.piiDb, 'flow-condition-user-pii'),
      tenantId,
    });
    // Only the claims asked for: no other profile or contact value is read.
    const user = await users.findById(userId, {
      claimNames: [
        ...new Set(profileKeys.map((key) => (key.startsWith('address.') ? 'address' : key))),
      ],
    });
    if (user) {
      for (const key of profileKeys) {
        const value =
          key === 'address.country'
            ? addressPart(user.address_json, 'country')
            : key === 'address.region'
              ? addressPart(user.address_json, 'region')
              : user[key as 'birthdate' | 'gender' | 'locale' | 'zoneinfo'];
        if (typeof value === 'string' && value.trim()) attributes[key] = value;
      }
    }
  }

  const customKeys = wanted.filter((key) => !PROFILE_KEYS.has(key));
  if (customKeys.length > 0) {
    const schemaDb = ensureDatabaseAdapter(sources.schemaDb, 'flow-condition-schemas');
    const readSchemas = () =>
      schemaDb.query<{
        id: string;
        field_key: string;
        is_pii: number;
        cardinality: string | null;
        operation_status: string | null;
      }>(
        `SELECT id, field_key, is_pii, cardinality, operation_status
           FROM custom_claim_schemas WHERE tenant_id = ? AND is_active = TRUE`,
        [tenantId]
      );
    const schemas = await readSchemas();
    // A condition names a custom attribute by its key, compared without case.
    const byKey = new Map(schemas.map((schema) => [schema.field_key.toLowerCase(), schema]));
    const chosen = customKeys.flatMap((key) => {
      const schema = byKey.get(key.toLowerCase());
      return schema ? [{ key, schema }] : [];
    });
    // One being renamed (its values on their way to another key) or left in error has no value to
    // be read: not knowing it is not the same as it being unset.
    if (chosen.some(({ schema }) => (schema.operation_status ?? 'active') !== 'active')) {
      throw new Error('custom_attribute_not_readable');
    }
    if (chosen.length > 0) {
      const values = await new UserCustomDataFetcher(sources.nonPiiDb, sources.piiDb, {
        strict: true,
      }).fetch(
        tenantId,
        userId,
        chosen.map(({ schema }) => schema as unknown as CustomClaimSchema)
      );
      // A rename that began while the values were read moves them away under the old key: the
      // schemas read again must be the ones read before, or nothing read is trusted.
      const signature = (rows: typeof schemas) =>
        JSON.stringify(
          rows
            .filter((row) => chosen.some(({ schema }) => schema.id === row.id))
            .map((row) => [
              row.id,
              row.field_key,
              row.is_pii,
              row.cardinality,
              row.operation_status,
            ])
            .sort()
        );
      if (signature(await readSchemas()) !== signature(chosen.map(({ schema }) => schema))) {
        throw new Error('custom_attribute_not_readable');
      }
      for (const { key, schema } of chosen) {
        const raw = values.get(schema.field_key);
        if (raw !== undefined) attributes[key] = customValue(raw, schema.cardinality === 'multi');
      }
    }
  }
  return attributes;
}

/**
 * Reads a user's attributes for the conditions of a Flow, from the tenant's and the user's own
 * databases, only once a condition asks for some (as `FlowSsoContext.user_attributes`).
 */
export function flowConditionAttributeReader(
  env: Env,
  tenantId: string,
  userId: string
): (keys: string[]) => Promise<FlowConditionUserAttributes> {
  return async (keys) => {
    const sources = await resolveCustomClaimRuntimeSourcesFromEnv(env, tenantId, {
      accountId: userId,
    });
    return loadFlowConditionUserAttributes(sources, tenantId, userId, keys);
  };
}
