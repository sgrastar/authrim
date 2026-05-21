/**
 * FlowExecutor - Flow Engine core
 *
 * Responsibilities:
 * - Flow initialization (/init)
 * - capability responseprocessing (/submit)
 * - stateget (/state)
 * - Flow cancellation (/cancel)
 * - FlowStateStore DO integration
 *
 * @see /private/docs/track-c-flow-engine-design.md
 */

import { type Env, getFlowStateStoreStub } from '@authrim/ar-lib-core';
import type {
  FlowInitRequest,
  FlowInitResponse,
  FlowSubmitRequest,
  FlowSubmitResponse,
  FlowStateResponse,
  CompiledPlan,
  CompiledNode,
  OAuthFlowParams,
  DecisionNodeConfig,
  SwitchNodeConfig,
  FlowRuntimeContext,
} from './types';
import { DEFAULT_FLOW_TTL_MS } from './types';
import { FlowRegistry, createFlowRegistry, type FlowType } from './flow-registry';
import { createFlowCompiler, type FlowCompilerService } from './flow-compiler';
import { UIContractGenerator, createUIContractGenerator } from './ui-contract-generator';
import { evaluate } from './condition-evaluator';

// =============================================================================
// Types
// =============================================================================

/**
 * FlowExecutoroptions
 */
export interface FlowExecutorOptions {
  /** sessionTTL (milliseconds) */
  ttlMs?: number;
}

/**
 * DOInitializeresponse
 */
interface DOInitResponse {
  success: boolean;
  state?: {
    sessionId: string;
    flowId: string;
    currentNodeId: string;
    visitedNodeIds: string[];
    completedCapabilities: string[];
    expiresAt: number;
  };
  error?: string;
  code?: string;
}

/**
 * OAuth parameters returned by the DO (OAuth-standard snake_case)
 */
interface DOOAuthParams {
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

/**
 * DOstateresponse
 */
interface DOStateResponse {
  state?: {
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
    requestTimestamps?: number[];
    collectedData?: Record<string, unknown>;
    oauthParams?: DOOAuthParams;
  };
  error?: string;
  code?: string;
}

/**
 * DOIdempotency checkresponse
 */
interface DOCheckRequestResponse {
  found: boolean;
  result?: FlowSubmitResponse;
  state?: {
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
    requestTimestamps?: number[];
    collectedData?: Record<string, unknown>;
    oauthParams?: DOOAuthParams;
  };
  error?: string;
  code?: string;
}

// =============================================================================
// FlowExecutor
// =============================================================================

/**
 * FlowExecutor - Flow Engine core
 */
export class FlowExecutor {
  private registry: FlowRegistry;
  private compiler: FlowCompilerService;
  private uiGenerator: UIContractGenerator;
  private compiledPlans: Map<string, CompiledPlan> = new Map();
  private ttlMs: number;

  constructor(
    private env: Env,
    options: FlowExecutorOptions = {}
  ) {
    this.registry = createFlowRegistry({ kv: env.AUTHRIM_CONFIG });
    this.compiler = createFlowCompiler() as FlowCompilerService;
    this.uiGenerator = createUIContractGenerator();
    this.ttlMs = options.ttlMs ?? DEFAULT_FLOW_TTL_MS;
  }

