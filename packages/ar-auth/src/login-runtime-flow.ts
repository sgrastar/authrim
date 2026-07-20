import type { Context } from 'hono';
import { consumeAuthorizationChallengeContinuation } from './direct-auth';
import {
  FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
  FLOW_RUNTIME_INTERACTION_TTL_SECONDS,
  createAuthContextFromHono,
  createPIIContextFromHono,
  evaluateFlowConditionRows,
  generateId,
  buildSAMLRequestStoreInstanceName,
  getChallengeStoreByChallengeId,
  getFeatureFlag,
  clearFeatureFlagCache,
  isTenantFlowProtocolConsentGatesEnabled,
  isTenantFlowProtocolConsentShadowEnabled,
  invalidateConsentCache,
  getLogger,
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  hashIpAddress,
  isShardedSessionId,
  CanonicalRuntimeUserStore,
  ConsentGateDecisionReceiptRepository,
  ConsentGatePolicyConfigurationError,
  ConsentGatePolicyBindingRepository,
  DocumentAcknowledgmentRepository,
  evaluateConsentGate,
  resolveConsentGatePolicyBinding,
  resolveClientTrustPolicy,
  resolveRuntimeIdentityMappingBinding,
  requireDedicatedAdminDatabaseAdapter,
  type ConsentGateKind,
  type ConsentGateNodeConfig,
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
  type SAMLRequestData,
  type SAMLAuthnRequest,
  type TransactionContext,
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
  oidc_redirect_uri: string | null;
  oidc_resources: string[];
  oidc_claims: FlowRuntimeJsonObject | null;
  oidc_identity_mapping: FlowRuntimeJsonObject | null;
  oidc_mapping_claims: string[];
  oidc_mapping_snapshot_hash: string | null;
  oidc_release_mode: 'once' | 'every_time' | 'until_attributes_change';
  oidc_prompt: string | null;
  oidc_prompt_values: string[];
  oidc_authorization_request_source: string | null;
  oidc_authorization_request_integrity_protected: boolean;
  oidc_challenge_type: 'login' | 'reauth' | 'consent' | null;
  saml_acs_url: string | null;
  saml_requested_attributes: FlowRuntimeJsonObject[];
  saml_identity_mapping: FlowRuntimeJsonObject | null;
  saml_release_attributes: FlowRuntimeJsonObject[];
  saml_release_set_hash: string | null;
  saml_release_mode: 'once' | 'every_time' | 'until_attributes_change' | null;
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
  attribute_display_values: string[];
  checkbox_mode: 'none' | 'required' | 'optional';
  checkbox_default_checked: boolean;
  binding_type: string | null;
  binding_value: string | null;
  evidence_profile: string | null;
  language_fallback: string | null;
  display_order: number;
  acceptance_status: 'accepted' | 'pending';
  action_required: boolean;
  accepted_at: number | null;
  accepted_record_id: string | null;
  release_kind: 'scope' | 'claim' | 'attribute' | null;
  release_name: string | null;
  release_locked: boolean | null;
  previously_granted: boolean | null;
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
  gate_kind: ConsentGateKind | null;
  policy_id: string;
  policy_satisfied: boolean;
  force_interaction: boolean;
  release_set_hash: string | null;
  release_mode: 'once' | 'every_time' | 'until_attributes_change' | null;
  release_current_state: 'granted' | 'denied' | 'revoked' | 'expired' | null;
  release_existing_set_hash: string | null;
}

type RuntimeConsentQueryStore = Pick<
  DatabaseAdapter | TransactionContext,
  'query' | 'queryOne' | 'execute'
>;

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
  clearFeatureFlagCache();
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

function readLoginRuntimeFlagFromSettings(
  settings: Record<string, unknown> | null
): boolean | null {
  if (!settings || typeof settings !== 'object') return null;
  for (const key of LOGIN_RUNTIME_FEATURE_KEYS) {
    if (settings[key] === true || settings[key] === 'true' || settings[key] === '1') return true;
    if (settings[key] === false || settings[key] === 'false' || settings[key] === '0') return false;
  }
  return null;
}

export async function isLoginRuntimeFlowEnabled(env: Env, tenantId: string): Promise<boolean> {
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
                  redirect_uri: requestContext.oidc_redirect_uri,
                  resource: requestContext.oidc_resources,
                  claims: requestContext.oidc_claims,
                  identity_mapping: requestContext.oidc_identity_mapping,
                  mapping_claims: requestContext.oidc_mapping_claims,
                  mapping_snapshot_hash: requestContext.oidc_mapping_snapshot_hash,
                  release_mode: requestContext.oidc_release_mode,
                  prompt: requestContext.oidc_prompt,
                  prompt_values: requestContext.oidc_prompt_values,
                  authorization_request_source: requestContext.oidc_authorization_request_source,
                  authorization_request_integrity_protected:
                    requestContext.oidc_authorization_request_integrity_protected,
                  challenge_type: requestContext.oidc_challenge_type,
                } as FlowRuntimeJsonObject)
              : null,
          saml: requestContext.saml_sp_id
            ? ({
                saml_sp_id: requestContext.saml_sp_id,
                saml_request_id: requestContext.saml_request_id,
                saml_sp_entity_id: requestContext.saml_sp_entity_id,
                acs_url: requestContext.saml_acs_url,
                requested_attributes: requestContext.saml_requested_attributes,
                identity_mapping: requestContext.saml_identity_mapping,
                release_attributes: requestContext.saml_release_attributes,
                release_set_hash: requestContext.saml_release_set_hash,
                release_mode: requestContext.saml_release_mode,
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
    requestContext.oidc_redirect_uri,
    requestContext.oidc_resources,
    requestContext.oidc_claims,
    requestContext.oidc_identity_mapping,
    requestContext.oidc_mapping_claims,
    requestContext.oidc_mapping_snapshot_hash,
    requestContext.oidc_release_mode,
    requestContext.oidc_prompt,
    requestContext.oidc_authorization_request_source,
    requestContext.oidc_authorization_request_integrity_protected,
    requestContext.oidc_challenge_type,
    requestContext.saml_acs_url,
    requestContext.saml_requested_attributes,
    requestContext.saml_identity_mapping,
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
  db: RuntimeConsentQueryStore,
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
  db: RuntimeConsentQueryStore,
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
  db: RuntimeConsentQueryStore,
  tenantId: string,
  policyId: string,
  requestContext: FlowRequestContext,
  gateKind: ConsentGateKind | null = null
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
      attribute_display_values: [],
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
      acceptance_status: 'pending',
      action_required: row.requirement === 'required',
      accepted_at: null,
      accepted_record_id: null,
      release_kind: null,
      release_name: null,
      release_locked: null,
      previously_granted: null,
    });
  }

  return {
    id: policy.id,
    display_name: policy.display_name,
    description: policy.description,
    language,
    default_language: 'en',
    items,
    gate_kind: gateKind,
    policy_id: policy.id,
    policy_satisfied: false,
    force_interaction: false,
    release_set_hash: null,
    release_mode: null,
    release_current_state: null,
    release_existing_set_hash: null,
  };
}

const OIDC_RELEASE_POLICY_ID = '__oidc_authorization_release__';
const SAML_RELEASE_POLICY_ID = '__saml_attribute_release__';

interface OidcReleaseGrantRow {
  scope: string;
  selected_claims: unknown;
  release_set_hash: string | null;
  expires_at: number | null;
}

