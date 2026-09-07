import type { DatabaseAdapter, DatabaseSource } from '../../db';
import { ensureDatabaseAdapter } from '../../db';

export interface RegistrationFieldSchemaRow {
  field_key: string;
  display_label: string;
  field_type: string;
  cardinality?: 'single' | 'multi';
  is_pii: number | boolean;
  registration_required: number | boolean;
  registration_order: number;
  registration_placeholder: string | null;
  validation_rules: string | null;
}

export interface RegistrationFieldDefinition {
  field_key: string;
  display_label: string;
  field_type: string;
  cardinality: 'single' | 'multi';
  required: boolean;
  order: number;
  placeholder: string | null;
  validation_rules: Record<string, unknown> | null;
}

export interface SeedCustomClaimSchemaInput {
  field_key: string;
  display_label: string;
  field_type: string;
  cardinality?: 'single' | 'multi';
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

export const BUILTIN_PROFILE_CLAIM_KEYS = [
  'email',
  'email_verified',
  'display_name',
  'given_name',
  'family_name',
  'preferred_username',
  'picture_url',
  'locale',
] as const;

export type BuiltinProfileClaimKey = (typeof BUILTIN_PROFILE_CLAIM_KEYS)[number];

/**
 * Protocol-neutral profile fields created for every tenant.
 *
 * These definitions are deliberately optional. Protocol adapters may enforce stronger
 * requirements at their own boundaries, but enabling a protocol must not make a tenant-wide
 * profile field required.
 */
export const BUILTIN_PROFILE_CLAIM_SCHEMAS: readonly SeedCustomClaimSchemaInput[] = [
  {
    field_key: 'display_name',
    display_label: 'Display Name',
    field_type: 'string',
    is_pii: 1,
    is_searchable: 1,
    is_exportable: 1,
    display_order: 1,
    ui_group_key: 'profile',
    ui_group_label: 'Profile',
    ui_group_order: 10,
    ui_field_order: 1,
    examples_json: JSON.stringify({ values: ['John Doe', '山田 太郎'] }),
  },
  {
    field_key: 'given_name',
    display_label: 'Given Name',
    field_type: 'string',
    is_pii: 1,
    is_searchable: 1,
    is_exportable: 1,
    display_order: 2,
    ui_group_key: 'profile',
    ui_group_label: 'Profile',
    ui_group_order: 10,
    ui_field_order: 2,
    examples_json: JSON.stringify({ values: ['John', '太郎'] }),
  },
  {
    field_key: 'family_name',
    display_label: 'Family Name',
    field_type: 'string',
    is_pii: 1,
    is_searchable: 1,
    is_exportable: 1,
    display_order: 3,
    ui_group_key: 'profile',
    ui_group_label: 'Profile',
    ui_group_order: 10,
    ui_field_order: 3,
    examples_json: JSON.stringify({ values: ['Doe', '山田'] }),
  },
  {
    field_key: 'preferred_username',
    display_label: 'Preferred Username',
    field_type: 'string',
    is_pii: 0,
    is_searchable: 1,
    is_exportable: 1,
    display_order: 4,
    ui_group_key: 'profile',
    ui_group_label: 'Profile',
    ui_group_order: 10,
    ui_field_order: 4,
    examples_json: JSON.stringify({ values: ['jdoe'] }),
  },
  {
    field_key: 'picture_url',
    display_label: 'Picture URL',
    field_type: 'string',
    is_pii: 1,
    is_searchable: 0,
    is_exportable: 1,
    display_order: 5,
    ui_group_key: 'profile',
    ui_group_label: 'Profile',
    ui_group_order: 10,
    ui_field_order: 5,
    examples_json: JSON.stringify({ values: ['https://example.com/users/jdoe/photo.jpg'] }),
  },
  {
    field_key: 'locale',
    display_label: 'Locale',
    field_type: 'string',
    is_pii: 0,
    is_searchable: 0,
    is_exportable: 1,
    display_order: 6,
    ui_group_key: 'profile',
    ui_group_label: 'Profile',
    ui_group_order: 10,
    ui_field_order: 6,
    examples_json: JSON.stringify({ values: ['ja-JP', 'en-US'] }),
  },
  {
    field_key: 'email',
    display_label: 'Email',
    field_type: 'string',
    is_pii: 1,
    is_searchable: 1,
    is_exportable: 1,
    display_order: 20,
    ui_group_key: 'contact',
    ui_group_label: 'Contact',
    ui_group_order: 20,
    ui_field_order: 1,
    examples_json: JSON.stringify({ values: ['john@example.com'] }),
  },
  {
    field_key: 'email_verified',
    display_label: 'Email Verified',
    field_type: 'boolean',
    is_pii: 0,
    is_searchable: 0,
    is_exportable: 0,
    display_order: 21,
    ui_group_key: 'contact',
    ui_group_label: 'Contact',
    ui_group_order: 20,
    ui_field_order: 2,
    examples_json: JSON.stringify({ values: [true] }),
  },
];

export interface SeedCustomClaimSchemasParams {
  db: DatabaseSource;
  tenantId: string;
  schemas: SeedCustomClaimSchemaInput[];
  now?: number;
  idFactory?: (schema: SeedCustomClaimSchemaInput) => string;
}

function getAdapter(db: DatabaseSource): DatabaseAdapter {
  return ensureDatabaseAdapter(db, 'custom-claims-schema-catalog');
}

export async function listRegistrationFieldSchemas(
  db: DatabaseSource,
  tenantId: string,
  options: { includeRequiredHidden?: boolean } = {}
): Promise<RegistrationFieldSchemaRow[]> {
  const visibilityFilter = options.includeRequiredHidden
    ? '(show_on_registration = TRUE OR registration_required = TRUE)'
    : 'show_on_registration = TRUE';
  const rows = await getAdapter(db).query<RegistrationFieldSchemaRow>(
    `SELECT field_key, display_label, field_type, cardinality, is_pii, registration_required,
            registration_order, registration_placeholder, validation_rules
     FROM custom_claim_schemas
     WHERE tenant_id = ? AND ${visibilityFilter} AND is_active = TRUE
     ORDER BY registration_order ASC, display_order ASC`,
    [tenantId]
  );
  return rows.map((row) => ({
    ...row,
    is_pii: row.is_pii === true ? 1 : row.is_pii === false ? 0 : row.is_pii,
    registration_required:
      row.registration_required === true
        ? 1
        : row.registration_required === false
          ? 0
          : row.registration_required,
  }));
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
      cardinality: row.cardinality ?? 'single',
      required: row.registration_required === 1 || row.registration_required === true,
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
  const usesNativeBooleans = adapter.getType() === 'postgres';
  const databaseFlag = (value: number): number | boolean =>
    usesNativeBooleans ? value === 1 : value;
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
        id, tenant_id, field_key, active_field_key, display_label, field_type, cardinality,
        is_pii, is_required, is_active, is_system,
        is_searchable, is_exportable, is_vc_claim,
        include_in_id_token, include_in_userinfo, include_in_introspection,
        scope_mode, display_order, ui_group_key, ui_group_label, ui_group_order, ui_field_order,
        examples_json, schema_version, operation_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?, ?, ?, FALSE, FALSE, FALSE, FALSE, 'any', ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`,
      [
        idFactory(schema),
        tenantId,
        schema.field_key,
        schema.field_key,
        schema.display_label,
        schema.field_type,
        schema.cardinality ?? 'single',
        databaseFlag(schema.is_pii),
        databaseFlag(schema.is_required ?? 0),
        databaseFlag(schema.is_system ?? 1),
        databaseFlag(schema.is_searchable),
        databaseFlag(schema.is_exportable),
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

export async function seedBuiltinProfileClaimSchemas(
  input: Omit<SeedCustomClaimSchemasParams, 'schemas' | 'idFactory'>
): Promise<number> {
  return seedCustomClaimSchemas({
    ...input,
    schemas: [...BUILTIN_PROFILE_CLAIM_SCHEMAS],
    idFactory: (schema) => `builtin:${input.tenantId}:${schema.field_key}`,
  });
}
