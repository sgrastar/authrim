import type { KVNamespace } from '@cloudflare/workers-types';
import type { DatabaseSource } from '../../db';
import { ensureDatabaseAdapter, ensureOptionalDatabaseAdapter } from '../../db';
import type { CustomClaimSchema } from './resolver';
import { SchemaLoader } from './schema-loader';
import { UserCustomDataFetcher } from './data-fetcher';
import { upsertUserCustomFieldValue } from './non-pii-storage';

export interface ValidateCustomClaimWriteParams {
  db: DatabaseSource;
  dbPii?: DatabaseSource | null;
  schemaDb?: DatabaseSource;
  cache?: KVNamespace | null;
  tenantId: string;
  userId?: string;
  submitted: Record<string, unknown> | undefined;
  requireCompleteRecord?: boolean;
  mergeExistingValues?: boolean;
  deleteMissingFields?: boolean;
}

export interface ValidatedCustomClaimWriteResult {
  ok: true;
  schemas: CustomClaimSchema[];
  nonPiiValues: Record<string, string>;
  piiValues: Record<string, string>;
  nonPiiKeysToDelete: string[];
  piiKeysToDelete: string[];
}

export interface InvalidCustomClaimWriteResult {
  ok: false;
  error: string;
  missingRequiredFields?: MissingRequiredCustomClaim[];
}

export type CustomClaimWriteValidationResult =
  | ValidatedCustomClaimWriteResult
  | InvalidCustomClaimWriteResult;

export interface PersistCustomClaimWriteParams {
  db: DatabaseSource;
  dbPii?: DatabaseSource | null;
  tenantId: string;
  userId: string;
  validation: ValidatedCustomClaimWriteResult;
}

export interface MissingRequiredCustomClaim {
  fieldKey: string;
  label: string;
  fieldType: string;
}

export interface GetMissingRequiredCustomClaimsParams {
  db: DatabaseSource;
  dbPii?: DatabaseSource | null;
  schemaDb?: DatabaseSource;
  cache?: KVNamespace | null;
  tenantId: string;
  userId: string;
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function getRequiredFieldError(label: string): string {
  return `${label} is required`;
}

function getSchemaLabel(schema: CustomClaimSchema): string {
  return schema.display_label || schema.field_key;
}

function toMissingRequiredCustomClaim(schema: CustomClaimSchema): MissingRequiredCustomClaim {
  return {
    fieldKey: schema.field_key,
    label: getSchemaLabel(schema),
    fieldType: schema.field_type,
  };
}

export function collectMissingRequiredCustomClaims(
  schemas: CustomClaimSchema[],
  values: Map<string, string>
): MissingRequiredCustomClaim[] {
  return schemas
    .filter((schema) => schema.is_required === 1)
    .filter((schema) => isBlank(values.get(schema.field_key)))
    .map(toMissingRequiredCustomClaim);
}

function parseValidationRules(raw: string | null): Record<string, unknown> {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed validation_rules that may already exist in storage.
  }

  return {};
}

