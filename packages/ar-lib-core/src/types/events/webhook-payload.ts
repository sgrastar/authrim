/**
 * Webhook Payload Types
 *
 * Defines the external delivery format for events sent to Webhook endpoints.
 * WebhookPayload is the serialized form of UnifiedEvent, optimized for
 * external consumption with Unix timestamps and flattened context.
 *
 * Transformation:
 * - UnifiedEvent (internal) → toWebhookPayload() → WebhookPayload (external)
 *
 * @packageDocumentation
 */

import type { ActorType, UnifiedEvent } from './unified-event';

// =============================================================================
// Webhook Context
// =============================================================================

/**
 * Context information for webhook delivery.
 * Flattened from UnifiedEvent.metadata for external consumption.
 */
export interface WebhookContext {
  /** Request ID for correlation */
  requestId?: string;
  /** Session ID */
  sessionId?: string;
  /** OAuth client ID */
  clientId?: string;
  /** IP address of the request origin */
  ipAddress?: string;
  /** User agent string */
  userAgent?: string;
  /** Geographic location */
  geoLocation?: {
    country?: string;
    region?: string;
    city?: string;
  };
}

// =============================================================================
// Webhook Actor
// =============================================================================

/**
 * Actor information for webhook payloads.
 * Promoted from UnifiedEvent.metadata.actor.
 */
export interface WebhookActor {
  /** Actor type (same as ActorType from unified-event) */
  type: ActorType;
  /** Actor identifier */
  id: string;
}

// =============================================================================
// Webhook Target
// =============================================================================

/**
 * Target resource information.
 * Extracted from event data for standardized access.
 */
export interface WebhookTarget {
  /** Target resource type (e.g., "user", "session", "client") */
  type: string;
  /** Target resource identifier */
  id: string;
}

// =============================================================================
// Webhook Payload
// =============================================================================

/**
 * External delivery format for webhook endpoints.
 *
 * This is the serialized form of UnifiedEvent, optimized for external
 * consumption with:
 * - Unix timestamps (milliseconds) instead of ISO 8601
 * - Flattened context structure
 * - Promoted actor and target fields
 *
 * @example
 * ```typescript
 * const payload: WebhookPayload = {
 *   eventId: "evt_abc123",
 *   eventName: "auth.passkey.succeeded",
 *   timestamp: 1703119856000,
 *   tenantId: "default",
 *   context: {
 *     requestId: "req_xyz789",
 *     sessionId: "ses_def456",
 *     clientId: "my-app",
 *     ipAddress: "203.0.113.1",
 *   },
 *   actor: {
 *     type: "user",
 *     id: "usr_abc123",
 *   },
 *   data: {
 *     credentialId: "cred_xyz",
 *     deviceName: "MacBook Pro",
 *   },
 * };
 * ```
 */
export interface WebhookPayload {
  /** Unique event ID (same as UnifiedEvent.id) */
  eventId: string;
  /** Event type (same as UnifiedEvent.type) */
  eventName: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Tenant ID */
  tenantId: string;
  /** Flattened context from metadata */
  context: WebhookContext;
  /** Actor who triggered the event (promoted from metadata) */
  actor?: WebhookActor;
  /** Target resource (extracted from data) */
  target?: WebhookTarget;
  /** Event-specific data */
  data: Record<string, unknown>;
}

// =============================================================================
// Transformation Functions
// =============================================================================

/**
 * Options for extracting target from event data.
 *
 * Target extraction priority:
 * 1. `data.target = { type, id }` object (if targetField is set or default "target")
 * 2. `data.targetType` + `data.targetId` fields (if typeField/idField are set)
 */
export interface ExtractTargetOptions {
  /** Field name for target object (default: "target"). Set to null to disable. */
  targetField?: string | null;
  /** Field name for target type (default: "targetType") */
  typeField?: string;
  /** Field name for target id (default: "targetId") */
  idField?: string;
}

