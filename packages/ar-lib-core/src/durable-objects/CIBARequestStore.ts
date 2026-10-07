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
 * - Structured operational logging without external persistence coupling
 *
 * Storage Strategy:
 * - Durable Storage as primary (for atomic operations)
 * - In-memory cache for hot data (active CIBA requests)
 * - Dual mapping: auth_req_id → metadata, user_code → auth_req_id
 */

import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env } from '../types/env';
import type { CIBARequestMetadata } from '../types/oidc';
import { isCIBARequestExpired } from '../utils/ciba';
import { createLogger, type Logger } from '../utils/logger';

/**
 * CIBA Request V2 - Enhanced state for V2 architecture
 * Extends CIBARequestMetadata with any V2-specific additions
 */
export interface CIBARequestV2 extends CIBARequestMetadata {
  // CIBARequestMetadata already has token_issued and token_issued_at
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

/**
 * Storage key prefixes
 */
const STORAGE_PREFIX = {
  REQUEST: 'r:', // r:{auth_req_id} → CIBARequestV2
  USER: 'u:', // u:{user_code} → auth_req_id (mapping)
  META: 'm:', // m:initialized → boolean
  // Who a pending request is addressed to, for the approval page's list:
  PENDING_SUBJECT: 'ps:', // ps:{sha256(resolved_subject_id)}:{auth_req_id} → auth_req_id
  PENDING_HINT: 'ph:', // ph:{sha256(normalized login_hint)}:{auth_req_id} → auth_req_id
} as const;

/** The most requests one user's pending list returns. */
const PENDING_LIST_LIMIT = 50;

/** The most index entries one pending list reads per address before giving up on more. */
const PENDING_INDEX_READ_LIMIT = 200;

/** Durable Storage takes at most 128 keys in one get, put, or delete. */
const STORAGE_BATCH_LIMIT = 128;

function chunks<T>(items: readonly T[], size = STORAGE_BATCH_LIMIT): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

/** Returned while the pending-address index could not be brought up to date. */
export class PendingIndexUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('ciba_pending_index_unavailable', { cause });
    this.name = 'PendingIndexUnavailableError';
  }
}

function normalizeLoginHint(loginHint: string): string {
  return loginHint.trim().toLowerCase();
}

