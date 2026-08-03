/**
 * Durable Objects Export
 *
 * This file exports all Durable Objects for use in Cloudflare Workers.
 * These Durable Objects can be bound to by other workers using wrangler.toml bindings.
 *
 * Usage in other workers' wrangler.toml:
 * ```toml
 * [[durable_objects.bindings]]
 * name = "SESSION_STORE"
 * class_name = "SessionStore"
 * script_name = "authrim-shared"
 * ```
 */

export { SessionStore } from './SessionStore';
export { SessionRevocationStore } from './SessionRevocationStore';
export { SessionClientStore } from './SessionClientStore';
export { AuthorizationCodeStore } from './AuthorizationCodeStore';
export { RefreshTokenRotator } from './RefreshTokenRotator';
export { KeyManager } from './KeyManager';
export { ChallengeStore } from './ChallengeStore';
export { RateLimiterCounter } from './RateLimiterCounter';
export { PARRequestStore } from './PARRequestStore';
export { DPoPJTIStore } from './DPoPJTIStore';
export { TokenRevocationStore } from './TokenRevocationStore';
export { DeviceCodeStore } from './DeviceCodeStore';
export { CIBARequestStore } from './CIBARequestStore';
export { VersionManager } from './VersionManager';
export { SAMLRequestStore } from './SAMLRequestStore';
export { SAMLAggregateMetadataStore } from './SAMLAggregateMetadataStore';
export { PermissionChangeHub } from './PermissionChangeHub';
export { UserCodeRateLimiter } from './UserCodeRateLimiter';
export { FlowStateStore } from './FlowStateStore';
export { DeviceSecretRouteStore } from './DeviceSecretRouteStore';
export type { DeviceSecretRouteHint } from './DeviceSecretRouteStore';
export { KeyManagerPublicEntrypoint } from '../entrypoints/KeyManagerPublicEntrypoint';
export { RuntimeSmokeEntrypoint } from '../entrypoints/RuntimeSmokeEntrypoint';

// Export types for external use
export type { Session, SessionData, CreateSessionRequest, SessionResponse } from './SessionStore';
export type {
  AccountAuthenticationLifecycle,
  AccountAuthenticationSnapshot,
  SessionRegistrationResult,
} from './SessionRevocationStore';
export type {
  RegisterSessionClientRequest,
  SessionClientRecord,
  UpdateSessionClientActivityRequest,
} from './SessionClientStore';

export type {
  AuthorizationCode,
  StoreCodeRequest,
  ConsumeCodeRequest,
  ConsumeCodeResponse,
} from './AuthorizationCodeStore';

export type {
  TokenFamilyV2,
  RotateTokenRequestV2,
  RotateTokenResponseV2,
  CreateFamilyRequestV2,
} from './RefreshTokenRotator';

export type {
  Challenge,
  ChallengeType,
  StoreChallengeRequest,
  ConsumeChallengeRequest,
  ConsumeChallengeResponse,
} from './ChallengeStore';

export type {
  RateLimitConfig,
  RateLimitRecord,
  RateLimitResult,
  IncrementRequest,
} from './RateLimiterCounter';

export type { PARRequestData, StorePARRequest, ConsumePARRequest } from './PARRequestStore';

export type { DPoPJTIRecord, CheckAndStoreJTIRequest } from './DPoPJTIStore';

export type { RevokedTokenRecord, RevokeTokenRequest } from './TokenRevocationStore';

export type {
  RuntimeState,
  RuntimeStateSnapshot,
  FlowSubmitResult,
  CreateRuntimeStateParams,
  OAuthFlowParams as FlowOAuthParams,
} from './FlowStateStore';
export { DEFAULT_FLOW_TTL_MS, MAX_PROCESSED_REQUEST_IDS } from './FlowStateStore';

/**
 * Default export for ES Module compatibility
 * This worker only exports Durable Objects, so the default export is a minimal fetch handler
 */
export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Response {
    return new Response('Authrim Shared - Durable Objects Worker', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};
