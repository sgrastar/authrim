import type { Context } from 'hono';
import { consumeAuthorizationChallengeContinuation } from './direct-auth';
import {
  FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
  FLOW_RUNTIME_INTERACTION_TTL_SECONDS,
  createAuthContextFromHono,
  evaluateFlowConditionRows,
  generateId,
  getFeatureFlag,
  getLogger,
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  hashIpAddress,
  isShardedSessionId,
  processConsentItemDecisions,
  type DatabaseAdapter,
  type Env,
  type FlowAssignmentTargetType,
  type FlowConditionConfig,
  type FlowConditionEvaluationContext,
  type FlowKind,
  type FlowEditorState,
  type FlowRuntimeContract,
  type FlowRuntimeJsonObject,
  type FlowRuntimeErrorAction,
  type FlowRuntimeErrorCategory,
  type FlowRuntimeStep,
  type Session,
} from '@authrim/ar-lib-core';

type AuthContext = Context<{ Bindings: Env }>;
type FlowRuntimeEnv = Env & {
  FLOW_RUNTIME_HMAC_SECRET?: string;
};

interface StartRequest {
  flow_kind?: string;
  target_type?: string;
  target_id?: string | null;
  client_id?: string;
  saml_sp_id?: string;
  scope?: string | string[];
  requested_scope?: string | string[];
  locale?: string;
  requested_locale?: string;
  authorization_challenge_id?: string;
  saml_request_id?: string;
  saml_sp_entity_id?: string;
  return_to?: string;
  resume_interaction_id?: string;
  contract_hash?: string;
  signature?: string;
}

interface SubmitRequest {
  step_id?: string;
  node_id?: string;
  selected_handle?: string;
  contract_hash?: string;
  signature?: string;
  input?: unknown;
}

interface FlowAssignmentRow {
  flow_id: string;
  target_type: FlowAssignmentTargetType;
  target_id: string | null;
  flow_kind: FlowKind;
  published_version_id: string | null;
}

interface FlowVersionRow {
  id: string;
  flow_id: string;
  schema_version: string;
  runtime_snapshot_json: string;
  editor_snapshot_json: string | null;
  published_at: number;
}

interface FlowInteractionRow {
  id: string;
  flow_id: string;
  flow_version_id: string;
  user_id: string | null;
  client_id: string | null;
  saml_sp_id: string | null;
  state: string;
  current_node_id: string | null;
  current_step_id: string | null;
  context_json: string | null;
  contract_hash: string;
  signature: string;
  expires_at: number;
}

interface FlowInteractionStepRow {
  id: string;
  interaction_id: string;
  node_id: string;
  step_id: string;
  state: string;
  selected_handle: string | null;
  state_json: string | null;
}

interface ResolvedTarget {
  targetType: FlowAssignmentTargetType;
  targetId: string | null;
  clientId: string | null;
  samlSpId: string | null;
}

interface FlowRequestContext {
  protocol: 'oidc' | 'saml' | 'direct';
  target_type: FlowAssignmentTargetType;
  target_id: string | null;
  client_id: string | null;
  saml_sp_id: string | null;
  authorization_challenge_id: string | null;
  saml_request_id: string | null;
  saml_sp_entity_id: string | null;
  return_to: string | null;
  requested_scope: string[];
  locale: string | null;
}

interface CachedFlowVersion {
  row: FlowVersionRow;
  expiresAt: number;
}

interface RuntimeConsentPolicyItem extends FlowRuntimeJsonObject {
  statement_id: string;
  slug: string;
  category: string;
  title: string;
  description: string;
  document_url: string | null;
  inline_content: string | null;
  version: string;
  version_id: string;
  is_required: boolean;
  checkbox_mode: 'none' | 'required' | 'optional';
  checkbox_default_checked: boolean;
  binding_type: string | null;
  binding_value: string | null;
  evidence_profile: string | null;
  language_fallback: string | null;
  display_order: number;
}

interface RuntimeConsentPolicyContent extends FlowRuntimeJsonObject {
  id: string;
  display_name: string;
  description: string | null;
  language: string;
  default_language: string;
  items: RuntimeConsentPolicyItem[];
}

const LOGIN_RUNTIME_FEATURE_KEYS = [
  'feature.enable_login_runtime_flow',
  'feature.login_runtime_flow.enabled',
  'feature.flow_runtime.enabled',
];

const STANDARD_FLOW_KINDS = new Set<FlowKind>(['login', 'registration', 'approve', 'account']);
const FLOW_VERSION_CACHE_TTL_SECONDS = 180;
const FLOW_VERSION_CACHE_MAX_ENTRIES = 256;
const flowVersionCache = new Map<string, CachedFlowVersion>();

export function clearLoginRuntimeFlowVersionCacheForTests(): void {
  flowVersionCache.clear();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function readString(value: unknown, maxLength = 256): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function readOptionalString(value: unknown, maxLength = 256): string | null {
  if (value === undefined || value === null) return null;
  return readString(value, maxLength);
}

function parseStringList(value: unknown, maxItems = 100, maxItemLength = 128): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\s+/)
      : [];
  const values: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawValues) {
    if (typeof raw !== 'string') continue;
    const item = raw.trim();
    if (!item || item.length > maxItemLength || seen.has(item)) continue;
    seen.add(item);
    values.push(item);
    if (values.length >= maxItems) break;
  }

  return values;
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function jsonError(
  c: AuthContext,
  status: 400 | 403 | 404 | 409 | 500,
  error: string,
  errorDescription: string,
  errorCode = 'AR_FLOW_RUNTIME_ERROR'
) {
  return c.json(
    {
      error,
      error_description: errorDescription,
      error_code: errorCode,
    },
    status
  );
}

function runtimeError(
  c: AuthContext,
  status: 400 | 401 | 403 | 404 | 409 | 500,
  error: string,
  errorDescription: string,
  errorCode: string,
  category: FlowRuntimeErrorCategory,
  action: FlowRuntimeErrorAction,
  interactionId?: string
) {
  return c.json(
    {
      error,
      error_description: errorDescription,
      error_code: errorCode,
      category,
      action,
      interaction_id: interactionId,
    },
    status
  );
}

async function isLoginRuntimeFlowEnabled(env: Env, tenantId: string): Promise<boolean> {
  if (env.AUTHRIM_CONFIG) {
    try {
      const settingsJson = await env.AUTHRIM_CONFIG.get(
        `settings:tenant:${tenantId}:feature-flags`
      );
      const settings = settingsJson ? (JSON.parse(settingsJson) as Record<string, unknown>) : null;
      if (settings && typeof settings === 'object') {
        for (const key of LOGIN_RUNTIME_FEATURE_KEYS) {
          if (settings[key] === true || settings[key] === 'true' || settings[key] === '1') {
            return true;
          }
        }
      }
    } catch {
      // Fall through to environment flags.
    }
  }
  return getFeatureFlag('ENABLE_LOGIN_RUNTIME_FLOW', env, false);
}

function normalizeFlowKind(value: unknown): FlowKind {
  if (typeof value === 'string' && STANDARD_FLOW_KINDS.has(value as FlowKind)) {
    return value as FlowKind;
  }
  if (typeof value === 'string' && value.startsWith('custom:')) {
    return value as FlowKind;
  }
  return 'login';
}

function resolveTarget(body: StartRequest): ResolvedTarget | null {
  const clientId = readString(body.client_id, 200);
  const samlSpId = readString(body.saml_sp_id, 200);
  const explicitTargetType = body.target_type;
  const explicitTargetId = readString(body.target_id, 200);

  if (explicitTargetType) {
    if (explicitTargetType === 'tenant') {
      return { targetType: 'tenant', targetId: null, clientId, samlSpId };
    }
    if (explicitTargetType === 'oidc_client' && explicitTargetId) {
      return {
        targetType: 'oidc_client',
        targetId: explicitTargetId,
        clientId: clientId ?? explicitTargetId,
        samlSpId,
      };
    }
    if (explicitTargetType === 'saml_sp' && explicitTargetId) {
      return {
        targetType: 'saml_sp',
        targetId: explicitTargetId,
        clientId,
        samlSpId: samlSpId ?? explicitTargetId,
      };
    }
    return null;
  }

  if (clientId) {
    return { targetType: 'oidc_client', targetId: clientId, clientId, samlSpId };
  }
  if (samlSpId) {
    return { targetType: 'saml_sp', targetId: samlSpId, clientId, samlSpId };
  }
  return { targetType: 'tenant', targetId: null, clientId, samlSpId };
}

