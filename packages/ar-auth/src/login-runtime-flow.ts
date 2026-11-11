import { emitLogIcebergRow } from '@authrim/ar-lib-core/services/log-iceberg-emitter';
import { readSamlDrFlowRuntimeEnabled } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-runtime-settings';
import type { Context } from 'hono';
import {
  consentPresentationKey,
  consentStepKey,
  destinationPresentationKey,
} from '@authrim/ar-lib-core/utils/consent-presentation-key';
import {
  consumeAuthorizationChallengeContinuation,
  isProofOlderThanChallengeRequirement,
  readAuthorizationChallengeFreshness,
  reauthProofFromRecord,
} from './direct-auth';
import { checkSAMLChallengeForFlow } from './saml-authorization-challenge';
import {
  getTenantSettingsDocument,
  readSettingsFlag,
  FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
  FLOW_RUNTIME_INTERACTION_TTL_SECONDS,
  createAuthContextFromHono,
  createAccountAuthContextFromHono,
  resolveAccountDataContextFromHono,
  createPIIContextFromHono,
  evaluateFlowConditionRows,
  generateId,
  getChallengeStoreByChallengeId,
  getFeatureFlag,
  getLogger,
  getSessionStoreBySessionId,
  getTenantIdFromContext,
  hashIpAddress,
  isOidcFieldApplicableToScopes,
  canReleaseClaim,
  parseClaimsRequest,
  OIDC_STANDARD_CLAIM_SCOPE,
  type OIDCClaimsClientPolicy,
  isShardedSessionId,
  loadDestinationProfileConsentDescriptor,
  resolveOidcFieldRequiredScopes,
  resolveDestinationProfileConsentVersion,
  resolveRuntimeIdentityMappingBinding,
  resolveOidcIdentityMappingBinding,
  toOidcIdentityMappingRuntimeError,
  requireDedicatedAdminDatabaseAdapter,
  CanonicalRuntimeUserStore,
  ensureDatabaseAdapter,
  persistCustomClaimWrite,
  resolveCustomClaimRuntimeSourcesFromHono,
  validateCustomClaimWrite,
  resolveAccountCoreDataContext,
  resolveSubjectOrganizations,
  resolveSubjectRoles,
  type DatabaseAdapter,
  type PreparedStatement,
  type ExecuteResult,
  type Env,
  type TenantRBACDatabases,
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
  type DestinationProfileConsentDescriptor,
  type DestinationFieldReleasePolicies,
  type Session,
  type FlowScreenSubmittedEventData,
  FLOW_EVENTS,
  contextWithoutScreenAnswers,
  expireFlowInteractions,
  screenAnswerEntriesOf,
  screenAnswersOf,
  publishEvent,
  isSAMLAuthorizationChallenge,
  flowProfileRefsOfRuntime,
  layerTenantSettingsDocument,
} from '@authrim/ar-lib-core';
import { resolveRuntimeScreenRow } from '@authrim/ar-lib-core/services/runtime-screen-resolution';
import { applyRuntimeScreenOptions, runtimeAttributeKey } from './runtime-screen-options';
import { screenRoutingHandle } from './runtime-screen-exits';
import { narrowHandlesByProfile, readAuthenticationProfile } from './authentication-profile';
import {
  BACK_LOOKBACK,
  backTargets,
  type BackStep,
  type BackTarget,
  type BackVisit,
} from './runtime-back-navigation';
import {
  hasSignInMethodPart,
  readRuntimeScreenAnswers,
  splitOffProfileAnswers,
  splitProfileAnswers,
  type OffProfileScreenAnswers,
  type RuntimeScreenAnswer,
  type RuntimeScreenAnswerProblem,
  type ScreenAnswerValue,
} from './runtime-screen-answers';

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
  /** Going back (`/back`): the key of the screen to go back to. */
  target_screen?: string;
  /**
   * The visit of the step the request was made on (`current_visit_id`), when the client knows it:
   * a request made on an earlier visit of the same step (before going back and on) is refused.
   */
  visit_id?: string;
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
  /**
   * The claims the authorization request names in its claims parameter (for the ID token or
   * UserInfo), read from the authorization request itself and never from the caller: a field the
   * request asks for this way is one the consent step has to ask about, even without its scope,
   * when the client's claims policy lets the claim through.
   */
  requested_claims?: string[];
  locale: string | null;
  /**
   * Changes when the contract served for the interaction has to be prepared anew (the terms it asks
   * consent to changed): part of the key a prepared contract is kept under, so that no Worker
   * serves the interaction from a contract prepared before.
   */
  contract_revision?: string | null;
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

interface RuntimeDestinationFieldConsentContent extends FlowRuntimeJsonObject {
  profile_id: string;
  profile_version_id: string;
  consent_version: string;
  destination_type: 'oidc' | 'saml';
  consent_mode: 'once' | 'every_time' | 'until_attributes_change' | null;
  fields: Array<{
    key: string;
    label: string;
    required: boolean;
    nullable: boolean;
    classification: string;
    surfaces: string[];
    required_scopes: string[];
  }>;
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
  diagnosticSessionId: string | null;
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
const DIAGNOSTIC_SESSION_ID_HEADER = 'X-Diagnostic-Session-Id';
const MAX_DIAGNOSTIC_SESSION_ID_LENGTH = 128;
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

/**
 * Runs the statements the callback writes as one batch: all of them or none (a D1 batch is
 * atomic, where a callback transaction runs and commits each statement on its own), in one round
 * trip.
 */
async function writeAtomically(
  db: DatabaseAdapter,
  build: (write: (sql: string, params: unknown[]) => void) => void
): Promise<ExecuteResult[]> {
  const statements: PreparedStatement[] = [];
  build((sql, params) => {
    statements.push({ sql, params });
  });
  return db.batch(statements);
}

/**
 * How long a submit holds its interaction (claimRuntimeSubmit) at most, in seconds: a submit that
 * neither saves its step nor lets go of it (a request cut off) keeps the step from being submitted
 * again only until then.
 */
const FLOW_SUBMIT_CLAIM_TTL_SECONDS = 60;
/**
 * How long after its claim a submit may still start recording anything (consent, profile answers,
 * a response record, the authorization continuation, the step), in milliseconds. Past it the
 * submit stops (step_conflict) and records nothing more; what it started before has the rest of
 * the claim (50 seconds) to finish, so it does not overlap a submit that takes the step after the
 * claim lapsed. This is a bound in time, not a fence the other stores check: a write started in
 * the window and held up past the claim's expiry could still land after such a submit. The
 * interaction itself (its step, its context) is only ever written under the claim.
 */
const FLOW_SUBMIT_CLAIM_ACT_WINDOW_MS = 10_000;

/** A runtime submit's hold on its interaction (see claimRuntimeSubmit). */
interface RuntimeSubmitClaim {
  id: string;
  /** Set once the step is saved under the claim; otherwise the claim is let go of. */
  saved: boolean;
  /** Until when (Date.now()) the submit may still start recording. */
  actBeforeMs: number;
}

/** Whether a submit's claim is too old for it to start recording anything more. */
function runtimeSubmitClaimLapsed(claim: RuntimeSubmitClaim): boolean {
  return Date.now() >= claim.actBeforeMs;
}

/** `IS` for a comparison that holds for two nulls, in the database's dialect. */
function nullSafeEquals(db: DatabaseAdapter): string {
  const type = db.getType();
  return type === 'postgres' || type === 'aurora-dsql' ? 'IS NOT DISTINCT FROM' : 'IS';
}

/** A write refused because a concurrent one changed the same row (PostgreSQL, Aurora DSQL). */
function isSerializationConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '40001'
  );
}

/**
 * The submit of a step holds its interaction before anything is recorded: one conditional UPDATE,
 * which only one of two submits of the same step (two tabs, a retried request) can make while the
 * other's claim is held. The other is answered `step_conflict` and records nothing; its browser
 * picks the interaction up again (where the winner left it). The claim is taken only over the
 * interaction as the submit read it (step, context, contract), the interaction is written only
 * under it, and a submit that does not save its step lets go of it.
 */
async function claimRuntimeSubmit(
  db: DatabaseAdapter,
  tenantId: string,
  interaction: FlowInteractionRow,
  claimId: string,
  now: number
): Promise<'claimed' | 'conflict' | 'not_active'> {
  let claimed: ExecuteResult;
  try {
    claimed = await db.execute(
      `UPDATE flow_interactions
          SET submit_claim_id = ?, submit_claim_expires_at = ?
        WHERE tenant_id = ? AND id = ? AND state IN ('created', 'active')
          AND current_step_id = ?
          AND context_json ${nullSafeEquals(db)} ? AND contract_hash = ? AND signature = ?
          AND (submit_claim_expires_at IS NULL OR submit_claim_expires_at <= ?)`,
      [
        claimId,
        now + FLOW_SUBMIT_CLAIM_TTL_SECONDS,
        tenantId,
        interaction.id,
        interaction.current_step_id,
        // As it was read and verified: a resume that wrote since (a new contract, the context
        // it shows) is not written over with what this submit read before it.
        interaction.context_json,
        interaction.contract_hash,
        interaction.signature,
        now,
      ]
    );
  } catch (error) {
    // Aurora DSQL refuses the second of two concurrent claims at its commit.
    if (isSerializationConflict(error)) return 'conflict';
    throw error;
  }
  if ((claimed.rowsAffected ?? 0) > 0) return 'claimed';
  const current = await db.queryOne<{ state: string }>(
    'SELECT state FROM flow_interactions WHERE tenant_id = ? AND id = ?',
    [tenantId, interaction.id]
  );
  return current && (current.state === 'created' || current.state === 'active')
    ? 'conflict'
    : 'not_active';
}

/** Lets go of a claim whose submit did not save its step (a refusal, a failure). */
async function releaseRuntimeSubmitClaim(
  c: AuthContext,
  db: DatabaseAdapter,
  tenantId: string,
  interactionId: string,
  claimId: string
): Promise<void> {
  try {
    await db.execute(
      `UPDATE flow_interactions SET submit_claim_id = NULL, submit_claim_expires_at = NULL
        WHERE tenant_id = ? AND id = ? AND submit_claim_id = ?`,
      [tenantId, interactionId, claimId]
    );
  } catch (error) {
    // The claim lapses at its expiry: the answer already decided is not replaced by this failure.
    getLogger(c)
      .module('LOGIN-RUNTIME-FLOW')
      .warn('Failed to release the Flow submit claim', {
        action: 'flow_submit_claim_release',
        interaction_id: interactionId,
        error: error instanceof Error ? error.name : 'unknown',
      });
  }
}

