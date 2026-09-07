import type {
  DatabaseSource,
  Env,
  RegistrationFieldSchemaRow,
  ValidatedCustomClaimWriteResult,
} from '@authrim/ar-lib-core';
import {
  listRegistrationFieldSchemas,
  persistCustomClaimWrite,
  resolveCustomClaimRuntimeSourcesFromEnv,
} from '@authrim/ar-lib-core';

interface MissingRequiredRegistrationField {
  fieldKey: string;
  label: string;
  fieldType: string;
}

type ValidationResult =
  | {
      ok: true;
      values: Record<string, string>;
      schemas: RegistrationFieldSchemaRow[];
    }
  | {
      ok: false;
      error: string;
      missingRequiredFields?: MissingRequiredRegistrationField[];
    };

function getRequiredFieldError(label: string): string {
  return `${label} is required`;
}

const FIXED_REGISTRATION_FIELD_KEYS = new Set([
  'name',
  'field.canonical.name',
  'email',
  'field.canonical.email',
  'email_verified',
  'field.canonical.email_verified',
]);

const GIVEN_NAME_FIELD_KEYS = [
  'given_name',
  'first_name',
  'field.canonical.given_name',
  'field.canonical.first_name',
];

const FAMILY_NAME_FIELD_KEYS = [
  'family_name',
  'last_name',
  'field.canonical.family_name',
  'field.canonical.last_name',
];

export interface SubmittedCanonicalProfileFields {
  given_name?: string;
  family_name?: string;
}

export interface CanonicalProfileRuntimeUserFields {
  piiFields: Partial<Record<'given_name' | 'family_name', boolean>>;
  sensitiveValues: Partial<Record<'given_name' | 'family_name', string>>;
}

export function isFixedRegistrationFieldKey(fieldKey: string): boolean {
  return FIXED_REGISTRATION_FIELD_KEYS.has(fieldKey.trim().toLowerCase());
}

function isPiiRegistrationField(schema: RegistrationFieldSchemaRow): boolean {
  return schema.is_pii === 1 || schema.is_pii === true;
}

function readSubmittedStringByKeys(
  submitted: Record<string, unknown> | undefined,
  keys: string[]
): string | undefined {
  if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
    return undefined;
  }

  for (const key of keys) {
    const value = submitted[key];
    if (value === undefined || value === null) {
      continue;
    }
    const stringValue = String(value).trim();
    if (stringValue) {
      return stringValue;
    }
  }
  return undefined;
}

export function resolveSubmittedCanonicalProfileFields(
  submitted: Record<string, unknown> | undefined
): SubmittedCanonicalProfileFields {
  const fields: SubmittedCanonicalProfileFields = {};
  const givenName = readSubmittedStringByKeys(submitted, GIVEN_NAME_FIELD_KEYS);
  const familyName = readSubmittedStringByKeys(submitted, FAMILY_NAME_FIELD_KEYS);

  if (givenName) {
    fields.given_name = givenName;
  }
  if (familyName) {
    fields.family_name = familyName;
  }

  return fields;
}

export function buildCanonicalProfileRuntimeUserFields(
  submitted: Record<string, unknown> | undefined
): CanonicalProfileRuntimeUserFields {
  const fields = resolveSubmittedCanonicalProfileFields(submitted);
  return {
    piiFields: {
      ...(fields.given_name ? { given_name: true } : {}),
      ...(fields.family_name ? { family_name: true } : {}),
    },
    sensitiveValues: {
      ...(fields.given_name ? { given_name: fields.given_name } : {}),
      ...(fields.family_name ? { family_name: fields.family_name } : {}),
    },
  };
}

function filterCustomRegistrationFieldSchemas(
  schemas: RegistrationFieldSchemaRow[]
): RegistrationFieldSchemaRow[] {
  return schemas.filter((schema) => !isFixedRegistrationFieldKey(schema.field_key));
}

