import { Context } from 'hono';
import type {
  Env,
  FormProfileField,
  FormProfileKind,
  FormProfileLocalization,
  FormProfileResponse,
  FormProfileSettings,
} from '@authrim/ar-lib-core';
import { createAuthContextFromHono, getLogger, getTenantIdFromContext } from '@authrim/ar-lib-core';

type AdminContext = Context<{ Bindings: Env }>;
type Row = Record<string, unknown>;

const FORM_KINDS = new Set<FormProfileKind>([
  'registration',
  'profile_completion',
  'login',
  'consent',
  'custom',
]);
const FORM_BLOCK_TYPES = new Set([
  'identity_field',
  'auth_widget',
  'consent_widget',
  'heading',
  'text',
  'security_verification',
  'divider',
  'layout_row',
]);
const FORM_VALUE_TYPES = new Set(['text', 'boolean']);

const DEFAULT_FORM_PROFILES: Array<{
  profile_key: string;
  display_name: string;
  description: string;
  form_kind: FormProfileKind;
  fields: FormProfileField[];
  settings: FormProfileSettings;
}> = [
  {
    profile_key: 'registration',
    display_name: 'Registration',
    description: 'Default registration form.',
    form_kind: 'registration',
    settings: { canvas_layout: 'narrow' },
    fields: [
      {
        field: 'auth.passkey',
        label: 'Create Account with Passkey',
        required: false,
        block_type: 'auth_widget',
        auth_method: 'passkey',
        order: 10,
      },
      {
        field: 'email',
        label: 'Email',
        required: true,
        block_type: 'identity_field',
        order: 20,
      },
      {
        field: 'name',
        label: 'Name',
        required: false,
        block_type: 'identity_field',
        order: 30,
      },
    ],
  },
  {
    profile_key: 'profile_completion',
    display_name: 'Profile completion',
    description: 'Default profile completion form.',
    form_kind: 'profile_completion',
    settings: { canvas_layout: 'narrow' },
    fields: [
      { field: 'name', label: 'Name', required: true, order: 10 },
      {
        field: 'preferred_username',
        label: 'Preferred username',
        required: false,
        order: 20,
      },
    ],
  },
  {
    profile_key: 'login',
    display_name: 'Login',
    description: 'Default login form.',
    form_kind: 'login',
    settings: { canvas_layout: 'narrow' },
    fields: [
      {
        field: 'auth.passkey',
        label: 'Sign in with Passkey',
        required: false,
        block_type: 'auth_widget',
        auth_method: 'passkey',
        order: 10,
      },
      {
        field: 'divider.or',
        label: 'or',
        required: false,
        block_type: 'divider',
        text: 'or',
        order: 20,
      },
      {
        field: 'auth.mail_otp',
        label: 'Send verification code',
        required: false,
        block_type: 'auth_widget',
        auth_method: 'mail_otp',
        order: 30,
      },
      {
        field: 'divider.other_accounts',
        label: 'Continue with another account',
        required: false,
        block_type: 'divider',
        text: 'Continue with another account',
        order: 40,
      },
      {
        field: 'auth.external_idp',
        label: 'Continue with external IdP',
        required: false,
        block_type: 'auth_widget',
        auth_method: 'external_idp',
        order: 50,
      },
      {
        field: 'auth.directory_password',
        label: 'Sign in with directory password',
        required: false,
        block_type: 'auth_widget',
        auth_method: 'directory_password',
        order: 60,
      },
    ],
  },
  {
    profile_key: 'consent',
    display_name: 'Consent',
    description: 'Default consent confirmation form.',
    form_kind: 'consent',
    settings: { canvas_layout: 'narrow' },
    fields: [
      {
        field: 'consent.policy',
        label: 'Consent confirmation',
        required: true,
        block_type: 'consent_widget',
        text: 'Review the consent items required for this step.',
        order: 10,
      },
    ],
  },
];

function invalid(c: AdminContext, error_description: string): Response {
  return c.json({ error: 'invalid_request', error_description }, 400);
}

function notFound(c: AdminContext, error_description: string): Response {
  return c.json({ error: 'not_found', error_description }, 404);
}

function nowMs(): number {
  return Date.now();
}

function readTrimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeProfileKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

function readBlockType(value: unknown): FormProfileField['block_type'] {
  return typeof value === 'string' && FORM_BLOCK_TYPES.has(value)
    ? (value as FormProfileField['block_type'])
    : 'identity_field';
}

