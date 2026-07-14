import type { Context } from 'hono';
import { consumeAuthorizationChallengeContinuation } from './direct-auth';
import {
  FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
  FLOW_RUNTIME_INTERACTION_TTL_SECONDS,
  createAuthContextFromHono,
  createPIIContextFromHono,
  evaluateFlowConditionRows,
  generateId,
  getChallengeStoreByChallengeId,
  getFeatureFlag,
  getLogger,
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  hashIpAddress,
  isShardedSessionId,
  CanonicalRuntimeUserStore,
  type DatabaseAdapter,
  type Env,
  type Challenge,
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
  AUTHRIM_FLOW_RUNTIME_TIMING?: string;
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

interface EmailVerificationChallengeRequest {
  step_id?: string;
  contract_hash?: string;
  signature?: string;
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

interface CachedPreparedRuntimeContract {
  contract: FlowRuntimeContract;
  contractHash: string;
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
  content_mode: 'display_only' | 'checkbox' | 'radio';
  options: RuntimeConsentPolicyOption[];
  attribute_value_display: 'names' | 'masked_values' | 'full_values' | null;
  checkbox_mode: 'none' | 'required' | 'optional';
  checkbox_default_checked: boolean;
  binding_type: string | null;
  binding_value: string | null;
  evidence_profile: string | null;
  language_fallback: string | null;
  display_order: number;
}

interface RuntimeConsentPolicyOption extends FlowRuntimeJsonObject {
  id: string;
  value: string;
  label: string;
  description: string;
}

interface RuntimeConsentPolicyContent extends FlowRuntimeJsonObject {
  id: string;
  display_name: string;
  description: string | null;
  language: string;
  default_language: string;
  items: RuntimeConsentPolicyItem[];
}

interface RuntimeScreenRow {
  id: string;
  screen_key: string;
  display_name: string;
  description: string | null;
  screen_kind: string;
  fields_json: string | null;
  localizations_json: string | null;
  settings_json: string | null;
}

interface RuntimeScreenFieldLocalization {
  label?: string;
  text?: string;
  help_text?: string;
  placeholder?: string;
}

interface RuntimeScreenLocalization {
  display_name?: string;
  description?: string;
  fields?: Record<string, RuntimeScreenFieldLocalization>;
}

const DEFAULT_RUNTIME_SCREEN_KEYS = new Set([
  'login',
  'registration',
  'profile_completion',
  'code_input',
  'consent',
]);

type RuntimeConsentRecordBindingType =
  | 'subject'
  | 'identity_schema'
  | 'destination_field_mapping_set'
  | 'user_decision';

type RuntimeConsentRecordKind =
  | 'terms'
  | 'privacy'
  | 'attribute_release'
  | 'scope_claim_release'
  | 'form_confirmation'
  | 'custom';

type RuntimeConsentRecordResourceType =
  | 'userinfo'
  | 'id_token'
  | 'saml_attributes'
  | 'document'
  | 'custom';

type RuntimeConsentRecordDecision = 'accepted' | 'rejected' | 'once' | 'always' | 'selected';

interface RuntimeConsentItemDecision {
  decision: RuntimeConsentRecordDecision;
  selectedValue: string | null;
}

interface FlowRuntimeTerminalError {
  error: string;
  message?: string;
}

interface RuntimeAutoAdvancedStep {
  step: FlowRuntimeStep;
  selectedHandle: string | null;
  userId?: string | null;
}

interface RuntimeStartTimingSpan {
  name: string;
  durationMs: number;
}

interface RuntimeStartTiming {
  startedAtMs: number;
  spans: RuntimeStartTimingSpan[];
}

interface CachedLoginRuntimeFeatureFlag {
  value: boolean;
  expiresAt: number;
}

const LOGIN_RUNTIME_FEATURE_KEYS = [
  'feature.enable_login_runtime_flow',
  'feature.login_runtime_flow.enabled',
  'feature.flow_runtime.enabled',
];

const STANDARD_FLOW_KINDS = new Set<FlowKind>(['login', 'registration', 'approve', 'account']);
const FLOW_VERSION_CACHE_TTL_SECONDS = 180;
const FLOW_VERSION_CACHE_MAX_ENTRIES = 256;
const EMAIL_VERIFICATION_PROTOCOL_CHALLENGE_TTL_SECONDS = 300;
const LOGIN_RUNTIME_FEATURE_FLAG_CACHE_DEFAULT_TTL_MS = 180_000;
const LOGIN_RUNTIME_FEATURE_FLAG_CACHE_MIN_TTL_MS = 10_000;
const LOGIN_RUNTIME_FEATURE_FLAG_CACHE_MAX_TTL_MS = 600_000;
const flowVersionCache = new Map<string, CachedFlowVersion>();
const preparedRuntimeContractCache = new Map<string, CachedPreparedRuntimeContract>();
const loginRuntimeFeatureFlagCache = new Map<string, CachedLoginRuntimeFeatureFlag>();

export function clearLoginRuntimeFlowVersionCacheForTests(): void {
  flowVersionCache.clear();
  preparedRuntimeContractCache.clear();
  loginRuntimeFeatureFlagCache.clear();
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

function parseJsonObjectArray(value: string | null): FlowRuntimeJsonObject[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is FlowRuntimeJsonObject =>
        Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    );
  } catch {
    return [];
  }
}

function parseRuntimeJsonObject(value: string | null): FlowRuntimeJsonObject {
  return parseJsonObject(value) as FlowRuntimeJsonObject;
}

function screenLocalizationKey(field: FlowRuntimeJsonObject, index: number): string {
  const blockId = readString(field.block_id, 200);
  const fieldName = readString(field.field, 200) ?? 'field';
  return blockId ?? `${fieldName}-${index}`;
}

function selectRuntimeScreenLocalization(
  localizations: FlowRuntimeJsonObject,
  language: string,
  defaultLanguage = 'en'
): RuntimeScreenLocalization | null {
  const candidates = [
    localizations[language],
    localizations[defaultLanguage],
    localizations.en,
    ...Object.values(localizations),
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate as RuntimeScreenLocalization;
    }
  }
  return null;
}

function readRuntimeScreenLocalizedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function applyRuntimeScreenLocalization(
  fields: FlowRuntimeJsonObject[],
  localizations: FlowRuntimeJsonObject,
  language: string,
  defaultLanguage = 'en'
): {
  displayName?: string;
  description?: string;
  fields: FlowRuntimeJsonObject[];
} {
  const localization = selectRuntimeScreenLocalization(localizations, language, defaultLanguage);
  if (!localization) return { fields };
  const fieldLocalizations =
    localization.fields &&
    typeof localization.fields === 'object' &&
    !Array.isArray(localization.fields)
      ? localization.fields
      : {};
  return {
    displayName: readRuntimeScreenLocalizedString(localization.display_name) ?? undefined,
    description: readRuntimeScreenLocalizedString(localization.description) ?? undefined,
    fields: fields.map((field, index) => {
      const fieldLocalization = fieldLocalizations[screenLocalizationKey(field, index)];
      if (!fieldLocalization || typeof fieldLocalization !== 'object') return field;
      const next: FlowRuntimeJsonObject = { ...field };
      const label = readRuntimeScreenLocalizedString(fieldLocalization.label);
      const text = readRuntimeScreenLocalizedString(fieldLocalization.text);
      const helpText = readRuntimeScreenLocalizedString(fieldLocalization.help_text);
      const placeholder = readRuntimeScreenLocalizedString(fieldLocalization.placeholder);
      if (label) next.label = label;
      if (text) next.text = text;
      if (helpText) next.help_text = helpText;
      if (placeholder) next.placeholder = placeholder;
      return next;
    }),
  };
}