async function resolveAssignment(
  db: DatabaseAdapter,
  tenantId: string,
  flowKind: FlowKind,
  target: ResolvedTarget
): Promise<FlowAssignmentRow | null> {
  if (target.targetType !== 'tenant' && target.targetId) {
    const specific = await db.queryOne<FlowAssignmentRow>(
      `SELECT a.flow_id, a.target_type, a.target_id, a.flow_kind, f.published_version_id
       FROM flow_assignments a
       JOIN flows f ON f.id = a.flow_id AND f.tenant_id = a.tenant_id
       WHERE a.tenant_id = ?
         AND a.target_type = ?
         AND a.target_id = ?
         AND a.flow_kind = ?
         AND a.enabled = 1
         AND f.status = 'published'
         AND f.deleted_at IS NULL`,
      [tenantId, target.targetType, target.targetId, flowKind]
    );
    if (specific) return specific;
  }

  return db.queryOne<FlowAssignmentRow>(
    `SELECT a.flow_id, a.target_type, a.target_id, a.flow_kind, f.published_version_id
     FROM flow_assignments a
     JOIN flows f ON f.id = a.flow_id AND f.tenant_id = a.tenant_id
     WHERE a.tenant_id = ?
       AND a.target_type = 'tenant'
       AND a.target_id IS NULL
       AND a.flow_kind = ?
       AND a.enabled = 1
       AND f.status = 'published'
       AND f.deleted_at IS NULL`,
    [tenantId, flowKind]
  );
}

async function getPublishedVersion(
  db: DatabaseAdapter,
  tenantId: string,
  assignment: FlowAssignmentRow
): Promise<FlowVersionRow | null> {
  if (!assignment.published_version_id) return null;
  return getFlowVersion(db, tenantId, assignment.flow_id, assignment.published_version_id);
}

async function getFlowVersion(
  db: DatabaseAdapter,
  tenantId: string,
  flowId: string,
  versionId: string
): Promise<FlowVersionRow | null> {
  const cacheKey = `${tenantId}:${flowId}:${versionId}`;
  const now = nowSeconds();
  const cached = flowVersionCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.row;
  }

  const row = await db.queryOne<FlowVersionRow>(
    `SELECT id, flow_id, schema_version, runtime_snapshot_json, editor_snapshot_json, published_at
     FROM flow_versions
     WHERE tenant_id = ? AND flow_id = ? AND id = ?`,
    [tenantId, flowId, versionId]
  );
  if (row) {
    flowVersionCache.set(cacheKey, { row, expiresAt: now + FLOW_VERSION_CACHE_TTL_SECONDS });
    if (flowVersionCache.size > FLOW_VERSION_CACHE_MAX_ENTRIES) {
      const firstKey = flowVersionCache.keys().next().value;
      if (firstKey) flowVersionCache.delete(firstKey);
    }
  }
  return row;
}

