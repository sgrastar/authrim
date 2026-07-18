import type {
  AgentActorContext,
  AgentAccessSettings,
  AgentAuditEvent,
  AgentAuthorizationDecision,
  AgentGrantContract,
  AgentManagementIdempotencyLookup,
  AgentManagementIdempotencyStatus,
  AgentResourceRequestContext,
  AgentToolDefinition,
  AgentBulkChildCapabilityBinding,
  AgentConfigurationPlanStepDefinition,
  AgentConfigurationSchemaValidator,
  JsonObject,
  JsonValue,
} from '../core';

/** Reads current owner state for declarative Baseline evaluation. */
export interface AgentConfigurationStateReaderPort {
  readCurrent(input: {
    tenantId: string;
    step: AgentConfigurationPlanStepDefinition;
  }): Promise<JsonObject | null>;
}

export interface AgentConfigurationResourceSubject {
  tenantId: string;
  grantId: string;
  grantGeneration: number;
  consentVersion: number;
  actorSub: string;
  clientId: string;
}

/** Reads allowlisted dynamic MCP representations without exposing database access to protocol. */
export interface AgentConfigurationResourceReaderPort {
  readTenantSummary(subject: AgentConfigurationResourceSubject): Promise<JsonObject | null>;
  readPlan(subject: AgentConfigurationResourceSubject, planId: string): Promise<JsonObject | null>;
}

export interface AgentSessionRecord {
  id: string;
  tenantId: string;
  grantId: string;
  actorSub: string;
  clientId: string;
  consentVersion: number;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
}

export interface AgentSessionStorePort {
  get(sessionId: string): Promise<AgentSessionRecord | null>;
  put(record: AgentSessionRecord): Promise<void>;
  touch(sessionId: string, lastActiveAt: number): Promise<boolean>;
  delete(sessionId: string): Promise<void>;
}

export interface AgentProtocolEvent {
  id: string;
  sessionId: string;
  event: string;
  data: JsonValue;
  createdAt: number;
}

export interface AgentEventStorePort {
  append(event: AgentProtocolEvent): Promise<void>;
  listAfter(sessionId: string, lastEventId: string | undefined): Promise<AgentProtocolEvent[]>;
  purgeSession(sessionId: string): Promise<void>;
}

export interface AgentScheduledJob {
  id: string;
  kind: string;
  runAt: number;
  payload: JsonObject;
}

export interface AgentSchedulerPort {
  schedule(job: AgentScheduledJob): Promise<void>;
  cancel(jobId: string): Promise<void>;
}

/** Resolves the canonical public issuer origin for a concrete tenant. */
export interface AgentTenantIssuerPort {
  getIssuerOrigin(tenantId: string): string;
}

export interface ManagementOperationRequest {
  operation: string;
  tenantId: string;
  authorization: {
    actor: AgentActorContext;
    grantId: string;
    grantGeneration: number;
    delegatorId: string;
    consentVersion: number;
    effectivePermissions: readonly string[];
    audience: 'authrim:admin-api';
    /** Verified public origin used to bind the internal token issuer and target tenant. */
    issuerOrigin: string;
    correlationId: string;
  };
  idempotencyKey?: string;
  input: JsonObject;
}

export interface ManagementOperationResult {
  status: number;
  body: JsonValue;
  requestId?: string;
  executionStatus?: 'definite' | 'indeterminate';
}

export interface ManagementApiPort {
  /** Mints/obtains the internal downscope token and invokes the typed owner operation. */
  execute(request: ManagementOperationRequest): Promise<ManagementOperationResult>;
}

export interface AgentBulkChildOperationRequest {
  binding: AgentBulkChildCapabilityBinding;
  childCapabilityDigest: string;
  issuerOrigin: string;
  correlationId: string;
  operation: string;
  input: JsonObject;
  idempotencyKey: string;
}

/** Issues a single-tenant child credential and invokes one allowlisted owner operation. */
export interface AgentBulkChildExecutorPort {
  execute(request: AgentBulkChildOperationRequest): Promise<ManagementOperationResult>;
}

export interface AgentConfigurationOperationRequest {
  operation: string;
  actor: AgentActorContext;
  grant: AgentGrantContract;
  issuerOrigin: string;
  correlationId: string;
  input: JsonObject;
}

