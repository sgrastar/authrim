import { Context } from 'hono';
import type {
  ClientTrustPolicyTargetType,
  ConsentPolicyCheckboxMode,
  ConsentPolicyItemBindingType,
  ConsentPolicyRequirement,
  ConsentPolicyVersionMode,
  Env,
  SignInConfirmationMode,
} from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  getLogger,
  getTenantIdFromContext,
  validateVersionFormat,
} from '@authrim/ar-lib-core';

type Row = Record<string, unknown>;
type ExistingTable = 'consent_policies' | 'consent_statements';

const REQUIREMENTS = new Set<ConsentPolicyRequirement>(['required', 'optional', 'hidden']);
const VERSION_MODES = new Set<ConsentPolicyVersionMode>(['current', 'fixed', 'minimum']);
const CHECKBOX_MODES = new Set<ConsentPolicyCheckboxMode>(['none', 'required', 'optional']);
const BINDING_TYPES = new Set<ConsentPolicyItemBindingType>([
  'subject',
  'scope',
  'claim',
  'saml_attribute',
  'destination_field_set',
]);
const TRUST_TARGET_TYPES = new Set<ClientTrustPolicyTargetType>(['oidc_client', 'saml_sp']);
const SIGN_IN_MODES = new Set<SignInConfirmationMode>(['disabled', 'first_time', 'every_time']);

function invalid(c: Context, error_description: string): Response {
  return c.json({ error: 'invalid_request', error_description }, 400);
}

function notFound(c: Context, error_description: string): Response {
  return c.json({ error: 'not_found', error_description }, 404);
}

function readTrimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return fallback;
  return value;
}

function readIntegerInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    return fallback;
  }
  return value;
}

function normalizeTargetId(targetType: string, targetId: unknown): string {
  return readTrimmed(targetId) ?? '';
}

async function rowExists(
  c: Context<{ Bindings: Env }>,
  table: ExistingTable,
  tenantId: string,
  id: string
): Promise<boolean> {
  const authCtx = createAuthContextFromHono(c, tenantId);
  const sql =
    table === 'consent_policies'
      ? `SELECT id FROM consent_policies WHERE id = ? AND tenant_id = ?`
      : `SELECT id FROM consent_statements WHERE id = ? AND tenant_id = ?`;
  const rows = await authCtx.coreAdapter.query(sql, [id, tenantId]);
  return rows.length > 0;
}

async function fetchPolicyItems(c: Context<{ Bindings: Env }>, tenantId: string, policyId: string) {
  const authCtx = createAuthContextFromHono(c, tenantId);
  return authCtx.coreAdapter.query(
    `SELECT i.*, s.slug AS statement_slug, s.category AS statement_category
       FROM consent_policy_items i
       JOIN consent_statements s ON s.id = i.statement_id AND s.tenant_id = i.tenant_id
      WHERE i.tenant_id = ? AND i.policy_id = ?
      ORDER BY i.display_order ASC, i.created_at ASC`,
    [tenantId, policyId]
  );
}

export async function adminConsentPoliciesListHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT_POLICIES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const rows = await authCtx.coreAdapter.query(
      `SELECT p.*,
              COUNT(i.id) AS item_count
         FROM consent_policies p
         LEFT JOIN consent_policy_items i ON i.policy_id = p.id AND i.tenant_id = p.tenant_id
        WHERE p.tenant_id = ?
        GROUP BY p.id
        ORDER BY p.updated_at DESC`,
      [tenantId]
    );
    return c.json({ policies: rows });
  } catch (error) {
    log.error('Failed to list consent policies', { action: 'list' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to list consent policies' },
      500
    );
  }
}

export async function adminConsentPolicyGetHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT_POLICIES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const id = c.req.param('id')!;
    const rows = await authCtx.coreAdapter.query(
      `SELECT * FROM consent_policies WHERE id = ? AND tenant_id = ?`,
      [id, tenantId]
    );
    if (rows.length === 0) return notFound(c, 'Consent policy not found');

    const items = await fetchPolicyItems(c, tenantId, id);
    return c.json({ policy: rows[0], items });
  } catch (error) {
    log.error('Failed to get consent policy', { action: 'get' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to get consent policy' },
      500
    );
  }
}

export async function adminConsentPolicyCreateHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT_POLICIES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const body = await c.req.json<Row>();
    const displayName = readTrimmed(body.display_name);
    if (!displayName) return invalid(c, 'display_name is required');

    const id = crypto.randomUUID();
    const name = `policy-${id}`;
    const now = Date.now();
    await authCtx.coreAdapter.execute(
      `INSERT INTO consent_policies
       (id, tenant_id, name, display_name, description, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        name,
        displayName,
        readOptionalString(body.description),
        readBool(body.is_active, true) ? 1 : 0,
        now,
        now,
      ]
    );

    const rows = await authCtx.coreAdapter.query(
      `SELECT * FROM consent_policies WHERE id = ? AND tenant_id = ?`,
      [id, tenantId]
    );
    return c.json({ policy: rows[0] }, 201);
  } catch (error) {
    log.error('Failed to create consent policy', { action: 'create' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to create consent policy' },
      500
    );
  }
}

export async function adminConsentPolicyUpdateHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT_POLICIES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const id = c.req.param('id')!;
    const body = await c.req.json<Row>();
    const existing = await authCtx.coreAdapter.query(
      `SELECT id FROM consent_policies WHERE id = ? AND tenant_id = ?`,
      [id, tenantId]
    );
    if (existing.length === 0) return notFound(c, 'Consent policy not found');

    const sets: string[] = [];
    const params: unknown[] = [];
    const displayName = readTrimmed(body.display_name);
    if (displayName !== undefined) {
      sets.push('display_name = ?');
      params.push(displayName);
    }
    if (body.description !== undefined) {
      sets.push('description = ?');
      params.push(readOptionalString(body.description));
    }
    if (body.is_active !== undefined) {
      sets.push('is_active = ?');
      params.push(readBool(body.is_active) ? 1 : 0);
    }
    if (sets.length === 0) return invalid(c, 'No fields to update');
    sets.push('updated_at = ?');
    params.push(Date.now(), id, tenantId);
    await authCtx.coreAdapter.execute(
      `UPDATE consent_policies SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`,
      params
    );
    return adminConsentPolicyGetHandler(c);
  } catch (error) {
    log.error('Failed to update consent policy', { action: 'update' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to update consent policy' },
      500
    );
  }
}

export async function adminConsentPolicyDeleteHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT_POLICIES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const id = c.req.param('id')!;
    await authCtx.coreAdapter.execute(
      `DELETE FROM consent_policies WHERE id = ? AND tenant_id = ?`,
      [id, tenantId]
    );
    return c.json({ success: true });
  } catch (error) {
    log.error('Failed to delete consent policy', { action: 'delete' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to delete consent policy' },
      500
    );
  }
}

export async function adminConsentPolicyItemsReplaceHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT_POLICIES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const policyId = c.req.param('id')!;
    if (!(await rowExists(c, 'consent_policies', tenantId, policyId))) {
      return notFound(c, 'Consent policy not found');
    }

    const body = await c.req.json<{ items?: Row[] }>();
    const items = Array.isArray(body.items) ? body.items : [];
    const now = Date.now();
    const normalizedItems: Array<{
      statementId: string;
      requirement: string;
      versionMode: string;
      versionId: string | null;
      minVersion: string | null;
      checkboxMode: string;
      checkboxDefaultChecked: number;
      bindingType: string | null;
      bindingValue: string | null;
      evidenceProfile: string | null;
      languageFallback: string | null;
      displayOrder: number;
    }> = [];
    const seenStatementIds = new Set<string>();

    for (const [index, item] of items.entries()) {
      const statementId = readTrimmed(item.statement_id);
      if (!statementId) return invalid(c, 'items[].statement_id is required');
      if (seenStatementIds.has(statementId)) {
        return invalid(c, `Duplicate consent statement: ${statementId}`);
      }
      seenStatementIds.add(statementId);
      if (!(await rowExists(c, 'consent_statements', tenantId, statementId))) {
        return invalid(c, `Unknown consent statement: ${statementId}`);
      }

      const requirement = readTrimmed(item.requirement) ?? 'required';
      const versionMode = readTrimmed(item.version_mode) ?? 'current';
      const checkboxMode = readTrimmed(item.checkbox_mode) ?? 'required';
      if (!REQUIREMENTS.has(requirement as ConsentPolicyRequirement)) {
        return invalid(c, 'items[].requirement must be required, optional, or hidden');
      }
      if (!VERSION_MODES.has(versionMode as ConsentPolicyVersionMode)) {
        return invalid(c, 'items[].version_mode must be current, fixed, or minimum');
      }
      if (!CHECKBOX_MODES.has(checkboxMode as ConsentPolicyCheckboxMode)) {
        return invalid(c, 'items[].checkbox_mode must be none, required, or optional');
      }

      const minVersion = readOptionalString(item.min_version);
      if (minVersion && !validateVersionFormat(minVersion)) {
        return invalid(c, 'items[].min_version must be YYYYMMDD format');
      }
      if (versionMode === 'minimum' && !minVersion) {
        return invalid(c, 'items[].min_version is required when version_mode is minimum');
      }

      const versionId = readOptionalString(item.version_id);
      if (versionMode === 'fixed') {
        if (!versionId) {
          return invalid(c, 'items[].version_id is required when version_mode is fixed');
        }
        const versionRows = await authCtx.coreAdapter.query(
          `SELECT id FROM consent_statement_versions
            WHERE id = ? AND tenant_id = ? AND statement_id = ?`,
          [versionId, tenantId, statementId]
        );
        if (versionRows.length === 0) {
          return invalid(
            c,
            'items[].version_id must reference a version of the selected statement'
          );
        }
      }
      const bindingType = readOptionalString(item.binding_type);
      if (bindingType && !BINDING_TYPES.has(bindingType as ConsentPolicyItemBindingType)) {
        return invalid(
          c,
          'items[].binding_type must be subject, scope, claim, saml_attribute, or destination_field_set'
        );
      }

      normalizedItems.push({
        statementId,
        requirement,
        versionMode,
        versionId: versionMode === 'fixed' ? versionId : null,
        minVersion: versionMode === 'minimum' ? minVersion : null,
        checkboxMode,
        checkboxDefaultChecked: readBool(item.checkbox_default_checked) ? 1 : 0,
        bindingType,
        bindingValue: readOptionalString(item.binding_value),
        evidenceProfile: readOptionalString(item.evidence_profile),
        languageFallback: readOptionalString(item.language_fallback),
        displayOrder: readNonNegativeInteger(item.display_order, index),
      });
    }

    await authCtx.coreAdapter.execute(
      `DELETE FROM consent_policy_items WHERE tenant_id = ? AND policy_id = ?`,
      [tenantId, policyId]
    );

    for (const item of normalizedItems) {
      await authCtx.coreAdapter.execute(
        `INSERT INTO consent_policy_items
         (id, tenant_id, policy_id, statement_id, requirement, version_mode, version_id,
          min_version, checkbox_mode, checkbox_default_checked, binding_type, binding_value,
          evidence_profile, language_fallback, display_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          tenantId,
          policyId,
          item.statementId,
          item.requirement,
          item.versionMode,
          item.versionId,
          item.minVersion,
          item.checkboxMode,
          item.checkboxDefaultChecked,
          item.bindingType,
          item.bindingValue,
          item.evidenceProfile,
          item.languageFallback,
          item.displayOrder,
          now,
          now,
        ]
      );
    }

    await authCtx.coreAdapter.execute(
      `UPDATE consent_policies SET updated_at = ? WHERE tenant_id = ? AND id = ?`,
      [now, tenantId, policyId]
    );

    return c.json({ items: await fetchPolicyItems(c, tenantId, policyId) });
  } catch (error) {
    log.error(
      'Failed to replace consent policy items',
      { action: 'replace_items' },
      error as Error
    );
    return c.json(
      { error: 'server_error', error_description: 'Failed to replace consent policy items' },
      500
    );
  }
}

export async function adminClientTrustPoliciesListHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT_POLICIES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const rows = await authCtx.coreAdapter.query(
      `SELECT * FROM client_trust_policies WHERE tenant_id = ? ORDER BY target_type ASC, updated_at DESC`,
      [tenantId]
    );
    return c.json({ policies: rows });
  } catch (error) {
    log.error('Failed to list client trust policies', { action: 'list_trust' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to list client trust policies' },
      500
    );
  }
}

export async function adminClientTrustPolicyUpsertHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT_POLICIES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const body = await c.req.json<Row>();
    const targetType = readTrimmed(body.target_type);
    if (!targetType || !TRUST_TARGET_TYPES.has(targetType as ClientTrustPolicyTargetType)) {
      return invalid(c, 'target_type is invalid');
    }
    const targetId = normalizeTargetId(targetType, body.target_id);
    if (!targetId) return invalid(c, 'target_id is required');
    const name = `${targetType}-${targetId}-trust`;
    const displayName = readTrimmed(body.display_name) ?? name;
    const now = Date.now();
    const existing = await authCtx.coreAdapter.query(
      `SELECT id FROM client_trust_policies
        WHERE tenant_id = ? AND target_type = ? AND target_id = ?`,
      [tenantId, targetType, targetId]
    );
    const values = [
      name,
      displayName,
      readOptionalString(body.description),
      readBool(body.first_party) ? 1 : 0,
      readBool(body.trusted) ? 1 : 0,
      readBool(body.skip_authorization_consent) ? 1 : 0,
      readBool(body.is_active, true) ? 1 : 0,
      now,
      tenantId,
      targetType,
      targetId,
    ];
    if (existing.length > 0) {
      await authCtx.coreAdapter.execute(
        `UPDATE client_trust_policies
            SET name = ?, display_name = ?, description = ?, first_party = ?, trusted = ?,
                skip_authorization_consent = ?, is_active = ?, updated_at = ?
          WHERE tenant_id = ? AND target_type = ? AND target_id = ?`,
        values
      );
    } else {
      await authCtx.coreAdapter.execute(
        `INSERT INTO client_trust_policies
         (id, tenant_id, name, display_name, description, target_type, target_id,
          first_party, trusted, skip_authorization_consent, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          tenantId,
          name,
          displayName,
          readOptionalString(body.description),
          targetType,
          targetId,
          readBool(body.first_party) ? 1 : 0,
          readBool(body.trusted) ? 1 : 0,
          readBool(body.skip_authorization_consent) ? 1 : 0,
          readBool(body.is_active, true) ? 1 : 0,
          now,
          now,
        ]
      );
    }
    return adminClientTrustPoliciesListHandler(c);
  } catch (error) {
    log.error('Failed to upsert client trust policy', { action: 'upsert_trust' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to upsert client trust policy' },
      500
    );
  }
}

export async function adminSignInConfirmationPoliciesListHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT_POLICIES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const rows = await authCtx.coreAdapter.query(
      `SELECT * FROM sign_in_confirmation_policies WHERE tenant_id = ? ORDER BY trigger_type ASC`,
      [tenantId]
    );
    return c.json({ policies: rows });
  } catch (error) {
    log.error(
      'Failed to list sign-in confirmation policies',
      { action: 'list_signin' },
      error as Error
    );
    return c.json(
      { error: 'server_error', error_description: 'Failed to list sign-in confirmation policies' },
      500
    );
  }
}

export async function adminSignInConfirmationPolicyUpsertHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('ADMIN_CONSENT_POLICIES');
  try {
    const tenantId = getTenantIdFromContext(c);
    const authCtx = createAuthContextFromHono(c, tenantId);
    const body = await c.req.json<Row>();
    const mode = readTrimmed(body.mode) ?? 'disabled';
    if (!SIGN_IN_MODES.has(mode as SignInConfirmationMode)) {
      return invalid(c, 'mode must be disabled, first_time, or every_time');
    }
    const triggerType = 'login';
    const name = 'login-sign-in-confirmation';
    const displayName = readTrimmed(body.display_name) ?? 'Login sign-in confirmation';
    const now = Date.now();
    const existing = await authCtx.coreAdapter.query(
      `SELECT id FROM sign_in_confirmation_policies WHERE tenant_id = ? AND trigger_type = ?`,
      [tenantId, triggerType]
    );
    const values = [
      name,
      displayName,
      readOptionalString(body.description),
      mode,
      readIntegerInRange(body.remember_duration_days, 365, 0, 3650),
      readBool(body.show_application_context, true) ? 1 : 0,
      readBool(body.show_tenant_context, true) ? 1 : 0,
      readBool(body.is_active, true) ? 1 : 0,
      now,
      tenantId,
      triggerType,
    ];
    if (existing.length > 0) {
      await authCtx.coreAdapter.execute(
        `UPDATE sign_in_confirmation_policies
            SET name = ?, display_name = ?, description = ?, mode = ?, remember_duration_days = ?,
                show_application_context = ?, show_tenant_context = ?, is_active = ?, updated_at = ?
          WHERE tenant_id = ? AND trigger_type = ?`,
        values
      );
    } else {
      await authCtx.coreAdapter.execute(
        `INSERT INTO sign_in_confirmation_policies
         (id, tenant_id, name, display_name, description, trigger_type, mode,
          remember_duration_days, show_application_context, show_tenant_context,
          is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          tenantId,
          name,
          displayName,
          readOptionalString(body.description),
          triggerType,
          mode,
          readIntegerInRange(body.remember_duration_days, 365, 0, 3650),
          readBool(body.show_application_context, true) ? 1 : 0,
          readBool(body.show_tenant_context, true) ? 1 : 0,
          readBool(body.is_active, true) ? 1 : 0,
          now,
          now,
        ]
      );
    }
    return adminSignInConfirmationPoliciesListHandler(c);
  } catch (error) {
    log.error(
      'Failed to upsert sign-in confirmation policy',
      { action: 'upsert_signin' },
      error as Error
    );
    return c.json(
      { error: 'server_error', error_description: 'Failed to upsert sign-in confirmation policy' },
      500
    );
  }
}