function applyRuntimeScreenDefaultMetadata(
  screenKey: string,
  fields: FlowRuntimeJsonObject[]
): FlowRuntimeJsonObject[] {
  if (screenKey !== 'login') return fields;
  return fields.map((field) => {
    const fieldName = readString(field.field, 200);
    const blockType = readString(field.block_type, 80);
    if (blockType !== 'divider' || field.display_condition) return field;
    if (fieldName === 'divider.or') {
      return {
        ...field,
        display_condition: { mode: 'feature_enabled', feature: 'mail_otp' },
      };
    }
    if (fieldName === 'divider.other_accounts') {
      return {
        ...field,
        display_condition: { mode: 'feature_enabled', feature: 'external_idp' },
      };
    }
    if (fieldName === 'divider.directory_password') {
      return {
        ...field,
        display_condition: { mode: 'feature_enabled', feature: 'directory_password' },
      };
    }
    return field;
  });
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

function isRuntimeStartTimingEnabled(env: FlowRuntimeEnv): boolean {
  const value = env.AUTHRIM_FLOW_RUNTIME_TIMING?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function runtimeStartTimingNowMs(): number {
  return Date.now();
}

function roundRuntimeStartDurationMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function createRuntimeStartTiming(env: FlowRuntimeEnv): RuntimeStartTiming | null {
  if (!isRuntimeStartTimingEnabled(env)) {
    return null;
  }
  return {
    startedAtMs: runtimeStartTimingNowMs(),
    spans: [],
  };
}

async function timeRuntimeStartSpan<T>(
  timing: RuntimeStartTiming | null,
  name: string,
  operation: () => Promise<T>
): Promise<T> {
  if (!timing) {
    return operation();
  }
  const startedAtMs = runtimeStartTimingNowMs();
  try {
    return await operation();
  } finally {
    timing.spans.push({
      name,
      durationMs: roundRuntimeStartDurationMs(runtimeStartTimingNowMs() - startedAtMs),
    });
  }
}

function timeRuntimeStartValue<T>(
  timing: RuntimeStartTiming | null,
  name: string,
  operation: () => T
): T {
  if (!timing) {
    return operation();
  }
  const startedAtMs = runtimeStartTimingNowMs();
  try {
    return operation();
  } finally {
    timing.spans.push({
      name,
      durationMs: roundRuntimeStartDurationMs(runtimeStartTimingNowMs() - startedAtMs),
    });
  }
}

function writeRuntimeStartTiming(
  c: AuthContext,
  timing: RuntimeStartTiming | null,
  metadata: {
    result: 'success' | 'disabled' | 'resume' | 'error';
    flowKind?: FlowKind;
    targetType?: FlowAssignmentTargetType;
    currentStepId?: string | null;
    autoAdvancedSteps?: number;
    error?: string;
  }
): void {
  if (!timing) {
    return;
  }

  const totalMs = roundRuntimeStartDurationMs(runtimeStartTimingNowMs() - timing.startedAtMs);
  const allSpans = [...timing.spans, { name: 'total', durationMs: totalMs }];
  c.header(
    'Server-Timing',
    allSpans.map((span) => `${span.name};dur=${span.durationMs.toFixed(1)}`).join(', ')
  );
  getLogger(c)
    .module('LOGIN-RUNTIME-FLOW-TIMING')
    .info('LoginUI runtime Flow start timing', {
      result: metadata.result,
      flow_kind: metadata.flowKind,
      target_type: metadata.targetType,
      current_step_id: metadata.currentStepId,
      auto_advanced_steps: metadata.autoAdvancedSteps,
      error: metadata.error,
      total_ms: totalMs,
      spans_ms: Object.fromEntries(allSpans.map((span) => [span.name, span.durationMs])),
    });
}

function getLoginRuntimeFeatureFlagCacheKey(env: Env, tenantId: string): string {
  const envRecord = env as unknown as Record<string, string | undefined>;
  const environment =
    env.ENVIRONMENT ?? env.NODE_ENV ?? envRecord.BASE_DOMAIN ?? envRecord.ISSUER_URL ?? 'default';
  return `${environment}:tenant:${tenantId}`;
}

function getLoginRuntimeFeatureFlagCacheTtlMs(env: Env): number {
  const envRecord = env as unknown as Record<string, string | undefined>;
  const ttlSeconds = Number.parseInt(
    envRecord.FEATURE_FLAGS_CACHE_TTL ?? env.CONFIG_CACHE_TTL ?? '',
    10
  );
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return LOGIN_RUNTIME_FEATURE_FLAG_CACHE_DEFAULT_TTL_MS;
  }
  return Math.min(
    LOGIN_RUNTIME_FEATURE_FLAG_CACHE_MAX_TTL_MS,
    Math.max(LOGIN_RUNTIME_FEATURE_FLAG_CACHE_MIN_TTL_MS, ttlSeconds * 1000)
  );
}

function readLoginRuntimeFlagFromSettings(settings: Record<string, unknown> | null): true | null {
  if (!settings || typeof settings !== 'object') return null;
  for (const key of LOGIN_RUNTIME_FEATURE_KEYS) {
    if (settings[key] === true || settings[key] === 'true' || settings[key] === '1') return true;
  }
  return null;
}

async function isLoginRuntimeFlowEnabled(env: Env, tenantId: string): Promise<boolean> {
  const cacheKey = getLoginRuntimeFeatureFlagCacheKey(env, tenantId);
  const cached = loginRuntimeFeatureFlagCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const ttlMs = getLoginRuntimeFeatureFlagCacheTtlMs(env);
  const cacheValue = (value: boolean): boolean => {
    loginRuntimeFeatureFlagCache.set(cacheKey, {
      value,
      expiresAt: now + ttlMs,
    });
    return value;
  };

  if (env.AUTHRIM_CONFIG) {
    try {
      const settingsJson = await env.AUTHRIM_CONFIG.get(
        `settings:tenant:${tenantId}:feature-flags`
      );
      const settings = settingsJson ? (JSON.parse(settingsJson) as Record<string, unknown>) : null;
      const settingValue = readLoginRuntimeFlagFromSettings(settings);
      if (settingValue !== null) {
        return cacheValue(settingValue);
      }
    } catch {
      // Fall through to environment flags.
    }
  }
  return cacheValue(await getFeatureFlag('ENABLE_LOGIN_RUNTIME_FLOW', env, false));
}

function normalizeFlowKind(value: unknown): FlowKind | null {
  if (typeof value === 'string' && STANDARD_FLOW_KINDS.has(value as FlowKind)) {
    return value as FlowKind;
  }
  if (typeof value === 'string' && value.startsWith('custom:')) {
    return value as FlowKind;
  }
  return value === undefined || value === null ? 'login' : null;
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

function getPreparedRuntimeContractCacheKey(
  tenantId: string,
  assignment: FlowAssignmentRow,
  version: FlowVersionRow,
  requestContext: FlowRequestContext
): string {
  return JSON.stringify([
    tenantId,
    assignment.flow_id,
    version.id,
    assignment.flow_kind,
    assignment.target_type,
    assignment.target_id,
    requestContext.protocol,
    requestContext.target_type,
    requestContext.target_id,
    requestContext.client_id,
    requestContext.saml_sp_id,
    requestContext.authorization_challenge_id,
    requestContext.saml_request_id,
    requestContext.saml_sp_entity_id,
    requestContext.return_to,
    requestContext.locale,
    requestContext.requested_scope,
  ]);
}

function rememberPreparedRuntimeContract(
  cacheKey: string,
  contract: FlowRuntimeContract,
  contractHash: string,
  now: number
): void {
  preparedRuntimeContractCache.set(cacheKey, {
    contract,
    contractHash,
    expiresAt: now + FLOW_VERSION_CACHE_TTL_SECONDS,
  });
  if (preparedRuntimeContractCache.size > FLOW_VERSION_CACHE_MAX_ENTRIES) {
    const firstKey = preparedRuntimeContractCache.keys().next().value;
    if (firstKey) preparedRuntimeContractCache.delete(firstKey);
  }
}

async function prepareRuntimeContract(input: {
  c: AuthContext;
  db: DatabaseAdapter;
  tenantId: string;
  assignment: FlowAssignmentRow;
  version: FlowVersionRow;
  runtimeSnapshot: FlowRuntimeContract;
  requestContext: FlowRequestContext;
}): Promise<{ contract: FlowRuntimeContract; contractHash: string }> {
  const cacheKey = getPreparedRuntimeContractCacheKey(
    input.tenantId,
    input.assignment,
    input.version,
    input.requestContext
  );
  const now = nowSeconds();
  const cached = preparedRuntimeContractCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { contract: cached.contract, contractHash: cached.contractHash };
  }

  const contract = await hydrateRuntimeContract(
    input.c,
    input.db,
    input.tenantId,
    normalizeRuntime(input.runtimeSnapshot, input.assignment, input.version, input.requestContext),
    input.requestContext
  );
  const contractHash = await sha256Base64Url(JSON.stringify(contract));
  rememberPreparedRuntimeContract(cacheKey, contract, contractHash, now);
  return { contract, contractHash };
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

function readLocalizedRuntimeString(
  value: unknown,
  language: string,
  defaultLanguage = 'en'
): string {
  if (typeof value === 'string') return value;
  const record = parseJsonRecord(value);
  const preferred = record[language] ?? record[defaultLanguage] ?? record.en;
  return typeof preferred === 'string' ? preferred : '';
}

function normalizeRuntimeConsentContentMode(
  value: unknown,
  category: string,
  checkboxMode: string
): RuntimeConsentPolicyItem['content_mode'] {
  if (value === 'display_only' || value === 'checkbox' || value === 'radio') return value;
  if (category === 'saml_attribute_release_confirmation') return 'radio';
  return checkboxMode === 'required' || checkboxMode === 'optional' ? 'checkbox' : 'display_only';
}

function normalizeRuntimeAttributeValueDisplay(
  value: unknown,
  category: string
): RuntimeConsentPolicyItem['attribute_value_display'] {
  if (value === 'names' || value === 'masked_values' || value === 'full_values') return value;
  return category === 'saml_attribute_release_confirmation' ? 'masked_values' : null;
}

function defaultRuntimeConsentOptions(
  category: string,
  language: string
): RuntimeConsentPolicyOption[] {
  if (category !== 'saml_attribute_release_confirmation') return [];
  const ja = language === 'ja';
  return [
    {
      id: 'option-1',
      value: 'once',
      label: ja ? '今回のみ同意' : 'Allow this time only',
      description: ja
        ? '今回のログインに限って属性送信を許可します。'
        : 'Allow this attribute release only for the current sign-in.',
    },
    {
      id: 'option-2',
      value: 'always',
      label: ja ? '今後も同意' : 'Always allow for this service',
      description: ja
        ? 'このサービスへの今後のログインでも、この選択を利用します。'
        : 'Remember this choice for future sign-ins to this service.',
    },
  ];
}

function normalizeRuntimeConsentOptions(
  value: unknown,
  category: string,
  language: string,
  defaultLanguage: string
): RuntimeConsentPolicyOption[] {
  if (!Array.isArray(value)) return defaultRuntimeConsentOptions(category, language);
  const options = value
    .map((raw, index) => {
      const record = parseJsonRecord(raw);
      const selectedValue = readString(record.value, 128) ?? `option-${index + 1}`;
      const label =
        readLocalizedRuntimeString(record.labels, language, defaultLanguage) ||
        readLocalizedRuntimeString(record.label, language, defaultLanguage) ||
        selectedValue;
      const description =
        readLocalizedRuntimeString(record.descriptions, language, defaultLanguage) ||
        readLocalizedRuntimeString(record.description, language, defaultLanguage);
      return {
        id: readString(record.id, 128) ?? `option-${index + 1}`,
        value: selectedValue,
        label,
        description,
      };
    })
    .filter((option) => option.value);
  return options.length > 0 ? options : defaultRuntimeConsentOptions(category, language);
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

function getRuntimeRequestHost(c: AuthContext): string | null {
  const candidates = [
    getRequestHeader(c, 'Host'),
    getRequestHeader(c, 'X-Authrim-Forwarded-Host'),
    getRequestHeader(c, 'X-Forwarded-Host'),
  ];

  for (const candidate of candidates) {
    const value = candidate?.split(',')[0]?.trim();
    if (value) return value;
  }

  try {
    return new URL(c.req.url).host;
  } catch {
    return null;
  }
}

function getRuntimeForwardedProto(c: AuthContext): string {
  const headerValue = getRequestHeader(c, 'X-Forwarded-Proto')?.split(',')[0]?.trim();
  if (headerValue === 'http' || headerValue === 'https') {
    return headerValue;
  }

  try {
    const protocol = new URL(c.req.url).protocol.replace(':', '');
    return protocol === 'http' || protocol === 'https' ? protocol : 'https';
  } catch {
    return 'https';
  }
}

function buildRuntimeExternalIdpHeaders(c: AuthContext, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Tenant-Id': tenantId,
  };
  const forwardedHost = getRuntimeRequestHost(c);
  if (forwardedHost) {
    headers['X-Authrim-Forwarded-Host'] = forwardedHost;
    headers['X-Forwarded-Host'] = forwardedHost;
    headers['X-Forwarded-Proto'] = getRuntimeForwardedProto(c);
  }
  return headers;
}

function indexExternalProviderUsage(
  providerUsage: Array<Record<string, unknown>>
): Map<string, Record<string, unknown>> {
  const indexed = new Map<string, Record<string, unknown>>();
  for (const provider of providerUsage) {
    const providerId = readString(provider.id, 200) ?? readString(provider.providerId, 200);
    if (!providerId) continue;
    indexed.set(providerId, provider);
    indexed.set(normalizeOutputHandle(providerId), provider);
  }
  return indexed;
}

function externalProviderUsageEnabled(
  provider: Record<string, unknown>,
  usage: 'login' | 'signup'
): boolean {
  const providerEnabled = readBooleanSetting(provider, 'enabled', true);
  const usageEnabled = readBooleanSetting(provider, `${usage}Enabled`, providerEnabled);
  return providerEnabled && usageEnabled;
}

function getExternalProviderUsageOverride(
  usageById: Map<string, Record<string, unknown>>,
  providerId: string,
  slug: string | null
): Record<string, unknown> | undefined {
  return (
    usageById.get(providerId) ??
    usageById.get(normalizeOutputHandle(providerId)) ??
    (slug ? usageById.get(slug) : undefined) ??
    (slug ? usageById.get(normalizeOutputHandle(slug)) : undefined)
  );
}

async function fetchRuntimeExternalProviderHandles(
  c: AuthContext,
  tenantId: string,
  usage: 'login' | 'signup',
  usageById: Map<string, Record<string, unknown>>
): Promise<string[]> {
  if (!c.env.EXTERNAL_IDP) return [];

  try {
    const response = await c.env.EXTERNAL_IDP.fetch('https://external-idp/api/external/providers', {
      method: 'GET',
      headers: buildRuntimeExternalIdpHeaders(c, tenantId),
    });
    if (!response.ok) return [];

    const data = (await response.json()) as {
      providers?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(data.providers)) return [];

    const handles: string[] = [];
    for (const provider of data.providers) {
      if (provider.enabled === false) continue;
      const providerId = readString(provider.id, 200);
      const slug = readString(provider.slug, 200);
      const outputId = slug ?? providerId;
      if (!outputId) continue;

      const usageOverride = getExternalProviderUsageOverride(
        usageById,
        providerId ?? outputId,
        slug
      );
      if (usageOverride && !externalProviderUsageEnabled(usageOverride, usage)) continue;
      handles.push(normalizeOutputHandle(outputId));
    }
    return handles;
  } catch {
    return [];
  }
}

async function resolveRuntimeAuthenticationHandles(
  c: AuthContext,
  tenantId: string,
  flowKind: FlowKind,
  component: string
): Promise<string[]> {
  const env = c.env;
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
  const legacyTotpEnabled = readBooleanSetting(
    settings,
    'authentication-methods.totp.enabled',
    false
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
    readBooleanSetting(settings, `authentication-methods.totp.${usage}_enabled`, legacyTotpEnabled)
  ) {
    handles.push('totp');
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
  const usageById = indexExternalProviderUsage(providerUsage);
  for (const provider of providerUsage) {
    const providerId = readString(provider.id, 200);
    if (!providerId) continue;
    if (externalProviderUsageEnabled(provider, usage)) {
      handles.push(normalizeOutputHandle(providerId));
    }
  }
  handles.push(...(await fetchRuntimeExternalProviderHandles(c, tenantId, usage, usageById)));

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
    conditional_rules_json: string | null;
  }>(
    `SELECT i.statement_id, i.requirement, i.version_mode, i.version_id,
            i.checkbox_mode, i.checkbox_default_checked, i.binding_type, i.binding_value,
            i.evidence_profile, i.language_fallback, i.display_order,
            s.slug, s.category, r.conditional_rules_json
       FROM consent_policy_items i
       JOIN consent_statements s ON s.id = i.statement_id AND s.tenant_id = i.tenant_id
       LEFT JOIN tenant_consent_requirements r
         ON r.statement_id = i.statement_id AND r.tenant_id = i.tenant_id
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
    const statementRules = parseJsonRecord(row.conditional_rules_json);
    const contentMode = normalizeRuntimeConsentContentMode(
      statementRules.content_mode,
      row.category,
      row.checkbox_mode
    );
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
      content_mode: contentMode,
      options:
        contentMode === 'radio' || contentMode === 'checkbox'
          ? normalizeRuntimeConsentOptions(
              statementRules.content_options,
              row.category,
              language,
              'en'
            )
          : [],
      attribute_value_display: normalizeRuntimeAttributeValueDisplay(
        statementRules.attribute_value_display,
        row.category
      ),
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

async function resolveRuntimeScreenContent(
  db: DatabaseAdapter,
  tenantId: string,
  screenRef: string | null,
  component: string | undefined,
  requestContext: FlowRequestContext
): Promise<FlowRuntimeJsonObject | null> {
  if (!screenRef) return null;
  const queryScreen = (scopeTenantId: string, ref: string, systemOnly = false) =>
    db.queryOne<RuntimeScreenRow>(
      `SELECT id, screen_key, display_name, description, screen_kind, fields_json,
            localizations_json, settings_json
       FROM screens
      WHERE tenant_id = ?
        AND is_active = 1
        ${systemOnly ? 'AND is_system = 1' : ''}
        AND (id = ? OR screen_key = ?)
      LIMIT 1`,
      [scopeTenantId, ref, ref]
    );
  const fallbackScreenRef =
    screenRef === 'basic_profile' ? defaultScreenKeyForRuntimeComponent(component) : screenRef;
  const row =
    (await queryScreen(tenantId, screenRef)) ??
    (screenRef === 'basic_profile' ? await queryScreen(tenantId, fallbackScreenRef) : null) ??
    (DEFAULT_RUNTIME_SCREEN_KEYS.has(fallbackScreenRef)
      ? await queryScreen('default', fallbackScreenRef, true)
      : null);
  if (!row) return null;
  const fields = applyRuntimeScreenDefaultMetadata(
    row.screen_key,
    parseJsonObjectArray(row.fields_json)
  );
  const localizations = parseRuntimeJsonObject(row.localizations_json);
  const localized = applyRuntimeScreenLocalization(
    fields,
    localizations,
    requestedLanguage(requestContext),
    'en'
  );
  return {
    id: row.id,
    screen_key: row.screen_key,
    display_name: localized.displayName ?? row.display_name,
    description: localized.description ?? row.description,
    screen_kind: row.screen_kind,
    fields: localized.fields,
    localizations,
    settings: parseRuntimeJsonObject(row.settings_json),
  };
}

function defaultScreenKeyForRuntimeComponent(component?: string): string {
  if (component === 'registration_method_selector') return 'registration';
  if (component === 'authentication_method_selector') return 'login';
  if (component === 'email_verification') return 'code_input';
  if (component === 'screen') return 'profile_completion';
  if (component === 'consent_policy') return 'consent';
  return 'profile_completion';
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
      const nextConfig: FlowRuntimeJsonObject = { ...(config as FlowRuntimeJsonObject) };
      const nextContent: FlowRuntimeJsonObject = { ...(content as FlowRuntimeJsonObject) };

      if (
        step.component === 'authentication_method_selector' ||
        step.component === 'registration_method_selector'
      ) {
        const handles = await resolveRuntimeAuthenticationHandles(
          c,
          tenantId,
          runtime.flow_kind,
          step.component
        );
        nextConfig.output_handles = handles;
        nextContent.authentication_profile = {
          id: readString(config.authentication_profile_ref, 200) ?? 'default',
          output_handles: handles,
        };
      }

      const screenRef = readString(config.screen_ref, 200);
      if (screenRef) {
        const screen = await resolveRuntimeScreenContent(
          db,
          tenantId,
          screenRef,
          step.component,
          requestContext
        );
        nextConfig.screen = screen;
      }

      const policyId = readString(config.consent_policy_ref, 200);
      if (policyId) {
        const policy = policyId
          ? await resolveRuntimeConsentPolicyContent(db, tenantId, policyId, requestContext)
          : null;
        nextContent.consent_policy = policy;
      }

      return {
        ...step,
        config: nextConfig,
        content: nextContent,
      };
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

async function validateRuntimeAuthorizationChallengeBinding(
  c: AuthContext,
  tenantId: string,
  target: ResolvedTarget,
  requestContext: FlowRequestContext
): Promise<Response | null> {
  const challengeId = requestContext.authorization_challenge_id;
  if (!challengeId) return null;

  if (requestContext.protocol !== 'oidc' || !target.clientId) {
    return jsonError(
      c,
      400,
      'invalid_authorization_challenge',
      'Authorization challenge can only be used with an OIDC client Flow target',
      'AR_FLOW_AUTH_CHALLENGE_INVALID'
    );
  }

  let challenge: Challenge | null = null;
  try {
    const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId, tenantId);
    challenge = (await challengeStore.getChallengeRpc(challengeId)) as Challenge | null;
  } catch {
    challenge = null;
  }

  if (
    !challenge ||
    challenge.tenantId !== tenantId ||
    challenge.consumed ||
    (challenge.type !== 'login' && challenge.type !== 'reauth')
  ) {
    return jsonError(
      c,
      400,
      'invalid_authorization_challenge',
      'Authorization challenge is invalid or expired',
      'AR_FLOW_AUTH_CHALLENGE_INVALID'
    );
  }

  const challengeClientId = readOptionalString(challenge.metadata?.client_id, 200);
  if (!challengeClientId || challengeClientId !== target.clientId) {
    return jsonError(
      c,
      403,
      'authorization_challenge_mismatch',
      'Authorization challenge does not match the requested client',
      'AR_FLOW_AUTH_CHALLENGE_MISMATCH'
    );
  }

  return null;
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

function getFirstStep(runtime: FlowRuntimeContract): FlowRuntimeStep | null {
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
  return readString(env.FLOW_RUNTIME_HMAC_SECRET, 2048);
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

function findRuntimeStepBySourceNode(
  runtime: FlowRuntimeContract,
  sourceNodeId: string
): FlowRuntimeStep | null {
  return runtime.ui.steps.find((step) => step.source_node_id === sourceNodeId) ?? null;
}

function stepMatchesRequestProtocol(
  step: FlowRuntimeStep | null,
  requestContext: FlowRequestContext | null
): boolean {
  if (!step || !requestContext) return true;
  const completionBlock = readRuntimeCompletionBlock(step);
  const protocol = typeof completionBlock?.protocol === 'string' ? completionBlock.protocol : null;
  return !protocol || protocol === requestContext.protocol;
}

function selectProtocolCompatibleEdge<T extends { target: string }>(
  runtime: FlowRuntimeContract,
  edges: T[],
  requestContext: FlowRequestContext | null
): T | null {
  if (edges.length === 0) return null;
  if (edges.length === 1) return edges[0];

  return (
    edges.find((edge) =>
      stepMatchesRequestProtocol(findRuntimeStepBySourceNode(runtime, edge.target), requestContext)
    ) ?? edges[0]
  );
}

function resolveNextStep(
  runtime: FlowRuntimeContract,
  currentIndex: number,
  editor: FlowEditorState | null,
  selectedHandle: string | null,
  requestContext: FlowRequestContext | null = null
): { step: FlowRuntimeStep | null; errorCode?: string } {
  const currentStep = runtime.ui.steps[currentIndex];
  if (currentStep && editor) {
    const outgoingEdges = editor.edges.filter((edge) => edge.source === currentStep.source_node_id);
    if (outgoingEdges.length > 0) {
      const selectedEdges = selectedHandle
        ? outgoingEdges.filter((edge) => edge.source_handle === selectedHandle)
        : [];
      const selectedEdge = selectProtocolCompatibleEdge(runtime, selectedEdges, requestContext);
      if (selectedHandle && !selectedEdge) {
        return { step: null, errorCode: 'AR_FLOW_INVALID_SELECTED_HANDLE' };
      }

      const defaultEdges = outgoingEdges.filter(
        (edge) => !edge.source_handle || edge.source_handle === 'next'
      );
      const defaultEdge =
        selectProtocolCompatibleEdge(runtime, defaultEdges, requestContext) ??
        (outgoingEdges.length === 1 ? outgoingEdges[0] : null);
      if (!selectedHandle && !defaultEdge) {
        return { step: null, errorCode: 'AR_FLOW_SELECTED_HANDLE_REQUIRED' };
      }

      const nextEdge = selectedEdge ?? defaultEdge;
      const nextByEdge = nextEdge ? findRuntimeStepBySourceNode(runtime, nextEdge.target) : null;
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

function getRuntimeStepIndex(runtime: FlowRuntimeContract, step: FlowRuntimeStep): number {
  return runtime.ui.steps.findIndex(
    (candidate) => candidate.id === step.id && candidate.source_node_id === step.source_node_id
  );
}

function readRuntimeConsentPolicyContent(
  step: FlowRuntimeStep
): RuntimeConsentPolicyContent | null {
  const content = parseJsonRecord(step.content);
  const policy = parseJsonRecord(content.consent_policy);
  const id = readString(policy.id, 200);
  if (!id || !Array.isArray(policy.items)) return null;
  return policy as RuntimeConsentPolicyContent;
}

function withRuntimeConsentPolicyContent(
  step: FlowRuntimeStep,
  policy: RuntimeConsentPolicyContent
): FlowRuntimeStep {
  const content = parseJsonRecord(step.content);
  return {
    ...step,
    content: {
      ...content,
      consent_policy: policy,
    },
  };
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

async function resolveSessionCheckSelectedHandle(
  c: AuthContext,
  tenantId: string
): Promise<{ selectedHandle: 'continue' | 'authenticate'; userId: string | null }> {
  const session = await getCurrentSession(c, tenantId);
  return {
    selectedHandle: session?.userId ? 'continue' : 'authenticate',
    userId: session?.userId ?? null,
  };
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

function isImplicitAccountActionStep(step: FlowRuntimeStep): boolean {
  if (step.component !== 'account_action') return false;
  const config = parseJsonRecord(step.config);
  return (
    config.interaction_ui !== true &&
    config.render_ui !== true &&
    typeof config.screen_ref !== 'string'
  );
}

function autoAdvanceHandleForStep(step: FlowRuntimeStep): string | null {
  if (isImplicitAccountActionStep(step)) {
    return 'completed';
  }
  return null;
}

async function resolveAutoAdvanceForStep(input: {
  c: AuthContext;
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  runtime: FlowRuntimeContract;
  step: FlowRuntimeStep;
}): Promise<{
  selectedHandle: string | null;
  userId?: string | null;
  terminalError?: FlowRuntimeTerminalError;
  errorCode?: string;
} | null> {
  if (input.step.component === 'condition') {
    return resolveConditionSelectedHandle({
      db: input.db,
      tenantId: input.tenantId,
      interaction: input.interaction,
      runtime: input.runtime,
      step: input.step,
    });
  }

  if (input.step.component === 'session_check') {
    return resolveSessionCheckSelectedHandle(input.c, input.tenantId);
  }

  const selectedHandle = autoAdvanceHandleForStep(input.step);
  if (selectedHandle) {
    return { selectedHandle };
  }

  if (input.step.render === false && input.step.component !== 'email_verification') {
    return { selectedHandle: null };
  }

  return null;
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
  const requestOrigin = (() => {
    if (!url) return 'https://authrim.local';
    try {
      return new URL(url).origin;
    } catch {
      return 'https://authrim.local';
    }
  })();

  if (getRequestHeader(c, 'x-authrim-ui-proxy') === 'login-ui') {
    const browserOrigin = getRequestHeader(c, 'x-authrim-browser-origin');
    const forwardedOrigin = getRequestHeader(c, 'origin');
    if (browserOrigin && forwardedOrigin) {
      try {
        const normalizedForwardedOrigin = new URL(forwardedOrigin).origin;
        const forwardedHost =
          getRequestHeader(c, 'x-authrim-forwarded-host')?.split(',')[0]?.trim() ?? '';
        const trustedOrigins = new Set([requestOrigin]);
        if (forwardedHost) {
          trustedOrigins.add(`https://${forwardedHost}`);
          trustedOrigins.add(`http://${forwardedHost}`);
        }
        if (trustedOrigins.has(normalizedForwardedOrigin)) {
          return new URL(browserOrigin).origin;
        }
      } catch {
        // Fall through to the upstream request origin.
      }
    }
  }

  const browserOrigin = getRequestHeader(c, 'origin');
  if (browserOrigin) {
    try {
      return new URL(browserOrigin).origin;
    } catch {
      // Fall through to the request URL origin.
    }
  }

  return requestOrigin;
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