function validateValue(
  schema: CustomClaimSchema,
  rawValue: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  const label = getSchemaLabel(schema);
  const rules = parseValidationRules(schema.validation_rules);

  if (schema.field_type === 'boolean') {
    if (typeof rawValue === 'boolean') {
      return { ok: true, value: rawValue ? 'true' : 'false' };
    }

    if (rawValue === 'true' || rawValue === 'false') {
      return { ok: true, value: rawValue };
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

export async function validateCustomClaimWrite(
  params: ValidateCustomClaimWriteParams
): Promise<CustomClaimWriteValidationResult> {
  const {
    db,
    dbPii = null,
    schemaDb = db,
    cache = null,
    tenantId,
    userId,
    submitted,
    requireCompleteRecord = true,
    mergeExistingValues = requireCompleteRecord && !!userId,
    deleteMissingFields = false,
  } = params;

  const schemas = await new SchemaLoader(schemaDb, cache).loadActiveSchemas(tenantId);
  const schemaMap = new Map(schemas.map((schema) => [schema.field_key, schema] as const));
  const input =
    submitted && typeof submitted === 'object' && !Array.isArray(submitted) ? submitted : {};

  const nonPiiValues: Record<string, string> = {};
  const piiValues: Record<string, string> = {};
  const nonPiiKeysToDelete: string[] = [];
  const piiKeysToDelete: string[] = [];

  const mergedValues = new Map<string, string>();
  let existingValues = new Map<string, string>();

  if ((mergeExistingValues || deleteMissingFields) && userId) {
    existingValues = await new UserCustomDataFetcher(db, dbPii).fetch(tenantId, userId, schemas);
  }

  if (mergeExistingValues) {
    for (const [key, value] of existingValues.entries()) {
      mergedValues.set(key, value);
    }
  }

  if (deleteMissingFields) {
    for (const [fieldKey] of existingValues.entries()) {
      if (Object.prototype.hasOwnProperty.call(input, fieldKey)) {
        continue;
      }

      const schema = schemaMap.get(fieldKey);
      if (!schema) {
        continue;
      }

      if (schema.is_pii === 1) {
        piiKeysToDelete.push(fieldKey);
      } else {
        nonPiiKeysToDelete.push(fieldKey);
      }
    }
  }

  for (const [fieldKey, rawValue] of Object.entries(input)) {
    const schema = schemaMap.get(fieldKey);
    if (!schema) {
      continue;
    }

    const label = getSchemaLabel(schema);
    const isPii = schema.is_pii === 1;

    if (isBlank(rawValue)) {
      mergedValues.delete(fieldKey);
      if (isPii) {
        piiKeysToDelete.push(fieldKey);
      } else {
        nonPiiKeysToDelete.push(fieldKey);
      }
      continue;
    }

    if (isPii && !dbPii) {
      return { ok: false, error: `${label} requires PII storage` };
    }

    const validated = validateValue(schema, rawValue);
    if (!validated.ok) {
      return validated;
    }

    mergedValues.set(fieldKey, validated.value);

    if (isPii) {
      piiValues[fieldKey] = validated.value;
    } else {
      nonPiiValues[fieldKey] = validated.value;
    }
  }

  if (requireCompleteRecord) {
    const missingRequiredFields = collectMissingRequiredCustomClaims(schemas, mergedValues);

    if (missingRequiredFields.length > 0) {
      return {
        ok: false,
        error: getRequiredFieldError(missingRequiredFields[0].label),
        missingRequiredFields,
      };
    }
  }

  return {
    ok: true,
    schemas,
    nonPiiValues,
    piiValues,
    nonPiiKeysToDelete,
    piiKeysToDelete,
  };
}

export async function getMissingRequiredCustomClaims(
  params: GetMissingRequiredCustomClaimsParams
): Promise<MissingRequiredCustomClaim[]> {
  const { db, dbPii = null, schemaDb = db, cache = null, tenantId, userId } = params;
  const schemas = await new SchemaLoader(schemaDb, cache).loadActiveSchemas(tenantId);
  const existingValues = await new UserCustomDataFetcher(db, dbPii).fetch(tenantId, userId, schemas);

  return collectMissingRequiredCustomClaims(schemas, existingValues);
}

export async function persistCustomClaimWrite(params: PersistCustomClaimWriteParams): Promise<void> {
  const { db, dbPii = null, tenantId, userId, validation } = params;
  const coreAdapter = ensureDatabaseAdapter(db, 'custom-claims-write-core');
  const piiAdapter = ensureOptionalDatabaseAdapter(dbPii, 'custom-claims-write-pii');
  const schemaMap = new Map(validation.schemas.map((schema) => [schema.field_key, schema] as const));

  for (const [fieldKey, fieldValue] of Object.entries(validation.nonPiiValues)) {
    const schema = schemaMap.get(fieldKey);
    const fieldType = schema?.field_type ?? 'string';

    await upsertUserCustomFieldValue({
      adapter: coreAdapter,
      userId,
      tenantId,
      fieldName: fieldKey,
      fieldValue,
      fieldType,
    });
  }

  for (const fieldKey of validation.nonPiiKeysToDelete) {
    await coreAdapter.execute(
      'DELETE FROM user_custom_fields WHERE tenant_id = ? AND user_id = ? AND field_name = ?',
      [tenantId, userId, fieldKey]
    );
  }

  const hasPiiChanges =
    Object.keys(validation.piiValues).length > 0 || validation.piiKeysToDelete.length > 0;
  if (!hasPiiChanges) {
    return;
  }

  if (!piiAdapter) {
    throw new Error('PII storage is not available');
  }

  const currentRow = await piiAdapter.queryOne<{ custom_attributes_json: string | null }>(
    'SELECT custom_attributes_json FROM users_pii WHERE id = ? AND tenant_id = ?',
    [userId, tenantId]
  );

  if (!currentRow) {
    throw new Error('PII user record not found');
  }

  let attributes: Record<string, unknown> = {};
  if (currentRow.custom_attributes_json) {
    try {
      const parsed = JSON.parse(currentRow.custom_attributes_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        attributes = parsed as Record<string, unknown>;
      }
    } catch {
      attributes = {};
    }
  }

  for (const fieldKey of validation.piiKeysToDelete) {
    delete attributes[fieldKey];
  }

  for (const [fieldKey, fieldValue] of Object.entries(validation.piiValues)) {
    attributes[fieldKey] = fieldValue;
  }

  const serialized = Object.keys(attributes).length > 0 ? JSON.stringify(attributes) : '{}';

  await piiAdapter.execute(
    'UPDATE users_pii SET custom_attributes_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
    [serialized, Date.now(), userId, tenantId]
  );
}
