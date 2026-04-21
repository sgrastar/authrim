import { D1Adapter } from '@authrim/ar-lib-core';

interface RegistrationFieldSchemaRow {
  field_key: string;
  display_label: string;
  field_type: string;
  registration_required: number;
  validation_rules: string | null;
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
    };

async function listRegistrationFieldSchemas(
  db: D1Database,
  tenantId: string
): Promise<RegistrationFieldSchemaRow[]> {
  const adapter = new D1Adapter({ db });
  return adapter.query<RegistrationFieldSchemaRow>(
    `SELECT field_key, display_label, field_type, registration_required, validation_rules
     FROM custom_claim_schemas
     WHERE tenant_id = ? AND show_on_registration = 1 AND is_active = 1
     ORDER BY registration_order ASC, display_order ASC`,
    [tenantId]
  );
}

function getRequiredFieldError(label: string): string {
  return `${label} is required`;
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

export async function validateRegistrationFieldSubmission(
  db: D1Database,
  tenantId: string,
  submitted: Record<string, unknown> | undefined
): Promise<ValidationResult> {
  const schemas = await listRegistrationFieldSchemas(db, tenantId);
  const input =
    submitted && typeof submitted === 'object' && !Array.isArray(submitted) ? submitted : {};
  const values: Record<string, string> = {};

  for (const schema of schemas) {
    const rawValue = input[schema.field_key];
    const label = schema.display_label || schema.field_key;

    if (isBlank(rawValue)) {
      if (schema.registration_required === 1) {
        return { ok: false, error: getRequiredFieldError(label) };
      }
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
  db: D1Database,
  tenantId: string,
  userId: string,
  values: Record<string, unknown> | undefined,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<void> {
  if (!values || typeof values !== 'object') {
    return;
  }

  const schemas = await listRegistrationFieldSchemas(db, tenantId);
  if (schemas.length === 0) {
    return;
  }

  const schemaKeys = new Set(schemas.map((schema) => schema.field_key));

  for (const [fieldKey, fieldValue] of Object.entries(values)) {
    if (!schemaKeys.has(fieldKey)) {
      continue;
    }

    await db
      .prepare(
        `INSERT INTO user_custom_fields (id, user_id, tenant_id, field_key, field_value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, tenant_id, field_key) DO UPDATE SET field_value = excluded.field_value, updated_at = excluded.updated_at`
      )
      .bind(
        crypto.randomUUID(),
        userId,
        tenantId,
        fieldKey,
        String(fieldValue),
        nowSeconds,
        nowSeconds
      )
      .run();
  }
}
