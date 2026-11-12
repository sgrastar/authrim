import { Context } from 'hono';
import type {
  ClientTrustPolicyTargetType,
  Env,
  SignInConfirmationMode,
} from '@authrim/ar-lib-core';
import { createAuthContextFromHono, getLogger, getTenantIdFromContext } from '@authrim/ar-lib-core';

type Row = Record<string, unknown>;

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

async function oidcClientExists(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  clientId: string
): Promise<boolean> {
  const authCtx = createAuthContextFromHono(c, tenantId);
  const rows = await authCtx.coreAdapter.query(
    'SELECT client_id FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
    [tenantId, clientId]
  );
  return rows.length > 0;
}

async function hasEnabledAppLogin(env: Env, tenantId: string, clientId: string): Promise<boolean> {
  if (!env.SETTINGS) return false;
  const raw = await env.SETTINGS.get(`settings:client:${tenantId}:${clientId}:client`);
  if (!raw) return false;
  const parsed = JSON.parse(raw) as unknown;
  return (
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>)['client.app_login_enabled'] === true
  );
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
    if (targetType === 'oidc_client' && !(await oidcClientExists(c, tenantId, targetId))) {
      return notFound(c, 'OIDC client was not found');
    }
    if (
      targetType === 'oidc_client' &&
      (!readBool(body.first_party) || !readBool(body.is_active, true)) &&
      (await hasEnabledAppLogin(c.env, tenantId, targetId))
    ) {
      return invalid(
        c,
        'An active first-party Client Trust Policy is required while App Login is enabled'
      );
    }
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
