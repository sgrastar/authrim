import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const PHASE1_SCHEMA_VERSION = 1 as const;
export const PHASE1_EXECUTION_CONFIRMATION = 'AUTHRIM_PHASE1_DISPOSABLE_SCALE_OUT';

export type Phase1ProfileName = 'smoke' | 'standard' | 'main' | 'custom';

export interface Phase1HarnessConfig {
  schemaVersion: 1;
  profile: Phase1ProfileName;
  environment: {
    environmentId: string;
    baseUrl: string;
    tenantId: string;
    placementPolicy: 'shared_pool' | 'tenant_exclusive';
    disposable: true;
    executionConfirmation: typeof PHASE1_EXECUTION_CONFIRMATION;
    emailDomain: string;
    sourceCommit: string;
    controlDatabaseId: string;
  };
  credentials: {
    adminTokenEnv?: string;
    adminMachineClientIdEnv?: string;
    adminMachineKidEnv?: string;
    adminMachinePrivateJwkBase64Env?: string;
    cloudflareAccountIdEnv: string;
    cloudflareD1ReadTokenEnv: string;
    cloudflareD1WriteTokenEnv: string;
    seedEnv: string;
  };
  load: {
    accountCount: number;
    ratePerSecond: number;
    maximumInFlight: number;
    retryWindowSeconds: number;
    requestTimeoutMs: number;
  };
  expectedPolicy: {
    targetAccountCount: number;
    maxReadySpares: number;
    maxD1Resources: number;
    dailyD1CreateBudget: number;
    lookupTargetActiveRouteCount: number;
    lookupForecastHorizonSeconds: number;
    lookupEwmaAlphaBps: number;
    lookupHeadroomBps: number;
    lookupPolicyGeneration: number;
    expectedLookupRoutesPerAccount: number;
    minimumLookupAdditions: number;
    minimumLookupUsedAssignmentTransitions: number;
    minimumRoleBoundaryCrossings: number;
  };
  observation: {
    controlIntervalMs: number;
    providerIntervalMs: number;
    quiescenceTimeoutSeconds: number;
    quiescenceStableWindows: number;
  };
  attestations: {
    workersPaidPlan: true;
    scheduledTriggerLastSucceededAt: string;
    noManualInterventionFrom: string;
  };
}

export interface LogicalAccountIdentity {
  accountIndex: number;
  email: string;
  emailDigest: string;
  idempotencyKey: string;
  requestDigest: string;
}

export type RequestEventKind =
  | 'scheduled'
  | 'attempt'
  | 'accepted_201'
  | 'accepted_202'
  | 'capacity_503'
  | 'server_5xx'
  | 'retry_scheduled'
  | 'operation_poll'
  | 'succeeded'
  | 'terminal_failure';

export interface Phase1RequestEvent {
  schemaVersion: 1;
  kind: RequestEventKind;
  at: string;
  runId: string;
  accountIndex: number;
  emailDigest: string;
  requestDigest: string;
  attempt: number;
  status?: number;
  latencyMs?: number;
  retryAt?: string;
  operationId?: string;
  statusPathDigest?: string;
  userId?: string;
  errorCode?: string;
}

export interface Phase1ControlSnapshot {
  schemaVersion: 1;
  observedAt: string;
  environment: Record<string, unknown> | null;
  resourcePolicy: Record<string, unknown> | null;
  tenantPolicy: Record<string, unknown> | null;
  residencyPartitions: Record<string, unknown>[];
  shardCapacities: Record<string, unknown>[];
  tenantAssignments: Record<string, unknown>[];
  tenantAllocations: Record<string, unknown>[];
  operations: Record<string, unknown>[];
  operationSteps: Record<string, unknown>[];
  desiredResources: Record<string, unknown>[];
  observedResources: Record<string, unknown>[];
  lookupForecasts: Record<string, unknown>[];
  lookupShards: Record<string, unknown>[];
  lookupAssignments: Record<string, unknown>[];
  workerBindingDrift: Record<string, unknown>[];
}

export interface Phase1ProviderDatabase {
  uuid: string;
  name: string;
  createdAt: string | null;
  fileSize: number | null;
}

export interface Phase1ProviderSnapshot {
  schemaVersion: 1;
  observedAt: string;
  databases: Phase1ProviderDatabase[];
}