function readValueType(value: unknown): FormProfileField['value_type'] {
  return typeof value === 'string' && FORM_VALUE_TYPES.has(value)
    ? (value as FormProfileField['value_type'])
    : undefined;
}

function readPositiveInteger(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < 1 || value > max) return undefined;
  return value;
}

function normalizeSettings(value: unknown): FormProfileSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { canvas_layout: 'narrow' };
  }
  const record = value as Row;
  return {
    canvas_layout: record.canvas_layout === 'wide' ? 'wide' : 'narrow',
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value as T;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeFields(value: unknown): FormProfileField[] | null {
  if (!Array.isArray(value)) return null;
  const fields: FormProfileField[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const record = item as Row;
    const field = readTrimmed(record.field);
    const label = readTrimmed(record.label);
    if (!field || !label) return null;
    fields.push({
      field,
      label,
      required: readBoolean(record.required, false),
      block_type: readBlockType(record.block_type),
      block_id: readTrimmed(record.block_id) ?? undefined,
      value_type: readValueType(record.value_type),
      auth_method: readTrimmed(record.auth_method),
      text: readTrimmed(record.text),
      help_text: readTrimmed(record.help_text),
      placeholder: readTrimmed(record.placeholder),
      layout_columns: readPositiveInteger(record.layout_columns, 4),
      layout_column: readPositiveInteger(record.layout_column, 4),
      order:
        typeof record.order === 'number' && Number.isInteger(record.order)
          ? record.order
          : undefined,
    });
  }
  return fields;
}

function normalizeLocalizations(value: unknown): Record<string, FormProfileLocalization> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, FormProfileLocalization>;
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value);
}