function stepConflictError(c: AuthContext, interactionId: string) {
  return runtimeError(
    c,
    409,
    'step_conflict',
    'This step was submitted at the same time from elsewhere; load the interaction again',
    'AR_FLOW_STEP_CONFLICT',
    'recoverable',
    'retry_step',
    interactionId
  );
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

/**
 * The scope of an authorization request as a list, whole: the request was accepted as it is, so
 * no scope is cut off here (unlike lists a caller supplies, which parseStringList bounds).
 */
function parseScopeList(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\s+/)
      : [];
  return Array.from(
    new Set(rawValues.filter((item): item is string => typeof item === 'string' && item !== ''))
  );
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

/**
 * A string array read back from a stored record (scopes, field keys), whole: it was accepted when
 * it was written, so nothing is cut off. Absent is an empty list; anything that is not a list of
 * strings is null, which the caller treats as not covering anything (the consent is asked again).
 */
function parseStoredStringArray(value: unknown): string[] | null {
  if (value === undefined || value === null || value === '') return [];
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.every((item): item is string => typeof item === 'string') ? parsed : null;
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
      return candidate;
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

function normalizeRegistrationFieldKey(field: string): string {
  const normalized = field.trim().toLowerCase();
  return normalized.startsWith('field.canonical.')
    ? normalized.slice('field.canonical.'.length)
    : normalized;
}

/** The input parts that answer an attribute of the profile. */
const PROFILE_INPUT_BLOCK_TYPES = new Set(['identity_field', 'select', 'radio', 'checkbox']);

function registrationIdentityFieldKey(field: FlowRuntimeJsonObject): string | null {
  const fieldName = readString(field.field, 200);
  const blockType = readString(field.block_type, 80) ?? 'identity_field';
  if (!PROFILE_INPUT_BLOCK_TYPES.has(blockType) || !fieldName) return null;
  // An answer not stored to the profile is not an attribute, whatever its key.
  if (field.store_to_profile === false) return null;
  return normalizeRegistrationFieldKey(fieldName);
}

async function applyRegistrationSchemaRequirements(
  db: DatabaseAdapter,
  tenantId: string,
  fields: FlowRuntimeJsonObject[]
): Promise<FlowRuntimeJsonObject[]> {
  const schemas = await db.query<{ field_key: string; registration_required: number }>(
    `SELECT field_key, registration_required
     FROM custom_claim_schemas
     WHERE tenant_id = ? AND is_active = 1`,
    [tenantId]
  );
  const schemaRequirements = new Map<string, boolean>();
  for (const schema of schemas) {
    const fieldKey = normalizeRegistrationFieldKey(schema.field_key);
    schemaRequirements.set(
      fieldKey,
      (schemaRequirements.get(fieldKey) ?? false) || schema.registration_required === 1
    );
  }

  return fields.map((field) => {
    const fieldKey = registrationIdentityFieldKey(field);
    if (!fieldKey) return field;
    const required = schemaRequirements.get(fieldKey);
    if (required === undefined) return field;
    return { ...field, required };
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
  status: 400 | 401 | 403 | 404 | 409 | 500 | 503,
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

function sanitizeRuntimeStartDiagnosticSessionId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, MAX_DIAGNOSTIC_SESSION_ID_LENGTH);
}

function isRuntimeStartTimingEnabled(env: FlowRuntimeEnv, request?: Request): boolean {
  if (
    isDiagnosticTimingEnabled(env) &&
    sanitizeRuntimeStartDiagnosticSessionId(request?.headers.get(DIAGNOSTIC_SESSION_ID_HEADER))
  ) {
    return true;
  }
  const value = env.AUTHRIM_FLOW_RUNTIME_TIMING?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function isDiagnosticTimingEnabled(env: FlowRuntimeEnv): boolean {
  const value = env.AUTHRIM_DIAGNOSTIC_TIMING_ENABLED?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function runtimeStartTimingNowMs(): number {
  return Date.now();
}

function roundRuntimeStartDurationMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function createRuntimeStartTiming(
  env: FlowRuntimeEnv,
  request?: Request
): RuntimeStartTiming | null {
  const diagnosticSessionId = sanitizeRuntimeStartDiagnosticSessionId(
    request?.headers.get(DIAGNOSTIC_SESSION_ID_HEADER)
  );
  if (!isRuntimeStartTimingEnabled(env, request)) {
    return null;
  }
  return {
    startedAtMs: runtimeStartTimingNowMs(),
    spans: [],
    diagnosticSessionId,
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
  if (timing.diagnosticSessionId) {
    c.header('X-Authrim-Diagnostic-Session-Id', timing.diagnosticSessionId);
  }
  getLogger(c)
    .module('LOGIN-RUNTIME-FLOW-TIMING')
    .info('LoginUI runtime Flow start timing', {
      diagnosticSessionId: timing.diagnosticSessionId,
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
  const values = LOGIN_RUNTIME_FEATURE_KEYS.map((key) => readSettingsFlag(settings, key));
  if (values.includes(true)) return true;
  // An explicit false wins over the environment flag; unset keys fall back to it.
  if (values.includes(false)) return false;
  return null;
}

async function isLoginRuntimeFlowEnabled(env: Env, tenantId: string): Promise<boolean> {
  if (env.ENABLE_SAML_DR_EXPORT === 'true') return readSamlDrFlowRuntimeEnabled(env, tenantId);
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

  const settings = await getTenantSettingsDocument(env, tenantId, 'feature-flags');
  const settingValue = readLoginRuntimeFlagFromSettings(settings);
  if (settingValue !== null) {
    return cacheValue(settingValue);
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

  // The app a Flow is chosen for is the app the interaction is recorded and checked for: a target
  // that names one app (or the tenant) while the request names another is refused, or the Flow of
  // one would run for another's authorization request (sign-in-flow-binding).
  if (explicitTargetType) {
    if (explicitTargetType === 'tenant') {
      if (clientId || samlSpId) return null;
      return { targetType: 'tenant', targetId: null, clientId: null, samlSpId: null };
    }
    if (explicitTargetType === 'oidc_client' && explicitTargetId) {
      if (samlSpId || (clientId && clientId !== explicitTargetId)) return null;
      return {
        targetType: 'oidc_client',
        targetId: explicitTargetId,
        clientId: explicitTargetId,
        samlSpId: null,
      };
    }
    if (explicitTargetType === 'saml_sp' && explicitTargetId) {
      if (clientId || (samlSpId && samlSpId !== explicitTargetId)) return null;
      return {
        targetType: 'saml_sp',
        targetId: explicitTargetId,
        clientId: null,
        samlSpId: explicitTargetId,
      };
    }
    return null;
  }
  // Both an OIDC client and a SAML SP: which app it is for cannot be told.
  if (clientId && samlSpId) return null;

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
         AND a.enabled = TRUE
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
       AND a.enabled = TRUE
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
              ? {
                  client_id: requestContext.client_id,
                  authorization_challenge_id: requestContext.authorization_challenge_id,
                  requested_scope: requestContext.requested_scope,
                }
              : null,
          saml: requestContext.saml_sp_id
            ? {
                saml_sp_id: requestContext.saml_sp_id,
                saml_request_id: requestContext.saml_request_id,
                saml_sp_entity_id: requestContext.saml_sp_entity_id,
              }
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
    requestContext.requested_claims ?? [],
    requestContext.contract_revision ?? null,
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
    input.requestContext,
    parseEditorSnapshot(input.version.editor_snapshot_json)
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

function hasExplicitReadableExternalProviderUsage(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (typeof value !== 'string') return false;
  if (!value.trim()) return true;
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}

function isSAMLProviderUsage(provider: Record<string, unknown>): boolean {
  const providerId = readString(provider.id, 200) ?? readString(provider.providerId, 200);
  return providerId?.startsWith('saml:') === true;
}

function shouldFetchRuntimeExternalProviderHandles(
  rawProviderUsage: unknown,
  providerUsage: Array<Record<string, unknown>>,
  usage: 'login' | 'signup'
): boolean {
  if (!hasExplicitReadableExternalProviderUsage(rawProviderUsage)) {
    // Legacy tenant: bridge providers may exist before external_provider_usage is saved.
    return true;
  }
  return providerUsage.some(
    (provider) => !isSAMLProviderUsage(provider) && externalProviderUsageEnabled(provider, usage)
  );
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
  component: string,
  /** The step's authentication method profile (`default`: the tenant's methods as they are). */
  profileRef: string | null = null
): Promise<string[]> {
  const env = c.env;
  const rawSettings = await env.SETTINGS?.get(`settings:tenant:${tenantId}:authentication-methods`);
  // The platform's Default methods under the tenant's (default-profile-layer.ts). Unreadable, it
  // is thrown (the step fails) rather than offering methods the platform may have turned off.
  const settings = await layerTenantSettingsDocument(
    env,
    'authentication-methods',
    parseJsonRecord(rawSettings)
  );
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

  if (
    usage === 'login' &&
    readBooleanSetting(settings, 'authentication-methods.guest.login_enabled', false)
  ) {
    handles.push('guest');
  }

  const rawProviderUsage = settings['authentication-methods.external_provider_usage'];
  const providerUsage = parseAuthProviderUsage(rawProviderUsage);
  const usageById = indexExternalProviderUsage(providerUsage);
  for (const provider of providerUsage) {
    const providerId = readString(provider.id, 200);
    if (!providerId) continue;
    if (externalProviderUsageEnabled(provider, usage)) {
      handles.push(normalizeOutputHandle(providerId));
    }
  }
  if (shouldFetchRuntimeExternalProviderHandles(rawProviderUsage, providerUsage, usage)) {
    handles.push(...(await fetchRuntimeExternalProviderHandles(c, tenantId, usage, usageById)));
  }

  // The tenant's methods, narrowed by the step's profile (authentication-profile.ts).
  const profile = await readAuthenticationProfile(env, tenantId, profileRef);
  return narrowHandlesByProfile([...new Set(handles)], profile, usage);
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
  const row = await resolveRuntimeScreenRow(db, tenantId, screenRef, component);
  if (!row) return null;
  let fields = applyRuntimeScreenDefaultMetadata(
    row.screen_key,
    parseJsonObjectArray(row.fields_json)
  );
  if (row.screen_kind === 'registration') {
    fields = await applyRegistrationSchemaRequirements(db, tenantId, fields);
  }
  const localizations = parseRuntimeJsonObject(row.localizations_json);
  const language = requestedLanguage(requestContext);
  const localized = applyRuntimeScreenLocalization(fields, localizations, language, 'en');
  // The choices of the select and radio parts: the Identity Schema's now, or the part's own.
  const withOptions = await applyRuntimeScreenOptions(
    db,
    tenantId,
    localized.fields,
    localizations,
    language,
    screenLocalizationKey
  );
  return {
    id: row.id,
    screen_key: row.screen_key,
    display_name: localized.displayName ?? row.display_name,
    description: localized.description ?? row.description,
    screen_kind: row.screen_kind,
    fields: withOptions,
    localizations,
    settings: parseRuntimeJsonObject(row.settings_json),
  };
}

/** The step components that sign a person in or up on the built-in form when they name no screen. */
const SIGN_IN_SELECTOR_COMPONENTS: ReadonlySet<string> = new Set([
  'authentication_method_selector',
  'registration_method_selector',
]);

/** How many of an interaction's latest step visits a sign-up looks back through. */
const SIGN_UP_STEP_LOOKBACK = 20;
/** The most visits of one second read at the edge of that look-back. */
const SIGN_UP_SAME_SECOND_LIMIT = 200;

/** The screen a sign-up started from a Flow is checked against (see resolveSignUpScreen). */
export type SignUpFlowScreen =
  | { kind: 'screen'; stepId: string; screen: FlowRuntimeJsonObject }
  /** A sign-in step that shows the built-in form: the Identity Schema alone says what is asked. */
  | { kind: 'built_in' }
  | { kind: 'invalid'; reason: 'interaction_not_found' | 'not_a_sign_up_step' };

/**
 * The screen a sign-up told about the Flow interaction `interactionId` was entered on, as the
 * server resolves it (never what the browser says the screen was). It is the screen of the
 * interaction's current step when that step is one a person signs in or up on (its screen has a
 * sign-in part, or it is a method selector showing the built-in form); otherwise that of the
 * latest step visited that is one (a code resent from the code step after the choice: the
 * registration's values are still those entered before it). An interaction that is not live, or
 * has no such step, is no place to sign up from.
 */
export async function resolveSignUpScreen(
  c: AuthContext,
  tenantId: string,
  interactionId: string
): Promise<SignUpFlowScreen> {
  const db = createAuthContextFromHono(c, tenantId).coreAdapter;
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
    interaction.expires_at <= nowSeconds()
  ) {
    return { kind: 'invalid', reason: 'interaction_not_found' };
  }
  const version = await getFlowVersion(
    db,
    tenantId,
    interaction.flow_id,
    interaction.flow_version_id
  );
  const runtime = version ? parseRuntimeSnapshot(version.runtime_snapshot_json) : null;
  if (!runtime) return { kind: 'invalid', reason: 'not_a_sign_up_step' };

  type Visit = { step_id: string; created_at: number; state_json: string | null };
  let visits = await db.query<Visit>(
    `SELECT step_id, created_at, state_json FROM flow_interaction_steps
      WHERE tenant_id = ? AND interaction_id = ? AND state <> 'skipped'
      ORDER BY created_at DESC, id DESC
      LIMIT ${SIGN_UP_STEP_LOOKBACK}`,
    [tenantId, interaction.id]
  );
  // The visits of the oldest second listed may go on past the limit: all of that second are read
  // instead, so the order below never misses a later one of it.
  if (visits.length === SIGN_UP_STEP_LOOKBACK) {
    const boundary = visits[visits.length - 1].created_at;
    const sameSecond = await db.query<Visit>(
      `SELECT step_id, created_at, state_json FROM flow_interaction_steps
        WHERE tenant_id = ? AND interaction_id = ? AND state <> 'skipped' AND created_at = ?
        LIMIT ${SIGN_UP_SAME_SECOND_LIMIT + 1}`,
      [tenantId, interaction.id, boundary]
    );
    // More than that in one second is no order to tell the step a sign-up started on by.
    if (sameSecond.length > SIGN_UP_SAME_SECOND_LIMIT) {
      return { kind: 'invalid', reason: 'not_a_sign_up_step' };
    }
    visits = [...visits.filter((visit) => visit.created_at !== boundary), ...sameSecond];
  }
  // Latest first: by when each visit was completed, to the millisecond where it was recorded
  // (two steps can be passed within the second `created_at` counts), else by its second.
  const visitedAt = (visit: { created_at: number; state_json: string | null }) => {
    const ms = parseJsonObject(visit.state_json).completed_at_ms;
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : Number(visit.created_at) * 1000;
  };
  const visited = [...visits].sort((a, b) => visitedAt(b) - visitedAt(a));
  const candidates: string[] = [];
  for (const stepId of [interaction.current_step_id, ...visited.map((row) => row.step_id)]) {
    if (stepId && !candidates.includes(stepId)) candidates.push(stepId);
  }
  const requestContext = getRequestContextFromInteraction(interaction);
  for (const stepId of candidates) {
    const step = runtime.ui.steps.find((candidate) => candidate.id === stepId);
    if (!step) continue;
    const screenRef = readString(parseJsonRecord(step.config).screen_ref, 200);
    if (!screenRef) {
      if (SIGN_IN_SELECTOR_COMPONENTS.has(step.component)) return { kind: 'built_in' };
      continue;
    }
    const screen = await resolveRuntimeScreenContent(
      db,
      tenantId,
      screenRef,
      step.component,
      requestContext
    );
    if (screen && hasSignInMethodPart(screen)) return { kind: 'screen', stepId, screen };
  }
  return { kind: 'invalid', reason: 'not_a_sign_up_step' };
}

async function resolveRuntimeDestinationFieldConsent(
  c: AuthContext,
  db: DatabaseAdapter,
  tenantId: string,
  requestContext: FlowRequestContext
): Promise<RuntimeDestinationFieldConsentContent | null> {
  if (requestContext.protocol === 'direct') return null;
  // An OIDC request reads the Admin database only when the Mapping Set it is bound to is one (a
  // selection of none needs none), and fails then if it is not bound, as the release of claims
  // does. The other protocols have nothing to look up without it.
  if (!c.env.DB_ADMIN && requestContext.protocol !== 'oidc') return null;

  const adminAdapter = c.env.DB_ADMIN
    ? requireDedicatedAdminDatabaseAdapter(c.env, 'flow-destination-profile-consent')
    : null;
  const selector = await resolveRuntimeDestinationProfileSelector(
    db,
    adminAdapter,
    c.env,
    tenantId,
    requestContext
  );
  if (!selector) return null;
  // A selector is only returned with an Admin database to read the profile from.
  if (!adminAdapter) return null;
  const descriptor = await loadDestinationProfileConsentDescriptor(
    adminAdapter,
    tenantId,
    selector.profileId
  );
  if (!descriptor || descriptor.destinationType !== requestContext.protocol) return null;

  const fields = applicableDestinationConsentFields(
    descriptor,
    requestContext,
    selector.fieldPolicies,
    selector.claimsPolicy
  );
  if (fields.length === 0) return null;
  return {
    profile_id: descriptor.profileId,
    profile_version_id: descriptor.profileVersionId,
    consent_version: resolveDestinationProfileConsentVersion(
      descriptor.profileVersionId,
      selector.fieldPolicies
    ),
    destination_type: descriptor.destinationType,
    consent_mode: selector.consentMode ?? null,
    fields: fields.map((field) => ({
      key: field.key,
      label: field.label,
      required: field.required,
      nullable: field.nullable,
      classification: field.classification,
      surfaces: field.surfaces,
      required_scopes:
        descriptor.destinationType === 'oidc'
          ? resolveOidcFieldRequiredScopes(field)
          : field.requiredScopes,
    })),
  };
}

async function resolveRuntimeDestinationProfileSelector(
  db: DatabaseAdapter,
  adminDb: DatabaseAdapter | null,
  env: Env,
  tenantId: string,
  requestContext: FlowRequestContext
): Promise<{
  profileId: string;
  fieldPolicies?: DestinationFieldReleasePolicies;
  consentMode?: 'once' | 'every_time' | 'until_attributes_change';
  /** The client's policy for claims requested through the claims parameter. */
  claimsPolicy?: OIDCClaimsClientPolicy;
} | null> {
  if (requestContext.protocol === 'oidc' && requestContext.client_id) {
    const row = await db.queryOne<{
      identity_mapping: string | null;
      attribute_release_consent: string | null;
      allow_claims_without_scope?: number | boolean | null;
      claims_parameter_policy?: string | null;
    }>(
      `SELECT identity_mapping, attribute_release_consent, allow_claims_without_scope,
              claims_parameter_policy
         FROM oauth_clients
        WHERE tenant_id = ? AND client_id = ?`,
      [tenantId, requestContext.client_id]
    );
    const claimsPolicy: OIDCClaimsClientPolicy = {
      allow_claims_without_scope:
        row?.allow_claims_without_scope === 1 || row?.allow_claims_without_scope === true,
      claims_parameter_policy: parseJsonRecord(
        row?.claims_parameter_policy
      ) as OIDCClaimsClientPolicy['claims_parameter_policy'],
    };
    // The same selection and reading of the Mapping Set the ID token and UserInfo go through
    // (applyOIDCIdentityMapping), so the fields the user is asked about are the fields the release
    // is held to. An app's own choice, else the tenant's default, else the platform's, else none:
    // an activation's scope never binds an app to a set. A choice that cannot be used fails.
    let profileId: string | undefined;
    try {
      const resolution = await resolveOidcIdentityMappingBinding({
        env,
        tenantId,
        clientId: requestContext.client_id,
        clientSelector: row?.identity_mapping,
      });
      // Exactly one Destination Profile is checked by the reading of the set.
      profileId = resolution.binding?.destinationProfileId;
    } catch (error) {
      throw toOidcIdentityMappingRuntimeError(error, { clientId: requestContext.client_id });
    }
    return profileId
      ? {
          profileId,
          consentMode: readAttributeReleaseConsentMode(row?.attribute_release_consent),
          claimsPolicy,
        }
      : null;
  }

  if (requestContext.protocol === 'saml' && requestContext.saml_sp_id) {
    if (!adminDb) return null;
    const rows = await db.query<{ id: string; config_json: string }>(
      `SELECT id, config_json
         FROM identity_providers
        WHERE tenant_id = ? AND provider_type = 'saml_sp' AND enabled = 1`,
      [tenantId]
    );
    const expectedIds = new Set(
      [requestContext.saml_sp_id, requestContext.saml_sp_entity_id].filter(
        (value): value is string => Boolean(value)
      )
    );
    for (const row of rows) {
      const config = parseJsonRecord(row.config_json);
      if (!expectedIds.has(row.id) && !expectedIds.has(readString(config.entityId, 512) ?? '')) {
        continue;
      }
      const selector = parseJsonRecord(config.identityMapping);
      const fieldMappingSetId = readString(selector.fieldMappingSetId, 200);
      let profileId: string | undefined;
      if (fieldMappingSetId) {
        const binding = await resolveRuntimeIdentityMappingBinding(adminDb, {
          tenantId,
          protocol: 'saml',
          role: 'idp',
          fieldMappingSetId,
          fieldMappingVersionId: readString(selector.fieldMappingVersionId, 200) ?? undefined,
          partnerEntityId: readString(config.entityId, 512) ?? undefined,
        });
        if (
          !binding ||
          binding.destinationProfileIds.length !== 1 ||
          !binding.destinationProfileId
        ) {
          throw new Error('SAML Mapping Set must resolve exactly one Destination Profile');
        }
        profileId = binding.destinationProfileId;
      } else {
        profileId = readString(selector.destinationProfileId, 200) ?? undefined;
      }
      return profileId
        ? {
            profileId,
            fieldPolicies: readDestinationFieldReleasePolicies(selector.destinationFieldPolicies),
            consentMode: readAttributeReleaseConsentMode(config.attributeReleaseConsent),
          }
        : null;
    }
  }
  return null;
}

function readAttributeReleaseConsentMode(
  value: unknown
): 'once' | 'every_time' | 'until_attributes_change' | undefined {
  const policy = parseJsonRecord(value);
  if (policy.enabled !== true) return undefined;
  return policy.mode === 'every_time' || policy.mode === 'until_attributes_change'
    ? policy.mode
    : 'once';
}

function applicableDestinationConsentFields(
  descriptor: DestinationProfileConsentDescriptor,
  requestContext: FlowRequestContext,
  fieldPolicies?: DestinationFieldReleasePolicies,
  claimsPolicy?: OIDCClaimsClientPolicy
) {
  if (descriptor.destinationType === 'saml') {
    return descriptor.fields
      .filter((field) => fieldPolicies?.[field.key] !== 'hidden')
      .map((field) => ({
        ...field,
        required: fieldPolicies?.[field.key] === 'required',
        nullable: fieldPolicies?.[field.key] === 'required' ? false : true,
      }));
  }
  // The release filter's own judgement, so the fields asked about and required here are the
  // fields that can be released: a standard claim that lists no scope needs its OIDC scope.
  const scopes =
    requestContext.requested_scope.length === 0 ? null : new Set(requestContext.requested_scope);
  // A claim the request names in its claims parameter and the client's policy lets through
  // without its scope is released as the scope claims are (the OIDC scope it would need counts as
  // granted, a scope of the profile's own does not), so its field is asked about too.
  const requestedClaims = new Set(
    (requestContext.requested_claims ?? []).filter((name) =>
      canReleaseClaim(name, scopes ?? new Set<string>(), claimsPolicy ?? {})
    )
  );
  return descriptor.fields.filter((field) => {
    const standardScope = requestedClaims.has(field.key)
      ? OIDC_STANDARD_CLAIM_SCOPE[field.key]
      : undefined;
    return isOidcFieldApplicableToScopes(
      field,
      scopes && standardScope ? new Set([...scopes, standardScope]) : scopes
    );
  });
}

function readDestinationFieldReleasePolicies(
  value: unknown
): DestinationFieldReleasePolicies | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const policies: DestinationFieldReleasePolicies = {};
  for (const [key, mode] of Object.entries(value)) {
    if (mode === 'required' || mode === 'optional' || mode === 'hidden') {
      policies[key] = mode;
    }
  }
  return policies;
}

async function hydrateRuntimeContract(
  c: AuthContext,
  db: DatabaseAdapter,
  tenantId: string,
  runtime: FlowRuntimeContract,
  requestContext: FlowRequestContext,
  editor: FlowEditorState | null = null
): Promise<FlowRuntimeContract> {
  const destinationFieldConsent = await resolveRuntimeDestinationFieldConsent(
    c,
    db,
    tenantId,
    requestContext
  );
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
          step.component,
          readString(config.authentication_profile_ref, 200)
        );
        // Never advertise a guest action that has no route through the published Flow.
        if (
          editor &&
          !editor.edges.some(
            (edge) => edge.source === step.source_node_id && edge.source_handle === 'guest'
          )
        ) {
          const guestIndex = handles.indexOf('guest');
          if (guestIndex >= 0) handles.splice(guestIndex, 1);
        }
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
      if (step.component === 'consent_policy' && destinationFieldConsent) {
        nextContent.destination_field_consent = destinationFieldConsent;
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

  // A SAML SP target takes the challenge of a SAML request; any other target must be an OIDC client.
  const samlTarget = requestContext.protocol === 'saml';
  if (!samlTarget && (requestContext.protocol !== 'oidc' || !target.clientId)) {
    return jsonError(
      c,
      400,
      'invalid_authorization_challenge',
      'Authorization challenge can only be used with an OIDC client or SAML SP Flow target',
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

  // Gone or used: the request has expired, which is what the user is told (not that it is invalid).
  if (!challenge || challenge.tenantId !== tenantId || challenge.consumed) {
    return jsonError(
      c,
      400,
      authorizationRequestExpired().error,
      authorizationRequestExpired().message ?? '',
      'AR_FLOW_AUTH_REQUEST_EXPIRED'
    );
  }
  if (challenge.type !== 'login' && challenge.type !== 'reauth') {
    return jsonError(
      c,
      400,
      'invalid_authorization_challenge',
      'Authorization challenge is invalid or expired',
      'AR_FLOW_AUTH_CHALLENGE_INVALID'
    );
  }

  if (samlTarget) {
    // The binding is the challenge's own: the SAML request, SP and tenant it was issued for.
    const samlCheck = checkSAMLChallengeForFlow(challenge, {
      tenantId,
      targetType: target.targetType,
      targetId: target.targetId,
      samlSpId: target.samlSpId,
      clientId: target.clientId,
      samlRequestId: requestContext.saml_request_id,
      samlSpEntityId: requestContext.saml_sp_entity_id,
    });
    if (!samlCheck.ok) {
      return jsonError(
        c,
        403,
        'authorization_challenge_mismatch',
        'Authorization challenge does not match the requested SAML request',
        'AR_FLOW_AUTH_CHALLENGE_MISMATCH'
      );
    }
    // A SAML request asks for no scope or claims.
    return null;
  }
  if (isSAMLAuthorizationChallenge(challenge.metadata)) {
    // A SAML request's challenge is not an OIDC authorization request.
    return jsonError(
      c,
      403,
      'authorization_challenge_mismatch',
      'Authorization challenge does not match the requested client',
      'AR_FLOW_AUTH_CHALLENGE_MISMATCH'
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

  // What the authorization request itself asks for, read from the request and never from the
  // caller: its scope (the Login UI does not send one, and an unknown scope would make every
  // field of the profile look asked for) and the claims its claims parameter names. Of those
  // claims only the standard ones can change what is asked about (a custom claim has no OIDC scope
  // to be released without), so only they are kept: a short, fixed set, nothing cut off.
  const challengeScope = parseScopeList(challenge.metadata?.scope);
  if (challengeScope.length > 0) requestContext.requested_scope = challengeScope;
  const claims = challenge.metadata?.claims;
  const claimsRequest = parseClaimsRequest(typeof claims === 'string' ? claims : undefined);
  requestContext.requested_claims = claimsRequest.request
    ? Array.from(
        new Set(
          [
            ...Object.keys(claimsRequest.request.id_token ?? {}),
            ...Object.keys(claimsRequest.request.userinfo ?? {}),
          ].filter((name) => Object.prototype.hasOwnProperty.call(OIDC_STANDARD_CLAIM_SCOPE, name))
        )
      )
    : [];
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
    requested_scope: parseScopeList(raw.requested_scope),
    requested_claims: parseStringList(raw.requested_claims),
    locale: readOptionalString(raw.locale, 64),
    contract_revision: readOptionalString(raw.contract_revision, 64),
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

/**
 * An identifier made from what a record is about, so the same record has the same identifier
 * however often it is written (the table's primary key then keeps it from being written twice).
 */
async function deterministicRecordId(
  kind: string,
  ...parts: Array<string | null>
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([kind, ...parts]))
  );
  return `${kind}_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
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

/**
 * The handle a step's submit is routed by: a screen's own exit with no edge of its own follows
 * the screen's submit, and an exit the screen does not offer is `undefined` (see
 * `screenRoutingHandle`); every other handle as it was sent.
 */
function routingHandleOf(
  step: FlowRuntimeStep,
  editor: FlowEditorState | null,
  handle: string | null
): string | null | undefined {
  if (step.component !== 'screen') return handle;
  const outgoing = (editor?.edges ?? [])
    .filter((edge) => edge.source === step.source_node_id)
    .map((edge) => edge.source_handle);
  return screenRoutingHandle(parseJsonRecord(step.config).screen, handle, outgoing);
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

function withoutRuntimeDestinationFieldConsent(step: FlowRuntimeStep): FlowRuntimeStep {
  const remainingContent = {
    ...(parseJsonRecord(step.content) as FlowRuntimeJsonObject),
  };
  delete remainingContent.destination_field_consent;
  return {
    ...step,
    content: remainingContent,
  };
}

function readRuntimeDestinationFieldConsent(
  step: FlowRuntimeStep
): RuntimeDestinationFieldConsentContent | null {
  const content = parseJsonRecord(step.content);
  const consent = parseJsonRecord(content.destination_field_consent);
  const profileId = readString(consent.profile_id, 200);
  const profileVersionId = readString(consent.profile_version_id, 200);
  if (
    !profileId ||
    !profileVersionId ||
    (consent.destination_type !== 'oidc' && consent.destination_type !== 'saml') ||
    !Array.isArray(consent.fields)
  ) {
    return null;
  }
  return {
    ...consent,
    consent_version: readString(consent.consent_version, 240) ?? profileVersionId,
  } as RuntimeDestinationFieldConsentContent;
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
  c: AuthContext,
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
      requestContext.protocol === 'oidc' || requestContext.protocol === 'saml'
        ? requestContext.protocol
        : undefined,
    authenticated: Boolean(authenticationMethod),
    client_id: interaction.client_id ?? undefined,
    saml_sp_id: interaction.saml_sp_id ?? undefined,
    flow_kind: runtime.flow_kind,
    requested_scope: parseScopeList(requestContext.requested_scope),
    authentication_method: authenticationMethod,
    user: interaction.user_id
      ? await getFlowConditionUserContext(c, db, tenantId, interaction.user_id)
      : undefined,
    // The choices screen steps sent to the Flow (a screen answer condition reads them).
    screen_answers: screenAnswersOf(requestContext.screen_answers),
  };
}

async function getFlowConditionUserContext(
  c: AuthContext,
  db: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<NonNullable<FlowConditionEvaluationContext['user']>> {
  // Role and organisation definitions are in the tenant metadata database (`db`); the user's
  // assignments and memberships in the user's account database. A user the tenant has no account
  // for has none; one whose account or roles cannot be read throws, so no condition is decided
  // without them (a condition may route admins to a stronger step).
  let rbac: TenantRBACDatabases | null = null;
  try {
    const account = await resolveAccountCoreDataContext(c.env, { tenantId, accountId: userId });
    rbac = { metadata: db, account: account.coreDb };
  } catch (error) {
    if (!(error instanceof Error && error.message === 'account_data_route_not_found')) throw error;
  }
  const [roles, orgIds] = await Promise.all([
    getFlowConditionUserRoles(db, rbac, tenantId, userId),
    getFlowConditionUserOrgIds(rbac, tenantId, userId),
  ]);
  return {
    roles,
    org_ids: orgIds,
  };
}

async function getFlowConditionUserRoles(
  metadata: DatabaseAdapter,
  rbac: TenantRBACDatabases | null,
  tenantId: string,
  userId: string
): Promise<string[]> {
  try {
    const rows = await metadata.query<{ name: string }>(
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

  if (!rbac) return [];
  const roles = await resolveSubjectRoles(rbac, tenantId, userId);
  return [...new Set(roles.map(({ role }) => role.name))].filter(Boolean);
}

async function getFlowConditionUserOrgIds(
  rbac: TenantRBACDatabases | null,
  tenantId: string,
  userId: string
): Promise<string[]> {
  if (!rbac) return [];
  // Active organisations only, as tokens, consent and the Check API see them.
  const memberships = await resolveSubjectOrganizations(rbac, tenantId, userId, {
    activeOnly: true,
  });
  return [...new Set(memberships.map(({ organization }) => organization.id))];
}

async function resolveConditionSelectedHandle(input: {
  c: AuthContext;
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

  let context: FlowConditionEvaluationContext;
  try {
    context = await buildConditionEvaluationContext(
      input.c,
      input.db,
      input.tenantId,
      input.interaction,
      input.runtime
    );
  } catch (error) {
    // The user's roles or organisations could not be read: no branch is chosen without them.
    getLogger(input.c)
      .module('LOGIN-RUNTIME-FLOW')
      .warn('Flow condition context unavailable', {
        tenantId: input.tenantId,
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
    return { selectedHandle: null, errorCode: 'AR_FLOW_CONDITION_CONTEXT_UNAVAILABLE' };
  }
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
  requestContext: FlowRequestContext,
  options: RuntimeSessionOptions = {}
): Promise<{
  selectedHandle: 'continue' | 'authenticate' | null;
  userId: string | null;
  terminalError?: FlowRuntimeTerminalError;
  /** The request could not be read: no branch is chosen, the browser asks again. */
  unavailable?: true;
}> {
  // Only a session the request accepts (see resolveSessionForChallenge) can continue; anything
  // else signs in. A request that cannot be read decides nothing (the browser asks again), and one
  // that is gone cannot be answered by signing in: that ends the interaction, as it says.
  const usable = await resolveSessionForChallenge(
    c,
    tenantId,
    requestContext.authorization_challenge_id,
    { ...options, judgeChallengeWithoutSession: true }
  );
  if (usable.unavailable) {
    return { selectedHandle: null, userId: null, unavailable: true };
  }
  if (usable.expired) {
    return { selectedHandle: null, userId: null, terminalError: authorizationRequestExpired() };
  }
  const session = usable.session;
  if (!session?.userId) {
    return { selectedHandle: 'authenticate', userId: null };
  }
  return { selectedHandle: 'continue', userId: session.userId };
}

/** The authorization request is gone: no sign-in can answer it, it has to be started again. */
function authorizationRequestExpired(): FlowRuntimeTerminalError {
  return {
    error: 'authorization_request_expired',
    message: 'The authorization request has expired; start again from the application',
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
  unavailable?: true;
} | null> {
  if (input.step.component === 'condition') {
    return resolveConditionSelectedHandle({
      c: input.c,
      db: input.db,
      tenantId: input.tenantId,
      interaction: input.interaction,
      runtime: input.runtime,
      step: input.step,
    });
  }

  if (input.step.component === 'session_check') {
    return resolveSessionCheckSelectedHandle(
      input.c,
      input.tenantId,
      getRequestContextFromInteraction(input.interaction),
      sessionOptionsForRuntime(input.runtime, input.interaction)
    );
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

/**
 * What a session must be to answer this Flow besides the authorization request's own terms: for a
 * registration, one made since the interaction began (a registration is not answered by a session
 * that was already there).
 */
/**
 * When the interaction began, in milliseconds. An interaction made before the start was kept to the
 * millisecond is taken to have begun at the end of its second, so a session made within that
 * second does not count as made after it.
 */
function interactionStartedAtMs(interaction: FlowInteractionRow): number {
  const stored = parseJsonObject(interaction.context_json).started_at_ms;
  return typeof stored === 'number' && Number.isFinite(stored)
    ? stored
    : (interaction.expires_at - FLOW_RUNTIME_INTERACTION_TTL_SECONDS + 1) * 1000;
}

/**
 * Which sessions an interaction takes, beyond what its authorization request asks
 * (`resolveSessionForChallenge`).
 *
 * - A registration: only a sign-in made since it began (`createdAfterMs`).
 * - Any Flow: a session made since it began must have been made in it (`madeIn`). Its sign-in ran
 *   under this Flow's profiles only then; one made in another interaction (another request's Flow,
 *   with wider methods or a longer session) or in none would carry this Flow's request on settings
 *   it does not allow. A session from before the interaction is single sign-on, which the request
 *   judges. A sign-in route that does not record its interaction in the session is taken only
 *   while this Flow sets nothing of its own (both profiles Default).
 */
interface RuntimeSessionOptions {
  createdAfterMs?: number;
  madeIn?: { interactionId: string; startedAtMs: number; profilesAreDefault: boolean };
}

function sessionOptionsForRuntime(
  runtime: FlowRuntimeContract,
  interaction: FlowInteractionRow
): RuntimeSessionOptions {
  const startedAtMs = interactionStartedAtMs(interaction);
  const refs = flowProfileRefsOfRuntime(runtime);
  return {
    ...(runtime.flow_kind === 'registration' ? { createdAfterMs: startedAtMs } : {}),
    madeIn: {
      interactionId: interaction.id,
      startedAtMs,
      profilesAreDefault:
        refs.methodProfileRef === 'default' && refs.sessionProfileRef === 'default',
    },
  };
}

/** Whether a session may stand for the interaction (see `RuntimeSessionOptions.madeIn`). */
function sessionMadeInInteraction(
  session: Session,
  madeIn: RuntimeSessionOptions['madeIn']
): boolean {
  if (!madeIn || session.createdAt < madeIn.startedAtMs) return true;
  const recorded = session.data?.runtime_interaction_id;
  if (typeof recorded === 'string' && recorded) return recorded === madeIn.interactionId;
  return madeIn.profilesAreDefault;
}

/**
 * The browser's session as proof for the authorization challenge: the session, none, or a failure
 * to tell. A challenge that asks for a proof made after it (a sign-in for a client whose SSO is
 * off, or a re-authentication) is not answered by an older session: that session is "none", as if
 * the browser had no sign-in, and the user signs in with a method of their own. A challenge that
 * cannot be read is "unavailable", which is neither: the caller asks the browser to try again
 * instead of completing the interaction without (or with) a session it could not judge.
 */
type SessionForChallenge =
  | { unavailable: false; expired?: false; session: Session | null }
  | { unavailable: false; expired: true; session: null }
  | { unavailable: true };

async function resolveSessionForChallenge(
  c: AuthContext,
  tenantId: string,
  authorizationChallengeId: string | undefined | null,
  options: RuntimeSessionOptions & {
    /**
     * Judge the authorization request (is it gone) even with no session to judge: a request that
     * is gone is found out at once, not when the user has signed in to no purpose.
     */
    judgeChallengeWithoutSession?: boolean;
  } = {}
): Promise<SessionForChallenge> {
  const current = await getCurrentSession(c, tenantId);
  // A registration is answered only by a sign-in made since it began: a session from before
  // (another account's, or the same one's) is no proof of this registration. A session made
  // since the interaction began in another (or none) is no proof of it either: the person signs
  // in again, under this Flow.
  const session =
    current?.userId &&
    (options.createdAfterMs === undefined || current.createdAt >= options.createdAfterMs) &&
    sessionMadeInInteraction(current, options.madeIn)
      ? current
      : null;
  if (!authorizationChallengeId || (!session && !options.judgeChallengeWithoutSession)) {
    return { unavailable: false, session };
  }
  let freshness: Awaited<ReturnType<typeof readAuthorizationChallengeFreshness>>;
  try {
    freshness = await readAuthorizationChallengeFreshness(
      c.env,
      tenantId,
      authorizationChallengeId
    );
  } catch {
    return { unavailable: true };
  }
  if (!freshness) return { unavailable: false, session };
  // A challenge that is gone and left no confirmation is answered by no one; one that was
  // continued is answered again only for the user it was continued for. This is judged here, before
  // anything is recorded for the session's user.
  if (freshness.gone) return { unavailable: false, expired: true, session: null };
  if (!session) return { unavailable: false, session: null };
  if (freshness.confirmedFor && session.userId !== freshness.confirmedFor) {
    return { unavailable: false, session: null };
  }
  // A re-authentication is answered by the user it was asked of, with the method that proved the
  // session, after it was asked for. Any other session is no one's here.
  if (
    freshness.kind === 'reauth' &&
    freshness.subjectUserId &&
    session.userId !== freshness.subjectUserId
  ) {
    return { unavailable: false, session: null };
  }
  const proof = getSessionReauthProof(session);
  if (freshness.kind === 'reauth' && !proof.method) return { unavailable: false, session: null };
  return {
    unavailable: false,
    session: isProofOlderThanChallengeRequirement(
      freshness,
      getSessionAuthTime(session),
      proof.provenAtMs
    )
      ? null
      : session,
  };
}

/** What the session proves for a re-authentication: the server-recorded method and proof time. */
function getSessionReauthProof(session: Session) {
  return reauthProofFromRecord(
    session.data,
    Array.isArray(session.data?.amr) ? session.data.amr : undefined,
    Array.isArray(session.data?.unverified_amr) ? session.data.unverified_amr : undefined
  );
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
  /** The session the challenge accepts as proof, if any (see resolveSessionForChallenge). */
  session: Session | null;
}): Promise<{ redirectUrl?: string; response?: Response }> {
  if (
    (input.requestContext.protocol !== 'oidc' && input.requestContext.protocol !== 'saml') ||
    !input.requestContext.authorization_challenge_id
  ) {
    return {};
  }

  // Only a session the challenge accepts is used: an older one (SSO off, re-authentication) is
  // treated as none, so no continuation is attempted that would consume the challenge only to
  // refuse it. The user signs in with a method of their own and that proof answers the challenge.
  const session = input.session;
  const userId = input.resolvedUserId ?? session?.userId ?? null;
  if (!session || !userId) {
    return {};
  }
  // The session supplies the proof (its method and time): it must be the flow's user's.
  if (session.userId !== userId) {
    return {
      response: input.c.json(
        {
          error: 'access_denied',
          error_description: 'The signed-in session does not belong to this interaction',
        },
        403
      ),
    };
  }

  const reauthProof = getSessionReauthProof(session);
  const continuation = await consumeAuthorizationChallengeContinuation(
    input.c,
    input.tenantId,
    input.requestContext.authorization_challenge_id,
    userId,
    getSessionAuthTime(session),
    getRequestOrigin(input.c),
    // The method the server recorded for this session, never one the client names.
    reauthProof.method,
    reauthProof.provenAtMs
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

/**
 * Consent given at a method selection before sign-in, kept in the step's state until someone has
 * signed in to record it for: the decisions that were validated and the statements (with their
 * versions) they were given for, not the raw input, so that it is those versions that are recorded.
 */
interface HeldRuntimeConsent {
  policy: RuntimeConsentPolicyContent;
  decisions: Record<string, RuntimeConsentItemDecision>;
  destination?: {
    consent: RuntimeDestinationFieldConsentContent;
    selected_fields: string[];
  };
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
  env: Env,
  tenantId: string,
  interaction: FlowInteractionRow,
  input: RuntimeAuditEventInput
) {
  const createdAt = nowSeconds();
  await emitLogIcebergRow(env, {
    tenantId,
    sourceDataset: 'core.flow_audit_events',
    logType: 'normal',
    eventAt: createdAt * 1000,
    expiresAt: null,
    overview: {
      action: input.eventType,
      result: input.result,
      reason_code: input.errorCode ?? null,
      client_id: interaction.client_id,
      subject_id: input.userId ?? interaction.user_id ?? null,
    },
    row: {
      id: input.id ?? generateId(),
      tenant_id: tenantId,
      interaction_id: interaction.id,
      flow_id: interaction.flow_id,
      flow_version_id: interaction.flow_version_id,
      user_id: input.userId ?? interaction.user_id ?? null,
      client_id: interaction.client_id,
      saml_sp_id: interaction.saml_sp_id,
      node_id: input.nodeId ?? null,
      branch_handle_id: input.branchHandleId ?? null,
      event_type: input.eventType,
      result: input.result,
      error_code: input.errorCode ?? null,
      contract_hash: interaction.contract_hash,
      metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
      method: null,
      reason_code: null,
      subject_hash: null,
      inquiry_number: null,
      created_at: createdAt,
    },
  });
}

function asRuntimeFlowError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function scheduleRuntimeAuditEvents(
  c: AuthContext,
  tenantId: string,
  interaction: FlowInteractionRow,
  events: RuntimeAuditEventInput[],
  label: string
): Promise<void> | undefined {
  if (events.length === 0) return undefined;

  const auditPromise = (async () => {
    for (const event of events) {
      await insertAuditEvent(c.env, tenantId, interaction, event);
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

async function getCurrentSession(c: AuthContext, tenantId: string): Promise<Session | null> {
  const sessionId = getSessionIdFromRequest(c);
  if (!sessionId || !isShardedSessionId(sessionId)) return null;
  const { stub: sessionStore } = getSessionStoreBySessionId(c.env, sessionId, tenantId);
  const session = (await sessionStore.getSessionRpc(sessionId)) as Session | null;
  if (!session || session.expiresAt <= Date.now()) return null;
  return session;
}

/** Verify the session proof against its owning account; Flow state remains tenant metadata. */
export async function getRecentVerifiedEmailSessionUserId(
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

  try {
    await resolveAccountDataContextFromHono(c, session.userId);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'lookup_destination_revalidation_failed' &&
      error.cause === 'account_inactive'
    ) {
      return null;
    }
    throw error;
  }
  const authCtx = createAccountAuthContextFromHono(c, tenantId);
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

function readDestinationFieldDecisionMap(input: unknown): Record<string, boolean> {
  const inputRecord = parseJsonRecord(input);
  const raw = parseJsonRecord(inputRecord.destination_field_decisions);
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
  );
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
      ORDER BY created_at DESC, id DESC
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

async function hasActiveDestinationFieldConsentRecord(input: {
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  requestContext: FlowRequestContext;
  userId: string;
  consent: RuntimeDestinationFieldConsentContent;
}): Promise<boolean> {
  if (input.consent.consent_mode === 'every_time') return false;
  const { recipientType, recipientId } = consentRecordRecipient(input);
  const destinationRecipientId =
    input.consent.destination_type === 'saml'
      ? (input.requestContext.saml_sp_entity_id ?? recipientId)
      : recipientId;
  const row = await input.db.queryOne<{
    id: string;
    released_scopes_json: unknown;
    evidence_json?: unknown;
  }>(
    `SELECT id, released_scopes_json, evidence_json
       FROM consent_records
      WHERE tenant_id = ?
        AND subject_user_id = ?
        AND protocol = ?
        AND recipient_type = ?
        AND ((recipient_id = ?) OR (recipient_id IS NULL AND ? IS NULL))
        AND binding_type = 'destination_field_mapping_set'
        AND binding_key = ?
        AND statement_id = ?
        AND statement_version = ?
        AND decision = 'selected'
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [
      input.tenantId,
      input.userId,
      input.requestContext.protocol,
      recipientType,
      destinationRecipientId,
      destinationRecipientId,
      input.consent.profile_id,
      `destination_profile:${input.consent.profile_id}`,
      input.consent.consent_version,
      nowSeconds(),
    ]
  );
  if (!row) return false;
  if (input.consent.destination_type !== 'oidc') return true;
  const storedScopes = parseStoredStringArray(row.released_scopes_json);
  if (!storedScopes) return false;
  const releasedScopes = new Set(storedScopes);
  if (!input.requestContext.requested_scope.every((scope) => releasedScopes.has(scope))) {
    return false;
  }
  // The consent covers the fields asked about now only if it was asked about them: a field a
  // claims parameter newly asks for (the scope unchanged) is asked about before it can be selected.
  // A record from before the fields were kept stands for the fields its scopes made applicable.
  const presented = parseStoredStringArray(parseJsonRecord(row.evidence_json).presented_field_keys);
  if (!presented) return false;
  const covered = new Set(presented);
  return input.consent.fields.every(
    (field) =>
      covered.has(field.key) ||
      (presented.length === 0 &&
        (field.key === 'sub' ||
          field.required_scopes.length === 0 ||
          field.required_scopes.some((scope) => releasedScopes.has(scope))))
  );
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
  let step = withRuntimeConsentPolicyContent(input.step, {
    ...policy,
    items: remainingItems,
  });
  const destinationFieldConsent = readRuntimeDestinationFieldConsent(step);
  if (
    destinationFieldConsent &&
    (await hasActiveDestinationFieldConsentRecord({
      db: input.db,
      tenantId: input.tenantId,
      interaction: input.interaction,
      requestContext: input.requestContext,
      userId: input.userId,
      consent: destinationFieldConsent,
    }))
  ) {
    step = withoutRuntimeDestinationFieldConsent(step);
  }
  return step;
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
  /** A request that decides the branch could not be read: nothing is decided. */
  unavailable?: true;
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
      if (autoAdvance.unavailable) {
        return { step: null, terminalStep: null, unavailable: true, userId, autoAdvancedSteps };
      }
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
      const destinationFieldConsent = readRuntimeDestinationFieldConsent(filteredStep);
      if (!policy || policy.items.length > 0 || destinationFieldConsent) {
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
}): Promise<string> {
  if (input.autoAdvancedSteps.length === 0) return input.initialStepRowId;

  // The visit of the step the person is shown (the interaction's current visit).
  let visitId = input.initialStepRowId;
  await writeAtomically(input.db, (write) => {
    for (let index = 0; index < input.autoAdvancedSteps.length; index += 1) {
      const advanced = input.autoAdvancedSteps[index];
      const stateJson = JSON.stringify({
        selected_handle: advanced.selectedHandle,
        submitted_handle: advanced.selectedHandle,
        completed_at: input.now,
        auto_advanced: true,
      });

      if (index === 0) {
        write(
          `UPDATE flow_interaction_steps
             SET state = 'completed', selected_handle = ?, state_json = ?, updated_at = ?
           WHERE tenant_id = ? AND id = ? AND state IN ('pending', 'waiting_input', 'processing')`,
          [advanced.selectedHandle, stateJson, input.now, input.tenantId, input.initialStepRowId]
        );
      } else {
        write(
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

    visitId = generateId();
    write(
      `INSERT INTO flow_interaction_steps (
        id, tenant_id, interaction_id, node_id, step_id, state, selected_handle, state_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      [
        visitId,
        input.tenantId,
        input.interaction.id,
        input.nextStep.source_node_id,
        input.nextStep.id,
        getStepStateForRuntimeStep(input.nextStep),
        input.now,
        input.now,
      ]
    );

    write(
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
  return visitId;
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

/** Exported for the tests of how records are written. */
export async function insertFlowConsentRecords(input: {
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
      // One record per interaction, step, statement and version: a retry of the same decision
      // changes nothing, and a retry with another decision replaces it (the last one stands).
      `INSERT INTO consent_records (
        id, tenant_id, subject_user_id, actor_user_id, protocol, consent_kind,
        client_id, saml_sp_id, recipient_type, recipient_id, binding_type, binding_key,
        resource_type, resource_id, purpose_key, statement_id, statement_version, policy_id,
        flow_id, flow_version_id, flow_node_id, decision, selected_value, selected_options_json,
        released_scopes_json, released_claims_json, released_attributes_json, status, expires_at,
        revoked_at, evidence_json, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        decision = excluded.decision,
        selected_value = excluded.selected_value,
        selected_options_json = excluded.selected_options_json,
        released_scopes_json = excluded.released_scopes_json,
        evidence_json = excluded.evidence_json,
        updated_at = excluded.updated_at`,
      [
        await deterministicRecordId(
          'consent',
          input.interaction.id,
          input.step.id,
          item.statement_id,
          item.version
        ),
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

/** Exported for the tests of how records are written. */
export async function insertDestinationFieldConsentRecord(input: {
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  step: FlowRuntimeStep;
  policyId: string;
  requestContext: FlowRequestContext;
  userId: string;
  consent: RuntimeDestinationFieldConsentContent;
  selectedFields: string[];
  /**
   * The consent version that applies as this is written (read just before, not the one this
   * record is in): the record in that version is the one that stands. A record in another version
   * (a request delayed past a change of the terms) is written but does not displace it.
   */
  currentConsentVersion?: string;
  ipHash?: string;
  userAgent?: string;
}): Promise<void> {
  const now = nowSeconds();
  const { recipientType, recipientId } = consentRecordRecipient(input);
  const destinationRecipientId =
    input.consent.destination_type === 'saml'
      ? (input.requestContext.saml_sp_entity_id ?? recipientId)
      : recipientId;
  const releasedScopes =
    input.requestContext.protocol === 'oidc' && input.requestContext.requested_scope.length > 0
      ? JSON.stringify(input.requestContext.requested_scope)
      : null;
  const releasedClaims =
    input.consent.destination_type === 'oidc' ? JSON.stringify(input.selectedFields) : null;
  const releasedAttributes =
    input.consent.destination_type === 'saml' ? JSON.stringify(input.selectedFields) : null;

  // One record per interaction, step, profile and consent version: a retry updates it (the last
  // selection stands). Afterwards every active record of the binding but one is retired, in one
  // statement, the record just written included. The one that stands is the one in the consent
  // version that applies (read just before, not the version this record is in), and then the latest
  // by (created_at, id): a record written late in an older version does not displace one in the
  // version that applies, and a retry of an older record does not retire a newer one. A reader asks
  // for the version that applies, and then takes the same order.
  const recordId = await deterministicRecordId(
    'consent_destination',
    input.interaction.id,
    input.step.id,
    input.consent.profile_id,
    input.consent.profile_version_id,
    input.consent.consent_version
  );
  await input.db.execute(
    `INSERT INTO consent_records (
      id, tenant_id, subject_user_id, actor_user_id, protocol, consent_kind,
      client_id, saml_sp_id, recipient_type, recipient_id, binding_type, binding_key,
      resource_type, resource_id, purpose_key, statement_id, statement_version, policy_id,
      flow_id, flow_version_id, flow_node_id, decision, selected_value, selected_options_json,
      released_scopes_json, released_claims_json, released_attributes_json, status, expires_at,
      revoked_at, evidence_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      selected_options_json = excluded.selected_options_json,
      released_scopes_json = excluded.released_scopes_json,
      released_claims_json = excluded.released_claims_json,
      released_attributes_json = excluded.released_attributes_json,
      evidence_json = excluded.evidence_json,
      updated_at = excluded.updated_at`,
    [
      recordId,
      input.tenantId,
      input.userId,
      input.userId,
      input.requestContext.protocol,
      input.consent.destination_type === 'oidc' ? 'scope_claim_release' : 'attribute_release',
      input.interaction.client_id,
      input.interaction.saml_sp_id,
      recipientType,
      destinationRecipientId,
      'destination_field_mapping_set',
      input.consent.profile_id,
      input.consent.destination_type === 'oidc' ? 'userinfo' : 'saml_attributes',
      input.consent.profile_id,
      'destination_field_release',
      `destination_profile:${input.consent.profile_id}`,
      input.consent.consent_version,
      input.policyId,
      input.interaction.flow_id,
      input.interaction.flow_version_id,
      input.step.source_node_id,
      'selected',
      null,
      JSON.stringify(input.selectedFields),
      releasedScopes,
      releasedClaims,
      releasedAttributes,
      'active',
      null,
      null,
      JSON.stringify({
        source: 'flow_runtime',
        interaction_id: input.interaction.id,
        step_id: input.step.id,
        node_id: input.step.source_node_id,
        destination_profile_id: input.consent.profile_id,
        destination_profile_version_id: input.consent.profile_version_id,
        selected_field_keys: input.selectedFields,
        // What the user was asked about, so a later request that asks about more is told apart
        // from one for which a field was declined.
        presented_field_keys: input.consent.fields.map((field) => field.key),
        saml_request_id: input.requestContext.saml_request_id,
        user_agent: input.userAgent,
        ip_address_hash: input.ipHash,
      }),
      now,
      now,
    ]
  );
  const bindingMatch = `tenant_id = ?
        AND subject_user_id = ?
        AND protocol = ?
        AND recipient_type = ?
        AND ((recipient_id = ?) OR (recipient_id IS NULL AND ? IS NULL))
        AND binding_type = 'destination_field_mapping_set'
        AND binding_key = ?
        AND status = 'active'`;
  const bindingParams = [
    input.tenantId,
    input.userId,
    input.requestContext.protocol,
    recipientType,
    destinationRecipientId,
    destinationRecipientId,
    input.consent.profile_id,
  ];
  await input.db.execute(
    `UPDATE consent_records
        SET status = 'superseded', updated_at = ?
      WHERE ${bindingMatch}
        AND id <> (
          SELECT id FROM consent_records
           WHERE ${bindingMatch}
           ORDER BY CASE WHEN statement_version = ? THEN 0 ELSE 1 END, created_at DESC, id DESC
           LIMIT 1
        )`,
    [
      now,
      ...bindingParams,
      ...bindingParams,
      input.currentConsentVersion ?? input.consent.consent_version,
    ]
  );
}

/**
 * Prepares the profile answers of a `screen` step for `userId`: everything is checked first (the
 * Identity Schema's type and rules for a custom attribute, the user's profile for a standard
 * field), with nothing written; `write` then stores them (standard profile fields with
 * `updateProfileFields`, custom attributes through the schema's checked write). Writing the same
 * answers again (a retried submit) leaves the same values. Answers kept off the profile are
 * never passed here.
 */
async function prepareRuntimeScreenProfileAnswers(input: {
  c: AuthContext;
  tenantId: string;
  userId: string;
  answers: RuntimeScreenAnswer[];
}): Promise<{ ok: true; write: () => Promise<void> } | { ok: false; error: string }> {
  const { c, tenantId, userId, answers } = input;
  await resolveAccountDataContextFromHono(c, userId);
  const sources = await resolveCustomClaimRuntimeSourcesFromHono(c, tenantId);
  const schemaRows = await ensureDatabaseAdapter(
    sources.schemaDb,
    'flow-screen-answer-schemas'
  ).query<{ field_key: string }>(
    `SELECT field_key FROM custom_claim_schemas WHERE tenant_id = ? AND is_active = 1`,
    [tenantId]
  );
  const customKeys = new Map(
    schemaRows.map((row) => [runtimeAttributeKey(row.field_key), row.field_key] as const)
  );
  const split = splitProfileAnswers(answers, customKeys);
  if (split.skipped.length > 0) {
    getLogger(c).module('LOGIN-RUNTIME-FLOW').info('Screen answers not stored to the profile', {
      action: 'flow_screen_answers',
      skipped_fields: split.skipped,
    });
  }

  const validation =
    Object.keys(split.custom).length > 0
      ? await validateCustomClaimWrite({
          db: sources.nonPiiDb,
          dbPii: sources.piiDb,
          schemaDb: sources.schemaDb,
          tenantId,
          userId,
          submitted: split.custom,
          requireCompleteRecord: false,
          mergeExistingValues: false,
        })
      : null;
  if (validation && !validation.ok) return { ok: false, error: validation.error };
  // An answer never clears a stored value: one the schema reads as empty (such as `[]`) is not
  // an answer, and is refused rather than deleting what is stored.
  if (
    validation &&
    (validation.nonPiiKeysToDelete.length > 0 || validation.piiKeysToDelete.length > 0)
  ) {
    const key = [...validation.nonPiiKeysToDelete, ...validation.piiKeysToDelete][0];
    return { ok: false, error: `The answer for ${key} is empty` };
  }

  const hasProfile = Object.keys(split.profile).length > 0;
  const users = new CanonicalRuntimeUserStore({
    coreAdapter: createAccountAuthContextFromHono(c, tenantId).coreAdapter,
    piiAdapter: createPIIContextFromHono(c, tenantId).defaultPiiAdapter,
    tenantId,
  });
  if (hasProfile && !(await users.hasProfile(userId))) {
    return { ok: false, error: 'The profile cannot be updated' };
  }

  return {
    ok: true,
    write: async () => {
      if (hasProfile && !(await users.updateProfileFields(userId, split.profile))) {
        throw new Error('flow_screen_profile_unavailable');
      }
      if (validation) {
        await persistCustomClaimWrite({
          db: sources.nonPiiDb,
          dbPii: sources.piiDb,
          schemaDb: sources.schemaDb,
          tenantId,
          userId,
          validation,
        });
      }
    },
  };
}

/** The interaction's context with a screen step's choices set (an empty set removes them). */
function withRuntimeScreenAnswers(
  context: Record<string, unknown>,
  stepId: string,
  answers: Record<string, ScreenAnswerValue>
): Record<string, unknown> {
  // The step moves to the end each time it is answered: the list is in the order of the last
  // answers, and a key answered on two steps reads the latest (see screenAnswerEntriesOf).
  const entries = screenAnswerEntriesOf(context.screen_answers).filter(
    (entry) => entry.step_id !== stepId
  );
  if (Object.keys(answers).length > 0) entries.push({ step_id: stepId, answers });
  const next = { ...context };
  if (entries.length > 0) next.screen_answers = entries;
  else delete next.screen_answers;
  return next;
}

/** The interaction's context without any screen step's choices. */
function withoutRuntimeScreenAnswers(context: Record<string, unknown>): Record<string, unknown> {
  const next = { ...context };
  delete next.screen_answers;
  return next;
}

/**
 * Publishes `flow.screen.submitted` for a saved screen step, without being waited for (its
 * failure is logged). It carries the answers going to the Flow, free text included, so it is not
 * written to the audit log (which keeps an event's data).
 */
function scheduleScreenSubmittedEvent(
  c: AuthContext,
  input: {
    tenantId: string;
    interaction: FlowInteractionRow;
    step: FlowRuntimeStep;
    userId: string | null;
    submissionId: string;
    answers: Record<string, ScreenAnswerValue>;
  }
): void {
  const screen = runtimeStepScreenIdentity(input.step);
  if (!screen) return;
  const warn = (failure: string) =>
    getLogger(c).module('LOGIN-RUNTIME-FLOW').warn('Failed to publish flow.screen.submitted', {
      action: 'event_publish',
      interaction_id: input.interaction.id,
      failure,
    });
  const delivery = publishEvent(
    c,
    {
      type: FLOW_EVENTS.SCREEN_SUBMITTED,
      tenantId: input.tenantId,
      data: {
        interactionId: input.interaction.id,
        flowId: input.interaction.flow_id,
        flowVersionId: input.interaction.flow_version_id,
        stepId: input.step.id,
        submissionId: input.submissionId,
        screenId: screen.id,
        screenKey: screen.screen_key,
        userId: input.userId,
        answers: input.answers,
      } satisfies FlowScreenSubmittedEventData,
    },
    { skipAuditLog: true }
  )
    .then((result) => {
      // Never the answers: what failed, and where.
      if (!result.success) {
        warn((result.errors ?? []).map((failure) => `${failure.target}:${failure.name}`).join(','));
      }
    })
    .catch((error: unknown) => warn(error instanceof Error ? error.name : 'unknown'));
  if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
    c.executionCtx.waitUntil(delivery);
  }
}

/** Whether `userId` is a registered account (not a guest, and known to the profile store). */
async function isRegisteredRuntimeUser(
  c: AuthContext,
  tenantId: string,
  userId: string
): Promise<boolean> {
  await resolveAccountDataContextFromHono(c, userId);
  const user = await new CanonicalRuntimeUserStore({
    coreAdapter: createAccountAuthContextFromHono(c, tenantId).coreAdapter,
    piiAdapter: createPIIContextFromHono(c, tenantId).defaultPiiAdapter,
    tenantId,
  }).findById(userId);
  return user?.registration_state === 'registered';
}

/**
 * Stores a screen step's response record for `userId`, in their PII database: one row per visit
 * of the step (keyed by the step's row), so a retried submit replaces its own answers instead of
 * adding a row, and a row is never moved to another user or tenant.
 */
async function writeRuntimeScreenResponse(input: {
  c: AuthContext;
  tenantId: string;
  userId: string;
  screen: { id: string; screen_key: string };
  interaction: FlowInteractionRow;
  stepId: string;
  stepRowId: string;
  answers: Record<string, ScreenAnswerValue>;
}): Promise<void> {
  const { c, tenantId, userId } = input;
  await resolveAccountDataContextFromHono(c, userId);
  const pii = createPIIContextFromHono(c, tenantId).defaultPiiAdapter;
  const now = Date.now();
  // Not for an account being deleted: its tombstone is written before its PII is erased, so a
  // record written first is erased with the rest, and none is written after. Nor for a guest
  // being erased (the handler keeps no guest record; the database refuses one under erasure).
  await pii.execute(
    `INSERT INTO screen_responses (
       id, tenant_id, user_id, screen_id, screen_key, flow_id, flow_version_id, interaction_id,
       step_id, answers_json, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM users_pii_tombstone WHERE tenant_id = ? AND id = ?
      ) AND NOT EXISTS (
        SELECT 1 FROM guest_pii_erasure_markers WHERE tenant_id = ? AND user_id = ?
      )
     ON CONFLICT (id) DO UPDATE SET answers_json = excluded.answers_json,
       updated_at = excluded.updated_at
     WHERE screen_responses.tenant_id = excluded.tenant_id
       AND screen_responses.user_id = excluded.user_id`,
    [
      input.stepRowId,
      tenantId,
      userId,
      input.screen.id,
      input.screen.screen_key,
      input.interaction.flow_id,
      input.interaction.flow_version_id,
      input.interaction.id,
      input.stepId,
      JSON.stringify(input.answers),
      now,
      now,
      tenantId,
      userId,
      tenantId,
      userId,
    ]
  );
}

/** Removes what an earlier submit of this visit of a step kept for `userId` (a visit left empty). */
async function clearRuntimeScreenResponse(
  c: AuthContext,
  tenantId: string,
  userId: string,
  stepRowId: string
): Promise<void> {
  await resolveAccountDataContextFromHono(c, userId);
  await createPIIContextFromHono(c, tenantId).defaultPiiAdapter.execute(
    `DELETE FROM screen_responses WHERE tenant_id = ? AND user_id = ? AND id = ?`,
    [tenantId, userId, stepRowId]
  );
}

/** The screen a step shows, as the server resolved it: its id and key (null if it has none). */
function runtimeStepScreenIdentity(
  step: FlowRuntimeStep
): { id: string; screen_key: string } | null {
  const screen = parseJsonRecord(parseJsonRecord(step.config).screen);
  const id = readString(screen.id, 200);
  const key = readString(screen.screen_key, 200);
  return id && key ? { id, screen_key: key } : null;
}

function screenAnswerError(
  c: AuthContext,
  interactionId: string,
  problem: RuntimeScreenAnswerProblem | 'invalid_profile_value',
  field: string | null,
  description: string
) {
  return c.json(
    {
      error: 'invalid_screen_answers',
      error_description: description,
      error_code: 'AR_FLOW_SCREEN_ANSWERS_INVALID',
      category: 'recoverable' satisfies FlowRuntimeErrorCategory,
      action: 'retry_step' satisfies FlowRuntimeErrorAction,
      interaction_id: interactionId,
      problem,
      field,
    },
    400
  );
}

async function persistRuntimeConsentStep(input: {
  c: AuthContext;
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  step: FlowRuntimeStep;
  submitInput: unknown;
  /** The session the challenge accepts as proof, if any (see resolveSessionForChallenge). */
  session: Session | null;
  /** The submit's claim on the interaction (claimRuntimeSubmit). */
  claimId: string;
}): Promise<{
  ok: boolean;
  response?: Response;
  userId?: string | null;
  /** Consent given before anyone is signed in, validated, to be recorded once someone is. */
  held?: HeldRuntimeConsent;
}> {
  const requestContext = getRequestContextFromInteraction(input.interaction);
  const destinationFieldConsent = readRuntimeDestinationFieldConsent(input.step);
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

  // Consent is recorded for the user the interaction is already about: another user's session
  // (made in another tab after the interaction was bound) does not take it over.
  if (
    input.interaction.user_id &&
    input.session?.userId &&
    input.interaction.user_id !== input.session.userId
  ) {
    return {
      ok: false,
      response: sessionUserMismatch(input.c, input.interaction.id),
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

  // What is accepted is what was shown: if the terms are not those the contract of this
  // interaction was prepared with (changed since, or the contract came from a cache that is behind),
  // nothing is accepted, and the browser is asked to resume with a contract prepared anew.
  const presented = parseJsonRecord(
    parseJsonObject(input.interaction.context_json).consent_presented
  )[input.step.id];
  if (
    typeof presented === 'string' &&
    presented !== consentStepKey(policy, destinationFieldConsent)
  ) {
    return {
      ok: false,
      response: await consentChangedResponse(
        input.c,
        input.db,
        input.tenantId,
        input.interaction,
        input.claimId
      ),
    };
  }

  // An older session the challenge refuses is no one: consent before authentication is not
  // attributed to its user.
  const userId = input.session?.userId || null;
  if (!userId) {
    if (
      input.step.component !== 'authentication_method_selector' &&
      input.step.component !== 'registration_method_selector'
    ) {
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
  }

  const submitted = readConsentDecisionMap(input.submitInput);
  const submittedSelectedValues = readConsentSelectedValueMap(input.submitInput);
  const submittedDestinationFields = readDestinationFieldDecisionMap(input.submitInput);
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
  const missingRequiredDestinationFields = destinationFieldConsent?.fields.filter(
    (field) => field.required && submittedDestinationFields[field.key] !== true
  );
  if (missingRequiredDestinationFields && missingRequiredDestinationFields.length > 0) {
    return {
      ok: false,
      response: runtimeError(
        input.c,
        400,
        'consent_required',
        'Required destination fields must be granted',
        'AR_FLOW_DESTINATION_FIELD_CONSENT_REQUIRED',
        'recoverable',
        'retry_step',
        input.interaction.id
      ),
    };
  }

  // What was validated, and for which statements and versions: this is what gets recorded.
  const given: HeldRuntimeConsent = {
    policy,
    decisions,
    ...(destinationFieldConsent
      ? {
          destination: {
            consent: destinationFieldConsent,
            selected_fields: destinationFieldConsent.fields
              .filter((field) => field.required || submittedDestinationFields[field.key] === true)
              .map((field) => field.key),
          },
        }
      : {}),
  };

  if (!userId) {
    // The method is chosen before the user has signed in (an emailed code, an external provider):
    // what was given is valid, and kept with the step until a session exists to record it for.
    return { ok: true, held: given };
  }

  const recorded = await recordRuntimeConsent({
    c: input.c,
    db: input.db,
    tenantId: input.tenantId,
    interaction: input.interaction,
    step: input.step,
    requestContext,
    consent: given,
    userId,
  });
  return recorded.ok ? { ok: true, userId } : recorded;
}

/** The authorization request could not be read just now: nothing was decided or saved. */
function authorizationRequestUnavailable(c: AuthContext, interactionId: string) {
  return runtimeError(
    c,
    503,
    'temporarily_unavailable',
    'The authorization request could not be checked; try again',
    'AR_FLOW_CHALLENGE_UNAVAILABLE',
    'recoverable',
    'retry_step',
    interactionId
  );
}

function sessionUserMismatch(c: AuthContext, interactionId: string) {
  return runtimeError(
    c,
    403,
    'access_denied',
    'The signed-in session does not belong to this interaction',
    'AR_FLOW_SESSION_USER_MISMATCH',
    'security_error',
    'restart_interaction',
    interactionId
  );
}

/**
 * Makes `userId` the user the interaction is about, if it is about no one yet. Returns whether it
 * is about that user now. The update takes an interaction that has no user only, so two sessions
 * racing to be recorded for it cannot both succeed.
 */
async function claimInteractionUser(
  db: DatabaseAdapter,
  tenantId: string,
  interaction: FlowInteractionRow,
  userId: string
): Promise<boolean> {
  if (interaction.user_id) return interaction.user_id === userId;
  const claimed = await db.execute(
    `UPDATE flow_interactions
        SET user_id = ?, updated_at = ?
      WHERE tenant_id = ? AND id = ? AND user_id IS NULL`,
    [userId, nowSeconds(), tenantId, interaction.id]
  );
  if ((claimed.rowsAffected ?? 0) > 0) return true;
  const current = await db.queryOne<{ user_id: string | null }>(
    'SELECT user_id FROM flow_interactions WHERE tenant_id = ? AND id = ?',
    [tenantId, interaction.id]
  );
  return current?.user_id === userId;
}

/**
 * Records consent for `userId`: the interaction is first claimed for that user (another user's
 * consent is never recorded on it), and each record has a fixed identifier, so a retried or a
 * concurrent attempt cannot record it twice.
 */
async function recordRuntimeConsent(input: {
  c: AuthContext;
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  step: FlowRuntimeStep;
  requestContext: FlowRequestContext;
  consent: HeldRuntimeConsent;
  userId: string;
}): Promise<{ ok: true } | { ok: false; response: Response }> {
  if (!(await claimInteractionUser(input.db, input.tenantId, input.interaction, input.userId))) {
    return {
      ok: false,
      response: sessionUserMismatch(input.c, input.interaction.id),
    };
  }
  const ipAddress =
    getRequestHeader(input.c, 'CF-Connecting-IP') ||
    getRequestHeader(input.c, 'X-Forwarded-For') ||
    '';
  const ipHash = ipAddress
    ? await hashIpAddress(ipAddress, input.tenantId, input.c.env.KV ?? null, input.c.env)
    : undefined;
  const userAgent = getRequestHeader(input.c, 'User-Agent');
  await insertFlowConsentRecords({
    db: input.db,
    tenantId: input.tenantId,
    interaction: input.interaction,
    step: input.step,
    policy: input.consent.policy,
    requestContext: input.requestContext,
    userId: input.userId,
    decisions: input.consent.decisions,
    ipHash,
    userAgent,
  });
  if (input.consent.destination) {
    // The version that applies now: this record may be in an older one.
    const applicable = await resolveRuntimeDestinationFieldConsent(
      input.c,
      input.db,
      input.tenantId,
      input.requestContext
    );
    await insertDestinationFieldConsentRecord({
      db: input.db,
      tenantId: input.tenantId,
      interaction: input.interaction,
      step: input.step,
      policyId: input.consent.policy.id,
      requestContext: input.requestContext,
      userId: input.userId,
      consent: input.consent.destination.consent,
      selectedFields: input.consent.destination.selected_fields,
      currentConsentVersion:
        applicable?.profile_id === input.consent.destination.consent.profile_id
          ? applicable.consent_version
          : undefined,
      ipHash,
      userAgent,
    });
  }
  return { ok: true };
}

/**
 * What the consent steps of a contract ask, by step: the statements, their versions and terms, the
 * destination fields. Kept with the interaction as what its browser was shown.
 */
function consentPresentedKeys(contract: FlowRuntimeContract): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const step of contract.ui.steps) {
    const policy = readRuntimeConsentPolicyContent(step);
    const destination = readRuntimeDestinationFieldConsent(step);
    if (!policy && !destination) continue;
    keys[step.id] = consentStepKey(policy, destination);
  }
  return keys;
}

/**
 * The answer when the terms have changed since they were shown: the interaction is asked to be
 * resumed with a contract prepared anew (a new revision keeps every Worker from serving one
 * prepared before).
 */
async function consentChangedResponse(
  c: AuthContext,
  db: DatabaseAdapter,
  tenantId: string,
  interaction: FlowInteractionRow,
  claimId: string
) {
  const written = await db.execute(
    // Only while it is open: a context read before it ended is not written back over the one it
    // ended with (its screen answers are removed then). And only under the submit's claim: the
    // context it read is then still the one stored.
    `UPDATE flow_interactions SET context_json = ?, updated_at = ?
      WHERE tenant_id = ? AND id = ? AND state IN ('created', 'active')
        AND submit_claim_id = ? AND submit_claim_expires_at IS NOT NULL`,
    [
      JSON.stringify({
        ...parseJsonObject(interaction.context_json),
        contract_revision: crypto.randomUUID(),
      }),
      nowSeconds(),
      tenantId,
      interaction.id,
      claimId,
    ]
  );
  if ((written.rowsAffected ?? 0) === 0) return stepConflictError(c, interaction.id);
  return runtimeError(
    c,
    400,
    'consent_changed',
    'The terms changed after they were shown; they are asked for again',
    'AR_FLOW_CONSENT_VERSION_CHANGED',
    'recoverable',
    'retry_step',
    interaction.id
  );
}

/**
 * Records the consent given at method selections before anyone was signed in, for the user who now
 * is (the session the authorization request accepts), in the versions it was given for. If a
 * statement has a newer version by now, or the policy's statements changed, nothing is recorded
 * and the consent is asked for again. Each record is made once (see recordRuntimeConsent).
 */
async function recordHeldRuntimeConsent(input: {
  c: AuthContext;
  db: DatabaseAdapter;
  tenantId: string;
  interaction: FlowInteractionRow;
  runtime: FlowRuntimeContract;
  requestContext: FlowRequestContext;
  session: Session;
  /** The submit's claim on the interaction (claimRuntimeSubmit). */
  claimId: string;
}): Promise<{ response?: Response }> {
  const rows = await input.db.query<{ id: string; step_id: string; state_json: string | null }>(
    `SELECT id, step_id, state_json
       FROM flow_interaction_steps
      WHERE tenant_id = ? AND interaction_id = ? AND state = 'completed'
        AND state_json LIKE '%"held_consent"%'`,
    [input.tenantId, input.interaction.id]
  );
  for (const row of rows ?? []) {
    const state = parseJsonRecord(row.state_json);
    const held = state.held_consent as HeldRuntimeConsent | undefined;
    const step = input.runtime.ui.steps.find((candidate) => candidate.id === row.step_id);
    if (!held?.policy || !held.decisions || !step) continue;

    const current = await resolveRuntimeConsentPolicyContent(
      input.db,
      input.tenantId,
      held.policy.id,
      input.requestContext
    );
    const currentDestination = readRuntimeDestinationFieldConsent(step);
    // What was accepted must still be what is asked: the same statements in the same versions and
    // terms (required or not, how they are agreed to), and, judged by what is asked now, nothing
    // required that was not given.
    if (
      !current ||
      consentPresentationKey(current) !== consentPresentationKey(held.policy) ||
      current.items.some((item) => {
        const decision = held.decisions[item.statement_id];
        return (
          !decision ||
          !consentItemInputSatisfied(item, decision) ||
          // A choice that is no longer offered is not one that can be recorded.
          (decision.selectedValue !== null &&
            !consentOptionValueSet(item).has(decision.selectedValue))
        );
      }) ||
      (held.destination &&
        (!currentDestination ||
          destinationPresentationKey(currentDestination) !==
            destinationPresentationKey(held.destination.consent) ||
          currentDestination.fields.some(
            (field) => field.required && !held.destination?.selected_fields.includes(field.key)
          )))
    ) {
      // The consent is asked for again: the interaction goes back to the step that took it (the
      // signed-in browser resumes there), with nothing held. Only under the submit's claim, as
      // its step is saved: the interaction first, the step row only if it was moved.
      const rewound = await writeAtomically(input.db, (write) => {
        write(
          `UPDATE flow_interactions
              SET state = 'active', current_node_id = ?, current_step_id = ?, updated_at = ?,
                  completed_at = NULL
            WHERE tenant_id = ? AND id = ? AND state IN ('created', 'active')
              AND submit_claim_id = ? AND submit_claim_expires_at IS NOT NULL`,
          [
            step.source_node_id,
            step.id,
            nowSeconds(),
            input.tenantId,
            input.interaction.id,
            input.claimId,
          ]
        );
        write(
          `UPDATE flow_interaction_steps
              SET state = 'waiting_input', selected_handle = NULL, state_json = NULL, updated_at = ?
            WHERE tenant_id = ? AND id = ?
              AND EXISTS (
                SELECT 1 FROM flow_interactions
                 WHERE tenant_id = ? AND id = ? AND submit_claim_id = ?
                   AND submit_claim_expires_at IS NOT NULL)`,
          [
            nowSeconds(),
            input.tenantId,
            row.id,
            input.tenantId,
            input.interaction.id,
            input.claimId,
          ]
        );
      });
      if ((rewound[0]?.rowsAffected ?? 0) === 0) {
        return { response: stepConflictError(input.c, input.interaction.id) };
      }
      return {
        response: await consentChangedResponse(
          input.c,
          input.db,
          input.tenantId,
          input.interaction,
          input.claimId
        ),
      };
    }

    // What was recorded is not recorded again, but the conditions above are judged every time.
    if (state.held_consent_recorded === true) continue;

    const recorded = await recordRuntimeConsent({
      c: input.c,
      db: input.db,
      tenantId: input.tenantId,
      interaction: input.interaction,
      step,
      requestContext: input.requestContext,
      consent: held,
      userId: input.session.userId,
    });
    if (!recorded.ok) return { response: recorded.response };
    // Over the state read, only under the submit's claim (nothing else writes the row then).
    const marked = await input.db.execute(
      `UPDATE flow_interaction_steps SET state_json = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?
          AND EXISTS (
            SELECT 1 FROM flow_interactions
             WHERE tenant_id = ? AND id = ? AND state IN ('created', 'active')
               AND submit_claim_id = ? AND submit_claim_expires_at IS NOT NULL)`,
      [
        JSON.stringify({ ...state, held_consent_recorded: true }),
        nowSeconds(),
        input.tenantId,
        row.id,
        input.tenantId,
        input.interaction.id,
        input.claimId,
      ]
    );
    if ((marked.rowsAffected ?? 0) === 0) {
      return { response: stepConflictError(input.c, input.interaction.id) };
    }
  }
  return {};
}

export async function cleanupExpiredFlowInteractions(
  db: DatabaseAdapter,
  tenantId: string,
  options: { now?: number; retentionSeconds?: number } = {}
): Promise<{ expired: number; deletedSteps: number }> {
  const now = options.now ?? nowSeconds();
  const retentionSeconds = Math.max(0, options.retentionSeconds ?? 24 * 60 * 60);
  const cutoff = now - retentionSeconds;
  // Expired with their screen answers removed, as the scheduled maintenance does.
  const expired = await expireFlowInteractions(db, tenantId, now);
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
    expired,
    deletedSteps: deletedStepsResult.rowsAffected ?? 0,
  };
}

/** The waits (ms) before a resume reads its interaction again (see resumeInteractionOnce). */
const RESUME_RETRY_DELAYS_MS = [100, 200, 400, 800];

async function resumeInteraction(
  c: AuthContext,
  db: DatabaseAdapter,
  tenantId: string,
  interactionId: string,
  submittedContractHash: string | null,
  submittedSignature: string | null,
  requestedLocale: string | null
) {
  for (let attempt = 0; ; attempt += 1) {
    const resumed = await resumeInteractionOnce(
      c,
      db,
      tenantId,
      interactionId,
      submittedContractHash,
      submittedSignature,
      requestedLocale
    );
    if (resumed !== 'busy') return resumed;
    const delay = RESUME_RETRY_DELAYS_MS[attempt];
    // A submit that keeps the step longer than this: the browser loads the interaction again.
    if (delay === undefined) return stepConflictError(c, interactionId);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * One reading of the interaction for a resume. `busy` when a submit holds the interaction or it
 * changed after it was read: what the resume writes (the context, the contract) is written over
 * what it read only, never over what a submit saved meanwhile, and a submit's own write is not
 * undone by it while the submit holds the step.
 */
async function resumeInteractionOnce(
  c: AuthContext,
  db: DatabaseAdapter,
  tenantId: string,
  interactionId: string,
  submittedContractHash: string | null,
  submittedSignature: string | null,
  requestedLocale: string | null
): Promise<Response | 'busy'> {
  const now = nowSeconds();
  const interaction = await db.queryOne<
    FlowInteractionRow & { submit_claim_expires_at: number | null }
  >(
    `SELECT id, flow_id, flow_version_id, user_id, client_id, saml_sp_id, state, current_node_id,
            current_step_id, context_json, contract_hash, signature, expires_at,
            submit_claim_expires_at
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
  // A submit is saving the step: it is read again once the submit is done.
  if (interaction.submit_claim_expires_at !== null && interaction.submit_claim_expires_at > now) {
    return 'busy';
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

  const storedRequestContext = getRequestContextFromInteraction(interaction);
  // An authorization request that is gone is found out when the interaction is picked up again, not
  // when the user has signed in to no purpose. (One that was continued and left its confirmation is
  // not gone: its result can still be had.)
  if (storedRequestContext.authorization_challenge_id) {
    let freshness: Awaited<ReturnType<typeof readAuthorizationChallengeFreshness>>;
    try {
      freshness = await readAuthorizationChallengeFreshness(
        c.env,
        tenantId,
        storedRequestContext.authorization_challenge_id
      );
    } catch {
      return authorizationRequestUnavailable(c, interaction.id);
    }
    if (freshness?.gone) {
      return runtimeError(
        c,
        400,
        authorizationRequestExpired().error,
        authorizationRequestExpired().message ?? '',
        'AR_FLOW_AUTH_REQUEST_EXPIRED',
        'restart_required',
        'restart_interaction',
        interaction.id
      );
    }
  }
  const requestContext = requestedLocale
    ? { ...storedRequestContext, locale: requestedLocale }
    : storedRequestContext;
  const nextContextBase = {
    ...parseJsonObject(interaction.context_json),
    ...(requestedLocale ? { locale: requestedLocale } : {}),
  };
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
  // Only over what was read, and not while a submit holds the step (it may be saving a context
  // read before this one).
  let written: ExecuteResult;
  try {
    written = await db.execute(
      `UPDATE flow_interactions
			 SET context_json = ?, contract_hash = ?, signature = ?, updated_at = ?
		 WHERE tenant_id = ? AND id = ? AND state IN ('created', 'active')
		   AND current_step_id ${nullSafeEquals(db)} ? AND context_json ${nullSafeEquals(db)} ?
		   AND (submit_claim_expires_at IS NULL OR submit_claim_expires_at <= ?)`,
      [
        // What this contract asks consent to is what the browser is shown from now on.
        JSON.stringify({ ...nextContextBase, consent_presented: consentPresentedKeys(contract) }),
        contractHash,
        signature,
        now,
        tenantId,
        interaction.id,
        interaction.current_step_id,
        interaction.context_json,
        now,
      ]
    );
  } catch (error) {
    // Aurora DSQL: a concurrent write (a submit's claim) refused this one; it is read again.
    if (isSerializationConflict(error)) return 'busy';
    throw error;
  }
  if ((written.rowsAffected ?? 0) === 0) return 'busy';
  // The visit of the current step: a page drawn for an earlier visit of the same step (before
  // going back and on again) is told apart by it.
  const currentVisit = interaction.current_step_id
    ? await db.queryOne<{ id: string }>(
        `SELECT id FROM flow_interaction_steps
          WHERE tenant_id = ? AND interaction_id = ? AND step_id = ?
            AND state IN ('pending', 'waiting_input', 'processing')
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [tenantId, interaction.id, interaction.current_step_id]
      )
    : null;
  // A submit took the step between the write above and this read: read the interaction again
  // rather than answer a step without its visit.
  if (interaction.current_step_id && !currentVisit) return 'busy';
  const backScreens = await runtimeBackScreens(
    db,
    tenantId,
    interaction.id,
    interaction.current_step_id,
    {
      runtime: contract,
      editor: parseEditorSnapshot(version.editor_snapshot_json),
      requestContext,
    }
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
      current_visit_id: currentVisit?.id ?? null,
      expires_at: interaction.expires_at,
    },
    contract,
    contract_hash: contractHash,
    signature,
    expires_in: Math.max(0, interaction.expires_at - now),
    resumed: true,
    // The screens a link on the current screen can go back to (see `/back`).
    back_screens: backScreens,
  });
}

export async function loginRuntimeInteractionStartHandler(c: AuthContext) {
  const timing = createRuntimeStartTiming(c.env, c.req.raw);
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
        readString(body.signature, 512),
        readOptionalString(body.requested_locale ?? body.locale, 64)
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
  // The start to the millisecond (created_at has seconds only): a registration is answered only by
  // a sign-in made after it.
  const storedContextJson = JSON.stringify({
    ...requestContext,
    started_at_ms: Date.now(),
    consent_presented: consentPresentedKeys(runtime),
  });
  const signature = await timeRuntimeStartSpan(timing, 'sign_contract', () =>
    signContract({
      interactionId,
      contractHash,
      expiresAt,
      secret,
    })
  );

  await timeRuntimeStartSpan(timing, 'initial_tx', () =>
    writeAtomically(db, (write) => {
      write(
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
          storedContextJson,
          contractHash,
          signature,
          expiresAt,
          now,
          now,
        ]
      );
      write(
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
    context_json: storedContextJson,
    contract_hash: contractHash,
    signature,
    expires_at: expiresAt,
  };
  const startAuditFallback = scheduleRuntimeAuditEvents(
    c,
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
  if (initialDisplayResolution.unavailable) {
    return authorizationRequestUnavailable(c, interactionId);
  }
  if (initialDisplayResolution.terminalError) {
    await insertAuditEvent(c.env, tenantId, startedInteraction, {
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
    await insertAuditEvent(c.env, tenantId, startedInteraction, {
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
  let currentVisitId = stepRowId;
  if (initialDisplayResolution.autoAdvancedSteps.length > 0) {
    currentVisitId = await timeRuntimeStartSpan(timing, 'persist_auto_advance', () =>
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
      current_visit_id: currentVisitId,
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
          requestContext,
          editor
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

/**
 * A live interaction a request may act on at its current step: the Flow runtime is on, the
 * interaction is active and not expired, the contract the browser holds is the one signed for it,
 * and the step the request names is the current one. Otherwise, the error to answer.
 */
async function openRuntimeStepRequest(c: AuthContext): Promise<
  | Response
  | {
      tenantId: string;
      interactionId: string;
      interaction: FlowInteractionRow;
      db: DatabaseAdapter;
      body: SubmitRequest;
      selectedHandle: string | null;
      now: number;
    }
> {
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
    // Expired with its screen answers removed: they served the steps that never came. Only over
    // the context read: one a concurrent submit changed since is left open, and the scheduled
    // maintenance expires it with its answers removed.
    await db.execute(
      `UPDATE flow_interactions
       SET state = 'expired', updated_at = ?,
           context_json = COALESCE(?, context_json)
       WHERE tenant_id = ? AND id = ? AND state IN ('created', 'active')
         AND context_json ${nullSafeEquals(db)} ?`,
      [
        now,
        contextWithoutScreenAnswers(interaction.context_json),
        tenantId,
        interactionId,
        interaction.context_json,
      ]
    );
    await insertAuditEvent(c.env, tenantId, interaction, {
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
    await insertAuditEvent(c.env, tenantId, interaction, {
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
    await insertAuditEvent(c.env, tenantId, interaction, {
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

  return { tenantId, interactionId, interaction, db, body, selectedHandle, now };
}

export async function loginRuntimeInteractionSubmitHandler(c: AuthContext) {
  const opened = await openRuntimeStepRequest(c);
  if (opened instanceof Response) return opened;
  const { tenantId, interactionId, interaction, db, body, selectedHandle, now } = opened;

  // From here on this submit holds the interaction: a second submit of the same step (another
  // tab, a retried request) is answered step_conflict before it records anything.
  // The claim's expiry and the window to act in are counted from the same moment, the claim's.
  const claimedAtMs = Date.now();
  const claim: RuntimeSubmitClaim = {
    id: crypto.randomUUID(),
    saved: false,
    actBeforeMs: claimedAtMs + FLOW_SUBMIT_CLAIM_ACT_WINDOW_MS,
  };
  const claimed = await claimRuntimeSubmit(
    db,
    tenantId,
    interaction,
    claim.id,
    Math.floor(claimedAtMs / 1000)
  );
  if (claimed === 'not_active') {
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
  if (claimed === 'conflict') return stepConflictError(c, interactionId);
  try {
    return await submitClaimedRuntimeStep({
      c,
      db,
      tenantId,
      interactionId,
      interaction,
      body,
      selectedHandle,
      now,
      claim,
    });
  } catch (error) {
    // Aurora DSQL: a write to the interaction refused because a concurrent one changed it.
    if (!claim.saved && isSerializationConflict(error)) return stepConflictError(c, interactionId);
    throw error;
  } finally {
    if (!claim.saved) await releaseRuntimeSubmitClaim(c, db, tenantId, interactionId, claim.id);
  }
}

/** The steps of a hydrated runtime as going back sees them: each with the key of its screen. */
function backStepsOf(runtime: FlowRuntimeContract): Map<string, BackStep> {
  return new Map(
    runtime.ui.steps.map((step) => {
      const screen = parseJsonRecord(parseJsonRecord(step.config).screen);
      return [
        step.id,
        {
          id: step.id,
          component: step.component,
          screenKey: readString(screen.screen_key, 200),
        },
      ];
    })
  );
}

/**
 * The screens the person can go back to from the interaction's current step, nearest first (see
 * runtime-back-navigation). Read from the interaction's completed visits.
 */
async function runtimeBackTargets(
  db: DatabaseAdapter,
  tenantId: string,
  interactionId: string,
  currentStepId: string | null,
  flow: RuntimeBackFlow
): Promise<BackTarget[]> {
  const { runtime, editor, requestContext } = flow;
  const steps = backStepsOf(runtime);
  const current = currentStepId ? steps.get(currentStepId) : undefined;
  if (!current || current.component !== 'screen') return [];
  const visits = await db.query<BackVisit>(
    `SELECT id, step_id, selected_handle, created_at, state_json FROM flow_interaction_steps
      WHERE tenant_id = ? AND interaction_id = ? AND state = 'completed'
      ORDER BY created_at DESC, id DESC
      LIMIT ${BACK_LOOKBACK}`,
    [tenantId, interactionId]
  );
  // A full page may have cut the oldest second short: its visits are left out (the way back
  // stops before them rather than pass one it did not read).
  const oldestSecond =
    visits.length === BACK_LOOKBACK
      ? Math.min(...visits.map((visit) => Number(visit.created_at)))
      : null;
  const read =
    oldestSecond === null
      ? visits
      : visits.filter((visit) => Number(visit.created_at) !== oldestSecond);
  // Where the Flow goes from a visit, by the way out it took (as a submit resolves it).
  const nextStepIdOf = (visit: BackVisit) => {
    const index = runtime.ui.steps.findIndex((step) => step.id === visit.step_id);
    if (index < 0) return null;
    const routed = routingHandleOf(runtime.ui.steps[index], editor, visit.selected_handle ?? null);
    if (routed === undefined) return null;
    return resolveNextStep(runtime, index, editor, routed, requestContext).step?.id ?? null;
  };
  return backTargets(current, read, steps, nextStepIdOf);
}

/** What going back reads of the Flow: its hydrated runtime, its graph and the request. */
interface RuntimeBackFlow {
  runtime: FlowRuntimeContract;
  editor: FlowEditorState | null;
  requestContext: FlowRequestContext;
}

/** The keys of the screens a link on the current screen can go back to (for the browser). */
async function runtimeBackScreens(
  db: DatabaseAdapter,
  tenantId: string,
  interactionId: string,
  currentStepId: string | null,
  flow: RuntimeBackFlow
): Promise<string[]> {
  const targets = await runtimeBackTargets(db, tenantId, interactionId, currentStepId, flow);
  return targets.map((target) => target.screenKey);
}

/** The interaction's published runtime, hydrated as the browser was given it; null when gone. */
async function hydratedInteractionRuntime(
  c: AuthContext,
  db: DatabaseAdapter,
  tenantId: string,
  interaction: FlowInteractionRow
): Promise<RuntimeBackFlow | null> {
  const version = await getFlowVersion(
    db,
    tenantId,
    interaction.flow_id,
    interaction.flow_version_id
  );
  const runtimeSnapshot = version ? parseRuntimeSnapshot(version.runtime_snapshot_json) : null;
  if (!version || !runtimeSnapshot) return null;
  const editor = parseEditorSnapshot(version.editor_snapshot_json);
  const requestContext = getRequestContextFromInteraction(interaction);
  const runtime = await hydrateRuntimeContract(
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
    requestContext,
    editor
  );
  return { runtime, editor, requestContext };
}

/**
 * `POST /api/v1/login/interactions/:interaction_id/back`: from the current screen, back to a
 * screen passed before with only screens since (a screen part `link` with `link_screen`). The
 * screens passed since are undone and shown again as the person goes on; their answers stay with
 * the interaction until they are submitted again. Held like a submit (claimRuntimeSubmit), so it
 * and a submit of the same step cannot both land.
 */
export async function loginRuntimeInteractionBackHandler(c: AuthContext) {
  const opened = await openRuntimeStepRequest(c);
  if (opened instanceof Response) return opened;
  const { tenantId, interactionId, interaction, db, body, now } = opened;
  const targetScreen = readString(body.target_screen, 96);
  const notAllowed = () =>
    runtimeError(
      c,
      409,
      'back_not_allowed',
      'This screen cannot be gone back to from here',
      'AR_FLOW_BACK_NOT_ALLOWED',
      'recoverable',
      'retry_step',
      interactionId
    );
  if (!targetScreen) return notAllowed();

  const flow = await hydratedInteractionRuntime(c, db, tenantId, interaction);
  const runtime = flow?.runtime;
  const current = runtime ? findCurrentStep(runtime, interaction) : null;
  if (!flow || !runtime || !current) {
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

  const claimedAtMs = Date.now();
  const claim: RuntimeSubmitClaim = {
    id: crypto.randomUUID(),
    saved: false,
    actBeforeMs: claimedAtMs + FLOW_SUBMIT_CLAIM_ACT_WINDOW_MS,
  };
  const claimed = await claimRuntimeSubmit(
    db,
    tenantId,
    interaction,
    claim.id,
    Math.floor(claimedAtMs / 1000)
  );
  if (claimed === 'not_active') {
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
  if (claimed === 'conflict') return stepConflictError(c, interactionId);
  try {
    // Made on an earlier visit of this screen (another tab, before going back and on): not this one.
    const submittedVisitId = readOptionalString(body.visit_id, 200);
    if (submittedVisitId) {
      const visit = await db.queryOne<{ id: string }>(
        `SELECT id FROM flow_interaction_steps
          WHERE tenant_id = ? AND interaction_id = ? AND step_id = ?
            AND state IN ('pending', 'waiting_input', 'processing')
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [tenantId, interactionId, current.step.id]
      );
      if (visit?.id !== submittedVisitId) return stepConflictError(c, interactionId);
    }
    // Read under the claim: no submit can move the interaction on while the way back is chosen.
    const targets = await runtimeBackTargets(
      db,
      tenantId,
      interactionId,
      interaction.current_step_id,
      flow
    );
    const target = targets.find((candidate) => candidate.screenKey === targetScreen);
    const targetStep = target
      ? runtime.ui.steps.find((step) => step.id === target.stepId)
      : undefined;
    if (!target || !targetStep) return notAllowed();
    const heldByThisClaim = `EXISTS (
         SELECT 1 FROM flow_interactions
          WHERE tenant_id = ? AND id = ? AND submit_claim_id = ? AND submit_claim_expires_at IS NULL)`;
    if (runtimeSubmitClaimLapsed(claim)) return stepConflictError(c, interactionId);
    const undone = JSON.stringify({
      returned_to_step_id: target.stepId,
      returned_at_ms: Date.now(),
    });
    let saved: ExecuteResult[];
    try {
      saved = await writeAtomically(db, (write) => {
        // The interaction first, under the claim and still at the step it was read at.
        write(
          `UPDATE flow_interactions
              SET current_node_id = ?, current_step_id = ?, updated_at = ?,
                  submit_claim_expires_at = NULL
            WHERE tenant_id = ? AND id = ? AND state IN ('created', 'active')
              AND current_step_id = ? AND submit_claim_id = ?
              AND submit_claim_expires_at IS NOT NULL`,
          [
            targetStep.source_node_id,
            targetStep.id,
            now,
            tenantId,
            interactionId,
            current.step.id,
            claim.id,
          ]
        );
        // The step left (not completed) and the screens passed since the target are undone: they
        // are no longer behind the person.
        write(
          `UPDATE flow_interaction_steps
              SET state = 'skipped', state_json = ?, updated_at = ?
            WHERE tenant_id = ? AND interaction_id = ? AND step_id = ?
              AND state IN ('pending', 'waiting_input', 'processing')
              AND ${heldByThisClaim}`,
          [undone, now, tenantId, interactionId, current.step.id, tenantId, interactionId, claim.id]
        );
        for (const visitId of target.undoneVisitIds) {
          write(
            `UPDATE flow_interaction_steps
                SET state = 'skipped', updated_at = ?
              WHERE tenant_id = ? AND id = ? AND interaction_id = ? AND state = 'completed'
                AND ${heldByThisClaim}`,
            [now, tenantId, visitId, interactionId, tenantId, interactionId, claim.id]
          );
        }
        write(
          `INSERT INTO flow_interaction_steps (
            id, tenant_id, interaction_id, node_id, step_id, state, selected_handle, state_json,
            created_at, updated_at
          ) SELECT ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?
             WHERE ${heldByThisClaim}`,
          [
            generateId(),
            tenantId,
            interactionId,
            targetStep.source_node_id,
            targetStep.id,
            getStepStateForRuntimeStep(targetStep),
            now,
            now,
            tenantId,
            interactionId,
            claim.id,
          ]
        );
      });
    } catch (error) {
      if (isSerializationConflict(error)) return stepConflictError(c, interactionId);
      throw error;
    }
    if ((saved[0]?.rowsAffected ?? 0) === 0) return stepConflictError(c, interactionId);
    // Saved under the claim, its expiry cleared (as a submit leaves it): the next submit claims anew.
    claim.saved = true;

    await scheduleRuntimeAuditEvents(
      c,
      tenantId,
      interaction,
      [
        {
          eventType: 'flow.node.entered',
          result: 'success',
          nodeId: targetStep.source_node_id,
          userId: interaction.user_id,
        },
      ],
      'back_navigation'
    );
    const backScreens = await runtimeBackScreens(db, tenantId, interactionId, targetStep.id, flow);
    return c.json({
      schema_version: FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
      interaction: {
        id: interactionId,
        state: interaction.state,
        flow_id: interaction.flow_id,
        flow_version_id: interaction.flow_version_id,
        current_node_id: targetStep.source_node_id,
        current_step_id: targetStep.id,
        expires_at: interaction.expires_at,
      },
      step: runtimeStepResponse(targetStep),
      completed: false,
      output: null,
      back_screens: backScreens,
    });
  } catch (error) {
    if (!claim.saved && isSerializationConflict(error)) return stepConflictError(c, interactionId);
    throw error;
  } finally {
    if (!claim.saved) await releaseRuntimeSubmitClaim(c, db, tenantId, interactionId, claim.id);
  }
}

/**
 * The submit of a step, once it holds its interaction (claimRuntimeSubmit): `claim.saved` is set
 * when the step is saved under the claim; otherwise the caller lets go of it.
 */
async function submitClaimedRuntimeStep(input: {
  c: AuthContext;
  db: DatabaseAdapter;
  tenantId: string;
  interactionId: string;
  interaction: FlowInteractionRow;
  body: SubmitRequest;
  selectedHandle: string | null;
  now: number;
  claim: RuntimeSubmitClaim;
}): Promise<Response> {
  const { c, db, tenantId, interactionId, interaction, body, selectedHandle, now, claim } = input;
  const stepState = await db.queryOne<FlowInteractionStepRow>(
    `SELECT id, interaction_id, node_id, step_id, state, selected_handle, state_json
     FROM flow_interaction_steps
     WHERE tenant_id = ? AND interaction_id = ? AND node_id = ? AND step_id = ?
     ORDER BY CASE WHEN state IN ('pending', 'waiting_input', 'processing') THEN 0 ELSE 1 END,
              created_at DESC
     LIMIT 1`,
    [tenantId, interactionId, interaction.current_node_id, interaction.current_step_id]
  );
  // Made on an earlier visit of this step (another tab, before going back and on): not this one.
  const submittedVisitId = readOptionalString(body.visit_id, 200);
  if (stepState && submittedVisitId && submittedVisitId !== stepState.id) {
    return stepConflictError(c, interactionId);
  }
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
          requestContext,
          editor
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
    unavailable?: true;
  };
  if (current.step.component === 'condition') {
    branchResolution = await resolveConditionSelectedHandle({
      c,
      db,
      tenantId,
      interaction,
      runtime,
      step: current.step,
    });
  } else if (current.step.component === 'session_check') {
    branchResolution = await resolveSessionCheckSelectedHandle(
      c,
      tenantId,
      requestContext,
      sessionOptionsForRuntime(runtime, interaction)
    );
  } else {
    // A screen sent with no way out is its submit: its answers are read like one (no way out
    // that reads none is taken unnamed).
    branchResolution = {
      selectedHandle:
        current.step.component === 'screen' ? (selectedHandle ?? 'submitted') : selectedHandle,
    };
  }

  if (branchResolution.unavailable) {
    return authorizationRequestUnavailable(c, interactionId);
  }
  if (branchResolution.terminalError) {
    await insertAuditEvent(c.env, tenantId, interaction, {
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
    await insertAuditEvent(c.env, tenantId, interaction, {
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
      await insertAuditEvent(c.env, tenantId, interaction, {
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
  const routedHandle = routingHandleOf(current.step, editor, effectiveSelectedHandle);
  const nextResolution: { step: FlowRuntimeStep | null; errorCode?: string } =
    current.step.component === 'completion'
      ? { step: null }
      : routedHandle === undefined
        ? // An exit the screen does not offer (no link part names it).
          { step: null, errorCode: 'AR_FLOW_INVALID_SELECTED_HANDLE' }
        : resolveNextStep(runtime, current.index, editor, routedHandle, requestContext);
  if (nextResolution.errorCode) {
    await insertAuditEvent(c.env, tenantId, interaction, {
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

  const sessionForChallenge = await resolveSessionForChallenge(
    c,
    tenantId,
    requestContext.authorization_challenge_id,
    { ...sessionOptionsForRuntime(runtime, interaction), judgeChallengeWithoutSession: true }
  );
  if (sessionForChallenge.unavailable) {
    // Nothing is recorded yet: the browser may submit this step again.
    return authorizationRequestUnavailable(c, interactionId);
  }
  if (sessionForChallenge.expired) {
    // Signing in again does not answer a request that is gone, so this is not a request to sign in.
    return runtimeError(
      c,
      400,
      authorizationRequestExpired().error,
      authorizationRequestExpired().message ?? '',
      'AR_FLOW_AUTH_REQUEST_EXPIRED',
      'restart_required',
      'restart_interaction',
      interactionId
    );
  }
  const challengeSession = sessionForChallenge.session;

  // A login or registration is complete only for someone signed in (with a session the
  // authorization request accepts). Until then the interaction waits at its completion step: the
  // method is chosen first (an emailed code, an external provider) and the proof comes later, so
  // the completion is submitted again, by the browser, once it exists.
  const completionNeedsSession =
    (runtime.flow_kind === 'login' || runtime.flow_kind === 'registration') && !challengeSession;
  if (current.step.component === 'completion' && completionNeedsSession) {
    return runtimeError(
      c,
      401,
      'authentication_required',
      'Sign in to continue',
      'AR_FLOW_COMPLETION_AUTH_REQUIRED',
      'reauthentication_required',
      'reauthenticate',
      interactionId
    );
  }

  // A screen's answers, when it is submitted: checked against the screen the step shows (the
  // server's), and its profile answers prepared for the signed-in user, before anything is
  // recorded (a refused submit changes nothing, not even whom the interaction is about).
  let screenAnswers: {
    userId: string;
    /** Null when nothing goes to the profile. */
    writeProfile: (() => Promise<void>) | null;
    /** Null when the visit keeps no record. */
    writeRecord: (() => Promise<void>) | null;
  } | null = null;
  let offProfileAnswers: OffProfileScreenAnswers | null = null;
  let clearRecordFor: string | null = null;
  if (current.step.component === 'screen' && effectiveSelectedHandle === 'submitted') {
    const read = readRuntimeScreenAnswers(parseJsonRecord(current.step.config).screen, body.input);
    if (!read.ok) {
      return screenAnswerError(
        c,
        interactionId,
        read.problem,
        read.field,
        read.field ? `The answer for ${read.field} is not valid` : 'The answers are not valid'
      );
    }
    offProfileAnswers = splitOffProfileAnswers(read.answers);
    const hasProfileAnswers = read.answers.some(
      (answer) => answer.storeToProfile && answer.value !== null
    );
    const recordAnswers = offProfileAnswers.record;
    const hasRecordAnswers = Object.keys(recordAnswers).length > 0;
    // A visit left all empty replaces what an earlier submit of it kept: nothing is asked of the
    // person for it (no sign-in, no claim), the record is only cleared for whom it was kept.
    if (offProfileAnswers.hasRecordPart && !hasRecordAnswers && challengeSession?.userId) {
      clearRecordFor = challengeSession.userId;
    }
    const screen = runtimeStepScreenIdentity(current.step);
    if (hasRecordAnswers && !screen) {
      // A record names its screen; a step whose screen has no identity cannot keep one.
      return screenAnswerError(c, interactionId, 'invalid_input', null, 'The screen is not known');
    }
    if (hasProfileAnswers || hasRecordAnswers) {
      // Only for the person signed in, and only on an interaction about them (or no one yet): the
      // profile and the response record are that person's.
      const sessionUserId = challengeSession?.userId ?? null;
      if (!sessionUserId) {
        return runtimeError(
          c,
          401,
          'authentication_required',
          'Sign in to continue',
          'AR_FLOW_SCREEN_ANSWERS_AUTH_REQUIRED',
          'reauthentication_required',
          'reauthenticate',
          interactionId
        );
      }
      if (interaction.user_id && interaction.user_id !== sessionUserId) {
        return sessionUserMismatch(c, interactionId);
      }
      let writeProfile: (() => Promise<void>) | null = null;
      let writeRecord: (() => Promise<void>) | null = null;
      if (hasProfileAnswers) {
        const prepared = await prepareRuntimeScreenProfileAnswers({
          c,
          tenantId,
          userId: sessionUserId,
          answers: read.answers,
        });
        if (!prepared.ok) {
          return screenAnswerError(c, interactionId, 'invalid_profile_value', null, prepared.error);
        }
        writeProfile = prepared.write;
      }
      if (
        hasRecordAnswers &&
        screen &&
        !(await isRegisteredRuntimeUser(c, tenantId, sessionUserId))
      ) {
        // A guest's answers are not kept as a record: a guest's PII is erased under a fence that
        // knows only its own tables, and a record outliving the guest would be personal data
        // nobody erases. The Flow goes on; the answers still reach the Flow and its event.
        getLogger(c)
          .module('LOGIN-RUNTIME-FLOW')
          .info('Screen response record not kept for a guest', {
            action: 'flow_screen_answers',
            interaction_id: interactionId,
          });
      } else if (hasRecordAnswers && screen) {
        writeRecord = () =>
          writeRuntimeScreenResponse({
            c,
            tenantId,
            userId: sessionUserId,
            screen,
            interaction,
            stepId: current.step.id,
            stepRowId: stepState.id,
            answers: recordAnswers,
          });
      }
      screenAnswers = { userId: sessionUserId, writeProfile, writeRecord };
    }
  }

  // Before each thing this submit records: only within its claim's window (see
  // FLOW_SUBMIT_CLAIM_ACT_WINDOW_MS).
  if (runtimeSubmitClaimLapsed(claim)) return stepConflictError(c, interactionId);
  const consentResult = await persistRuntimeConsentStep({
    c,
    db,
    tenantId,
    interaction,
    step: current.step,
    submitInput: body.input,
    session: challengeSession,
    claimId: claim.id,
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
    // Not a session the challenge would refuse: that one is not this sign-in.
    resolvedUserId = challengeSession?.userId ?? null;
    if (resolvedUserId && runtimeSubmitClaimLapsed(claim)) {
      return stepConflictError(c, interactionId);
    }
    if (
      resolvedUserId &&
      !(await claimInteractionUser(db, tenantId, interaction, resolvedUserId))
    ) {
      return sessionUserMismatch(c, interactionId);
    }
  }

  // A screen's profile answers and response record, checked and prepared before anything is
  // recorded: stored once the interaction is about the person signed in.
  if (screenAnswers && resolvedUserId && resolvedUserId !== screenAnswers.userId) {
    return sessionUserMismatch(c, interactionId);
  }
  if (screenAnswers?.writeProfile) {
    if (runtimeSubmitClaimLapsed(claim)) return stepConflictError(c, interactionId);
    if (!(await claimInteractionUser(db, tenantId, interaction, screenAnswers.userId))) {
      return sessionUserMismatch(c, interactionId);
    }
    if (runtimeSubmitClaimLapsed(claim)) return stepConflictError(c, interactionId);
    resolvedUserId = screenAnswers.userId;
    // Before the next steps are judged: a condition after the screen may read what it stored.
    await screenAnswers.writeProfile();
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
          // The choices this submit sends to the Flow count for the conditions after it (they are
          // written with the step).
          interaction: offProfileAnswers?.hasFlowContextPart
            ? {
                ...interaction,
                context_json: JSON.stringify(
                  withRuntimeScreenAnswers(
                    parseJsonObject(interaction.context_json),
                    current.step.id,
                    offProfileAnswers.flowContext
                  )
                ),
              }
            : interaction,
          runtime,
          editor,
          requestContext,
          userId: resolvedUserId ?? null,
          initialStep: nextResolution.step,
          // Without a session the completion is not reached: it waits as the current step.
          ...(completionNeedsSession ? { completeTerminalStep: false } : {}),
        });
  if (visibleStepResolution.unavailable) {
    return authorizationRequestUnavailable(c, interactionId);
  }
  if (visibleStepResolution.terminalError) {
    await insertAuditEvent(c.env, tenantId, interaction, {
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
    await insertAuditEvent(c.env, tenantId, interaction, {
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
  if (runtimeSubmitClaimLapsed(claim)) return stepConflictError(c, interactionId);
  if (
    visibleStepResolution.userId &&
    visibleStepResolution.userId !== interaction.user_id &&
    !(await claimInteractionUser(db, tenantId, interaction, visibleStepResolution.userId))
  ) {
    return sessionUserMismatch(c, interactionId);
  }

  // The response record, once the steps after the screen accepted the submit (a condition that
  // ends the interaction keeps none, and the interaction is not claimed for it before then).
  if ((screenAnswers?.writeRecord || clearRecordFor) && runtimeSubmitClaimLapsed(claim)) {
    return stepConflictError(c, interactionId);
  }
  if (screenAnswers?.writeRecord) {
    if (resolvedUserId && resolvedUserId !== screenAnswers.userId) {
      return sessionUserMismatch(c, interactionId);
    }
    if (!(await claimInteractionUser(db, tenantId, interaction, screenAnswers.userId))) {
      return sessionUserMismatch(c, interactionId);
    }
    if (runtimeSubmitClaimLapsed(claim)) return stepConflictError(c, interactionId);
    resolvedUserId = screenAnswers.userId;
    await screenAnswers.writeRecord();
  }
  if (clearRecordFor && resolvedUserId === clearRecordFor) {
    await clearRuntimeScreenResponse(c, tenantId, clearRecordFor, stepState.id);
  }

  const nextStep = visibleStepResolution.step;
  const terminalStep = visibleStepResolution.terminalStep;
  const outputStep = terminalStep ?? current.step;
  const completed = nextStep === null;
  const nextState = completed ? 'completed' : 'active';
  const completedAt = completed ? now : null;

  // Whatever way the Flow reaches its end (the completion submitted, or a step before it with a
  // session already there), the same happens before anything is saved as complete: the consent
  // held from the method selection is recorded, and the authorization request is continued. If
  // either fails the interaction stays open, nothing is audited as a success, and the browser can
  // submit again.
  let completedProtocolRedirect: { redirectUrl?: string; response?: Response } = {};
  if (completed) {
    if (runtimeSubmitClaimLapsed(claim)) return stepConflictError(c, interactionId);
    if (challengeSession) {
      // Whatever was recorded before, the interaction ends for the user whose session ends it, and
      // for that user alone: the claim is made (and the user checked) here, every time.
      if (!(await claimInteractionUser(db, tenantId, interaction, challengeSession.userId))) {
        return sessionUserMismatch(c, interactionId);
      }
      if (runtimeSubmitClaimLapsed(claim)) return stepConflictError(c, interactionId);
      resolvedUserId = challengeSession.userId;
      const heldConsent = await recordHeldRuntimeConsent({
        c,
        db,
        tenantId,
        interaction,
        runtime,
        requestContext,
        session: challengeSession,
        claimId: claim.id,
      });
      if (heldConsent.response) return heldConsent.response;
    }
    if (runtimeSubmitClaimLapsed(claim)) return stepConflictError(c, interactionId);
    completedProtocolRedirect = await resolveCompletedProtocolRedirect({
      c,
      db,
      tenantId,
      interaction,
      runtime,
      requestContext,
      resolvedUserId,
      session: challengeSession,
    });
    if (completedProtocolRedirect.response) {
      return completedProtocolRedirect.response;
    }
  }

  // The choices a screen sends to the Flow are kept with the interaction, by step (a step shown
  // again replaces its own), so a later step can be chosen by them. They serve the steps still to
  // come: an interaction that ends here keeps none (it outlives the person's account otherwise).
  const storedContext = parseJsonObject(interaction.context_json);
  const keptContext = offProfileAnswers?.hasFlowContextPart
    ? withRuntimeScreenAnswers(storedContext, current.step.id, offProfileAnswers.flowContext)
    : storedContext;
  const nextContextJson =
    offProfileAnswers?.hasFlowContextPart || (completed && 'screen_answers' in storedContext)
      ? JSON.stringify(completed ? withoutRuntimeScreenAnswers(keptContext) : keptContext)
      : null;

  // Saved only under this submit's claim, still at its step: the interaction first (the claim's
  // expiry cleared, its id kept), then the step rows, each written only if the interaction was.
  // A claim lost meanwhile (held past its expiry and taken by another submit) saves nothing.
  const heldByThisSubmit = `EXISTS (
         SELECT 1 FROM flow_interactions
          WHERE tenant_id = ? AND id = ? AND submit_claim_id = ? AND submit_claim_expires_at IS NULL)`;
  if (runtimeSubmitClaimLapsed(claim)) return stepConflictError(c, interactionId);
  let saved: ExecuteResult[];
  try {
    saved = await writeAtomically(db, (write) => {
      write(
        `UPDATE flow_interactions
            SET state = ?, current_node_id = ?, current_step_id = ?, updated_at = ?,
                completed_at = ?, context_json = COALESCE(?, context_json),
                submit_claim_expires_at = NULL
          WHERE tenant_id = ? AND id = ? AND state IN ('created', 'active')
            AND current_step_id = ? AND submit_claim_id = ?
            AND submit_claim_expires_at IS NOT NULL`,
        [
          nextState,
          nextStep?.source_node_id ?? null,
          nextStep?.id ?? null,
          now,
          completedAt,
          // The choices a screen sends to the Flow: kept only while the interaction is still at
          // this step (the condition above), so a late copy of a submit already taken does not
          // undo what later steps keep.
          nextContextJson,
          tenantId,
          interactionId,
          current.step.id,
          claim.id,
        ]
      );
      write(
        `UPDATE flow_interaction_steps
         SET state = 'completed', selected_handle = ?, state_json = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND state IN ('pending', 'waiting_input', 'processing')
           AND ${heldByThisSubmit}`,
        [
          effectiveSelectedHandle,
          JSON.stringify({
            selected_handle: effectiveSelectedHandle,
            submitted_handle: selectedHandle,
            completed_at: now,
            // The order of the visits within a second (`created_at` counts seconds): a sign-up
            // resent from a later step finds the step it started on by it (resolveSignUpScreen).
            completed_at_ms: Date.now(),
            ...(consentResult.held ? { held_consent: consentResult.held } : {}),
          }),
          now,
          tenantId,
          stepState.id,
          tenantId,
          interactionId,
          claim.id,
        ]
      );

      if (nextStep) {
        write(
          `INSERT INTO flow_interaction_steps (
          id, tenant_id, interaction_id, node_id, step_id, state, selected_handle, state_json,
          created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?
           WHERE ${heldByThisSubmit}`,
          [
            generateId(),
            tenantId,
            interactionId,
            nextStep.source_node_id,
            nextStep.id,
            getStepStateForRuntimeStep(nextStep),
            now,
            now,
            tenantId,
            interactionId,
            claim.id,
          ]
        );
      }
    });
  } catch (error) {
    // Aurora DSQL: a concurrent write to the interaction refused this one at its commit.
    if (isSerializationConflict(error)) return stepConflictError(c, interactionId);
    throw error;
  }
  if ((saved[0]?.rowsAffected ?? 0) === 0) {
    // Nothing was saved, and none of the audit below is written: the step was taken by another
    // submit after this one's claim expired.
    getLogger(c)
      .module('LOGIN-RUNTIME-FLOW')
      .warn('Flow submit claim lost before the step was saved', {
        action: 'flow_submit_claim_lost',
        interaction_id: interactionId,
      });
    return stepConflictError(c, interactionId);
  }
  claim.saved = true;

  // The audit of a step that is saved is written without being waited for, and its failure is
  // logged, not answered: the step is saved and, if it was the last, so is the continuation, which
  // only this response can hand to the browser.
  const completionAudit: RuntimeAuditEventInput[] = [
    {
      eventType: eventTypeForCompletedStep(current.step),
      result: 'success',
      nodeId: current.step.source_node_id,
      branchHandleId: effectiveSelectedHandle,
      userId: resolvedUserId,
    },
  ];
  if (nextStep) {
    completionAudit.push({
      eventType: 'flow.node.entered',
      result: 'success',
      nodeId: nextStep.source_node_id,
      userId: resolvedUserId,
    });
  } else {
    if (current.step.component !== 'completion') {
      completionAudit.push({
        eventType: 'flow.output.completed',
        result: 'success',
        nodeId: outputStep.source_node_id,
        branchHandleId: effectiveSelectedHandle,
        userId: resolvedUserId,
      });
    }
    completionAudit.push({
      eventType: 'flow.interaction.completed',
      result: 'success',
      nodeId: current.step.source_node_id,
      branchHandleId: effectiveSelectedHandle,
      userId: resolvedUserId,
    });
  }
  await scheduleRuntimeAuditEvents(c, tenantId, interaction, completionAudit, 'submit_completion');
  if (offProfileAnswers?.hasFlowEventPart) {
    scheduleScreenSubmittedEvent(c, {
      tenantId,
      interaction,
      step: current.step,
      userId: resolvedUserId ?? null,
      submissionId: stepState.id,
      answers: offProfileAnswers.flowEvent,
    });
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

  const backScreens = nextStep
    ? await runtimeBackScreens(db, tenantId, interactionId, nextStep.id, {
        runtime,
        editor,
        requestContext,
      })
    : [];
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
    back_screens: backScreens,
  });
}
