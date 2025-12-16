/**
 * CIBARequestStore Durable Object (V2)
 * OpenID Connect CIBA Flow Core 1.0
 * https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html
 *
 * Manages CIBA authentication requests with strong consistency guarantees:
 * - One-time token issuance (prevents replay)
 * - Immediate status updates (pending → approved/denied)
 * - Polling rate limiting (slow_down detection)
 * - Support for poll, ping, and push delivery modes
 *
 * V2 Architecture:
 * - Explicit initialization with Durable Storage bulk load
 * - Granular storage with prefix-based keys
 * - Audit logging with batch flush and synchronous critical events
 * - D1 retry for improved reliability
 *
 * Storage Strategy:
 * - Durable Storage as primary (for atomic operations)
 * - In-memory cache for hot data (active CIBA requests)
 * - D1 for persistence, recovery, and audit trail
 * - Dual mapping: auth_req_id → metadata, user_code → auth_req_id
 */

import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env } from '../types/env';
import type { CIBARequestMetadata, CIBARequestRow } from '../types/oidc';
import { isCIBARequestExpired } from '../utils/ciba';
import { retryD1Operation } from '../utils/d1-retry';

/**
 * CIBA Request V2 - Enhanced state for V2 architecture
 * Extends CIBARequestMetadata with any V2-specific additions
 */
export interface CIBARequestV2 extends CIBARequestMetadata {
  // CIBARequestMetadata already has token_issued and token_issued_at
}

/**
 * Storage key prefixes
 */
const STORAGE_PREFIX = {
  REQUEST: 'r:', // r:{auth_req_id} → CIBARequestV2
  USER: 'u:', // u:{user_code} → auth_req_id (mapping)
  META: 'm:', // m:initialized → boolean
} as const;

/**
 * Audit log entry for CIBA events
 */
interface AuditLogEntry {
  action:
    | 'ciba_request_created'
    | 'ciba_request_approved'
    | 'ciba_request_denied'
    | 'ciba_request_expired'
    | 'ciba_token_issued'
    | 'ciba_slow_down';
  authReqId: string;
  userCode?: string;
  clientId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export class CIBARequestStore {
  private state: DurableObjectState;
  private env: Env;

  // In-memory storage for active CIBA requests
  private cibaRequests: Map<string, CIBARequestV2> = new Map();
  // User code → Auth req ID mapping (if user_code is used)
  private userCodeToAuthReqId: Map<string, string> = new Map();

  // V2: Initialization state
  private initialized: boolean = false;
  private initializePromise: Promise<void> | null = null;

  // V2: Async audit log buffering
  private pendingAuditLogs: AuditLogEntry[] = [];
  private flushScheduled: boolean = false;
  private readonly AUDIT_FLUSH_DELAY = 100; // ms

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Block all requests until initialization completes
    // This ensures the DO is in a consistent state before processing any requests
    // Critical for CIBA request verification and one-time token issuance
    state.blockConcurrencyWhile(async () => {
      await this.initializeStateBlocking();
    });
  }

  /**
   * Initialize state from Durable Storage
   * Called by blockConcurrencyWhile() in constructor
   */
  private async initializeStateBlocking(): Promise<void> {
    try {
      // Load all CIBA requests from granular storage
      const requestEntries = await this.state.storage.list<CIBARequestV2>({
        prefix: STORAGE_PREFIX.REQUEST,
      });

      for (const [key, metadata] of requestEntries) {
        const authReqId = key.substring(STORAGE_PREFIX.REQUEST.length);
        this.cibaRequests.set(authReqId, metadata);
      }

      // Load user code mappings
      const userMappings = await this.state.storage.list<string>({
        prefix: STORAGE_PREFIX.USER,
      });

      for (const [key, authReqId] of userMappings) {
        const userCode = key.substring(STORAGE_PREFIX.USER.length);
        this.userCodeToAuthReqId.set(userCode, authReqId);
      }

      console.log(
        `CIBARequestStore: Loaded ${this.cibaRequests.size} requests, ${this.userCodeToAuthReqId.size} user mappings`
      );
    } catch (error) {
      console.error('CIBARequestStore: Failed to initialize:', error);
    }

    this.initialized = true;
  }