function toResponse(row: Row): FormProfileResponse {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    profile_key: String(row.profile_key),
    display_name: String(row.display_name),
    description: typeof row.description === 'string' ? row.description : null,
    form_kind: String(row.form_kind) as FormProfileKind,
    fields: parseJson<FormProfileField[]>(row.fields_json, []),
    localizations: parseJson<Record<string, FormProfileLocalization>>(row.localizations_json, {}),
    settings: normalizeSettings(parseJson<FormProfileSettings | null>(row.settings_json, null)),
    is_active: row.is_active as number | boolean,
    is_system: row.is_system as number | boolean,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

async function ensureDefaultFormProfiles(c: AdminContext, tenantId: string): Promise<void> {
  const authCtx = createAuthContextFromHono(c, tenantId);
  for (const profile of DEFAULT_FORM_PROFILES) {
    const existing = await authCtx.coreAdapter.queryOne<{ id: string }>(
      'SELECT id FROM form_profiles WHERE tenant_id = ? AND profile_key = ?',
      [tenantId, profile.profile_key]
    );
    if (existing) continue;
    await authCtx.coreAdapter.execute(
      `INSERT INTO form_profiles
       (id, tenant_id, profile_key, display_name, description, form_kind, fields_json,
        localizations_json, settings_json, is_active, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        tenantId,
        profile.profile_key,
        profile.display_name,
        profile.description,
        profile.form_kind,
        serializeJson(profile.fields),
        null,
        serializeJson(profile.settings),
        1,
        1,
        nowMs(),
        nowMs(),
      ]
    );
  }
}

export async function adminFormProfilesListHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_FORM_PROFILES');
  try {
    const tenantId = getTenantIdFromContext(c);
    await ensureDefaultFormProfiles(c, tenantId);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const rows = await authCtx.coreAdapter.query(
      `SELECT * FROM form_profiles
       WHERE tenant_id = ?
       ORDER BY is_system DESC, form_kind ASC, display_name ASC`,
      [tenantId]
    );
    return c.json({ profiles: (rows as Row[]).map(toResponse) });
  } catch (error) {
    log.error('Failed to list form profiles', { action: 'list' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to list form profiles' },
      500
    );
  }
}

export async function adminFormProfileGetHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_FORM_PROFILES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const row = await authCtx.coreAdapter.queryOne<Row>(
      'SELECT * FROM form_profiles WHERE tenant_id = ? AND id = ?',
      [tenantId, c.req.param('id')]
    );
    if (!row) return notFound(c, 'Form profile not found');
    return c.json({ profile: toResponse(row) });
  } catch (error) {
    log.error('Failed to get form profile', { action: 'get' }, error as Error);
    return c.json({ error: 'server_error', error_description: 'Failed to get form profile' }, 500);
  }
}

export async function adminFormProfileCreateHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_FORM_PROFILES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const body = await c.req.json<Row>();
    const displayName = readTrimmed(body.display_name);
    const rawKey = readTrimmed(body.profile_key) ?? displayName;
    const profileKey = rawKey ? normalizeProfileKey(rawKey) : '';
    const formKind = body.form_kind;
    const fields = normalizeFields(body.fields);
    if (!displayName) return invalid(c, 'display_name is required');
    if (!profileKey) return invalid(c, 'profile_key is required');
    if (!FORM_KINDS.has(formKind as FormProfileKind)) return invalid(c, 'Invalid form_kind');
    if (!fields || fields.length === 0) return invalid(c, 'fields must contain at least one field');

    const now = nowMs();
    const id = crypto.randomUUID();
    await authCtx.coreAdapter.execute(
      `INSERT INTO form_profiles
       (id, tenant_id, profile_key, display_name, description, form_kind, fields_json,
        localizations_json, settings_json, is_active, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        profileKey,
        displayName,
        readTrimmed(body.description),
        formKind,
        serializeJson(fields),
        serializeJson(normalizeLocalizations(body.localizations)),
        serializeJson(normalizeSettings(body.settings)),
        readBoolean(body.is_active, true) ? 1 : 0,
        0,
        now,
        now,
      ]
    );
    const row = await authCtx.coreAdapter.queryOne<Row>(
      'SELECT * FROM form_profiles WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    return c.json({ profile: row ? toResponse(row) : null }, 201);
  } catch (error) {
    log.error('Failed to create form profile', { action: 'create' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to create form profile' },
      500
    );
  }
}

export async function adminFormProfileUpdateHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_FORM_PROFILES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id');
    const authCtx = createAuthContextFromHono(c, tenantId);
    const existing = await authCtx.coreAdapter.queryOne<Row>(
      'SELECT id, is_system FROM form_profiles WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    if (!existing) return notFound(c, 'Form profile not found');
    const body = await c.req.json<Row>();
    const sets: string[] = [];
    const params: unknown[] = [];

    if (body.display_name !== undefined) {
      const displayName = readTrimmed(body.display_name);
      if (!displayName) return invalid(c, 'display_name is required');
      sets.push('display_name = ?');
      params.push(displayName);
    }
    if (body.description !== undefined) {
      sets.push('description = ?');
      params.push(readTrimmed(body.description));
    }
    if (body.form_kind !== undefined) {
      if (!FORM_KINDS.has(body.form_kind as FormProfileKind))
        return invalid(c, 'Invalid form_kind');
      sets.push('form_kind = ?');
      params.push(body.form_kind);
    }
    if (body.fields !== undefined) {
      const fields = normalizeFields(body.fields);
      if (!fields || fields.length === 0) {
        return invalid(c, 'fields must contain at least one field');
      }
      sets.push('fields_json = ?');
      params.push(serializeJson(fields));
    }
    if (body.localizations !== undefined) {
      sets.push('localizations_json = ?');
      params.push(serializeJson(normalizeLocalizations(body.localizations)));
    }
    if (body.settings !== undefined) {
      sets.push('settings_json = ?');
      params.push(serializeJson(normalizeSettings(body.settings)));
    }
    if (body.is_active !== undefined) {
      sets.push('is_active = ?');
      params.push(readBoolean(body.is_active, true) ? 1 : 0);
    }
    if (sets.length === 0) return invalid(c, 'No fields to update');
    sets.push('updated_at = ?');
    params.push(nowMs(), tenantId, id);
    await authCtx.coreAdapter.execute(
      `UPDATE form_profiles SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`,
      params
    );
    const row = await authCtx.coreAdapter.queryOne<Row>(
      'SELECT * FROM form_profiles WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    return c.json({ profile: row ? toResponse(row) : null });
  } catch (error) {
    log.error('Failed to update form profile', { action: 'update' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to update form profile' },
      500
    );
  }
}

export async function adminFormProfileDeleteHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_FORM_PROFILES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const id = c.req.param('id');
    const authCtx = createAuthContextFromHono(c, tenantId);
    const existing = await authCtx.coreAdapter.queryOne<{ is_system: number | boolean }>(
      'SELECT is_system FROM form_profiles WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    if (!existing) return notFound(c, 'Form profile not found');
    if (readBoolean(existing.is_system, false))
      return invalid(c, 'System form profiles cannot be deleted');
    await authCtx.coreAdapter.execute('DELETE FROM form_profiles WHERE tenant_id = ? AND id = ?', [
      tenantId,
      id,
    ]);
    return c.json({ success: true });
  } catch (error) {
    log.error('Failed to delete form profile', { action: 'delete' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to delete form profile' },
      500
    );
  }
}
