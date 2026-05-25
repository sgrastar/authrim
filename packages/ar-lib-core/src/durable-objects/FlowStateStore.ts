/**
 * FlowStateStore - Durable Object
 *
 * Responsibilities (strictly limited):
 * - RuntimeState storage
 * - mutual exclusion control (prevents concurrent requests for the same session)
 * - TTL management (automatic deletion of expired state)
 * - requestIdduplicate detection (idempotency)
 *
 * Out of scope (handled on the Worker side):
 * - PolicyResolver
 * - UIContractGenerator
 * - CapabilityResolver
 *
 * @see /private/docs/track-c-flow-engine-design.md
 */

import type { DurableObjectState } from '@cloudflare/workers-types';

// =============================================================================
// Types (Flow Engine specific)
// =============================================================================

/** OAuth Flow parameters */
export interface OAuthFlowParams {
  state?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: 'plain' | 'S256';
  redirect_uri?: string;
  scope?: string;
  response_type?: string;
  response_mode?: string;
  acr_values?: string;
  max_age?: number;
  ui_locales?: string;
  prompt?: string;
  login_hint?: string;
  claims?: string;
}

/** RuntimeState - Layer 3: for DO storage */
export interface RuntimeState {
  /** Session ID */
  sessionId: string;
  /** FlowID (which flow is executing) */
  flowId: string;
  /** FlowType ('login' | 'authorization' | 'consent' | 'logout') */
  flowType: string;
  /** Tenant ID */
  tenantId: string;
  /** Client ID */
  clientId: string;
  /** Current node ID */
  currentNodeId: string;
  /** Visited node ID array */
  visitedNodeIds: string[];
  /** Collected data (capabilityId → response data) */
  collectedData: Record<string, unknown>;
  /** Completed capabilityId array */
  completedCapabilities: string[];
  /** OAuthparameters (PKCE, etc.) */
  oauthParams?: OAuthFlowParams;
  /** Authenticated user ID (set after authentication completes) */
  userId?: string;
  /** Flow start time (Unix ms) */
  startedAt: number;
  /** Flow expiration time (Unix ms) */
  expiresAt: number;
  /** Last activity time (Unix ms) */
  lastActivityAt: number;
  /** Recent request timestamps for per-session rate limiting */
  requestTimestamps: number[];
  /** Processed requestId → snapshot (for idempotency) */
  processedRequestIds: Record<string, RuntimeStateSnapshot>;
}

/** RuntimeState snapshot (for idempotency) */
export interface RuntimeStateSnapshot {
  /** Request ID */
  requestId: string;
  /** Processed at (Unix ms) */
  processedAt: number;
  /** Result node ID */
  resultNodeId: string;
  /** Result data */
  resultData: FlowSubmitResult;
}

/** Result of processing a capability response */
export type FlowSubmitResult =
  | {
      type: 'continue';
      uiContract: unknown;
    }
  | {
      type: 'redirect';
      redirect: { url: string; method?: string };
    }
  | {
      type: 'error';
      error: { code: string; message: string };
    };

/** RuntimeState creation parameters */
export interface CreateRuntimeStateParams {
  /** Session ID */
  sessionId: string;
  /** FlowID */
  flowId: string;
  /** FlowType ('login' | 'authorization' | 'consent' | 'logout') */
  flowType: string;
  /** Tenant ID */
  tenantId: string;
  /** Client ID */
  clientId: string;
  /** Entry node ID */
  entryNodeId: string;
  /** TTL (milliseconds) */
  ttlMs?: number;
  /** OAuthparameters */
  oauthParams?: OAuthFlowParams;
}

/** Default Flow TTL (15 minutes) */
export const DEFAULT_FLOW_TTL_MS = 15 * 60 * 1000;

/** Maximum number of requestIds to retain for idempotency */
export const MAX_PROCESSED_REQUEST_IDS = 100;

// =============================================================================
// FlowStateStore Durable Object
// =============================================================================

