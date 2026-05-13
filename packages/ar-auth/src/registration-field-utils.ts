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
    value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
  );
}

export async function validateRegistrationFieldSubmission(
  db: DatabaseSource,
  tenantId: string,
  submitted: Record<string, unknown> | undefined
): Promise<ValidationResult> {
  const schemas = await listRegistrationFieldSchemas(db, tenantId);
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
    const label = schema.display_label || schema.field_key;

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

    if (schema.field_type === 'boolean') {
      if (typeof rawValue === 'boolean') {
        values[schema.field_key] = rawValue ? 'true' : 'false';
        continue;
      }

      if (rawValue === 'true' || rawValue === 'false') {
        values[schema.field_key] = rawValue;
        continue;
      }

      return { ok: false, error: `${label} must be true or false` };
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
        values[schema.field_key] = trimmedValue;
        break;
      }
      case 'enum': {
        const enumValues = Array.isArray(rules.enum_values)
          ? rules.enum_values.filter((value): value is string => typeof value === 'string')
          : [];
        if (enumValues.length > 0 && !enumValues.includes(trimmedValue)) {
          return { ok: false, error: `${label} must be one of the configured options` };
        }
        values[schema.field_key] = trimmedValue;
        break;
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

        values[schema.field_key] = trimmedValue;
        break;
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
        values[schema.field_key] = stringValue;
        break;
      }
    }
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
  values: Record<string, unknown> | undefined
): Promise<void> {
  if (!values || typeof values !== 'object') {
    return;
  }

  const schemas = await listRegistrationFieldSchemas(db, tenantId);
  if (schemas.length === 0) {
    return;
  }

  const schemaMap = new Map(schemas.map((schema) => [schema.field_key, schema] as const));
  const nonPiiValues: Record<string, string> = {};
  const piiValues: Record<string, string> = {};

  for (const [fieldKey, fieldValue] of Object.entries(values)) {
    const schema = schemaMap.get(fieldKey);
    if (!schema) {
      continue;
    }

    if (schema.is_pii === 1) {
      piiValues[fieldKey] = String(fieldValue);
    } else {
      nonPiiValues[fieldKey] = String(fieldValue);
    }
  }

  const validation: ValidatedCustomClaimWriteResult = {
    ok: true,
    schemas: schemas.map((schema) => ({
      ...schema,
      tenant_id: tenantId,
      id: `${tenantId}:${schema.field_key}`,
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
    tenantId,
    userId,
    validation,
  });
}

export async function validateRegistrationFieldSubmissionFromEnv(
  env: Pick<
    Env,
    | 'DB'
    | 'DB_PII'
    | 'DB_ADMIN'
    | 'SETTINGS'
    | 'AUTHRIM_CONFIG'
    | 'PROFILE_REGISTRY_BACKEND'
    | 'DEFAULT_STORAGE_PROFILE_ID'
    | 'DEFAULT_AUDIT_PROFILE_ID'
    | 'DEFAULT_RESIDENCY_PROFILE_ID'
  >,
  tenantId: string,
  submitted: Record<string, unknown> | undefined
): Promise<ValidationResult> {
  const sources = await resolveCustomClaimRuntimeSourcesFromEnv(env, tenantId);
  return validateRegistrationFieldSubmission(sources.schemaDb, tenantId, submitted);
}

export async function persistRegistrationFieldValuesFromEnv(
  env: Pick<
    Env,
    | 'DB'
    | 'DB_PII'
    | 'DB_ADMIN'
    | 'SETTINGS'
    | 'AUTHRIM_CONFIG'
    | 'PROFILE_REGISTRY_BACKEND'
    | 'DEFAULT_STORAGE_PROFILE_ID'
    | 'DEFAULT_AUDIT_PROFILE_ID'
    | 'DEFAULT_RESIDENCY_PROFILE_ID'
  >,
  tenantId: string,
  userId: string,
  values: Record<string, unknown> | undefined
): Promise<void> {
  const sources = await resolveCustomClaimRuntimeSourcesFromEnv(env, tenantId);
  await persistRegistrationFieldValues(sources.nonPiiDb, sources.piiDb, tenantId, userId, values);
}