  /**
   * Ensure state is initialized
   * Called by public methods for backward compatibility
   *
   * Note: With blockConcurrencyWhile() in constructor, this is now a no-op guard.
   */
  private async initializeState(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Safety fallback (should not happen with blockConcurrencyWhile)
    console.warn(
      'CIBARequestStore: initializeState called but not initialized - this should not happen'
    );
    await this.initializeStateBlocking();
  }

  /**
   * Build storage key for CIBA request
   */
  private buildRequestKey(authReqId: string): string {
    return `${STORAGE_PREFIX.REQUEST}${authReqId}`;
  }

  /**
   * Build storage key for user code mapping
   */
  private buildUserKey(userCode: string): string {
    return `${STORAGE_PREFIX.USER}${userCode}`;
  }

  /**
   * Save CIBA request to Durable Storage
   */
  private async saveRequest(authReqId: string, metadata: CIBARequestV2): Promise<void> {
    const key = this.buildRequestKey(authReqId);
    await this.state.storage.put(key, metadata);
  }

  /**
   * Save user code mapping to Durable Storage
   */
  private async saveUserMapping(userCode: string, authReqId: string): Promise<void> {
    const key = this.buildUserKey(userCode);
    await this.state.storage.put(key, authReqId);
  }

  /**
   * Delete CIBA request from Durable Storage
   */
  private async deleteRequestFromStorage(authReqId: string, userCode?: string): Promise<void> {
    const keysToDelete = [this.buildRequestKey(authReqId)];
    if (userCode) {
      keysToDelete.push(this.buildUserKey(userCode));
    }
    await this.state.storage.delete(keysToDelete);
  }

  /**
   * Handle HTTP requests to the Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    await this.initializeState();

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

      // V2: Status endpoint
      if (path === '/status' && request.method === 'GET') {
        const now = Date.now();
        let activeCount = 0;
        let pendingCount = 0;
        let approvedCount = 0;

        for (const metadata of this.cibaRequests.values()) {
          if (!isCIBARequestExpired(metadata)) {
            activeCount++;
            if (metadata.status === 'pending') pendingCount++;
            if (metadata.status === 'approved') approvedCount++;
          }
        }

        return new Response(
          JSON.stringify({
            status: 'ok',
            version: 'v2',
            requests: {
              total: this.cibaRequests.size,
              active: activeCount,
              pending: pendingCount,
              approved: approvedCount,
            },
            userMappings: this.userCodeToAuthReqId.size,
            timestamp: now,
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
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
    const v2Metadata: CIBARequestV2 = {
      ...metadata,
      token_issued: metadata.token_issued ?? false,
    };

    // Store in memory
    this.cibaRequests.set(metadata.auth_req_id, v2Metadata);
    if (metadata.user_code) {
      this.userCodeToAuthReqId.set(metadata.user_code, metadata.auth_req_id);
    }

    // V2: Persist to Durable Storage (primary)
    await this.saveRequest(metadata.auth_req_id, v2Metadata);
    if (metadata.user_code) {
      await this.saveUserMapping(metadata.user_code, metadata.auth_req_id);
    }

    // Persist to D1 (backup/audit)
    if (this.env.DB) {
      await retryD1Operation(
        async () => {
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
        },
        'CIBARequestStore.storeCIBARequest',
        { maxRetries: 3 }
      );
    }

    // V2: Audit log (non-critical, fire-and-forget)
    void this.logToD1({
      action: 'ciba_request_created',
      authReqId: metadata.auth_req_id,
      userCode: metadata.user_code,
      clientId: metadata.client_id,
      metadata: {
        scope: metadata.scope,
        delivery_mode: metadata.delivery_mode,
        login_hint: metadata.login_hint,
      },
      timestamp: Date.now(),
    });

    // Set expiration alarm to clean up expired requests
    const expiresIn = metadata.expires_at - Date.now();
    if (expiresIn > 0) {
      await this.state.storage.setAlarm(Date.now() + expiresIn);
    }
  }

  /**
   * Get CIBA request metadata by auth_req_id
   */
  private async getByAuthReqId(authReqId: string): Promise<CIBARequestV2 | null> {
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

    // V2: Fallback to Durable Storage
    const storedMetadata = await this.state.storage.get<CIBARequestV2>(
      this.buildRequestKey(authReqId)
    );

    if (storedMetadata) {
      // Check if expired
      if (isCIBARequestExpired(storedMetadata)) {
        await this.deleteCIBARequest(authReqId);
        return null;
      }

      // Warm up cache
      this.cibaRequests.set(authReqId, storedMetadata);
      if (storedMetadata.user_code) {
        this.userCodeToAuthReqId.set(storedMetadata.user_code, authReqId);
      }
      return storedMetadata;
    }

    // Fallback to D1 (for recovery after data loss)
    if (this.env.DB) {
      const result = await this.env.DB.prepare('SELECT * FROM ciba_requests WHERE auth_req_id = ?')
        .bind(authReqId)
        .first<CIBARequestRow>();

      if (result) {
        // Convert token_issued from integer to boolean
        const v2Metadata: CIBARequestV2 = {
          ...result,
          token_issued: result.token_issued === 1,
        };

        // Check if expired
        if (isCIBARequestExpired(v2Metadata)) {
          await this.deleteCIBARequest(authReqId);
          return null;
        }

        // Warm up cache and Durable Storage
        this.cibaRequests.set(authReqId, v2Metadata);
        if (v2Metadata.user_code) {
          this.userCodeToAuthReqId.set(v2Metadata.user_code, authReqId);
          await this.saveUserMapping(v2Metadata.user_code, authReqId);
        }
        await this.saveRequest(authReqId, v2Metadata);
        return v2Metadata;
      }
    }

    return null;
  }