interface RuntimeAuditEventInput {
  id?: string;
  eventType: string;
  result: string;
  nodeId?: string | null;
  branchHandleId?: string | null;
  errorCode?: string | null;
  metadata?: Record<string, unknown>;
  userId?: string | null;
}

async function insertAuditEvent(
  db: DatabaseAdapter,
  tenantId: string,
  interaction: FlowInteractionRow,
  input: RuntimeAuditEventInput
) {
  await db.execute(
    `INSERT INTO flow_audit_events (
      id, tenant_id, interaction_id, flow_id, flow_version_id, user_id, client_id, saml_sp_id,
      node_id, branch_handle_id, event_type, result, error_code, contract_hash, metadata_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id ?? generateId(),
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

function asRuntimeFlowError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function scheduleRuntimeAuditEvents(
  c: AuthContext,
  db: DatabaseAdapter,
  tenantId: string,
  interaction: FlowInteractionRow,
  events: RuntimeAuditEventInput[],
  label: string
): Promise<void> | undefined {
  if (events.length === 0) return undefined;

  const auditPromise = (async () => {
    for (const event of events) {
      await insertAuditEvent(db, tenantId, interaction, event);
    }
  })().catch((error: unknown) => {
    getLogger(c).module('LOGIN-RUNTIME-FLOW').error(
      'Failed to write LoginUI runtime Flow audit events',
      {
        action: 'flow_runtime_audit',
        audit_batch: label,
        interaction_id: interaction.id,
      },
      asRuntimeFlowError(error)
    );
  });

  if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
    c.executionCtx.waitUntil(auditPromise);
    return undefined;
  }

  return auditPromise;
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

async function getRecentVerifiedEmailSessionUserId(
  c: AuthContext,
  tenantId: string,
  notBefore: number,
  interactionId: string
): Promise<string | null> {
  const session = await getCurrentSession(c, tenantId);
  if (!session) return null;

  const rawAmr = session.data?.amr;
  const amr = Array.isArray(rawAmr)
    ? rawAmr.filter((value): value is string => typeof value === 'string')
    : [];
  if (!amr.includes('email_code') && !amr.includes('email_verification_protocol')) {
    return null;
  }
  if (session.data?.runtime_interaction_id !== interactionId) {
    return null;
  }

  const authTime = getSessionAuthTime(session);
  const now = nowSeconds();
  if (authTime < notBefore || authTime > now + 60) {
    return null;
  }

  const authCtx = createAuthContextFromHono(c, tenantId);
  const piiCtx = createPIIContextFromHono(c, tenantId);
  const runtimeUsers = new CanonicalRuntimeUserStore({
    coreAdapter: authCtx.coreAdapter,
    piiAdapter: piiCtx.defaultPiiAdapter,
    tenantId,
  });
  const user = await runtimeUsers.findById(session.userId, { includeInactive: true });
  if (!user || user.active !== 1 || user.email_verified !== 1 || !user.email) {
    return null;
  }

  return user.id;
}

function readConsentDecisionMap(input: unknown): Record<string, 'granted' | 'denied' | 'selected'> {
  const inputRecord = parseJsonRecord(input);
  const raw = parseJsonRecord(inputRecord.consent_item_decisions ?? inputRecord.decisions);
  const decisions: Record<string, 'granted' | 'denied' | 'selected'> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === 'granted' || value === 'denied' || value === 'selected') {
      decisions[key] = value;
    }
  }
  return decisions;
}

function readConsentSelectedValueMap(input: unknown): Record<string, string> {
  const inputRecord = parseJsonRecord(input);
  const raw = parseJsonRecord(
    inputRecord.consent_item_selected_values ?? inputRecord.selected_values
  );
  const selectedValues: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const selectedValue = readString(value, 256);
    if (selectedValue) {
      selectedValues[key] = selectedValue;
    }
  }
  return selectedValues;
}

function consentOptionValueSet(item: RuntimeConsentPolicyItem): Set<string> {
  return new Set(item.options.map((option) => option.value));
}

function consentItemDecision(input: {
  item: RuntimeConsentPolicyItem;
  submittedDecision: 'granted' | 'denied' | 'selected' | undefined;
  submittedSelectedValue: string | undefined;
}): RuntimeConsentItemDecision {
  const { item, submittedDecision, submittedSelectedValue } = input;
  if (item.content_mode === 'radio') {
    const allowedValues = consentOptionValueSet(item);
    const selectedValue =
      submittedSelectedValue && allowedValues.has(submittedSelectedValue)
        ? submittedSelectedValue
        : null;
    if (!selectedValue) return { decision: 'rejected', selectedValue: null };
    if (selectedValue === 'once') return { decision: 'once', selectedValue };
    if (selectedValue === 'always') return { decision: 'always', selectedValue };
    if (
      selectedValue === 'none' ||
      selectedValue === 'false' ||
      selectedValue === 'deny' ||
      selectedValue === 'denied' ||
      selectedValue === 'rejected'
    ) {
      return { decision: 'rejected', selectedValue };
    }
    return { decision: submittedDecision === 'denied' ? 'rejected' : 'selected', selectedValue };
  }

  if (item.checkbox_mode === 'none') return { decision: 'accepted', selectedValue: null };
  return {
    decision: submittedDecision === 'granted' ? 'accepted' : 'rejected',
    selectedValue: null,
  };
}

function consentItemInputSatisfied(
  item: RuntimeConsentPolicyItem,
  decision: RuntimeConsentItemDecision
): boolean {
  if (!item.is_required) return true;
  if (item.content_mode === 'radio') return Boolean(decision.selectedValue);
  return decision.decision !== 'rejected';
}

function normalizeConsentRecordKind(category: string): RuntimeConsentRecordKind {
  const normalized = category.trim().toLowerCase();
  if (
    normalized === 'terms' ||
    normalized === 'terms_of_service' ||
    normalized === 'service_terms'
  ) {
    return 'terms';
  }
  if (normalized === 'privacy' || normalized === 'privacy_policy') return 'privacy';
  if (
    normalized === 'attribute_release' ||
    normalized === 'saml_attribute_release' ||
    normalized === 'saml_attribute_release_confirmation'
  ) {
    return 'attribute_release';
  }
  if (
    normalized === 'scope_claim_release' ||
    normalized === 'oidc_scope_claim_release' ||
    normalized === 'data_release'
  ) {
    return 'scope_claim_release';
  }
  if (normalized === 'form_confirmation' || normalized === 'screen') {
    return 'form_confirmation';
  }
  return 'custom';
}

function normalizeConsentRecordBindingType(
  bindingType: string | null,
  requestContext: FlowRequestContext
): RuntimeConsentRecordBindingType {
  const normalized = bindingType?.trim().toLowerCase() ?? '';
  if (
    normalized === 'identity_schema' ||
    normalized === 'claim' ||
    normalized === 'saml_attribute'
  ) {
    return 'identity_schema';
  }
  if (
    normalized === 'destination_field_mapping_set' ||
    normalized === 'destination_field_set' ||
    normalized === 'field_mapping_set'
  ) {
    return 'destination_field_mapping_set';
  }
  if (normalized === 'user_decision' || normalized === 'scope') return 'user_decision';
  if (requestContext.protocol === 'saml') return 'user_decision';
  return 'subject';
}

function consentRecordResourceType(
  item: RuntimeConsentPolicyItem,
  requestContext: FlowRequestContext
): RuntimeConsentRecordResourceType {
  const kind = normalizeConsentRecordKind(item.category);
  if (kind === 'terms' || kind === 'privacy') return 'document';
  if (requestContext.protocol === 'saml') return 'saml_attributes';
  if (kind === 'scope_claim_release') return 'userinfo';
  return 'custom';
}

function consentRecordRecipient(input: {
  interaction: FlowInteractionRow;
  requestContext: FlowRequestContext;
}): { recipientType: 'oidc_client' | 'saml_sp' | 'tenant'; recipientId: string | null } {
  const recipientType =
    input.requestContext.protocol === 'saml'
      ? 'saml_sp'
      : input.requestContext.protocol === 'oidc'
        ? 'oidc_client'
        : 'tenant';
  const recipientId =
    input.interaction.saml_sp_id ?? input.interaction.client_id ?? input.requestContext.target_id;
  return { recipientType, recipientId };
}

async function hasActiveAcceptedConsentRecord(input: {
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  requestContext: FlowRequestContext;
  userId: string;
  policyId: string;
  item: RuntimeConsentPolicyItem;
}): Promise<boolean> {
  const { recipientType, recipientId } = consentRecordRecipient(input);
  const bindingType = normalizeConsentRecordBindingType(
    input.item.binding_type,
    input.requestContext
  );
  const protocol =
    input.requestContext.protocol === 'direct' ? 'custom' : input.requestContext.protocol;
  const now = nowSeconds();
  const row = await input.db.queryOne<{ id: string }>(
    `SELECT id
       FROM consent_records
      WHERE tenant_id = ?
        AND subject_user_id = ?
        AND protocol = ?
        AND recipient_type = ?
        AND ((recipient_id = ?) OR (recipient_id IS NULL AND ? IS NULL))
        AND binding_type = ?
        AND ((binding_key = ?) OR (binding_key IS NULL AND ? IS NULL))
        AND statement_id = ?
        AND statement_version = ?
        AND policy_id = ?
        AND decision IN ('accepted', 'always', 'selected')
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC
      LIMIT 1`,
    [
      input.tenantId,
      input.userId,
      protocol,
      recipientType,
      recipientId,
      recipientId,
      bindingType,
      input.item.binding_value,
      input.item.binding_value,
      input.item.statement_id,
      input.item.version,
      input.policyId,
      now,
    ]
  );
  return Boolean(row);
}

async function removeAcceptedConsentItems(input: {
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  requestContext: FlowRequestContext;
  userId: string | null;
  step: FlowRuntimeStep;
}): Promise<FlowRuntimeStep> {
  if (input.step.component !== 'consent_policy' || !input.userId) return input.step;
  const policy = readRuntimeConsentPolicyContent(input.step);
  if (!policy) return input.step;
  const remainingItems: RuntimeConsentPolicyItem[] = [];
  for (const item of policy.items) {
    const alreadyAccepted = await hasActiveAcceptedConsentRecord({
      db: input.db,
      tenantId: input.tenantId,
      interaction: input.interaction,
      requestContext: input.requestContext,
      userId: input.userId,
      policyId: policy.id,
      item,
    });
    if (!alreadyAccepted) {
      remainingItems.push(item);
    }
  }
  return withRuntimeConsentPolicyContent(input.step, {
    ...policy,
    items: remainingItems,
  });
}

async function resolveNextDisplayStep(input: {
  c: AuthContext;
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  runtime: FlowRuntimeContract;
  editor: FlowEditorState | null;
  requestContext: FlowRequestContext;
  userId: string | null;
  initialStep: FlowRuntimeStep | null;
  completeTerminalStep?: boolean;
}): Promise<{
  step: FlowRuntimeStep | null;
  terminalStep: FlowRuntimeStep | null;
  terminalError?: FlowRuntimeTerminalError;
  errorCode?: string;
  userId: string | null;
  autoAdvancedSteps: RuntimeAutoAdvancedStep[];
}> {
  let step = input.initialStep;
  let userId = input.userId;
  const autoAdvancedSteps: RuntimeAutoAdvancedStep[] = [];
  const visited = new Set<string>();

  while (step) {
    const visitKey = `${step.source_node_id}:${step.id}`;
    if (visited.has(visitKey)) {
      return {
        step: null,
        terminalStep: null,
        errorCode: 'AR_FLOW_RUNTIME_LOOP',
        userId,
        autoAdvancedSteps,
      };
    }
    visited.add(visitKey);

    if (step.component === 'completion') {
      return input.completeTerminalStep === false
        ? { step, terminalStep: null, userId, autoAdvancedSteps }
        : { step: null, terminalStep: step, userId, autoAdvancedSteps };
    }

    const autoAdvance = await resolveAutoAdvanceForStep({
      c: input.c,
      db: input.db,
      tenantId: input.tenantId,
      interaction: input.interaction,
      runtime: input.runtime,
      step,
    });
    if (autoAdvance) {
      if (autoAdvance.terminalError) {
        return {
          step: null,
          terminalStep: null,
          terminalError: autoAdvance.terminalError,
          userId,
          autoAdvancedSteps,
        };
      }
      if (autoAdvance.errorCode) {
        return {
          step: null,
          terminalStep: null,
          errorCode: autoAdvance.errorCode,
          userId,
          autoAdvancedSteps,
        };
      }
      if (autoAdvance.userId) {
        userId = autoAdvance.userId;
      }
      autoAdvancedSteps.push({
        step,
        selectedHandle: autoAdvance.selectedHandle,
        userId: autoAdvance.userId,
      });
      const stepIndex = getRuntimeStepIndex(input.runtime, step);
      if (stepIndex < 0) {
        return {
          step: null,
          terminalStep: null,
          errorCode: 'AR_FLOW_RUNTIME_INVALID',
          userId,
          autoAdvancedSteps,
        };
      }
      const nextResolution = resolveNextStep(
        input.runtime,
        stepIndex,
        input.editor,
        autoAdvance.selectedHandle,
        input.requestContext
      );
      if (nextResolution.errorCode) {
        return {
          step: null,
          terminalStep: null,
          errorCode: nextResolution.errorCode,
          userId,
          autoAdvancedSteps,
        };
      }
      step = nextResolution.step;
      continue;
    }

    if (step.component === 'consent_policy') {
      const filteredStep = await removeAcceptedConsentItems({
        db: input.db,
        tenantId: input.tenantId,
        interaction: input.interaction,
        requestContext: input.requestContext,
        userId,
        step,
      });
      const policy = readRuntimeConsentPolicyContent(filteredStep);
      if (!policy || policy.items.length > 0) {
        return { step: filteredStep, terminalStep: null, userId, autoAdvancedSteps };
      }

      autoAdvancedSteps.push({
        step,
        selectedHandle: null,
        userId,
      });
      const stepIndex = getRuntimeStepIndex(input.runtime, step);
      if (stepIndex < 0) {
        return {
          step: null,
          terminalStep: null,
          errorCode: 'AR_FLOW_RUNTIME_INVALID',
          userId,
          autoAdvancedSteps,
        };
      }
      const nextResolution = resolveNextStep(
        input.runtime,
        stepIndex,
        input.editor,
        null,
        input.requestContext
      );
      if (nextResolution.errorCode) {
        return {
          step: null,
          terminalStep: null,
          errorCode: nextResolution.errorCode,
          userId,
          autoAdvancedSteps,
        };
      }
      step = nextResolution.step;
      continue;
    }

    return { step, terminalStep: null, userId, autoAdvancedSteps };
  }

  return { step: null, terminalStep: null, userId, autoAdvancedSteps };
}

async function persistInitialAutoAdvancedSteps(input: {
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  initialStepRowId: string;
  autoAdvancedSteps: RuntimeAutoAdvancedStep[];
  nextStep: FlowRuntimeStep;
  userId: string | null;
  now: number;
}): Promise<void> {
  if (input.autoAdvancedSteps.length === 0) return;

  await input.db.transaction(async (tx) => {
    for (let index = 0; index < input.autoAdvancedSteps.length; index += 1) {
      const advanced = input.autoAdvancedSteps[index];
      const stateJson = JSON.stringify({
        selected_handle: advanced.selectedHandle,
        submitted_handle: advanced.selectedHandle,
        completed_at: input.now,
        auto_advanced: true,
      });

      if (index === 0) {
        await tx.execute(
          `UPDATE flow_interaction_steps
             SET state = 'completed', selected_handle = ?, state_json = ?, updated_at = ?
           WHERE tenant_id = ? AND id = ? AND state IN ('pending', 'waiting_input', 'processing')`,
          [advanced.selectedHandle, stateJson, input.now, input.tenantId, input.initialStepRowId]
        );
      } else {
        await tx.execute(
          `INSERT INTO flow_interaction_steps (
            id, tenant_id, interaction_id, node_id, step_id, state, selected_handle, state_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
          [
            generateId(),
            input.tenantId,
            input.interaction.id,
            advanced.step.source_node_id,
            advanced.step.id,
            advanced.selectedHandle,
            stateJson,
            input.now,
            input.now,
          ]
        );
      }
    }

    await tx.execute(
      `INSERT INTO flow_interaction_steps (
        id, tenant_id, interaction_id, node_id, step_id, state, selected_handle, state_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      [
        generateId(),
        input.tenantId,
        input.interaction.id,
        input.nextStep.source_node_id,
        input.nextStep.id,
        getStepStateForRuntimeStep(input.nextStep),
        input.now,
        input.now,
      ]
    );

    await tx.execute(
      `UPDATE flow_interactions
         SET user_id = COALESCE(user_id, ?), current_node_id = ?, current_step_id = ?,
             updated_at = ?, completed_at = NULL
       WHERE tenant_id = ? AND id = ?`,
      [
        input.userId,
        input.nextStep.source_node_id,
        input.nextStep.id,
        input.now,
        input.tenantId,
        input.interaction.id,
      ]
    );
  });
}

function createInitialAutoAdvanceAuditEvents(input: {
  autoAdvancedSteps: RuntimeAutoAdvancedStep[];
  nextStep: FlowRuntimeStep;
  userId: string | null;
}): RuntimeAuditEventInput[] {
  const events: RuntimeAuditEventInput[] = [];

  for (const advanced of input.autoAdvancedSteps) {
    events.push({
      eventType: eventTypeForCompletedStep(advanced.step),
      result: 'success',
      nodeId: advanced.step.source_node_id,
      branchHandleId: advanced.selectedHandle,
      userId: advanced.userId ?? input.userId,
    });
  }

  events.push({
    eventType: 'flow.node.entered',
    result: 'success',
    nodeId: input.nextStep.source_node_id,
    userId: input.userId,
  });

  return events;
}

async function insertFlowConsentRecords(input: {
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  step: FlowRuntimeStep;
  policy: RuntimeConsentPolicyContent;
  requestContext: FlowRequestContext;
  userId: string;
  decisions: Record<string, RuntimeConsentItemDecision>;
  ipHash?: string;
  userAgent?: string;
}): Promise<void> {
  const now = nowSeconds();
  const { recipientType, recipientId } = consentRecordRecipient(input);
  const releasedScopes =
    input.requestContext.protocol === 'oidc' && input.requestContext.requested_scope.length > 0
      ? JSON.stringify(input.requestContext.requested_scope)
      : null;

  for (const item of input.policy.items) {
    const itemDecision = input.decisions[item.statement_id] ?? {
      decision: 'rejected',
      selectedValue: null,
    };
    const bindingType = normalizeConsentRecordBindingType(item.binding_type, input.requestContext);
    const resourceType = consentRecordResourceType(item, input.requestContext);
    await input.db.execute(
      `INSERT INTO consent_records (
        id, tenant_id, subject_user_id, actor_user_id, protocol, consent_kind,
        client_id, saml_sp_id, recipient_type, recipient_id, binding_type, binding_key,
        resource_type, resource_id, purpose_key, statement_id, statement_version, policy_id,
        flow_id, flow_version_id, flow_node_id, decision, selected_value, selected_options_json,
        released_scopes_json, released_claims_json, released_attributes_json, status, expires_at,
        revoked_at, evidence_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId(),
        input.tenantId,
        input.userId,
        input.userId,
        input.requestContext.protocol === 'direct' ? 'custom' : input.requestContext.protocol,
        normalizeConsentRecordKind(item.category),
        input.interaction.client_id,
        input.interaction.saml_sp_id,
        recipientType,
        recipientId,
        bindingType,
        item.binding_value,
        resourceType,
        item.binding_value,
        item.category,
        item.statement_id,
        item.version,
        input.policy.id,
        input.interaction.flow_id,
        input.interaction.flow_version_id,
        input.step.source_node_id,
        itemDecision.decision,
        itemDecision.selectedValue,
        itemDecision.selectedValue ? JSON.stringify([itemDecision.selectedValue]) : null,
        releasedScopes,
        null,
        null,
        'active',
        null,
        null,
        JSON.stringify({
          source: 'flow_runtime',
          interaction_id: input.interaction.id,
          step_id: input.step.id,
          node_id: input.step.source_node_id,
          statement_slug: item.slug,
          statement_version_id: item.version_id,
          content_mode: item.content_mode,
          checkbox_mode: item.checkbox_mode,
          is_required: item.is_required,
          selected_value: itemDecision.selectedValue,
          attribute_value_display: item.attribute_value_display,
          requested_scope: input.requestContext.requested_scope,
          authorization_challenge_id: input.requestContext.authorization_challenge_id,
          saml_request_id: input.requestContext.saml_request_id,
          saml_sp_entity_id: input.requestContext.saml_sp_entity_id,
          user_agent: input.userAgent,
          ip_address_hash: input.ipHash,
        }),
        now,
        now,
      ]
    );
  }
}

