/**
 * PARRequestStore Durable Object
 *
 * Manages Pushed Authorization Request (PAR) request_uri with single-use guarantee.
 * Solves issue #11: PAR request_uri race condition (RFC 9126 compliance).
 *
 * RFC 9126 Requirements:
 * - request_uri MUST be single-use only
 * - request_uri MUST expire (typically 10 minutes)
 * - request_uri MUST be bound to the client_id
 *
 * Security Features:
 * - Atomic consume operation (check + delete in single operation)
 * - Prevents parallel replay attacks
 * - TTL enforcement
 * - Client ID validation
 *
 * Benefits over KV-based PAR:
 * - ✅ RFC 9126 complete compliance (single-use guarantee)
 * - ✅ No race conditions on concurrent requests
 * - ✅ Immediate consistency (no eventual consistency issues)
 */

import type { Env } from '../types/env';

/**
 * PAR request data
 */
export interface PARRequestData {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  response_type?: string;
  prompt?: string;
  max_age?: number;
  ui_locales?: string;
  id_token_hint?: string;
  login_hint?: string;
  acr_values?: string;
  claims?: string;
  createdAt?: number;
  expiresAt?: number;
  consumed?: boolean;
}

/**
 * Store PAR request payload
 */
export interface StorePARRequest {
  requestUri: string; // urn:ietf:params:oauth:request_uri:xxx
  data: PARRequestData;
  ttl: number; // Time to live in seconds (typically 600 = 10 minutes)
}

/**
 * Consume PAR request payload
 */
export interface ConsumePARRequest {
  requestUri: string;
  client_id: string; // Must match the client_id in stored data
}

/**
 * Persistent state stored in Durable Storage
 */
interface PARRequestStoreState {
  requests: Record<string, PARRequestData>;
  lastCleanup: number;
}

/**
 * PARRequestStore Durable Object
 *
 * Provides atomic single-use PAR request_uri management.
 */
export class PARRequestStore {
  private state: DurableObjectState;
  private env: Env;
  private requests: Map<string, PARRequestData> = new Map();
  private cleanupInterval: number | null = null;
  private initialized: boolean = false;

  // Configuration
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_ENTRIES = 10000; // Cleanup trigger threshold

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /**
   * Initialize state from Durable Storage
   */
  private async initializeState(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const stored = await this.state.storage.get<PARRequestStoreState>('state');

      if (stored) {
        this.requests = new Map(Object.entries(stored.requests));
        console.log(
          `PARRequestStore: Restored ${this.requests.size} requests from Durable Storage`
        );
      }
    } catch (error) {
      console.error('PARRequestStore: Failed to initialize from Durable Storage:', error);
    }

