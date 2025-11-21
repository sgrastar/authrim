/**
 * CIBARequestStore Durable Object
 * OpenID Connect CIBA Flow Core 1.0
 * https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html
 *
 * Manages CIBA authentication requests with strong consistency guarantees:
 * - One-time token issuance (prevents replay)
 * - Immediate status updates (pending → approved/denied)
 * - Polling rate limiting (slow_down detection)
 * - Support for poll, ping, and push delivery modes
 *
 * Storage Strategy:
 * - In-memory cache for hot data (active CIBA requests)
 * - D1 for persistence and recovery
 * - Auth req ID → Request metadata mapping
 */

import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env } from '../types/env';
import type { CIBARequestMetadata } from '../types/oidc';
import { isCIBARequestExpired, CIBA_CONSTANTS } from '../utils/ciba';

export class CIBARequestStore {
  private state: DurableObjectState;
  private env: Env;

  // In-memory storage for active CIBA requests
  private cibaRequests: Map<string, CIBARequestMetadata> = new Map();
  // User code → Auth req ID mapping (if user_code is used)
  private userCodeToAuthReqId: Map<string, string> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /**
   * Handle HTTP requests to the Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Store CIBA request
      if (path === '/store' && request.method === 'POST') {
        const metadata: CIBARequestMetadata = await request.json();
        await this.storeCIBARequest(metadata);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Get CIBA request by auth_req_id
      if (path === '/get-by-auth-req-id' && request.method === 'POST') {
        const { auth_req_id } = (await request.json()) as { auth_req_id: string };
        const metadata = await this.getByAuthReqId(auth_req_id);
        return new Response(JSON.stringify(metadata), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Get CIBA request by user_code
      if (path === '/get-by-user-code' && request.method === 'POST') {
        const { user_code } = (await request.json()) as { user_code: string };
        const metadata = await this.getByUserCode(user_code);
        return new Response(JSON.stringify(metadata), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Get CIBA request by login_hint
      if (path === '/get-by-login-hint' && request.method === 'POST') {
        const { login_hint, client_id } = (await request.json()) as {
          login_hint: string;
          client_id: string;
        };
        const metadata = await this.getByLoginHint(login_hint, client_id);
        return new Response(JSON.stringify(metadata), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Approve CIBA request (user approved the request)
      if (path === '/approve' && request.method === 'POST') {
        const { auth_req_id, user_id, sub, nonce } = (await request.json()) as {
          auth_req_id: string;
          user_id: string;
          sub: string;
          nonce?: string;
        };
        await this.approveCIBARequest(auth_req_id, user_id, sub, nonce);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Deny CIBA request (user denied the request)
      if (path === '/deny' && request.method === 'POST') {
        const { auth_req_id } = (await request.json()) as { auth_req_id: string };
        await this.denyCIBARequest(auth_req_id);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Update last poll time (for rate limiting)
      if (path === '/update-poll' && request.method === 'POST') {
        const { auth_req_id } = (await request.json()) as { auth_req_id: string };
        await this.updatePollTime(auth_req_id);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Mark tokens as issued (one-time use)
      if (path === '/mark-token-issued' && request.method === 'POST') {
        const { auth_req_id } = (await request.json()) as { auth_req_id: string };
        await this.markTokenIssued(auth_req_id);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Delete CIBA request (consumed or expired)
      if (path === '/delete' && request.method === 'POST') {
        const { auth_req_id } = (await request.json()) as { auth_req_id: string };
        await this.deleteCIBARequest(auth_req_id);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('CIBARequestStore error:', error);
      return new Response(
        JSON.stringify({
          error: 'internal_error',
          error_description: error instanceof Error ? error.message : 'Unknown error',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  }

  /**
   * Store a new CIBA request
   */
  private async storeCIBARequest(metadata: CIBARequestMetadata): Promise<void> {
    // Store in memory
    this.cibaRequests.set(metadata.auth_req_id, metadata);
    if (metadata.user_code) {
      this.userCodeToAuthReqId.set(metadata.user_code, metadata.auth_req_id);
    }

    // Persist to D1
    if (this.env.DB) {
      await this.env.DB.prepare(
        `INSERT INTO ciba_requests (
          auth_req_id, client_id, scope, login_hint, login_hint_token, id_token_hint,
          binding_message, user_code, acr_values, requested_expiry, status, delivery_mode,
          client_notification_token, client_notification_endpoint, created_at, expires_at,
          poll_count, interval, nonce, token_issued
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          metadata.auth_req_id,
          metadata.client_id,
          metadata.scope,
          metadata.login_hint || null,
          metadata.login_hint_token || null,
          metadata.id_token_hint || null,
          metadata.binding_message || null,
          metadata.user_code || null,
          metadata.acr_values || null,
          metadata.requested_expiry || null,
          metadata.status,
          metadata.delivery_mode,
          metadata.client_notification_token || null,
          metadata.client_notification_endpoint || null,
          metadata.created_at,
          metadata.expires_at,
          metadata.poll_count || 0,
          metadata.interval,
          metadata.nonce || null,
          metadata.token_issued ? 1 : 0
        )
        .run();
    }

    // Set expiration alarm to clean up expired requests
    const expiresIn = metadata.expires_at - Date.now();
    if (expiresIn > 0) {
      await this.state.storage.setAlarm(Date.now() + expiresIn);
    }
  }

  /**
   * Get CIBA request metadata by auth_req_id
   */
  private async getByAuthReqId(authReqId: string): Promise<CIBARequestMetadata | null> {
    // Check in-memory cache first
    let metadata = this.cibaRequests.get(authReqId);

    if (metadata) {
      // Check if expired
      if (isCIBARequestExpired(metadata)) {
        await this.deleteCIBARequest(authReqId);
        return null;
      }
      return metadata;
    }

    // Fallback to D1
    if (this.env.DB) {
      const result = await this.env.DB.prepare(
        'SELECT * FROM ciba_requests WHERE auth_req_id = ?'
      )
        .bind(authReqId)
        .first<CIBARequestMetadata & { token_issued: number }>();

      if (result) {
        // Check if expired
        if (isCIBARequestExpired(result)) {
          await this.deleteCIBARequest(authReqId);
          return null;
        }

        // Convert token_issued from integer to boolean
        const metadata: CIBARequestMetadata = {
          ...result,
          token_issued: result.token_issued === 1,
        };

        // Warm up cache
        this.cibaRequests.set(authReqId, metadata);
        if (metadata.user_code) {
          this.userCodeToAuthReqId.set(metadata.user_code, authReqId);
        }
        return metadata;
      }
    }

    return null;
  }

  /**
   * Get CIBA request metadata by user_code
   */
  private async getByUserCode(userCode: string): Promise<CIBARequestMetadata | null> {
    // Check mapping first
    const authReqId = this.userCodeToAuthReqId.get(userCode);

    if (authReqId) {
      return this.getByAuthReqId(authReqId);
    }

    // Fallback to D1
    if (this.env.DB) {
      const result = await this.env.DB.prepare('SELECT * FROM ciba_requests WHERE user_code = ?')
        .bind(userCode)
        .first<CIBARequestMetadata & { token_issued: number }>();

      if (result) {
        // Check if expired
        if (isCIBARequestExpired(result)) {
          await this.deleteCIBARequest(result.auth_req_id);
          return null;
        }

        // Convert token_issued from integer to boolean
        const metadata: CIBARequestMetadata = {
          ...result,
          token_issued: result.token_issued === 1,
        };

        // Warm up cache
        this.cibaRequests.set(result.auth_req_id, metadata);
        this.userCodeToAuthReqId.set(userCode, result.auth_req_id);
        return metadata;
      }
    }

    return null;
  }

  /**
   * Get CIBA request by login_hint (for finding pending requests for a user)
   */
  private async getByLoginHint(
    loginHint: string,
    clientId: string
  ): Promise<CIBARequestMetadata | null> {
    // Check in-memory cache
    for (const [, metadata] of this.cibaRequests) {
      if (
        metadata.login_hint === loginHint &&
        metadata.client_id === clientId &&
        metadata.status === 'pending' &&
        !isCIBARequestExpired(metadata)
      ) {
        return metadata;
      }
    }

    // Fallback to D1
    if (this.env.DB) {
      const result = await this.env.DB.prepare(
        `SELECT * FROM ciba_requests
         WHERE login_hint = ? AND client_id = ? AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`
      )
        .bind(loginHint, clientId)
        .first<CIBARequestMetadata & { token_issued: number }>();

      if (result) {
        // Check if expired
        if (isCIBARequestExpired(result)) {
          await this.deleteCIBARequest(result.auth_req_id);
          return null;
        }

        // Convert token_issued from integer to boolean
        const metadata: CIBARequestMetadata = {
          ...result,
          token_issued: result.token_issued === 1,
        };

        // Warm up cache
        this.cibaRequests.set(result.auth_req_id, metadata);
        if (metadata.user_code) {
          this.userCodeToAuthReqId.set(metadata.user_code, result.auth_req_id);
        }
        return metadata;
      }
    }

    return null;
  }

  /**
   * Approve CIBA request (user approved the authorization request)
   */
  private async approveCIBARequest(
    authReqId: string,
    userId: string,
    sub: string,
    nonce?: string
  ): Promise<void> {
    const metadata = await this.getByAuthReqId(authReqId);

    if (!metadata) {
      throw new Error('CIBA request not found');
    }

    if (isCIBARequestExpired(metadata)) {
      throw new Error('CIBA request expired');
    }

    if (metadata.status !== 'pending') {
      throw new Error(`CIBA request already ${metadata.status}`);
    }

    // Update status to approved
    metadata.status = 'approved';
    metadata.user_id = userId;
    metadata.sub = sub;
    if (nonce) {
      metadata.nonce = nonce;
    }

    // Update in memory
    this.cibaRequests.set(authReqId, metadata);

    // Update in D1
    if (this.env.DB) {
      await this.env.DB.prepare(
        `UPDATE ciba_requests
         SET status = ?, user_id = ?, sub = ?, nonce = ?
         WHERE auth_req_id = ?`
      )
        .bind('approved', userId, sub, nonce || null, authReqId)
        .run();
    }
  }

  /**
   * Deny CIBA request (user denied the authorization request)
   */
  private async denyCIBARequest(authReqId: string): Promise<void> {
    const metadata = await this.getByAuthReqId(authReqId);

    if (!metadata) {
      throw new Error('CIBA request not found');
    }

    if (metadata.status !== 'pending') {
      throw new Error(`CIBA request already ${metadata.status}`);
    }

    // Update status to denied
    metadata.status = 'denied';

    // Update in memory
    this.cibaRequests.set(authReqId, metadata);

    // Update in D1
    if (this.env.DB) {
      await this.env.DB.prepare('UPDATE ciba_requests SET status = ? WHERE auth_req_id = ?')
        .bind('denied', authReqId)
        .run();
    }
  }

  /**
   * Update last poll time (for rate limiting)
   */
  private async updatePollTime(authReqId: string): Promise<void> {
    const metadata = await this.getByAuthReqId(authReqId);

    if (!metadata) {
      throw new Error('CIBA request not found');
    }

    // Update poll tracking
    metadata.last_poll_at = Date.now();
    metadata.poll_count = (metadata.poll_count || 0) + 1;

    // Update in memory
    this.cibaRequests.set(authReqId, metadata);

    // Update in D1 (periodic update to reduce writes)
    // Only update every 5 polls to reduce D1 load
    if (metadata.poll_count % 5 === 0 && this.env.DB) {
      await this.env.DB.prepare(
        'UPDATE ciba_requests SET last_poll_at = ?, poll_count = ? WHERE auth_req_id = ?'
      )
        .bind(metadata.last_poll_at, metadata.poll_count, authReqId)
        .run();
    }
  }

  /**
   * Mark tokens as issued (one-time use enforcement)
   */
  private async markTokenIssued(authReqId: string): Promise<void> {
    const metadata = await this.getByAuthReqId(authReqId);

    if (!metadata) {
      throw new Error('CIBA request not found');
    }

    if (metadata.token_issued) {
      throw new Error('Tokens already issued for this CIBA request');
    }

    // Mark as issued
    metadata.token_issued = true;
    metadata.token_issued_at = Date.now();

    // Update in memory
    this.cibaRequests.set(authReqId, metadata);

    // Update in D1
    if (this.env.DB) {
      await this.env.DB.prepare(
        'UPDATE ciba_requests SET token_issued = ?, token_issued_at = ? WHERE auth_req_id = ?'
      )
        .bind(1, metadata.token_issued_at, authReqId)
        .run();
    }
  }

  /**
   * Delete CIBA request (consumed or expired)
   */
  private async deleteCIBARequest(authReqId: string): Promise<void> {
    const metadata = this.cibaRequests.get(authReqId);

    if (metadata) {
      // Remove from in-memory storage
      this.cibaRequests.delete(authReqId);
      if (metadata.user_code) {
        this.userCodeToAuthReqId.delete(metadata.user_code);
      }
    }

    // Delete from D1
    if (this.env.DB) {
      await this.env.DB.prepare('DELETE FROM ciba_requests WHERE auth_req_id = ?')
        .bind(authReqId)
        .run();
    }
  }

  /**
   * Alarm handler for cleaning up expired CIBA requests
   */
  async alarm(): Promise<void> {
    console.log('CIBARequestStore alarm: Cleaning up expired CIBA requests');

    const now = Date.now();
    const expiredRequests: string[] = [];

    // Find expired requests in memory
    for (const [authReqId, metadata] of this.cibaRequests.entries()) {
      if (isCIBARequestExpired(metadata)) {
        expiredRequests.push(authReqId);
      }
    }

    // Delete expired requests
    for (const authReqId of expiredRequests) {
      await this.deleteCIBARequest(authReqId);
    }

    // Clean up expired requests in D1
    if (this.env.DB) {
      await this.env.DB.prepare('DELETE FROM ciba_requests WHERE expires_at < ?').bind(now).run();
    }

    console.log(`CIBARequestStore: Cleaned up ${expiredRequests.length} expired CIBA requests`);

    // Schedule next cleanup (every 5 minutes)
    await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
  }
}