async function persistRuntimeConsentStep(input: {
  c: AuthContext;
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  step: FlowRuntimeStep;
  submitInput: unknown;
}): Promise<{ ok: boolean; response?: Response; userId?: string | null }> {
  const requestContext = getRequestContextFromInteraction(input.interaction);
  const config = parseJsonRecord(input.step.config);
  const policyId = readString(config.consent_policy_ref, 200);
  if (!policyId) {
    if (input.step.component !== 'consent_policy') return { ok: true };
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
    if (
      input.step.component === 'authentication_method_selector' ||
      input.step.component === 'registration_method_selector'
    ) {
      return { ok: true };
    }
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
  const submittedSelectedValues = readConsentSelectedValueMap(input.submitInput);
  const decisions = Object.fromEntries(
    policy.items.map((item) => [
      item.statement_id,
      consentItemDecision({
        item,
        submittedDecision: submitted[item.statement_id],
        submittedSelectedValue: submittedSelectedValues[item.statement_id],
      }),
    ])
  ) as Record<string, RuntimeConsentItemDecision>;
  const missingRequired = policy.items.filter(
    (item) => !consentItemInputSatisfied(item, decisions[item.statement_id])
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

  const ipAddress =
    getRequestHeader(input.c, 'CF-Connecting-IP') ||
    getRequestHeader(input.c, 'X-Forwarded-For') ||
    '';
  const ipHash = ipAddress
    ? await hashIpAddress(ipAddress, input.tenantId, input.c.env.KV ?? null)
    : undefined;
  await insertFlowConsentRecords({
    db: input.db,
    tenantId: input.tenantId,
    interaction: input.interaction,
    step: input.step,
    policy,
    requestContext,
    userId,
    decisions,
    ipHash,
    userAgent: getRequestHeader(input.c, 'User-Agent'),
  });

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
  const assignment: FlowAssignmentRow = {
    flow_id: interaction.flow_id,
    flow_kind: runtime.flow_kind,
    target_type: interaction.saml_sp_id
      ? 'saml_sp'
      : interaction.client_id
        ? 'oidc_client'
        : 'tenant',
    target_id: interaction.saml_sp_id ?? interaction.client_id,
    published_version_id: interaction.flow_version_id,
  };
  const { contract, contractHash } = await prepareRuntimeContract({
    c,
    db,
    tenantId,
    assignment,
    version,
    runtimeSnapshot: runtime,
    requestContext,
  });
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
  const timing = createRuntimeStartTiming(c.env);
  const tenantId = getTenantIdFromContext(c);
  const enabled = await timeRuntimeStartSpan(timing, 'feature_flag', () =>
    isLoginRuntimeFlowEnabled(c.env, tenantId)
  );
  if (!enabled) {
    writeRuntimeStartTiming(c, timing, { result: 'disabled', error: 'flow_runtime_disabled' });
    return jsonError(c, 403, 'flow_runtime_disabled', 'LoginUI runtime Flow is disabled');
  }

  const body = await timeRuntimeStartSpan(timing, 'parse_body', () =>
    c.req.json<StartRequest>().catch((): StartRequest => ({}))
  );
  const resumeInteractionId = readString(body.resume_interaction_id, 128);
  const authCtx = timeRuntimeStartValue(timing, 'auth_context', () =>
    createAuthContextFromHono(c, tenantId)
  );
  const db = authCtx.coreAdapter;

  if (resumeInteractionId) {
    const response = await timeRuntimeStartSpan(timing, 'resume_interaction', () =>
      resumeInteraction(
        c,
        db,
        tenantId,
        resumeInteractionId,
        readString(body.contract_hash, 256),
        readString(body.signature, 512)
      )
    );
    writeRuntimeStartTiming(c, timing, { result: 'resume' });
    return response;
  }

  const target = timeRuntimeStartValue(timing, 'resolve_target', () => resolveTarget(body));
  if (!target) {
    writeRuntimeStartTiming(c, timing, { result: 'error', error: 'invalid_target' });
    return jsonError(c, 400, 'invalid_target', 'Flow assignment target is invalid');
  }

  const flowKind = timeRuntimeStartValue(timing, 'normalize_flow', () =>
    normalizeFlowKind(body.flow_kind)
  );
  if (!flowKind) {
    writeRuntimeStartTiming(c, timing, { result: 'error', error: 'unsupported_flow_kind' });
    return jsonError(
      c,
      400,
      'unsupported_flow_kind',
      'This flow kind is not executed by the LoginUI runtime'
    );
  }
  const requestContext = timeRuntimeStartValue(timing, 'request_context', () =>
    createRequestContext(target, body)
  );
  const challengeBindingError = await timeRuntimeStartSpan(timing, 'authorization_challenge', () =>
    validateRuntimeAuthorizationChallengeBinding(c, tenantId, target, requestContext)
  );
  if (challengeBindingError) {
    writeRuntimeStartTiming(c, timing, {
      result: 'error',
      flowKind,
      targetType: target.targetType,
      error: 'invalid_authorization_challenge',
    });
    return challengeBindingError;
  }

  const assignment = await timeRuntimeStartSpan(timing, 'resolve_assignment', () =>
    resolveAssignment(db, tenantId, flowKind, target)
  );
  if (!assignment) {
    writeRuntimeStartTiming(c, timing, {
      result: 'error',
      flowKind,
      targetType: target.targetType,
      error: 'flow_assignment_missing',
    });
    return jsonError(
      c,
      409,
      'flow_assignment_missing',
      'No published Flow assignment is available'
    );
  }

  const version = await timeRuntimeStartSpan(timing, 'published_version', () =>
    getPublishedVersion(db, tenantId, assignment)
  );
  const runtimeSnapshot = timeRuntimeStartValue(timing, 'parse_snapshot', () =>
    version ? parseRuntimeSnapshot(version.runtime_snapshot_json) : null
  );
  if (!version || !runtimeSnapshot) {
    writeRuntimeStartTiming(c, timing, {
      result: 'error',
      flowKind,
      targetType: target.targetType,
      error: 'flow_version_unavailable',
    });
    return jsonError(c, 409, 'flow_version_unavailable', 'Published Flow version is unavailable');
  }

  const { contract: runtime, contractHash } = await timeRuntimeStartSpan(
    timing,
    'prepare_contract',
    () =>
      prepareRuntimeContract({
        c,
        db,
        tenantId,
        assignment,
        version,
        runtimeSnapshot,
        requestContext,
      })
  );
  const editor = timeRuntimeStartValue(timing, 'parse_editor', () =>
    parseEditorSnapshot(version.editor_snapshot_json)
  );
  const firstStep = timeRuntimeStartValue(timing, 'first_step', () => getFirstStep(runtime));
  if (!firstStep) {
    writeRuntimeStartTiming(c, timing, {
      result: 'error',
      flowKind,
      targetType: target.targetType,
      error: 'flow_runtime_invalid',
    });
    return jsonError(
      c,
      409,
      'flow_runtime_invalid',
      'Published Flow runtime has no executable steps'
    );
  }

  const secret = getRuntimeHmacSecret(c.env);
  if (!secret) {
    writeRuntimeStartTiming(c, timing, {
      result: 'error',
      flowKind,
      targetType: target.targetType,
      error: 'flow_runtime_secret_missing',
    });
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
  const signature = await timeRuntimeStartSpan(timing, 'sign_contract', () =>
    signContract({
      interactionId,
      contractHash,
      expiresAt,
      secret,
    })
  );

  await timeRuntimeStartSpan(timing, 'initial_tx', () =>
    db.transaction(async (tx) => {
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
    })
  );

  const startedInteraction: FlowInteractionRow = {
    id: interactionId,
    flow_id: assignment.flow_id,
    flow_version_id: version.id,
    user_id: null,
    client_id: target.clientId,
    saml_sp_id: target.samlSpId,
    state: 'active',
    current_node_id: firstStep.source_node_id,
    current_step_id: firstStep.id,
    context_json: JSON.stringify(requestContext),
    contract_hash: contractHash,
    signature,
    expires_at: expiresAt,
  };
  const startAuditFallback = scheduleRuntimeAuditEvents(
    c,
    db,
    tenantId,
    startedInteraction,
    [
      {
        id: auditEventId,
        eventType: 'flow.interaction.started',
        result: 'success',
        nodeId: firstStep.source_node_id,
        metadata: {
          target_type: assignment.target_type,
          target_id: assignment.target_id,
          flow_kind: assignment.flow_kind,
          requested_scope: requestContext.requested_scope,
        },
      },
    ],
    'interaction_started'
  );
  if (startAuditFallback) {
    await timeRuntimeStartSpan(timing, 'audit_start_fallback', () => startAuditFallback);
  }

  const initialDisplayResolution = await timeRuntimeStartSpan(timing, 'resolve_initial_step', () =>
    resolveNextDisplayStep({
      c,
      db,
      tenantId,
      interaction: startedInteraction,
      runtime,
      editor,
      requestContext,
      userId: null,
      initialStep: firstStep,
      completeTerminalStep: false,
    })
  );
  if (initialDisplayResolution.terminalError) {
    await insertAuditEvent(db, tenantId, startedInteraction, {
      eventType: 'flow.interaction.failed',
      result: 'terminal_error',
      errorCode: initialDisplayResolution.terminalError.error,
      nodeId: firstStep.source_node_id,
    });
    writeRuntimeStartTiming(c, timing, {
      result: 'error',
      flowKind: assignment.flow_kind,
      targetType: assignment.target_type,
      error: initialDisplayResolution.terminalError.error,
    });
    return runtimeError(
      c,
      409,
      initialDisplayResolution.terminalError.error,
      initialDisplayResolution.terminalError.message ?? 'Flow condition ended this interaction',
      'AR_FLOW_TERMINAL',
      'terminal_error',
      'show_terminal_error',
      interactionId
    );
  }
  if (initialDisplayResolution.errorCode) {
    await insertAuditEvent(db, tenantId, startedInteraction, {
      eventType: 'flow.interaction.failed',
      result: 'configuration_error',
      errorCode: initialDisplayResolution.errorCode,
      nodeId: firstStep.source_node_id,
    });
    writeRuntimeStartTiming(c, timing, {
      result: 'error',
      flowKind: assignment.flow_kind,
      targetType: assignment.target_type,
      error: initialDisplayResolution.errorCode,
    });
    return runtimeError(
      c,
      409,
      'invalid_flow_branch',
      'Published Flow initial branch cannot be evaluated',
      initialDisplayResolution.errorCode,
      'configuration_error',
      'contact_administrator',
      interactionId
    );
  }
  const initialCurrentStep = initialDisplayResolution.step;
  if (!initialCurrentStep) {
    writeRuntimeStartTiming(c, timing, {
      result: 'error',
      flowKind: assignment.flow_kind,
      targetType: assignment.target_type,
      error: 'flow_runtime_invalid',
    });
    return jsonError(
      c,
      409,
      'flow_runtime_invalid',
      'Published Flow runtime has no displayable initial step'
    );
  }
  if (initialDisplayResolution.autoAdvancedSteps.length > 0) {
    await timeRuntimeStartSpan(timing, 'persist_auto_advance', () =>
      persistInitialAutoAdvancedSteps({
        db,
        tenantId,
        interaction: startedInteraction,
        initialStepRowId: stepRowId,
        autoAdvancedSteps: initialDisplayResolution.autoAdvancedSteps,
        nextStep: initialCurrentStep,
        userId: initialDisplayResolution.userId,
        now,
      })
    );
    const autoAdvanceAuditFallback = scheduleRuntimeAuditEvents(
      c,
      db,
      tenantId,
      startedInteraction,
      createInitialAutoAdvanceAuditEvents({
        autoAdvancedSteps: initialDisplayResolution.autoAdvancedSteps,
        nextStep: initialCurrentStep,
        userId: initialDisplayResolution.userId,
      }),
      'initial_auto_advance'
    );
    if (autoAdvanceAuditFallback) {
      await timeRuntimeStartSpan(
        timing,
        'audit_auto_advance_fallback',
        () => autoAdvanceAuditFallback
      );
    }
  }

  getLogger(c).module('LOGIN-RUNTIME-FLOW').info('Started LoginUI runtime Flow interaction', {
    interaction_id: interactionId,
    flow_id: assignment.flow_id,
    flow_version_id: version.id,
    flow_kind: assignment.flow_kind,
    current_step_id: initialCurrentStep.id,
    auto_advanced_steps: initialDisplayResolution.autoAdvancedSteps.length,
  });
  writeRuntimeStartTiming(c, timing, {
    result: 'success',
    flowKind: assignment.flow_kind,
    targetType: assignment.target_type,
    currentStepId: initialCurrentStep.id,
    autoAdvancedSteps: initialDisplayResolution.autoAdvancedSteps.length,
  });

  return c.json({
    schema_version: FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
    interaction: {
      id: interactionId,
      state: 'active',
      flow_id: assignment.flow_id,
      flow_version_id: version.id,
      current_node_id: initialCurrentStep.source_node_id,
      current_step_id: initialCurrentStep.id,
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

function emailVerificationTargetForCurrentStep(
  runtime: FlowRuntimeContract,
  current: { index: number; step: FlowRuntimeStep },
  editor: FlowEditorState | null,
  requestContext: FlowRequestContext
): FlowRuntimeStep | null {
  if (current.step.component === 'email_verification') {
    return current.step;
  }
  if (
    current.step.component !== 'authentication_method_selector' &&
    current.step.component !== 'registration_method_selector'
  ) {
    return null;
  }

  const resolution = resolveNextStep(runtime, current.index, editor, 'mail_otp', requestContext);
  return resolution.errorCode || resolution.step?.component !== 'email_verification'
    ? null
    : resolution.step;
}

function generateEmailVerificationNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export async function loginRuntimeEmailVerificationChallengeHandler(c: AuthContext) {
  const tenantId = getTenantIdFromContext(c);
  if (!(await isLoginRuntimeFlowEnabled(c.env, tenantId))) {
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

  const body = await c.req
    .json<EmailVerificationChallengeRequest>()
    .catch((): EmailVerificationChallengeRequest => ({}));
  const submittedStepId = readString(body.step_id, 200);
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
  if (
    !interaction ||
    (interaction.state !== 'created' && interaction.state !== 'active') ||
    interaction.expires_at <= now
  ) {
    return runtimeError(
      c,
      404,
      'interaction_not_found',
      'Flow interaction was not found or expired',
      'AR_FLOW_NOT_FOUND',
      'restart_required',
      'restart_interaction',
      interactionId
    );
  }
  if (submittedStepId !== interaction.current_step_id) {
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
  if (
    !(await verifyContractSignature({
      interactionId,
      contractHash: interaction.contract_hash,
      expiresAt: interaction.expires_at,
      storedSignature: interaction.signature,
      submittedContractHash,
      submittedSignature,
      secret,
    }))
  ) {
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
  const current = runtime ? findCurrentStep(runtime, interaction) : null;
  if (!runtime || !current) {
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

  const availableHandles = await resolveRuntimeAuthenticationHandles(
    c,
    tenantId,
    runtime.flow_kind,
    current.step.component
  );
  const verificationStep = emailVerificationTargetForCurrentStep(
    runtime,
    current,
    editor,
    requestContext
  );
  if (!availableHandles.includes('mail_otp') || !verificationStep) {
    return c.json({ available: false });
  }

  const challengeId = crypto.randomUUID();
  const nonce = generateEmailVerificationNonce();
  const expiresIn = Math.min(
    EMAIL_VERIFICATION_PROTOCOL_CHALLENGE_TTL_SECONDS,
    interaction.expires_at - now
  );
  const challengeStore = await getChallengeStoreByChallengeId(c.env, challengeId, tenantId);
  await challengeStore.storeChallengeRpc({
    id: `email_verification_protocol:${challengeId}`,
    tenantId,
    type: 'email_verification_protocol',
    userId: interaction.user_id ?? interaction.id,
    challenge: nonce,
    ttl: expiresIn,
    metadata: {
      interaction_id: interaction.id,
      source_step_id: current.step.id,
      verification_step_id: verificationStep.id,
      expected_origin: getRequestOrigin(c),
      contract_hash: interaction.contract_hash,
    },
  });

  c.header('Cache-Control', 'no-store');
  return c.json({
    available: true,
    challenge_id: challengeId,
    nonce,
    expires_in: expiresIn,
    interaction_id: interaction.id,
    step_id: current.step.id,
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
    userId?: string | null;
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
  } else if (current.step.component === 'session_check') {
    branchResolution = await resolveSessionCheckSelectedHandle(c, tenantId);
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
  if (current.step.component === 'email_verification' && effectiveSelectedHandle === 'verified') {
    const verifiedUserId = await getRecentVerifiedEmailSessionUserId(
      c,
      tenantId,
      interaction.expires_at - FLOW_RUNTIME_INTERACTION_TTL_SECONDS,
      interaction.id
    );
    if (!verifiedUserId) {
      await insertAuditEvent(db, tenantId, interaction, {
        eventType: 'flow.interaction.failed',
        result: 'security_error',
        errorCode: 'AR_FLOW_EMAIL_VERIFICATION_REQUIRED',
        nodeId: interaction.current_node_id,
        branchHandleId: effectiveSelectedHandle,
      });
      return runtimeError(
        c,
        403,
        'email_verification_required',
        'A recent verified email authentication is required',
        'AR_FLOW_EMAIL_VERIFICATION_REQUIRED',
        'security_error',
        'retry_step',
        interactionId
      );
    }
    branchResolution.userId = verifiedUserId;
  }
  const nextResolution =
    current.step.component === 'completion'
      ? { step: null as FlowRuntimeStep | null }
      : resolveNextStep(runtime, current.index, editor, effectiveSelectedHandle, requestContext);
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
  let resolvedUserId = consentResult.userId ?? branchResolution.userId ?? interaction.user_id;
  if (
    !resolvedUserId &&
    (current.step.component === 'authentication_method_selector' ||
      current.step.component === 'registration_method_selector' ||
      current.step.component === 'completion' ||
      nextResolution.step?.component === 'consent_policy' ||
      nextResolution.step?.component === 'completion')
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

  const visibleStepResolution =
    current.step.component === 'completion'
      ? {
          step: null as FlowRuntimeStep | null,
          terminalStep: current.step,
          userId: resolvedUserId ?? null,
          autoAdvancedSteps: [],
        }
      : await resolveNextDisplayStep({
          c,
          db,
          tenantId,
          interaction,
          runtime,
          editor,
          requestContext,
          userId: resolvedUserId ?? null,
          initialStep: nextResolution.step,
        });
  if (visibleStepResolution.terminalError) {
    await insertAuditEvent(db, tenantId, interaction, {
      eventType: 'flow.interaction.failed',
      result: 'terminal_error',
      errorCode: visibleStepResolution.terminalError.error,
      nodeId: interaction.current_node_id,
      branchHandleId: effectiveSelectedHandle,
      userId: resolvedUserId,
    });
    return runtimeError(
      c,
      409,
      visibleStepResolution.terminalError.error,
      visibleStepResolution.terminalError.message ?? 'Flow condition ended this interaction',
      'AR_FLOW_TERMINAL',
      'terminal_error',
      'show_terminal_error',
      interactionId
    );
  }
  if (visibleStepResolution.errorCode) {
    await insertAuditEvent(db, tenantId, interaction, {
      eventType: 'flow.interaction.failed',
      result: 'configuration_error',
      errorCode: visibleStepResolution.errorCode,
      nodeId: interaction.current_node_id,
      branchHandleId: effectiveSelectedHandle,
      userId: resolvedUserId,
    });
    return runtimeError(
      c,
      409,
      'invalid_flow_branch',
      'Submitted Flow branch does not match the active Flow step',
      visibleStepResolution.errorCode,
      'configuration_error',
      'contact_administrator',
      interactionId
    );
  }
  resolvedUserId = visibleStepResolution.userId ?? resolvedUserId;
  if (visibleStepResolution.userId && visibleStepResolution.userId !== interaction.user_id) {
    await db.execute(
      `UPDATE flow_interactions
         SET user_id = COALESCE(user_id, ?), updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
      [visibleStepResolution.userId, now, tenantId, interactionId]
    );
  }

  const nextStep = visibleStepResolution.step;
  const terminalStep = visibleStepResolution.terminalStep;
  const outputStep = terminalStep ?? current.step;
  const completed = nextStep === null;
  const nextState = completed ? 'completed' : 'active';
  const completedAt = completed ? now : null;

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
        nodeId: outputStep.source_node_id,
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
          currentStep: outputStep,
          effectiveSelectedHandle,
          redirectUrl: completedProtocolRedirect.redirectUrl,
        })
      : null,
  });
}