function toMissingRequiredRegistrationField(
  schema: RegistrationFieldSchemaRow
): MissingRequiredRegistrationField {
  return {
    fieldKey: schema.field_key,
    label: schema.display_label || schema.field_key,
    fieldType: schema.field_type,
  };
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

function validateScalarRegistrationValue(
  schema: RegistrationFieldSchemaRow,
  rawValue: unknown,
  rules: Record<string, unknown>
): { ok: true; value: string } | { ok: false; error: string } {
  const label = schema.display_label || schema.field_key;
  if (schema.field_type === 'boolean') {
    if (typeof rawValue === 'boolean') return { ok: true, value: rawValue ? 'true' : 'false' };
    if (rawValue === 'true' || rawValue === 'false') return { ok: true, value: rawValue };
    return { ok: false, error: `${label} must be true or false` };
  }

  if (rawValue === null || typeof rawValue === 'object') {
    return { ok: false, error: `${label} contains an invalid value` };
  }
  const stringValue = String(rawValue);
  const trimmedValue = stringValue.trim();
  switch (schema.field_type) {
    case 'number': {
      const numberValue = Number(trimmedValue);
      if (!Number.isFinite(numberValue)) {
        return { ok: false, error: `${label} must be a valid number` };
      }
      if (typeof rules.min === 'number' && numberValue < rules.min) {
        return { ok: false, error: `${label} must be at least ${rules.min}` };
      }
      if (typeof rules.max === 'number' && numberValue > rules.max) {
        return { ok: false, error: `${label} must be at most ${rules.max}` };
      }
      return { ok: true, value: trimmedValue };
    }
    case 'enum': {
      const enumValues = Array.isArray(rules.enum_values)
        ? rules.enum_values.filter((value): value is string => typeof value === 'string')
        : [];
      if (enumValues.length > 0 && !enumValues.includes(trimmedValue)) {
        return { ok: false, error: `${label} must be one of the configured options` };
      }
      return { ok: true, value: trimmedValue };
    }
    case 'date': {
      const timestamp = Date.parse(trimmedValue);
      if (Number.isNaN(timestamp)) {
        return { ok: false, error: `${label} must be a valid date` };
      }
      if (typeof rules.min_date === 'string') {
        const minTimestamp = Date.parse(rules.min_date);
        if (!Number.isNaN(minTimestamp) && timestamp < minTimestamp) {
          return { ok: false, error: `${label} must be on or after ${rules.min_date}` };
        }
      }
      if (typeof rules.max_date === 'string') {
        const maxTimestamp = Date.parse(rules.max_date);
        if (!Number.isNaN(maxTimestamp) && timestamp > maxTimestamp) {
          return { ok: false, error: `${label} must be on or before ${rules.max_date}` };
        }
      }
      return { ok: true, value: trimmedValue };
    }
    case 'string':
    default: {
      if (typeof rules.min_length === 'number' && trimmedValue.length < rules.min_length) {
        return { ok: false, error: `${label} must be at least ${rules.min_length} characters` };
      }
      if (typeof rules.max_length === 'number' && trimmedValue.length > rules.max_length) {
        return { ok: false, error: `${label} must be at most ${rules.max_length} characters` };
      }
      if (typeof rules.pattern === 'string') {
        try {
          if (!new RegExp(rules.pattern).test(trimmedValue)) {
            return { ok: false, error: `${label} is in an invalid format` };
          }
        } catch {
          // Ignore invalid patterns already accepted in admin settings.
        }
      }
      return { ok: true, value: stringValue };
    }
  }
}

function validateRegistrationValue(
  schema: RegistrationFieldSchemaRow,
  rawValue: unknown,
  rules: Record<string, unknown>
): { ok: true; value: string } | { ok: false; error: string } {
  if (schema.cardinality !== 'multi') {
    return validateScalarRegistrationValue(schema, rawValue, rules);
  }
  const label = schema.display_label || schema.field_key;
  if (!Array.isArray(rawValue)) return { ok: false, error: `${label} must be an array` };
  if (rawValue.length > 100) {
    return { ok: false, error: `${label} must have at most 100 values` };
  }
  const values: string[] = [];
  for (const item of rawValue) {
    const validated = validateScalarRegistrationValue(schema, item, rules);
    if (!validated.ok) return validated;
    if (!values.includes(validated.value)) values.push(validated.value);
  }
  return { ok: true, value: JSON.stringify(values) };
}

function serializeRegistrationValue(schema: RegistrationFieldSchemaRow, value: unknown): string {
  if (schema.cardinality !== 'multi') return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string') {
    try {
      if (Array.isArray(JSON.parse(value))) return value;
    } catch {
      // Fall through to the explicit invariant error below.
    }
  }
  throw new Error(`registration_multi_value_not_serialized:${schema.field_key}`);
}