export interface Phase1LookupBucketSnapshotRow {
  virtualBucket: number;
  lookupShardId: string;
  databaseId: string;
  assignmentGeneration: number;
  successfulRoutePublicationCount: number;
  activeRouteCount: number;
}

export interface Phase1Baseline {
  schemaVersion: 1;
  runId: string;
  capturedAt: string;
  sourceCommit: string;
  control: Phase1ControlSnapshot;
  provider: Phase1ProviderSnapshot;
  lookupBuckets: Phase1LookupBucketSnapshotRow[];
  preflight: {
    passed: boolean;
    checks: Array<{ name: string; passed: boolean; detail: string }>;
    expectedMinimumD1Creates: number;
  };
}

export interface Phase1IntegrityResult {
  schemaVersion: 1;
  runId: string;
  verifiedAt: string;
  submittedAccounts: number;
  succeededAccounts: number;
  uniqueUserIds: number;
  terminalFailures: number;
  lostAccounts: number;
  duplicateCoreAccounts: number;
  duplicatePiiAccounts: number;
  lookupRouteMismatches: number;
  crossTenantWrites: number;
  orphanD1Resources: number;
  resourceMappingMismatches: number;
  pendingAccountOperations: number;
  pendingRoutingOutbox: number;
  blockedCapacityOperations: number;
  duplicateProvisioningDecisions: number;
  publicationCounterDecreases: number;
  publicationCounterDeltaMismatches: number;
  lookupForecastMismatches: number;
  controlPhysicalCountMismatches: number;
  allocationMismatches: number;
  fieldLevelMismatches: number;
  coreBoundaryCrossings: number;
  piiBoundaryCrossings: number;
  corePhysicalAdditions: number;
  piiPhysicalAdditions: number;
  excessCoreProvisioning: number;
  excessPiiProvisioning: number;
  lookupPhysicalAdditions: number;
  lookupUsedAssignmentTransitions: number;
  provisionedD1Resources: number;
  manualIntervention: number;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  passed: boolean;
}

export interface Phase1LookupForecastDecisionEvidence {
  observedAt: string;
  decisionGeneration: number | null;
  observedActiveRouteCount: number | null;
  observedSuccessfulPublicationCount: number | null;
  sampleRateMicrorowsPerSecond: number | null;
  ewmaRateMicrorowsPerSecond: number | null;
  forecastHorizonSeconds: number | null;
  forecastNewRouteCount: number | null;
  projectedActiveRouteCount: number | null;
  usableCapacityRouteCount: number | null;
}

export interface Phase1ProvisioningEventEvidence {
  desiredResourceId: string;
  operationId: string | null;
  dataRole: string;
  deterministicName: string;
  decisionAt: string;
  readyAt: string | null;
  decisionToReadyMs: number | null;
  timingSource: 'control_state' | 'observer';
  lookupForecast: Phase1LookupForecastDecisionEvidence | null;
}

export interface Phase1ProvisioningEvidence {
  events: Phase1ProvisioningEventEvidence[];
  readyLatencyMs: {
    count: number;
    minimum: number | null;
    p50: number | null;
    p95: number | null;
    maximum: number | null;
    mean: number | null;
  };
}

export interface Phase1Summary {
  schemaVersion: 1;
  runId: string;
  profile: Phase1ProfileName;
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  metrics: {
    scheduled: number;
    attempts: number;
    accepted201: number;
    accepted202: number;
    capacity503: number;
    server5xx: number;
    retries: number;
    terminalFailures: number;
    eventualSuccessRate: number;
    immediate201Rate: number;
  };
  provisioning: Phase1ProvisioningEvidence;
  integrity: Phase1IntegrityResult;
}

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,127}$/u;
const HEX = /^[a-f0-9]+$/u;
const FORBIDDEN_KEY =
  /(?:^|_)(?:authorization|cookie|email|password|secret|seed|token|private_key|client_secret)(?:$|_)/iu;
const FORBIDDEN_VALUE = /(?:bearer\s+|-----BEGIN [A-Z ]+PRIVATE KEY-----)/iu;
const SAFE_METADATA_KEYS = new Set(['provisioning_token_ownership']);

function record(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function string(value: unknown, error: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(error);
  return value.trim();
}

function integer(value: unknown, minimum: number, maximum: number, error: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(error);
  }
  return value as number;
}

