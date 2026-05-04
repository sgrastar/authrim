/**
 * SessionStore Durable Object
 *
 * Manages active user sessions with in-memory hot data and D1 database fallback.
 * Provides instant session invalidation and ITP-compatible session management.
 *
 * Storage Architecture (v2):
 * - Individual key storage: `session:${sessionId}` for each session
 * - O(1) reads/writes per session operation
 * - Sharding support: Multiple DO instances distribute load
 *
 * Hot/Cold Pattern:
 * 1. Active sessions stored in-memory for sub-millisecond access (hot)
 * 2. Cold sessions loaded from D1 database on demand
 * 3. Sessions promoted to hot storage on access
 * 4. Expired sessions cleaned up periodically
 *
 * Security Features:
 * - Instant session revocation (security requirement)
 * - Automatic expiration handling
 * - Multi-device session management
 * - Audit trail via D1 storage
 */
import { DurableObject } from 'cloudflare:workers';
import { retryD1Operation } from '../utils/d1-retry';
import { CloudflareActorContext } from '../actor';
import { createLogger } from '../utils/logger';
import { AUTH_CORE_PERSISTENCE_CONTEXT_KEY, resolveAuthCorePersistenceContextFromEnv, resolveAuthCorePersistenceSourceFromContext, } from '../services/auth-core-persistence-context';
import { createSessionPersistenceAdapter, } from '../services/session-persistence';
const log = createLogger().module('DO-SESSION-STORE');
/**
 * Storage key prefix for sessions
 */
const SESSION_KEY_PREFIX = 'session:';
/**
 * Storage key prefix for tombstones (deleted session markers)
 * Used to prevent D1 fallback from returning stale sessions after deletion
 */
const TOMBSTONE_KEY_PREFIX = 'tombstone:';
/**
 * Tombstone TTL in milliseconds (24 hours)
 * After this period, tombstones are automatically cleaned up
 */
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * SessionStore Durable Object
 *
 * Provides distributed session storage with strong consistency guarantees.
 * Uses individual key storage for O(1) operations.
 *
 * RPC Support:
 * - Extends DurableObject base class for RPC method exposure
 * - RPC methods have 'Rpc' suffix (e.g., getSessionRpc)
 * - fetch() handler is maintained for backward compatibility and debugging
 */