  /**
   * Initialize the flow and return UIContract
   */
  async initFlow(params: {
    flowType: FlowType;
    clientId: string;
    tenantId: string;
    oauthParams?: OAuthFlowParams;
  }): Promise<FlowInitResponse> {
    const { flowType, clientId, tenantId, oauthParams } = params;

    // Security mitigation (Medium 10): basic Tenant/Client validation
    this.validateBasicTenantClient(tenantId, clientId);

    // 1. retrieve flow definitions
    const graphDef = await this.registry.getFlow(flowType, tenantId);
    if (!graphDef) {
      throw new Error(`Flow not found: ${flowType}`);
    }

    // 2. Get or compile the CompiledPlan
    const compiledPlan = this.getOrCompilePlan(graphDef, tenantId);

    // 3. Generate Session ID
    const sessionId = `flow_${crypto.randomUUID()}`;

    // 4. Determine the entry node (skip the start node)
    const entryNode = compiledPlan.nodes.get(compiledPlan.entryNodeId);
    if (!entryNode) {
      throw new Error(`Entry node not found: ${compiledPlan.entryNodeId}`);
    }

    // If this is the start node, use the next node as the actual entry
    let actualEntryNodeId = compiledPlan.entryNodeId;
    let currentNode = entryNode;
    if (entryNode.type === 'start' && entryNode.nextOnSuccess) {
      const nextNode = compiledPlan.nodes.get(entryNode.nextOnSuccess);
      if (nextNode) {
        actualEntryNodeId = entryNode.nextOnSuccess;
        currentNode = nextNode;
      }
    }

    // 5. Call FlowStateStore DO and initialize it
    // Save the actual displayed Node ID in the DO (start node already skipped)
    const doResponse = await this.callDO<DOInitResponse>(tenantId, sessionId, '/init', 'POST', {
      sessionId,
      flowId: graphDef.id,
      flowType, // Save flowType (needed for recompilation)
      tenantId,
      clientId,
      entryNodeId: actualEntryNodeId,
      ttlMs: this.ttlMs,
      oauthParams,
    });

    if (!doResponse.success || !doResponse.state) {
      throw new Error(doResponse.error || 'Failed to initialize flow');
    }

    const uiContract = this.uiGenerator.generate({
      compiledNode: currentNode,
      flowId: graphDef.id,
      profileId: graphDef.profileId,
    });

    return {
      sessionId,
      uiContractVersion: '0.1',
      uiContract,
    };
  }