/**
 * FlowStateStore Durable Object
 *
 * Durable Objects serialize requests for the same ID,,
 * so mutual exclusion for concurrent requests is handled automatically..
 */
export class FlowStateStore {
  private state: DurableObjectState;
  private runtimeState: RuntimeState | null = null;
  private initialized = false;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  /**
   * HTTP request handler
   * All requests to the DO pass through here
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;

    try {
      // Initialize (if needed)
      if (!this.initialized) {
        await this.loadState();
      }

      // Routing
      switch (`${method} ${pathname}`) {
        case 'POST /init':
          return await this.handleInit(request);
        case 'POST /submit':
          return await this.handleSubmit(request);
        case 'POST /check-request':
          return await this.handleCheckRequest(request);
        case 'GET /state':
          return await this.handleGetState(request);
        case 'DELETE /cancel':
          return await this.handleCancel(request);
        default:
          return new Response(JSON.stringify({ error: 'Not Found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // =============================================================================
  // Handler Methods
  // =============================================================================

  /**
   * POST /init - RuntimeState initialization
   */
  private async handleInit(request: Request): Promise<Response> {
    const params = (await request.json()) as CreateRuntimeStateParams;
    const validationError = this.validateInitRequest(request, params);
    if (validationError) {
      return validationError;
    }

    // Error when existing state is present
    if (this.runtimeState) {
      return new Response(
        JSON.stringify({
          error: 'Session already exists',
          code: 'session_exists',
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Create RuntimeState
    const now = Date.now();
    this.runtimeState = {
      sessionId: params.sessionId,
      flowId: params.flowId,
      flowType: params.flowType,
      tenantId: params.tenantId,
      clientId: params.clientId,
      currentNodeId: params.entryNodeId,
      visitedNodeIds: [params.entryNodeId],
      collectedData: {},
      completedCapabilities: [],
      oauthParams: params.oauthParams,
      startedAt: now,
      expiresAt: now + (params.ttlMs || DEFAULT_FLOW_TTL_MS),
      lastActivityAt: now,
      requestTimestamps: [],
      processedRequestIds: {},
    };

    // Persist
    await this.saveState();

    // Set TTL alarm
    await this.state.storage.setAlarm(this.runtimeState.expiresAt);

    return new Response(JSON.stringify({ success: true, state: this.getPublicState() }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * POST /submit - capability responseprocessing
   * idempotency: Detect duplicates with sessionId + requestId
   */
  private async handleSubmit(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      requestId: string;
      capabilityId: string;
      response: unknown;
      // Result calculated on the Worker side
      result: FlowSubmitResult;
      nextNodeId: string;
      requestTimestamps?: number[];
    };

    // State check
    if (!this.runtimeState) {
      return new Response(
        JSON.stringify({
          error: 'Session not found',
          code: 'session_not_found',
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const validationError = this.validateRuntimeRequest(request);
    if (validationError) {
      return validationError;
    }

    // Expiration check
    if (Date.now() > this.runtimeState.expiresAt) {
      return new Response(
        JSON.stringify({
          error: 'Session expired',
          code: 'session_expired',
        }),
        { status: 410, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Idempotency check
    const existingSnapshot = this.runtimeState.processedRequestIds[body.requestId];
    if (existingSnapshot) {
      // Resent same requestId → return the previous result
      return new Response(JSON.stringify(existingSnapshot.resultData), {
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotent': 'true',
        },
      });
    }

    // Update state
    const now = Date.now();
    this.runtimeState.currentNodeId = body.nextNodeId;
    this.runtimeState.visitedNodeIds.push(body.nextNodeId);
    this.runtimeState.collectedData[body.capabilityId] = body.response;
    this.runtimeState.completedCapabilities.push(body.capabilityId);
    this.runtimeState.lastActivityAt = now;
    if (Array.isArray(body.requestTimestamps)) {
      this.runtimeState.requestTimestamps = body.requestTimestamps.filter(
        (timestamp): timestamp is number =>
          typeof timestamp === 'number' && Number.isFinite(timestamp)
      );
    }

    // Save idempotency snapshot
    const snapshot: RuntimeStateSnapshot = {
      requestId: body.requestId,
      processedAt: now,
      resultNodeId: body.nextNodeId,
      resultData: body.result,
    };
    this.runtimeState.processedRequestIds[body.requestId] = snapshot;

    // Delete old snapshots (do not keep more than MAX_PROCESSED_REQUEST_IDS)
    this.pruneOldSnapshots();

    // Persist
    await this.saveState();

    return new Response(JSON.stringify(body.result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * GET /state - Get current state
   */
  private async handleGetState(request: Request): Promise<Response> {
    if (!this.runtimeState) {
      return new Response(
        JSON.stringify({
          error: 'Session not found',
          code: 'session_not_found',
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const validationError = this.validateRuntimeRequest(request);
    if (validationError) {
      return validationError;
    }

    // Expiration check
    if (Date.now() > this.runtimeState.expiresAt) {
      return new Response(
        JSON.stringify({
          error: 'Session expired',
          code: 'session_expired',
        }),
        { status: 410, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ state: this.getPublicState() }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * DELETE /cancel - Session cancellation
   */
  private async handleCancel(request: Request): Promise<Response> {
    const validationError = this.validateRuntimeRequest(request, { allowMissingState: true });
    if (validationError) {
      return validationError;
    }

    if (this.runtimeState) {
      // Cancel the alarm
      await this.state.storage.deleteAlarm();

      // Clear state
      this.runtimeState = null;
      await this.state.storage.delete('runtimeState');
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * POST /check-request - Idempotency check (for pre-checking on the Worker side)
   *
   * Check whether requestId has already been processed,
   * return the cached result when it has already been processed.
   * This lets the Worker side avoid regenerating the UIContract.
   */
  private async handleCheckRequest(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      requestId: string;
    };

    // State check
    if (!this.runtimeState) {
      return new Response(
        JSON.stringify({
          error: 'Session not found',
          code: 'session_not_found',
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const validationError = this.validateRuntimeRequest(request);
    if (validationError) {
      return validationError;
    }

    // Expiration check
    if (Date.now() > this.runtimeState.expiresAt) {
      return new Response(
        JSON.stringify({
          error: 'Session expired',
          code: 'session_expired',
        }),
        { status: 410, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Idempotency check
    const existingSnapshot = this.runtimeState.processedRequestIds[body.requestId];
    if (existingSnapshot) {
      // Resent same requestId → return the previous result
      return new Response(
        JSON.stringify({
          found: true,
          result: existingSnapshot.resultData,
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Idempotent': 'true',
          },
        }
      );
    }

    // unprocessed
    return new Response(
      JSON.stringify({
        found: false,
        state: this.getPublicState(),
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // =============================================================================
  // Alarm Handler (TTL management)
  // =============================================================================

  /**
   * Alarm handler - called on expiration
   */
  async alarm(): Promise<void> {
    // Clear expired state
    this.runtimeState = null;
    await this.state.storage.delete('runtimeState');
  }

  // =============================================================================
  // Internal Methods
  // =============================================================================

  /**
   * Load state from storage
   */
  private async loadState(): Promise<void> {
    const stored = await this.state.storage.get<RuntimeState>('runtimeState');
    if (stored) {
      // Restore processedRequestIds as an object
      this.runtimeState = {
        ...stored,
        requestTimestamps: stored.requestTimestamps || [],
        processedRequestIds: stored.processedRequestIds || {},
      };
    }
    this.initialized = true;
  }

  /**
   * Save state to storage
   */
  private async saveState(): Promise<void> {
    if (this.runtimeState) {
      await this.state.storage.put('runtimeState', this.runtimeState);
    }
  }

  /**
   * Get the public state subset
   */
  private getPublicState(): {
    sessionId: string;
    flowId: string;
    flowType: string;
    tenantId: string;
    clientId: string;
    currentNodeId: string;
    visitedNodeIds: string[];
    completedCapabilities: string[];
    startedAt: number;
    expiresAt: number;
    requestTimestamps: number[];
    collectedData?: Record<string, unknown>;
    oauthParams?: OAuthFlowParams;
  } | null {
    if (!this.runtimeState) return null;

    return {
      sessionId: this.runtimeState.sessionId,
      flowId: this.runtimeState.flowId,
      flowType: this.runtimeState.flowType,
      tenantId: this.runtimeState.tenantId,
      clientId: this.runtimeState.clientId,
      currentNodeId: this.runtimeState.currentNodeId,
      visitedNodeIds: this.runtimeState.visitedNodeIds,
      completedCapabilities: this.runtimeState.completedCapabilities,
      startedAt: this.runtimeState.startedAt,
      expiresAt: this.runtimeState.expiresAt,
      requestTimestamps: this.runtimeState.requestTimestamps,
      collectedData: this.runtimeState.collectedData,
      oauthParams: this.runtimeState.oauthParams,
    };
  }

  private validateInitRequest(request: Request, params: CreateRuntimeStateParams): Response | null {
    const tenantId = this.getRequiredHeader(request, 'X-Tenant-Id', 'tenant_required');
    if (tenantId instanceof Response) {
      return tenantId;
    }

    const sessionId = this.getRequiredHeader(request, 'X-Flow-Session-Id', 'session_required');
    if (sessionId instanceof Response) {
      return sessionId;
    }

    if (!params.tenantId || params.tenantId.trim() !== tenantId) {
      return this.jsonError('Tenant mismatch', 'tenant_mismatch', 403);
    }

    if (!params.sessionId || params.sessionId.trim() !== sessionId) {
      return this.jsonError('Session mismatch', 'session_mismatch', 403);
    }

    return null;
  }

  private validateRuntimeRequest(
    request: Request,
    options: { allowMissingState?: boolean } = {}
  ): Response | null {
    const tenantId = this.getRequiredHeader(request, 'X-Tenant-Id', 'tenant_required');
    if (tenantId instanceof Response) {
      return tenantId;
    }

    const sessionId = this.getRequiredHeader(request, 'X-Flow-Session-Id', 'session_required');
    if (sessionId instanceof Response) {
      return sessionId;
    }

    if (!this.runtimeState) {
      return options.allowMissingState
        ? null
        : this.jsonError('Session not found', 'session_not_found', 404);
    }

    if (this.runtimeState.tenantId !== tenantId) {
      return this.jsonError('Tenant mismatch', 'tenant_mismatch', 403);
    }

    if (this.runtimeState.sessionId !== sessionId) {
      return this.jsonError('Session mismatch', 'session_mismatch', 403);
    }

    return null;
  }

  private getRequiredHeader(request: Request, headerName: string, code: string): string | Response {
    const value = request.headers.get(headerName)?.trim();
    if (!value) {
      return this.jsonError(`${headerName} header is required`, code, 400);
    }
    return value;
  }

  private jsonError(error: string, code: string, status: number): Response {
    return new Response(JSON.stringify({ error, code }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Delete old idempotency snapshots
   */
  private pruneOldSnapshots(): void {
    if (!this.runtimeState) return;

    const requestIds = Object.keys(this.runtimeState.processedRequestIds);
    if (requestIds.length <= MAX_PROCESSED_REQUEST_IDS) return;

    // Sort by processedAt and delete the oldest items
    const sorted = requestIds.sort((a, b) => {
      const aTime = this.runtimeState!.processedRequestIds[a].processedAt;
      const bTime = this.runtimeState!.processedRequestIds[b].processedAt;
      return aTime - bTime;
    });

    const toDelete = sorted.slice(0, requestIds.length - MAX_PROCESSED_REQUEST_IDS);
    for (const id of toDelete) {
      delete this.runtimeState.processedRequestIds[id];
    }
  }
}

// =============================================================================
// Export
// =============================================================================

export default FlowStateStore;