function parseRuntimeSnapshot(value: string): FlowRuntimeContract | null {
  try {
    const parsed = JSON.parse(value) as FlowRuntimeContract;
    if (!parsed || typeof parsed !== 'object' || !parsed.ui || !Array.isArray(parsed.ui.steps)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseEditorSnapshot(value: string | null): FlowEditorState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as FlowEditorState;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeRuntime(
  runtime: FlowRuntimeContract,
  assignment: FlowAssignmentRow,
  version: FlowVersionRow,
  requestContext?: FlowRequestContext
): FlowRuntimeContract {
  return {
    ...runtime,
    flow_kind: assignment.flow_kind,
    flow_id: assignment.flow_id,
    flow_version_id: version.id,
    protocol_context: requestContext
      ? {
          protocol: requestContext.protocol,
          request: {
            target_type: requestContext.target_type,
            target_id: requestContext.target_id,
            requested_scope: requestContext.requested_scope,
            locale: requestContext.locale,
            authorization_challenge_id: requestContext.authorization_challenge_id,
            saml_request_id: requestContext.saml_request_id,
            saml_sp_entity_id: requestContext.saml_sp_entity_id,
            return_to: requestContext.return_to,
          },
          oidc:
            requestContext.client_id ||
            requestContext.authorization_challenge_id ||
            requestContext.requested_scope.length > 0
              ? ({
                  client_id: requestContext.client_id,
                  authorization_challenge_id: requestContext.authorization_challenge_id,
                  requested_scope: requestContext.requested_scope,
                } as FlowRuntimeJsonObject)
              : null,
          saml: requestContext.saml_sp_id
            ? ({
                saml_sp_id: requestContext.saml_sp_id,
                saml_request_id: requestContext.saml_request_id,
                saml_sp_entity_id: requestContext.saml_sp_entity_id,
              } as FlowRuntimeJsonObject)
            : null,
        }
      : runtime.protocol_context,
  };
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readBooleanSetting(
  settings: Record<string, unknown>,
  key: string,
  fallback: boolean
): boolean {
  const value = settings[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function normalizeOutputHandle(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'method';
}

function parseAuthProviderUsage(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    );
  }
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === 'object' && !Array.isArray(item)
        )
      : [];
  } catch {
    return [];
  }
}

async function resolveRuntimeAuthenticationHandles(
  env: Env,
  tenantId: string,
  flowKind: FlowKind,
  component: string
): Promise<string[]> {
  const rawSettings = await env.SETTINGS?.get(`settings:tenant:${tenantId}:authentication-methods`);
  const settings = parseJsonRecord(rawSettings);
  const usage =
    component === 'registration_method_selector' || flowKind === 'registration'
      ? 'signup'
      : 'login';
  const handles: string[] = [];
  const legacyPasskeyEnabled = readBooleanSetting(
    settings,
    'authentication-methods.passkey.enabled',
    true
  );
  const legacyEmailOtpEnabled = readBooleanSetting(
    settings,
    'authentication-methods.email_otp.enabled',
    true
  );

  if (
    readBooleanSetting(
      settings,
      `authentication-methods.email_otp.${usage}_enabled`,
      legacyEmailOtpEnabled
    )
  ) {
    handles.push('mail_otp');
  }
  if (
    readBooleanSetting(
      settings,
      `authentication-methods.passkey.${usage}_enabled`,
      legacyPasskeyEnabled
    )
  ) {
    handles.push('passkey');
  }
  if (
    usage === 'login' &&
    readBooleanSetting(settings, 'authentication-methods.directory_password.enabled', false)
  ) {
    handles.push('directory_password');
  }

  const providerUsage = parseAuthProviderUsage(
    settings['authentication-methods.external_provider_usage']
  );
  for (const provider of providerUsage) {
    const providerId = readString(provider.id, 200);
    if (!providerId) continue;
    const providerEnabled = readBooleanSetting(provider, 'enabled', true);
    const usageEnabled = readBooleanSetting(provider, `${usage}Enabled`, providerEnabled);
    if (providerEnabled && usageEnabled) handles.push(normalizeOutputHandle(providerId));
  }

  return [...new Set(handles)];
}

function requestedLanguage(requestContext: FlowRequestContext): string {
  return requestContext.locale || 'en';
}

function consentBindingMatchesRequestContext(
  bindingType: string | null,
  bindingValue: string | null,
  requestContext: FlowRequestContext
): boolean {
  if (!bindingType || !bindingValue) return true;
  const values = bindingValue
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0) return true;
  const valueSet = new Set(values);
  if (bindingType === 'scope') {
    return requestContext.requested_scope.some((scope) => valueSet.has(scope));
  }
  if (bindingType === 'subject') return true;
  if (bindingType === 'destination_field_set') return true;
  return true;
}

async function getConsentVersionForPolicyItem(
  db: DatabaseAdapter,
  tenantId: string,
  statementId: string,
  versionMode: string,
  versionId: string | null
): Promise<{ id: string; version: string } | null> {
  if (versionMode === 'fixed' && versionId) {
    return db.queryOne<{ id: string; version: string }>(
      `SELECT id, version
         FROM consent_statement_versions
        WHERE tenant_id = ? AND statement_id = ? AND id = ? AND status = 'active'`,
      [tenantId, statementId, versionId]
    );
  }
  return db.queryOne<{ id: string; version: string }>(
    `SELECT id, version
       FROM consent_statement_versions
      WHERE tenant_id = ? AND statement_id = ? AND is_current = 1 AND status = 'active'
      LIMIT 1`,
    [tenantId, statementId]
  );
}

async function getConsentLocalizationForRuntime(
  db: DatabaseAdapter,
  tenantId: string,
  versionId: string,
  language: string,
  defaultLanguage = 'en'
): Promise<{
  language: string;
  title: string;
  description: string;
  document_url: string | null;
  inline_content: string | null;
} | null> {
  const rows = await db.query<{
    language: string;
    title: string;
    description: string;
    document_url: string | null;
    inline_content: string | null;
  }>(
    `SELECT language, title, description, document_url, inline_content
       FROM consent_statement_localizations
      WHERE tenant_id = ? AND version_id = ?
      ORDER BY language ASC`,
    [tenantId, versionId]
  );
  return (
    rows.find((row) => row.language === language) ??
    rows.find((row) => row.language === defaultLanguage) ??
    rows.find((row) => row.language === 'en') ??
    rows[0] ??
    null
  );
}

async function resolveRuntimeConsentPolicyContent(
  db: DatabaseAdapter,
  tenantId: string,
  policyId: string,
  requestContext: FlowRequestContext
): Promise<RuntimeConsentPolicyContent | null> {
  const policy = await db.queryOne<{
    id: string;
    display_name: string;
    description: string | null;
    is_active: number;
  }>(
    `SELECT id, display_name, description, is_active
       FROM consent_policies
      WHERE tenant_id = ? AND id = ?`,
    [tenantId, policyId]
  );
  if (!policy || policy.is_active !== 1) return null;

  const itemRows = await db.query<{
    statement_id: string;
    requirement: string;
    version_mode: string;
    version_id: string | null;
    checkbox_mode: string;
    checkbox_default_checked: number;
    binding_type: string | null;
    binding_value: string | null;
    evidence_profile: string | null;
    language_fallback: string | null;
    display_order: number;
    slug: string;
    category: string;
  }>(
    `SELECT i.statement_id, i.requirement, i.version_mode, i.version_id,
            i.checkbox_mode, i.checkbox_default_checked, i.binding_type, i.binding_value,
            i.evidence_profile, i.language_fallback, i.display_order,
            s.slug, s.category
       FROM consent_policy_items i
       JOIN consent_statements s ON s.id = i.statement_id AND s.tenant_id = i.tenant_id
      WHERE i.tenant_id = ? AND i.policy_id = ? AND s.is_active = 1
      ORDER BY i.display_order ASC, i.created_at ASC`,
    [tenantId, policyId]
  );
  const language = requestedLanguage(requestContext);
  const items: RuntimeConsentPolicyItem[] = [];

  for (const row of itemRows) {
    if (row.requirement === 'hidden') continue;
    if (!consentBindingMatchesRequestContext(row.binding_type, row.binding_value, requestContext)) {
      continue;
    }
    const version = await getConsentVersionForPolicyItem(
      db,
      tenantId,
      row.statement_id,
      row.version_mode,
      row.version_id
    );
    if (!version) continue;
    const localization = await getConsentLocalizationForRuntime(db, tenantId, version.id, language);
    items.push({
      statement_id: row.statement_id,
      slug: row.slug,
      category: row.category,
      title: localization?.title || row.slug,
      description: localization?.description || '',
      document_url: localization?.document_url ?? null,
      inline_content: localization?.inline_content ?? null,
      version: version.version,
      version_id: version.id,
      is_required: row.requirement === 'required',
      checkbox_mode:
        row.checkbox_mode === 'required' || row.checkbox_mode === 'optional'
          ? row.checkbox_mode
          : 'none',
      checkbox_default_checked: row.checkbox_default_checked === 1,
      binding_type: row.binding_type,
      binding_value: row.binding_value,
      evidence_profile: row.evidence_profile,
      language_fallback: row.language_fallback,
      display_order: row.display_order,
    });
  }

  return {
    id: policy.id,
    display_name: policy.display_name,
    description: policy.description,
    language,
    default_language: 'en',
    items,
  };
}

async function hydrateRuntimeContract(
  c: AuthContext,
  db: DatabaseAdapter,
  tenantId: string,
  runtime: FlowRuntimeContract,
  requestContext: FlowRequestContext
): Promise<FlowRuntimeContract> {
  const steps = await Promise.all(
    runtime.ui.steps.map(async (step) => {
      const config = parseJsonRecord(step.config);
      const content = parseJsonRecord(step.content);
      if (
        step.component === 'authentication_method_selector' ||
        step.component === 'registration_method_selector'
      ) {
        const handles = await resolveRuntimeAuthenticationHandles(
          c.env,
          tenantId,
          runtime.flow_kind,
          step.component
        );
        return {
          ...step,
          config: {
            ...config,
            output_handles: handles,
          },
          content: {
            ...content,
            authentication_profile: {
              id: readString(config.authentication_profile_ref, 200) ?? 'default',
              output_handles: handles,
            },
          },
        };
      }

      if (step.component === 'consent_policy') {
        const policyId = readString(config.consent_policy_ref, 200);
        const policy = policyId
          ? await resolveRuntimeConsentPolicyContent(db, tenantId, policyId, requestContext)
          : null;
        return {
          ...step,
          content: {
            ...content,
            consent_policy: policy,
          },
        };
      }

      return step;
    })
  );

  return {
    ...runtime,
    ui: {
      ...runtime.ui,
      steps,
    },
  };
}

function createRequestContext(
  target: ResolvedTarget,
  body: Pick<
    StartRequest,
    | 'requested_scope'
    | 'scope'
    | 'requested_locale'
    | 'locale'
    | 'authorization_challenge_id'
    | 'saml_request_id'
    | 'saml_sp_entity_id'
    | 'return_to'
  >
): FlowRequestContext {
  const requestedScope = parseStringList(body.requested_scope ?? body.scope);
  const locale = readOptionalString(body.requested_locale ?? body.locale, 64);
  const samlSpEntityId = readOptionalString(body.saml_sp_entity_id, 512) ?? target.samlSpId;
  return {
    protocol: target.samlSpId ? 'saml' : target.clientId ? 'oidc' : 'direct',
    target_type: target.targetType,
    target_id: target.targetId,
    client_id: target.clientId,
    saml_sp_id: target.samlSpId,
    authorization_challenge_id: readOptionalString(body.authorization_challenge_id, 128),
    saml_request_id: readOptionalString(body.saml_request_id, 512),
    saml_sp_entity_id: samlSpEntityId,
    return_to: readOptionalString(body.return_to, 128),
    requested_scope: requestedScope,
    locale,
  };
}

function getRequestContextFromInteraction(interaction: FlowInteractionRow): FlowRequestContext {
  const raw = parseJsonObject(interaction.context_json);
  const protocol =
    raw.protocol === 'oidc' || raw.protocol === 'saml' || raw.protocol === 'direct'
      ? raw.protocol
      : interaction.saml_sp_id
        ? 'saml'
        : interaction.client_id
          ? 'oidc'
          : 'direct';
  const targetType =
    raw.target_type === 'oidc_client' ||
    raw.target_type === 'saml_sp' ||
    raw.target_type === 'tenant'
      ? raw.target_type
      : interaction.saml_sp_id
        ? 'saml_sp'
        : interaction.client_id
          ? 'oidc_client'
          : 'tenant';
  const fallbackTargetId =
    targetType === 'tenant' ? null : (interaction.saml_sp_id ?? interaction.client_id);
  return {
    protocol,
    target_type: targetType,
    target_id: typeof raw.target_id === 'string' ? raw.target_id : fallbackTargetId,
    client_id: interaction.client_id,
    saml_sp_id: interaction.saml_sp_id,
    authorization_challenge_id: readOptionalString(raw.authorization_challenge_id, 128),
    saml_request_id: readOptionalString(raw.saml_request_id, 512),
    saml_sp_entity_id:
      readOptionalString(raw.saml_sp_entity_id, 512) ??
      readOptionalString(raw.saml_sp_id, 512) ??
      interaction.saml_sp_id,
    return_to: readOptionalString(raw.return_to, 128),
    requested_scope: parseStringList(raw.requested_scope),
    locale: readOptionalString(raw.locale, 64),
  };
}

function getFirstStep(runtime: FlowRuntimeContract): {
  id: string;
  source_node_id: string;
  render?: boolean;
} | null {
  const first = runtime.ui.steps[0];
  if (!first || typeof first.id !== 'string' || typeof first.source_node_id !== 'string') {
    return null;
  }
  return first;
}

function bytesToBase64Url(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToBase64Url(digest);
}

async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToBase64Url(signature);
}

function getRuntimeHmacSecret(env: FlowRuntimeEnv): string | null {
  return readString(env.FLOW_RUNTIME_HMAC_SECRET, 2048) ?? readString(env.KEY_MANAGER_SECRET, 2048);
}

async function signContract(input: {
  interactionId: string;
  contractHash: string;
  expiresAt: number;
  secret: string;
}): Promise<string> {
  return hmacBase64Url(
    input.secret,
    `${input.interactionId}.${input.contractHash}.${input.expiresAt}`
  );
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let i = 0; i < length; i++) {
    diff |= (leftBytes[i] ?? 0) ^ (rightBytes[i] ?? 0);
  }

  return diff === 0;
}