  /**
   * Process the capability response and return the next UIContract
   */
  async submitCapability(params: FlowSubmitRequest): Promise<FlowSubmitResponse> {
    const { sessionId, requestId, capabilityId, response, tenantId, clientId } = params;

    if (!tenantId?.trim()) {
      return {
        type: 'error',
        error: {
          code: 'tenant_required',
          message: 'Tenant context is required',
        },
      };
    }

    // 1. Idempotency check (/check-request)
    // This lets requests with the same requestId skip processing and return the cached result
    const checkResponse = await this.callDO<DOCheckRequestResponse>(
      tenantId,
      sessionId,
      '/check-request',
      'POST',
      { requestId }
    );

    // Error check
    if (checkResponse.error) {
      return {
        type: 'error',
        error: {
          code: checkResponse.code || 'check_error',
          message: checkResponse.error,
        },
      };
    }

    // Idempotency hit: return the cached result
    if (checkResponse.found && checkResponse.result) {
      return checkResponse.result;
    }

    // unprocessed: use the state returned by check-request
    if (!checkResponse.state) {
      return {
        type: 'error',
        error: {
          code: 'session_not_found',
          message: 'Session not found',
        },
      };
    }

    const {
      flowId,
      flowType,
      currentNodeId,
      collectedData = {},
      oauthParams,
    } = checkResponse.state;

    // Security mitigation: session validation (Critical 4)
    // Verify that request context tenantId/clientId match the session values
    // This prevents session hijacking attacks
    if (checkResponse.state.tenantId !== tenantId) {
      console.error(
        `[Security] Session tenant mismatch: expected=${tenantId}, got=${checkResponse.state.tenantId}`
      );
      return {
        type: 'error',
        error: {
          code: 'invalid_session',
          message: 'Session tenant mismatch',
        },
      };
    }
    if (clientId && checkResponse.state.clientId !== clientId) {
      console.error(
        `[Security] Session client mismatch: expected=${clientId}, got=${checkResponse.state.clientId}`
      );
      return {
        type: 'error',
        error: {
          code: 'invalid_session',
          message: 'Session client mismatch',
        },
      };
    }

    // Security mitigation: rate limit (Critical 3)
    // Get request timestamps from session state (use an empty array when not implemented on the DO side)
    let requestTimestamps = checkResponse.state.requestTimestamps || [];
    const now = Date.now();
    const RATE_LIMIT_WINDOW_MS = 60 * 1000; // One-minute window
    const MAX_REQUESTS_PER_WINDOW = 30; // Maximum 30 requests per minute
    const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // Maximum session duration is 30 minutes
    const MAX_TIMESTAMP_HISTORY = 100; // Maximum timestamp history size (memory DoS mitigation)

    // Array size limit (memory exhaustion attack mitigation)
    if (requestTimestamps.length > MAX_TIMESTAMP_HISTORY) {
      requestTimestamps = requestTimestamps.slice(-MAX_TIMESTAMP_HISTORY);
    }

    // 1. Delete old timestamps (outside the window)
    const recentTimestamps = requestTimestamps.filter(
      (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS
    );

    // 2. Rate-limit check
    if (recentTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
      console.error(
        `[Security] Rate limit exceeded: ${recentTimestamps.length} requests in ${RATE_LIMIT_WINDOW_MS}ms (max: ${MAX_REQUESTS_PER_WINDOW})`
      );
      return {
        type: 'error',
        error: {
          code: 'rate_limit_exceeded',
          message: 'Too many requests. Please wait a moment and try again.',
        },
      };
    }

    // 3. Session timeout check
    const sessionStartedAt = checkResponse.state.startedAt;
    if (now - sessionStartedAt > SESSION_TIMEOUT_MS) {
      console.error(
        `[Security] Session timeout: ${Math.floor((now - sessionStartedAt) / 1000 / 60)} minutes elapsed (max: ${SESSION_TIMEOUT_MS / 1000 / 60})`
      );
      return {
        type: 'error',
        error: {
          code: 'session_timeout',
          message: 'Session has expired. Please start over.',
        },
      };
    }

    // Security mitigation: circular reference detection (High 6)
    // Get visit history from session state (use an empty array when not implemented on the DO side)
    const rawVisitedNodes = checkResponse.state.visitedNodeIds;
    // Security mitigation (Medium 8): ensure type safety (fall back to an empty array when it is not an array)
    let visitedNodes: string[] = Array.isArray(rawVisitedNodes) ? rawVisitedNodes : [];
    const MAX_VISITS_PER_NODE = 3; // Maximum visits to the same node
    const MAX_TOTAL_NODES = 50; // Maximum node visits across the flow (infinite loop mitigation)
    const MAX_VISITED_HISTORY = 200; // Maximum visit history array size (memory DoS mitigation)

    // Pre-check array size (memory exhaustion attack mitigation)
    if (visitedNodes.length > MAX_VISITED_HISTORY) {
      console.warn(
        `[Security] Visited nodes history too large (${visitedNodes.length}), truncating to last ${MAX_VISITED_HISTORY} entries`
      );
      visitedNodes = visitedNodes.slice(-MAX_VISITED_HISTORY);
    }

    // 1. Check excessive visits to the same node
    const currentNodeVisitCount = visitedNodes.filter((id) => id === currentNodeId).length;
    if (currentNodeVisitCount >= MAX_VISITS_PER_NODE) {
      console.error(
        `[Security] Circular reference detected: Node "${currentNodeId}" visited ${currentNodeVisitCount} times (max: ${MAX_VISITS_PER_NODE})`
      );
      return {
        type: 'error',
        error: {
          code: 'circular_reference',
          message: 'Flow contains a circular reference. Please contact support.',
        },
      };
    }

    // 2. Check total node visits across the flow (infinite loop mitigation)
    if (visitedNodes.length >= MAX_TOTAL_NODES) {
      console.error(
        `[Security] Maximum flow length exceeded: ${visitedNodes.length} nodes visited (max: ${MAX_TOTAL_NODES})`
      );
      return {
        type: 'error',
        error: {
          code: 'flow_too_long',
          message: 'Flow execution limit exceeded. Please contact support.',
        },
      };
    }

    // 2. Get CompiledPlan
    const compiledPlan = this.compiledPlans.get(
      this.getCompiledPlanCacheKey(checkResponse.state.tenantId, flowId)
    );
    if (!compiledPlan) {
      // Recompile when not in the cache
      // flowType is stored in the DO and retrieved from the session
      const graphDef = await this.registry.getFlow(
        flowType as FlowType,
        checkResponse.state.tenantId
      );
      if (!graphDef) {
        return {
          type: 'error',
          error: {
            code: 'flow_not_found',
            message: 'Flow definition not found',
          },
        };
      }
      this.getOrCompilePlan(graphDef, checkResponse.state.tenantId);
    }

    const plan = this.compiledPlans.get(
      this.getCompiledPlanCacheKey(checkResponse.state.tenantId, flowId)
    );
    if (!plan) {
      return {
        type: 'error',
        error: {
          code: 'plan_not_found',
          message: 'Compiled plan not found',
        },
      };
    }

    // 3. Get current node
    const currentNode = plan.nodes.get(currentNodeId);
    if (!currentNode) {
      return {
        type: 'error',
        error: {
          code: 'node_not_found',
          message: `Node not found: ${currentNodeId}`,
        },
      };
    }

    // 4. Determine the next node (Decision/Switch support)
    // Use tenantId/clientId values verified from the DO (security hardening)
    const runtimeContext = this.buildRuntimeContext(collectedData, {
      tenantId: checkResponse.state.tenantId,
      clientId: checkResponse.state.clientId,
    });
    const nextNodeId = await this.determineNextNode(currentNode, plan, runtimeContext);

    // Completion check
    if (!nextNodeId) {
      // flow completion → redirect
      // Get redirect_uri from OAuth parameters; otherwise fall back
      const redirectUrl = oauthParams?.redirect_uri || '/callback';
      return {
        type: 'redirect',
        redirect: {
          url: redirectUrl,
          method: 'GET',
        },
      };
    }

    const nextNode = plan.nodes.get(nextNodeId);
    if (!nextNode) {
      return {
        type: 'error',
        error: {
          code: 'next_node_not_found',
          message: `Next node not found: ${nextNodeId}`,
        },
      };
    }

    // Redirect for end nodes
    if (nextNode.type === 'end') {
      // Get redirect_uri from OAuth parameters; otherwise fall back
      const redirectUrl = oauthParams?.redirect_uri || '/callback';
      return {
        type: 'redirect',
        redirect: {
          url: redirectUrl,
          method: 'GET',
        },
      };
    }

    // 5. Generate the next UIContract
    const updatedCollectedData = {
      ...collectedData,
      [capabilityId]: response,
    };

    const uiContract = this.uiGenerator.generate({
      compiledNode: nextNode,
      flowId,
      runtimeState: {
        collectedData: updatedCollectedData,
      },
      profileId: plan.profileId,
    });

    // 6. Save state to the DO
    const submitResult: FlowSubmitResponse = {
      type: 'continue',
      uiContract,
    };

    // Update visit history (add the current node)
    const updatedVisitedNodes = [...visitedNodes, currentNodeId];

    // Update request timestamps (add the current time)
    const updatedRequestTimestamps = [...recentTimestamps, now];

    await this.callDO(tenantId, sessionId, '/submit', 'POST', {
      requestId,
      capabilityId,
      response,
      result: submitResult,
      nextNodeId,
      visitedNodes: updatedVisitedNodes, // Save visit history
      requestTimestamps: updatedRequestTimestamps, // Save request timestamps
    });

    return submitResult;
  }

  /**
   * Get the current state
   */
  async getFlowState(sessionId: string, tenantId: string): Promise<FlowStateResponse> {
    // 1. Get state from the DO
    const stateResponse = await this.callDO<DOStateResponse>(tenantId, sessionId, '/state', 'GET');

    if (stateResponse.error || !stateResponse.state) {
      throw new Error(stateResponse.error || 'Session not found');
    }

    const {
      flowId,
      flowType,
      tenantId: stateTenantId,
      currentNodeId,
      visitedNodeIds,
      completedCapabilities,
      collectedData,
    } = stateResponse.state;

    // 2. Get CompiledPlan
    let plan = this.compiledPlans.get(this.getCompiledPlanCacheKey(stateTenantId, flowId));
    if (!plan) {
      // Recompile when not in the cache
      // flowType is stored in the DO and retrieved from the session
      const graphDef = await this.registry.getFlow(flowType as FlowType, stateTenantId);
      if (graphDef) {
        plan = this.getOrCompilePlan(graphDef, stateTenantId);
      }
    }

    if (!plan) {
      throw new Error('Compiled plan not found');
    }

    // 3. Get current node
    const currentNode = plan.nodes.get(currentNodeId);
    if (!currentNode) {
      throw new Error(`Node not found: ${currentNodeId}`);
    }

    // 4. Generate a UIContract
    const uiContract = this.uiGenerator.generate({
      compiledNode: currentNode,
      flowId,
      runtimeState: {
        collectedData,
      },
      profileId: plan.profileId,
    });

    return {
      state: {
        currentNodeId,
        visitedNodeIds,
        completedCapabilities,
      },
      uiContract,
    };
  }

  /**
   * Cancel the flow
   */
  async cancelFlow(sessionId: string, tenantId: string): Promise<void> {
    await this.callDO(tenantId, sessionId, '/cancel', 'DELETE');
  }

  // =============================================================================
  // Private Methods
  // =============================================================================

  /**
   * Get or compile the CompiledPlan
   */
  private getOrCompilePlan(
    graphDef: {
      id: string;
      flowVersion: string;
      profileId: string;
      nodes: unknown[];
      edges: unknown[];
      name: string;
      description: string;
      metadata: unknown;
    },
    tenantId: string
  ): CompiledPlan {
    const cacheKey = this.getCompiledPlanCacheKey(tenantId, graphDef.id);

    // Return the cached value when available
    const cached = this.compiledPlans.get(cacheKey);
    if (cached && cached.sourceVersion === graphDef.flowVersion) {
      return cached;
    }

    // Compile
    const compiled = this.compiler.compile(graphDef as Parameters<typeof this.compiler.compile>[0]);
    this.compiledPlans.set(cacheKey, compiled);

    return compiled;
  }

  private getCompiledPlanCacheKey(tenantId: string, flowId: string): string {
    return `compiled:${tenantId}:${flowId}`;
  }

  /**
   * Call the FlowStateStore DO
   *
   * Routing strategy:
   * - one Durable Object per tenant + flow session
   * - the DO stores exactly one RuntimeState and serializes that session only
   */
  private async callDO<T>(
    tenantId: string,
    sessionId: string,
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown
  ): Promise<T> {
    // Use the sharding utility to get the DO stub
    const { stub } = await getFlowStateStoreStub(this.env, sessionId, tenantId);

    // Create the request
    const requestInit: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Id': tenantId,
        'X-Flow-Session-Id': sessionId,
      },
    };

