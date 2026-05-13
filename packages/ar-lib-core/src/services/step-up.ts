import type { Env } from '../types/env';
import type { Challenge } from '../durable-objects/ChallengeStore';
import { arrayBufferToBase64Url, generateSecureRandomString } from '../utils/crypto';
import { getChallengeStoreByChallengeId } from '../utils/challenge-sharding';
import type {
  StepUpInputState,
  StepUpPreferredMethod,
  StepUpStatusObject,
} from '../errors/step-up';

const STEP_UP_TOKEN_TYPE = 'step_up_token';
const STEP_UP_ACTION_TYPE = 'step_up_action';
const STEP_UP_RECEIPT_TYPE = 'step_up_receipt';
const STEP_UP_SETTINGS_CATEGORY = 'step-up';

export const DEFAULT_STEP_UP_POLICY = {
  stepUpTokenTtlSeconds: 300,
  stepUpActionTtlSeconds: 600,
  stepUpReceiptTtlSeconds: 300,
  stepUpAttemptLimit: 5,
  stepUpResendCooldownSeconds: 60,
  stepUpMaxResends: 3,
} as const;

const STEP_UP_POLICY_MAX = {
  stepUpTokenTtlSeconds: 24 * 60 * 60,
  stepUpActionTtlSeconds: 24 * 60 * 60,
  stepUpReceiptTtlSeconds: 24 * 60 * 60,
  stepUpAttemptLimit: 20,
  stepUpResendCooldownSeconds: 60 * 60,
  stepUpMaxResends: 20,
} as const;

const METHOD_CATALOG = {
  portal_confirm: {
    category: 'confirmation',
    nextActionType: 'confirmation',
    resendSupported: false,
  },
  email_otp: {
    category: 'otp',
    nextActionType: 'otp',
    resendSupported: true,
  },
  sms_otp: {
    category: 'otp',
    nextActionType: 'otp',
    resendSupported: true,
  },
  reauth: {
    category: 'reauth',
    nextActionType: 'reauth',
    resendSupported: false,
  },
  passkey: {
    category: 'mfa',
    nextActionType: 'passkey',
    resendSupported: false,
  },
} as const;

export type StepUpKnownMethod = keyof typeof METHOD_CATALOG;
export type StepUpKnownCategory = (typeof METHOD_CATALOG)[StepUpKnownMethod]['category'];

export interface StepUpPolicy {
  stepUpTokenTtlSeconds: number;
  stepUpActionTtlSeconds: number;
  stepUpReceiptTtlSeconds: number;
  stepUpAttemptLimit: number;
  stepUpResendCooldownSeconds: number;
  stepUpMaxResends: number;
}

export interface StepUpAcceptableMethods {
  categories?: string[];
  methods?: string[];
}

export interface StepUpOperationBinding {
  tenantId: string;
  actorId: string;
  subjectId: string;
  operationHash: string;
  idempotencyKey?: string;
}

export interface StepUpRequirement {
  step_up_token: string;
  expires_at: string;
  expires_at_unix: number;
  acceptable_methods: StepUpAcceptableMethods;
}

export interface IssueStepUpTokenInput extends StepUpOperationBinding {
  acceptableMethods?: StepUpAcceptableMethods;
  ttlSeconds?: number;
}

export interface StartStepUpActionInput {
  stepUpToken: string;
  tenantId: string;
  preferredMethod?: StepUpPreferredMethod;
  now?: number;
}

export interface CompleteStepUpActionInput {
  actionId: string;
  tenantId: string;
  method: string;
  input: unknown;
  now?: number;
}

export interface ResendStepUpActionInput {
  actionId: string;
  tenantId: string;
  now?: number;
}

export interface ConsumeStepUpReceiptInput extends StepUpOperationBinding {
  receipt: string;
}

export interface StepUpNextAction {
  type: string;
  method: string;
  category: string;
  action_id: string;
  expires_at: string;
  expires_at_unix: number;
  payload: Record<string, unknown>;
}

export interface StepUpActionResponse {
  action_id: string;
  status: StepUpStatusObject;
  next_action?: StepUpNextAction;
  step_up_receipt?: string;
  step_up_receipt_expires_at?: string;
  step_up_receipt_expires_at_unix?: number;
}

type StepUpTokenMetadata = StepUpOperationBinding & {
  version: 1;
  acceptable_methods: StepUpAcceptableMethods;
  issued_at: number;
  expires_at: number;
};

type StepUpActionMetadata = StepUpOperationBinding & {
  version: 1;
  step_up_token: string;
  action_id: string;
  method: string;
  category: string;
  status: 'pending' | 'completed' | 'failed' | 'expired' | 'canceled';
  attempt_limit: number;
  attempts_used: number;
  resend_count: number;
  max_resends: number;
  resend_cooldown_seconds: number;
  last_resend_at?: number;
  receipt_id?: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
  terminal_at?: number;
};

type StepUpReceiptMetadata = StepUpOperationBinding & {
  version: 1;
  receipt_id: string;
  action_id: string;
  method: string;
  issued_at: number;
  expires_at: number;
};

