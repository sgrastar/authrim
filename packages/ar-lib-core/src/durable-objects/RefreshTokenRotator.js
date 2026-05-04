/**
 * RefreshTokenRotator Durable Object (V2)
 *
 * Manages atomic refresh token rotation with version-based theft detection.
 * Each Token Family tracks a single refresh token chain per user.
 *
 * V2 Architecture:
 * - Version-based theft detection (not token string comparison)
 * - Minimal state: version, last_jti, last_used_at, expires_at, user_id, client_id, allowed_scope
 * - JWT contains rtv (Refresh Token Version) claim for validation
 * - Granular storage with prefix-based keys
 *
 * Security Features:
 * - Atomic rotation (DO guarantees single-threaded execution)
 * - Version mismatch → theft detection → family revocation
 * - Scope amplification prevention (allowed_scope check)
 * - Tenant boundary enforcement (user_id validation)
 *
 * OAuth 2.0 Security Best Current Practice (BCP) Compliance:
 * - Token Rotation: Refresh tokens are rotated on every use
 * - Theft Detection: Old version reuse triggers family revocation
 * - Audit Trail: Critical events logged synchronously
 *
 * Reference:
 * - OAuth 2.0 Security BCP: Draft 16, Section 4.13.2
 * - RFC 6749: Section 10.4 (Refresh Token Protection)
 */
import { DurableObject } from 'cloudflare:workers';
import { createAuditLog } from '../utils/audit-log';
import { createLogger } from '../utils/logger';
/**
 * Storage key prefixes
 */
const STORAGE_PREFIX = {
    FAMILY: 'f:', // f:{userId} → TokenFamilyV2
    META: 'm:', // m:migrated → boolean, m:generation → number, m:shardIndex → number
};
/**
 * RefreshTokenRotator Durable Object (V2)
 *
 * Sharded by client_id for horizontal scaling.
 * Each DO instance manages all token families for a single client.
 *
 * RPC Support:
 * - Extends DurableObject base class for RPC method exposure
 * - RPC methods have 'Rpc' suffix (e.g., createFamilyRpc, rotateRpc)
 * - fetch() handler is maintained for backward compatibility and debugging
 */