export class SessionStore extends DurableObject {
    sessionCache = new Map();
    cleanupInterval = null;
    actorCtx;
    sessionPersistence = null;
    sessionPersistenceInit = null;
    persistenceContext = null;
    constructor(ctx, env) {
        super(ctx, env);
        this.actorCtx = new CloudflareActorContext(ctx);
        // Start periodic cleanup
        this.startCleanup();
    }
    // ==========================================
    // RPC Methods (public, with 'Rpc' suffix)
    // ==========================================
    /**
     * RPC: Get session by ID
     */
    async getSessionRpc(sessionId) {
        return this.getSession(sessionId);
    }
    /**
     * RPC: Create new session
     */
    async createSessionRpc(sessionId, userId, ttl, data) {
        return this.createSession(sessionId, userId, ttl, data);
    }
    /**
     * RPC: Invalidate session immediately
     */
    async invalidateSessionRpc(sessionId) {
        return this.invalidateSession(sessionId);
    }
    /**
     * RPC: Batch invalidate multiple sessions
     */
    async invalidateSessionsBatchRpc(sessionIds) {
        return this.invalidateSessionsBatch(sessionIds);
    }
    /**
     * RPC: List all active sessions for a user
     */
    async listUserSessionsRpc(userId) {
        return this.listUserSessions(userId);
    }
    /**
     * RPC: Extend session expiration
     */
    async extendSessionRpc(sessionId, additionalSeconds) {
        return this.extendSession(sessionId, additionalSeconds);
    }
    /**
     * RPC: Update session data (merge with existing data)
     * Used for updating session metadata without changing userId or expiration
     */
    async updateSessionDataRpc(sessionId, dataUpdates) {
        return this.updateSessionData(sessionId, dataUpdates);
    }
    /**
     * RPC: Update session user ID
     * Used when anonymous user sub changes during upgrade (preserve_sub=false)
     */
    async updateSessionUserIdRpc(sessionId, newUserId) {
        return this.updateSessionUserId(sessionId, newUserId);
    }
    /**
     * RPC: Get status/health check
     */
    async getStatusRpc() {
        const storedSessions = await this.actorCtx.storage.list({
            prefix: SESSION_KEY_PREFIX,
        });
        return {
            status: 'ok',
            sessions: storedSessions.size,
            cached: this.sessionCache.size,
            timestamp: Date.now(),
        };
    }
    // ==========================================
    // Internal Methods (private)
    // ==========================================
    /**
     * Build storage key for a session
     */
    buildSessionKey(sessionId) {
        return `${SESSION_KEY_PREFIX}${sessionId}`;
    }
    /**
     * Build storage key for a tombstone
     */
    buildTombstoneKey(sessionId) {
        return `${TOMBSTONE_KEY_PREFIX}${sessionId}`;
    }
    /**
     * Create a tombstone for a deleted session
     * Tombstones prevent D1 fallback from returning stale sessions after deletion
     * This is critical for OIDC RP-Initiated Logout security
     */
    async createTombstone(sessionId) {
        const tombstone = {
            deletedAt: Date.now(),
            expiresAt: Date.now() + TOMBSTONE_TTL_MS,
        };
        await this.actorCtx.storage.put(this.buildTombstoneKey(sessionId), tombstone);
        log.debug('Created tombstone for session', { sessionId });
    }
    /**
     * Create tombstones for multiple deleted sessions (batch)
     */
    async createTombstonesBatch(sessionIds) {
        if (sessionIds.length === 0)
            return;
        const now = Date.now();
        const expiresAt = now + TOMBSTONE_TTL_MS;
        // Create tombstones individually (actor abstraction doesn't support batch put)
        for (const sessionId of sessionIds) {
            await this.actorCtx.storage.put(this.buildTombstoneKey(sessionId), {
                deletedAt: now,
                expiresAt,
            });
        }
        log.debug('Created tombstones', { count: sessionIds.length });
    }
    /**
     * Check if a tombstone exists for a session
     * Returns true if the session has been deleted and should not be loaded from D1
     */
    async hasTombstone(sessionId) {
        const tombstone = await this.actorCtx.storage.get(this.buildTombstoneKey(sessionId));
        if (!tombstone) {
            return false;
        }
        // Tombstone exists and is not expired
        if (tombstone.expiresAt > Date.now()) {
            return true;
        }
        // Tombstone expired, clean it up
        await this.actorCtx.storage.delete(this.buildTombstoneKey(sessionId));
        return false;
    }
    /**
     * Cleanup expired tombstones
     */
    async cleanupTombstones() {
        const now = Date.now();
        let cleaned = 0;
        const tombstones = await this.actorCtx.storage.list({
            prefix: TOMBSTONE_KEY_PREFIX,
        });
        const keysToDelete = [];
        for (const [key, tombstone] of tombstones) {
            if (tombstone.expiresAt <= now) {
                keysToDelete.push(key);
                cleaned++;
            }
        }
        if (keysToDelete.length > 0) {
            await this.actorCtx.storage.deleteMany(keysToDelete);
        }
        return cleaned;
    }
    /**
     * Start periodic cleanup of expired sessions
     */
    startCleanup() {
        // Cleanup every 5 minutes
        if (this.cleanupInterval === null) {
            this.cleanupInterval = setInterval(() => {
                void this.cleanupExpiredSessions();
            }, 5 * 60 * 1000);
        }
    }
    /**
     * Cleanup expired sessions from memory and Durable Storage
     * Also cleans up expired tombstones
     */
    async cleanupExpiredSessions() {
        const now = Date.now();
        let cleanedSessions = 0;
        // Clean memory cache
        for (const [sessionId, session] of this.sessionCache.entries()) {
            if (session.expiresAt <= now) {
                this.sessionCache.delete(sessionId);
                // Delete from Durable Storage
                await this.actorCtx.storage.delete(this.buildSessionKey(sessionId));
                cleanedSessions++;
            }
        }
        // Also scan storage for expired sessions not in cache
        const storedSessions = await this.actorCtx.storage.list({
            prefix: SESSION_KEY_PREFIX,
        });
        for (const [key, session] of storedSessions) {
            if (session.expiresAt <= now) {
                await this.actorCtx.storage.delete(key);
                cleanedSessions++;
            }
        }
        // Clean expired tombstones
        const cleanedTombstones = await this.cleanupTombstones();
        if (cleanedSessions > 0 || cleanedTombstones > 0) {
            log.info('Cleaned up expired sessions and tombstones', {
                sessions: cleanedSessions,
                tombstones: cleanedTombstones,
            });
        }
    }
    /**
     * Check if session is expired
     */
    isExpired(session) {
        return session.expiresAt <= Date.now();
    }
    /**
     * Load session from cold persistence
     * Checks for tombstones first to prevent returning deleted sessions
     * This is critical for OIDC RP-Initiated Logout security
     */
    async loadFromPersistence(sessionId) {
        // Check for tombstone first - if exists, session was deleted
        // This prevents cold persistence from returning stale sessions after logout
        if (await this.hasTombstone(sessionId)) {
            log.debug('Tombstone found for session, skipping persistence load', { sessionId });
            return null;
        }
        const persistence = await this.ensureSessionPersistence();
        if (!persistence) {
            return null;
        }
        try {
            const result = await persistence.loadSession(sessionId, Date.now());
            return result;
        }
        catch (error) {
            log.error('Persistence load error', { sessionId }, error);
            return null;
        }
    }
    /**
     * Save session to cold persistence
     * Uses retry logic with exponential backoff for reliability
     */
    async saveToPersistence(session) {
        const persistence = await this.ensureSessionPersistence();
        if (!persistence) {
            return;
        }
        await retryD1Operation(() => persistence.saveSession({
            id: session.id,
            userId: session.userId,
            expiresAt: session.expiresAt,
            createdAt: session.createdAt,
        }), 'SessionStore.saveToPersistence', { maxRetries: 3 });
    }
    /**
     * Delete session from cold persistence
     * Uses retry logic with exponential backoff for reliability
     */
    async deleteFromPersistence(sessionId) {
        const persistence = await this.ensureSessionPersistence();
        if (!persistence) {
            return;
        }
        await retryD1Operation(() => persistence.deleteSession(sessionId), 'SessionStore.deleteFromPersistence', { maxRetries: 3 });
    }
    /**
     * Get session by ID (cache → storage → D1 fallback)
     */
    async getSession(sessionId) {
        // 1. Check in-memory cache (hot)
        let session = this.sessionCache.get(sessionId);
        if (session) {
            if (!this.isExpired(session)) {
                return session;
            }
            // Cleanup expired session
            this.sessionCache.delete(sessionId);
            await this.actorCtx.storage.delete(this.buildSessionKey(sessionId));
            return null;
        }
        // 2. Check Durable Storage
        const storedSession = await this.actorCtx.storage.get(this.buildSessionKey(sessionId));
        if (storedSession) {
            if (!this.isExpired(storedSession)) {
                // Promote to cache
                this.sessionCache.set(sessionId, storedSession);
                return storedSession;
            }
            // Cleanup expired session
            await this.actorCtx.storage.delete(this.buildSessionKey(sessionId));
            return null;
        }
        // 3. Check cold persistence with timeout
        try {
            const persistedSession = await Promise.race([
                this.loadFromPersistence(sessionId),
                new Promise((resolve) => setTimeout(() => resolve(null), 100)),
            ]);
            if (persistedSession && !this.isExpired(persistedSession)) {
                // Promote to cache and storage
                this.sessionCache.set(sessionId, persistedSession);
                await this.actorCtx.storage.put(this.buildSessionKey(sessionId), persistedSession);
                return persistedSession;
            }
        }
        catch (error) {
            log.error('Persistence fallback error', { sessionId }, error);
        }
        return null;
    }
    /**
     * Create new session
     * Session ID must be provided by the caller (generated via session-helper)
     */
    async createSession(sessionId, userId, ttl, data) {
        const session = {
            id: sessionId,
            userId,
            expiresAt: Date.now() + ttl * 1000,
            createdAt: Date.now(),
            data,
        };
        // 1. Store in memory cache (hot)
        this.sessionCache.set(sessionId, session);
        // 2. Persist to Durable Storage (individual key - O(1))
        await this.actorCtx.storage.put(this.buildSessionKey(sessionId), session);
        // 3. Persist to cold storage (backup & audit) - async, don't wait
        this.saveToPersistence(session).catch((error) => {
            log.error('Failed to save to persistence', { sessionId }, error);
        });
        return session;
    }
    /**
     * Invalidate session immediately
     *
     * Optimized: No read-before-delete pattern.
     * storage.delete() is idempotent and works safely on non-existent keys.
     *
     * Security: Creates tombstone if D1 deletion fails to prevent stale sessions
     * from being loaded via D1 fallback (OIDC RP-Initiated Logout protection)
     */
    async invalidateSession(sessionId) {
        // 1. Remove from memory cache
        const hadSession = this.sessionCache.has(sessionId);
        this.sessionCache.delete(sessionId);
        // 2. Delete from Durable Storage (individual key - O(1))
        // No need to check existence first - delete() is idempotent
        const storageKey = this.buildSessionKey(sessionId);
        await this.actorCtx.storage.delete(storageKey);
        // 3. Delete from cold persistence - MUST await to prevent race condition
        // Without await, getSession could still find the session in cold persistence
        // before the deletion completes, causing prompt=none to succeed
        // when it should fail with login_required (OIDC RP-Initiated Logout)
        let persistenceDeleteFailed = false;
        try {
            await this.deleteFromPersistence(sessionId);
        }
        catch (error) {
            log.error('Failed to delete from persistence', { sessionId }, error);
            persistenceDeleteFailed = true;
        }
        // 4. Create tombstone if persistence deletion failed
        // This prevents cold persistence fallback from returning stale sessions
        // Critical for OIDC RP-Initiated Logout security
        if (persistenceDeleteFailed) {
            try {
                await this.createTombstone(sessionId);
            }
            catch (tombstoneError) {
                log.error('CRITICAL - Failed to create tombstone for session', { sessionId }, tombstoneError);
                // This is a critical error - session may be resurrected via persistence fallback
                // In production, this should trigger an alert
            }
        }
        // Return based on cache only - sufficient for logging/debugging purposes
        return hadSession;
    }
    /**
     * Batch invalidate multiple sessions
     * Optimized for admin operations (e.g., delete all user sessions)
     *
     * Optimized: No read-before-delete pattern. Uses batch delete for efficiency.
     * Uses chunking to prevent timeout on large batches.
     *
     * Security: Creates tombstones if D1 deletion fails to prevent stale sessions
     * from being loaded via D1 fallback (OIDC RP-Initiated Logout protection)
     */
    async invalidateSessionsBatch(sessionIds) {
        const MAX_BATCH_SIZE = 1000;
        const failed = [];
        let deleted = 0;
        const failedPersistenceDeleteIds = [];
        // Process in chunks to prevent timeout on large batches
        for (let i = 0; i < sessionIds.length; i += MAX_BATCH_SIZE) {
            const chunk = sessionIds.slice(i, i + MAX_BATCH_SIZE);
            const storageKeysToDelete = [];
            // Process each session in chunk - remove from cache and collect storage keys
            for (const sessionId of chunk) {
                // Remove from memory cache
                this.sessionCache.delete(sessionId);
                // Collect storage keys for batch delete
                storageKeysToDelete.push(this.buildSessionKey(sessionId));
            }
            // Batch delete from Durable Storage - delete() is idempotent
            try {
                if (storageKeysToDelete.length > 0) {
                    await this.actorCtx.storage.deleteMany(storageKeysToDelete);
                }
                deleted += chunk.length;
            }
            catch (error) {
                log.error('Failed to delete chunk', { chunkIndex: i }, error);
                failed.push(...chunk);
                continue;
            }
            // Delete from cold persistence in batch - MUST await to prevent race condition
            if (chunk.length > 0) {
                try {
                    await this.batchDeleteFromPersistence(chunk);
                }
                catch (error) {
                    log.error('Failed to batch delete from persistence', { count: chunk.length }, error);
                    failedPersistenceDeleteIds.push(...chunk);
                }
            }
        }
        // Create tombstones for sessions where persistence deletion failed
        // This prevents persistence fallback from returning stale sessions
        if (failedPersistenceDeleteIds.length > 0) {
            try {
                await this.createTombstonesBatch(failedPersistenceDeleteIds);
            }
            catch (tombstoneError) {
                log.error('CRITICAL - Failed to create tombstones', { count: failedPersistenceDeleteIds.length }, tombstoneError);
                // This is a critical error - sessions may be resurrected via persistence fallback
                // In production, this should trigger an alert
            }
        }
        return {
            deleted,
            failed,
        };
    }
    /**
     * Batch delete sessions from cold persistence
     * Uses a single SQL statement with IN clause for efficiency
     */
    async batchDeleteFromPersistence(sessionIds) {
        if (sessionIds.length === 0) {
            return;
        }
        const persistence = await this.ensureSessionPersistence();
        if (!persistence) {
            return;
        }
        await retryD1Operation(() => persistence.batchDeleteSessions(sessionIds), 'SessionStore.batchDeleteFromPersistence', { maxRetries: 3 });
    }
    /**
     * List all active sessions for a user
     * Note: In sharded mode, this only returns sessions in this shard
     */
    async listUserSessions(userId) {
        const sessions = [];
        const now = Date.now();
        // 1. Get from Durable Storage (individual keys)
        const storedSessions = await this.actorCtx.storage.list({
            prefix: SESSION_KEY_PREFIX,
        });
        for (const [, session] of storedSessions) {
            if (session.userId === userId && session.expiresAt > now) {
                sessions.push({
                    id: session.id,
                    userId: session.userId,
                    expiresAt: session.expiresAt,
                    createdAt: session.createdAt,
                });
            }
        }
        // 2. Get from cold persistence - optional, for audit/completeness
        const persistence = await this.ensureSessionPersistence();
        if (persistence) {
            try {
                const result = await persistence.listUserSessions(userId, now);
                const existingIds = new Set(sessions.map((s) => s.id));
                for (const row of result) {
                    if (!existingIds.has(row.id)) {
                        sessions.push({
                            id: row.id,
                            userId: row.userId,
                            expiresAt: row.expiresAt,
                            createdAt: row.createdAt,
                        });
                    }
                }
            }
            catch (error) {
                log.error('Persistence list error', { userId }, error);
            }
        }
        return sessions;
    }
    /**
     * Extend session expiration (Active TTL)
     */
    async extendSession(sessionId, additionalSeconds) {
        const session = await this.getSession(sessionId);
        if (!session) {
            return null;
        }
        // Extend expiration
        session.expiresAt += additionalSeconds * 1000;
        // Update in memory cache
        this.sessionCache.set(sessionId, session);
        // Persist to Durable Storage
        await this.actorCtx.storage.put(this.buildSessionKey(sessionId), session);
        // Update in cold persistence - async
        this.saveToPersistence(session).catch((error) => {
            log.error('Failed to extend session in persistence', { sessionId }, error);
        });
        return session;
    }
    /**
     * Update session data (merge with existing data)
     * Used for updating session metadata without changing userId or expiration
     */
    async updateSessionData(sessionId, dataUpdates) {
        const session = await this.getSession(sessionId);
        if (!session) {
            return null;
        }
        // Merge new data with existing data
        session.data = {
            ...session.data,
            ...dataUpdates,
        };
        // Update in memory cache
        this.sessionCache.set(sessionId, session);
        // Persist to Durable Storage
        await this.actorCtx.storage.put(this.buildSessionKey(sessionId), session);
        return session;
    }
    /**
     * Update session user ID
     * Used when anonymous user sub changes during upgrade (preserve_sub=false)
     * NOTE: D1 does not store full session data, only basic fields
     */
    async updateSessionUserId(sessionId, newUserId) {
        const session = await this.getSession(sessionId);
        if (!session) {
            return null;
        }
        const oldUserId = session.userId;
        session.userId = newUserId;
        // Update in memory cache
        this.sessionCache.set(sessionId, session);
        // Persist to Durable Storage
        await this.actorCtx.storage.put(this.buildSessionKey(sessionId), session);
        // Update in cold persistence - async
        const persistence = await this.ensureSessionPersistence();
        if (persistence) {
            retryD1Operation(() => persistence.updateSessionUserId(sessionId, newUserId), 'SessionStore.updateSessionUserId.persistence', { maxRetries: 3 }).catch((error) => {
                log.error('Failed to update user_id in persistence', { sessionId, newUserId }, error);
            });
        }
        log.info('Updated session user', { sessionId, oldUserId, newUserId });
        return session;
    }
    /**
     * Sanitize session data for HTTP response (remove sensitive data)
     * Note: data field is included for OIDC conformance (authTime consistency)
     */
    sanitizeSession(session) {
        return {
            id: session.id,
            userId: session.userId,
            expiresAt: session.expiresAt,
            createdAt: session.createdAt,
            data: session.data, // Include data for OIDC conformance (prompt=none authTime consistency)
        };
    }
    async ensurePersistenceContext() {
        if (this.persistenceContext) {
            return this.persistenceContext;
        }
        const stored = await this.actorCtx.storage.get(AUTH_CORE_PERSISTENCE_CONTEXT_KEY);
        if (stored) {
            this.persistenceContext = stored;
            return stored;
        }
        const resolved = await resolveAuthCorePersistenceContextFromEnv(this.env);
        await this.actorCtx.storage.put(AUTH_CORE_PERSISTENCE_CONTEXT_KEY, resolved);
        this.persistenceContext = resolved;
        return resolved;
    }
    async initializeSessionPersistence() {
        const context = await this.ensurePersistenceContext();
        const source = resolveAuthCorePersistenceSourceFromContext(this.env, context);
        return createSessionPersistenceAdapter(source);
    }
    async ensureSessionPersistence() {
        if (this.sessionPersistence) {
            return this.sessionPersistence;
        }
        if (!this.sessionPersistenceInit) {
            this.sessionPersistenceInit = this.initializeSessionPersistence().finally(() => {
                this.sessionPersistenceInit = null;
            });
        }
        this.sessionPersistence = await this.sessionPersistenceInit;
        return this.sessionPersistence;
    }
    /**
     * Handle HTTP requests to the SessionStore Durable Object
     */
    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        try {
            // GET /session/:id - Get session by ID
            if (path.startsWith('/session/') && request.method === 'GET') {
                const sessionId = path.substring(9); // Remove '/session/'
                const session = await this.getSession(sessionId);
                if (!session) {
                    return new Response(JSON.stringify({ error: 'Session not found' }), {
                        status: 404,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                return new Response(JSON.stringify(this.sanitizeSession(session)), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            // POST /session - Create new session
            if (path === '/session' && request.method === 'POST') {
                const body = (await request.json());
                if (!body.sessionId || !body.userId || !body.ttl) {
                    return new Response(JSON.stringify({ error: 'Missing required fields: sessionId, userId, ttl' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                const session = await this.createSession(body.sessionId, body.userId, body.ttl, body.data);
                return new Response(JSON.stringify(this.sanitizeSession(session)), {
                    status: 201,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            // DELETE /session/:id - Invalidate session
            if (path.startsWith('/session/') && request.method === 'DELETE') {
                const sessionId = path.substring(9);
                const deleted = await this.invalidateSession(sessionId);
                return new Response(JSON.stringify({
                    success: true,
                    deleted: deleted ? sessionId : null,
                }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            // POST /sessions/batch-delete - Batch invalidate multiple sessions
            if (path === '/sessions/batch-delete' && request.method === 'POST') {
                const body = (await request.json());
                if (!body.sessionIds || !Array.isArray(body.sessionIds)) {
                    return new Response(JSON.stringify({ error: 'Missing required field: sessionIds (array)' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                const result = await this.invalidateSessionsBatch(body.sessionIds);
                return new Response(JSON.stringify({
                    success: true,
                    deleted: result.deleted,
                    failed: result.failed.length,
                    failedIds: result.failed,
                }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            // GET /sessions/user/:userId - List all sessions for user
            if (path.startsWith('/sessions/user/') && request.method === 'GET') {
                const userId = path.substring(15); // Remove '/sessions/user/'
                const sessions = await this.listUserSessions(userId);
                return new Response(JSON.stringify({ sessions }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            // POST /session/:id/extend - Extend session expiration
            if (path.match(/^\/session\/[^/]+\/extend$/) && request.method === 'POST') {
                const sessionId = path.split('/')[2];
                const body = (await request.json());
                if (!body.seconds || body.seconds <= 0) {
                    return new Response(JSON.stringify({ error: 'Invalid seconds value' }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                const session = await this.extendSession(sessionId, body.seconds);
                if (!session) {
                    return new Response(JSON.stringify({ error: 'Session not found' }), {
                        status: 404,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                return new Response(JSON.stringify(this.sanitizeSession(session)), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            // GET /status - Health check and stats
            if (path === '/status' && request.method === 'GET') {
                // Count sessions in storage
                const storedSessions = await this.actorCtx.storage.list({
                    prefix: SESSION_KEY_PREFIX,
                });
                return new Response(JSON.stringify({
                    status: 'ok',
                    sessions: storedSessions.size,
                    cached: this.sessionCache.size,
                    timestamp: Date.now(),
                }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            return new Response('Not Found', { status: 404 });
        }
        catch (error) {
            log.error('Request error', {}, error);
            return new Response(JSON.stringify({
                error: 'Internal Server Error',
                // SECURITY: Do not expose internal error details in response
                message: 'An error occurred while processing the session',
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    }
}
