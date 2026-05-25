import type { DatabaseSource } from '../../db';
import { ensureDatabaseAdapter, escapeLikePattern } from '../../db';

export type CustomClaimSchemaRecord = Record<string, unknown>;

export interface ListCustomClaimSchemasParams {
  tenantId: string;
  search?: string | null;
  fieldType?: string | null;
  isPii?: number | null;
  isActive?: number | null;
  isSystem?: number | null;
  operationStatus?: string | null;
  limit: number;
  offset: number;
}

export interface ListCustomClaimSchemasResult<
  TSchema extends CustomClaimSchemaRecord = CustomClaimSchemaRecord,
> {
  schemas: TSchema[];
  total: number;
}

export interface UpdateCustomClaimSchemaFieldsParams {
  db: DatabaseSource;
  tenantId: string;
  schemaId: string;
  updates: Record<string, unknown>;
  allowedCurrentStatuses?: string[];
  incrementSchemaVersion?: boolean;
}

function getAdapter(db: DatabaseSource) {
  return ensureDatabaseAdapter(db, 'custom-claims-schema-admin');
}

function normalizeActiveFieldKey(fieldKey: unknown, isActive: unknown): string | null {
  return typeof fieldKey === 'string' && (isActive === 1 || isActive === true) ? fieldKey : null;
}

function buildSchemaWhereClause(params: Omit<ListCustomClaimSchemasParams, 'limit' | 'offset'>): {
  whereClause: string;
  queryParams: unknown[];
} {
  const whereConditions = ['tenant_id = ?'];
  const queryParams: unknown[] = [params.tenantId];

  if (params.search) {
    whereConditions.push('(field_key LIKE ? OR display_label LIKE ? OR description LIKE ?)');
    const pattern = `%${escapeLikePattern(params.search)}%`;
    queryParams.push(pattern, pattern, pattern);
  }

  if (params.fieldType) {
    whereConditions.push('field_type = ?');
    queryParams.push(params.fieldType);
  }

  if (params.isPii === 0 || params.isPii === 1) {
    whereConditions.push('is_pii = ?');
    queryParams.push(params.isPii);
  }

  if (params.isActive === 0 || params.isActive === 1) {
    whereConditions.push('is_active = ?');
    queryParams.push(params.isActive);
  }

  if (params.isSystem === 0 || params.isSystem === 1) {
    whereConditions.push('is_system = ?');
    queryParams.push(params.isSystem);
  }

  if (params.operationStatus) {
    whereConditions.push('operation_status = ?');
    queryParams.push(params.operationStatus);
  }

  return {
    whereClause: whereConditions.join(' AND '),
    queryParams,
  };
}

export async function listCustomClaimSchemas<
  TSchema extends CustomClaimSchemaRecord = CustomClaimSchemaRecord,
>(
  db: DatabaseSource,
  params: ListCustomClaimSchemasParams
): Promise<ListCustomClaimSchemasResult<TSchema>> {
  const adapter = getAdapter(db);
  const { whereClause, queryParams } = buildSchemaWhereClause(params);

  const countResult = await adapter.query<{ count: number }>(
    `SELECT COUNT(*) as count FROM custom_claim_schemas WHERE ${whereClause}`,
    queryParams
  );
  const schemas = await adapter.query<TSchema>(
    `SELECT * FROM custom_claim_schemas WHERE ${whereClause} ORDER BY display_order ASC, created_at ASC LIMIT ? OFFSET ?`,
    [...queryParams, params.limit, params.offset]
  );

  return {
    schemas,
    total: countResult[0]?.count || 0,
  };
}

export async function getCustomClaimSchemaById<
  TSchema extends CustomClaimSchemaRecord = CustomClaimSchemaRecord,
>(db: DatabaseSource, tenantId: string, schemaId: string): Promise<TSchema | null> {
  const adapter = getAdapter(db);
  const rows = await adapter.query<TSchema>(
    'SELECT * FROM custom_claim_schemas WHERE id = ? AND tenant_id = ?',
    [schemaId, tenantId]
  );
  return rows[0] ?? null;
}