function requestedOidcClaims(request: FlowRuntimeJsonObject | null): Array<{
  name: string;
  required: boolean;
}> {
  if (!request) return [];
  const claims = new Map<string, boolean>();
  for (const target of ['userinfo', 'id_token']) {
    const values = parseJsonRecord(request[target]);
    for (const [name, raw] of Object.entries(values)) {
      const options = parseJsonRecord(raw);
      claims.set(name, (claims.get(name) ?? false) || options.essential === true);
    }
  }
  return [...claims.entries()]
    .map(([name, required]) => ({ name, required }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function effectiveRequestedOidcClaims(requestContext: FlowRequestContext): Array<{
  name: string;
  required: boolean;
}> {
  const claims = new Map(
    requestedOidcClaims(requestContext.oidc_claims).map((claim) => [claim.name, claim.required])
  );
  for (const claimName of requestContext.oidc_mapping_claims) {
    claims.set(claimName, true);
  }
  return [...claims.entries()]
    .map(([name, required]) => ({ name, required }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function parseStoredStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (!value) return [];
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function localizedOidcClaim(
  name: string,
  language: string
): {
  title: string;
  description: string;
} {
  const ja: Record<string, [string, string]> = {
    name: ['氏名', '氏名をこのサービスへ提供します。'],
    preferred_username: ['ユーザー名', '表示用のユーザー名をこのサービスへ提供します。'],
    email: ['メールアドレス', 'メールアドレスをこのサービスへ提供します。'],
    email_verified: ['メール確認状態', 'メールアドレスの確認状態をこのサービスへ提供します。'],
    phone_number: ['電話番号', '電話番号をこのサービスへ提供します。'],
    address: ['住所', '住所情報をこのサービスへ提供します。'],
  };
  const en: Record<string, [string, string]> = {
    name: ['Name', 'Share your name with this service.'],
    preferred_username: ['Username', 'Share your display username with this service.'],
    email: ['Email address', 'Share your email address with this service.'],
    email_verified: ['Email verification status', 'Share whether your email address is verified.'],
    phone_number: ['Phone number', 'Share your phone number with this service.'],
    address: ['Address', 'Share your address information with this service.'],
  };
  const fallbackTitle = name
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
  const selected = (language === 'ja' ? ja : en)[name];
  return selected
    ? { title: selected[0], description: selected[1] }
    : {
        title: fallbackTitle,
        description:
          language === 'ja'
            ? `${name} クレームをこのサービスへ提供します。`
            : `Share the ${name} claim with this service.`,
      };
}

export async function resolveOidcReleasePolicyContent(input: {
  db: RuntimeConsentQueryStore;
  tenantId: string;
  requestContext: FlowRequestContext;
  policy: RuntimeConsentPolicyContent | null;
  userId?: string | null;
}): Promise<RuntimeConsentPolicyContent | null> {
  if (
    input.requestContext.protocol !== 'oidc' ||
    !input.requestContext.client_id ||
    input.requestContext.target_type !== 'oidc_client'
  ) {
    return input.policy;
  }
  const language = requestedLanguage(input.requestContext);
  const requestedScopes = [...new Set(input.requestContext.requested_scope)].filter(Boolean);
  const requestedClaims = effectiveRequestedOidcClaims(input.requestContext);
  const existing = input.userId
    ? await input.db.queryOne<OidcReleaseGrantRow>(
        `SELECT scope, selected_claims, release_set_hash, expires_at
           FROM oauth_client_consents
          WHERE tenant_id = ? AND user_id = ? AND client_id = ?
          LIMIT 1`,
        [input.tenantId, input.userId, input.requestContext.client_id]
      )
    : null;
  const existingActive =
    existing && (existing.expires_at === null || existing.expires_at > Date.now());
  const grantedScopes = new Set(existingActive ? existing.scope.split(/\s+/u).filter(Boolean) : []);
  const grantedClaims = new Set(
    existingActive ? parseStoredStringArray(existing.selected_claims) : []
  );
  const allRequestedGranted =
    requestedScopes.every((scope) => grantedScopes.has(scope)) &&
    requestedClaims.every((claim) => grantedClaims.has(claim.name));
  const trust = await resolveClientTrustPolicy(
    input.db as DatabaseAdapter,
    input.tenantId,
    'oidc_client',
    input.requestContext.client_id
  );
  const explicitlyTrusted = Boolean(trust?.trusted || trust?.skip_authorization_consent);
  const trustedSkip =
    explicitlyTrusted && !input.requestContext.oidc_prompt_values.includes('consent');
  const releaseSetHash = await sha256Base64Url(
    JSON.stringify({
      scopes: [...requestedScopes].sort((left, right) => left.localeCompare(right)),
      claims: requestedClaims.map((claim) => `${claim.name}:${claim.required}`),
      mapping_snapshot_hash: input.requestContext.oidc_mapping_snapshot_hash,
    })
  );
  const releaseMode = input.requestContext.oidc_release_mode;
  const grantSatisfied = Boolean(
    existingActive &&
    releaseMode !== 'every_time' &&
    allRequestedGranted &&
    (releaseMode === 'once' || existing?.release_set_hash === releaseSetHash)
  );
  const scopeRows = await input.db.query<{
    name: string;
    display_name: string;
    description: string | null;
    localizations_json: string | null;
  }>(
    `SELECT name, display_name, description, localizations_json
       FROM oidc_scopes
      WHERE enabled = 1 AND name IN (${requestedScopes.map(() => '?').join(', ') || "''"})
        AND tenant_id IN (?, 'default')
      ORDER BY CASE WHEN tenant_id = ? THEN 0 ELSE 1 END, name ASC`,
    [...requestedScopes, input.tenantId, input.tenantId]
  );
  const scopeMetadata = new Map<string, (typeof scopeRows)[number]>();
  for (const row of scopeRows) {
    if (!scopeMetadata.has(row.name)) scopeMetadata.set(row.name, row);
  }
  const baseItems = (input.policy?.items ?? []).filter((item) => !item.release_kind);
  const releaseItems: RuntimeConsentPolicyItem[] = [];
  for (const [index, name] of requestedScopes.entries()) {
    const row = scopeMetadata.get(name);
    const localizations = parseTrustedJsonObject(row?.localizations_json) ?? {};
    const localized = parseJsonRecord(localizations[language] ?? localizations.en);
    const required = name === 'openid';
    releaseItems.push({
      statement_id: `oidc:scope:${name}`,
      slug: `oidc-scope-${name}`,
      category: 'scope_claim_release',
      title: readString(localized.display_name, 500) ?? row?.display_name ?? name,
      description: readString(localized.description, 2000) ?? row?.description ?? '',
      document_url: null,
      inline_content: null,
      version: 'request-v1',
      version_id: `oidc:scope:${name}`,
      is_required: required,
      content_mode: 'checkbox',
      options: [],
      attribute_value_display: 'names',
      attribute_display_values: [],
      checkbox_mode: required ? 'required' : 'optional',
      checkbox_default_checked: true,
      binding_type: 'user_decision',
      binding_value: name,
      evidence_profile: 'oidc_authorization',
      language_fallback: 'en',
      display_order: 10_000 + index,
      acceptance_status: required && (grantSatisfied || trustedSkip) ? 'accepted' : 'pending',
      action_required: required && !grantSatisfied && !trustedSkip,
      accepted_at: null,
      accepted_record_id: null,
      release_kind: 'scope',
      release_name: name,
      release_locked: required,
      previously_granted: grantedScopes.has(name),
    });
  }
  for (const [index, claim] of requestedClaims.entries()) {
    const localized = localizedOidcClaim(claim.name, language);
    releaseItems.push({
      statement_id: `oidc:claim:${claim.name}`,
      slug: `oidc-claim-${claim.name}`,
      category: 'scope_claim_release',
      title: localized.title,
      description: localized.description,
      document_url: null,
      inline_content: null,
      version: 'request-v1',
      version_id: `oidc:claim:${claim.name}`,
      is_required: claim.required,
      content_mode: 'checkbox',
      options: [],
      attribute_value_display: 'names',
      attribute_display_values: [],
      checkbox_mode: claim.required ? 'required' : 'optional',
      checkbox_default_checked: true,
      binding_type: 'user_decision',
      binding_value: claim.name,
      evidence_profile: 'oidc_authorization',
      language_fallback: 'en',
      display_order: 20_000 + index,
      acceptance_status: claim.required && (grantSatisfied || trustedSkip) ? 'accepted' : 'pending',
      action_required: claim.required && !grantSatisfied && !trustedSkip,
      accepted_at: null,
      accepted_record_id: null,
      release_kind: 'claim',
      release_name: claim.name,
      release_locked: claim.required,
      previously_granted: grantedClaims.has(claim.name),
    });
  }
  const base = input.policy ?? {
    id: OIDC_RELEASE_POLICY_ID,
    display_name: language === 'ja' ? '提供する情報' : 'Information to share',
    description:
      language === 'ja'
        ? 'このサービスへ提供する権限と情報を確認してください。'
        : 'Review the permissions and information shared with this service.',
    language,
    default_language: 'en',
    items: [],
    gate_kind: 'oidc_authorization' as const,
    policy_id: OIDC_RELEASE_POLICY_ID,
    policy_satisfied: false,
    force_interaction: false,
    release_set_hash: null,
    release_mode: null,
    release_current_state: null,
    release_existing_set_hash: null,
  };
  return {
    ...base,
    items: [...baseItems, ...releaseItems],
    gate_kind: 'oidc_authorization',
    policy_satisfied:
      baseItems
        .filter((item) => item.is_required)
        .every((item) => item.acceptance_status === 'accepted') &&
      (grantSatisfied || trustedSkip),
    force_interaction: input.requestContext.oidc_prompt_values.includes('consent'),
    release_set_hash: releaseSetHash,
    release_mode: releaseMode,
    release_current_state: grantSatisfied || trustedSkip ? 'granted' : null,
    release_existing_set_hash: existingActive ? existing.release_set_hash : null,
  };
}

export async function resolveSamlReleasePolicyContent(input: {
  db: RuntimeConsentQueryStore;
  tenantId: string;
  requestContext: FlowRequestContext;
  policy: RuntimeConsentPolicyContent | null;
  userId?: string | null;
}): Promise<RuntimeConsentPolicyContent | null> {
  if (
    input.requestContext.protocol !== 'saml' ||
    !input.requestContext.saml_sp_id ||
    input.requestContext.target_type !== 'saml_sp'
  ) {
    return input.policy;
  }
  const language = requestedLanguage(input.requestContext);
  const releaseHash = input.requestContext.saml_release_set_hash;
  const mode = input.requestContext.saml_release_mode ?? 'once';
  const summaries = input.requestContext.saml_release_attributes;
  const base = input.policy ?? {
    id: SAML_RELEASE_POLICY_ID,
    display_name: language === 'ja' ? '属性の提供' : 'Attribute release',
    description:
      language === 'ja'
        ? 'このサービスへ提供する属性を確認してください。'
        : 'Review the attributes shared with this service.',
    language,
    default_language: 'en',
    items: [],
    gate_kind: 'saml_attribute_release' as const,
    policy_id: SAML_RELEASE_POLICY_ID,
    policy_satisfied: false,
    force_interaction: false,
    release_set_hash: null,
    release_mode: null,
    release_current_state: null,
    release_existing_set_hash: null,
  };
  const baseItems = base.items.filter((item) => !item.release_kind);
  if (!releaseHash || summaries.length === 0) {
    return {
      ...base,
      items: baseItems.map((item) => ({
        ...item,
        acceptance_status: 'accepted' as const,
        action_required: false,
      })),
      policy_satisfied: true,
      release_set_hash: null,
      release_mode: null,
      release_current_state: null,
      release_existing_set_hash: null,
    };
  }
  const existing = input.userId
    ? await input.db.queryOne<{
        attribute_set_hash: string;
        consent_state: string;
        expires_at: number | null;
      }>(
        `SELECT attribute_set_hash, consent_state, expires_at
           FROM attribute_release_consents
          WHERE tenant_id = ? AND subject_id = ? AND destination_type = 'saml_sp'
            AND destination_id = ? AND consent_state = 'granted'
          ORDER BY last_confirmed_at DESC, updated_at DESC
          LIMIT 1`,
        [input.tenantId, input.userId, input.requestContext.saml_sp_id]
      )
    : null;
  const existingActive =
    existing && (existing.expires_at === null || existing.expires_at > Date.now());
  const grantSatisfied = Boolean(
    existingActive &&
    mode !== 'every_time' &&
    (mode === 'once' || existing.attribute_set_hash === releaseHash)
  );
  const trust = await resolveClientTrustPolicy(
    input.db as DatabaseAdapter,
    input.tenantId,
    'saml_sp',
    input.requestContext.saml_sp_id
  );
  const trustedSkip = Boolean(trust?.trusted || trust?.skip_authorization_consent);
  const releaseItems = summaries.flatMap((summary, index) => {
    const name = readString(summary.name, 1000);
    if (!name) return [];
    const title = readString(summary.friendlyName, 500) ?? name;
    const description =
      readString(summary.description, 2000) ??
      (language === 'ja'
        ? `${title} をこのサービスへ提供します。`
        : `Share ${title} with this service.`);
    const required = summary.required === true;
    const valueDisplay = normalizeRuntimeAttributeValueDisplay(
      summary.valueDisplay,
      'saml_attribute_release_confirmation'
    );
    const displayValues = Array.isArray(summary.displayValues)
      ? summary.displayValues.filter((value): value is string => typeof value === 'string')
      : [];
    return [
      {
        statement_id: `saml:attribute:${name}`,
        slug: `saml-attribute-${name}`,
        category: 'attribute_release',
        title,
        description,
        document_url: null,
        inline_content: null,
        version: 'request-v1',
        version_id: `saml:attribute:${name}`,
        is_required: required,
        content_mode: 'checkbox' as const,
        options: [],
        attribute_value_display: valueDisplay,
        attribute_display_values: valueDisplay === 'names' ? [] : displayValues,
        checkbox_mode: required ? ('required' as const) : ('optional' as const),
        checkbox_default_checked: true,
        binding_type: 'user_decision',
        binding_value: name,
        evidence_profile: 'saml_attribute_release',
        language_fallback: 'en',
        display_order: 10_000 + index,
        acceptance_status:
          required && (grantSatisfied || trustedSkip)
            ? ('accepted' as const)
            : ('pending' as const),
        action_required: required && !grantSatisfied && !trustedSkip,
        accepted_at: null,
        accepted_record_id: null,
        release_kind: 'attribute' as const,
        release_name: name,
        release_locked: required,
        previously_granted: grantSatisfied,
      } satisfies RuntimeConsentPolicyItem,
    ];
  });
  return {
    ...base,
    items: [...baseItems, ...releaseItems],
    gate_kind: 'saml_attribute_release',
    policy_satisfied:
      baseItems
        .filter((item) => item.is_required)
        .every((item) => item.acceptance_status === 'accepted') &&
      (grantSatisfied || trustedSkip),
    force_interaction: false,
    release_set_hash: releaseHash,
    release_mode: mode,
    release_current_state: grantSatisfied || trustedSkip ? 'granted' : null,
    release_existing_set_hash: existingActive ? existing.attribute_set_hash : null,
  };
}

function readConsentGateKind(config: Record<string, unknown>): ConsentGateKind | null {
  const value = readString(config.consent_gate_kind, 64);
  return value === 'legal_document' ||
    value === 'oidc_authorization' ||
    value === 'saml_attribute_release'
    ? value
    : null;
}

function readConsentGateNodeConfig(config: Record<string, unknown>): ConsentGateNodeConfig {
  const policyResolution = readString(config.policy_resolution, 64);
  return {
    consent_gate_kind: readConsentGateKind(config) ?? undefined,
    policy_resolution:
      policyResolution === 'fixed' || policyResolution === 'target_binding'
        ? policyResolution
        : undefined,
    consent_policy_ref: readString(config.consent_policy_ref, 200) ?? undefined,
    fallback_policy_ref: readString(config.fallback_policy_ref, 200) ?? undefined,
    policy_required: config.policy_required === true,
  };
}

async function resolveRuntimeConsentPolicyId(input: {
  db: DatabaseAdapter;
  tenantId: string;
  config: Record<string, unknown>;
  requestContext: FlowRequestContext;
}): Promise<{ policyId: string | null; gateKind: ConsentGateKind | null }> {
  const gateKind = readConsentGateKind(input.config);
  if (!gateKind) {
    return {
      policyId: readString(input.config.consent_policy_ref, 200),
      gateKind: null,
    };
  }
  if (
    (gateKind === 'oidc_authorization' && input.requestContext.protocol !== 'oidc') ||
    (gateKind === 'saml_attribute_release' && input.requestContext.protocol !== 'saml')
  ) {
    return { policyId: null, gateKind };
  }
  try {
    const resolved = await resolveConsentGatePolicyBinding({
      repository: new ConsentGatePolicyBindingRepository(input.db),
      tenantId: input.tenantId,
      nodeConfig: readConsentGateNodeConfig(input.config),
      gateKind,
      targetType:
        input.requestContext.target_type === 'oidc_client' ||
        input.requestContext.target_type === 'saml_sp'
          ? input.requestContext.target_type
          : 'tenant',
      targetId:
        input.requestContext.target_type === 'oidc_client' ||
        input.requestContext.target_type === 'saml_sp'
          ? input.requestContext.target_id
          : null,
    });
    return { policyId: resolved.policyId, gateKind };
  } catch (error) {
    if (error instanceof ConsentGatePolicyConfigurationError) {
      return { policyId: null, gateKind };
    }
    throw error;
  }
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

      const configuredPolicyId = readString(config.consent_policy_ref, 200);
      if (step.component === 'consent_policy' || configuredPolicyId) {
        const { policyId, gateKind } = await resolveRuntimeConsentPolicyId({
          db,
          tenantId,
          config,
          requestContext,
        });
        const resolvedPolicy = policyId
          ? await resolveRuntimeConsentPolicyContent(
              db,
              tenantId,
              policyId,
              requestContext,
              gateKind
            )
          : null;
        const policy =
          gateKind === 'oidc_authorization'
            ? await resolveOidcReleasePolicyContent({
                db,
                tenantId,
                requestContext,
                policy: resolvedPolicy,
              })
            : gateKind === 'saml_attribute_release'
              ? await resolveSamlReleasePolicyContent({
                  db,
                  tenantId,
                  requestContext,
                  policy: resolvedPolicy,
                })
              : resolvedPolicy;
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

function parseTrustedJsonObject(value: unknown): FlowRuntimeJsonObject | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as FlowRuntimeJsonObject;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as FlowRuntimeJsonObject)
      : null;
  } catch {
    return null;
  }
}

function parseTrustedStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .filter((item): item is string => typeof item === 'string')
          .flatMap((item) => parseStringList(item))
      ),
    ];
  }
  return parseStringList(value);
}

function normalizeOidcPrompt(value: unknown): {
  raw: string | null;
  values: string[];
  valid: boolean;
} {
  const raw = readOptionalString(value, 200);
  if (!raw) return { raw: null, values: [], valid: true };
  const values = [...new Set(raw.split(/\s+/u).filter(Boolean))];
  const allowed = new Set(['none', 'login', 'consent', 'select_account']);
  return {
    raw: values.join(' '),
    values,
    valid:
      values.every((promptValue) => allowed.has(promptValue)) &&
      !(values.includes('none') && values.length > 1),
  };
}

function createUntrustedRequestContext(
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
    oidc_redirect_uri: null,
    oidc_resources: [],
    oidc_claims: null,
    oidc_identity_mapping: null,
    oidc_mapping_claims: [],
    oidc_mapping_snapshot_hash: null,
    oidc_release_mode: 'once',
    oidc_prompt: null,
    oidc_prompt_values: [],
    oidc_authorization_request_source: null,
    oidc_authorization_request_integrity_protected: false,
    oidc_challenge_type: null,
    saml_acs_url: null,
    saml_requested_attributes: [],
    saml_identity_mapping: null,
    saml_release_attributes: [],
    saml_release_set_hash: null,
    saml_release_mode: null,
  };
}

async function resolveTrustedOidcRequestContext(
  c: AuthContext,
  tenantId: string,
  target: ResolvedTarget,
  requestContext: FlowRequestContext
): Promise<{ context?: FlowRequestContext; target?: ResolvedTarget; error?: Response }> {
  const challengeId = requestContext.authorization_challenge_id;
  if (!challengeId) {
    return {
      context:
        requestContext.protocol === 'oidc'
          ? {
              ...requestContext,
              // OIDC scope is authoritative only when restored from an authorization challenge.
              requested_scope: [],
            }
          : requestContext,
    };
  }

  if (requestContext.protocol !== 'oidc' || !target.clientId) {
    return {
      error: jsonError(
        c,
        400,
        'invalid_authorization_challenge',
        'Authorization challenge can only be used with an OIDC client Flow target',
        'AR_FLOW_AUTH_CHALLENGE_INVALID'
      ),
    };
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
    challenge.expiresAt <= Date.now() ||
    challenge.id !== challengeId ||
    challenge.challenge !== challengeId ||
    (challenge.type !== 'login' && challenge.type !== 'reauth' && challenge.type !== 'consent')
  ) {
    return {
      error: jsonError(
        c,
        400,
        'invalid_authorization_challenge',
        'Authorization challenge is invalid or expired',
        'AR_FLOW_AUTH_CHALLENGE_INVALID'
      ),
    };
  }

  const challengeClientId = readOptionalString(challenge.metadata?.client_id, 200);
  if (!challengeClientId || challengeClientId !== target.clientId) {
    return {
      error: jsonError(
        c,
        403,
        'authorization_challenge_mismatch',
        'Authorization challenge does not match the requested client',
        'AR_FLOW_AUTH_CHALLENGE_MISMATCH'
      ),
    };
  }

  const metadataTenantId = readOptionalString(challenge.metadata?.tenant_id, 200);
  if (metadataTenantId && metadataTenantId !== tenantId) {
    return {
      error: jsonError(
        c,
        403,
        'authorization_challenge_mismatch',
        'Authorization challenge does not match the requested tenant',
        'AR_FLOW_AUTH_CHALLENGE_MISMATCH'
      ),
    };
  }

  if (challenge.type === 'reauth' || challenge.type === 'consent') {
    const session = await getCurrentSession(c, tenantId);
    const expectedUserId =
      readOptionalString(challenge.metadata?.sessionUserId, 200) ??
      readOptionalString(challenge.userId, 200);
    if (!session || !expectedUserId || session.userId !== expectedUserId) {
      return {
        error: jsonError(
          c,
          403,
          'authorization_challenge_subject_mismatch',
          'Authorization challenge does not match the active session subject',
          'AR_FLOW_AUTH_CHALLENGE_SUBJECT_MISMATCH'
        ),
      };
    }
  }

  const prompt = normalizeOidcPrompt(challenge.metadata?.prompt);
  if (!prompt.valid) {
    return {
      error: jsonError(
        c,
        400,
        'invalid_authorization_challenge',
        'Authorization challenge contains an invalid prompt parameter',
        'AR_FLOW_AUTH_CHALLENGE_INVALID'
      ),
    };
  }
  const rawClaims = challenge.metadata?.claims;
  const claims = parseTrustedJsonObject(rawClaims);
  if (rawClaims !== undefined && rawClaims !== null && rawClaims !== '' && !claims) {
    return {
      error: jsonError(
        c,
        400,
        'invalid_authorization_challenge',
        'Authorization challenge contains an invalid claims parameter',
        'AR_FLOW_AUTH_CHALLENGE_INVALID'
      ),
    };
  }

  const identityMapping = parseTrustedJsonObject(challenge.metadata?.identity_mapping);
  const releasePolicy = parseTrustedJsonObject(challenge.metadata?.attribute_release_consent);
  const releaseMode =
    releasePolicy?.enabled === true &&
    (releasePolicy.mode === 'once' ||
      releasePolicy.mode === 'every_time' ||
      releasePolicy.mode === 'until_attributes_change')
      ? releasePolicy.mode
      : 'once';
  let mappingClaims: string[] = [];
  let mappingSnapshotHash: string | null = null;
  try {
    const coreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    const mappingAdapter = c.env.DB_ADMIN
      ? requireDedicatedAdminDatabaseAdapter(c.env, 'oidc-consent-release-mapping')
      : coreAdapter;
    const binding = await resolveRuntimeIdentityMappingBinding(mappingAdapter, {
      tenantId,
      protocol: 'oidc',
      role: 'op',
      fieldMappingSetId: readOptionalString(identityMapping?.fieldMappingSetId, 200) ?? undefined,
      fieldMappingVersionId:
        readOptionalString(identityMapping?.fieldMappingVersionId, 200) ?? undefined,
      partnerEntityId: challengeClientId,
      clientId: challengeClientId,
    });
    if (binding) {
      const destinationNamespace =
        readOptionalString(identityMapping?.destinationNamespace, 200) ??
        binding.destinationNamespace ??
        'oidc.claim';
      const claimNames = new Set<string>();
      const collect = (
        ref: { side?: unknown; namespace?: unknown; path?: unknown } | undefined
      ) => {
        if (
          ref?.side === 'destination' &&
          ref.namespace === destinationNamespace &&
          typeof ref.path === 'string' &&
          ref.path.trim()
        ) {
          claimNames.add(ref.path.trim());
        }
      };
      for (const edge of binding.edges) collect(edge.targetRef);
      for (const transform of binding.transforms) collect(transform.outputTargetRef);
      for (const rule of binding.fieldMappingSet.rules) collect(rule.targetRef);
      mappingClaims = [...claimNames].sort((left, right) => left.localeCompare(right));
      mappingSnapshotHash = binding.mappingSnapshotHash;
    }
  } catch (error) {
    if (readOptionalString(identityMapping?.fieldMappingSetId, 200)) {
      return {
        error: jsonError(
          c,
          409,
          'invalid_client_configuration',
          'OIDC identity mapping cannot be resolved for consent',
          'AR_FLOW_OIDC_IDENTITY_MAPPING_INVALID'
        ),
      };
    }
  }

  return {
    target: {
      targetType: 'oidc_client',
      targetId: challengeClientId,
      clientId: challengeClientId,
      samlSpId: null,
    },
    context: {
      ...requestContext,
      client_id: challengeClientId,
      target_type: 'oidc_client',
      target_id: challengeClientId,
      requested_scope: parseTrustedStringList(challenge.metadata?.scope),
      locale:
        readOptionalString(challenge.metadata?.ui_locales, 64)?.split(/\s+/u)[0] ??
        requestContext.locale,
      oidc_redirect_uri: readOptionalString(challenge.metadata?.redirect_uri, 2048),
      oidc_resources: parseTrustedStringList(challenge.metadata?.resource),
      oidc_claims: claims,
      oidc_identity_mapping: identityMapping,
      oidc_mapping_claims: mappingClaims,
      oidc_mapping_snapshot_hash: mappingSnapshotHash,
      oidc_release_mode: releaseMode,
      oidc_prompt: prompt.raw,
      oidc_prompt_values: prompt.values,
      oidc_authorization_request_source: readOptionalString(
        challenge.metadata?.authorization_request_source,
        100
      ),
      oidc_authorization_request_integrity_protected:
        challenge.metadata?.authorization_request_integrity_protected === true,
      oidc_challenge_type: challenge.type,
    },
  };
}

