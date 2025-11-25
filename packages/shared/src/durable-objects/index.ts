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

// Export types for external use
export type { Session, SessionData, CreateSessionRequest, SessionResponse } from './SessionStore';

export type {
  AuthorizationCode,
  StoreCodeRequest,
  ConsumeCodeRequest,
  ConsumeCodeResponse,
} from './AuthorizationCodeStore';

export type {
  TokenFamily,
  RotateTokenRequest,
  RotateTokenResponse,
  CreateFamilyRequest,
  RevokeFamilyRequest,
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