    if (body && method !== 'GET') {
      requestInit.body = JSON.stringify(body);
    }

    // Call the DO
    const response = await stub.fetch(new Request(`http://localhost${path}`, requestInit));

    // Parse the response
    return (await response.json()) as T;
  }

  /**
   * Determine the next node ID (Decision/Switch support)
   *
   * @param currentNode - current node
   * @param plan - compiled plan
   * @param context - runtime context
   * @returns next node ID (null means flow end)
   */
  private async determineNextNode(
    currentNode: CompiledNode,
    plan: CompiledPlan,
    context: FlowRuntimeContext
  ): Promise<string | null> {
    // For Decision/Switch nodes
    if (currentNode.type === 'decision' || currentNode.type === 'switch') {
      return this.evaluateDecisionNode(currentNode, plan, context);
    }

    // Normal node: return nextOnSuccess
    return currentNode.nextOnSuccess;
  }

  /**
   * Evaluate Decision/Switch nodes
   *
   * @param node - Decision/Switch node
   * @param plan - compiled plan
   * @param context - runtime context
   * @returns Target node ID
   */
  private evaluateDecisionNode(
    node: CompiledNode,
    plan: CompiledPlan,
    context: FlowRuntimeContext
  ): string | null {
    if (node.type === 'decision') {
      return this.evaluateDecisionBranches(node, plan, context);
    }

    if (node.type === 'switch') {
      return this.evaluateSwitchCases(node, plan, context);
    }

    return null;
  }