  /**
   * Get CIBA request metadata by user_code
   */
  private async getByUserCode(userCode: string): Promise<CIBARequestV2 | null> {
    // Check mapping first
    let authReqId = this.userCodeToAuthReqId.get(userCode);

    if (!authReqId) {
      // Check Durable Storage
      authReqId = await this.state.storage.get<string>(this.buildUserKey(userCode));
    }

    if (authReqId) {
      return this.getByAuthReqId(authReqId);
    }

    // Fallback to D1 (for recovery)
    if (this.env.DB) {
      const result = await this.env.DB.prepare('SELECT * FROM ciba_requests WHERE user_code = ?')
        .bind(userCode)
        .first<CIBARequestRow>();

      if (result) {
        // Convert token_issued from integer to boolean
        const v2Metadata: CIBARequestV2 = {
          ...result,
          token_issued: result.token_issued === 1,
        };

        // Check if expired
        if (isCIBARequestExpired(v2Metadata)) {
          await this.deleteCIBARequest(result.auth_req_id);
          return null;
        }

        // Warm up cache and Durable Storage
        this.cibaRequests.set(result.auth_req_id, v2Metadata);
        this.userCodeToAuthReqId.set(userCode, result.auth_req_id);
        await this.saveRequest(result.auth_req_id, v2Metadata);
        await this.saveUserMapping(userCode, result.auth_req_id);
        return v2Metadata;
      }
    }

    return null;
  }