function booleanTrue(value: unknown, error: string): true {
  if (value !== true) throw new Error(error);
  return true;
}

function isoDate(value: unknown, error: string): string {
  const normalized = string(value, error);
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== normalized)
    throw new Error(error);
  return normalized;
}

function url(value: unknown, error: string): string {
  const normalized = string(value, error);
  const parsed = new URL(normalized);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(error);
  }
  return parsed.toString();
}

export function parsePhase1HarnessConfig(value: unknown): Phase1HarnessConfig {
  const root = record(value, 'phase1_config_invalid');
  if (root.schemaVersion !== PHASE1_SCHEMA_VERSION)
    throw new Error('phase1_config_version_invalid');
  const profile = string(root.profile, 'phase1_profile_invalid');
  if (profile !== 'smoke' && profile !== 'standard' && profile !== 'main' && profile !== 'custom') {
    throw new Error('phase1_profile_invalid');
  }
  const environment = record(root.environment, 'phase1_environment_invalid');
  const credentials = record(root.credentials, 'phase1_credentials_invalid');
  const load = record(root.load, 'phase1_load_invalid');
  const expectedPolicy = record(root.expectedPolicy, 'phase1_expected_policy_invalid');
  const observation = record(root.observation, 'phase1_observation_invalid');
  const attestations = record(root.attestations, 'phase1_attestations_invalid');
  const environmentId = string(environment.environmentId, 'phase1_environment_id_invalid');
  const tenantId = string(environment.tenantId, 'phase1_tenant_id_invalid');
  const placementPolicy = string(environment.placementPolicy, 'phase1_placement_policy_invalid');
  if (placementPolicy !== 'shared_pool' && placementPolicy !== 'tenant_exclusive') {
    throw new Error('phase1_placement_policy_invalid');
  }
  if (!SAFE_ID.test(environmentId) || !SAFE_ID.test(tenantId)) {
    throw new Error('phase1_environment_or_tenant_id_invalid');
  }
  if (/(?:^|[-_.])(prod|production)(?:$|[-_.])/iu.test(environmentId)) {
    throw new Error('phase1_production_environment_rejected');
  }
  const emailDomain = string(environment.emailDomain, 'phase1_email_domain_invalid').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]{1,251})[a-z0-9]$/u.test(emailDomain)) {
    throw new Error('phase1_email_domain_invalid');
  }
  const sourceCommit = string(environment.sourceCommit, 'phase1_source_commit_invalid');
  if (!HEX.test(sourceCommit) || sourceCommit.length < 7 || sourceCommit.length > 64) {
    throw new Error('phase1_source_commit_invalid');
  }
  const envName = (key: string): string => {
    const name = string(credentials[key], `phase1_${key}_invalid`);
    if (!ENV_NAME.test(name)) throw new Error(`phase1_${key}_invalid`);
    return name;
  };
  const optionalEnvName = (key: string): string | undefined => {
    if (credentials[key] === undefined) return undefined;
    return envName(key);
  };
  const adminTokenEnv = optionalEnvName('adminTokenEnv');
  const adminMachineClientIdEnv = optionalEnvName('adminMachineClientIdEnv');
  const adminMachineKidEnv = optionalEnvName('adminMachineKidEnv');
  const adminMachinePrivateJwkBase64Env = optionalEnvName('adminMachinePrivateJwkBase64Env');
  const machineCredentialCount = [
    adminMachineClientIdEnv,
    adminMachineKidEnv,
    adminMachinePrivateJwkBase64Env,
  ].filter(Boolean).length;
  if (
    (!adminTokenEnv && machineCredentialCount === 0) ||
    (machineCredentialCount > 0 && machineCredentialCount < 3)
  ) {
    throw new Error('phase1_admin_auth_configuration_invalid');
  }
  const parsed: Phase1HarnessConfig = {
    schemaVersion: PHASE1_SCHEMA_VERSION,
    profile,
    environment: {
      environmentId,
      baseUrl: url(environment.baseUrl, 'phase1_base_url_invalid'),
      tenantId,
      placementPolicy,
      disposable: booleanTrue(environment.disposable, 'phase1_disposable_environment_required'),
      executionConfirmation:
        string(environment.executionConfirmation, 'phase1_execution_confirmation_required') ===
        PHASE1_EXECUTION_CONFIRMATION
          ? PHASE1_EXECUTION_CONFIRMATION
          : (() => {
              throw new Error('phase1_execution_confirmation_invalid');
            })(),
      emailDomain,
      sourceCommit,
      controlDatabaseId: string(
        environment.controlDatabaseId,
        'phase1_control_database_id_invalid'
      ),
    },
    credentials: {
      ...(adminTokenEnv ? { adminTokenEnv } : {}),
      ...(adminMachineClientIdEnv ? { adminMachineClientIdEnv } : {}),
      ...(adminMachineKidEnv ? { adminMachineKidEnv } : {}),
      ...(adminMachinePrivateJwkBase64Env ? { adminMachinePrivateJwkBase64Env } : {}),
      cloudflareAccountIdEnv: envName('cloudflareAccountIdEnv'),
      cloudflareD1ReadTokenEnv: envName('cloudflareD1ReadTokenEnv'),
      cloudflareD1WriteTokenEnv: envName('cloudflareD1WriteTokenEnv'),
      seedEnv: envName('seedEnv'),
    },
    load: {
      accountCount: integer(load.accountCount, 1, 10_000_000, 'phase1_account_count_invalid'),
      ratePerSecond: integer(load.ratePerSecond, 1, 10_000, 'phase1_rate_invalid'),
      maximumInFlight: integer(load.maximumInFlight, 1, 1_000, 'phase1_in_flight_invalid'),
      retryWindowSeconds: integer(
        load.retryWindowSeconds,
        1,
        86_400,
        'phase1_retry_window_invalid'
      ),
      requestTimeoutMs: integer(
        load.requestTimeoutMs,
        100,
        120_000,
        'phase1_request_timeout_invalid'
      ),
    },
    expectedPolicy: {
      targetAccountCount: integer(
        expectedPolicy.targetAccountCount,
        1,
        10_000_000,
        'phase1_target_account_count_invalid'
      ),
      maxReadySpares: integer(expectedPolicy.maxReadySpares, 1, 32, 'phase1_ready_spares_invalid'),
      maxD1Resources: integer(
        expectedPolicy.maxD1Resources,
        1,
        100_000,
        'phase1_max_d1_resources_invalid'
      ),
      dailyD1CreateBudget: integer(
        expectedPolicy.dailyD1CreateBudget,
        0,
        100_000,
        'phase1_daily_d1_budget_invalid'
      ),
      lookupTargetActiveRouteCount: integer(
        expectedPolicy.lookupTargetActiveRouteCount,
        1,
        100_000_000,
        'phase1_lookup_target_invalid'
      ),
      lookupForecastHorizonSeconds: integer(
        expectedPolicy.lookupForecastHorizonSeconds,
        300,
        2_592_000,
        'phase1_lookup_horizon_invalid'
      ),
      lookupEwmaAlphaBps: integer(
        expectedPolicy.lookupEwmaAlphaBps,
        1,
        10_000,
        'phase1_lookup_alpha_invalid'
      ),
      lookupHeadroomBps: integer(
        expectedPolicy.lookupHeadroomBps,
        0,
        9_000,
        'phase1_lookup_headroom_invalid'
      ),
      lookupPolicyGeneration: integer(
        expectedPolicy.lookupPolicyGeneration,
        1,
        1_000_000,
        'phase1_lookup_policy_generation_invalid'
      ),
      expectedLookupRoutesPerAccount: integer(
        expectedPolicy.expectedLookupRoutesPerAccount,
        1,
        32,
        'phase1_lookup_routes_per_account_invalid'
      ),
      minimumLookupAdditions: integer(
        expectedPolicy.minimumLookupAdditions,
        0,
        10_000,
        'phase1_lookup_additions_invalid'
      ),
      minimumLookupUsedAssignmentTransitions: integer(
        expectedPolicy.minimumLookupUsedAssignmentTransitions,
        0,
        4_096,
        'phase1_lookup_transitions_invalid'
      ),
      minimumRoleBoundaryCrossings: integer(
        expectedPolicy.minimumRoleBoundaryCrossings,
        0,
        10_000,
        'phase1_role_boundaries_invalid'
      ),
    },
    observation: {
      controlIntervalMs: integer(
        observation.controlIntervalMs,
        250,
        300_000,
        'phase1_control_interval_invalid'
      ),
      providerIntervalMs: integer(
        observation.providerIntervalMs,
        250,
        300_000,
        'phase1_provider_interval_invalid'
      ),
      quiescenceTimeoutSeconds: integer(
        observation.quiescenceTimeoutSeconds,
        1,
        86_400,
        'phase1_quiescence_timeout_invalid'
      ),
      quiescenceStableWindows: integer(
        observation.quiescenceStableWindows,
        1,
        100,
        'phase1_quiescence_windows_invalid'
      ),
    },
    attestations: {
      workersPaidPlan: booleanTrue(
        attestations.workersPaidPlan,
        'phase1_workers_paid_attestation_required'
      ),
      scheduledTriggerLastSucceededAt: isoDate(
        attestations.scheduledTriggerLastSucceededAt,
        'phase1_scheduled_trigger_attestation_invalid'
      ),
      noManualInterventionFrom: isoDate(
        attestations.noManualInterventionFrom,
        'phase1_manual_intervention_attestation_invalid'
      ),
    },
  };
  if (
    parsed.credentials.cloudflareD1ReadTokenEnv === parsed.credentials.cloudflareD1WriteTokenEnv
  ) {
    throw new Error('phase1_d1_tokens_must_be_separate');
  }
  if (parsed.load.maximumInFlight < parsed.load.ratePerSecond) {
    throw new Error('phase1_in_flight_below_arrival_rate');
  }
  if (parsed.load.retryWindowSeconds < parsed.observation.quiescenceTimeoutSeconds) {
    throw new Error('phase1_retry_window_below_quiescence_timeout');
  }
  if (profile === 'smoke' && parsed.load.accountCount !== 1_000) {
    throw new Error('phase1_smoke_account_count_mismatch');
  }
  if (profile === 'standard' && parsed.load.accountCount !== 5_000) {
    throw new Error('phase1_standard_account_count_mismatch');
  }
  if (profile === 'main' && parsed.load.accountCount !== 50_000) {
    throw new Error('phase1_main_account_count_mismatch');
  }
  return parsed;
}