/**
 * Convert UnifiedEvent to WebhookPayload.
 *
 * Transformation rules:
 * - id → eventId
 * - type → eventName
 * - timestamp (ISO 8601) → timestamp (Unix ms)
 * - metadata.actor → actor (promoted)
 * - metadata.* → context.* (flattened)
 * - data.target → target (extracted, object format preferred)
 * - data.targetType/targetId → target (fallback)
 *
 * @param event - UnifiedEvent to transform
 * @param options - Options for target extraction
 * @returns WebhookPayload for external delivery
 *
 * @example
 * ```typescript
 * // Example 1: Target as object (recommended)
 * const event1: UnifiedEvent = {
 *   id: "evt_123",
 *   type: "session.user.revoked",
 *   version: "1.0",
 *   timestamp: "2024-01-01T00:00:00.000Z",
 *   tenantId: "default",
 *   data: {
 *     target: { type: "session", id: "ses_456" },
 *     reason: "admin_revoke",
 *   },
 *   metadata: { actor: { type: "user", id: "usr_789" } },
 * };
 * const payload1 = toWebhookPayload(event1);
 * // payload1.target = { type: "session", id: "ses_456" }
 *
 * // Example 2: Target as separate fields (fallback)
 * const event2: UnifiedEvent = {
 *   id: "evt_456",
 *   type: "user.profile.updated",
 *   version: "1.0",
 *   timestamp: "2024-01-01T00:00:00.000Z",
 *   tenantId: "default",
 *   data: {
 *     targetType: "user",
 *     targetId: "usr_123",
 *     changes: { name: "New Name" },
 *   },
 *   metadata: {},
 * };
 * const payload2 = toWebhookPayload(event2);
 * // payload2.target = { type: "user", id: "usr_123" }
 * ```
 */
export function toWebhookPayload<T extends Record<string, unknown>>(
  event: UnifiedEvent<T>,
  options?: ExtractTargetOptions
): WebhookPayload {
  const { actor, ...restMetadata } = event.metadata;

  // Build context from remaining metadata fields
  const context: WebhookContext = {
    requestId: restMetadata.requestId,
    sessionId: restMetadata.sessionId,
    clientId: restMetadata.clientId,
    ipAddress: restMetadata.ipAddress,
    userAgent: restMetadata.userAgent,
    geoLocation: restMetadata.geo,
  };

  // Build actor if present
  const webhookActor: WebhookActor | undefined = actor
    ? {
        type: actor.type,
        id: actor.id,
      }
    : undefined;

  // Extract target from data if present
  // Priority: 1. data.target object, 2. data.targetType/targetId fields
  let target: WebhookTarget | undefined;

  // Try object format first: data.target = { type, id }
  const targetField = options?.targetField !== null ? (options?.targetField ?? 'target') : null;
  if (targetField) {
    const targetObj = event.data[targetField];
    if (
      targetObj &&
      typeof targetObj === 'object' &&
      'type' in targetObj &&
      'id' in targetObj &&
      typeof (targetObj as Record<string, unknown>).type === 'string' &&
      typeof (targetObj as Record<string, unknown>).id === 'string'
    ) {
      target = {
        type: (targetObj as Record<string, unknown>).type as string,
        id: (targetObj as Record<string, unknown>).id as string,
      };
    }
  }

  // Fallback to field format: data.targetType + data.targetId
  if (!target) {
    const typeField = options?.typeField ?? 'targetType';
    const idField = options?.idField ?? 'targetId';
    if (typeof event.data[typeField] === 'string' && typeof event.data[idField] === 'string') {
      target = {
        type: event.data[typeField],
        id: event.data[idField],
      };
    }
  }

  return {
    eventId: event.id,
    eventName: event.type,
    timestamp: new Date(event.timestamp).getTime(),
    tenantId: event.tenantId,
    context,
    actor: webhookActor,
    target,
    data: event.data as Record<string, unknown>,
  };
}

/**
 * Convert WebhookPayload back to UnifiedEvent format.
 *
 * This is primarily useful for testing and validation.
 * Note: Some metadata may be lost in round-trip conversion.
 *
 * @param payload - WebhookPayload to convert
 * @param version - Event schema version (default: "1.0")
 * @returns UnifiedEvent format
 */
export function fromWebhookPayload(
  payload: WebhookPayload,
  version = '1.0'
): UnifiedEvent<Record<string, unknown>> {
  return {
    id: payload.eventId,
    type: payload.eventName,
    version,
    timestamp: new Date(payload.timestamp).toISOString(),
    tenantId: payload.tenantId,
    data: payload.data,
    metadata: {
      actor: payload.actor
        ? {
            type: payload.actor.type,
            id: payload.actor.id,
          }
        : undefined,
      requestId: payload.context.requestId,
      sessionId: payload.context.sessionId,
      clientId: payload.context.clientId,
      ipAddress: payload.context.ipAddress,
      userAgent: payload.context.userAgent,
      geo: payload.context.geoLocation,
    },
  };
}