  /**
   * Evaluate Decision branches
   *
   * @param node - Decision node
   * @param plan - compiled plan
   * @param context - runtime context
   * @returns Target node ID
   */
  private evaluateDecisionBranches(
    node: CompiledNode,
    plan: CompiledPlan,
    context: FlowRuntimeContext
  ): string | null {
    const config = node.decisionConfig as DecisionNodeConfig | undefined;
    if (!config) {
      return null;
    }

    // Get the transition list (already sorted by priority order)
    const transitions = plan.transitions.get(node.id) || [];

    // Evaluate conditions in priority order
    for (const branch of config.branches) {
      // Condition evaluation
      const matches = evaluate(branch.condition, context);

      if (matches) {
        // Return the target for the matched branch
        const transition = transitions.find((t) => t.sourceHandle === branch.id);
        if (transition) {
          // Security mitigation (Medium 12): Verify that the target node exists
          if (!plan.nodes.has(transition.targetNodeId)) {
            console.error(
              `[Security] Invalid transition: target node "${transition.targetNodeId}" does not exist in plan`
            );
            return null;
          }
          return transition.targetNodeId;
        }
      }
    }

    // If no condition matches, use the default branch
    if (config.defaultBranch) {
      const defaultTransition = transitions.find((t) => t.sourceHandle === config.defaultBranch);
      if (defaultTransition) {
        // Security mitigation (Medium 12): Verify that the target node exists
        if (!plan.nodes.has(defaultTransition.targetNodeId)) {
          console.error(
            `[Security] Invalid default transition: target node "${defaultTransition.targetNodeId}" does not exist in plan`
          );
          return null;
        }
        return defaultTransition.targetNodeId;
      }
    }

    // Return null when there is no default branch (flow ends)
    return null;
  }

