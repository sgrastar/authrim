/**
 * FlowStateStore - Re-export from ar-lib-core
 *
 * FlowStateStore DO is defined in ar-lib-core.
 * This file re-exports it for backward compatibility.
 *
 * @see /private/docs/track-c-flow-engine-design.md
 */

// Re-export FlowStateStore and types from ar-lib-core
export {
  FlowStateStore,
  DEFAULT_FLOW_TTL_MS,
  MAX_PROCESSED_REQUEST_IDS,
} from '@authrim/ar-lib-core';

export type {
  RuntimeState,
  RuntimeStateSnapshot,
  FlowSubmitResult,
  CreateRuntimeStateParams,
  FlowOAuthParams as OAuthFlowParams,
} from '@authrim/ar-lib-core';