export class StepUpFlowError extends Error {
  readonly error: string;
  readonly httpStatus: 400 | 403 | 404 | 409 | 429 | 500;
  readonly detailCode?:
    | 'step_up_required'
    | 'preferred_method_unavailable'
    | 'invalid_step_up_input'
    | 'step_up_attempts_exhausted'
    | 'resend_limit_exceeded'
    | 'user_canceled';
  readonly statusObject?: StepUpStatusObject;
  readonly inputState?: StepUpInputState;
  readonly stepUp?: StepUpRequirement;
  readonly nextAction?: StepUpNextAction;
  readonly retryAfterSeconds?: number;

  constructor(input: {
    error: string;
    message: string;
    httpStatus: 400 | 403 | 404 | 409 | 429 | 500;
    detailCode?: StepUpFlowError['detailCode'];
    statusObject?: StepUpStatusObject;
    inputState?: StepUpInputState;
    stepUp?: StepUpRequirement;
    nextAction?: StepUpNextAction;
    retryAfterSeconds?: number;
  }) {
    super(input.message);
    this.name = 'StepUpFlowError';
    this.error = input.error;
    this.httpStatus = input.httpStatus;
    this.detailCode = input.detailCode;
    this.statusObject = input.statusObject;
    this.inputState = input.inputState;
    this.stepUp = input.stepUp;
    this.nextAction = input.nextAction;
    this.retryAfterSeconds = input.retryAfterSeconds;
  }
}

export class StepUpPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepUpPolicyError';
  }
}

function compactUuid(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export function generateStepUpTokenId(): string {
  return `stu_${compactUuid()}`;
}

export function generateStepUpActionId(): string {
  return `sua_${compactUuid()}`;
}

export function generateStepUpReceiptId(): string {
  return `sur_${compactUuid()}`;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function toUnix(ms: number): number {
  return Math.floor(ms / 1000);
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128);
}

function ensurePositiveInteger(
  value: unknown,
  field: keyof StepUpPolicy,
  defaultValue: number,
  maxValue: number
): number {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new StepUpPolicyError(`${field} must be a positive integer`);
  }
  return Math.min(numeric, maxValue);
}

function readPolicyValue(
  settings: Record<string, unknown>,
  snake: string,
  camel: keyof StepUpPolicy
) {
  return settings[snake] ?? settings[camel];
}