  /**
   * Evaluate Switch case
   *
   * @param node - Switch node
   * @param plan - compiled plan
   * @param context - runtime context
   * @returns Target node ID
   */
  private evaluateSwitchCases(
    node: CompiledNode,
    plan: CompiledPlan,
    context: FlowRuntimeContext
  ): string | null {
    const config = node.decisionConfig as SwitchNodeConfig | undefined;
    if (!config) {
      return null;
    }

    // Dangerous keys for prototype pollution mitigation
    const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

    // Get the switchKey value
    const keyParts = config.switchKey.split('.');
    let value: unknown = context;
    for (const part of keyParts) {
      // Prototype pollution mitigation: Reject dangerous keys
      if (DANGEROUS_KEYS.includes(part)) {
        console.error(
          `[Security] Dangerous key detected in switchKey: "${part}" (full key: "${config.switchKey}")`
        );
        value = undefined;
        break;
      }

      if (value === null || value === undefined || typeof value !== 'object') {
        value = undefined;
        break;
      }

      // Prototype pollution mitigation: Use hasOwnProperty to avoid walking the prototype chain
      if (!Object.prototype.hasOwnProperty.call(value, part)) {
        value = undefined;
        break;
      }

      value = (value as Record<string, unknown>)[part];
    }

    // Get the transition list
    const transitions = plan.transitions.get(node.id) || [];

    // Compare each case with the value
    for (const caseItem of config.cases) {
      if (caseItem.values.includes(value as string | number | boolean)) {
        const transition = transitions.find((t) => t.sourceHandle === caseItem.id);
        if (transition) {
          // Security mitigation (Medium 12): Verify that the target node exists
          if (!plan.nodes.has(transition.targetNodeId)) {
            console.error(
              `[Security] Invalid switch transition: target node "${transition.targetNodeId}" does not exist in plan`
            );
            return null;
          }
          return transition.targetNodeId;
        }
      }
    }

    // If no case matches, use the default case
    if (config.defaultCase) {
      const defaultTransition = transitions.find((t) => t.sourceHandle === config.defaultCase);
      if (defaultTransition) {
        // Security mitigation (Medium 12): Verify that the target node exists
        if (!plan.nodes.has(defaultTransition.targetNodeId)) {
          console.error(
            `[Security] Invalid switch default transition: target node "${defaultTransition.targetNodeId}" does not exist in plan`
          );
          return null;
        }
        return defaultTransition.targetNodeId;
      }
    }

    // Return null when there is no default case (flow ends)
    return null;
  }

