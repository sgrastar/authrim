/**
 * Flow Engine - exports
 *
 * Track C: Flow Engine / UIContract unified entry point
 *
 * @see /private/docs/track-c-flow-engine-design.md
 */

// =============================================================================
// Types
// =============================================================================

export type {
  // Layer 1: GraphDefinition (for editing)
  GraphDefinition,
  GraphNode,
  GraphNodeData,
  GraphNodeType,
  GraphEdge,
  GraphEdgeData,
  GraphEdgeType,
  EdgeCondition,
  GraphMetadata,
  CapabilityTemplate,
  // Layer 2: CompiledPlan (for execution)
  CompiledPlan,
  CompiledNode,
  CompiledTransition,
  CompiledCondition,
  EvaluationContext,
  ResolvedCapability,
  // Layer 3: RuntimeState (for DO storage)
  RuntimeState,
  OAuthFlowParams,
  RuntimeStateSnapshot,
  // API Types
  FlowInitRequest,
  FlowInitResponse,
  FlowSubmitRequest,
  FlowSubmitResponse,
  FlowSubmitResult,
  FlowRedirect,
  FlowError,
  FlowStateResponse,
  // Migration Types
  MigrationFn,
  MigrationDefinition,
  // Utility Types
  FlowCompiler,
  CreateRuntimeStateParams,
} from './types';

export { DEFAULT_FLOW_TTL_MS, MAX_PROCESSED_REQUEST_IDS } from './types';

// =============================================================================
// Flow API
// =============================================================================

export { flowApi } from './flow-api';

// =============================================================================
// Durable Object
// =============================================================================

export { FlowStateStore } from './flow-state-store';

// =============================================================================
// Flow Registry
// =============================================================================

export { FlowRegistry, createFlowRegistry } from './flow-registry';
export type { FlowType, FlowRegistryOptions } from './flow-registry';

// =============================================================================
// Flow Compiler
// =============================================================================

export { FlowCompilerService, createFlowCompiler } from './flow-compiler';

// =============================================================================
// UI Contract Generator
// =============================================================================

export { UIContractGenerator, createUIContractGenerator } from './ui-contract-generator';
export type { UIContractGeneratorParams } from './ui-contract-generator';

// =============================================================================
// Flow Executor
// =============================================================================

export { FlowExecutor, createFlowExecutor } from './flow-executor';
export type { FlowExecutorOptions } from './flow-executor';

// =============================================================================
// Builtin Flows
// =============================================================================

export {
  HUMAN_BASIC_LOGIN_FLOW,
  BUILTIN_FLOWS,
  getBuiltinFlow,
  getBuiltinFlowIds,
} from './flows/login-flow';
