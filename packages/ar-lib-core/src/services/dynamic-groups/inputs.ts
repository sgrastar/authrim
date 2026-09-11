import type { DatabaseAdapter } from '../../db';
import { BUILTIN_GROUP_FIELDS, type EvaluationInput, type Field, type GroupPlan } from './model';
import type { GroupInputReader, InputVersion } from './store';
const primary = { consistencyClass: 'primary_required' as const };
interface SchemaRow {
  id: string;
  field_key: string;
  field_type: string;
  cardinality: string;
  is_pii: number;
  schema_version: number;
}
export async function loadGroupFields(
  db: DatabaseAdapter,
  tenantId: string
): Promise<Record<string, Field>> {
  const schemas = await db.query<SchemaRow>(
    `SELECT id, field_key, field_type, cardinality, is_pii, schema_version FROM custom_claim_schemas WHERE tenant_id = ? AND is_active = 1 AND operation_status = 'active' ORDER BY field_key LIMIT 1000`,
    [tenantId],
    primary
  );
  const fields = { ...BUILTIN_GROUP_FIELDS };
  for (const row of schemas) {
    if (!['string', 'number', 'boolean', 'enum', 'date'].includes(row.field_type)) continue;
    fields[`custom.${row.field_key}`] = {
      type: `${['enum', 'date'].includes(row.field_type) ? 'string' : row.field_type}${row.cardinality === 'multi' ? '[]' : ''}` as Field['type'],
      schemaId: row.id,
      schemaVersion: Number(row.schema_version),
      pii: !!row.is_pii,
    };
  }
  return fields;
}
/** Strict storage decoding; unlike presentation casters, malformed booleans are not false. */
function decode(raw: unknown, field: Field): unknown {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'string') return undefined;
  if (field.type.endsWith('[]')) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }
  if (field.type === 'boolean')
    return raw === 'true' || raw === '1'
      ? true
      : raw === 'false' || raw === '0'
        ? false
        : undefined;
  if (field.type === 'number')
    return raw.trim() &&
      /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) &&
      Number.isFinite(Number(raw))
      ? Number(raw)
      : undefined;
  return raw;
}
function json(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Account routing must already be resolved; never falls back from a missing shard to a shared DB. */
export class SavedGroupInputReader implements GroupInputReader {
  constructor(
    readonly metadata: DatabaseAdapter,
    readonly core: DatabaseAdapter,
    readonly pii: DatabaseAdapter,
    readonly tenantId: string,
    readonly userId: string,
    readonly route?: { stamp: string; verify: () => Promise<void> }
  ) {}
  async unsettledWrites(): Promise<
    Array<{ id: string; operation: string; status: string; created_at: number }>
  > {
    const rows = [];
    for (const db of [this.core, this.pii])
      rows.push(
        ...(await db.query<{ id: string; operation: string; status: string; created_at: number }>(
          'SELECT id, operation, status, created_at FROM service_group_write_boundaries WHERE tenant_id = ? AND user_id = ? ORDER BY created_at LIMIT 50',
          [this.tenantId, this.userId],
          primary
        ))
      );
    return rows;
  }
  /** Explicit operator acceptance of repaired, saved attributes. Never clears an in-flight writer. */
  async acceptFailedWrites(ids: string[], actorId: string): Promise<void> {
    if (!ids.length || ids.length > 50 || new Set(ids).size !== ids.length)
      throw new Error('group_recovery_invalid');
    const rows = await this.unsettledWrites();
    if (ids.some((id) => !rows.some((row) => row.id === id && row.status === 'failed')))
      throw new Error('group_recovery_conflict');
    await this.metadata.execute(
      `INSERT INTO service_group_audit(id, tenant_id, user_id, rule_version, generation, event_type, detail_json, created_at) VALUES (?, ?, ?, 0, 0, 'input_recovery', ?, ?)`,
      [
        crypto.randomUUID(),
        this.tenantId,
        this.userId,
        JSON.stringify({ actorId, acceptedBoundaryIds: ids }),
        Date.now(),
      ]
    );
    for (const db of [this.core, this.pii])
      await db.batch(
        ids.map((id) => ({
          sql: "DELETE FROM service_group_write_boundaries WHERE tenant_id = ? AND user_id = ? AND id = ? AND status = 'failed'",
          params: [this.tenantId, this.userId, id],
        }))
      );
  }
  async version(): Promise<InputVersion> {
    await this.route?.verify();
    for (const db of [this.core, this.pii]) {
      const open = await db.queryOne(
        'SELECT id FROM service_group_write_boundaries WHERE tenant_id = ? AND user_id = ? LIMIT 1',
        [this.tenantId, this.userId],
        primary
      );
      if (open) throw new Error('group_input_write_unsettled');
    }
    const revision = async (db: DatabaseAdapter) =>
      Number(
        (
          await db.queryOne<{ revision: number }>(
            'SELECT revision FROM service_group_inputs WHERE tenant_id = ? AND user_id = ?',
            [this.tenantId, this.userId],
            primary
          )
        )?.revision ?? 0
      );
    const [core, pii, metadata, epoch] = await Promise.all([
      revision(this.core),
      revision(this.pii),
      revision(this.metadata),
      this.metadata.queryOne<{ revision: number }>(
        'SELECT revision FROM service_group_epoch WHERE tenant_id = ?',
        [this.tenantId],
        primary
      ),
    ]);
    return {
      ...(this.route ? { route: this.route.stamp } : {}),
      core,
      pii,
      metadata,
      epoch: Number(epoch?.revision ?? 0),
    };
  }
  async load(plan: GroupPlan): Promise<EvaluationInput> {
    if (plan.tenantId !== this.tenantId) throw new Error('group_tenant_mismatch');
    const account = await this.core.queryOne<{
      id: string;
      account_type: string;
      registration_state: string;
      directory_publication_state: string;
      lifecycle_state: string;
    }>(
      'SELECT id, account_type, registration_state, directory_publication_state, lifecycle_state FROM identity_accounts WHERE tenant_id = ? AND legacy_user_id = ?',
      [this.tenantId, this.userId],
      primary
    );
    if (!account || account.account_type !== 'user') throw new Error('group_subject_unavailable');
    if (account.lifecycle_state !== 'active' || account.directory_publication_state !== 'active')
      throw new Error('group_subject_not_active');
    const currentFields = await loadGroupFields(this.metadata, this.tenantId);
    for (const key of Object.keys(plan.attributes)) {
      if (JSON.stringify(currentFields[key]) !== JSON.stringify(plan.fields[key]))
        throw new Error('group_attribute_schema_changed');
    }
    const attributes: Record<string, unknown> = { registration_state: account.registration_state };
    const used = Object.keys(plan.attributes);
    const needEmail = used.some((key) => ['email', 'email_domain', 'email_verified'].includes(key));
    if (needEmail) {
      const contacts = await this.core.query<{
        verification_state: string;
        value_storage_ref: string | null;
      }>(
        `SELECT verification_state, value_storage_ref FROM contact_points WHERE tenant_id = ? AND account_id = ? AND contact_type = 'email' AND is_primary = 1 AND lifecycle_state = 'active'`,
        [this.tenantId, account.id],
        primary
      );
      if (
        contacts.length === 1 &&
        ['verified', 'unverified'].includes(contacts[0].verification_state)
      )
        attributes.email_verified = contacts[0].verification_state === 'verified';
    }
    const sensitiveKeys = new Set<string>();
    if (needEmail && attributes.email_verified === true) sensitiveKeys.add('email');
    if (used.includes('country')) {
      sensitiveKeys.add('address_country');
      sensitiveKeys.add('address_json');
    }
    for (const key of used)
      if (key.startsWith('custom.') && plan.fields[key].pii)
        sensitiveKeys.add(`custom_attribute:${key.slice(7)}`);
    const sensitive: Record<string, unknown> = {};
    // Bound D1 parameters, preserving every requested field rather than truncating results.
    const keys = [...sensitiveKeys];
    for (let start = 0; start < keys.length; start += 40) {
      const batch = keys.slice(start, start + 40);
      const rows = await this.pii.query<{ value_key: string; value_json: string }>(
        `SELECT value_key, value_json FROM identity_sensitive_values WHERE tenant_id = ? AND owner_type = 'runtime_user' AND owner_id = ? AND lifecycle_state = 'active' AND value_key IN (${batch.map(() => '?').join(',')})`,
        [this.tenantId, this.userId, ...batch],
        primary
      );
      for (const row of rows) sensitive[row.value_key] = json(row.value_json);
    }
    if (typeof sensitive.email === 'string' && attributes.email_verified === true) {
      attributes.email = sensitive.email;
      const at = sensitive.email.lastIndexOf('@');
      if (at > 0) attributes.email_domain = sensitive.email.slice(at + 1);
    }
    if (typeof sensitive.address_country === 'string')
      attributes.country = sensitive.address_country;
    else {
      const address =
        typeof sensitive.address_json === 'string'
          ? json(sensitive.address_json)
          : sensitive.address_json;
      if (address && typeof address === 'object' && 'country' in address)
        attributes.country = address.country;
    }
    const customKeys = used.filter((key) => key.startsWith('custom.') && !plan.fields[key].pii);
    for (let start = 0; start < customKeys.length; start += 40) {
      const batch = customKeys.slice(start, start + 40).map((key) => key.slice(7));
      const rows = await this.core.query<{ field_name: string; field_value: string | null }>(
        `SELECT field_name, field_value FROM user_custom_fields WHERE tenant_id = ? AND user_id = ? AND field_name IN (${batch.map(() => '?').join(',')})`,
        [this.tenantId, this.userId, ...batch],
        primary
      );
      for (const row of rows)
        attributes[`custom.${row.field_name}`] = decode(
          row.field_value,
          plan.fields[`custom.${row.field_name}`]
        );
    }
    for (const key of used.filter((key) => key.startsWith('custom.') && plan.fields[key].pii)) {
      const raw = sensitive[`custom_attribute:${key.slice(7)}`];
      attributes[key] =
        raw === undefined || raw === null
          ? undefined
          : decode(typeof raw === 'string' ? raw : JSON.stringify(raw), plan.fields[key]);
    }
    const manual = new Set<string>();
    const roles = new Set<string>();
    const assigned = new Set<string>();
    for (let offset = 0; offset < plan.groups.length; offset += 40) {
      const page = plan.groups.slice(offset, offset + 40);
      const placeholders = page.map(() => '?').join(',');
      for (const row of await this.metadata.query<{ group_id: string }>(
        `SELECT group_id FROM service_group_manual WHERE tenant_id = ? AND user_id = ? AND group_id IN (${placeholders})`,
        [this.tenantId, this.userId, ...page.map((g) => g.id)],
        primary
      ))
        manual.add(row.group_id);
      const ids = [...new Set(page.flatMap((g) => (g.scimRoleId ? [g.scimRoleId] : [])))];
      if (!ids.length) continue;
      const slots = ids.map(() => '?').join(',');
      for (const row of await this.metadata.query<{ id: string }>(
        `SELECT id FROM roles WHERE tenant_id = ? AND id IN (${slots})`,
        [this.tenantId, ...ids],
        primary
      ))
        roles.add(row.id);
      for (const row of await this.metadata.query<{ role_id: string }>(
        `SELECT role_id FROM user_roles WHERE tenant_id = ? AND user_id = ? AND role_id IN (${slots})`,
        [this.tenantId, this.userId, ...ids],
        primary
      ))
        assigned.add(row.role_id);
    }
    const sources: EvaluationInput['sources'] = {};
    for (const group of plan.groups) {
      const scim = !group.scimRoleId
        ? false
        : !roles.has(group.scimRoleId)
          ? 'unknown'
          : assigned.has(group.scimRoleId);
      sources[group.id] = { manual: manual.has(group.id), scim };
    }
    return { attributes, sources };
  }
}