async function verifyContractSignature(input: {
  interactionId: string;
  contractHash: string;
  expiresAt: number;
  storedSignature: string;
  submittedContractHash: string | null;
  submittedSignature: string | null;
  secret: string;
}): Promise<boolean> {
  if (
    !input.submittedContractHash ||
    !input.submittedSignature ||
    !constantTimeStringEqual(input.submittedContractHash, input.contractHash)
  ) {
    return false;
  }

  const expected = await signContract({
    interactionId: input.interactionId,
    contractHash: input.contractHash,
    expiresAt: input.expiresAt,
    secret: input.secret,
  });
  return (
    constantTimeStringEqual(input.submittedSignature, input.storedSignature) &&
    constantTimeStringEqual(input.submittedSignature, expected)
  );
}

function findCurrentStep(
  runtime: FlowRuntimeContract,
  interaction: FlowInteractionRow
): { index: number; step: FlowRuntimeStep } | null {
  const index = runtime.ui.steps.findIndex(
    (step) =>
      step.id === interaction.current_step_id && step.source_node_id === interaction.current_node_id
  );
  if (index < 0) return null;
  return {
    index,
    step: runtime.ui.steps[index],
  };
}

function resolveNextStep(
  runtime: FlowRuntimeContract,
  currentIndex: number,
  editor: FlowEditorState | null,
  selectedHandle: string | null
): { step: FlowRuntimeStep | null; errorCode?: string } {
  const currentStep = runtime.ui.steps[currentIndex];
  if (currentStep && editor) {
    const outgoingEdges = editor.edges.filter((edge) => edge.source === currentStep.source_node_id);
    if (outgoingEdges.length > 0) {
      const selectedEdge = selectedHandle
        ? outgoingEdges.find((edge) => edge.source_handle === selectedHandle)
        : null;
      if (selectedHandle && !selectedEdge) {
        return { step: null, errorCode: 'AR_FLOW_INVALID_SELECTED_HANDLE' };
      }

      const defaultEdge =
        outgoingEdges.find((edge) => !edge.source_handle || edge.source_handle === 'next') ??
        (outgoingEdges.length === 1 ? outgoingEdges[0] : null);
      if (!selectedHandle && !defaultEdge) {
        return { step: null, errorCode: 'AR_FLOW_SELECTED_HANDLE_REQUIRED' };
      }

      const nextEdge = selectedEdge ?? defaultEdge;
      const nextByEdge = nextEdge
        ? runtime.ui.steps.find((step) => step.source_node_id === nextEdge.target)
        : null;
      if (nextEdge && !nextByEdge) {
        return { step: null, errorCode: 'AR_FLOW_EDGE_TARGET_MISSING' };
      }
      if (nextByEdge) {
        return { step: nextByEdge };
      }
    }
  }

  return { step: runtime.ui.steps[currentIndex + 1] ?? null };
}

function parseConditionConfig(value: unknown): FlowConditionConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const config = value as FlowConditionConfig;
  if (!Array.isArray(config.rows)) return null;
  if (!config.otherwise || typeof config.otherwise !== 'object') return null;
  return config;
}

async function getLatestCompletedAuthenticationMethod(
  db: DatabaseAdapter,
  tenantId: string,
  interactionId: string,
  runtime: FlowRuntimeContract
): Promise<string | undefined> {
  const authenticationStepIds = new Set(
    runtime.ui.steps
      .filter(
        (step) =>
          step.component === 'authentication_method_selector' ||
          step.component === 'registration_method_selector'
      )
      .map((step) => step.id)
  );
  if (authenticationStepIds.size === 0) return undefined;

  const rows = await db.query<{ step_id: string; selected_handle: string | null }>(
    `SELECT step_id, selected_handle
     FROM flow_interaction_steps
     WHERE tenant_id = ?
       AND interaction_id = ?
       AND state = 'completed'
       AND selected_handle IS NOT NULL
     ORDER BY updated_at DESC
     LIMIT 20`,
    [tenantId, interactionId]
  );
  for (const row of rows) {
    if (authenticationStepIds.has(row.step_id)) {
      const selectedHandle = readOptionalString(row.selected_handle, 200);
      if (selectedHandle) return selectedHandle;
    }
  }
  return undefined;
}

async function buildConditionEvaluationContext(
  db: DatabaseAdapter,
  tenantId: string,
  interaction: FlowInteractionRow,
  runtime: FlowRuntimeContract
): Promise<FlowConditionEvaluationContext> {
  const requestContext = parseJsonObject(interaction.context_json);
  const authenticationMethod = await getLatestCompletedAuthenticationMethod(
    db,
    tenantId,
    interaction.id,
    runtime
  );
  return {
    authenticated: Boolean(authenticationMethod),
    client_id: interaction.client_id ?? undefined,
    saml_sp_id: interaction.saml_sp_id ?? undefined,
    flow_kind: runtime.flow_kind,
    requested_scope: parseStringList(requestContext.requested_scope),
    authentication_method: authenticationMethod,
    user: interaction.user_id
      ? await getFlowConditionUserContext(db, tenantId, interaction.user_id)
      : undefined,
  };
}