export interface AgentConfigurationOperationResult {
  status: number;
  body: JsonValue;
  executionStatus?: 'definite' | 'indeterminate';
  urlElicitation?: {
    elicitationId: string;
    url: string;
    message: string;
  };
}

/** Platform-owned Plan persistence/orchestration behind protocol-neutral MCP tools. */
export interface AgentConfigurationPlanPort {
  execute(request: AgentConfigurationOperationRequest): Promise<AgentConfigurationOperationResult>;
}

/** Platform-owned cross-tenant Bulk Plan lifecycle behind protocol-neutral MCP tools. */
export interface AgentBulkPlanPort {
  execute(request: AgentConfigurationOperationRequest): Promise<AgentConfigurationOperationResult>;
}

/** Platform-owned diagnostics across the public issuer and its fixed runtime services. */
export interface AgentRuntimeDiagnosticsPort {
  inspect(request: AgentConfigurationOperationRequest): Promise<AgentConfigurationOperationResult>;
}

/** Target-side durable execution status used by stale elevation recovery. */
export interface ManagementIdempotencyStatusPort {
  lookup(input: AgentManagementIdempotencyLookup): Promise<AgentManagementIdempotencyStatus>;
}

export interface SecretKeyProviderPort {
  getSigningKey(keyId: string): Promise<CryptoKey>;
  getEncryptionKey(keyId: string): Promise<CryptoKey>;
}

export interface AgentRateLimitRequest {
  key: string;
  limit: number;
  windowSeconds: number;
  cost?: number;
}

export interface AgentRateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export interface AgentRateLimiterPort {
  consume(request: AgentRateLimitRequest): Promise<AgentRateLimitResult>;
}

/** Live tenant policy lookup. Implementations must reject unavailable or malformed stores. */
export interface AgentSettingsPort {
  get(tenantId: string): Promise<AgentAccessSettings>;
}

export interface AgentRefreshFamilyRevocationRequest {
  tenantId: string;
  clientId: string;
  familyId: string;
  /** Stable shard locator captured when the family was created; not assumed to be current. */
  familyJti: string;
  reason: string;
}

export interface AgentRefreshFamilyRevokerPort {
  revoke(request: AgentRefreshFamilyRevocationRequest): Promise<void>;
}

export interface AgentClockPort {
  now(): number;
}

export interface AgentIdGeneratorPort {
  generate(prefix: string): string;
}

export interface AgentAuditPort {
  write(event: AgentAuditEvent): Promise<void>;
}

export interface AgentAuthorizationPort {
  authorize(input: {
    actor: AgentActorContext;
    grant: AgentGrantContract;
    tool: AgentToolDefinition;
    resource: AgentResourceRequestContext;
    elevationCapabilityValid?: boolean;
  }): Promise<AgentAuthorizationDecision>;
}

export interface AgentElevationResolutionRequest {
  actor: AgentActorContext;
  grant: AgentGrantContract;
  tool: AgentToolDefinition;
  resource: AgentResourceRequestContext;
  input: JsonObject;
  challengeId?: string;
  issuerOrigin: string;
  correlationId: string;
}

export type AgentElevationResolution =
  | {
      status: 'required';
      challengeId: string;
      url: string;
      message: string;
      expiresAt: number;
    }
  | {
      status: 'authorized';
      challengeId: string;
      executionAttempt: number;
      executionFence: number;
      /** Opaque adapter-owned claim token; never sent to the MCP client. */
      executionToken: string;
      idempotencyKey: string;
    };

export interface AgentElevationCompletion {
  tenantId: string;
  challengeId: string;
  executionAttempt: number;
  executionFence: number;
  executionToken: string;
  status: 'consumed' | 'failed' | 'indeterminate';
  result?: JsonValue;
  correlationId: string;
}

/**
 * Operation-bound elevation lifecycle. Implementations own challenge persistence, encrypted
 * payloads, approval transport, execution leases, and terminal fencing.
 */
export interface AgentElevationPort {
  resolve(request: AgentElevationResolutionRequest): Promise<AgentElevationResolution>;
  complete(completion: AgentElevationCompletion): Promise<boolean>;
}

export interface AgentJsonSchemaValidationResult {
  valid: boolean;
  errorMessage?: string;
}

export interface AgentJsonSchemaValidatorPort extends AgentConfigurationSchemaValidator {
  validate(schema: JsonObject, input: JsonValue): AgentJsonSchemaValidationResult;
}