function isWellFormedUnicode(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The fixed-length index segment of an address: the SHA-256 hex digest of the (already
 * normalized) value, so a key stays small however long the hint, or null for a value that is not
 * well-formed Unicode (TextEncoder would silently replace its lone surrogates). The digest only
 * narrows a read: every listed request is checked against its own stored address.
 */
async function addressDigest(value: string): Promise<string | null> {
  if (!isWellFormedUnicode(value)) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function subjectIndexPrefix(subject: string): Promise<string | null> {
  const digest = await addressDigest(subject);
  return digest ? `${STORAGE_PREFIX.PENDING_SUBJECT}${digest}:` : null;
}

async function hintIndexPrefix(loginHint: string): Promise<string | null> {
  const digest = await addressDigest(normalizeLoginHint(loginHint));
  return digest ? `${STORAGE_PREFIX.PENDING_HINT}${digest}:` : null;
}

/**
 * The pending-address index key of a request: by the subject resolved from a signed hint, or
 * failing that by its normalized login_hint. Null when it names neither, or names it with a value
 * that is not well-formed Unicode: such a request is never listed.
 */
async function pendingIndexKey(metadata: CIBARequestMetadata): Promise<string | null> {
  const prefix = metadata.resolved_subject_id
    ? await subjectIndexPrefix(metadata.resolved_subject_id)
    : metadata.login_hint
      ? await hintIndexPrefix(metadata.login_hint)
      : null;
  return prefix ? `${prefix}${metadata.auth_req_id}` : null;
}

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
  private readonly log: Logger = createLogger().module('CIBARequestStore');

  // In-memory storage for active CIBA requests
  private cibaRequests: Map<string, CIBARequestV2> = new Map();
  // User code → Auth req ID mapping (if user_code is used)
  private userCodeToAuthReqId: Map<string, string> = new Map();

  // V2: Initialization state
  private initialized: boolean = false;

  /** Whether the stored requests were loaded (the backfill below needs all of them). */
  private requestsLoaded = false;

  /** Whether every loaded pending request is in the pending-address index. */
  private pendingIndexReady = false;

  private tenantId: string | null = null;

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
      await this.loadRequests();

      // Load user code mappings
      const userMappings = await this.state.storage.list<string>({
        prefix: STORAGE_PREFIX.USER,
      });

      for (const [key, authReqId] of userMappings) {
        const userCode = key.substring(STORAGE_PREFIX.USER.length);
        this.userCodeToAuthReqId.set(userCode, authReqId);
      }

      this.log.info('Loaded requests and user mappings', {
        requestCount: this.cibaRequests.size,
        userMappingCount: this.userCodeToAuthReqId.size,
      });
      // Backfill: requests stored before the pending-address index existed. The full list above
      // is read on every start anyway; this adds batched reads and, only for missing entries,
      // batched writes. A failure leaves the index marked not ready: the pending list then
      // retries and answers 503 rather than an incomplete list. Other operations are unaffected.
      await this.ensurePendingIndex();
    } catch (error) {
      this.log.error('Failed to initialize', {}, error as Error);
    }

    this.initialized = true;
  }

  /** Load every stored request into memory (startup, or a retry after a failed startup load). */
  private async loadRequests(): Promise<void> {
    const requestEntries = await this.state.storage.list<CIBARequestV2>({
      prefix: STORAGE_PREFIX.REQUEST,
    });
    for (const [key, metadata] of requestEntries) {
      const authReqId = key.substring(STORAGE_PREFIX.REQUEST.length);
      if (!this.cibaRequests.has(authReqId)) {
        this.cibaRequests.set(authReqId, metadata);
      }
      if (!this.tenantId && metadata.tenant_id) {
        this.tenantId = metadata.tenant_id;
      }
    }
    this.requestsLoaded = true;
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
    this.log.warn('initializeState called but not initialized - this should not happen');
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
   * Save a request that is no longer pending and drop its pending-address index entry. Both are
   * issued without an await between them, so Durable Objects commit them as one atomic write.
   */
  private async saveDecidedRequest(authReqId: string, metadata: CIBARequestV2): Promise<void> {
    // The key is computed first; the two writes then go out with no await between them.
    const indexKey = await this.indexKeyOf(metadata);
    const writes: Promise<unknown>[] = [
      this.state.storage.put(this.buildRequestKey(authReqId), metadata),
    ];
    if (indexKey) {
      writes.push(this.state.storage.delete(indexKey));
    }
    await Promise.all(writes);
  }

  /**
   * Save user code mapping to Durable Storage
   */
  private async saveUserMapping(userCode: string, authReqId: string): Promise<void> {
    const key = this.buildUserKey(userCode);
    await this.state.storage.put(key, authReqId);
  }

  /**
   * The index key of a request, or null when it has none or its address is not well-formed
   * Unicode: such a request is stored but never listed, and is logged.
   */
  private async indexKeyOf(metadata: CIBARequestMetadata): Promise<string | null> {
    const key = await pendingIndexKey(metadata);
    if (!key && (metadata.resolved_subject_id || metadata.login_hint)) {
      this.log.warn('CIBA request address cannot be indexed; it will not be listed', {
        authReqId: metadata.auth_req_id,
      });
    }
    return key;
  }

  /** Index every loaded pending, unexpired request that has no index entry yet. */
  private async backfillPendingIndex(): Promise<void> {
    const wanted = new Map<string, string>();
    for (const metadata of this.cibaRequests.values()) {
      // State and expiry first: a decided or expired request needs no key at all.
      if (metadata.status !== 'pending' || isCIBARequestExpired(metadata)) continue;
      const key = await this.indexKeyOf(metadata);
      if (key) wanted.set(key, metadata.auth_req_id);
    }
    for (const keys of chunks([...wanted.keys()])) {
      const present = await this.state.storage.get<string>(keys);
      const missing = Object.fromEntries(
        keys.filter((key) => !present.has(key)).map((key) => [key, wanted.get(key)!])
      );
      if (Object.keys(missing).length > 0) {
        await this.state.storage.put(missing);
      }
    }
  }

  /** Bring the pending-address index up to date once; remember failure for a later retry. */
  private async ensurePendingIndex(): Promise<void> {
    if (this.pendingIndexReady) return;
    try {
      // An empty map after a failed load is not "nothing to migrate": load first.
      if (!this.requestsLoaded) {
        await this.loadRequests();
      }
      await this.backfillPendingIndex();
      this.pendingIndexReady = true;
    } catch (error) {
      this.log.error('Failed to backfill the CIBA pending-address index', {}, error as Error);
      throw new PendingIndexUnavailableError(error);
    }
  }

  /**
   * Delete CIBA request from Durable Storage
   */
  private async deleteRequestFromStorage(
    authReqId: string,
    userCode?: string,
    metadata?: CIBARequestMetadata
  ): Promise<void> {
    const keysToDelete = [this.buildRequestKey(authReqId)];
    if (userCode) {
      keysToDelete.push(this.buildUserKey(userCode));
    }
    const indexKey = metadata ? await this.indexKeyOf(metadata) : null;
    if (indexKey) {
      keysToDelete.push(indexKey);
    }
    await this.state.storage.delete(keysToDelete);
  }

  /**
   * Handle HTTP requests to the Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    await this.initializeState();
    this.configureTenantFromRequest(request);

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

      // List the pending requests addressed to one end user (the CIBA approval page)
      if (path === '/list-pending-for-user' && request.method === 'POST') {
        const body = (await request.json()) as {
          subject_ids?: unknown;
          login_hints?: unknown;
        };
        let requests: CIBARequestV2[];
        try {
          requests = await this.listPendingForUser({
            subjectIds: stringList(body.subject_ids),
            loginHints: stringList(body.login_hints),
          });
        } catch (error) {
          if (!(error instanceof PendingIndexUnavailableError)) throw error;
          // Never an incomplete list: the caller answers "try again".
          return new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
          });
        }
        return new Response(JSON.stringify({ requests }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Approve CIBA request (user approved the request)
      if (path === '/approve' && request.method === 'POST') {
        const { auth_req_id, user_id, sub, nonce, authenticated_acr, consent_generation } =
          (await request.json()) as {
            auth_req_id: string;
            user_id: string;
            sub: string;
            nonce?: string;
            authenticated_acr?: string;
            consent_generation?: number;
          };
        await this.approveCIBARequest(
          auth_req_id,
          user_id,
          sub,
          nonce,
          authenticated_acr,
          consent_generation
        );
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
      // Log full error for debugging but don't expose to client
      this.log.error('Request handling error', {}, error as Error);
      // SECURITY: Do not expose internal error details in response
      return new Response(
        JSON.stringify({
          error: 'server_error',
          error_description: 'Internal server error',
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
    if (metadata.tenant_id) {
      this.setTenantId(metadata.tenant_id);
    }

    const v2Metadata: CIBARequestV2 = {
      ...metadata,
      ...(this.tenantId ? { tenant_id: this.tenantId } : {}),
      token_issued: metadata.token_issued ?? false,
    };

    // Store in memory
    this.cibaRequests.set(metadata.auth_req_id, v2Metadata);
    if (metadata.user_code) {
      this.userCodeToAuthReqId.set(metadata.user_code, metadata.auth_req_id);
    }

    // V2: Persist to Durable Storage (primary), with its pending-address index entry in the
    // same write.
    const indexKey =
      v2Metadata.status === 'pending' && !isCIBARequestExpired(v2Metadata)
        ? await this.indexKeyOf(v2Metadata)
        : null;
    await this.state.storage.put({
      [this.buildRequestKey(metadata.auth_req_id)]: v2Metadata,
      ...(indexKey ? { [indexKey]: metadata.auth_req_id } : {}),
    });
    if (metadata.user_code) {
      await this.saveUserMapping(metadata.user_code, metadata.auth_req_id);
    }

    this.logEvent({
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
      // Keep the earliest pending expiry: a later request must not push an earlier one's cleanup
      // (and its index entry) back.
      const expiresAt = Date.now() + expiresIn;
      const scheduled = await this.state.storage.getAlarm();
      if (scheduled === null || scheduled > expiresAt) {
        await this.state.storage.setAlarm(expiresAt);
      }
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

    return null;
  }

  /**
   * The pending, unexpired requests addressed to one end user (at most PENDING_LIST_LIMIT), read
   * from Durable Storage through the pending-address index: only that user's index entries and
   * requests are read, however many requests the tenant holds. Entries of requests that were
   * decided meanwhile are dropped here; deletion and expiry remove an entry with its request.
   *
   * The caller derives the identifiers from the authenticated session, never from request
   * parameters. A request names its user by the subject resolved from a signed hint or, failing
   * that, by its login_hint; a request naming neither is never listed.
   */
  private async listPendingForUser(input: {
    subjectIds: string[];
    loginHints: string[];
  }): Promise<CIBARequestV2[]> {
    await this.ensurePendingIndex();
    const subjectIds = new Set(input.subjectIds);
    const loginHints = new Set(input.loginHints.map(normalizeLoginHint));
    const prefixes = (
      await Promise.all([
        ...[...subjectIds].map(subjectIndexPrefix),
        ...[...loginHints].map(hintIndexPrefix),
      ])
    ).filter((prefix): prefix is string => prefix !== null);

    const matches = new Map<string, CIBARequestV2>();
    const stale: string[] = [];
    let exhausted = false;
    for (const prefix of prefixes) {
      // Read this address's entries page by page until enough valid requests are found. Entries
      // of requests decided or expired meanwhile are skipped (and dropped below), so they can
      // never hide a pending request behind them.
      let startAfter: string | undefined;
      let read = 0;
      while (matches.size < PENDING_LIST_LIMIT && read < PENDING_INDEX_READ_LIMIT) {
        const page = await this.state.storage.list<string>({
          prefix,
          limit: Math.min(PENDING_LIST_LIMIT, PENDING_INDEX_READ_LIMIT - read),
          ...(startAfter ? { startAfter } : {}),
        });
        if (page.size === 0) break;
        read += page.size;
        const entries = [...page];
        startAfter = entries[entries.length - 1][0];
        const requests = await this.state.storage.get<CIBARequestV2>(
          entries.map(([, authReqId]) => this.buildRequestKey(authReqId))
        );
        for (const [indexKey, authReqId] of entries) {
          const metadata = requests.get(this.buildRequestKey(authReqId));
          if (!metadata || metadata.status !== 'pending' || isCIBARequestExpired(metadata)) {
            stale.push(indexKey);
            continue;
          }
          // The index only narrows the read; the request itself decides who it is addressed to.
          const addressed = metadata.resolved_subject_id
            ? subjectIds.has(metadata.resolved_subject_id)
            : Boolean(metadata.login_hint) &&
              loginHints.has(normalizeLoginHint(metadata.login_hint!));
          if (addressed && matches.size < PENDING_LIST_LIMIT) {
            matches.set(authReqId, metadata);
          }
        }
        if (page.size < PENDING_LIST_LIMIT) {
          startAfter = undefined;
          break;
        }
      }
      // The read budget ran out short of a full list: if entries remain unread, the list would
      // be incomplete.
      if (
        startAfter !== undefined &&
        read >= PENDING_INDEX_READ_LIMIT &&
        matches.size < PENDING_LIST_LIMIT
      ) {
        const rest = await this.state.storage.list<string>({ prefix, startAfter, limit: 1 });
        if (rest.size > 0) exhausted = true;
      }
    }
    for (const keys of chunks(stale)) {
      await this.state.storage.delete(keys);
    }
    if (exhausted) {
      // The leftovers read here are gone now, so a retry gets further.
      throw new PendingIndexUnavailableError();
    }
    return [...matches.values()].sort((left, right) => left.created_at - right.created_at);
  }

  /**
   * Approve CIBA request (user approved the authorization request)
   */
  private async approveCIBARequest(
    authReqId: string,
    userId: string,
    sub: string,
    nonce?: string,
    authenticatedAcr?: string,
    consentGeneration?: number
  ): Promise<void> {
    if (
      consentGeneration !== undefined &&
      (!Number.isSafeInteger(consentGeneration) || consentGeneration < 0)
    ) {
      throw new Error('Invalid consent generation');
    }
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
    if (authenticatedAcr) {
      metadata.authenticated_acr = authenticatedAcr;
    }
    if (consentGeneration !== undefined) {
      metadata.consent_generation = consentGeneration;
    }

    // Update in memory
    this.cibaRequests.set(authReqId, metadata);

    // V2: Update in Durable Storage, leaving the pending-address index in the same write
    await this.saveDecidedRequest(authReqId, metadata);

    this.logEvent({
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

    // V2: Update in Durable Storage, leaving the pending-address index in the same write
    await this.saveDecidedRequest(authReqId, metadata);

    this.logEvent({
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

    this.logEvent({
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
    const metadata =
      this.cibaRequests.get(authReqId) ??
      (await this.state.storage.get<CIBARequestV2>(this.buildRequestKey(authReqId)));
    const userCode = metadata?.user_code;

    // Remove from in-memory storage
    this.cibaRequests.delete(authReqId);
    if (userCode) {
      this.userCodeToAuthReqId.delete(userCode);
    }

    // V2: Delete from Durable Storage (with its pending-address index entry)
    await this.deleteRequestFromStorage(authReqId, userCode, metadata);
  }

  private logEvent(entry: AuditLogEntry): void {
    this.log.info('CIBA state changed', {
      action: `ciba.${entry.action}`,
      tenantId: this.tenantId ?? 'unknown',
      authReqId: entry.authReqId,
      clientId: entry.clientId,
      userId: entry.userId,
      ...entry.metadata,
    });
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
      this.log.info('Skipping duplicate alarm execution', {
        secondsSinceLastCleanup: Math.round(timeSinceLastCleanup / 1000),
      });
      // Reschedule to the correct time
      await this.state.storage.setAlarm(lastCleanup + CLEANUP_INTERVAL_MS);
      return;
    }

    this.log.info('Cleaning up expired CIBA requests');

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
      this.logEvent({
        action: 'ciba_request_expired',
        authReqId: authReqId,
        timestamp: now,
      });
    }

    this.log.info('Cleaned up expired CIBA requests', { count: expiredRequests.length });

    // Record successful cleanup for idempotency
    await this.state.storage.put(lastCleanupKey, Date.now());

    // Schedule next cleanup
    await this.state.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
  }

  private configureTenantFromRequest(request: Request): void {
    const tenantId = request.headers.get('X-Authrim-Tenant-Id')?.trim();
    if (tenantId) {
      this.setTenantId(tenantId);
    }
  }

  private setTenantId(tenantId: string): void {
    if (this.tenantId === tenantId) {
      return;
    }

    this.tenantId = tenantId;
  }
}