export async function validateRegistrationFieldSubmission(
  db: DatabaseSource,
  tenantId: string,
  submitted: Record<string, unknown> | undefined
): Promise<ValidationResult> {
  const schemas = await listRegistrationFieldSchemas(db, tenantId, {
    includeRequiredHidden: true,
  });
  const input =
    submitted && typeof submitted === 'object' && !Array.isArray(submitted) ? submitted : {};
  const values: Record<string, string> = {};

  const missingRequiredFields = schemas
    .filter((schema) => schema.registration_required === 1)
    .filter((schema) => isBlank(input[schema.field_key]))
    .map(toMissingRequiredRegistrationField);

  if (missingRequiredFields.length > 0) {
    return {
      ok: false,
      error: getRequiredFieldError(missingRequiredFields[0].label),
      missingRequiredFields,
    };
  }

  for (const schema of schemas) {
    const rawValue = input[schema.field_key];

    if (isBlank(rawValue)) {
      continue;
    }

    let rules: Record<string, unknown> = {};
    if (schema.validation_rules) {
      try {
        const parsed = JSON.parse(schema.validation_rules);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          rules = parsed as Record<string, unknown>;
        }
      } catch {
        // Ignore malformed validation_rules and proceed without extra checks.
      }
    }

    const validated = validateRegistrationValue(schema, rawValue, rules);
    if (!validated.ok) return validated;
    values[schema.field_key] = validated.value;
  }

  return {
    ok: true,
    values,
    schemas,
  };
}

export async function persistRegistrationFieldValues(
  db: DatabaseSource,
  dbPii: DatabaseSource | null | undefined,
  tenantId: string,
  userId: string,
  values: Record<string, unknown> | undefined,
  schemaDb: DatabaseSource = db
): Promise<void> {
  if (!values || typeof values !== 'object') {
    return;
  }

  const schemas = await listRegistrationFieldSchemas(schemaDb, tenantId, {
    includeRequiredHidden: true,
  });
  const customSchemas = filterCustomRegistrationFieldSchemas(schemas);
  if (customSchemas.length === 0) {
    return;
  }

  const schemaMap = new Map(customSchemas.map((schema) => [schema.field_key, schema] as const));
  const nonPiiValues: Record<string, string> = {};
  const piiValues: Record<string, string> = {};

  for (const [fieldKey, fieldValue] of Object.entries(values)) {
    const schema = schemaMap.get(fieldKey);
    if (!schema) {
      continue;
    }

    const serializedValue = serializeRegistrationValue(schema, fieldValue);
    if (isPiiRegistrationField(schema)) {
      piiValues[fieldKey] = serializedValue;
    } else {
      nonPiiValues[fieldKey] = serializedValue;
    }
  }

  const validation: ValidatedCustomClaimWriteResult = {
    ok: true,
    schemas: customSchemas.map((schema) => ({
      ...schema,
      tenant_id: tenantId,
      id: `${tenantId}:${schema.field_key}`,
      is_pii: isPiiRegistrationField(schema) ? 1 : 0,
      is_required: 0,
      is_active: 1,
      include_in_id_token: 0,
      include_in_userinfo: 0,
      include_in_introspection: 0,
      required_scopes: null,
      scope_mode: 'any',
      is_searchable: 0,
      is_exportable: 0,
      is_vc_claim: 0,
      claim_namespace: null,
      description: null,
      display_order: 0,
      schema_version: 1,
      operation_status: 'active',
      operation_detail: null,
      created_by: null,
      created_at: 0,
      updated_at: 0,
    })),
    nonPiiValues,
    piiValues,
    nonPiiKeysToDelete: [],
    piiKeysToDelete: [],
  };

  await persistCustomClaimWrite({
    db,
    dbPii,
    schemaDb,
    tenantId,
    userId,
    validation,
  });
}

export async function validateRegistrationFieldSubmissionFromEnv(
  env: Env,
  tenantId: string,
  submitted: Record<string, unknown> | undefined
): Promise<ValidationResult> {
  const sources = await resolveCustomClaimRuntimeSourcesFromEnv(env, tenantId);
  return validateRegistrationFieldSubmission(sources.schemaDb, tenantId, submitted);
}

export async function persistRegistrationFieldValuesFromEnv(
  env: Env,
  tenantId: string,
  userId: string,
  values: Record<string, unknown> | undefined
): Promise<void> {
  const sources = await resolveCustomClaimRuntimeSourcesFromEnv(env, tenantId, {
    accountId: userId,
  });
  if (!sources.nonPiiDb || !sources.piiDb) {
    throw new Error('registration_field_account_route_incomplete');
  }
  await persistRegistrationFieldValues(
    sources.nonPiiDb,
    sources.piiDb,
    tenantId,
    userId,
    values,
    sources.schemaDb
  );
}