async function getFlowConditionUserContext(
  db: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<NonNullable<FlowConditionEvaluationContext['user']>> {
  const [roles, orgIds] = await Promise.all([
    getFlowConditionUserRoles(db, tenantId, userId),
    getFlowConditionUserOrgIds(db, tenantId, userId),
  ]);
  return {
    roles,
    org_ids: orgIds,
  };
}

async function getFlowConditionUserRoles(
  db: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<string[]> {
  try {
    const rows = await db.query<{ name: string }>(
      `SELECT DISTINCT r.name
         FROM user_roles ur
         JOIN roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
        WHERE ur.tenant_id = ? AND ur.user_id = ?`,
      [tenantId, userId]
    );
    if (rows.length > 0) return rows.map((row) => row.name).filter(Boolean);
  } catch {
    // Optional RBAC tables differ by runtime topology; fail closed below.
  }

  try {
    const now = Date.now();
    const rows = await db.query<{ name: string }>(
      `SELECT DISTINCT r.name
         FROM role_assignments ra
         JOIN roles r ON r.tenant_id = ra.tenant_id AND r.id = ra.role_id
        WHERE ra.tenant_id = ?
          AND ra.subject_id = ?
          AND (ra.expires_at IS NULL OR ra.expires_at > ?)`,
      [tenantId, userId, now]
    );
    return rows.map((row) => row.name).filter(Boolean);
  } catch {
    return [];
  }
}

async function getFlowConditionUserOrgIds(
  db: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<string[]> {
  try {
    const rows = await db.query<{ org_id: string }>(
      `SELECT DISTINCT org_id
         FROM subject_org_membership
        WHERE tenant_id = ? AND subject_id = ?`,
      [tenantId, userId]
    );
    if (rows.length > 0) return rows.map((row) => row.org_id).filter(Boolean);
  } catch {
    // Optional organization tables differ by runtime topology; fail closed below.
  }

  try {
    const rows = await db.query<{ org_id: string }>(
      `SELECT DISTINCT org_id
         FROM org_memberships
        WHERE tenant_id = ? AND user_id = ?`,
      [tenantId, userId]
    );
    if (rows.length > 0) return rows.map((row) => row.org_id).filter(Boolean);
  } catch {
    // Continue to the alternate table name below.
  }

  try {
    const rows = await db.query<{ org_id: string }>(
      `SELECT DISTINCT org_id
         FROM organization_memberships
        WHERE tenant_id = ? AND user_id = ? AND is_active = 1`,
      [tenantId, userId]
    );
    return rows.map((row) => row.org_id).filter(Boolean);
  } catch {
    return [];
  }
}

async function resolveConditionSelectedHandle(input: {
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  runtime: FlowRuntimeContract;
  step: FlowRuntimeStep;
}): Promise<{
  selectedHandle: string | null;
  terminalError?: { error: string; message?: string };
  errorCode?: string;
}> {
  const config = parseConditionConfig(input.step.config?.conditions);
  if (!config) {
    return { selectedHandle: null, errorCode: 'AR_FLOW_CONDITION_CONFIG_INVALID' };
  }

  const context = await buildConditionEvaluationContext(
    input.db,
    input.tenantId,
    input.interaction,
    input.runtime
  );
  const result = await evaluateFlowConditionRows(config, context);
  if (!result.matched && result.terminal_error) {
    return { selectedHandle: null, terminalError: result.terminal_error };
  }
  if (!result.matched && !result.output_handle) {
    return { selectedHandle: null, errorCode: 'AR_FLOW_CONDITION_NO_MATCH' };
  }
  return { selectedHandle: result.output_handle ?? null };
}

function getStepStateForRuntimeStep(step: FlowRuntimeStep): 'pending' | 'waiting_input' {
  return step.render === false ? 'pending' : 'waiting_input';
}

function runtimeStepResponse(step: FlowRuntimeStep | null) {
  if (!step) return null;
  return {
    id: step.id,
    source_node_id: step.source_node_id,
    component: step.component,
    render: step.render,
    capability_ids: step.capability_ids,
    bindings: step.bindings,
    content: step.content,
    config: step.config,
  };
}

function readRuntimeCompletionBlock(step: FlowRuntimeStep): FlowRuntimeJsonObject | null {
  const config = parseJsonRecord(step.config);
  const rawBlock = parseJsonRecord(config.completion_block);
  const id = readString(rawBlock.id, 200);
  if (!id) return null;
  const block: FlowRuntimeJsonObject = { id };
  const label = readString(rawBlock.label, 200);
  const protocol = readString(rawBlock.protocol, 64);
  const purpose = readString(rawBlock.purpose, 128);
  const role = readString(rawBlock.role, 64);
  if (label) block.label = label;
  if (protocol) block.protocol = protocol;
  if (purpose) block.purpose = purpose;
  if (role) block.role = role;
  return block;
}

function buildCompletedRuntimeOutput(input: {
  interaction: FlowInteractionRow;
  requestContext: FlowRequestContext;
  currentStep: FlowRuntimeStep;
  effectiveSelectedHandle: string | null;
  redirectUrl?: string;
}): FlowRuntimeJsonObject {
  const completionBlock = readRuntimeCompletionBlock(input.currentStep);
  const output: FlowRuntimeJsonObject = {
    action: input.requestContext.protocol === 'direct' ? 'complete' : 'continue_protocol',
    protocol_continuation: {
      type: 'protocol_continuation',
      protocol: input.requestContext.protocol,
      flow_id: input.interaction.flow_id,
      flow_version_id: input.interaction.flow_version_id,
      interaction_id: input.interaction.id,
      target_type: input.requestContext.target_type,
      target_id: input.requestContext.target_id,
      client_id: input.requestContext.client_id,
      saml_sp_id: input.requestContext.saml_sp_id,
      authorization_challenge_id: input.requestContext.authorization_challenge_id,
      saml_request_id: input.requestContext.saml_request_id,
      saml_sp_entity_id: input.requestContext.saml_sp_entity_id,
      return_to: input.requestContext.return_to,
      requested_scope: input.requestContext.requested_scope,
      selected_handle: input.effectiveSelectedHandle,
      completion_block: completionBlock,
    },
  };
  if (input.redirectUrl) {
    output.redirect_url = input.redirectUrl;
  }
  return output;
}

function getRequestOrigin(c: AuthContext): string {
  const url = (c.req as { url?: string }).url;
  if (!url) return 'https://authrim.local';
  try {
    return new URL(url).origin;
  } catch {
    return 'https://authrim.local';
  }
}

function getSessionAuthTime(session: Session): number {
  return typeof session.data?.authTime === 'number'
    ? session.data.authTime
    : Math.floor(session.createdAt / 1000);
}

async function resolveCompletedProtocolRedirect(input: {
  c: AuthContext;
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  runtime: FlowRuntimeContract;
  requestContext: FlowRequestContext;
  resolvedUserId: string | null;
}): Promise<{ redirectUrl?: string; response?: Response }> {
  if (
    input.requestContext.protocol !== 'oidc' ||
    !input.requestContext.authorization_challenge_id
  ) {
    return {};
  }

  const session = await getCurrentSession(input.c, input.tenantId);
  const userId = input.resolvedUserId ?? session?.userId ?? null;
  if (!session || !userId) {
    return {};
  }

  const continuation = await consumeAuthorizationChallengeContinuation(
    input.c.env,
    input.tenantId,
    input.requestContext.authorization_challenge_id,
    userId,
    getSessionAuthTime(session),
    getRequestOrigin(input.c)
  );
  if ('error' in continuation) {
    return { response: continuation.error };
  }
  return { redirectUrl: continuation.redirectUrl };
}

function eventTypeForCompletedStep(step: FlowRuntimeStep): string {
  if (step.component === 'consent_policy') return 'flow.consent.completed';
  if (step.component === 'condition') return 'flow.condition.matched';
  if (
    step.component === 'authentication_method_selector' ||
    step.component === 'registration_method_selector'
  ) {
    return 'flow.auth_method.selected';
  }
  if (step.component === 'completion') return 'flow.output.completed';
  return 'flow.node.completed';
}

async function insertAuditEvent(
  db: DatabaseAdapter,
  tenantId: string,
  interaction: FlowInteractionRow,
  input: {
    eventType: string;
    result: string;
    nodeId?: string | null;
    branchHandleId?: string | null;
    errorCode?: string | null;
    metadata?: Record<string, unknown>;
    userId?: string | null;
  }
) {
  await db.execute(
    `INSERT INTO flow_audit_events (
      id, tenant_id, interaction_id, flow_id, flow_version_id, user_id, client_id, saml_sp_id,
      node_id, branch_handle_id, event_type, result, error_code, contract_hash, metadata_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generateId(),
      tenantId,
      interaction.id,
      interaction.flow_id,
      interaction.flow_version_id,
      input.userId ?? interaction.user_id ?? null,
      interaction.client_id,
      interaction.saml_sp_id,
      input.nodeId ?? null,
      input.branchHandleId ?? null,
      input.eventType,
      input.result,
      input.errorCode ?? null,
      interaction.contract_hash,
      input.metadata ? JSON.stringify(input.metadata) : null,
      nowSeconds(),
    ]
  );
}

function getRequestHeader(c: AuthContext, name: string): string | undefined {
  const header = (c.req as { header?: (name: string) => string | undefined }).header;
  return typeof header === 'function' ? header.call(c.req, name) : undefined;
}

function getSessionIdFromRequest(c: AuthContext): string | null {
  const cookieHeader = getRequestHeader(c, 'Cookie') ?? '';
  const cookieSession = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('authrim_session='));
  if (cookieSession) return decodeURIComponent(cookieSession.slice('authrim_session='.length));
  const authHeader = getRequestHeader(c, 'Authorization');
  return authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
}

async function getCurrentSessionUserId(c: AuthContext, tenantId: string): Promise<string | null> {
  const session = await getCurrentSession(c, tenantId);
  return session?.userId || null;
}

async function getCurrentSession(c: AuthContext, tenantId: string): Promise<Session | null> {
  const sessionId = getSessionIdFromRequest(c);
  if (!sessionId || !isShardedSessionId(sessionId)) return null;
  const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId, tenantId);
  const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;
  if (!session || session.expiresAt <= Date.now()) return null;
  return session;
}

function readConsentDecisionMap(input: unknown): Record<string, 'granted' | 'denied'> {
  const inputRecord = parseJsonRecord(input);
  const raw = parseJsonRecord(inputRecord.consent_item_decisions ?? inputRecord.decisions);
  const decisions: Record<string, 'granted' | 'denied'> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === 'granted' || value === 'denied') {
      decisions[key] = value;
    }
  }
  return decisions;
}

async function persistRuntimeConsentStep(input: {
  c: AuthContext;
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  step: FlowRuntimeStep;
  submitInput: unknown;
}): Promise<{ ok: boolean; response?: Response; userId?: string | null }> {
  if (input.step.component !== 'consent_policy') return { ok: true };
  const requestContext = getRequestContextFromInteraction(input.interaction);
  const config = parseJsonRecord(input.step.config);
  const policyId = readString(config.consent_policy_ref, 200);
  if (!policyId) {
    return {
      ok: false,
      response: runtimeError(
        input.c,
        409,
        'invalid_consent_policy',
        'Consent policy is not configured for this Flow step',
        'AR_FLOW_CONSENT_POLICY_MISSING',
        'configuration_error',
        'contact_administrator',
        input.interaction.id
      ),
    };
  }

  const policy = await resolveRuntimeConsentPolicyContent(
    input.db,
    input.tenantId,
    policyId,
    requestContext
  );
  if (!policy) {
    return {
      ok: false,
      response: runtimeError(
        input.c,
        409,
        'invalid_consent_policy',
        'Consent policy is unavailable',
        'AR_FLOW_CONSENT_POLICY_UNAVAILABLE',
        'configuration_error',
        'contact_administrator',
        input.interaction.id
      ),
    };
  }

  const userId = await getCurrentSessionUserId(input.c, input.tenantId);
  if (!userId) {
    return {
      ok: false,
      response: runtimeError(
        input.c,
        401,
        'authentication_required',
        'Consent can only be recorded after authentication',
        'AR_FLOW_CONSENT_AUTH_REQUIRED',
        'reauthentication_required',
        'reauthenticate',
        input.interaction.id
      ),
    };
  }

  const submitted = readConsentDecisionMap(input.submitInput);
  const decisions = Object.fromEntries(
    policy.items.map((item) => [
      item.statement_id,
      submitted[item.statement_id] === 'granted' || submitted[item.statement_id] === 'denied'
        ? submitted[item.statement_id]
        : item.checkbox_mode === 'none'
          ? 'granted'
          : 'denied',
    ])
  ) as Record<string, 'granted' | 'denied'>;
  const missingRequired = policy.items.filter(
    (item) => item.is_required && decisions[item.statement_id] !== 'granted'
  );
  if (missingRequired.length > 0) {
    return {
      ok: false,
      response: runtimeError(
        input.c,
        400,
        'consent_required',
        'Required consent items must be granted',
        'AR_FLOW_CONSENT_REQUIRED',
        'recoverable',
        'retry_step',
        input.interaction.id
      ),
    };
  }

  const targets = Object.fromEntries(
    policy.items.map((item) => [
      item.statement_id,
      {
        version_id: item.version_id,
        version: item.version,
      },
    ])
  );
  const ipAddress =
    getRequestHeader(input.c, 'CF-Connecting-IP') ||
    getRequestHeader(input.c, 'X-Forwarded-For') ||
    '';
  const ipHash = ipAddress
    ? await hashIpAddress(ipAddress, input.tenantId, input.c.env.KV ?? null)
    : undefined;
  await processConsentItemDecisions(
    input.db,
    input.tenantId,
    userId,
    decisions,
    {
      ip_address: ipAddress || undefined,
      user_agent: getRequestHeader(input.c, 'User-Agent'),
      client_id: input.interaction.client_id ?? undefined,
    },
    ipHash,
    targets
  );

  await input.db.execute(
    `UPDATE flow_interactions
       SET user_id = COALESCE(user_id, ?), updated_at = ?
     WHERE tenant_id = ? AND id = ?`,
    [userId, nowSeconds(), input.tenantId, input.interaction.id]
  );

  return { ok: true, userId };
}

export async function cleanupExpiredFlowInteractions(
  db: DatabaseAdapter,
  tenantId: string,
  options: { now?: number; retentionSeconds?: number } = {}
): Promise<{ expired: number; deletedSteps: number }> {
  const now = options.now ?? nowSeconds();
  const retentionSeconds = Math.max(0, options.retentionSeconds ?? 24 * 60 * 60);
  const cutoff = now - retentionSeconds;
  const expiredResult = await db.execute(
    `UPDATE flow_interactions
     SET state = 'expired', updated_at = ?
     WHERE tenant_id = ?
       AND state IN ('created', 'active')
       AND expires_at <= ?`,
    [now, tenantId, now]
  );
  const deletedStepsResult = await db.execute(
    `DELETE FROM flow_interaction_steps
     WHERE tenant_id = ?
       AND interaction_id IN (
         SELECT id
         FROM flow_interactions
         WHERE tenant_id = ?
           AND state IN ('completed', 'expired', 'failed')
           AND updated_at <= ?
       )`,
    [tenantId, tenantId, cutoff]
  );

  return {
    expired: expiredResult.rowsAffected ?? 0,
    deletedSteps: deletedStepsResult.rowsAffected ?? 0,
  };
}

async function resumeInteraction(
  c: AuthContext,
  db: DatabaseAdapter,
  tenantId: string,
  interactionId: string,
  submittedContractHash: string | null,
  submittedSignature: string | null
) {
  const now = nowSeconds();
  const interaction = await db.queryOne<FlowInteractionRow>(
    `SELECT id, flow_id, flow_version_id, user_id, client_id, saml_sp_id, state, current_node_id,
            current_step_id, context_json, contract_hash, signature, expires_at
     FROM flow_interactions
     WHERE tenant_id = ? AND id = ? AND state IN ('created', 'active') AND expires_at > ?`,
    [tenantId, interactionId, now]
  );
  if (!interaction) {
    return jsonError(c, 404, 'interaction_not_found', 'Flow interaction was not found or expired');
  }

  const secret = getRuntimeHmacSecret(c.env);
  if (!secret) {
    return runtimeError(
      c,
      500,
      'flow_runtime_secret_missing',
      'Flow runtime signing secret is not configured',
      'AR_FLOW_SECRET_MISSING',
      'configuration_error',
      'contact_administrator',
      interactionId
    );
  }

  const signatureValid = await verifyContractSignature({
    interactionId,
    contractHash: interaction.contract_hash,
    expiresAt: interaction.expires_at,
    storedSignature: interaction.signature,
    submittedContractHash,
    submittedSignature,
    secret,
  });
  if (!signatureValid) {
    return runtimeError(
      c,
      403,
      'invalid_runtime_signature',
      'Flow runtime contract verification failed',
      'AR_FLOW_SIGNATURE_MISMATCH',
      'security_error',
      'restart_interaction',
      interactionId
    );
  }

  const version = await getFlowVersion(
    db,
    tenantId,
    interaction.flow_id,
    interaction.flow_version_id
  );
  const runtime = version ? parseRuntimeSnapshot(version.runtime_snapshot_json) : null;
  if (!version || !runtime) {
    return jsonError(c, 409, 'flow_version_unavailable', 'Published Flow version is unavailable');
  }

  const requestContext = getRequestContextFromInteraction(interaction);
  const contract = await hydrateRuntimeContract(
    c,
    db,
    tenantId,
    normalizeRuntime(
      runtime,
      {
        flow_id: interaction.flow_id,
        flow_kind: runtime.flow_kind,
        target_type: interaction.saml_sp_id
          ? 'saml_sp'
          : interaction.client_id
            ? 'oidc_client'
            : 'tenant',
        target_id: interaction.saml_sp_id ?? interaction.client_id,
        published_version_id: interaction.flow_version_id,
      },
      version,
      requestContext
    ),
    requestContext
  );
  const contractHash = await sha256Base64Url(JSON.stringify(contract));
  const signature = await signContract({
    interactionId: interaction.id,
    contractHash,
    expiresAt: interaction.expires_at,
    secret,
  });
  await db.execute(
    `UPDATE flow_interactions
       SET contract_hash = ?, signature = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ?`,
    [contractHash, signature, now, tenantId, interaction.id]
  );

  return c.json({
    schema_version: FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
    interaction: {
      id: interaction.id,
      state: interaction.state,
      flow_id: interaction.flow_id,
      flow_version_id: interaction.flow_version_id,
      current_node_id: interaction.current_node_id,
      current_step_id: interaction.current_step_id,
      expires_at: interaction.expires_at,
    },
    contract,
    contract_hash: contractHash,
    signature,
    expires_in: Math.max(0, interaction.expires_at - now),
    resumed: true,
  });
}

export async function loginRuntimeInteractionStartHandler(c: AuthContext) {
  const tenantId = getTenantIdFromContext(c);
  const enabled = await isLoginRuntimeFlowEnabled(c.env, tenantId);
  if (!enabled) {
    return jsonError(c, 403, 'flow_runtime_disabled', 'LoginUI runtime Flow is disabled');
  }

  const body = await c.req.json<StartRequest>().catch((): StartRequest => ({}));
  const resumeInteractionId = readString(body.resume_interaction_id, 128);
  const authCtx = createAuthContextFromHono(c, tenantId);
  const db = authCtx.coreAdapter;

  if (resumeInteractionId) {
    return resumeInteraction(
      c,
      db,
      tenantId,
      resumeInteractionId,
      readString(body.contract_hash, 256),
      readString(body.signature, 512)
    );
  }

  const target = resolveTarget(body);
  if (!target) {
    return jsonError(c, 400, 'invalid_target', 'Flow assignment target is invalid');
  }

  const flowKind = normalizeFlowKind(body.flow_kind);
  const requestContext = createRequestContext(target, body);
  const assignment = await resolveAssignment(db, tenantId, flowKind, target);
  if (!assignment) {
    return jsonError(
      c,
      409,
      'flow_assignment_missing',
      'No published Flow assignment is available'
    );
  }

  const version = await getPublishedVersion(db, tenantId, assignment);
  const runtimeSnapshot = version ? parseRuntimeSnapshot(version.runtime_snapshot_json) : null;
  if (!version || !runtimeSnapshot) {
    return jsonError(c, 409, 'flow_version_unavailable', 'Published Flow version is unavailable');
  }

  const runtime = await hydrateRuntimeContract(
    c,
    db,
    tenantId,
    normalizeRuntime(runtimeSnapshot, assignment, version, requestContext),
    requestContext
  );
  const firstStep = getFirstStep(runtime);
  if (!firstStep) {
    return jsonError(
      c,
      409,
      'flow_runtime_invalid',
      'Published Flow runtime has no executable steps'
    );
  }

  const secret = getRuntimeHmacSecret(c.env);
  if (!secret) {
    return jsonError(
      c,
      500,
      'flow_runtime_secret_missing',
      'Flow runtime signing secret is not configured'
    );
  }

  const interactionId = generateId();
  const stepRowId = generateId();
  const auditEventId = generateId();
  const now = nowSeconds();
  const expiresAt = now + FLOW_RUNTIME_INTERACTION_TTL_SECONDS;
  const contractHash = await sha256Base64Url(JSON.stringify(runtime));
  const signature = await signContract({
    interactionId,
    contractHash,
    expiresAt,
    secret,
  });

  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO flow_interactions (
        id, tenant_id, flow_id, flow_version_id, user_id, client_id, saml_sp_id, state,
        current_node_id, current_step_id, context_json, contract_hash, signature, expires_at, created_at,
        updated_at, completed_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [
        interactionId,
        tenantId,
        assignment.flow_id,
        version.id,
        target.clientId,
        target.samlSpId,
        firstStep.source_node_id,
        firstStep.id,
        JSON.stringify(requestContext),
        contractHash,
        signature,
        expiresAt,
        now,
        now,
      ]
    );
    await tx.execute(
      `INSERT INTO flow_interaction_steps (
        id, tenant_id, interaction_id, node_id, step_id, state, selected_handle, state_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      [
        stepRowId,
        tenantId,
        interactionId,
        firstStep.source_node_id,
        firstStep.id,
        firstStep.render === false ? 'pending' : 'waiting_input',
        now,
        now,
      ]
    );
    await tx.execute(
      `INSERT INTO flow_audit_events (
        id, tenant_id, interaction_id, flow_id, flow_version_id, user_id, client_id, saml_sp_id,
        node_id, branch_handle_id, event_type, result, error_code, contract_hash, metadata_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 'flow.interaction.started', 'success', NULL, ?, ?, ?)`,
      [
        auditEventId,
        tenantId,
        interactionId,
        assignment.flow_id,
        version.id,
        target.clientId,
        target.samlSpId,
        firstStep.source_node_id,
        contractHash,
        JSON.stringify({
          target_type: assignment.target_type,
          target_id: assignment.target_id,
          flow_kind: assignment.flow_kind,
          requested_scope: requestContext.requested_scope,
        }),
        now,
      ]
    );
  });

  getLogger(c).module('LOGIN-RUNTIME-FLOW').info('Started LoginUI runtime Flow interaction', {
    interaction_id: interactionId,
    flow_id: assignment.flow_id,
    flow_version_id: version.id,
    flow_kind: assignment.flow_kind,
  });

  return c.json({
    schema_version: FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
    interaction: {
      id: interactionId,
      state: 'active',
      flow_id: assignment.flow_id,
      flow_version_id: version.id,
      current_node_id: firstStep.source_node_id,
      current_step_id: firstStep.id,
      expires_at: expiresAt,
    },
    assignment: {
      target_type: assignment.target_type,
      target_id: assignment.target_id,
      flow_kind: assignment.flow_kind,
    },
    contract: runtime,
    contract_hash: contractHash,
    signature,
    expires_in: FLOW_RUNTIME_INTERACTION_TTL_SECONDS,
    resumed: false,
  });
}

export async function loginRuntimeInteractionSubmitHandler(c: AuthContext) {
  const tenantId = getTenantIdFromContext(c);
  const enabled = await isLoginRuntimeFlowEnabled(c.env, tenantId);
  if (!enabled) {
    return runtimeError(
      c,
      403,
      'flow_runtime_disabled',
      'LoginUI runtime Flow is disabled',
      'AR_FLOW_DISABLED',
      'configuration_error',
      'contact_administrator'
    );
  }

  const interactionId = readString(c.req.param('interaction_id'), 128);
  if (!interactionId) {
    return runtimeError(
      c,
      400,
      'invalid_request',
      'Interaction ID is required',
      'AR_FLOW_INVALID_REQUEST',
      'recoverable',
      'retry_step'
    );
  }

  const body = await c.req.json<SubmitRequest>().catch((): SubmitRequest => ({}));
  const submittedStepId = readString(body.step_id, 200);
  const submittedNodeId = readOptionalString(body.node_id, 200);
  const selectedHandle = readOptionalString(body.selected_handle, 200);
  const submittedContractHash = readString(body.contract_hash, 256);
  const submittedSignature = readString(body.signature, 512);

  if (!submittedStepId) {
    return runtimeError(
      c,
      400,
      'invalid_request',
      'step_id is required',
      'AR_FLOW_INVALID_STEP',
      'recoverable',
      'retry_step',
      interactionId
    );
  }

  const authCtx = createAuthContextFromHono(c, tenantId);
  const db = authCtx.coreAdapter;
  const now = nowSeconds();
  const interaction = await db.queryOne<FlowInteractionRow>(
    `SELECT id, flow_id, flow_version_id, user_id, client_id, saml_sp_id, state, current_node_id,
            current_step_id, context_json, contract_hash, signature, expires_at
     FROM flow_interactions
     WHERE tenant_id = ? AND id = ?`,
    [tenantId, interactionId]
  );

  if (!interaction) {
    return runtimeError(
      c,
      404,
      'interaction_not_found',
      'Flow interaction was not found',
      'AR_FLOW_NOT_FOUND',
      'restart_required',
      'restart_interaction',
      interactionId
    );
  }

  if (interaction.state !== 'created' && interaction.state !== 'active') {
    return runtimeError(
      c,
      409,
      'interaction_not_active',
      'Flow interaction is no longer active',
      'AR_FLOW_NOT_ACTIVE',
      'restart_required',
      'restart_interaction',
      interactionId
    );
  }

  if (interaction.expires_at <= now) {
    await db.execute(
      `UPDATE flow_interactions
       SET state = 'expired', updated_at = ?
       WHERE tenant_id = ? AND id = ? AND state IN ('created', 'active')`,
      [now, tenantId, interactionId]
    );
    await insertAuditEvent(db, tenantId, interaction, {
      eventType: 'flow.interaction.failed',
      result: 'expired',
      errorCode: 'AR_FLOW_EXPIRED',
    });
    return runtimeError(
      c,
      409,
      'interaction_expired',
      'The login interaction has expired',
      'AR_FLOW_EXPIRED',
      'restart_required',
      'restart_interaction',
      interactionId
    );
  }

  const secret = getRuntimeHmacSecret(c.env);
  if (!secret) {
    return runtimeError(
      c,
      500,
      'flow_runtime_secret_missing',
      'Flow runtime signing secret is not configured',
      'AR_FLOW_SECRET_MISSING',
      'configuration_error',
      'contact_administrator',
      interactionId
    );
  }

  const signatureValid = await verifyContractSignature({
    interactionId,
    contractHash: interaction.contract_hash,
    expiresAt: interaction.expires_at,
    storedSignature: interaction.signature,
    submittedContractHash,
    submittedSignature,
    secret,
  });
  if (!signatureValid) {
    await insertAuditEvent(db, tenantId, interaction, {
      eventType: 'flow.interaction.failed',
      result: 'security_error',
      errorCode: 'AR_FLOW_SIGNATURE_MISMATCH',
      nodeId: interaction.current_node_id,
    });
    return runtimeError(
      c,
      403,
      'invalid_runtime_signature',
      'Flow runtime contract verification failed',
      'AR_FLOW_SIGNATURE_MISMATCH',
      'security_error',
      'restart_interaction',
      interactionId
    );
  }

  if (
    submittedStepId !== interaction.current_step_id ||
    (submittedNodeId && submittedNodeId !== interaction.current_node_id)
  ) {
    await insertAuditEvent(db, tenantId, interaction, {
      eventType: 'flow.interaction.failed',
      result: 'security_error',
      errorCode: 'AR_FLOW_STEP_MISMATCH',
      nodeId: interaction.current_node_id,
    });
    return runtimeError(
      c,
      409,
      'step_mismatch',
      'Submitted step does not match the active Flow step',
      'AR_FLOW_STEP_MISMATCH',
      'security_error',
      'restart_interaction',
      interactionId
    );
  }

  const stepState = await db.queryOne<FlowInteractionStepRow>(
    `SELECT id, interaction_id, node_id, step_id, state, selected_handle, state_json
     FROM flow_interaction_steps
     WHERE tenant_id = ? AND interaction_id = ? AND node_id = ? AND step_id = ?`,
    [tenantId, interactionId, interaction.current_node_id, interaction.current_step_id]
  );
  if (!stepState || stepState.state === 'completed' || stepState.state === 'failed') {
    return runtimeError(
      c,
      409,
      'step_not_active',
      'The submitted Flow step is no longer active',
      'AR_FLOW_STEP_NOT_ACTIVE',
      'restart_required',
      'restart_interaction',
      interactionId
    );
  }

  const version = await getFlowVersion(
    db,
    tenantId,
    interaction.flow_id,
    interaction.flow_version_id
  );
  const runtimeSnapshot = version ? parseRuntimeSnapshot(version.runtime_snapshot_json) : null;
  const editor = version ? parseEditorSnapshot(version.editor_snapshot_json) : null;
  const requestContext = getRequestContextFromInteraction(interaction);
  const runtime =
    version && runtimeSnapshot
      ? await hydrateRuntimeContract(
          c,
          db,
          tenantId,
          normalizeRuntime(
            runtimeSnapshot,
            {
              flow_id: interaction.flow_id,
              flow_kind: runtimeSnapshot.flow_kind,
              target_type: interaction.saml_sp_id
                ? 'saml_sp'
                : interaction.client_id
                  ? 'oidc_client'
                  : 'tenant',
              target_id: interaction.saml_sp_id ?? interaction.client_id,
              published_version_id: interaction.flow_version_id,
            },
            version,
            requestContext
          ),
          requestContext
        )
      : null;
  if (!version || !runtime) {
    return runtimeError(
      c,
      409,
      'flow_version_unavailable',
      'Published Flow version is unavailable',
      'AR_FLOW_VERSION_UNAVAILABLE',
      'configuration_error',
      'contact_administrator',
      interactionId
    );
  }

  const current = findCurrentStep(runtime, interaction);
  if (!current) {
    return runtimeError(
      c,
      409,
      'flow_runtime_invalid',
      'Active Flow step is not present in the published runtime',
      'AR_FLOW_RUNTIME_INVALID',
      'configuration_error',
      'contact_administrator',
      interactionId
    );
  }

  let branchResolution: {
    selectedHandle: string | null;
    terminalError?: { error: string; message?: string };
    errorCode?: string;
  };
  if (current.step.component === 'condition') {
    branchResolution = await resolveConditionSelectedHandle({
      db,
      tenantId,
      interaction,
      runtime,
      step: current.step,
    });
  } else {
    branchResolution = { selectedHandle };
  }

  if (branchResolution.terminalError) {
    await insertAuditEvent(db, tenantId, interaction, {
      eventType: 'flow.interaction.failed',
      result: 'terminal_error',
      errorCode: branchResolution.terminalError.error,
      nodeId: interaction.current_node_id,
    });
    return runtimeError(
      c,
      409,
      branchResolution.terminalError.error,
      branchResolution.terminalError.message ?? 'Flow condition ended this interaction',
      'AR_FLOW_TERMINAL',
      'terminal_error',
      'show_terminal_error',
      interactionId
    );
  }

  if (branchResolution.errorCode) {
    await insertAuditEvent(db, tenantId, interaction, {
      eventType: 'flow.interaction.failed',
      result: 'configuration_error',
      errorCode: branchResolution.errorCode,
      nodeId: interaction.current_node_id,
    });
    return runtimeError(
      c,
      409,
      'invalid_flow_condition',
      'Active Flow condition cannot be evaluated',
      branchResolution.errorCode,
      'configuration_error',
      'contact_administrator',
      interactionId
    );
  }

  const effectiveSelectedHandle = branchResolution.selectedHandle ?? selectedHandle;
  const nextResolution = resolveNextStep(runtime, current.index, editor, effectiveSelectedHandle);
  if (nextResolution.errorCode) {
    await insertAuditEvent(db, tenantId, interaction, {
      eventType: 'flow.interaction.failed',
      result: 'security_error',
      errorCode: nextResolution.errorCode,
      nodeId: interaction.current_node_id,
      branchHandleId: effectiveSelectedHandle,
    });
    return runtimeError(
      c,
      409,
      'invalid_flow_branch',
      'Submitted Flow branch does not match the active Flow step',
      nextResolution.errorCode,
      'security_error',
      'restart_interaction',
      interactionId
    );
  }

  const nextStep = nextResolution.step;
  const completed = nextStep === null;
  const nextState = completed ? 'completed' : 'active';
  const completedAt = completed ? now : null;
  const consentResult = await persistRuntimeConsentStep({
    c,
    db,
    tenantId,
    interaction,
    step: current.step,
    submitInput: body.input,
  });
  if (!consentResult.ok) {
    return (
      consentResult.response ??
      runtimeError(
        c,
        409,
        'invalid_consent_policy',
        'Consent policy could not be processed',
        'AR_FLOW_CONSENT_PROCESSING_FAILED',
        'configuration_error',
        'contact_administrator',
        interactionId
      )
    );
  }
  let resolvedUserId = consentResult.userId ?? interaction.user_id;
  if (
    !resolvedUserId &&
    (current.step.component === 'authentication_method_selector' ||
      current.step.component === 'registration_method_selector' ||
      completed)
  ) {
    resolvedUserId = await getCurrentSessionUserId(c, tenantId);
    if (resolvedUserId) {
      await db.execute(
        `UPDATE flow_interactions
           SET user_id = COALESCE(user_id, ?), updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
        [resolvedUserId, now, tenantId, interactionId]
      );
    }
  }

  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE flow_interaction_steps
       SET state = 'completed', selected_handle = ?, state_json = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND state IN ('pending', 'waiting_input', 'processing')`,
      [
        effectiveSelectedHandle,
        JSON.stringify({
          selected_handle: effectiveSelectedHandle,
          submitted_handle: selectedHandle,
          completed_at: now,
        }),
        now,
        tenantId,
        stepState.id,
      ]
    );

    if (nextStep) {
      const nextStepRowId = generateId();
      await tx.execute(
        `INSERT INTO flow_interaction_steps (
          id, tenant_id, interaction_id, node_id, step_id, state, selected_handle, state_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        [
          nextStepRowId,
          tenantId,
          interactionId,
          nextStep.source_node_id,
          nextStep.id,
          getStepStateForRuntimeStep(nextStep),
          now,
          now,
        ]
      );
      await tx.execute(
        `UPDATE flow_interactions
         SET state = ?, current_node_id = ?, current_step_id = ?, updated_at = ?, completed_at = NULL
         WHERE tenant_id = ? AND id = ?`,
        [nextState, nextStep.source_node_id, nextStep.id, now, tenantId, interactionId]
      );
    } else {
      await tx.execute(
        `UPDATE flow_interactions
         SET state = ?, current_node_id = NULL, current_step_id = NULL, updated_at = ?, completed_at = ?
         WHERE tenant_id = ? AND id = ?`,
        [nextState, now, completedAt, tenantId, interactionId]
      );
    }
  });

  await insertAuditEvent(db, tenantId, interaction, {
    eventType: eventTypeForCompletedStep(current.step),
    result: 'success',
    nodeId: current.step.source_node_id,
    branchHandleId: effectiveSelectedHandle,
    userId: resolvedUserId,
  });
  if (nextStep) {
    await insertAuditEvent(db, tenantId, interaction, {
      eventType: 'flow.node.entered',
      result: 'success',
      nodeId: nextStep.source_node_id,
      userId: resolvedUserId,
    });
  } else {
    if (current.step.component !== 'completion') {
      await insertAuditEvent(db, tenantId, interaction, {
        eventType: 'flow.output.completed',
        result: 'success',
        nodeId: current.step.source_node_id,
        branchHandleId: effectiveSelectedHandle,
        userId: resolvedUserId,
      });
    }
    await insertAuditEvent(db, tenantId, interaction, {
      eventType: 'flow.interaction.completed',
      result: 'success',
      nodeId: current.step.source_node_id,
      branchHandleId: effectiveSelectedHandle,
      userId: resolvedUserId,
    });
  }

  const completedProtocolRedirect = completed
    ? await resolveCompletedProtocolRedirect({
        c,
        db,
        tenantId,
        interaction,
        runtime,
        requestContext,
        resolvedUserId,
      })
    : {};
  if (completedProtocolRedirect.response) {
    return completedProtocolRedirect.response;
  }

  getLogger(c)
    .module('LOGIN-RUNTIME-FLOW')
    .info('Advanced LoginUI runtime Flow interaction', {
      interaction_id: interactionId,
      flow_id: interaction.flow_id,
      flow_version_id: interaction.flow_version_id,
      current_step_id: current.step.id,
      next_step_id: nextStep?.id ?? null,
      completed,
    });

  return c.json({
    schema_version: FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
    interaction: {
      id: interactionId,
      state: nextState,
      flow_id: interaction.flow_id,
      flow_version_id: interaction.flow_version_id,
      current_node_id: nextStep?.source_node_id ?? null,
      current_step_id: nextStep?.id ?? null,
      expires_at: interaction.expires_at,
    },
    step: runtimeStepResponse(nextStep),
    completed,
    output: completed
      ? buildCompletedRuntimeOutput({
          interaction,
          requestContext,
          currentStep: current.step,
          effectiveSelectedHandle,
          redirectUrl: completedProtocolRedirect.redirectUrl,
        })
      : null,
  });
}