  /**
   * Sanitize sensitive information before logging (Medium 9)
   *
   * Security mitigation:
   * - circular reference detection (prevents infinite loops)
   * - depth limit (prevents stack overflow)
   * - array/object size limit (prevents memory DoS)
   * - masking sensitive keys (password, secret, etc.)
   *
   * Usage example (debugging):
   * ```
   * console.error('[Debug] Context:', this.sanitizeForLogging(context));
   * console.warn('[Debug] State:', this.sanitizeForLogging(collectedData));
   * ```
   *
   * @param obj - object to log
   * @param seen - for circular reference detection (internal use)
   * @param depth - current depth (internal use)
   * @returns sanitized object
   */
  private sanitizeForLogging(obj: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
    const MAX_DEPTH = 10; // Maximum depth
    const MAX_ITEMS = 100; // Maximum array/object items

    // Depth limit check
    if (depth > MAX_DEPTH) {
      return '[MAX_DEPTH_EXCEEDED]';
    }

    // Return primitive values as-is
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }

    // Circular reference check
    if (seen.has(obj)) {
      return '[CIRCULAR_REFERENCE]';
    }
    seen.add(obj);

    // Sensitive key patterns
    const SENSITIVE_KEYS = [
      'password',
      'secret',
      'token',
      'access_token',
      'refresh_token',
      'id_token',
      'authorization',
      'api_key',
      'apiKey',
      'sessionId',
      'session_id',
      'credit_card',
      'creditCard',
      'ssn',
      'privateKey',
      'private_key',
    ];

    // For arrays
    if (Array.isArray(obj)) {
      // Size limit check
      if (obj.length > MAX_ITEMS) {
        return `[Array(${obj.length}) - truncated to first ${MAX_ITEMS} items]`;
      }
      return obj.slice(0, MAX_ITEMS).map((item) => this.sanitizeForLogging(item, seen, depth + 1));
    }

    // For objects
    const keys = Object.keys(obj);

    // Property count limit check
    if (keys.length > MAX_ITEMS) {
      return `[Object with ${keys.length} properties - truncated]`;
    }

    const sanitized: Record<string, unknown> = {};
    for (const key of keys) {
      const lowerKey = key.toLowerCase();
      const isSensitive = SENSITIVE_KEYS.some((sensitiveKey) =>
        lowerKey.includes(sensitiveKey.toLowerCase())
      );

      if (isSensitive) {
        sanitized[key] = '[REDACTED]';
      } else {
        const value = (obj as Record<string, unknown>)[key];
        if (typeof value === 'object' && value !== null) {
          sanitized[key] = this.sanitizeForLogging(value, seen, depth + 1);
        } else {
          sanitized[key] = value;
        }
      }
    }