async function resolveTrustedSamlRequestContext(
  c: AuthContext,
  tenantId: string,
  target: ResolvedTarget,
  requestContext: FlowRequestContext
): Promise<{ context?: FlowRequestContext; target?: ResolvedTarget; error?: Response }> {
  if (!requestContext.saml_request_id) return { context: requestContext };
  const spHint = requestContext.saml_sp_entity_id ?? target.samlSpId;
  if (requestContext.protocol !== 'saml' || !spHint || !target.samlSpId) {
    return {
      error: jsonError(
        c,
        403,
        'saml_request_mismatch',
        'Stored SAML request does not match the requested Service Provider',
        'AR_FLOW_SAML_REQUEST_MISMATCH'
      ),
    };
  }
  try {
    const storeId = c.env.SAML_REQUEST_STORE.idFromName(
      buildSAMLRequestStoreInstanceName(tenantId, 'idp', spHint)
    );
    const store = c.env.SAML_REQUEST_STORE.get(storeId);
    const response = await store.fetch(
      `https://saml-request-store/request/${encodeURIComponent(requestContext.saml_request_id)}`
    );
    if (!response.ok) throw new Error('missing');
    const stored = (await response.json()) as SAMLRequestData;
    const authnRequest = stored.data as SAMLAuthnRequest | undefined;
    const flowProtocol = stored.context?.loginFlowProtocol;
    const releaseChallenge = stored.context?.attributeReleaseConsentChallenge;
    const requestAcs = authnRequest?.assertionConsumerServiceURL;
    if (
      stored.used ||
      stored.expiresAt <= Date.now() ||
      stored.type !== 'authn_request' ||
      stored.requestId !== requestContext.saml_request_id ||
      stored.issuer !== spHint ||
      !authnRequest ||
      authnRequest.id !== stored.requestId ||
      authnRequest.issuer !== stored.issuer ||
      (stored.acsUrl && requestAcs && stored.acsUrl !== requestAcs) ||
      (flowProtocol &&
        (flowProtocol.tenantId !== tenantId ||
          flowProtocol.requestId !== stored.requestId ||
          flowProtocol.spEntityId !== stored.issuer ||
          (flowProtocol.acsUrl && stored.acsUrl && flowProtocol.acsUrl !== stored.acsUrl))) ||
      (releaseChallenge &&
        (releaseChallenge.destinationType !== 'saml_sp' ||
          releaseChallenge.destinationId !== stored.issuer ||
          !releaseChallenge.attributeSetHash ||
          Date.now() - releaseChallenge.createdAt > 10 * 60 * 1000))
    ) {
      throw new Error('mismatch');
    }
    return {
      target: {
        targetType: 'saml_sp',
        targetId: stored.issuer,
        clientId: null,
        samlSpId: stored.issuer,
      },
      context: {
        ...requestContext,
        target_type: 'saml_sp',
        target_id: stored.issuer,
        saml_sp_id: stored.issuer,
        saml_sp_entity_id: stored.issuer,
        return_to: 'saml_sso',
        requested_scope: [],
        saml_acs_url: flowProtocol?.acsUrl ?? stored.acsUrl ?? requestAcs ?? null,
        saml_requested_attributes: (flowProtocol?.requestedAttributes ?? []).map(
          (attribute) => ({ ...attribute }) as FlowRuntimeJsonObject
        ),
        saml_identity_mapping: flowProtocol?.identityMapping
          ? ({ ...flowProtocol.identityMapping } as FlowRuntimeJsonObject)
          : null,
        saml_release_attributes: (
          stored.context?.attributeReleaseConsentChallenge?.attributeSummaries ?? []
        ).map((attribute) => ({ ...attribute }) as FlowRuntimeJsonObject),
        saml_release_set_hash:
          stored.context?.attributeReleaseConsentChallenge?.attributeSetHash ?? null,
        saml_release_mode: stored.context?.attributeReleaseConsentChallenge?.consentMode ?? null,
      },
    };
  } catch {
    return {
      error: jsonError(
        c,
        400,
        'invalid_saml_request',
        'Stored SAML request is invalid, expired, or already used',
        'AR_FLOW_SAML_REQUEST_INVALID'
      ),
    };
  }
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
    oidc_redirect_uri: readOptionalString(raw.oidc_redirect_uri, 2048),
    oidc_resources: parseStringList(raw.oidc_resources),
    oidc_claims: parseTrustedJsonObject(raw.oidc_claims),
    oidc_identity_mapping: parseTrustedJsonObject(raw.oidc_identity_mapping),
    oidc_mapping_claims: parseStringList(raw.oidc_mapping_claims),
    oidc_mapping_snapshot_hash: readOptionalString(raw.oidc_mapping_snapshot_hash, 200),
    oidc_release_mode:
      raw.oidc_release_mode === 'every_time' || raw.oidc_release_mode === 'until_attributes_change'
        ? raw.oidc_release_mode
        : 'once',
    oidc_prompt: readOptionalString(raw.oidc_prompt, 200),
    oidc_prompt_values: parseStringList(raw.oidc_prompt_values),
    oidc_authorization_request_source: readOptionalString(
      raw.oidc_authorization_request_source,
      100
    ),
    oidc_authorization_request_integrity_protected:
      raw.oidc_authorization_request_integrity_protected === true,
    oidc_challenge_type:
      raw.oidc_challenge_type === 'login' ||
      raw.oidc_challenge_type === 'reauth' ||
      raw.oidc_challenge_type === 'consent'
        ? raw.oidc_challenge_type
        : null,
    saml_acs_url: readOptionalString(raw.saml_acs_url, 2048),
    saml_requested_attributes: Array.isArray(raw.saml_requested_attributes)
      ? raw.saml_requested_attributes.filter(
          (item): item is FlowRuntimeJsonObject =>
            Boolean(item) && typeof item === 'object' && !Array.isArray(item)
        )
      : [],
    saml_identity_mapping: parseTrustedJsonObject(raw.saml_identity_mapping),
    saml_release_attributes: Array.isArray(raw.saml_release_attributes)
      ? raw.saml_release_attributes.filter(
          (value): value is FlowRuntimeJsonObject =>
            Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        )
      : [],
    saml_release_set_hash: readOptionalString(raw.saml_release_set_hash, 200),
    saml_release_mode:
      raw.saml_release_mode === 'once' ||
      raw.saml_release_mode === 'every_time' ||
      raw.saml_release_mode === 'until_attributes_change'
        ? raw.saml_release_mode
        : null,
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
  if (edges.length === 1) {
    return stepMatchesRequestProtocol(
      findRuntimeStepBySourceNode(runtime, edges[0].target),
      requestContext
    )
      ? edges[0]
      : null;
  }

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

function runtimeConsentReleaseState(policy: RuntimeConsentPolicyContent | null) {
  if (!policy?.release_set_hash || !policy.release_mode) return null;
  return {
    mode: policy.release_mode,
    currentSetHash: policy.release_set_hash,
    existingState: policy.release_current_state ?? null,
    existingSetHash: policy.release_existing_set_hash ?? null,
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
    protocol:
      requestContext.protocol === 'oidc' ||
      requestContext.protocol === 'saml' ||
      requestContext.protocol === 'direct'
        ? requestContext.protocol
        : undefined,
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
  tenantId: string,
  requestContext: FlowRequestContext
): Promise<{ selectedHandle: 'continue' | 'authenticate'; userId: string | null }> {
  if (
    requestContext.oidc_challenge_type === 'reauth' ||
    requestContext.oidc_prompt_values.includes('login')
  ) {
    return { selectedHandle: 'authenticate', userId: null };
  }
  const session = await getCurrentSession(c, tenantId);
  return {
    selectedHandle: session?.userId ? 'continue' : 'authenticate',
    userId: session?.userId ?? null,
  };
}

function getStepStateForRuntimeStep(step: FlowRuntimeStep): 'pending' | 'waiting_input' {
  return step.render === false ? 'pending' : 'waiting_input';
}

function runtimeStepWaitingStateJson(step: FlowRuntimeStep): string | null {
  const policy = readRuntimeConsentPolicyContent(step);
  if (!policy) return null;
  return JSON.stringify({
    consent_render_snapshot: {
      policy_id: policy.id,
      gate_kind: policy.gate_kind,
      release_set_hash: policy.release_set_hash,
      release_current_state: policy.release_current_state,
      release_existing_set_hash: policy.release_existing_set_hash,
      items: policy.items.map((item) => ({
        statement_id: item.statement_id,
        version: item.version,
        acceptance_status: item.acceptance_status,
      })),
    },
  });
}

function readConsentRenderSnapshot(value: string | null): {
  policy_id: string;
  gate_kind: ConsentGateKind | null;
  release_set_hash: string | null;
  release_current_state: 'granted' | 'denied' | 'revoked' | 'expired' | null;
  release_existing_set_hash: string | null;
  items: Array<{
    statement_id: string;
    version: string;
    acceptance_status: 'accepted' | 'pending';
  }>;
} | null {
  const state = parseJsonRecord(value);
  const snapshot = parseJsonRecord(state.consent_render_snapshot);
  const policyId = readString(snapshot.policy_id, 200);
  if (!policyId || !Array.isArray(snapshot.items)) return null;
  const items = snapshot.items.flatMap((value) => {
    const item = parseJsonRecord(value);
    const statementId = readString(item.statement_id, 200);
    const version = readString(item.version, 200);
    const acceptanceStatus = readString(item.acceptance_status, 32);
    return statementId &&
      version &&
      (acceptanceStatus === 'accepted' || acceptanceStatus === 'pending')
      ? [
          {
            statement_id: statementId,
            version,
            acceptance_status: acceptanceStatus as 'accepted' | 'pending',
          },
        ]
      : [];
  });
  if (items.length !== snapshot.items.length) return null;
  const gateKindValue = readString(snapshot.gate_kind, 64);
  const gateKind =
    gateKindValue === 'legal_document' ||
    gateKindValue === 'oidc_authorization' ||
    gateKindValue === 'saml_attribute_release'
      ? gateKindValue
      : null;
  const releaseCurrentStateValue = readString(snapshot.release_current_state, 32);
  const releaseCurrentState =
    releaseCurrentStateValue === 'granted' ||
    releaseCurrentStateValue === 'denied' ||
    releaseCurrentStateValue === 'revoked' ||
    releaseCurrentStateValue === 'expired'
      ? releaseCurrentStateValue
      : null;
  return {
    policy_id: policyId,
    gate_kind: gateKind,
    release_set_hash: readString(snapshot.release_set_hash, 200) ?? null,
    release_current_state: releaseCurrentState,
    release_existing_set_hash: readString(snapshot.release_existing_set_hash, 200) ?? null,
    items,
  };
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
  requestContext: FlowRequestContext;
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
    return resolveSessionCheckSelectedHandle(input.c, input.tenantId, input.requestContext);
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
  consentGateReceiptId?: string;
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
      consent_gate_receipt_id: input.consentGateReceiptId ?? null,
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
}): Promise<{ redirectUrl?: string; consentGateReceiptId?: string; response?: Response }> {
  if (input.requestContext.protocol === 'saml' && input.requestContext.saml_request_id) {
    const samlReceipt = await input.db.queryOne<{ id: string }>(
      `SELECT id FROM consent_gate_decision_receipts
        WHERE tenant_id = ? AND interaction_id = ? AND gate_kind = 'saml_attribute_release'
          AND target_type = 'saml_sp' AND target_id = ? AND protocol_request_id = ?
          AND state = 'ready' AND expires_at > ?
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [
        input.tenantId,
        input.interaction.id,
        input.requestContext.saml_sp_id,
        input.requestContext.saml_request_id,
        nowSeconds(),
      ]
    );
    return { consentGateReceiptId: samlReceipt?.id };
  }
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

  const oidcReceipt = await input.db.queryOne<{ id: string }>(
    `SELECT id
       FROM consent_gate_decision_receipts
      WHERE tenant_id = ? AND interaction_id = ? AND gate_kind = 'oidc_authorization'
        AND subject_user_id = ? AND target_type = 'oidc_client' AND target_id = ?
        AND protocol_request_id = ? AND state = 'ready' AND expires_at > ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [
      input.tenantId,
      input.interaction.id,
      userId,
      input.requestContext.client_id,
      input.requestContext.authorization_challenge_id,
      nowSeconds(),
    ]
  );

  const continuation = await consumeAuthorizationChallengeContinuation(
    input.c.env,
    input.tenantId,
    input.requestContext.authorization_challenge_id,
    userId,
    getSessionAuthTime(session),
    getRequestOrigin(input.c),
    oidcReceipt?.id
  );
  if ('error' in continuation) {
    return { response: continuation.error };
  }
  return {
    redirectUrl: continuation.redirectUrl,
    consentGateReceiptId: oidcReceipt?.id,
  };
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

async function findActiveAcceptedConsentRecord(input: {
  db: RuntimeConsentQueryStore;
  tenantId: string;
  interaction: FlowInteractionRow;
  requestContext: FlowRequestContext;
  userId: string;
  policyId: string;
  item: RuntimeConsentPolicyItem;
}): Promise<{ id: string; accepted_at: number } | null> {
  if (input.item.acceptance_status === 'accepted' && input.item.accepted_record_id) {
    return {
      id: input.item.accepted_record_id,
      accepted_at: input.item.accepted_at ?? 0,
    };
  }
  const { recipientType, recipientId } = consentRecordRecipient(input);
  const bindingType = normalizeConsentRecordBindingType(
    input.item.binding_type,
    input.requestContext
  );
  const protocol =
    input.requestContext.protocol === 'direct' ? 'custom' : input.requestContext.protocol;
  const now = nowSeconds();
  return input.db.queryOne<{ id: string; accepted_at: number }>(
    `SELECT id, created_at AS accepted_at
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
}

async function annotateRuntimeConsentItems(input: {
  db: RuntimeConsentQueryStore;
  tenantId: string;
  interaction: FlowInteractionRow;
  requestContext: FlowRequestContext;
  userId: string | null;
  step: FlowRuntimeStep;
}): Promise<FlowRuntimeStep> {
  if (input.step.component !== 'consent_policy') return input.step;
  const policy = readRuntimeConsentPolicyContent(input.step);
  if (!policy) return input.step;
  if (!input.userId) {
    const anonymousPolicy =
      policy.gate_kind === 'oidc_authorization'
        ? await resolveOidcReleasePolicyContent({
            db: input.db,
            tenantId: input.tenantId,
            requestContext: input.requestContext,
            policy,
          })
        : policy.gate_kind === 'saml_attribute_release'
          ? await resolveSamlReleasePolicyContent({
              db: input.db,
              tenantId: input.tenantId,
              requestContext: input.requestContext,
              policy,
            })
          : policy;
    return withRuntimeConsentPolicyContent(input.step, {
      ...(anonymousPolicy ?? policy),
      policy_satisfied: false,
      force_interaction:
        policy.gate_kind === 'oidc_authorization' &&
        input.requestContext.oidc_prompt_values.includes('consent'),
    });
  }
  const annotatedItems: RuntimeConsentPolicyItem[] = [];
  for (const item of policy.items.filter((candidate) => !candidate.release_kind)) {
    const accepted =
      policy.gate_kind === 'legal_document'
        ? await new DocumentAcknowledgmentRepository(input.db).findActive({
            tenant_id: input.tenantId,
            subject_user_id: input.userId,
            consent_kind: normalizeConsentRecordKind(item.category),
            statement_id: item.statement_id,
            statement_version: item.version,
            now: nowSeconds(),
          })
        : await findActiveAcceptedConsentRecord({
            db: input.db,
            tenantId: input.tenantId,
            interaction: input.interaction,
            requestContext: input.requestContext,
            userId: input.userId,
            policyId: policy.id,
            item,
          });
    annotatedItems.push({
      ...item,
      acceptance_status: accepted ? 'accepted' : 'pending',
      action_required: !accepted && item.is_required,
      accepted_at: accepted?.accepted_at ?? null,
      accepted_record_id:
        accepted && 'latest_evidence_record_id' in accepted
          ? accepted.latest_evidence_record_id
          : (accepted?.id ?? null),
    });
  }
  const policySatisfied = annotatedItems
    .filter((item) => item.is_required)
    .every((item) => item.acceptance_status === 'accepted');
  const annotatedPolicy: RuntimeConsentPolicyContent = {
    ...policy,
    items: annotatedItems,
    policy_satisfied: policySatisfied,
    force_interaction:
      policy.gate_kind === 'oidc_authorization' &&
      input.requestContext.oidc_prompt_values.includes('consent'),
  };
  const effectivePolicy =
    policy.gate_kind === 'oidc_authorization'
      ? await resolveOidcReleasePolicyContent({
          db: input.db,
          tenantId: input.tenantId,
          requestContext: input.requestContext,
          policy: annotatedPolicy,
          userId: input.userId,
        })
      : policy.gate_kind === 'saml_attribute_release'
        ? await resolveSamlReleasePolicyContent({
            db: input.db,
            tenantId: input.tenantId,
            requestContext: input.requestContext,
            policy: annotatedPolicy,
            userId: input.userId,
          })
        : annotatedPolicy;
  return withRuntimeConsentPolicyContent(input.step, effectivePolicy ?? annotatedPolicy);
}

async function preflightPromptNoneConsentGates(input: {
  c: AuthContext;
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  runtime: FlowRuntimeContract;
  requestContext: FlowRequestContext;
  verifiedSubjectUserId?: string;
}): Promise<{
  status: 400 | 409;
  error: string;
  description: string;
  errorCode: string;
} | null> {
  if (
    input.requestContext.protocol !== 'oidc' ||
    !input.requestContext.oidc_prompt_values.includes('none')
  ) {
    return null;
  }
  const subjectUserId =
    input.verifiedSubjectUserId ?? (await getCurrentSession(input.c, input.tenantId))?.userId;
  if (!subjectUserId) {
    return {
      status: 400,
      error: 'login_required',
      description: 'prompt=none requires an active authenticated session',
      errorCode: 'AR_FLOW_PROMPT_NONE_LOGIN_REQUIRED',
    };
  }
  for (const step of input.runtime.ui.steps) {
    if (step.component !== 'consent_policy') continue;
    const gateKind = readConsentGateKind(parseJsonRecord(step.config));
    if (!gateKind) continue;
    if (
      (gateKind === 'oidc_authorization' || gateKind === 'saml_attribute_release') &&
      !(await isTenantFlowProtocolConsentGatesEnabled(input.c.env, input.tenantId))
    ) {
      continue;
    }
    const annotated = await annotateRuntimeConsentItems({
      db: input.db,
      tenantId: input.tenantId,
      interaction: input.interaction,
      requestContext: input.requestContext,
      userId: subjectUserId,
      step,
    });
    const policy = readRuntimeConsentPolicyContent(annotated);
    const decision = evaluateConsentGate({
      gateKind,
      protocol: input.requestContext.protocol,
      policyResolved: policy !== null,
      policyRequired: parseJsonRecord(step.config).policy_required === true,
      oidcPrompt: input.requestContext.oidc_prompt,
      release: runtimeConsentReleaseState(policy),
      items: (policy?.items ?? []).map((item) => ({
        id: item.statement_id,
        required: item.is_required,
        acceptanceStatus: item.acceptance_status,
        actionRequired: item.action_required,
      })),
    });
    if (decision.action === 'protocol_error') {
      return {
        status: 400,
        error: decision.protocolError?.error ?? 'consent_required',
        description: decision.protocolError?.description ?? 'Consent is required',
        errorCode: 'AR_FLOW_PROMPT_NONE_CONSENT_REQUIRED',
      };
    }
    if (decision.action === 'deny') {
      return {
        status: 409,
        error: 'consent_policy_unavailable',
        description: 'A required consent policy cannot be evaluated',
        errorCode: 'AR_FLOW_CONSENT_POLICY_UNAVAILABLE',
      };
    }
  }
  return null;
}

export async function preflightOidcPromptNoneConsentGates(input: {
  c: AuthContext;
  db: DatabaseAdapter;
  tenantId: string;
  clientId: string;
  subjectUserId: string;
  requestedScope: string[];
  resources: string[];
  claims: FlowRuntimeJsonObject | null;
  redirectUri: string | null;
  authorizationRequestSource: string | null;
  authorizationRequestIntegrityProtected: boolean;
}): Promise<{
  error: 'login_required' | 'consent_required' | 'server_error';
  description: string;
} | null> {
  if (!(await isLoginRuntimeFlowEnabled(input.c.env, input.tenantId))) return null;
  const target: ResolvedTarget = {
    targetType: 'oidc_client',
    targetId: input.clientId,
    clientId: input.clientId,
    samlSpId: null,
  };
  const assignment = await resolveAssignment(input.db, input.tenantId, 'login', target);
  if (!assignment) return null;
  const version = await getPublishedVersion(input.db, input.tenantId, assignment);
  const snapshot = version ? parseRuntimeSnapshot(version.runtime_snapshot_json) : null;
  if (!version || !snapshot) {
    return { error: 'server_error', description: 'Published Login Flow is unavailable' };
  }
  const requestContext: FlowRequestContext = {
    ...createUntrustedRequestContext(target, {}),
    requested_scope: [...new Set(input.requestedScope)],
    oidc_resources: [...new Set(input.resources)],
    oidc_redirect_uri: input.redirectUri,
    oidc_claims: input.claims,
    oidc_identity_mapping: null,
    oidc_mapping_claims: [],
    oidc_mapping_snapshot_hash: null,
    oidc_release_mode: 'once',
    oidc_prompt: 'none',
    oidc_prompt_values: ['none'],
    oidc_authorization_request_source: input.authorizationRequestSource,
    oidc_authorization_request_integrity_protected: input.authorizationRequestIntegrityProtected,
  };
  const prepared = await prepareRuntimeContract({
    c: input.c,
    db: input.db,
    tenantId: input.tenantId,
    assignment,
    version,
    runtimeSnapshot: snapshot,
    requestContext,
  });
  const interaction: FlowInteractionRow = {
    id: `prompt-none-preflight:${crypto.randomUUID()}`,
    flow_id: assignment.flow_id,
    flow_version_id: version.id,
    user_id: input.subjectUserId,
    client_id: input.clientId,
    saml_sp_id: null,
    state: 'active',
    current_node_id: null,
    current_step_id: null,
    context_json: JSON.stringify(requestContext),
    contract_hash: prepared.contractHash,
    signature: '',
    expires_at: nowSeconds() + 60,
  };
  const failure = await preflightPromptNoneConsentGates({
    c: input.c,
    db: input.db,
    tenantId: input.tenantId,
    interaction,
    runtime: prepared.contract,
    requestContext,
    verifiedSubjectUserId: input.subjectUserId,
  });
  if (!failure) return null;
  return {
    error:
      failure.error === 'login_required'
        ? 'login_required'
        : failure.error === 'consent_required'
          ? 'consent_required'
          : 'server_error',
    description: failure.description,
  };
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
      requestContext: input.requestContext,
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
      const configuredGateKind = readConsentGateKind(parseJsonRecord(step.config));
      if (
        (configuredGateKind === 'oidc_authorization' ||
          configuredGateKind === 'saml_attribute_release') &&
        !(await isTenantFlowProtocolConsentGatesEnabled(input.c.env, input.tenantId))
      ) {
        autoAdvancedSteps.push({ step, selectedHandle: null, userId });
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
      const annotatedStep = await annotateRuntimeConsentItems({
        db: input.db,
        tenantId: input.tenantId,
        interaction: input.interaction,
        requestContext: input.requestContext,
        userId,
        step,
      });
      const policy = readRuntimeConsentPolicyContent(annotatedStep);
      const gateKind = readConsentGateKind(parseJsonRecord(step.config));
      if (!policy && !gateKind) {
        return { step: annotatedStep, terminalStep: null, userId, autoAdvancedSteps };
      }
      const decision = gateKind
        ? evaluateConsentGate({
            gateKind,
            protocol: input.requestContext.protocol,
            policyResolved: policy !== null,
            policyRequired: parseJsonRecord(step.config).policy_required === true,
            oidcPrompt: input.requestContext.oidc_prompt,
            release: runtimeConsentReleaseState(policy),
            items: (policy?.items ?? []).map((item) => ({
              id: item.statement_id,
              required: item.is_required,
              acceptanceStatus: item.acceptance_status,
              actionRequired: item.action_required,
            })),
          })
        : null;
      if (policy && (!decision ? !policy.policy_satisfied : decision.action === 'challenge')) {
        return { step: annotatedStep, terminalStep: null, userId, autoAdvancedSteps };
      }
      if (decision?.action === 'deny' || decision?.action === 'protocol_error') {
        if (decision.action === 'protocol_error') {
          getLogger(input.c).module('LOGIN-RUNTIME-FLOW').warn('Consent Gate protocol error', {
            action: 'consent_gate_metric',
            metric: 'protocol_error',
            gate_kind: configuredGateKind,
            reason_codes: decision.reasonCodes,
            flow_version_id: input.interaction.flow_version_id,
          });
        }
        return {
          step: null,
          terminalStep: null,
          errorCode:
            decision.action === 'protocol_error'
              ? 'AR_FLOW_CONSENT_PROTOCOL_ERROR'
              : 'AR_FLOW_CONSENT_POLICY_UNAVAILABLE',
          userId,
          autoAdvancedSteps,
        };
      }

      autoAdvancedSteps.push({
        step: annotatedStep,
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
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        generateId(),
        input.tenantId,
        input.interaction.id,
        input.nextStep.source_node_id,
        input.nextStep.id,
        getStepStateForRuntimeStep(input.nextStep),
        runtimeStepWaitingStateJson(input.nextStep),
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
  db: RuntimeConsentQueryStore;
  tenantId: string;
  interaction: FlowInteractionRow;
  step: FlowRuntimeStep;
  policy: RuntimeConsentPolicyContent;
  requestContext: FlowRequestContext;
  userId: string;
  decisions: Record<string, RuntimeConsentItemDecision>;
  consentGateReceiptId?: string;
  ipHash?: string;
  userAgent?: string;
}): Promise<string[]> {
  const now = nowSeconds();
  const evidenceRecordIds: string[] = [];
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
    const evidenceRecordId = generateId();
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
        evidenceRecordId,
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
          consent_gate_receipt_id: input.consentGateReceiptId,
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
    evidenceRecordIds.push(evidenceRecordId);
  }
  return evidenceRecordIds;
}

type LegalConsentPersistenceFailure =
  | 'render_snapshot_missing'
  | 'consent_state_changed'
  | 'consent_required'
  | 'step_not_active';

async function persistLegalConsentGate(input: {
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  stepState: FlowInteractionStepRow;
  step: FlowRuntimeStep;
  policy: RuntimeConsentPolicyContent;
  requestContext: FlowRequestContext;
  userId: string;
  decisions: Record<string, RuntimeConsentItemDecision>;
  ipHash?: string;
  userAgent?: string;
}): Promise<{ ok: true } | { ok: false; reason: LegalConsentPersistenceFailure }> {
  const rendered = readConsentRenderSnapshot(input.stepState.state_json);
  if (!rendered || rendered.gate_kind !== 'legal_document') {
    return { ok: false, reason: 'render_snapshot_missing' };
  }
  const currentInteraction = await input.db.queryOne<FlowInteractionRow>(
    `SELECT id, flow_id, flow_version_id, user_id, client_id, saml_sp_id, state,
              current_node_id, current_step_id, context_json, contract_hash, signature, expires_at
         FROM flow_interactions
        WHERE tenant_id = ? AND id = ?
        LIMIT 1`,
    [input.tenantId, input.interaction.id]
  );
  const now = nowSeconds();
  if (
    !currentInteraction ||
    currentInteraction.state !== 'active' ||
    currentInteraction.current_node_id !== input.step.source_node_id ||
    currentInteraction.current_step_id !== input.step.id ||
    currentInteraction.expires_at <= now
  ) {
    return { ok: false, reason: 'step_not_active' };
  }

  const currentPolicy = await resolveRuntimeConsentPolicyContent(
    input.db,
    input.tenantId,
    input.policy.id,
    input.requestContext,
    'legal_document'
  );
  if (!currentPolicy || rendered.policy_id !== currentPolicy.id) {
    return { ok: false, reason: 'consent_state_changed' };
  }
  const annotatedStep = await annotateRuntimeConsentItems({
    db: input.db,
    tenantId: input.tenantId,
    interaction: currentInteraction,
    requestContext: input.requestContext,
    userId: input.userId,
    step: withRuntimeConsentPolicyContent(input.step, currentPolicy),
  });
  const annotatedPolicy = readRuntimeConsentPolicyContent(annotatedStep);
  if (!annotatedPolicy || !consentSnapshotMatchesPolicy(rendered, annotatedPolicy)) {
    return { ok: false, reason: 'consent_state_changed' };
  }

  const pendingItems = annotatedPolicy.items.filter((item) => item.acceptance_status === 'pending');
  const missingRequired = pendingItems.filter(
    (item) => !consentItemInputSatisfied(item, input.decisions[item.statement_id])
  );
  if (missingRequired.length > 0) {
    return { ok: false, reason: 'consent_required' };
  }

  const acceptedPendingItems = pendingItems.filter(
    (item) => input.decisions[item.statement_id]?.decision !== 'rejected'
  );
  const statementVersionSetHash = await sha256Base64Url(
    JSON.stringify(
      annotatedPolicy.items
        .map((item) => `${item.statement_id}:${item.version}`)
        .sort((left, right) => left.localeCompare(right))
    )
  );
  const receiptDecision = evaluateConsentGate({
    gateKind: 'legal_document',
    protocol: input.requestContext.protocol,
    policyResolved: true,
    policyRequired: true,
    items: annotatedPolicy.items.map((item) => ({
      id: item.statement_id,
      required: item.is_required,
      acceptanceStatus:
        item.acceptance_status === 'accepted' ||
        acceptedPendingItems.some((accepted) => accepted.statement_id === item.statement_id)
          ? 'accepted'
          : 'pending',
      actionRequired: false,
    })),
  });
  const writeResult = await writeLegalConsentGateBatch({
    ...input,
    interaction: currentInteraction,
    policy: annotatedPolicy,
    rendered,
    acceptedPendingItems,
    statementVersionSetHash,
    receiptDecision,
    now,
  });
  if (writeResult.claimed) return { ok: true };
  const existing = await new ConsentGateDecisionReceiptRepository(
    input.db
  ).findLatestForInteractionGate({
    tenant_id: input.tenantId,
    interaction_id: input.interaction.id,
    flow_node_id: input.step.source_node_id,
    gate_kind: 'legal_document',
  });
  return existing?.state === 'ready'
    ? { ok: true }
    : { ok: false, reason: 'consent_state_changed' };
}

async function writeLegalConsentGateBatch(input: {
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  stepState: FlowInteractionStepRow;
  step: FlowRuntimeStep;
  policy: RuntimeConsentPolicyContent;
  rendered: NonNullable<ReturnType<typeof readConsentRenderSnapshot>>;
  requestContext: FlowRequestContext;
  userId: string;
  decisions: Record<string, RuntimeConsentItemDecision>;
  acceptedPendingItems: RuntimeConsentPolicyItem[];
  statementVersionSetHash: string;
  receiptDecision: ReturnType<typeof evaluateConsentGate>;
  ipHash?: string;
  userAgent?: string;
  now: number;
}): Promise<{ claimed: boolean }> {
  const claimToken = `legal-consent:${crypto.randomUUID()}`;
  const claimStateJson = JSON.stringify({ processing_claim: claimToken });
  const validationClauses = [
    `EXISTS (
       SELECT 1 FROM flow_interactions fi
        WHERE fi.tenant_id = ? AND fi.id = ? AND fi.state = 'active'
          AND fi.current_node_id = ? AND fi.current_step_id = ? AND fi.expires_at > ?
     )`,
    `EXISTS (
       SELECT 1 FROM consent_policies cp
        WHERE cp.tenant_id = ? AND cp.id = ? AND cp.is_active = 1
     )`,
  ];
  const validationParams: unknown[] = [
    input.tenantId,
    input.interaction.id,
    input.step.source_node_id,
    input.step.id,
    input.now,
    input.tenantId,
    input.policy.id,
  ];
  for (const item of input.rendered.items) {
    validationClauses.push(
      `EXISTS (
         SELECT 1
           FROM consent_policy_items cpi
           JOIN consent_statement_versions csv
             ON csv.tenant_id = cpi.tenant_id AND csv.statement_id = cpi.statement_id
          WHERE cpi.tenant_id = ? AND cpi.policy_id = ? AND cpi.statement_id = ?
            AND csv.status = 'active' AND csv.version = ?
            AND (
              (cpi.version_mode = 'fixed' AND csv.id = cpi.version_id) OR
              (cpi.version_mode <> 'fixed' AND csv.is_current = 1)
            )
       )`
    );
    validationParams.push(input.tenantId, input.policy.id, item.statement_id, item.version);
    const activeAcknowledgment = `SELECT 1 FROM document_acknowledgments_current dac
      WHERE dac.tenant_id = ? AND dac.subject_user_id = ? AND dac.consent_kind = ?
        AND dac.statement_id = ? AND dac.statement_version = ? AND dac.status = 'accepted'
        AND (dac.expires_at IS NULL OR dac.expires_at > ?)`;
    validationClauses.push(
      item.acceptance_status === 'accepted'
        ? `EXISTS (${activeAcknowledgment})`
        : `NOT EXISTS (${activeAcknowledgment})`
    );
    const policyItem = input.policy.items.find(
      (candidate) => candidate.statement_id === item.statement_id
    );
    validationParams.push(
      input.tenantId,
      input.userId,
      normalizeConsentRecordKind(policyItem?.category ?? 'custom'),
      item.statement_id,
      item.version,
      input.now
    );
  }
  if (input.rendered.items.length > 0) {
    validationClauses.push(
      `NOT EXISTS (
         SELECT 1
           FROM consent_policy_items cpi
           JOIN consent_statements cs
             ON cs.tenant_id = cpi.tenant_id AND cs.id = cpi.statement_id
          WHERE cpi.tenant_id = ? AND cpi.policy_id = ? AND cs.is_active = 1
            AND cpi.requirement <> 'hidden'
            AND (cpi.binding_type IS NULL OR cpi.binding_value IS NULL OR cpi.binding_type <> 'scope')
            AND cpi.statement_id NOT IN (${input.rendered.items.map(() => '?').join(', ')})
       )`
    );
    validationParams.push(
      input.tenantId,
      input.policy.id,
      ...input.rendered.items.map((item) => item.statement_id)
    );
  }
  appendLegalPolicyBindingValidation(input, validationClauses, validationParams);

  const receiptId = `cgr_${crypto.randomUUID().replace(/-/gu, '')}`;
  const evidenceRecordIds = input.acceptedPendingItems.map(() => generateId());
  const receiptAbsentSql = `NOT EXISTS (
    SELECT 1 FROM consent_gate_decision_receipts cgr
     WHERE cgr.tenant_id = ? AND cgr.interaction_id = ?
       AND cgr.flow_node_id = ? AND cgr.gate_kind = 'legal_document'
  )`;
  const receiptAbsentParams = [input.tenantId, input.interaction.id, input.step.source_node_id];
  const claimExistsSql = `EXISTS (
    SELECT 1 FROM flow_interaction_steps fis
     WHERE fis.tenant_id = ? AND fis.id = ? AND fis.state = 'processing' AND fis.state_json = ?
  )`;
  const claimExistsParams = [input.tenantId, input.stepState.id, claimStateJson];
  const statements: Array<{ sql: string; params: unknown[] }> = [
    {
      sql: `UPDATE flow_interaction_steps
               SET state = 'processing', state_json = ?, updated_at = ?
             WHERE tenant_id = ? AND id = ? AND state IN ('pending', 'waiting_input')
               AND ${receiptAbsentSql}
               AND ${validationClauses.join('\n               AND ')}`,
      params: [
        claimStateJson,
        input.now,
        input.tenantId,
        input.stepState.id,
        ...receiptAbsentParams,
        ...validationParams,
      ],
    },
  ];
  for (let index = 0; index < input.acceptedPendingItems.length; index += 1) {
    const item = input.acceptedPendingItems[index];
    const decision = input.decisions[item.statement_id];
    const { recipientType, recipientId } = consentRecordRecipient(input);
    const bindingType = normalizeConsentRecordBindingType(item.binding_type, input.requestContext);
    const selectedOptions = decision.selectedValue
      ? JSON.stringify([decision.selectedValue])
      : null;
    const releasedScopes =
      input.requestContext.protocol === 'oidc' && input.requestContext.requested_scope.length > 0
        ? JSON.stringify(input.requestContext.requested_scope)
        : null;
    statements.push({
      sql: `INSERT INTO consent_records (
        id, tenant_id, subject_user_id, actor_user_id, protocol, consent_kind,
        client_id, saml_sp_id, recipient_type, recipient_id, binding_type, binding_key,
        resource_type, resource_id, purpose_key, statement_id, statement_version, policy_id,
        flow_id, flow_version_id, flow_node_id, decision, selected_value, selected_options_json,
        released_scopes_json, released_claims_json, released_attributes_json, status, expires_at,
        revoked_at, evidence_json, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?
        WHERE ${claimExistsSql} AND ${receiptAbsentSql}`,
      params: [
        evidenceRecordIds[index],
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
        consentRecordResourceType(item, input.requestContext),
        item.binding_value,
        item.category,
        item.statement_id,
        item.version,
        input.policy.id,
        input.interaction.flow_id,
        input.interaction.flow_version_id,
        input.step.source_node_id,
        decision.decision,
        decision.selectedValue,
        selectedOptions,
        releasedScopes,
        null,
        null,
        'active',
        null,
        null,
        JSON.stringify({
          source: 'flow_runtime',
          consent_gate_receipt_id: receiptId,
          interaction_id: input.interaction.id,
          step_id: input.step.id,
          node_id: input.step.source_node_id,
          statement_slug: item.slug,
          statement_version_id: item.version_id,
          content_mode: item.content_mode,
          checkbox_mode: item.checkbox_mode,
          is_required: item.is_required,
          selected_value: decision.selectedValue,
          attribute_value_display: item.attribute_value_display,
          requested_scope: input.requestContext.requested_scope,
          authorization_challenge_id: input.requestContext.authorization_challenge_id,
          saml_request_id: input.requestContext.saml_request_id,
          saml_sp_entity_id: input.requestContext.saml_sp_entity_id,
          user_agent: input.userAgent,
          ip_address_hash: input.ipHash,
        }),
        input.now,
        input.now,
        ...claimExistsParams,
        ...receiptAbsentParams,
      ],
    });
    statements.push({
      sql: `INSERT INTO document_acknowledgments_current (
        tenant_id, subject_user_id, consent_kind, statement_id, statement_version, status,
        accepted_at, expires_at, withdrawn_at, latest_evidence_record_id, updated_at
      ) SELECT ?, ?, ?, ?, ?, 'accepted', ?, NULL, NULL, ?, ?
        WHERE ${claimExistsSql} AND ${receiptAbsentSql}
      ON CONFLICT (tenant_id, subject_user_id, consent_kind, statement_id, statement_version)
      DO UPDATE SET status = 'accepted', accepted_at = excluded.accepted_at,
                    expires_at = excluded.expires_at, withdrawn_at = NULL,
                    latest_evidence_record_id = excluded.latest_evidence_record_id,
                    updated_at = excluded.updated_at`,
      params: [
        input.tenantId,
        input.userId,
        normalizeConsentRecordKind(item.category),
        item.statement_id,
        item.version,
        input.now,
        evidenceRecordIds[index],
        input.now,
        ...claimExistsParams,
        ...receiptAbsentParams,
      ],
    });
  }
  const target = consentRecordRecipient(input);
  const protocolRequestId =
    input.requestContext.authorization_challenge_id ??
    input.requestContext.saml_request_id ??
    (target.recipientType === 'tenant' ? null : input.interaction.id);
  statements.push({
    sql: `INSERT INTO consent_gate_decision_receipts (
      id, tenant_id, interaction_id, flow_id, flow_version_id, flow_node_id, gate_kind,
      subject_user_id, target_type, target_id, policy_id, protocol_request_id,
      statement_version_set_hash, release_set_hash, decision_json, evidence_record_ids_json,
      state, expires_at, consumed_at, created_at, updated_at
    ) SELECT ?, ?, ?, ?, ?, ?, 'legal_document', ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'ready', ?,
             NULL, ?, ?
      WHERE ${claimExistsSql} AND ${receiptAbsentSql}`,
    params: [
      receiptId,
      input.tenantId,
      input.interaction.id,
      input.interaction.flow_id,
      input.interaction.flow_version_id,
      input.step.source_node_id,
      input.userId,
      target.recipientType,
      target.recipientId,
      input.policy.id,
      protocolRequestId,
      input.statementVersionSetHash,
      JSON.stringify(input.receiptDecision),
      JSON.stringify(evidenceRecordIds),
      input.interaction.expires_at,
      input.now,
      input.now,
      ...claimExistsParams,
      ...receiptAbsentParams,
    ],
  });
  statements.push({
    sql: `UPDATE flow_interactions
             SET user_id = COALESCE(user_id, ?), updated_at = ?
           WHERE tenant_id = ? AND id = ? AND ${claimExistsSql}`,
    params: [input.userId, input.now, input.tenantId, input.interaction.id, ...claimExistsParams],
  });
  const results = await input.db.batch(statements);
  return { claimed: results[0]?.rowsAffected === 1 };
}

function appendLegalPolicyBindingValidation(
  input: {
    tenantId: string;
    policy: RuntimeConsentPolicyContent;
    step: FlowRuntimeStep;
    requestContext: FlowRequestContext;
  },
  clauses: string[],
  params: unknown[]
): void {
  const config = readConsentGateNodeConfig(parseJsonRecord(input.step.config));
  const resolution =
    config.policy_resolution ?? (config.consent_policy_ref ? 'fixed' : 'target_binding');
  if (resolution === 'fixed') return;
  const targetType =
    input.requestContext.target_type === 'oidc_client' ||
    input.requestContext.target_type === 'saml_sp'
      ? input.requestContext.target_type
      : 'tenant';
  const targetId = targetType === 'tenant' ? null : input.requestContext.target_id;
  const exactExists =
    targetType === 'tenant'
      ? '0'
      : `EXISTS (SELECT 1 FROM consent_gate_policy_bindings b
           WHERE b.tenant_id = ? AND b.gate_kind = 'legal_document'
             AND b.target_type = ? AND b.target_id = ? AND b.enabled = 1)`;
  const exactMatches =
    targetType === 'tenant'
      ? '0'
      : `EXISTS (SELECT 1 FROM consent_gate_policy_bindings b
           WHERE b.tenant_id = ? AND b.gate_kind = 'legal_document'
             AND b.target_type = ? AND b.target_id = ? AND b.policy_id = ? AND b.enabled = 1)`;
  const defaultExists = `EXISTS (SELECT 1 FROM consent_gate_policy_bindings b
    WHERE b.tenant_id = ? AND b.gate_kind = 'legal_document'
      AND b.target_type = 'tenant' AND b.target_id IS NULL AND b.enabled = 1)`;
  const defaultMatches = `EXISTS (SELECT 1 FROM consent_gate_policy_bindings b
    WHERE b.tenant_id = ? AND b.gate_kind = 'legal_document'
      AND b.target_type = 'tenant' AND b.target_id IS NULL AND b.policy_id = ? AND b.enabled = 1)`;
  const fallbackMatches = config.fallback_policy_ref === input.policy.id ? '1' : '0';
  clauses.push(
    `((${exactMatches}) OR (NOT (${exactExists}) AND (${defaultMatches})) OR
      (NOT (${exactExists}) AND NOT (${defaultExists}) AND ${fallbackMatches} = 1))`
  );
  if (targetType !== 'tenant') {
    params.push(input.tenantId, targetType, targetId, input.policy.id);
    params.push(input.tenantId, targetType, targetId);
  }
  params.push(input.tenantId, input.policy.id);
  if (targetType !== 'tenant') params.push(input.tenantId, targetType, targetId);
  params.push(input.tenantId);
}

function consentSnapshotMatchesPolicy(
  snapshot: NonNullable<ReturnType<typeof readConsentRenderSnapshot>>,
  policy: RuntimeConsentPolicyContent
): boolean {
  if (
    snapshot.policy_id !== policy.id ||
    snapshot.gate_kind !== policy.gate_kind ||
    snapshot.release_set_hash !== policy.release_set_hash ||
    snapshot.release_current_state !== policy.release_current_state ||
    snapshot.release_existing_set_hash !== policy.release_existing_set_hash
  ) {
    return false;
  }
  const expected = snapshot.items
    .map((item) => `${item.statement_id}:${item.version}:${item.acceptance_status}`)
    .sort((left, right) => left.localeCompare(right));
  const actual = policy.items
    .map((item) => `${item.statement_id}:${item.version}:${item.acceptance_status}`)
    .sort((left, right) => left.localeCompare(right));
  return (
    expected.length === actual.length && expected.every((value, index) => value === actual[index])
  );
}

type OidcConsentPersistenceFailure =
  | 'render_snapshot_missing'
  | 'consent_state_changed'
  | 'consent_required'
  | 'step_not_active';
type SamlConsentPersistenceFailure = OidcConsentPersistenceFailure;

export async function persistOidcAuthorizationConsentGate(input: {
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  stepState: FlowInteractionStepRow;
  step: FlowRuntimeStep;
  policy: RuntimeConsentPolicyContent;
  requestContext: FlowRequestContext;
  userId: string;
  decisions: Record<string, RuntimeConsentItemDecision>;
  ipHash?: string;
  userAgent?: string;
}): Promise<{ ok: true } | { ok: false; reason: OidcConsentPersistenceFailure }> {
  const rendered = readConsentRenderSnapshot(input.stepState.state_json);
  if (
    !rendered ||
    rendered.gate_kind !== 'oidc_authorization' ||
    input.requestContext.protocol !== 'oidc' ||
    !input.requestContext.client_id ||
    !input.requestContext.authorization_challenge_id
  ) {
    return { ok: false, reason: 'render_snapshot_missing' };
  }
  const now = nowSeconds();
  const currentInteraction = await input.db.queryOne<FlowInteractionRow>(
    `SELECT id, flow_id, flow_version_id, user_id, client_id, saml_sp_id, state,
            current_node_id, current_step_id, context_json, contract_hash, signature, expires_at
       FROM flow_interactions
      WHERE tenant_id = ? AND id = ?
      LIMIT 1`,
    [input.tenantId, input.interaction.id]
  );
  if (
    !currentInteraction ||
    currentInteraction.state !== 'active' ||
    currentInteraction.current_node_id !== input.step.source_node_id ||
    currentInteraction.current_step_id !== input.step.id ||
    currentInteraction.expires_at <= now
  ) {
    return { ok: false, reason: 'step_not_active' };
  }
  const configuredPolicy =
    input.policy.id === OIDC_RELEASE_POLICY_ID
      ? null
      : await resolveRuntimeConsentPolicyContent(
          input.db,
          input.tenantId,
          input.policy.id,
          input.requestContext,
          'oidc_authorization'
        );
  const currentPolicy = await resolveOidcReleasePolicyContent({
    db: input.db,
    tenantId: input.tenantId,
    requestContext: input.requestContext,
    policy: configuredPolicy,
    userId: input.userId,
  });
  if (!currentPolicy) return { ok: false, reason: 'consent_state_changed' };
  const annotatedStep = await annotateRuntimeConsentItems({
    db: input.db,
    tenantId: input.tenantId,
    interaction: currentInteraction,
    requestContext: input.requestContext,
    userId: input.userId,
    step: withRuntimeConsentPolicyContent(input.step, currentPolicy),
  });
  const annotatedPolicy = readRuntimeConsentPolicyContent(annotatedStep);
  if (!annotatedPolicy || !consentSnapshotMatchesPolicy(rendered, annotatedPolicy)) {
    return { ok: false, reason: 'consent_state_changed' };
  }

  const releaseItems = annotatedPolicy.items.filter(
    (item) => item.release_kind && item.release_name
  );
  const selectedScopes = releaseItems
    .filter(
      (item) =>
        item.release_kind === 'scope' &&
        (item.release_locked || input.decisions[item.statement_id]?.decision !== 'rejected')
    )
    .map((item) => item.release_name!)
    .sort((left, right) => left.localeCompare(right));
  const selectedClaims = releaseItems
    .filter(
      (item) =>
        item.release_kind === 'claim' &&
        (item.release_locked || input.decisions[item.statement_id]?.decision !== 'rejected')
    )
    .map((item) => item.release_name!)
    .sort((left, right) => left.localeCompare(right));
  const requiredScopes = releaseItems
    .filter((item) => item.release_kind === 'scope' && item.release_locked)
    .map((item) => item.release_name!);
  const requiredClaims = releaseItems
    .filter((item) => item.release_kind === 'claim' && item.release_locked)
    .map((item) => item.release_name!);
  if (
    requiredScopes.some((scope) => !selectedScopes.includes(scope)) ||
    requiredClaims.some((claim) => !selectedClaims.includes(claim))
  ) {
    return { ok: false, reason: 'consent_required' };
  }
  const missingPolicyItem = annotatedPolicy.items
    .filter((item) => !item.release_kind && item.acceptance_status === 'pending')
    .find((item) => !consentItemInputSatisfied(item, input.decisions[item.statement_id]));
  if (missingPolicyItem) return { ok: false, reason: 'consent_required' };

  const requestedScopes = [...new Set(input.requestContext.requested_scope)].sort((a, b) =>
    a.localeCompare(b)
  );
  const requestedClaims = effectiveRequestedOidcClaims(input.requestContext).map(
    (claim) => claim.name
  );
  const selectedSetHash = await sha256Base64Url(
    JSON.stringify({ scopes: selectedScopes, claims: selectedClaims })
  );
  const receiptId = `cgr_${crypto.randomUUID().replace(/-/gu, '')}`;
  const releaseEvidenceId = generateId();
  const acceptedPolicyItems = annotatedPolicy.items.filter(
    (item) =>
      !item.release_kind &&
      item.acceptance_status === 'pending' &&
      input.decisions[item.statement_id]?.decision !== 'rejected'
  );
  const policyEvidenceIds = acceptedPolicyItems.map(() => generateId());
  const consentId = generateId();
  const grantNow = Date.now();
  const claimStateJson = JSON.stringify({
    processing_claim: `oidc-consent:${crypto.randomUUID()}`,
  });
  const receiptAbsentSql = `NOT EXISTS (
    SELECT 1 FROM consent_gate_decision_receipts cgr
     WHERE cgr.tenant_id = ? AND cgr.interaction_id = ?
       AND cgr.flow_node_id = ? AND cgr.gate_kind = 'oidc_authorization'
  )`;
  const receiptAbsentParams = [input.tenantId, input.interaction.id, input.step.source_node_id];
  const claimExistsSql = `EXISTS (
    SELECT 1 FROM flow_interaction_steps fis
     WHERE fis.tenant_id = ? AND fis.id = ? AND fis.state = 'processing' AND fis.state_json = ?
  )`;
  const claimExistsParams = [input.tenantId, input.stepState.id, claimStateJson];
  const decision = {
    action: 'skip' as const,
    gateKind: 'oidc_authorization' as const,
    reasonCodes: ['consent.gate.release_selected'],
    forceInteraction: input.requestContext.oidc_prompt_values.includes('consent'),
    pendingItemIds: [],
    release: {
      protocol: 'oidc' as const,
      requested_scopes: requestedScopes,
      selected_scopes: selectedScopes,
      required_scopes: requiredScopes,
      requested_claims: requestedClaims,
      selected_claims: selectedClaims,
      required_claims: requiredClaims,
    },
  };
  const results = await input.db.batch([
    {
      sql: `UPDATE flow_interaction_steps
               SET state = 'processing', state_json = ?, updated_at = ?
             WHERE tenant_id = ? AND id = ? AND state IN ('pending', 'waiting_input')
               AND ${receiptAbsentSql}
               AND EXISTS (
                 SELECT 1 FROM flow_interactions fi
                  WHERE fi.tenant_id = ? AND fi.id = ? AND fi.state = 'active'
                    AND fi.current_node_id = ? AND fi.current_step_id = ? AND fi.expires_at > ?
               )`,
      params: [
        claimStateJson,
        now,
        input.tenantId,
        input.stepState.id,
        ...receiptAbsentParams,
        input.tenantId,
        input.interaction.id,
        input.step.source_node_id,
        input.step.id,
        now,
      ],
    },
    {
      sql: `INSERT INTO oauth_client_consents (
        id, user_id, client_id, scope, granted_at, expires_at, created_at, updated_at,
        tenant_id, selected_scopes, consent_version, release_set_hash, selected_claims
      ) SELECT ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1, ?, ?
        WHERE ${claimExistsSql} AND ${receiptAbsentSql}
      ON CONFLICT (tenant_id, user_id, client_id) DO UPDATE SET
        scope = excluded.scope,
        selected_scopes = excluded.selected_scopes,
        granted_at = excluded.granted_at,
        expires_at = excluded.expires_at,
        consent_version = COALESCE(oauth_client_consents.consent_version, 0) + 1,
        release_set_hash = excluded.release_set_hash,
        selected_claims = excluded.selected_claims,
        updated_at = excluded.updated_at`,
      params: [
        consentId,
        input.userId,
        input.requestContext.client_id,
        selectedScopes.join(' '),
        grantNow,
        grantNow,
        grantNow,
        input.tenantId,
        JSON.stringify(selectedScopes),
        annotatedPolicy.release_set_hash ?? selectedSetHash,
        JSON.stringify(selectedClaims),
        ...claimExistsParams,
        ...receiptAbsentParams,
      ],
    },
    ...acceptedPolicyItems.map((item, index) => {
      const itemDecision = input.decisions[item.statement_id];
      const bindingType = normalizeConsentRecordBindingType(
        item.binding_type,
        input.requestContext
      );
      return {
        sql: `INSERT INTO consent_records (
          id, tenant_id, subject_user_id, actor_user_id, protocol, consent_kind,
          client_id, saml_sp_id, recipient_type, recipient_id, binding_type, binding_key,
          resource_type, resource_id, purpose_key, statement_id, statement_version, policy_id,
          flow_id, flow_version_id, flow_node_id, decision, selected_value, selected_options_json,
          released_scopes_json, released_claims_json, released_attributes_json, status, expires_at,
          revoked_at, evidence_json, created_at, updated_at
        ) SELECT ?, ?, ?, ?, 'oidc', ?, ?, NULL, 'oidc_client', ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', NULL, NULL, ?, ?, ?
          WHERE ${claimExistsSql} AND ${receiptAbsentSql}`,
        params: [
          policyEvidenceIds[index],
          input.tenantId,
          input.userId,
          input.userId,
          normalizeConsentRecordKind(item.category),
          input.requestContext.client_id,
          input.requestContext.client_id,
          bindingType,
          item.binding_value,
          consentRecordResourceType(item, input.requestContext),
          item.binding_value,
          item.category,
          item.statement_id,
          item.version,
          annotatedPolicy.id === OIDC_RELEASE_POLICY_ID ? null : annotatedPolicy.id,
          input.interaction.flow_id,
          input.interaction.flow_version_id,
          input.step.source_node_id,
          itemDecision.decision,
          itemDecision.selectedValue,
          itemDecision.selectedValue ? JSON.stringify([itemDecision.selectedValue]) : null,
          JSON.stringify(selectedScopes),
          JSON.stringify(selectedClaims),
          JSON.stringify({
            source: 'flow_runtime',
            consent_gate_receipt_id: receiptId,
            interaction_id: input.interaction.id,
            authorization_challenge_id: input.requestContext.authorization_challenge_id,
            statement_slug: item.slug,
            statement_version_id: item.version_id,
            release_set_hash: selectedSetHash,
            user_agent: input.userAgent,
            ip_address_hash: input.ipHash,
          }),
          now,
          now,
          ...claimExistsParams,
          ...receiptAbsentParams,
        ],
      };
    }),
    {
      sql: `INSERT INTO consent_records (
        id, tenant_id, subject_user_id, actor_user_id, protocol, consent_kind,
        client_id, saml_sp_id, recipient_type, recipient_id, binding_type, binding_key,
        resource_type, resource_id, purpose_key, statement_id, statement_version, policy_id,
        flow_id, flow_version_id, flow_node_id, decision, selected_value, selected_options_json,
        released_scopes_json, released_claims_json, released_attributes_json, status, expires_at,
        revoked_at, evidence_json, created_at, updated_at
      ) SELECT ?, ?, ?, ?, 'oidc', 'scope_claim_release', ?, NULL, 'oidc_client', ?,
               'user_decision', ?, 'custom', ?, 'oidc_authorization', ?, ?, ?, ?, ?, ?,
               'selected', NULL, ?, ?, ?, NULL, 'active', NULL, NULL, ?, ?, ?
        WHERE ${claimExistsSql} AND ${receiptAbsentSql}`,
      params: [
        releaseEvidenceId,
        input.tenantId,
        input.userId,
        input.userId,
        input.requestContext.client_id,
        input.requestContext.client_id,
        selectedSetHash,
        input.requestContext.client_id,
        `oidc-release:${input.requestContext.client_id}`,
        selectedSetHash,
        annotatedPolicy.id === OIDC_RELEASE_POLICY_ID ? null : annotatedPolicy.id,
        input.interaction.flow_id,
        input.interaction.flow_version_id,
        input.step.source_node_id,
        JSON.stringify([...selectedScopes, ...selectedClaims]),
        JSON.stringify(selectedScopes),
        JSON.stringify(selectedClaims),
        JSON.stringify({
          source: 'flow_runtime',
          consent_gate_receipt_id: receiptId,
          interaction_id: input.interaction.id,
          authorization_challenge_id: input.requestContext.authorization_challenge_id,
          requested_scopes: requestedScopes,
          requested_claims: requestedClaims,
          release_set_hash: selectedSetHash,
          user_agent: input.userAgent,
          ip_address_hash: input.ipHash,
        }),
        now,
        now,
        ...claimExistsParams,
        ...receiptAbsentParams,
      ],
    },
    {
      sql: `INSERT INTO consent_gate_decision_receipts (
        id, tenant_id, interaction_id, flow_id, flow_version_id, flow_node_id, gate_kind,
        subject_user_id, target_type, target_id, policy_id, protocol_request_id,
        statement_version_set_hash, release_set_hash, decision_json, evidence_record_ids_json,
        state, expires_at, consumed_at, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, 'oidc_authorization', ?, 'oidc_client', ?, ?, ?,
               NULL, ?, ?, ?, 'ready', ?, NULL, ?, ?
        WHERE ${claimExistsSql} AND ${receiptAbsentSql}`,
      params: [
        receiptId,
        input.tenantId,
        input.interaction.id,
        input.interaction.flow_id,
        input.interaction.flow_version_id,
        input.step.source_node_id,
        input.userId,
        input.requestContext.client_id,
        annotatedPolicy.id === OIDC_RELEASE_POLICY_ID ? null : annotatedPolicy.id,
        input.requestContext.authorization_challenge_id,
        selectedSetHash,
        JSON.stringify(decision),
        JSON.stringify([...policyEvidenceIds, releaseEvidenceId]),
        input.interaction.expires_at,
        now,
        now,
        ...claimExistsParams,
        ...receiptAbsentParams,
      ],
    },
    {
      sql: `UPDATE flow_interactions
               SET user_id = COALESCE(user_id, ?), updated_at = ?
             WHERE tenant_id = ? AND id = ? AND ${claimExistsSql}`,
      params: [input.userId, now, input.tenantId, input.interaction.id, ...claimExistsParams],
    },
  ]);
  if (results[0]?.rowsAffected === 1) return { ok: true };
  const existingReceipt = await new ConsentGateDecisionReceiptRepository(
    input.db
  ).findLatestForInteractionGate({
    tenant_id: input.tenantId,
    interaction_id: input.interaction.id,
    flow_node_id: input.step.source_node_id,
    gate_kind: 'oidc_authorization',
  });
  return existingReceipt?.state === 'ready'
    ? { ok: true }
    : { ok: false, reason: 'consent_state_changed' };
}

export async function persistSamlAttributeReleaseConsentGate(input: {
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  stepState: FlowInteractionStepRow;
  step: FlowRuntimeStep;
  policy: RuntimeConsentPolicyContent;
  requestContext: FlowRequestContext;
  userId: string;
  decisions: Record<string, RuntimeConsentItemDecision>;
  ipHash?: string;
  userAgent?: string;
}): Promise<{ ok: true } | { ok: false; reason: SamlConsentPersistenceFailure }> {
  const rendered = readConsentRenderSnapshot(input.stepState.state_json);
  if (
    !rendered ||
    rendered.gate_kind !== 'saml_attribute_release' ||
    input.requestContext.protocol !== 'saml' ||
    !input.requestContext.saml_sp_id ||
    !input.requestContext.saml_request_id ||
    !input.requestContext.saml_release_set_hash ||
    !input.requestContext.saml_release_mode
  ) {
    return { ok: false, reason: 'render_snapshot_missing' };
  }
  const configuredPolicy =
    input.policy.id === SAML_RELEASE_POLICY_ID
      ? null
      : await resolveRuntimeConsentPolicyContent(
          input.db,
          input.tenantId,
          input.policy.id,
          input.requestContext,
          'saml_attribute_release'
        );
  const resolvedCurrentPolicy = await resolveSamlReleasePolicyContent({
    db: input.db,
    tenantId: input.tenantId,
    requestContext: input.requestContext,
    policy: configuredPolicy,
    userId: input.userId,
  });
  if (!resolvedCurrentPolicy) return { ok: false, reason: 'consent_state_changed' };
  const annotatedStep = await annotateRuntimeConsentItems({
    db: input.db,
    tenantId: input.tenantId,
    interaction: input.interaction,
    requestContext: input.requestContext,
    userId: input.userId,
    step: withRuntimeConsentPolicyContent(input.step, resolvedCurrentPolicy),
  });
  const currentPolicy = readRuntimeConsentPolicyContent(annotatedStep);
  if (!currentPolicy || !consentSnapshotMatchesPolicy(rendered, currentPolicy)) {
    return { ok: false, reason: 'consent_state_changed' };
  }
  const releaseItems = currentPolicy.items.filter(
    (item) => item.release_kind === 'attribute' && item.release_name
  );
  const selectedAttributes = releaseItems
    .filter(
      (item) => item.release_locked || input.decisions[item.statement_id]?.decision !== 'rejected'
    )
    .map((item) => item.release_name!)
    .sort((left, right) => left.localeCompare(right));
  const requiredAttributes = releaseItems
    .filter((item) => item.release_locked)
    .map((item) => item.release_name!);
  if (requiredAttributes.some((attribute) => !selectedAttributes.includes(attribute))) {
    return { ok: false, reason: 'consent_required' };
  }
  const missingPolicyItem = currentPolicy.items
    .filter((item) => !item.release_kind && item.acceptance_status === 'pending')
    .find((item) => !consentItemInputSatisfied(item, input.decisions[item.statement_id]));
  if (missingPolicyItem) return { ok: false, reason: 'consent_required' };
  const requestedAttributes = releaseItems
    .map((item) => item.release_name!)
    .sort((left, right) => left.localeCompare(right));
  const selectedHash = await sha256Base64Url(JSON.stringify(selectedAttributes));
  const receiptId = `cgr_${crypto.randomUUID().replace(/-/gu, '')}`;
  const existingReceipt = await new ConsentGateDecisionReceiptRepository(
    input.db
  ).findLatestForInteractionGate({
    tenant_id: input.tenantId,
    interaction_id: input.interaction.id,
    flow_node_id: input.step.source_node_id,
    gate_kind: 'saml_attribute_release',
  });
  if (existingReceipt?.state === 'ready') return { ok: true };
  const now = nowSeconds();
  const grantNow = Date.now();
  const releaseEvidenceId = generateId();
  const acceptedPolicyItems = currentPolicy.items.filter(
    (item) =>
      !item.release_kind &&
      item.acceptance_status === 'pending' &&
      input.decisions[item.statement_id]?.decision !== 'rejected'
  );
  const policyEvidenceIds = acceptedPolicyItems.map(() => generateId());
  const claimStateJson = JSON.stringify({
    processing_claim: `saml-consent:${crypto.randomUUID()}`,
  });
  const receiptAbsentSql = `NOT EXISTS (
    SELECT 1 FROM consent_gate_decision_receipts cgr
     WHERE cgr.tenant_id = ? AND cgr.interaction_id = ?
       AND cgr.flow_node_id = ? AND cgr.gate_kind = 'saml_attribute_release'
  )`;
  const receiptAbsentParams = [input.tenantId, input.interaction.id, input.step.source_node_id];
  const claimExistsSql = `EXISTS (
    SELECT 1 FROM flow_interaction_steps fis
     WHERE fis.tenant_id = ? AND fis.id = ? AND fis.state = 'processing' AND fis.state_json = ?
  )`;
  const claimExistsParams = [input.tenantId, input.stepState.id, claimStateJson];
  const decision = {
    action: 'skip' as const,
    gateKind: 'saml_attribute_release' as const,
    reasonCodes: ['consent.gate.release_selected'],
    forceInteraction: false,
    pendingItemIds: [],
    release: {
      protocol: 'saml' as const,
      requested_attributes: requestedAttributes,
      selected_attributes: selectedAttributes,
      required_attributes: requiredAttributes,
      consent_mode: input.requestContext.saml_release_mode,
    },
  };
  const statements: Array<{ sql: string; params: unknown[] }> = [
    {
      sql: `UPDATE flow_interaction_steps
               SET state = 'processing', state_json = ?, updated_at = ?
             WHERE tenant_id = ? AND id = ? AND state IN ('pending', 'waiting_input')
               AND ${receiptAbsentSql}
               AND EXISTS (
                 SELECT 1 FROM flow_interactions fi
                  WHERE fi.tenant_id = ? AND fi.id = ? AND fi.state = 'active'
                    AND fi.current_node_id = ? AND fi.current_step_id = ? AND fi.expires_at > ?
               )`,
      params: [
        claimStateJson,
        now,
        input.tenantId,
        input.stepState.id,
        ...receiptAbsentParams,
        input.tenantId,
        input.interaction.id,
        input.step.source_node_id,
        input.step.id,
        now,
      ],
    },
  ];
  for (let index = 0; index < acceptedPolicyItems.length; index += 1) {
    const item = acceptedPolicyItems[index];
    const itemDecision = input.decisions[item.statement_id];
    const bindingType = normalizeConsentRecordBindingType(item.binding_type, input.requestContext);
    statements.push({
      sql: `INSERT INTO consent_records (
        id, tenant_id, subject_user_id, actor_user_id, protocol, consent_kind,
        client_id, saml_sp_id, recipient_type, recipient_id, binding_type, binding_key,
        resource_type, resource_id, purpose_key, statement_id, statement_version, policy_id,
        flow_id, flow_version_id, flow_node_id, decision, selected_value, selected_options_json,
        released_scopes_json, released_claims_json, released_attributes_json, status, expires_at,
        revoked_at, evidence_json, created_at, updated_at
      ) SELECT ?, ?, ?, ?, 'saml', ?, NULL, ?, 'saml_sp', ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'active', NULL, NULL, ?, ?, ?
        WHERE ${claimExistsSql} AND ${receiptAbsentSql}`,
      params: [
        policyEvidenceIds[index],
        input.tenantId,
        input.userId,
        input.userId,
        normalizeConsentRecordKind(item.category),
        input.requestContext.saml_sp_id,
        input.requestContext.saml_sp_id,
        bindingType,
        item.binding_value,
        consentRecordResourceType(item, input.requestContext),
        item.binding_value,
        item.category,
        item.statement_id,
        item.version,
        currentPolicy.id === SAML_RELEASE_POLICY_ID ? null : currentPolicy.id,
        input.interaction.flow_id,
        input.interaction.flow_version_id,
        input.step.source_node_id,
        itemDecision.decision,
        itemDecision.selectedValue,
        itemDecision.selectedValue ? JSON.stringify([itemDecision.selectedValue]) : null,
        JSON.stringify(selectedAttributes),
        JSON.stringify({
          source: 'flow_runtime',
          consent_gate_receipt_id: receiptId,
          interaction_id: input.interaction.id,
          saml_request_id: input.requestContext.saml_request_id,
          statement_slug: item.slug,
          statement_version_id: item.version_id,
          release_set_hash: selectedHash,
          user_agent: input.userAgent,
          ip_address_hash: input.ipHash,
        }),
        now,
        now,
        ...claimExistsParams,
        ...receiptAbsentParams,
      ],
    });
  }
  statements.push(
    {
      sql: `INSERT INTO consent_records (
        id, tenant_id, subject_user_id, actor_user_id, protocol, consent_kind,
        client_id, saml_sp_id, recipient_type, recipient_id, binding_type, binding_key,
        resource_type, resource_id, purpose_key, statement_id, statement_version, policy_id,
        flow_id, flow_version_id, flow_node_id, decision, selected_value, selected_options_json,
        released_scopes_json, released_claims_json, released_attributes_json, status, expires_at,
        revoked_at, evidence_json, created_at, updated_at
      ) SELECT ?, ?, ?, ?, 'saml', 'attribute_release', NULL, ?, 'saml_sp', ?,
               'user_decision', ?, 'saml_attributes', ?, 'saml_attribute_release', ?, ?, ?,
               ?, ?, ?, 'selected', NULL, ?, NULL, NULL, ?, 'active', NULL, NULL, ?, ?, ?
        WHERE ${claimExistsSql} AND ${receiptAbsentSql}`,
      params: [
        releaseEvidenceId,
        input.tenantId,
        input.userId,
        input.userId,
        input.requestContext.saml_sp_id,
        input.requestContext.saml_sp_id,
        selectedHash,
        input.requestContext.saml_sp_id,
        `saml-release:${input.requestContext.saml_sp_id}`,
        input.requestContext.saml_release_set_hash,
        currentPolicy.id === SAML_RELEASE_POLICY_ID ? null : currentPolicy.id,
        input.interaction.flow_id,
        input.interaction.flow_version_id,
        input.step.source_node_id,
        JSON.stringify(selectedAttributes),
        JSON.stringify(selectedAttributes),
        JSON.stringify({
          source: 'flow_runtime',
          consent_gate_receipt_id: receiptId,
          interaction_id: input.interaction.id,
          saml_request_id: input.requestContext.saml_request_id,
          requested_attributes: requestedAttributes,
          selected_attributes: selectedAttributes,
          source_attribute_set_hash: input.requestContext.saml_release_set_hash,
          selected_release_set_hash: selectedHash,
          user_agent: input.userAgent,
          ip_address_hash: input.ipHash,
        }),
        now,
        now,
        ...claimExistsParams,
        ...receiptAbsentParams,
      ],
    },
    {
      sql: `INSERT INTO attribute_release_consents (
        id, tenant_id, subject_id, account_id, destination_type, destination_id,
        attribute_set_hash, consent_mode, consent_state, consent_record_id,
        first_granted_at, last_confirmed_at, expires_at, revoked_at, created_at, updated_at
      ) SELECT ?, ?, ?, NULL, 'saml_sp', ?, ?, ?, 'granted', ?, ?, ?, NULL, NULL, ?, ?
        WHERE ${claimExistsSql} AND ${receiptAbsentSql}
      ON CONFLICT (tenant_id, subject_id, destination_type, destination_id, attribute_set_hash)
      DO UPDATE SET consent_mode = excluded.consent_mode, consent_state = 'granted',
                    consent_record_id = excluded.consent_record_id,
                    last_confirmed_at = excluded.last_confirmed_at, expires_at = NULL,
                    revoked_at = NULL, updated_at = excluded.updated_at`,
      params: [
        generateId(),
        input.tenantId,
        input.userId,
        input.requestContext.saml_sp_id,
        input.requestContext.saml_release_set_hash,
        input.requestContext.saml_release_mode,
        releaseEvidenceId,
        grantNow,
        grantNow,
        grantNow,
        grantNow,
        ...claimExistsParams,
        ...receiptAbsentParams,
      ],
    },
    {
      sql: `INSERT INTO consent_gate_decision_receipts (
        id, tenant_id, interaction_id, flow_id, flow_version_id, flow_node_id, gate_kind,
        subject_user_id, target_type, target_id, policy_id, protocol_request_id,
        statement_version_set_hash, release_set_hash, decision_json, evidence_record_ids_json,
        state, expires_at, consumed_at, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, 'saml_attribute_release', ?, 'saml_sp', ?, ?, ?,
               NULL, ?, ?, ?, 'ready', ?, NULL, ?, ?
        WHERE ${claimExistsSql} AND ${receiptAbsentSql}`,
      params: [
        receiptId,
        input.tenantId,
        input.interaction.id,
        input.interaction.flow_id,
        input.interaction.flow_version_id,
        input.step.source_node_id,
        input.userId,
        input.requestContext.saml_sp_id,
        currentPolicy.id === SAML_RELEASE_POLICY_ID ? null : currentPolicy.id,
        input.requestContext.saml_request_id,
        selectedHash,
        JSON.stringify(decision),
        JSON.stringify([...policyEvidenceIds, releaseEvidenceId]),
        input.interaction.expires_at,
        now,
        now,
        ...claimExistsParams,
        ...receiptAbsentParams,
      ],
    },
    {
      sql: `UPDATE flow_interactions
               SET user_id = COALESCE(user_id, ?), updated_at = ?
             WHERE tenant_id = ? AND id = ? AND ${claimExistsSql}`,
      params: [input.userId, now, input.tenantId, input.interaction.id, ...claimExistsParams],
    }
  );
  try {
    const results = await input.db.batch(statements);
    if (results[0]?.rowsAffected === 1) return { ok: true };
  } catch {
    // A concurrent writer may have committed the same gate receipt first.
  }
  const concurrentReceipt = await new ConsentGateDecisionReceiptRepository(
    input.db
  ).findLatestForInteractionGate({
    tenant_id: input.tenantId,
    interaction_id: input.interaction.id,
    flow_node_id: input.step.source_node_id,
    gate_kind: 'saml_attribute_release',
  });
  return concurrentReceipt?.state === 'ready'
    ? { ok: true }
    : { ok: false, reason: 'consent_state_changed' };
}

export function evaluateConsentGateShadowComparison(
  gateKind: 'oidc_authorization' | 'saml_attribute_release',
  policy: RuntimeConsentPolicyContent
): { legacyWouldChallenge: boolean; reasonCode: string } {
  if (gateKind === 'oidc_authorization') {
    if (policy.force_interaction) {
      return { legacyWouldChallenge: true, reasonCode: 'prompt_forced' };
    }
    if (policy.release_current_state !== 'granted') {
      return { legacyWouldChallenge: true, reasonCode: 'current_grant_missing' };
    }
    return { legacyWouldChallenge: false, reasonCode: 'current_grant_reusable' };
  }
  if (policy.release_mode === 'every_time') {
    return { legacyWouldChallenge: true, reasonCode: 'every_time' };
  }
  if (policy.release_current_state !== 'granted') {
    return { legacyWouldChallenge: true, reasonCode: 'current_grant_missing' };
  }
  if (policy.release_existing_set_hash !== policy.release_set_hash) {
    return { legacyWouldChallenge: true, reasonCode: 'release_set_changed' };
  }
  return { legacyWouldChallenge: false, reasonCode: 'current_grant_reusable' };
}

async function persistRuntimeConsentStep(input: {
  c: AuthContext;
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  stepState: FlowInteractionStepRow;
  step: FlowRuntimeStep;
  submitInput: unknown;
}): Promise<{ ok: boolean; response?: Response; userId?: string | null }> {
  const requestContext = getRequestContextFromInteraction(input.interaction);
  const config = parseJsonRecord(input.step.config);
  const renderedPolicy = readRuntimeConsentPolicyContent(input.step);
  const gateKind = readConsentGateKind(config);
  if (
    (gateKind === 'oidc_authorization' || gateKind === 'saml_attribute_release') &&
    !(await isTenantFlowProtocolConsentGatesEnabled(input.c.env, input.tenantId))
  ) {
    return {
      ok: false,
      response: runtimeError(
        input.c,
        409,
        'consent_gate_disabled',
        'Protocol Consent Gates were disabled while this interaction was active',
        'AR_FLOW_PROTOCOL_CONSENT_GATE_DISABLED',
        'restart_required',
        'restart_interaction',
        input.interaction.id
      ),
    };
  }
  if (
    renderedPolicy &&
    (gateKind === 'oidc_authorization' || gateKind === 'saml_attribute_release') &&
    (await isTenantFlowProtocolConsentShadowEnabled(input.c.env, input.tenantId))
  ) {
    const { legacyWouldChallenge, reasonCode } = evaluateConsentGateShadowComparison(
      gateKind,
      renderedPolicy
    );
    getLogger(input.c)
      .module('LOGIN-RUNTIME-FLOW')
      .info('Consent Gate shadow comparison', {
        action: 'consent_gate_shadow',
        metric: legacyWouldChallenge ? 'shadow_match' : 'shadow_mismatch',
        gate_kind: gateKind,
        flow_action: 'challenge',
        legacy_action: legacyWouldChallenge ? 'challenge' : 'skip',
        reason_code: reasonCode,
        flow_version_id: input.interaction.flow_version_id,
      });
  }
  const policyId = renderedPolicy?.id ?? readString(config.consent_policy_ref, 200);
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

  const resolvedPolicy =
    policyId === OIDC_RELEASE_POLICY_ID || policyId === SAML_RELEASE_POLICY_ID
      ? null
      : await resolveRuntimeConsentPolicyContent(
          input.db,
          input.tenantId,
          policyId,
          requestContext,
          gateKind
        );
  const policy =
    gateKind === 'oidc_authorization'
      ? await resolveOidcReleasePolicyContent({
          db: input.db,
          tenantId: input.tenantId,
          requestContext,
          policy: resolvedPolicy,
          userId: await getCurrentSessionUserId(input.c, input.tenantId),
        })
      : gateKind === 'saml_attribute_release'
        ? await resolveSamlReleasePolicyContent({
            db: input.db,
            tenantId: input.tenantId,
            requestContext,
            policy: resolvedPolicy,
            userId: await getCurrentSessionUserId(input.c, input.tenantId),
          })
        : resolvedPolicy;
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
  const ipAddress =
    getRequestHeader(input.c, 'CF-Connecting-IP') ||
    getRequestHeader(input.c, 'X-Forwarded-For') ||
    '';
  const ipHash = ipAddress
    ? await hashIpAddress(ipAddress, input.tenantId, input.c.env.KV ?? null)
    : undefined;
  if (gateKind === 'legal_document') {
    const legalResult = await persistLegalConsentGate({
      db: input.db,
      tenantId: input.tenantId,
      interaction: input.interaction,
      stepState: input.stepState,
      step: input.step,
      policy,
      requestContext,
      userId,
      decisions,
      ipHash,
      userAgent: getRequestHeader(input.c, 'User-Agent'),
    });
    if (legalResult.ok) return { ok: true, userId };
    const stateChanged =
      legalResult.reason === 'render_snapshot_missing' ||
      legalResult.reason === 'consent_state_changed';
    return {
      ok: false,
      response: runtimeError(
        input.c,
        stateChanged ? 409 : legalResult.reason === 'consent_required' ? 400 : 409,
        stateChanged
          ? 'consent_state_changed'
          : legalResult.reason === 'consent_required'
            ? 'consent_required'
            : 'step_not_active',
        stateChanged
          ? 'Consent policy or acceptance state changed; review the current consent screen'
          : legalResult.reason === 'consent_required'
            ? 'Required consent items must be granted'
            : 'The submitted Flow step is no longer active',
        stateChanged
          ? 'AR_FLOW_CONSENT_STATE_CHANGED'
          : legalResult.reason === 'consent_required'
            ? 'AR_FLOW_CONSENT_REQUIRED'
            : 'AR_FLOW_STEP_NOT_ACTIVE',
        stateChanged ? 'recoverable' : 'recoverable',
        'retry_step',
        input.interaction.id
      ),
    };
  }
  if (gateKind === 'oidc_authorization') {
    const oidcResult = await persistOidcAuthorizationConsentGate({
      db: input.db,
      tenantId: input.tenantId,
      interaction: input.interaction,
      stepState: input.stepState,
      step: input.step,
      policy,
      requestContext,
      userId,
      decisions,
      ipHash,
      userAgent: getRequestHeader(input.c, 'User-Agent'),
    });
    if (oidcResult.ok) {
      if (requestContext.client_id) {
        await invalidateConsentCache(input.c.env, userId, input.tenantId, requestContext.client_id);
      }
      return { ok: true, userId };
    }
    const stateChanged =
      oidcResult.reason === 'render_snapshot_missing' ||
      oidcResult.reason === 'consent_state_changed';
    return {
      ok: false,
      response: runtimeError(
        input.c,
        stateChanged ? 409 : oidcResult.reason === 'consent_required' ? 400 : 409,
        stateChanged
          ? 'consent_state_changed'
          : oidcResult.reason === 'consent_required'
            ? 'consent_required'
            : 'step_not_active',
        stateChanged
          ? 'The requested OIDC release set changed; review the current consent screen'
          : oidcResult.reason === 'consent_required'
            ? 'Required scopes or claims must be granted'
            : 'The submitted Flow step is no longer active',
        stateChanged
          ? 'AR_FLOW_CONSENT_STATE_CHANGED'
          : oidcResult.reason === 'consent_required'
            ? 'AR_FLOW_CONSENT_REQUIRED'
            : 'AR_FLOW_STEP_NOT_ACTIVE',
        'recoverable',
        'retry_step',
        input.interaction.id
      ),
    };
  }
  if (gateKind === 'saml_attribute_release') {
    const samlResult = await persistSamlAttributeReleaseConsentGate({
      db: input.db,
      tenantId: input.tenantId,
      interaction: input.interaction,
      stepState: input.stepState,
      step: input.step,
      policy,
      requestContext,
      userId,
      decisions,
      ipHash,
      userAgent: getRequestHeader(input.c, 'User-Agent'),
    });
    if (samlResult.ok) return { ok: true, userId };
    const stateChanged =
      samlResult.reason === 'render_snapshot_missing' ||
      samlResult.reason === 'consent_state_changed';
    return {
      ok: false,
      response: runtimeError(
        input.c,
        stateChanged ? 409 : samlResult.reason === 'consent_required' ? 400 : 409,
        stateChanged
          ? 'consent_state_changed'
          : samlResult.reason === 'consent_required'
            ? 'consent_required'
            : 'step_not_active',
        stateChanged
          ? 'The SAML attribute release set changed; review the current consent screen'
          : samlResult.reason === 'consent_required'
            ? 'Required SAML attributes must be granted'
            : 'The submitted Flow step is no longer active',
        stateChanged
          ? 'AR_FLOW_CONSENT_STATE_CHANGED'
          : samlResult.reason === 'consent_required'
            ? 'AR_FLOW_CONSENT_REQUIRED'
            : 'AR_FLOW_STEP_NOT_ACTIVE',
        'recoverable',
        'retry_step',
        input.interaction.id
      ),
    };
  }
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
  const prepared = await prepareRuntimeContract({
    c,
    db,
    tenantId,
    assignment,
    version,
    runtimeSnapshot: runtime,
    requestContext,
  });
  let contract = prepared.contract;
  let contractHash = prepared.contractHash;
  const current = findCurrentStep(contract, interaction);
  const sessionUserId = await getCurrentSessionUserId(c, tenantId);
  if (interaction.user_id && sessionUserId && interaction.user_id !== sessionUserId) {
    return runtimeError(
      c,
      403,
      'interaction_subject_mismatch',
      'The active session does not match this Flow interaction',
      'AR_FLOW_SUBJECT_MISMATCH',
      'security_error',
      'restart_interaction',
      interaction.id
    );
  }
  if (current?.step.component === 'consent_policy' && sessionUserId) {
    const annotated = await annotateRuntimeConsentItems({
      db,
      tenantId,
      interaction,
      requestContext,
      userId: sessionUserId,
      step: current.step,
    });
    contract = {
      ...contract,
      ui: {
        ...contract.ui,
        steps: contract.ui.steps.map((step, index) => (index === current.index ? annotated : step)),
      },
    };
    contractHash = await sha256Base64Url(JSON.stringify(contract));
    await db.execute(
      `UPDATE flow_interaction_steps
          SET state_json = ?, updated_at = ?
        WHERE tenant_id = ? AND interaction_id = ? AND node_id = ? AND step_id = ?
          AND state IN ('pending', 'waiting_input')`,
      [
        runtimeStepWaitingStateJson(annotated),
        now,
        tenantId,
        interaction.id,
        annotated.source_node_id,
        annotated.id,
      ]
    );
  }
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

  const resolvedTarget = timeRuntimeStartValue(timing, 'resolve_target', () => resolveTarget(body));
  if (!resolvedTarget) {
    writeRuntimeStartTiming(c, timing, { result: 'error', error: 'invalid_target' });
    return jsonError(c, 400, 'invalid_target', 'Flow assignment target is invalid');
  }
  let target: ResolvedTarget = resolvedTarget;

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
  let requestContext = timeRuntimeStartValue(timing, 'request_context', () =>
    createUntrustedRequestContext(target, body)
  );
  const oidcContextResolution = await timeRuntimeStartSpan(timing, 'authorization_challenge', () =>
    resolveTrustedOidcRequestContext(c, tenantId, target, requestContext)
  );
  if (oidcContextResolution.error || !oidcContextResolution.context) {
    writeRuntimeStartTiming(c, timing, {
      result: 'error',
      flowKind,
      targetType: target.targetType,
      error: 'invalid_authorization_challenge',
    });
    return (
      oidcContextResolution.error ??
      jsonError(c, 400, 'invalid_authorization_challenge', 'Authorization challenge is invalid')
    );
  }
  requestContext = oidcContextResolution.context;
  target = oidcContextResolution.target ?? target;
  const samlContextResolution = await timeRuntimeStartSpan(timing, 'saml_request', () =>
    resolveTrustedSamlRequestContext(c, tenantId, target, requestContext)
  );
  if (samlContextResolution.error || !samlContextResolution.context) {
    writeRuntimeStartTiming(c, timing, {
      result: 'error',
      flowKind,
      targetType: target.targetType,
      error: 'invalid_saml_request',
    });
    return (
      samlContextResolution.error ??
      jsonError(c, 400, 'invalid_saml_request', 'Stored SAML request is invalid')
    );
  }
  requestContext = samlContextResolution.context;
  target = samlContextResolution.target ?? target;

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

  const { contract: runtime, contractHash: preparedContractHash } = await timeRuntimeStartSpan(
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
  let responseRuntime = runtime;
  let contractHash = preparedContractHash;
  let signature = await timeRuntimeStartSpan(timing, 'sign_contract', () =>
    signContract({
      interactionId,
      contractHash,
      expiresAt,
      secret,
    })
  );

  const preflightInteraction: FlowInteractionRow = {
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
  const promptNonePreflightError = await timeRuntimeStartSpan(timing, 'prompt_none_preflight', () =>
    preflightPromptNoneConsentGates({
      c,
      db,
      tenantId,
      interaction: preflightInteraction,
      runtime,
      requestContext,
    })
  );
  if (promptNonePreflightError) {
    writeRuntimeStartTiming(c, timing, {
      result: 'error',
      flowKind: assignment.flow_kind,
      targetType: assignment.target_type,
      error: 'prompt_none_interaction_required',
    });
    return jsonError(
      c,
      promptNonePreflightError.status,
      promptNonePreflightError.error,
      promptNonePreflightError.description,
      promptNonePreflightError.errorCode
    );
  }

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

  const startedInteraction: FlowInteractionRow = preflightInteraction;
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
  const currentStepIndex = getRuntimeStepIndex(runtime, initialCurrentStep);
  if (currentStepIndex >= 0) {
    const candidateRuntime = {
      ...runtime,
      ui: {
        ...runtime.ui,
        steps: runtime.ui.steps.map((step, index) =>
          index === currentStepIndex ? initialCurrentStep : step
        ),
      },
    };
    const candidateHash = await sha256Base64Url(JSON.stringify(candidateRuntime));
    if (candidateHash !== contractHash) {
      responseRuntime = candidateRuntime;
      contractHash = candidateHash;
      signature = await signContract({
        interactionId,
        contractHash,
        expiresAt,
        secret,
      });
      await db.execute(
        `UPDATE flow_interactions
            SET contract_hash = ?, signature = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        [contractHash, signature, now, tenantId, interactionId]
      );
    }
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
  } else {
    const waitingStateJson = runtimeStepWaitingStateJson(initialCurrentStep);
    if (waitingStateJson) {
      await db.execute(
        `UPDATE flow_interaction_steps
            SET state_json = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND state IN ('pending', 'waiting_input')`,
        [waitingStateJson, now, tenantId, stepRowId]
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
    contract: responseRuntime,
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

  if (!stepMatchesRequestProtocol(current.step, requestContext)) {
    await insertAuditEvent(db, tenantId, interaction, {
      eventType: 'flow.interaction.failed',
      result: 'protocol_mismatch',
      errorCode: 'AR_FLOW_STEP_PROTOCOL_MISMATCH',
      nodeId: current.step.source_node_id,
      userId: interaction.user_id,
    });
    return runtimeError(
      c,
      409,
      'invalid_protocol_step',
      'Active Flow step does not match the trusted protocol request',
      'AR_FLOW_STEP_PROTOCOL_MISMATCH',
      'security_error',
      'restart_interaction',
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
    branchResolution = await resolveSessionCheckSelectedHandle(c, tenantId, requestContext);
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
    stepState,
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

  if (completed && !stepMatchesRequestProtocol(outputStep, requestContext)) {
    await insertAuditEvent(db, tenantId, interaction, {
      eventType: 'flow.interaction.failed',
      result: 'protocol_mismatch',
      errorCode: 'AR_FLOW_COMPLETION_PROTOCOL_MISMATCH',
      nodeId: outputStep.source_node_id,
      branchHandleId: effectiveSelectedHandle,
      userId: resolvedUserId,
    });
    return runtimeError(
      c,
      409,
      'invalid_protocol_completion',
      'Flow completion does not match the trusted protocol request',
      'AR_FLOW_COMPLETION_PROTOCOL_MISMATCH',
      'configuration_error',
      'contact_administrator',
      interactionId
    );
  }

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
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        [
          nextStepRowId,
          tenantId,
          interactionId,
          nextStep.source_node_id,
          nextStep.id,
          getStepStateForRuntimeStep(nextStep),
          runtimeStepWaitingStateJson(nextStep),
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
          consentGateReceiptId: completedProtocolRedirect.consentGateReceiptId,
        })
      : null,
  });
}
