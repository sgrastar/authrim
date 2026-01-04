/**
 * PermissionChangeHub Durable Object
 *
 * Phase 8.3: Real-time Check API Model
 *
 * WebSocket-based permission change notification hub using Durable Objects.
 * Uses WebSocket Hibernation API for cost optimization.
 *
 * Features:
 * - Subscribe to permission changes for specific subjects/resources
 * - Broadcast permission change events to connected clients
 * - Hibernation support for cost optimization
 * - Automatic cleanup of stale connections
 *
 * Note: Each tenant has its own hub instance for isolation.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';
import { createLogger, type Logger } from '../utils/logger';
import type {
  WSClientMessage,
  WSSubscribeMessage,
  WSSubscribedMessage,
  WSPermissionChangeMessage,
  WSPongMessage,
  WSErrorMessage,
  PermissionChangeEvent,
} from '../types/check-api';

// =============================================================================
// Types
// =============================================================================

interface Subscription {
  id: string;
  subjects: string[];
  resources: string[];
  relations: string[];
  createdAt: number;
}

interface WebSocketAttachment {
  subscriptionId: string;
  subjectId?: string;
  connectedAt: number;
}

// =============================================================================
// PermissionChangeHub Durable Object
// =============================================================================

export class PermissionChangeHub extends DurableObject<Env> {
  /** Map of subscription ID to subscription details */
  private subscriptions: Map<string, Subscription> = new Map();

  /** Tenant ID for this hub instance */
  private tenantId: string = 'default';

  private readonly log: Logger = createLogger().module('PermissionChangeHub');

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Restore state on cold start
    this.ctx.blockConcurrencyWhile(async () => {
      // Load tenant ID if stored
      const stored = await this.ctx.storage.get<string>('tenantId');
      if (stored) {
        this.tenantId = stored;
      }

      // Load subscriptions
      const storedSubs = await this.ctx.storage.get<Map<string, Subscription>>('subscriptions');
      if (storedSubs) {
        this.subscriptions = storedSubs;
      }
    });
  }

  /**
   * Handle HTTP request (WebSocket upgrade or REST)
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Handle WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    // Handle REST endpoints
    if (request.method === 'POST' && url.pathname === '/broadcast') {
      return this.handleBroadcast(request);
    }

    if (request.method === 'POST' && url.pathname === '/setup') {
      return this.handleSetup(request);
    }

    if (request.method === 'GET' && url.pathname === '/stats') {
      return this.handleStats();
    }

    return new Response('Not Found', { status: 404 });
  }

  /**
   * Setup tenant ID for this hub
   */
  private async handleSetup(request: Request): Promise<Response> {
    try {
      const body = (await request.json()) as { tenant_id: string };
      this.tenantId = body.tenant_id;
      await this.ctx.storage.put('tenantId', this.tenantId);
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: 'Invalid request' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  /**
   * Get hub statistics
   */
  private handleStats(): Response {
    const websockets = this.ctx.getWebSockets();

    return new Response(
      JSON.stringify({
        tenant_id: this.tenantId,
        active_connections: websockets.length,
        subscriptions: this.subscriptions.size,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  /**
   * Handle WebSocket upgrade request
   */
  private handleWebSocketUpgrade(_request: Request): Response {
    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Generate subscription ID
    const subscriptionId = crypto.randomUUID();

    // Attach metadata to the WebSocket
    const attachment: WebSocketAttachment = {
      subscriptionId,
      connectedAt: Date.now(),
    };

    // Accept the WebSocket with hibernation support
    this.ctx.acceptWebSocket(server, [JSON.stringify(attachment)]);

    // Return the client WebSocket
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Handle WebSocket message (called from hibernation)
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const msgStr = typeof message === 'string' ? message : new TextDecoder().decode(message);
      const data = JSON.parse(msgStr) as WSClientMessage;

      switch (data.type) {
        case 'subscribe':
          await this.handleSubscribe(ws, data);
          break;
        case 'unsubscribe':
          await this.handleUnsubscribe(ws, data.subscription_id);
          break;
        case 'ping':
          this.handlePing(ws, data.timestamp);
          break;
        default:
          this.sendError(ws, 'unknown_message_type', 'Unknown message type');
      }
    } catch (error) {
      this.log.error('Message handling error', {}, error as Error);
      this.sendError(ws, 'parse_error', 'Failed to parse message');
    }
  }

  /**
   * Handle WebSocket close
   */
  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    const attachment = this.getAttachment(ws);
    if (attachment) {
      // Remove subscription
      this.subscriptions.delete(attachment.subscriptionId);
      await this.ctx.storage.put('subscriptions', this.subscriptions);
    }
  }

  /**
   * Handle WebSocket error
   */
  async webSocketError(ws: WebSocket, error: Error): Promise<void> {
    this.log.error('WebSocket error', {}, error);
    const attachment = this.getAttachment(ws);
    if (attachment) {
      this.subscriptions.delete(attachment.subscriptionId);
      await this.ctx.storage.put('subscriptions', this.subscriptions);
    }
  }

  /**
   * Handle subscribe message
   */
  private async handleSubscribe(ws: WebSocket, msg: WSSubscribeMessage): Promise<void> {
    const attachment = this.getAttachment(ws);
    if (!attachment) {
      this.sendError(ws, 'no_attachment', 'WebSocket attachment not found');
      return;
    }

    // Create subscription
    const subscription: Subscription = {
      id: attachment.subscriptionId,
      subjects: msg.subjects || (msg.subject_id ? [msg.subject_id] : []),
      resources: msg.resources || [],
      relations: msg.relations || [],
      createdAt: Date.now(),
    };

    // Update attachment with subject_id if provided
    if (msg.subject_id) {
      attachment.subjectId = msg.subject_id;
      // Re-attach the updated metadata
      // Note: We can't directly update tags, but we track it in the subscription
    }

    this.subscriptions.set(attachment.subscriptionId, subscription);
    await this.ctx.storage.put('subscriptions', this.subscriptions);

    // Send confirmation
    const response: WSSubscribedMessage = {
      type: 'subscribed',
      subscription_id: attachment.subscriptionId,
      subscriptions: {
        subjects: subscription.subjects,
        resources: subscription.resources,
        relations: subscription.relations,
      },
    };

    ws.send(JSON.stringify(response));
  }

  /**
   * Handle unsubscribe message
   */
  private async handleUnsubscribe(ws: WebSocket, subscriptionId: string): Promise<void> {
    const attachment = this.getAttachment(ws);
    if (!attachment || attachment.subscriptionId !== subscriptionId) {
      this.sendError(ws, 'invalid_subscription', 'Invalid subscription ID');
      return;
    }

    this.subscriptions.delete(subscriptionId);
    await this.ctx.storage.put('subscriptions', this.subscriptions);

    // Close the WebSocket
    ws.close(1000, 'Unsubscribed');
  }

  /**
   * Handle ping message
   */
  private handlePing(ws: WebSocket, timestamp: number): void {
    const response: WSPongMessage = {
      type: 'pong',
      timestamp,
    };
    ws.send(JSON.stringify(response));
  }

  /**
   * Handle broadcast request (from permission change notifier)
   */
  private async handleBroadcast(request: Request): Promise<Response> {
    try {
      const event = (await request.json()) as PermissionChangeEvent;

      // Get all connected WebSockets
      const websockets = this.ctx.getWebSockets();

      let notifiedCount = 0;

      for (const ws of websockets) {
        const attachment = this.getAttachment(ws);
        if (!attachment) continue;

        const subscription = this.subscriptions.get(attachment.subscriptionId);
        if (!subscription) continue;

        // Check if this subscription should receive the event
        if (this.shouldNotify(subscription, event)) {
          const message: WSPermissionChangeMessage = {
            type: 'permission_change',
            event: event.event,
            subject_id: event.subject_id,
            resource: event.resource,
            relation: event.relation,
            permission: event.permission,
            timestamp: event.timestamp,
            invalidate_cache: true,
          };

          try {
            ws.send(JSON.stringify(message));
            notifiedCount++;
          } catch (error) {
            this.log.warn('Failed to send to WebSocket', {}, error as Error);
          }
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          notified: notifiedCount,
          total_connections: websockets.length,
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } catch (error) {
      this.log.error('Broadcast error', {}, error as Error);
      return new Response(JSON.stringify({ error: 'Broadcast failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  /**
   * Check if a subscription should receive an event
   */
  private shouldNotify(subscription: Subscription, event: PermissionChangeEvent): boolean {
    // Match by subject
    if (
      subscription.subjects.length > 0 &&
      !subscription.subjects.includes(event.subject_id) &&
      !subscription.subjects.includes('*')
    ) {
      return false;
    }

    // Match by resource (supports wildcard patterns like "document:*")
    if (subscription.resources.length > 0 && event.resource) {
      const resourceMatches = subscription.resources.some((pattern) => {
        if (pattern === '*') return true;
        if (pattern.endsWith(':*')) {
          const prefix = pattern.slice(0, -1); // Remove '*'
          return event.resource?.startsWith(prefix);
        }
        return pattern === event.resource;
      });
      if (!resourceMatches) return false;
    }

    // Match by relation
    if (subscription.relations.length > 0 && event.relation) {
      if (
        !subscription.relations.includes(event.relation) &&
        !subscription.relations.includes('*')
      ) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get WebSocket attachment
   */
  private getAttachment(ws: WebSocket): WebSocketAttachment | null {
    try {
      const tags = this.ctx.getTags(ws);
      if (tags.length > 0) {
        return JSON.parse(tags[0]) as WebSocketAttachment;
      }
    } catch {
      // Ignore parse errors
    }
    return null;
  }

  /**
   * Send error message to WebSocket
   */
  private sendError(ws: WebSocket, code: string, message: string): void {
    const response: WSErrorMessage = {
      type: 'error',
      code,
      message,
    };
    ws.send(JSON.stringify(response));
  }
}