export async function findActiveCustomClaimSchemaByFieldKey<
  TSchema extends CustomClaimSchemaRecord = CustomClaimSchemaRecord,
>(
  db: DatabaseSource,
  tenantId: string,
  fieldKey: string,
  options: { excludeSchemaId?: string } = {}
): Promise<TSchema | null> {
  const adapter = getAdapter(db);

  if (options.excludeSchemaId) {
    const rows = await adapter.query<TSchema>(
      'SELECT * FROM custom_claim_schemas WHERE tenant_id = ? AND active_field_key = ? AND id != ?',
      [tenantId, fieldKey, options.excludeSchemaId]
    );
    return rows[0] ?? null;
  }

  const rows = await adapter.query<TSchema>(
    'SELECT * FROM custom_claim_schemas WHERE tenant_id = ? AND active_field_key = ?',
    [tenantId, fieldKey]
  );
  return rows[0] ?? null;
}

export async function insertCustomClaimSchema(
  db: DatabaseSource,
  schema: Record<string, unknown>
): Promise<void> {
  const adapter = getAdapter(db);
  const normalizedSchema = { ...schema };
  if (!('active_field_key' in normalizedSchema)) {
    normalizedSchema.active_field_key = normalizeActiveFieldKey(
      normalizedSchema.field_key,
      normalizedSchema.is_active ?? 1
    );
  }
  const entries = Object.entries(normalizedSchema);
  const columns = entries.map(([key]) => key);
  const placeholders = columns.map(() => '?');
  const values = entries.map(([, value]) => value);

  await adapter.execute(
    `INSERT INTO custom_claim_schemas (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    values
  );
}

export async function updateCustomClaimSchemaFields(
  params: UpdateCustomClaimSchemaFieldsParams
): Promise<number> {
  const {
    db,
    tenantId,
    schemaId,
    updates,
    allowedCurrentStatuses,
    incrementSchemaVersion = false,
  } = params;
  const adapter = getAdapter(db);
  const normalizedUpdates = { ...updates };
  if ('field_key' in normalizedUpdates || 'is_active' in normalizedUpdates) {
    const existing = await getCustomClaimSchemaById<Record<string, unknown>>(
      db,
      tenantId,
      schemaId
    );
    if (!existing) {
      return 0;
    }
    const nextFieldKey = normalizedUpdates.field_key ?? existing.field_key;
    const nextIsActive = normalizedUpdates.is_active ?? existing.is_active ?? 1;
    normalizedUpdates.active_field_key = normalizeActiveFieldKey(nextFieldKey, nextIsActive);
  }
  const updateEntries = Object.entries(normalizedUpdates);
  const setClauses = updateEntries.map(([key]) => `${key} = ?`);
  const values = updateEntries.map(([, value]) => value);

  if (incrementSchemaVersion) {
    setClauses.push('schema_version = schema_version + 1');
  }

  if (setClauses.length === 0) {
    return 0;
  }

  const whereClauses = ['id = ?', 'tenant_id = ?'];
  const whereValues: unknown[] = [schemaId, tenantId];

  if (allowedCurrentStatuses && allowedCurrentStatuses.length > 0) {
    whereClauses.push(`operation_status IN (${allowedCurrentStatuses.map(() => '?').join(', ')})`);
    whereValues.push(...allowedCurrentStatuses);
  }

  const result = await adapter.execute(
    `UPDATE custom_claim_schemas SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`,
    [...values, ...whereValues]
  );

  return result.rowsAffected;
}

export async function deleteCustomClaimSchemaById(
  db: DatabaseSource,
  tenantId: string,
  schemaId: string
): Promise<number> {
  const adapter = getAdapter(db);
  const result = await adapter.execute(
    'DELETE FROM custom_claim_schemas WHERE id = ? AND tenant_id = ?',
    [schemaId, tenantId]
  );
  return result.rowsAffected;
}