async function readStepUpSettings(
  kv: KVNamespace | undefined,
  tenantId: string
): Promise<Record<string, unknown> | null> {
  if (!kv) {
    return null;
  }
  try {
    const raw = await kv.get(`settings:tenant:${tenantId}:${STEP_UP_SETTINGS_CATEGORY}`);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function resolveStepUpPolicy(
  env: Pick<Env, 'AUTHRIM_CONFIG' | 'SETTINGS'>,
  tenantId: string
): Promise<StepUpPolicy> {
  const [configSettings, settingsSettings] = await Promise.all([
    readStepUpSettings(env.AUTHRIM_CONFIG, tenantId),
    readStepUpSettings(env.SETTINGS, tenantId),
  ]);
  const settings = {
    ...(configSettings ?? {}),
    ...(settingsSettings ?? {}),
  };

  return {
    stepUpTokenTtlSeconds: ensurePositiveInteger(
      readPolicyValue(settings, 'step_up_token_ttl_seconds', 'stepUpTokenTtlSeconds'),
      'stepUpTokenTtlSeconds',
      DEFAULT_STEP_UP_POLICY.stepUpTokenTtlSeconds,
      STEP_UP_POLICY_MAX.stepUpTokenTtlSeconds
    ),
    stepUpActionTtlSeconds: ensurePositiveInteger(
      readPolicyValue(settings, 'step_up_action_ttl_seconds', 'stepUpActionTtlSeconds'),
      'stepUpActionTtlSeconds',
      DEFAULT_STEP_UP_POLICY.stepUpActionTtlSeconds,
      STEP_UP_POLICY_MAX.stepUpActionTtlSeconds
    ),
    stepUpReceiptTtlSeconds: ensurePositiveInteger(
      readPolicyValue(settings, 'step_up_receipt_ttl_seconds', 'stepUpReceiptTtlSeconds'),
      'stepUpReceiptTtlSeconds',
      DEFAULT_STEP_UP_POLICY.stepUpReceiptTtlSeconds,
      STEP_UP_POLICY_MAX.stepUpReceiptTtlSeconds
    ),
    stepUpAttemptLimit: ensurePositiveInteger(
      readPolicyValue(settings, 'step_up_attempt_limit', 'stepUpAttemptLimit'),
      'stepUpAttemptLimit',
      DEFAULT_STEP_UP_POLICY.stepUpAttemptLimit,
      STEP_UP_POLICY_MAX.stepUpAttemptLimit
    ),
    stepUpResendCooldownSeconds: ensurePositiveInteger(
      readPolicyValue(settings, 'step_up_resend_cooldown_seconds', 'stepUpResendCooldownSeconds'),
      'stepUpResendCooldownSeconds',
      DEFAULT_STEP_UP_POLICY.stepUpResendCooldownSeconds,
      STEP_UP_POLICY_MAX.stepUpResendCooldownSeconds
    ),
    stepUpMaxResends: ensurePositiveInteger(
      readPolicyValue(settings, 'step_up_max_resends', 'stepUpMaxResends'),
      'stepUpMaxResends',
      DEFAULT_STEP_UP_POLICY.stepUpMaxResends,
      STEP_UP_POLICY_MAX.stepUpMaxResends
    ),
  };
}

function normalizeStringList(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const normalized = values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

function normalizeAcceptableMethods(input?: StepUpAcceptableMethods): StepUpAcceptableMethods {
  const categories = normalizeStringList(input?.categories);
  const methods = normalizeStringList(input?.methods);
  if (!categories && !methods) {
    return { methods: ['portal_confirm'] };
  }
  return {
    ...(categories ? { categories } : {}),
    ...(methods ? { methods } : {}),
  };
}

function methodDefinition(method: string): {
  category: string;
  nextActionType: string;
  resendSupported: boolean;
} | null {
  return METHOD_CATALOG[method as StepUpKnownMethod] ?? null;
}

function isMethodAllowed(method: string, acceptable: StepUpAcceptableMethods): boolean {
  const definition = methodDefinition(method);
  if (!definition) {
    return false;
  }
  return (
    acceptable.methods?.includes(method) === true ||
    acceptable.categories?.includes(definition.category) === true
  );
}

function allAllowedMethods(acceptable: StepUpAcceptableMethods): string[] {
  const methods = new Set<string>();
  for (const method of acceptable.methods ?? []) {
    if (methodDefinition(method)) {
      methods.add(method);
    }
  }
  for (const category of acceptable.categories ?? []) {
    for (const [method, definition] of Object.entries(METHOD_CATALOG)) {
      if (definition.category === category) {
        methods.add(method);
      }
    }
  }
  if (methods.size === 0) {
    methods.add('portal_confirm');
  }
  return Array.from(methods);
}

function resolvePreferredMethod(
  preferred: StepUpPreferredMethod | undefined,
  acceptable: StepUpAcceptableMethods
): { method: string; category: string } {
  if (!preferred) {
    const method = allAllowedMethods(acceptable)[0]!;
    const definition = methodDefinition(method)!;
    return { method, category: definition.category };
  }

  const category = preferred.category?.trim();
  const method = preferred.method?.trim();
  if (!category && !method) {
    throw new StepUpFlowError({
      error: 'invalid_request',
      message: 'preferred_method must include category or method',
      httpStatus: 400,
    });
  }

  if (method) {
    const definition = methodDefinition(method);
    if (!definition) {
      throw new StepUpFlowError({
        error: 'preferred_method_unavailable',
        message: 'Preferred step-up method is unavailable',
        httpStatus: 403,
        detailCode: 'preferred_method_unavailable',
      });
    }
    if (category && category !== definition.category) {
      throw new StepUpFlowError({
        error: 'invalid_request',
        message: 'preferred_method category and method are contradictory',
        httpStatus: 400,
      });
    }
    if (!isMethodAllowed(method, acceptable)) {
      throw new StepUpFlowError({
        error: 'preferred_method_unavailable',
        message: 'Preferred step-up method is unavailable',
        httpStatus: 403,
        detailCode: 'preferred_method_unavailable',
      });
    }
    return { method, category: definition.category };
  }

  const allowed = allAllowedMethods(acceptable).find(
    (candidate) => methodDefinition(candidate)?.category === category
  );
  if (!allowed) {
    throw new StepUpFlowError({
      error: 'preferred_method_unavailable',
      message: 'Preferred step-up method is unavailable',
      httpStatus: 403,
      detailCode: 'preferred_method_unavailable',
    });
  }
  return { method: allowed, category: category! };
}

async function getStore(env: Env, id: string, tenantId: string) {
  return getChallengeStoreByChallengeId(env, id, tenantId);
}

function tokenMetadataFromChallenge(challenge: Challenge | null): StepUpTokenMetadata | null {
  if (!challenge || challenge.type !== STEP_UP_TOKEN_TYPE || challenge.consumed) {
    return null;
  }
  const metadata = challenge.metadata as Partial<StepUpTokenMetadata> | undefined;
  if (
    !metadata ||
    metadata.version !== 1 ||
    typeof metadata.tenantId !== 'string' ||
    typeof metadata.actorId !== 'string' ||
    typeof metadata.subjectId !== 'string' ||
    typeof metadata.operationHash !== 'string' ||
    typeof metadata.expires_at !== 'number'
  ) {
    return null;
  }
  return {
    version: 1,
    tenantId: metadata.tenantId,
    actorId: metadata.actorId,
    subjectId: metadata.subjectId,
    operationHash: metadata.operationHash,
    ...(typeof metadata.idempotencyKey === 'string'
      ? { idempotencyKey: metadata.idempotencyKey }
      : {}),
    acceptable_methods: normalizeAcceptableMethods(metadata.acceptable_methods),
    issued_at: typeof metadata.issued_at === 'number' ? metadata.issued_at : challenge.createdAt,
    expires_at: metadata.expires_at,
  };
}

function actionMetadataFromChallenge(challenge: Challenge | null): StepUpActionMetadata | null {
  if (!challenge || challenge.type !== STEP_UP_ACTION_TYPE) {
    return null;
  }
  const metadata = challenge.metadata as Partial<StepUpActionMetadata> | undefined;
  if (
    !metadata ||
    metadata.version !== 1 ||
    typeof metadata.action_id !== 'string' ||
    typeof metadata.method !== 'string' ||
    typeof metadata.category !== 'string' ||
    typeof metadata.tenantId !== 'string' ||
    typeof metadata.actorId !== 'string' ||
    typeof metadata.subjectId !== 'string' ||
    typeof metadata.operationHash !== 'string' ||
    typeof metadata.expires_at !== 'number' ||
    typeof metadata.attempt_limit !== 'number' ||
    typeof metadata.attempts_used !== 'number' ||
    typeof metadata.resend_count !== 'number' ||
    typeof metadata.max_resends !== 'number' ||
    typeof metadata.resend_cooldown_seconds !== 'number'
  ) {
    return null;
  }
  return {
    version: 1,
    tenantId: metadata.tenantId,
    actorId: metadata.actorId,
    subjectId: metadata.subjectId,
    operationHash: metadata.operationHash,
    ...(typeof metadata.idempotencyKey === 'string'
      ? { idempotencyKey: metadata.idempotencyKey }
      : {}),
    step_up_token: String(metadata.step_up_token ?? ''),
    action_id: metadata.action_id,
    method: metadata.method,
    category: metadata.category,
    status: metadata.status ?? 'pending',
    attempt_limit: metadata.attempt_limit,
    attempts_used: metadata.attempts_used,
    resend_count: metadata.resend_count,
    max_resends: metadata.max_resends,
    resend_cooldown_seconds: metadata.resend_cooldown_seconds,
    ...(typeof metadata.last_resend_at === 'number'
      ? { last_resend_at: metadata.last_resend_at }
      : {}),
    ...(typeof metadata.receipt_id === 'string' ? { receipt_id: metadata.receipt_id } : {}),
    created_at: typeof metadata.created_at === 'number' ? metadata.created_at : challenge.createdAt,
    updated_at: typeof metadata.updated_at === 'number' ? metadata.updated_at : challenge.createdAt,
    expires_at: metadata.expires_at,
    ...(typeof metadata.terminal_at === 'number' ? { terminal_at: metadata.terminal_at } : {}),
  };
}

function receiptMetadataFromChallenge(challenge: Challenge | null): StepUpReceiptMetadata | null {
  if (!challenge || challenge.type !== STEP_UP_RECEIPT_TYPE || challenge.consumed) {
    return null;
  }
  const metadata = challenge.metadata as Partial<StepUpReceiptMetadata> | undefined;
  if (
    !metadata ||
    metadata.version !== 1 ||
    typeof metadata.receipt_id !== 'string' ||
    typeof metadata.action_id !== 'string' ||
    typeof metadata.method !== 'string' ||
    typeof metadata.tenantId !== 'string' ||
    typeof metadata.actorId !== 'string' ||
    typeof metadata.subjectId !== 'string' ||
    typeof metadata.operationHash !== 'string' ||
    typeof metadata.expires_at !== 'number'
  ) {
    return null;
  }
  return {
    version: 1,
    receipt_id: metadata.receipt_id,
    action_id: metadata.action_id,
    method: metadata.method,
    tenantId: metadata.tenantId,
    actorId: metadata.actorId,
    subjectId: metadata.subjectId,
    operationHash: metadata.operationHash,
    ...(typeof metadata.idempotencyKey === 'string'
      ? { idempotencyKey: metadata.idempotencyKey }
      : {}),
    issued_at: typeof metadata.issued_at === 'number' ? metadata.issued_at : challenge.createdAt,
    expires_at: metadata.expires_at,
  };
}

function toRequirement(token: string, metadata: StepUpTokenMetadata): StepUpRequirement {
  return {
    step_up_token: token,
    expires_at: toIso(metadata.expires_at),
    expires_at_unix: toUnix(metadata.expires_at),
    acceptable_methods: metadata.acceptable_methods,
  };
}

function toStatus(metadata: StepUpActionMetadata, now: number = Date.now()): StepUpStatusObject {
  const status =
    metadata.status === 'pending' && metadata.expires_at <= now ? 'expired' : metadata.status;
  return {
    action_id: metadata.action_id,
    status,
    method: metadata.method,
    category: metadata.category,
    preferred_method: {
      category: metadata.category,
      method: metadata.method,
    },
    updated_at: toIso(metadata.updated_at),
    updated_at_unix: toUnix(metadata.updated_at),
    expires_at: toIso(metadata.expires_at),
    expires_at_unix: toUnix(metadata.expires_at),
    attempts_remaining: Math.max(0, metadata.attempt_limit - metadata.attempts_used),
    max_attempts: metadata.attempt_limit,
    resends_remaining: Math.max(0, metadata.max_resends - metadata.resend_count),
    ...(metadata.last_resend_at
      ? {
          resend_available_at: toIso(
            metadata.last_resend_at + metadata.resend_cooldown_seconds * 1000
          ),
          resend_available_at_unix: toUnix(
            metadata.last_resend_at + metadata.resend_cooldown_seconds * 1000
          ),
        }
      : {}),
    ...(metadata.terminal_at
      ? { terminal_at: toIso(metadata.terminal_at), terminal_at_unix: toUnix(metadata.terminal_at) }
      : {}),
  };
}

function toNextAction(metadata: StepUpActionMetadata): StepUpNextAction {
  const definition = methodDefinition(metadata.method) ?? METHOD_CATALOG.portal_confirm;
  return {
    type: definition.nextActionType,
    method: metadata.method,
    category: metadata.category,
    action_id: metadata.action_id,
    expires_at: toIso(metadata.expires_at),
    expires_at_unix: toUnix(metadata.expires_at),
    payload: {
      resend_supported: definition.resendSupported,
      ...(metadata.method === 'portal_confirm' ? { confirm_required: true } : {}),
      ...(definition.nextActionType === 'otp'
        ? { delivery: 'out_of_band', input: { field: 'code', format: '6_digit_numeric' } }
        : {}),
    },
  };
}

function toActionResponse(
  metadata: StepUpActionMetadata,
  now: number = Date.now()
): StepUpActionResponse {
  const status = toStatus(metadata, now);
  const terminal = status.status !== 'pending';
  return {
    action_id: metadata.action_id,
    status,
    ...(!terminal ? { next_action: toNextAction(metadata) } : {}),
  };
}

function inputState(metadata: StepUpActionMetadata, field?: string): StepUpInputState {
  return {
    ...(field ? { field } : {}),
    attempts_remaining: Math.max(0, metadata.attempt_limit - metadata.attempts_used),
    max_attempts: metadata.attempt_limit,
    ...(metadata.last_resend_at
      ? {
          resend_available_at: toIso(
            metadata.last_resend_at + metadata.resend_cooldown_seconds * 1000
          ),
          resend_available_at_unix: toUnix(
            metadata.last_resend_at + metadata.resend_cooldown_seconds * 1000
          ),
        }
      : {}),
  };
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return arrayBufferToBase64Url(digest);
}

export async function createStepUpOperationHash(operation: unknown): Promise<string> {
  return sha256Base64Url(JSON.stringify(operation));
}

function pendingActionKey(binding: StepUpOperationBinding): string {
  const raw = [
    binding.tenantId,
    binding.actorId,
    binding.subjectId,
    binding.operationHash,
    binding.idempotencyKey ?? '',
  ].join(':');
  return `step_up:pending:${sanitizeIdPart(binding.tenantId)}:${arrayBufferToBase64Url(
    new TextEncoder().encode(raw)
  ).slice(0, 160)}`;
}

async function getPendingActionId(
  env: Pick<Env, 'AUTHRIM_CONFIG'>,
  binding: StepUpOperationBinding
): Promise<string | null> {
  return (await env.AUTHRIM_CONFIG?.get(pendingActionKey(binding)).catch(() => null)) ?? null;
}

async function setPendingActionId(
  env: Pick<Env, 'AUTHRIM_CONFIG'>,
  binding: StepUpOperationBinding,
  actionId: string,
  ttlSeconds: number
): Promise<void> {
  await env.AUTHRIM_CONFIG?.put(pendingActionKey(binding), actionId, {
    expirationTtl: Math.max(1, ttlSeconds),
  }).catch(() => {});
}

async function clearPendingActionId(
  env: Pick<Env, 'AUTHRIM_CONFIG'>,
  binding: StepUpOperationBinding
): Promise<void> {
  await env.AUTHRIM_CONFIG?.delete(pendingActionKey(binding)).catch(() => {});
}

async function storeAction(
  env: Env,
  metadata: StepUpActionMetadata,
  challengeValue: string
): Promise<void> {
  const ttlSeconds = Math.max(1, Math.ceil((metadata.expires_at - Date.now()) / 1000));
  const store = await getStore(env, metadata.action_id, metadata.tenantId);
  await store.storeChallengeRpc({
    id: metadata.action_id,
    tenantId: metadata.tenantId,
    type: STEP_UP_ACTION_TYPE,
    userId: metadata.actorId,
    challenge: challengeValue,
    ttl: ttlSeconds,
    metadata,
  });
}

async function loadActionWithChallenge(
  env: Env,
  actionId: string,
  now: number,
  tenantId: string
): Promise<{ metadata: StepUpActionMetadata; challenge: string } | null> {
  const store = await getStore(env, actionId, tenantId);
  const challenge = (await store.getChallengeRpc(actionId)) as Challenge | null;
  const metadata = actionMetadataFromChallenge(challenge);
  if (!metadata) {
    return null;
  }
  if (metadata.status === 'pending' && metadata.expires_at <= now) {
    const expired = {
      ...metadata,
      status: 'expired' as const,
      updated_at: now,
      terminal_at: now,
    };
    await storeAction(env, expired, challenge?.challenge ?? actionId);
    await clearPendingActionId(env, expired);
    return { metadata: expired, challenge: challenge?.challenge ?? actionId };
  }
  return { metadata, challenge: challenge?.challenge ?? actionId };
}

function assertStepUpTokenShape(token: string): void {
  if (!/^stu_[A-Za-z0-9_-]{16,}$/.test(token)) {
    throw new StepUpFlowError({
      error: 'invalid_request',
      message: 'step_up_token is malformed',
      httpStatus: 400,
    });
  }
}

function assertActionIdShape(actionId: string): void {
  if (!/^sua_[A-Za-z0-9_-]{16,}$/.test(actionId)) {
    throw new StepUpFlowError({
      error: 'invalid_request',
      message: 'action_id is malformed',
      httpStatus: 400,
    });
  }
}

function assertReceiptShape(receipt: string): void {
  if (!/^sur_[A-Za-z0-9_-]{16,}$/.test(receipt)) {
    throw new StepUpFlowError({
      error: 'invalid_request',
      message: 'step_up_receipt is malformed',
      httpStatus: 400,
    });
  }
}

export async function issueStepUpToken(
  env: Env,
  input: IssueStepUpTokenInput
): Promise<StepUpRequirement> {
  const tenantId = input.tenantId;
  const policy = await resolveStepUpPolicy(env, tenantId);
  const ttlSeconds = input.ttlSeconds ?? policy.stepUpTokenTtlSeconds;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new StepUpPolicyError('stepUpTokenTtlSeconds must be a positive integer');
  }
  const token = generateStepUpTokenId();
  const now = Date.now();
  const metadata: StepUpTokenMetadata = {
    version: 1,
    tenantId,
    actorId: input.actorId,
    subjectId: input.subjectId,
    operationHash: input.operationHash,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    acceptable_methods: normalizeAcceptableMethods(input.acceptableMethods),
    issued_at: now,
    expires_at: now + ttlSeconds * 1000,
  };

  const store = await getStore(env, token, tenantId);
  await store.storeChallengeRpc({
    id: token,
    tenantId,
    type: STEP_UP_TOKEN_TYPE,
    userId: input.actorId,
    challenge: token,
    ttl: ttlSeconds,
    metadata,
  });

  return toRequirement(token, metadata);
}

export async function startStepUpAction(
  env: Env,
  input: StartStepUpActionInput
): Promise<StepUpActionResponse> {
  assertStepUpTokenShape(input.stepUpToken);
  const now = input.now ?? Date.now();
  const tokenStore = await getStore(env, input.stepUpToken, input.tenantId);
  const tokenChallenge = (await tokenStore.getChallengeRpc(input.stepUpToken)) as Challenge | null;
  const tokenMetadata = tokenMetadataFromChallenge(tokenChallenge);
  if (!tokenMetadata || tokenMetadata.expires_at <= now) {
    throw new StepUpFlowError({
      error: 'step_up_required',
      message: 'Step-up token is invalid or expired',
      httpStatus: 403,
      detailCode: 'step_up_required',
    });
  }

  try {
    const pendingActionId = await getPendingActionId(env, tokenMetadata);
    if (pendingActionId) {
      const pending = await loadActionWithChallenge(
        env,
        pendingActionId,
        now,
        tokenMetadata.tenantId
      );
      if (pending?.metadata.status === 'pending') {
        return toActionResponse(pending.metadata, now);
      }
    }

    const resolved = resolvePreferredMethod(
      input.preferredMethod,
      tokenMetadata.acceptable_methods
    );
    const policy = await resolveStepUpPolicy(env, tokenMetadata.tenantId);
    const actionId = generateStepUpActionId();
    const expiresAt = Math.min(
      tokenMetadata.expires_at,
      now + policy.stepUpActionTtlSeconds * 1000
    );
    const definition = methodDefinition(resolved.method) ?? METHOD_CATALOG.portal_confirm;
    const challengeValue =
      definition.nextActionType === 'otp'
        ? generateUnbiasedNumericCode(6)
        : generateSecureRandomString(32);
    const metadata: StepUpActionMetadata = {
      version: 1,
      tenantId: tokenMetadata.tenantId,
      actorId: tokenMetadata.actorId,
      subjectId: tokenMetadata.subjectId,
      operationHash: tokenMetadata.operationHash,
      ...(tokenMetadata.idempotencyKey ? { idempotencyKey: tokenMetadata.idempotencyKey } : {}),
      step_up_token: input.stepUpToken,
      action_id: actionId,
      method: resolved.method,
      category: resolved.category,
      status: 'pending',
      attempt_limit: policy.stepUpAttemptLimit,
      attempts_used: 0,
      resend_count: 0,
      max_resends: policy.stepUpMaxResends,
      resend_cooldown_seconds: policy.stepUpResendCooldownSeconds,
      created_at: now,
      updated_at: now,
      expires_at: expiresAt,
    };

    await storeAction(env, metadata, challengeValue);
    await setPendingActionId(
      env,
      tokenMetadata,
      actionId,
      Math.max(1, Math.ceil((expiresAt - now) / 1000))
    );

    return toActionResponse(metadata, now);
  } catch (error) {
    if (error instanceof StepUpFlowError && error.detailCode === 'preferred_method_unavailable') {
      throw new StepUpFlowError({
        error: error.error,
        message: error.message,
        httpStatus: error.httpStatus,
        detailCode: error.detailCode,
        stepUp: toRequirement(input.stepUpToken, tokenMetadata),
      });
    }
    throw error;
  }
}

export async function getStepUpActionStatus(
  env: Env,
  actionId: string,
  tenantId: string,
  now: number = Date.now()
): Promise<StepUpActionResponse> {
  assertActionIdShape(actionId);
  const action = await loadActionWithChallenge(env, actionId, now, tenantId);
  if (!action) {
    throw new StepUpFlowError({
      error: 'invalid_request',
      message: 'Step-up action was not found',
      httpStatus: 404,
    });
  }
  return toActionResponse(action.metadata, now);
}

function isValidCompletionInput(method: string, input: unknown, challenge: string): boolean {
  if (typeof input !== 'object' || input === null) {
    return false;
  }
  const record = input as Record<string, unknown>;
  if (method === 'portal_confirm' || method === 'reauth') {
    return record.confirmed === true;
  }
  if (method === 'email_otp' || method === 'sms_otp') {
    return typeof record.code === 'string' && record.code === challenge;
  }
  return false;
}

export async function completeStepUpAction(
  env: Env,
  input: CompleteStepUpActionInput
): Promise<StepUpActionResponse> {
  assertActionIdShape(input.actionId);
  const now = input.now ?? Date.now();
  const action = await loadActionWithChallenge(
    env,
    input.actionId,
    now,
    input.tenantId
  );
  if (!action) {
    throw new StepUpFlowError({
      error: 'invalid_request',
      message: 'Step-up action was not found',
      httpStatus: 404,
    });
  }
  const { metadata, challenge } = action;
  if (metadata.status !== 'pending') {
    throw new StepUpFlowError({
      error: 'invalid_step_up_input',
      message: 'Step-up action is already terminal',
      httpStatus: 409,
      detailCode: 'invalid_step_up_input',
      statusObject: toStatus(metadata, now),
    });
  }
  if (input.method !== metadata.method) {
    throw new StepUpFlowError({
      error: 'invalid_step_up_input',
      message: 'Step-up completion method does not match the action',
      httpStatus: 409,
      detailCode: 'invalid_step_up_input',
      statusObject: toStatus(metadata, now),
      inputState: inputState(metadata, 'method'),
    });
  }

  if (!isValidCompletionInput(metadata.method, input.input, challenge)) {
    const attemptsUsed = metadata.attempts_used + 1;
    const failedTerminal = attemptsUsed >= metadata.attempt_limit;
    const updated: StepUpActionMetadata = {
      ...metadata,
      attempts_used: attemptsUsed,
      status: failedTerminal ? 'failed' : 'pending',
      updated_at: now,
      ...(failedTerminal ? { terminal_at: now } : {}),
    };
    await storeAction(env, updated, challenge);
    if (failedTerminal) {
      await clearPendingActionId(env, updated);
    }
    throw new StepUpFlowError({
      error: failedTerminal ? 'step_up_attempts_exhausted' : 'invalid_step_up_input',
      message: failedTerminal ? 'Step-up attempts have been exhausted' : 'Step-up input is invalid',
      httpStatus: failedTerminal ? 409 : 400,
      detailCode: failedTerminal ? 'step_up_attempts_exhausted' : 'invalid_step_up_input',
      statusObject: toStatus(updated, now),
      inputState: inputState(updated, metadata.method === 'portal_confirm' ? 'confirmed' : 'code'),
    });
  }

  const policy = await resolveStepUpPolicy(env, metadata.tenantId);
  const receiptId = generateStepUpReceiptId();
  const receiptExpiresAt = now + policy.stepUpReceiptTtlSeconds * 1000;
  const receiptMetadata: StepUpReceiptMetadata = {
    version: 1,
    receipt_id: receiptId,
    action_id: metadata.action_id,
    method: metadata.method,
    tenantId: metadata.tenantId,
    actorId: metadata.actorId,
    subjectId: metadata.subjectId,
    operationHash: metadata.operationHash,
    ...(metadata.idempotencyKey ? { idempotencyKey: metadata.idempotencyKey } : {}),
    issued_at: now,
    expires_at: receiptExpiresAt,
  };
  const receiptStore = await getStore(env, receiptId, metadata.tenantId);
  await receiptStore.storeChallengeRpc({
    id: receiptId,
    tenantId: metadata.tenantId,
    type: STEP_UP_RECEIPT_TYPE,
    userId: metadata.actorId,
    challenge: receiptId,
    ttl: policy.stepUpReceiptTtlSeconds,
    metadata: receiptMetadata,
  });

  const completed: StepUpActionMetadata = {
    ...metadata,
    status: 'completed',
    updated_at: now,
    terminal_at: now,
    receipt_id: receiptId,
  };
  await storeAction(env, completed, challenge);
  await clearPendingActionId(env, completed);

  return {
    action_id: metadata.action_id,
    status: toStatus(completed, now),
    step_up_receipt: receiptId,
    step_up_receipt_expires_at: toIso(receiptExpiresAt),
    step_up_receipt_expires_at_unix: toUnix(receiptExpiresAt),
  };
}

export async function resendStepUpAction(
  env: Env,
  input: ResendStepUpActionInput
): Promise<StepUpActionResponse> {
  assertActionIdShape(input.actionId);
  const now = input.now ?? Date.now();
  const action = await loadActionWithChallenge(
    env,
    input.actionId,
    now,
    input.tenantId
  );
  if (!action) {
    throw new StepUpFlowError({
      error: 'invalid_request',
      message: 'Step-up action was not found',
      httpStatus: 404,
    });
  }
  const { metadata } = action;
  if (metadata.status !== 'pending') {
    throw new StepUpFlowError({
      error: 'invalid_step_up_input',
      message: 'Step-up action is already terminal',
      httpStatus: 409,
      detailCode: 'invalid_step_up_input',
      statusObject: toStatus(metadata, now),
    });
  }
  const definition = methodDefinition(metadata.method);
  if (!definition?.resendSupported) {
    throw new StepUpFlowError({
      error: 'invalid_request',
      message: 'This step-up method does not support resend',
      httpStatus: 400,
    });
  }
  if (metadata.resend_count >= metadata.max_resends) {
    throw new StepUpFlowError({
      error: 'resend_limit_exceeded',
      message: 'Step-up resend limit has been exceeded',
      httpStatus: 429,
      detailCode: 'resend_limit_exceeded',
      statusObject: toStatus(metadata, now),
      inputState: inputState(metadata),
    });
  }
  if (metadata.last_resend_at) {
    const availableAt = metadata.last_resend_at + metadata.resend_cooldown_seconds * 1000;
    if (availableAt > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((availableAt - now) / 1000));
      throw new StepUpFlowError({
        error: 'resend_limit_exceeded',
        message: 'Step-up resend cooldown has not elapsed',
        httpStatus: 429,
        detailCode: 'resend_limit_exceeded',
        statusObject: toStatus(metadata, now),
        inputState: {
          ...inputState(metadata),
          retry_after_seconds: retryAfterSeconds,
        },
        retryAfterSeconds,
      });
    }
  }

  const challengeValue = generateUnbiasedNumericCode(6);
  const updated: StepUpActionMetadata = {
    ...metadata,
    resend_count: metadata.resend_count + 1,
    last_resend_at: now,
    updated_at: now,
  };
  await storeAction(env, updated, challengeValue);
  return toActionResponse(updated, now);
}

export async function cancelStepUpAction(
  env: Env,
  actionId: string,
  tenantId: string,
  now: number = Date.now()
): Promise<StepUpActionResponse> {
  assertActionIdShape(actionId);
  const action = await loadActionWithChallenge(env, actionId, now, tenantId);
  if (!action) {
    throw new StepUpFlowError({
      error: 'invalid_request',
      message: 'Step-up action was not found',
      httpStatus: 404,
    });
  }
  const canceled: StepUpActionMetadata = {
    ...action.metadata,
    status: 'canceled',
    updated_at: now,
    terminal_at: now,
  };
  await storeAction(env, canceled, action.challenge);
  await clearPendingActionId(env, canceled);
  return toActionResponse(canceled, now);
}

export async function consumeStepUpReceipt(
  env: Env,
  input: ConsumeStepUpReceiptInput
): Promise<StepUpReceiptMetadata> {
  assertReceiptShape(input.receipt);
  const store = await getStore(env, input.receipt, input.tenantId);
  const challenge = (await store.getChallengeRpc(input.receipt)) as Challenge | null;
  const metadata = receiptMetadataFromChallenge(challenge);
  if (!metadata || metadata.expires_at <= Date.now()) {
    throw new StepUpFlowError({
      error: 'step_up_required',
      message: 'Step-up receipt is invalid or expired',
      httpStatus: 403,
      detailCode: 'step_up_required',
    });
  }

  const matches =
    metadata.tenantId === input.tenantId &&
    metadata.actorId === input.actorId &&
    metadata.subjectId === input.subjectId &&
    metadata.operationHash === input.operationHash &&
    (metadata.idempotencyKey ?? '') === (input.idempotencyKey ?? '');
  if (!matches) {
    throw new StepUpFlowError({
      error: 'step_up_required',
      message: 'Step-up receipt does not match this operation',
      httpStatus: 403,
      detailCode: 'step_up_required',
    });
  }

  try {
    await store.consumeChallengeRpc({
      id: input.receipt,
      tenantId: input.tenantId,
      type: STEP_UP_RECEIPT_TYPE,
      challenge: input.receipt,
    });
  } catch {
    throw new StepUpFlowError({
      error: 'step_up_required',
      message: 'Step-up receipt has already been used',
      httpStatus: 403,
      detailCode: 'step_up_required',
    });
  }

  return metadata;
}

function generateUnbiasedNumericCode(digits: number): string {
  const max = 10 ** digits;
  const limit = Math.floor(0x100000000 / max) * max;
  const value = new Uint32Array(1);

  while (true) {
    crypto.getRandomValues(value);
    const candidate = value[0]!;
    if (candidate < limit) {
      return String(candidate - Math.floor(candidate / max) * max).padStart(digits, '0');
    }
  }
}