  /**
   * Get CIBA request by login_hint (for finding pending requests for a user)
   */
  private async getByLoginHint(loginHint: string, clientId: string): Promise<CIBARequestV2 | null> {
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
        .first<CIBARequestRow>();

      if (result) {
        // Convert token_issued from integer to boolean
        const v2Metadata: CIBARequestV2 = {
          ...result,
          token_issued: result.token_issued === 1,
        };

        // Check if expired
        if (isCIBARequestExpired(v2Metadata)) {
          await this.deleteCIBARequest(result.auth_req_id);
          return null;
        }

        // Warm up cache and Durable Storage
        this.cibaRequests.set(result.auth_req_id, v2Metadata);
        if (v2Metadata.user_code) {
          this.userCodeToAuthReqId.set(v2Metadata.user_code, result.auth_req_id);
          await this.saveUserMapping(v2Metadata.user_code, result.auth_req_id);
        }
        await this.saveRequest(result.auth_req_id, v2Metadata);
        return v2Metadata;
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

    // V2: Update in Durable Storage
    await this.saveRequest(authReqId, metadata);

    // Update in D1
    if (this.env.DB) {
      await retryD1Operation(
        async () => {
          await this.env.DB.prepare(
            `UPDATE ciba_requests
             SET status = ?, user_id = ?, sub = ?, nonce = ?
             WHERE auth_req_id = ?`
          )
            .bind('approved', userId, sub, nonce || null, authReqId)
            .run();
        },
        'CIBARequestStore.approveCIBARequest',
        { maxRetries: 3 }
      );
    }

    // V2: Audit log (critical - synchronous)
    await this.logCritical({
      action: 'ciba_request_approved',
      authReqId: authReqId,
      userCode: metadata.user_code,
      clientId: metadata.client_id,
      userId: userId,
      metadata: { sub, delivery_mode: metadata.delivery_mode },
      timestamp: Date.now(),
    });
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

    // V2: Update in Durable Storage
    await this.saveRequest(authReqId, metadata);

    // Update in D1
    if (this.env.DB) {
      await retryD1Operation(
        async () => {
          await this.env.DB.prepare('UPDATE ciba_requests SET status = ? WHERE auth_req_id = ?')
            .bind('denied', authReqId)
            .run();
        },
        'CIBARequestStore.denyCIBARequest',
        { maxRetries: 3 }
      );
    }

    // V2: Audit log (critical - synchronous)
    await this.logCritical({
      action: 'ciba_request_denied',
      authReqId: authReqId,
      userCode: metadata.user_code,
      clientId: metadata.client_id,
      timestamp: Date.now(),
    });
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

    // V2: Update in Durable Storage
    await this.saveRequest(authReqId, metadata);

    // Update in D1 (periodic update to reduce writes)
    // Only update every 5 polls to reduce D1 load
    if (metadata.poll_count % 5 === 0 && this.env.DB) {
      await retryD1Operation(
        async () => {
          await this.env.DB.prepare(
            'UPDATE ciba_requests SET last_poll_at = ?, poll_count = ? WHERE auth_req_id = ?'
          )
            .bind(metadata.last_poll_at, metadata.poll_count, authReqId)
            .run();
        },
        'CIBARequestStore.updatePollTime',
        { maxRetries: 2 }
      );
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

    if (metadata.status !== 'approved') {
      throw new Error('CIBA request not approved');
    }

    // Mark as issued
    metadata.token_issued = true;
    metadata.token_issued_at = Date.now();

    // Update in memory
    this.cibaRequests.set(authReqId, metadata);

    // V2: Update in Durable Storage
    await this.saveRequest(authReqId, metadata);

    // Update in D1
    if (this.env.DB) {
      await retryD1Operation(
        async () => {
          await this.env.DB.prepare(
            'UPDATE ciba_requests SET token_issued = ?, token_issued_at = ? WHERE auth_req_id = ?'
          )
            .bind(1, metadata.token_issued_at, authReqId)
            .run();
        },
        'CIBARequestStore.markTokenIssued',
        { maxRetries: 3 }
      );
    }

    // V2: Audit log (critical - synchronous)
    await this.logCritical({
      action: 'ciba_token_issued',
      authReqId: authReqId,
      userCode: metadata.user_code,
      clientId: metadata.client_id,
      userId: metadata.user_id,
      metadata: { delivery_mode: metadata.delivery_mode },
      timestamp: Date.now(),
    });
  }

  /**
   * Delete CIBA request (consumed or expired)
   */
  private async deleteCIBARequest(authReqId: string): Promise<void> {
    const metadata = this.cibaRequests.get(authReqId);
    const userCode = metadata?.user_code;

    // Remove from in-memory storage
    this.cibaRequests.delete(authReqId);
    if (userCode) {
      this.userCodeToAuthReqId.delete(userCode);
    }

    // V2: Delete from Durable Storage
    await this.deleteRequestFromStorage(authReqId, userCode);

    // Delete from D1
    if (this.env.DB) {
      await retryD1Operation(
        async () => {
          await this.env.DB.prepare('DELETE FROM ciba_requests WHERE auth_req_id = ?')
            .bind(authReqId)
            .run();
        },
        'CIBARequestStore.deleteCIBARequest',
        { maxRetries: 2 }
      );
    }
  }

  /**
   * Log non-critical events (batched, async) - V2
   */
  private async logToD1(entry: AuditLogEntry): Promise<void> {
    if (!this.env.DB) {
      return;
    }

    this.pendingAuditLogs.push(entry);
    this.scheduleAuditFlush();
  }

  /**
   * Log critical events synchronously - V2
   */
  private async logCritical(entry: AuditLogEntry): Promise<void> {
    if (!this.env.DB) {
      return;
    }

    await retryD1Operation(
      async () => {
        await this.env.DB.prepare(
          `INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            `audit_${crypto.randomUUID()}`,
            entry.userId || null,
            `ciba.${entry.action}`,
            'ciba_request',
            entry.authReqId,
            entry.metadata ? JSON.stringify(entry.metadata) : null,
            Math.floor(entry.timestamp / 1000)
          )
          .run();
      },
      'CIBARequestStore.logCritical',
      { maxRetries: 3 }
    );
  }

  /**
   * Schedule batch flush of audit logs - V2
   */
  private scheduleAuditFlush(): void {
    if (this.flushScheduled) {
      return;
    }

    this.flushScheduled = true;
    setTimeout(() => {
      void this.flushAuditLogs();
    }, this.AUDIT_FLUSH_DELAY);
  }

  /**
   * Flush pending audit logs to D1 - V2
   */
  private async flushAuditLogs(): Promise<void> {
    this.flushScheduled = false;

    if (this.pendingAuditLogs.length === 0 || !this.env.DB) {
      return;
    }

    const logsToFlush = [...this.pendingAuditLogs];
    this.pendingAuditLogs = [];

    try {
      const statements = logsToFlush.map((entry) =>
        this.env.DB.prepare(
          `INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          `audit_${crypto.randomUUID()}`,
          entry.userId || null,
          `ciba.${entry.action}`,
          'ciba_request',
          entry.authReqId,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
          Math.floor(entry.timestamp / 1000)
        )
      );

      await this.env.DB.batch(statements);
    } catch (error) {
      console.error('CIBARequestStore: Failed to flush audit logs:', error);
      // Re-queue (limited to prevent memory leak)
      if (this.pendingAuditLogs.length < 100) {
        this.pendingAuditLogs.push(...logsToFlush);
        this.scheduleAuditFlush();
      }
    }
  }

  /**
   * Alarm handler for cleaning up expired CIBA requests
   *
   * Implements idempotency to prevent duplicate execution:
   * - Stores last cleanup timestamp in meta storage
   * - Skips execution if within CLEANUP_INTERVAL - IDEMPOTENCY_BUFFER
   * - This prevents issues from alarm re-delivery or clock skew
   */
  async alarm(): Promise<void> {
    await this.initializeState();

    // Idempotency configuration
    const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    const IDEMPOTENCY_BUFFER_MS = 10 * 1000; // 10 seconds buffer
    const lastCleanupKey = `${STORAGE_PREFIX.META}lastCleanup`;

    // Check for duplicate execution
    const lastCleanup = (await this.state.storage.get<number>(lastCleanupKey)) || 0;
    const timeSinceLastCleanup = Date.now() - lastCleanup;

    if (timeSinceLastCleanup < CLEANUP_INTERVAL_MS - IDEMPOTENCY_BUFFER_MS) {
      console.log(
        `CIBARequestStore alarm: Skipping duplicate execution ` +
          `(last cleanup ${Math.round(timeSinceLastCleanup / 1000)}s ago)`
      );
      // Reschedule to the correct time
      await this.state.storage.setAlarm(lastCleanup + CLEANUP_INTERVAL_MS);
      return;
    }

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

      // Log expiration
      void this.logToD1({
        action: 'ciba_request_expired',
        authReqId: authReqId,
        timestamp: now,
      });
    }

    // Clean up expired requests in D1
    if (this.env.DB) {
      await retryD1Operation(
        async () => {
          await this.env.DB.prepare('DELETE FROM ciba_requests WHERE expires_at < ?')
            .bind(now)
            .run();
        },
        'CIBARequestStore.alarm.cleanup',
        { maxRetries: 2 }
      );
    }

    console.log(`CIBARequestStore: Cleaned up ${expiredRequests.length} expired CIBA requests`);

    // Record successful cleanup for idempotency
    await this.state.storage.put(lastCleanupKey, Date.now());

    // Schedule next cleanup
    await this.state.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
  }
}