export function resolvePhase1Secret(
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`phase1_required_environment_value_missing:${name}`);
  return value;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function deriveLogicalAccountIdentity(input: {
  seed: string;
  runId: string;
  accountIndex: number;
  emailDomain: string;
}): LogicalAccountIdentity {
  if (!Number.isSafeInteger(input.accountIndex) || input.accountIndex < 0) {
    throw new Error('phase1_account_index_invalid');
  }
  const digest = createHmac('sha256', input.seed)
    .update(`${input.runId}:${input.accountIndex}`)
    .digest('hex');
  const email = `phase1-${digest.slice(0, 32)}@${input.emailDomain}`;
  const idempotencyKey = `phase1:${input.runId}:${input.accountIndex}:${digest.slice(32, 48)}`;
  const requestBody = JSON.stringify({
    email,
    preferred_username: `phase1-${sha256(email).slice(0, 24)}`,
    email_verified: true,
    user_type: 'end_user',
  });
  return {
    accountIndex: input.accountIndex,
    email,
    emailDigest: sha256(email),
    idempotencyKey,
    requestDigest: sha256(requestBody),
  };
}

export function stableJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)])
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

export function assertPhase1EvidenceIsSecretFree(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    if (FORBIDDEN_VALUE.test(value) || /^[^\s@]+@[^\s@]+$/u.test(value)) {
      throw new Error(`phase1_evidence_sensitive_value:${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPhase1EvidenceIsSecretFree(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key) && !SAFE_METADATA_KEYS.has(key)) {
      throw new Error(`phase1_evidence_sensitive_key:${path}.${key}`);
    }
    assertPhase1EvidenceIsSecretFree(child, `${path}.${key}`);
  }
}

export function redactPhase1Config(config: Phase1HarnessConfig): Record<string, unknown> {
  const redacted = {
    ...config,
    environment: { ...config.environment },
    credentials: {
      source: 'environment',
      variableNames: Object.values(config.credentials),
    },
  };
  assertPhase1EvidenceIsSecretFree(redacted);
  return redacted;
}

export function equalDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
