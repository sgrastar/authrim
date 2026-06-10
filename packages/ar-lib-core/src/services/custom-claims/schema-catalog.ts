import type { DatabaseAdapter, DatabaseSource } from '../../db';
import { ensureDatabaseAdapter } from '../../db';

export interface RegistrationFieldSchemaRow {
  field_key: string;
  display_label: string;
  field_type: string;
  is_pii: number;
  registration_required: number;
  registration_order: number;
  registration_placeholder: string | null;
  validation_rules: string | null;
}

export interface RegistrationFieldDefinition {
  field_key: string;
  display_label: string;
  field_type: string;
  required: boolean;
  order: number;
  placeholder: string | null;
  validation_rules: Record<string, unknown> | null;
}

export interface SeedCustomClaimSchemaInput {
  field_key: string;
  display_label: string;
  field_type: string;
  is_pii: number;
  is_required?: number;
  is_system?: number;
  is_searchable: number;
  is_exportable: number;
  display_order: number;
  ui_group_key?: string | null;
  ui_group_label?: string | null;
  ui_group_order?: number;
  ui_field_order?: number;
  examples_json?: string | null;
}

export interface SeedCustomClaimSchemasParams {
  db: DatabaseSource;
  tenantId: string;
  schemas: SeedCustomClaimSchemaInput[];
  now?: number;
  idFactory?: () => string;
}

function getAdapter(db: DatabaseSource): DatabaseAdapter {
  return ensureDatabaseAdapter(db, 'custom-claims-schema-catalog');
}

export async function listRegistrationFieldSchemas(
  db: DatabaseSource,
  tenantId: string
): Promise<RegistrationFieldSchemaRow[]> {
  return getAdapter(db).query<RegistrationFieldSchemaRow>(
    `SELECT field_key, display_label, field_type, is_pii, registration_required,
            registration_order, registration_placeholder, validation_rules
     FROM custom_claim_schemas
     WHERE tenant_id = ? AND show_on_registration = 1 AND is_active = 1
     ORDER BY registration_order ASC, display_order ASC`,
    [tenantId]
  );
}

export function parseRegistrationFieldDefinitions(
  rows: RegistrationFieldSchemaRow[]
): RegistrationFieldDefinition[] {
  return rows.map((row) => {
    let validationRules: Record<string, unknown> | null = null;
    if (row.validation_rules) {
      try {
        const parsed = JSON.parse(row.validation_rules);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          validationRules = parsed as Record<string, unknown>;
        }
      } catch {
        validationRules = null;
      }
    }

    return {
      field_key: row.field_key,
      display_label: row.display_label,
      field_type: row.field_type,
      required: row.registration_required === 1,
      order: row.registration_order,
      placeholder: row.registration_placeholder,
      validation_rules: validationRules,
    };
  });
}

export async function listRegistrationFieldDefinitions(
  db: DatabaseSource,
  tenantId: string
): Promise<RegistrationFieldDefinition[]> {
  return parseRegistrationFieldDefinitions(await listRegistrationFieldSchemas(db, tenantId));
}

export async function seedCustomClaimSchemas({
  db,
  tenantId,
  schemas,
  now = Math.floor(Date.now() / 1000),
  idFactory = () => crypto.randomUUID(),
}: SeedCustomClaimSchemasParams): Promise<number> {
  const adapter = getAdapter(db);
  let createdCount = 0;

  for (const schema of schemas) {
    const existing = await adapter.queryOne<{ id: string }>(
      'SELECT id FROM custom_claim_schemas WHERE tenant_id = ? AND field_key = ?',
      [tenantId, schema.field_key]
    );
    if (existing) {
      continue;
    }

    await adapter.execute(
      `INSERT INTO custom_claim_schemas (
        id, tenant_id, field_key, active_field_key, display_label, field_type,
        is_pii, is_required, is_active, is_system,
        is_searchable, is_exportable, is_vc_claim,
        include_in_id_token, include_in_userinfo, include_in_introspection,
        scope_mode, display_order, ui_group_key, ui_group_label, ui_group_order, ui_field_order,
        examples_json, schema_version, operation_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, 0, 1, 0, 'any', ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`,
      [
        idFactory(),
        tenantId,
        schema.field_key,
        schema.field_key,
        schema.display_label,
        schema.field_type,
        schema.is_pii,
        schema.is_required ?? 0,
        schema.is_system ?? 1,
        schema.is_searchable,
        schema.is_exportable,
        schema.display_order,
        schema.ui_group_key ?? null,
        schema.ui_group_label ?? null,
        schema.ui_group_order ?? 0,
        schema.ui_field_order ?? schema.display_order,
        schema.examples_json ?? null,
        now,
        now,
      ]
    );
    createdCount += 1;
  }

  return createdCount;
}