    return sanitized;
  }

  /**
   * Build FlowRuntimeContext from collectedData
   *
   * Security mitigation:
   * - Treat collectedData as untrusted data
   * - Use an allowlist and extract only permitted fields
   * - In the future, user information and similar values should be reloaded from authenticated sources
   *
   * @param collectedData - Collected data
   * @returns FlowRuntimeContext
   */
  /**
   * Basic Tenant/Client ID validation (Medium 10)
   *
   * Security mitigation:
   * - null/undefined/empty-string check
   * - minimal type checks
   *
   * Note: this is basic validation only.
   * Production use needs the following additional validation:
   * - Tenant/Client existence check (DB lookup)
   * - Tenant/Client active-state check
   * - verify that Client belongs to Tenant
   * - permission check
   *
   * @param tenantId - Tenant ID
   * @param clientId - Client ID
   * @throws Error on validation failure
   */
  private validateBasicTenantClient(tenantId: string, clientId: string): void {
    // Basic null/undefined checks
    if (!tenantId || typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw new Error('Invalid tenantId');
    }
    if (!clientId || typeof clientId !== 'string' || clientId.trim() === '') {
      throw new Error('Invalid clientId');
    }

    // Security warning: Real authorization checks are not implemented
    console.warn(
      `[Security] Basic validation passed for tenantId="${tenantId}", clientId="${clientId}", but full authorization check is not implemented`
    );
  }

  /**
   * Type-safe runtime context construction
   *
   * security hardening (High 5):
   * - Remove dangerous `as` casts
   * - Safe type checks with type guards
   * - Fallback with default values
   * - use tenant/client values verified from the DO
   *
   * @param collectedData - Collected data (Treat as untrusted data)
   * @param verifiedContext - verified context retrieved from the DO
   */
  private buildRuntimeContext(
    collectedData: Record<string, unknown>,
    verifiedContext?: {
      tenantId?: string;
      clientId?: string;
    }
  ): FlowRuntimeContext {
    // Type guard: check whether it is an object
    const isObject = (value: unknown): value is Record<string, unknown> => {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    };

    // Type guard: check whether it is NodeOutput
    const isNodeOutput = (value: unknown): value is import('./types.js').NodeOutput => {
      return isObject(value) && typeof value.success === 'boolean';
    };

    // Prefer tenant/client values verified from the DO
    // Ignore values from collectedData because they are untrusted
    const tenant = verifiedContext?.tenantId ? { id: verifiedContext.tenantId } : undefined;
    const client = verifiedContext?.clientId ? { id: verifiedContext.clientId } : undefined;

    return {
      // Use tenant/client values verified from the DO (security hardening)
      tenant,
      client,

      // Get user/device/request/risk from collectedData (should be retrieved from authenticated sources in the future)
      // Note: these values are used only within the flow and not directly for authentication decisions
      user: isObject(collectedData.user) ? collectedData.user : undefined,
      device: isObject(collectedData.device) ? collectedData.device : undefined,
      request: isObject(collectedData.request) ? collectedData.request : undefined,
      risk: isObject(collectedData.risk) ? collectedData.risk : undefined,

      // The following data is collected within the flow
      form: isObject(collectedData.form) ? collectedData.form : undefined,
      prevNode: isNodeOutput(collectedData.prevNode) ? collectedData.prevNode : undefined,
      variables: isObject(collectedData.variables) ? collectedData.variables : undefined,
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a FlowExecutor
 *
 * @param env - Cloudflare Worker environment
 * @param options - options
 * @returns FlowExecutor instance
 *
 * @example
 * const executor = createFlowExecutor(c.env);
 * const response = await executor.initFlow({
 *   flowType: 'login',
 *   clientId: 'test-client',
 *   tenantId: 'default',
 * });
 */
export function createFlowExecutor(env: Env, options?: FlowExecutorOptions): FlowExecutor {
  return new FlowExecutor(env, options);
}

// =============================================================================
// Export
// =============================================================================

export default FlowExecutor;