    this.initialized = true;
    this.startCleanup();
  }

  /**
   * Save current state to Durable Storage
   */
  private async saveState(): Promise<void> {
    try {
      const stateToSave: PARRequestStoreState = {
        requests: Object.fromEntries(this.requests),
        lastCleanup: Date.now(),
      };

      await this.state.storage.put('state', stateToSave);
    } catch (error) {
      console.error('PARRequestStore: Failed to save to Durable Storage:', error);
    }
  }

  /**
   * Start periodic cleanup of expired requests
   */
  private startCleanup(): void {
    if (this.cleanupInterval === null) {
      this.cleanupInterval = setInterval(() => {
        void this.cleanupExpiredRequests();
      }, this.CLEANUP_INTERVAL) as unknown as number;
    }
  }

  /**
   * Cleanup expired or consumed requests
   */
  private async cleanupExpiredRequests(): Promise<void> {
    const now = Date.now();
    let cleaned = 0;

    for (const [uri, data] of this.requests.entries()) {
      if ((data.expiresAt && data.expiresAt <= now) || data.consumed) {
        this.requests.delete(uri);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`PARRequestStore: Cleaned up ${cleaned} expired/consumed requests`);
      await this.saveState();
    }
  }

  /**
   * Store a new PAR request
   */
  async storeRequest(request: StorePARRequest): Promise<void> {
    await this.initializeState();

    const now = Date.now();
    const data: PARRequestData = {
      ...request.data,
      createdAt: now,
      expiresAt: now + request.ttl * 1000,
      consumed: false,
    };

    this.requests.set(request.requestUri, data);
    await this.saveState();

    // Trigger cleanup if too many entries
    if (this.requests.size > this.MAX_ENTRIES) {
      void this.cleanupExpiredRequests();
    }
  }

  /**
   * Consume a PAR request (atomic check + delete)
   *
   * CRITICAL: This operation is atomic within the DO
   * - Checks if request_uri exists
   * - Validates client_id match
   * - Checks expiration
   * - Marks as consumed
   * - Returns request data
   *
   * RFC 9126 Compliance: Single-use guarantee
   * Parallel requests will fail because first request marks as consumed.
   */
  async consumeRequest(request: ConsumePARRequest): Promise<PARRequestData> {
    await this.initializeState();

    const data = this.requests.get(request.requestUri);

    // Request not found
    if (!data) {
      throw new Error('Invalid request_uri: not found or already consumed');
    }

    // Client ID mismatch
    if (data.client_id !== request.client_id) {
      throw new Error('Invalid request_uri: client_id mismatch');
    }

    // Already consumed
    if (data.consumed) {
      throw new Error('Invalid request_uri: already consumed');
    }

    // Expired
    if (data.expiresAt && data.expiresAt <= Date.now()) {
      this.requests.delete(request.requestUri);
      await this.saveState();
      throw new Error('Invalid request_uri: expired');
    }

    // ATOMIC: Mark as consumed (this is the solution to issue #11)
    // This prevents parallel replay attacks
    data.consumed = true;
    this.requests.set(request.requestUri, data);
    await this.saveState();

    // Optionally delete immediately (consumed requests don't need to be kept)
    setTimeout(() => {
      this.requests.delete(request.requestUri);
      void this.saveState();
    }, 1000);

    return data;
  }

  /**
   * Delete a PAR request (for cleanup or cancellation)
   */
  async deleteRequest(requestUri: string): Promise<boolean> {
    await this.initializeState();

    const had = this.requests.has(requestUri);
    this.requests.delete(requestUri);

    if (had) {
      await this.saveState();
    }

    return had;
  }

  /**
   * Get PAR request info (without consuming)
   * Used for validation before consumption
   */
  async getRequest(requestUri: string): Promise<PARRequestData | null> {
    await this.initializeState();

    const data = this.requests.get(requestUri);
    if (!data) {
      return null;
    }

    // Check if expired
    if (data.expiresAt && data.expiresAt <= Date.now()) {
      this.requests.delete(requestUri);
      await this.saveState();
      return null;
    }

    return data;
  }

  /**
   * Handle HTTP requests to the PARRequestStore Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // POST /request - Store new PAR request
      if (path === '/request' && request.method === 'POST') {
        const body = (await request.json()) as Partial<StorePARRequest>;

        if (!body.requestUri || !body.data || !body.ttl) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing required fields',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        await this.storeRequest(body as StorePARRequest);

        return new Response(JSON.stringify({ success: true }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /request/consume - Consume PAR request (atomic)
      if (path === '/request/consume' && request.method === 'POST') {
        const body = (await request.json()) as Partial<ConsumePARRequest>;

        if (!body.requestUri || !body.client_id) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing required fields',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        try {
          const data = await this.consumeRequest(body as ConsumePARRequest);

          return new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return new Response(
            JSON.stringify({
              error: 'invalid_request_uri',
              error_description: message,
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
      }

      // DELETE /request/:requestUri - Delete PAR request
      if (path.startsWith('/request/') && request.method === 'DELETE') {
        const requestUri = decodeURIComponent(path.substring(9)); // Remove '/request/'
        const deleted = await this.deleteRequest(requestUri);

        return new Response(
          JSON.stringify({
            success: true,
            deleted,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // GET /request/:requestUri - Get PAR request info
      if (path.startsWith('/request/') && request.method === 'GET') {
        const requestUri = decodeURIComponent(path.substring(9));
        const data = await this.getRequest(requestUri);

        if (!data) {
          return new Response(
            JSON.stringify({
              error: 'not_found',
              error_description: 'Request not found or expired',
            }),
            {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        // Don't expose sensitive data in GET requests
        return new Response(
          JSON.stringify({
            client_id: data.client_id,
            createdAt: data.createdAt,
            expiresAt: data.expiresAt,
            consumed: data.consumed,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // GET /health - Health check
      if (path === '/health' && request.method === 'GET') {
        const now = Date.now();
        let activeCount = 0;

        for (const data of this.requests.values()) {
          if (!data.consumed && data.expiresAt && data.expiresAt > now) {
            activeCount++;
          }
        }

        return new Response(
          JSON.stringify({
            status: 'ok',
            requests: {
              total: this.requests.size,
              active: activeCount,
              consumed: this.requests.size - activeCount,
            },
            timestamp: now,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('PARRequestStore error:', error);
      return new Response(
        JSON.stringify({
          error: 'server_error',
          error_description: error instanceof Error ? error.message : 'Internal Server Error',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  }
}
