import type { DatabaseAdapter } from '../../db/adapter.js';

const MAX_GROUPS = 4096;
const MAX_FIELDS = 8192;
const MAX_FIELDS_PER_GROUP = 1024;

interface AttributeGroupRow {
  protocol: unknown;
  field_keys_json: unknown;
}

interface AttributeFieldRow {
  protocol: unknown;
  field_key: unknown;
}

function invalid(): never {
  throw new Error('backup_phase3_semantic_reference_invalid');
}

function parseFieldKeys(value: unknown): string[] {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > 256 * 1024) invalid();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length > MAX_FIELDS_PER_GROUP) invalid();
    const fields: string[] = [];
    for (const field of parsed as unknown[]) {
      if (typeof field !== 'string' || !field || new TextEncoder().encode(field).length > 512)
        invalid();
      fields.push(field);
    }
    return [...new Set(fields)];
  } catch {
    return invalid();
  }
}

/**
 * Verify Phase 3 references whose logical keys cannot be represented by the generic record-ID
 * graph. Platform fields are installed reference data and may satisfy a tenant-owned group.
 */
export async function verifyPhase3LogicalReferences(input: {
  tenantId: string;
  admin: Pick<DatabaseAdapter, 'query'>;
}): Promise<void> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.tenantId)) invalid();
  const [groups, fields] = await Promise.all([
    input.admin.query<AttributeGroupRow>(
      `SELECT protocol, field_keys_json
         FROM attribute_group_registry
        WHERE tenant_id = ?
        ORDER BY id ASC
        LIMIT ?`,
      [input.tenantId, MAX_GROUPS + 1]
    ),
    input.admin.query<AttributeFieldRow>(
      `SELECT protocol, field_key
         FROM attribute_field_registry
        WHERE tenant_id IN (?, 'platform')
        ORDER BY id ASC
        LIMIT ?`,
      [input.tenantId, MAX_FIELDS + 1]
    ),
  ]);
  if (groups.length > MAX_GROUPS || fields.length > MAX_FIELDS) invalid();

  const installed = new Set<string>();
  for (const field of fields) {
    if (
      typeof field.protocol !== 'string' ||
      !field.protocol ||
      typeof field.field_key !== 'string' ||
      !field.field_key
    )
      invalid();
    installed.add(`${field.protocol}\u0000${field.field_key}`);
  }
  for (const group of groups) {
    if (typeof group.protocol !== 'string' || !group.protocol) invalid();
    for (const fieldKey of parseFieldKeys(group.field_keys_json)) {
      if (!installed.has(`${group.protocol}\u0000${fieldKey}`))
        throw new Error('backup_phase3_semantic_reference_missing');
    }
  }
}