export class RefreshTokenRotator extends DurableObject {
    families = new Map(); // userId → family
    initialized = false;
    initializePromise = null;
    log = createLogger().module('RefreshTokenRotator');
    // Sharding metadata (set on first createFamily call with V3 request)
    generation = null;
    shardIndex = null;
    // Async audit log buffering (non-critical events)
    pendingAuditLogs = [];
    flushScheduled = false;
    AUDIT_FLUSH_DELAY = 100; // ms
    // Configuration
    DEFAULT_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
    constructor(ctx, env) {
        super(ctx, env);
        // Block all requests until initialization completes
        // This ensures the DO is in a consistent state before processing any requests
        // Critical for token theft detection and version validation
        ctx.blockConcurrencyWhile(async () => {
            await this.initializeStateBlocking();
        });
    }
    /**
     * Initialize state from Durable Storage
     * Called by blockConcurrencyWhile() in constructor
     */
    async initializeStateBlocking() {
        try {
            // Load all families from granular storage
            const familyEntries = await this.ctx.storage.list({
                prefix: STORAGE_PREFIX.FAMILY,
            });
            for (const [key, family] of familyEntries) {
                const userId = key.substring(STORAGE_PREFIX.FAMILY.length);
                this.families.set(userId, family);
            }
            // Load sharding metadata
            const storedGeneration = await this.ctx.storage.get(`${STORAGE_PREFIX.META}generation`);
            const storedShardIndex = await this.ctx.storage.get(`${STORAGE_PREFIX.META}shardIndex`);
            if (storedGeneration !== undefined) {
                this.generation = storedGeneration;
            }
            if (storedShardIndex !== undefined) {
                this.shardIndex = storedShardIndex;
            }
            this.log.info('Loaded families from Durable Storage', {
                count: this.families.size,
                generation: this.generation,
                shardIndex: this.shardIndex,
            });
        }
        catch (error) {
            this.log.error('Failed to initialize', {}, error);
        }
        this.initialized = true;
    }
    // ==========================================
    // RPC Methods (public, with 'Rpc' suffix)
    // ==========================================
    /**
     * RPC: Create new token family
     */
    async createFamilyRpc(request) {
        return this.createFamily(request);
    }
    /**
     * RPC: Rotate refresh token
     * SECURITY CRITICAL: Handles token theft detection
     */
    async rotateRpc(request) {
        return this.rotate(request);
    }
    /**
     * RPC: Revoke token family
     */
    async revokeFamilyRpc(userId, reason) {
        return this.revokeFamily(userId, reason);
    }
    /**
     * RPC: Get family info
     */
    async getFamilyRpc(userId) {
        return this.getFamily(userId);
    }
    /**
     * RPC: Revoke by JTI (RFC 7009)
     */
    async revokeByJtiRpc(jti, reason) {
        return this.revokeByJti(jti, reason);
    }
    /**
     * RPC: Batch revoke multiple tokens
     */
    async batchRevokeRpc(jtis, reason) {
        return this.batchRevoke(jtis, reason);
    }
    /**
     * RPC: Validate token without rotation
     */
    async validateRpc(userId, version, clientId) {
        return this.validate(userId, version, clientId);
    }
    /**
     * RPC: Get status/health check
     */
    async getStatusRpc() {
        await this.initializeState();
        const now = Date.now();
        let activeFamilies = 0;
        for (const family of this.families.values()) {
            if (family.expires_at > now) {
                activeFamilies++;
            }
        }
        return {
            status: 'ok',
            version: 'v2',
            families: {
                total: this.families.size,
                active: activeFamilies,
            },
            timestamp: now,
        };
    }
    // ==========================================
    // Internal Methods
    // ==========================================
    /**
     * Ensure state is initialized
     * Called by public methods for backward compatibility
     *
     * Note: With blockConcurrencyWhile() in constructor, this is now a no-op guard.
     * The actual initialization happens in initializeStateBlocking() during construction.
     */
    async initializeState() {
        // Guard - initialization already completed by blockConcurrencyWhile()
        if (this.initialized) {
            return;
        }
        // This should not happen with blockConcurrencyWhile(), but as a safety fallback:
        this.log.warn('initializeState called but not initialized - this should not happen');
        await this.initializeStateBlocking();
    }
    /**
     * Build family key from userId
     */
    buildFamilyKey(userId) {
        return `${STORAGE_PREFIX.FAMILY}${userId}`;
    }
    /**
     * Save family to storage
     */
    async saveFamily(userId, family) {
        const key = this.buildFamilyKey(userId);
        await this.ctx.storage.put(key, family);
    }
    /**
     * Delete family from storage
     */
    async deleteFamily(userId) {
        const key = this.buildFamilyKey(userId);
        await this.ctx.storage.delete(key);
    }
    /**
     * Generate unique JWT ID
     *
     * If generation and shardIndex are set, generates full JTI format:
     * v{generation}_{shardIndex}_{randomPart}
     *
     * Otherwise, generates legacy format: rt_{uuid}
     */
    generateJti() {
        const randomPart = `rt_${crypto.randomUUID()}`;
        // Use full JTI format if sharding metadata is available
        if (this.generation !== null && this.shardIndex !== null) {
            return `v${this.generation}_${this.shardIndex}_${randomPart}`;
        }
        // Legacy format for backward compatibility
        return randomPart;
    }
    /**
     * Create new token family (V2/V3)
     *
     * Called when issuing the first refresh token for a user-client pair.
     * Returns response consistent with rotate for easier client implementation.
     *
     * V3 extension: If generation and shardIndex are provided, stores them
     * for use in generateJti() to create properly formatted JTIs.
     */
    async createFamily(request) {
        await this.initializeState();
        // V3: Store sharding metadata if provided (first call sets it)
        const v3Request = request;
        if (v3Request.generation !== undefined && v3Request.shardIndex !== undefined) {
            if (this.generation === null && this.shardIndex === null) {
                this.generation = v3Request.generation;
                this.shardIndex = v3Request.shardIndex;
                // Persist sharding metadata
                await this.ctx.storage.put(`${STORAGE_PREFIX.META}generation`, this.generation);
                await this.ctx.storage.put(`${STORAGE_PREFIX.META}shardIndex`, this.shardIndex);
            }
        }
        const now = Date.now();
        const expiresAt = now + request.ttl * 1000;
        const family = {
            version: 1,
            last_jti: request.jti,
            last_used_at: now,
            expires_at: expiresAt,
            user_id: request.userId,
            client_id: request.clientId,
            allowed_scope: request.scope,
        };
        // Store in memory and persistent storage
        this.families.set(request.userId, family);
        await this.saveFamily(request.userId, family);
        // Audit log (non-critical, fire-and-forget - no await needed)
        void this.logToD1({
            action: 'created',
            familyKey: request.userId,
            userId: request.userId,
            clientId: request.clientId,
            metadata: { scope: request.scope, generation: this.generation, shardIndex: this.shardIndex },
            timestamp: now,
        });
        // Response format consistent with rotate endpoint
        return {
            version: family.version,
            newJti: family.last_jti,
            expiresIn: request.ttl,
            allowedScope: family.allowed_scope,
        };
    }
    /**
     * Rotate refresh token (V2)
     *
     * Validates incoming token version and issues new token with incremented version.
     * Detects theft if incoming version < current version.
     */
    async rotate(request) {
        await this.initializeState();
        const family = this.families.get(request.userId);
        // Family not found
        if (!family) {
            throw new Error('invalid_grant: Token family not found');
        }
        // Validate client_id matches
        if (family.client_id !== request.clientId) {
            throw new Error('invalid_grant: Client ID mismatch');
        }
        // Check expiration
        const now = Date.now();
        if (family.expires_at <= now) {
            // Cleanup expired family
            this.families.delete(request.userId);
            await this.deleteFamily(request.userId);
            await this.logToD1({
                action: 'expired',
                familyKey: request.userId,
                userId: request.userId,
                timestamp: now,
            });
            throw new Error('invalid_grant: Refresh token expired');
        }
        // CRITICAL: Version mismatch detection (theft detection)
        if (request.incomingVersion < family.version) {
            // Token replay detected - incoming token has old version
            this.log.error('SECURITY: Token theft detected', {
                userId: request.userId,
                clientId: request.clientId,
                incomingVersion: request.incomingVersion,
                currentVersion: family.version,
            });
            // Revoke entire family
            this.families.delete(request.userId);
            await this.deleteFamily(request.userId);
            // CRITICAL: Log synchronously for audit trail
            await this.logCritical({
                action: 'theft_detected',
                familyKey: request.userId,
                userId: request.userId,
                clientId: request.clientId,
                metadata: {
                    incomingVersion: request.incomingVersion,
                    currentVersion: family.version,
                    incomingJti: request.incomingJti,
                },
                timestamp: now,
            });
            throw new Error('invalid_grant: Token theft detected. Family revoked.');
        }
        // Version must match exactly (not just >=)
        if (request.incomingVersion !== family.version) {
            throw new Error('invalid_grant: Version mismatch');
        }
        // JTI must match (additional security check)
        if (request.incomingJti !== family.last_jti) {
            // JTI mismatch could indicate token tampering or theft
            this.log.error('SECURITY: JTI mismatch detected', {
                userId: request.userId,
                clientId: request.clientId,
                incomingJti: request.incomingJti,
                expectedJti: family.last_jti,
            });
            // Revoke entire family as precaution
            this.families.delete(request.userId);
            await this.deleteFamily(request.userId);
            // CRITICAL: Log synchronously for audit trail
            await this.logCritical({
                action: 'theft_detected',
                familyKey: request.userId,
                userId: request.userId,
                clientId: request.clientId,
                metadata: {
                    reason: 'jti_mismatch',
                    incomingJti: request.incomingJti,
                    expectedJti: family.last_jti,
                },
                timestamp: now,
            });
            throw new Error('invalid_grant: Token theft detected (JTI mismatch). Family revoked.');
        }
        // Scope amplification check
        if (request.requestedScope) {
            const allowedScopes = new Set(family.allowed_scope.split(' '));
            const requestedScopes = request.requestedScope.split(' ');
            for (const scope of requestedScopes) {
                if (!allowedScopes.has(scope)) {
                    // SECURITY: Do not expose scope name in error to prevent scope enumeration
                    throw new Error('invalid_scope: Requested scope is not allowed');
                }
            }
        }
        // Rotate: increment version and generate new JTI
        const newVersion = family.version + 1;
        const newJti = this.generateJti();
        // Update family
        family.version = newVersion;
        family.last_jti = newJti;
        family.last_used_at = now;
        // Persist
        this.families.set(request.userId, family);
        await this.saveFamily(request.userId, family);
        // Audit log (non-critical, fire-and-forget - no await needed)
        void this.logToD1({
            action: 'rotated',
            familyKey: request.userId,
            userId: request.userId,
            clientId: request.clientId,
            metadata: { version: newVersion },
            timestamp: now,
        });
        return {
            newVersion,
            newJti,
            expiresIn: Math.floor((family.expires_at - now) / 1000),
            allowedScope: request.requestedScope || family.allowed_scope,
        };
    }
    /**
     * Revoke token family
     */
    async revokeFamily(userId, reason) {
        await this.initializeState();
        const family = this.families.get(userId);
        if (!family) {
            return; // Already revoked or doesn't exist
        }
        // Remove from memory and storage
        this.families.delete(userId);
        await this.deleteFamily(userId);
        // CRITICAL: Log synchronously
        await this.logCritical({
            action: 'family_revoked',
            familyKey: userId,
            userId,
            clientId: family.client_id,
            metadata: { reason: reason || 'manual_revocation' },
            timestamp: Date.now(),
        });
    }
    /**
     * Get family info (for validation/debugging)
     */
    async getFamily(userId) {
        await this.initializeState();
        return this.families.get(userId) || null;
    }
    /**
     * Revoke a single token by JTI
     * Used for RFC 7009 Token Revocation
     */
    async revokeByJti(jti, reason) {
        await this.initializeState();
        // Find family with matching last_jti
        for (const [userId, family] of this.families.entries()) {
            if (family.last_jti === jti) {
                // Revoke the entire family (as per OAuth best practice)
                this.families.delete(userId);
                await this.deleteFamily(userId);
                await this.logCritical({
                    action: 'family_revoked',
                    familyKey: userId,
                    userId,
                    clientId: family.client_id,
                    metadata: { reason: reason || 'token_revocation', jti },
                    timestamp: Date.now(),
                });
                return true;
            }
        }
        return false; // JTI not found (may already be revoked or expired)
    }
    /**
     * Batch revoke multiple token families
     * Used for user-wide token revocation
     *
     * @param jtis - List of JTIs to revoke
     * @param reason - Revocation reason
     * @returns Number of families revoked
     */
    async batchRevoke(jtis, reason) {
        await this.initializeState();
        const now = Date.now();
        let revoked = 0;
        let notFound = 0;
        // Build JTI to userId mapping for efficient lookup
        const jtiToUserMap = new Map();
        for (const [userId, family] of this.families.entries()) {
            jtiToUserMap.set(family.last_jti, userId);
        }
        // Revoke each JTI
        for (const jti of jtis) {
            const userId = jtiToUserMap.get(jti);
            if (userId) {
                const family = this.families.get(userId);
                if (family) {
                    this.families.delete(userId);
                    await this.deleteFamily(userId);
                    // Audit log (non-blocking for batch operations)
                    void this.logToD1({
                        action: 'family_revoked',
                        familyKey: userId,
                        userId,
                        clientId: family.client_id,
                        metadata: { reason: reason || 'batch_revocation', jti },
                        timestamp: now,
                    });
                    revoked++;
                }
            }
            else {
                notFound++;
            }
        }
        return { revoked, notFound };
    }
    /**
     * Validate token without rotation (for introspection)
     */
    async validate(userId, version, clientId) {
        await this.initializeState();
        const family = this.families.get(userId);
        if (!family) {
            return { valid: false };
        }
        // Check expiration
        if (family.expires_at <= Date.now()) {
            return { valid: false };
        }
        // Check version and client
        if (family.version !== version || family.client_id !== clientId) {
            return { valid: false };
        }
        return { valid: true, family };
    }
    /**
     * Log non-critical events (batched, async)
     */
    async logToD1(entry) {
        this.pendingAuditLogs.push(entry);
        this.scheduleAuditFlush();
    }
    /**
     * Log critical events synchronously (theft_detected, family_revoked)
     */
    async logCritical(entry) {
        await createAuditLog(this.env, {
            userId: entry.userId ?? 'system',
            action: `refresh_token.${entry.action}`,
            resource: 'refresh_token_family',
            resourceId: entry.familyKey,
            ipAddress: 'system',
            userAgent: 'RefreshTokenRotator',
            metadata: JSON.stringify(entry.metadata ?? {}),
            severity: 'warning',
        });
    }
    /**
     * Schedule batch flush of audit logs
     */
    scheduleAuditFlush() {
        if (this.flushScheduled) {
            return;
        }
        this.flushScheduled = true;
        setTimeout(() => {
            void this.flushAuditLogs();
        }, this.AUDIT_FLUSH_DELAY);
    }
    /**
     * Flush pending audit logs to D1
     */
    async flushAuditLogs() {
        this.flushScheduled = false;
        if (this.pendingAuditLogs.length === 0) {
            return;
        }
        const logsToFlush = [...this.pendingAuditLogs];
        this.pendingAuditLogs = [];
        try {
            await Promise.all(logsToFlush.map((entry) => createAuditLog(this.env, {
                userId: entry.userId ?? 'system',
                action: `refresh_token.${entry.action}`,
                resource: 'refresh_token_family',
                resourceId: entry.familyKey,
                ipAddress: 'system',
                userAgent: 'RefreshTokenRotator',
                metadata: JSON.stringify(entry.metadata ?? {}),
                severity: 'info',
            })));
        }
        catch (error) {
            this.log.error('Failed to flush audit logs', {}, error);
            // Re-queue (limited to prevent memory leak)
            if (this.pendingAuditLogs.length < 100) {
                this.pendingAuditLogs.push(...logsToFlush);
                this.scheduleAuditFlush();
            }
        }
    }
    /**
     * Handle HTTP requests
     */
    async fetch(request) {
        await this.initializeState();
        const url = new URL(request.url);
        const path = url.pathname;
        try {
            // POST /family - Create new token family (V2/V3)
            if (path === '/family' && request.method === 'POST') {
                let body;
                try {
                    body = (await request.json());
                }
                catch {
                    return new Response(JSON.stringify({
                        error: 'invalid_request',
                        error_description: 'Invalid JSON body',
                    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                }
                if (!body.jti || !body.userId || !body.clientId || !body.scope) {
                    return new Response(JSON.stringify({
                        error: 'invalid_request',
                        error_description: 'Missing required fields: jti, userId, clientId, scope',
                    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                }
                // Build request (V3 fields are optional)
                const createRequest = {
                    jti: body.jti,
                    userId: body.userId,
                    clientId: body.clientId,
                    scope: body.scope,
                    ttl: body.ttl || this.DEFAULT_TTL,
                    ...(body.generation !== undefined &&
                        body.shardIndex !== undefined && {
                        generation: body.generation,
                        shardIndex: body.shardIndex,
                    }),
                };
                const result = await this.createFamily(createRequest);
                return new Response(JSON.stringify(result), {
                    status: 201,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            // POST /rotate - Rotate refresh token (V2)
            if (path === '/rotate' && request.method === 'POST') {
                const body = (await request.json());
                if (body.incomingVersion === undefined ||
                    !body.incomingJti ||
                    !body.userId ||
                    !body.clientId) {
                    return new Response(JSON.stringify({
                        error: 'invalid_request',
                        error_description: 'Missing required fields: incomingVersion, incomingJti, userId, clientId',
                    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                }
                try {
                    const result = await this.rotate({
                        incomingVersion: body.incomingVersion,
                        incomingJti: body.incomingJti,
                        userId: body.userId,
                        clientId: body.clientId,
                        requestedScope: body.requestedScope,
                    });
                    return new Response(JSON.stringify(result), {
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                catch (error) {
                    this.log.error('rotateToken error', {}, error);
                    const message = error instanceof Error ? error.message : '';
                    const isTheft = message.includes('theft detected') || message.includes('theft');
                    // SECURITY: Use generic error descriptions
                    let errorDescription = 'Refresh token is invalid or expired';
                    if (isTheft || message.includes('revoked')) {
                        errorDescription = 'Refresh token has been revoked';
                    }
                    else if (message.includes('version mismatch')) {
                        errorDescription = 'Refresh token version mismatch';
                    }
                    else if (message.includes('expired')) {
                        errorDescription = 'Refresh token has expired';
                    }
                    return new Response(JSON.stringify({
                        error: 'invalid_grant',
                        error_description: errorDescription,
                        ...(isTheft && { action: 'family_revoked' }),
                    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                }
            }
            // POST /revoke-family - Revoke token family
            if (path === '/revoke-family' && request.method === 'POST') {
                const body = (await request.json());
                if (!body.userId) {
                    return new Response(JSON.stringify({ error: 'invalid_request', error_description: 'Missing userId' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                }
                await this.revokeFamily(body.userId, body.reason);
                return new Response(JSON.stringify({ success: true }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            // POST /revoke - Revoke single token by JTI (RFC 7009)
            if (path === '/revoke' && request.method === 'POST') {
                const body = (await request.json());
                if (!body.jti) {
                    return new Response(JSON.stringify({ error: 'invalid_request', error_description: 'Missing jti' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                }
                const revoked = await this.revokeByJti(body.jti, body.reason);
                return new Response(JSON.stringify({ success: true, revoked }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            // POST /batch-revoke - Batch revoke multiple tokens
            if (path === '/batch-revoke' && request.method === 'POST') {
                const body = (await request.json());
                if (!body.jtis || !Array.isArray(body.jtis)) {
                    return new Response(JSON.stringify({
                        error: 'invalid_request',
                        error_description: 'Missing or invalid jtis array',
                    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                }
                const result = await this.batchRevoke(body.jtis, body.reason);
                return new Response(JSON.stringify({ success: true, ...result }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            // GET /validate - Validate token
            if (path === '/validate' && request.method === 'GET') {
                const userId = url.searchParams.get('userId');
                const versionStr = url.searchParams.get('version');
                const clientId = url.searchParams.get('clientId');
                if (!userId || !versionStr || !clientId) {
                    return new Response(JSON.stringify({
                        error: 'invalid_request',
                        error_description: 'Missing required params: userId, version, clientId',
                    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                }
                const version = parseInt(versionStr, 10);
                const result = await this.validate(userId, version, clientId);
                return new Response(JSON.stringify({
                    valid: result.valid,
                    ...(result.family && {
                        version: result.family.version,
                        allowedScope: result.family.allowed_scope,
                        expiresAt: result.family.expires_at,
                    }),
                }), { headers: { 'Content-Type': 'application/json' } });
            }
            // GET /family/:userId - Get family info
            if (path.startsWith('/family/') && request.method === 'GET') {
                const userId = path.substring(8);
                const family = await this.getFamily(userId);
                if (!family) {
                    return new Response(JSON.stringify({ error: 'Family not found' }), {
                        status: 404,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                return new Response(JSON.stringify({
                    version: family.version,
                    lastUsedAt: family.last_used_at,
                    expiresAt: family.expires_at,
                    userId: family.user_id,
                    clientId: family.client_id,
                    allowedScope: family.allowed_scope,
                }), { headers: { 'Content-Type': 'application/json' } });
            }
            // GET /status - Health check
            if (path === '/status' && request.method === 'GET') {
                const now = Date.now();
                let activeFamilies = 0;
                for (const family of this.families.values()) {
                    if (family.expires_at > now) {
                        activeFamilies++;
                    }
                }
                return new Response(JSON.stringify({
                    status: 'ok',
                    version: 'v2',
                    families: {
                        total: this.families.size,
                        active: activeFamilies,
                    },
                    timestamp: now,
                }), { headers: { 'Content-Type': 'application/json' } });
            }
            return new Response('Not Found', { status: 404 });
        }
        catch (error) {
            // Log full error for debugging but don't expose to client
            this.log.error('Request handling error', {}, error);
            // SECURITY: Do not expose internal error details in response
            return new Response(JSON.stringify({
                error: 'server_error',
                error_description: 'Internal server error',
            }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
    }
}
