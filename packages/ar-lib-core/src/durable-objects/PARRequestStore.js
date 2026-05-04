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
import { DurableObject } from 'cloudflare:workers';
import { createLogger } from '../utils/logger';
/**
 * PARRequestStore Durable Object
 *
 * Provides atomic single-use PAR request_uri management.
 *
 * RPC Support:
 * - Extends DurableObject base class for RPC method exposure
 * - RPC methods have 'Rpc' suffix (e.g., storeRequestRpc, consumeRequestRpc)
 * - fetch() handler is maintained for backward compatibility and debugging
 */
export class PARRequestStore extends DurableObject {
    requests = new Map();
    cleanupInterval = null;
    initialized = false;
    log = createLogger().module('PARRequestStore');
    // Configuration
    CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
    MAX_ENTRIES = 10000; // Cleanup trigger threshold
    constructor(ctx, env) {
        super(ctx, env);
    }
    // ==========================================
    // RPC Methods (public, with 'Rpc' suffix)
    // ==========================================
    /**
     * RPC: Store a new PAR request
     */
    async storeRequestRpc(request) {
        return this.storeRequest(request);
    }
    /**
     * RPC: Consume a PAR request (atomic check + delete)
     * SECURITY CRITICAL: Single-use guarantee (RFC 9126)
     */
    async consumeRequestRpc(request) {
        return this.consumeRequest(request);
    }
    /**
     * RPC: Delete a PAR request
     */
    async deleteRequestRpc(requestUri) {
        return this.deleteRequest(requestUri);
    }
    /**
     * RPC: Get PAR request info (without consuming)
     */
    async getRequestRpc(requestUri) {
        return this.getRequest(requestUri);
    }
    /**
     * RPC: Get health check status
     */
    async getHealthRpc() {
        await this.initializeState();
        const now = Date.now();
        let activeCount = 0;
        for (const data of this.requests.values()) {
            if (!data.consumed && data.expiresAt && data.expiresAt > now) {
                activeCount++;
            }
        }
        return {
            status: 'ok',
            requests: {
                total: this.requests.size,
                active: activeCount,
                consumed: this.requests.size - activeCount,
            },
            timestamp: now,
        };
    }
    // ==========================================
    // Internal Methods
    // ==========================================
    /**
     * Initialize state from Durable Storage
     */
    async initializeState() {
        if (this.initialized) {
            return;
        }
        try {
            const stored = await this.ctx.storage.get('state');
            if (stored) {
                this.requests = new Map(Object.entries(stored.requests));
                this.log.info('Restored requests from Durable Storage', { count: this.requests.size });
            }
        }
        catch (error) {
            this.log.error('Failed to initialize from Durable Storage', {}, error);
        }
        this.initialized = true;
        this.startCleanup();
    }
    /**
     * Save current state to Durable Storage
     */
    async saveState() {
        try {
            const stateToSave = {
                requests: Object.fromEntries(this.requests),
                lastCleanup: Date.now(),
            };
            await this.ctx.storage.put('state', stateToSave);
        }
        catch (error) {
            this.log.error('Failed to save to Durable Storage', {}, error);
        }
    }
    /**
     * Start periodic cleanup of expired requests
     */
    startCleanup() {
        if (this.cleanupInterval === null) {
            this.cleanupInterval = setInterval(() => {
                void this.cleanupExpiredRequests();
            }, this.CLEANUP_INTERVAL);
        }
    }
    /**
     * Cleanup expired or consumed requests
     */
    async cleanupExpiredRequests() {
        const now = Date.now();
        let cleaned = 0;
        for (const [uri, data] of this.requests.entries()) {
            if ((data.expiresAt && data.expiresAt <= now) || data.consumed) {
                this.requests.delete(uri);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            this.log.info('Cleaned up expired/consumed requests', { count: cleaned });
            await this.saveState();
        }
    }
    /**
     * Store a new PAR request
     */
    async storeRequest(request) {
        await this.initializeState();
        const now = Date.now();
        const data = {
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
    async consumeRequest(request) {
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
    async deleteRequest(requestUri) {
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
    async getRequest(requestUri) {
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
    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        try {
            // POST /request - Store new PAR request
            if (path === '/request' && request.method === 'POST') {
                const body = (await request.json());
                if (!body.requestUri || !body.data || !body.ttl) {
                    return new Response(JSON.stringify({
                        error: 'invalid_request',
                        error_description: 'Missing required fields',
                    }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                await this.storeRequest(body);
                return new Response(JSON.stringify({ success: true }), {
                    status: 201,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            // POST /request/consume - Consume PAR request (atomic)
            if (path === '/request/consume' && request.method === 'POST') {
                const body = (await request.json());
                if (!body.requestUri || !body.client_id) {
                    return new Response(JSON.stringify({
                        error: 'invalid_request',
                        error_description: 'Missing required fields',
                    }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                try {
                    const data = await this.consumeRequest(body);
                    return new Response(JSON.stringify(data), {
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                catch (error) {
                    this.log.warn('consumeRequest error', {}, error);
                    const message = error instanceof Error ? error.message : '';
                    // SECURITY: Use generic error descriptions, only allow safe predefined messages
                    let errorDescription = 'PAR request is invalid or expired';
                    if (message.includes('already consumed') || message.includes('replay')) {
                        errorDescription = 'PAR request has already been used';
                    }
                    else if (message.includes('expired')) {
                        errorDescription = 'PAR request has expired';
                    }
                    else if (message.includes('not found')) {
                        errorDescription = 'PAR request not found';
                    }
                    return new Response(JSON.stringify({
                        error: 'invalid_request_uri',
                        error_description: errorDescription,
                    }), {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
            }
            // DELETE /request/:requestUri - Delete PAR request
            if (path.startsWith('/request/') && request.method === 'DELETE') {
                const requestUri = decodeURIComponent(path.substring(9)); // Remove '/request/'
                const deleted = await this.deleteRequest(requestUri);
                return new Response(JSON.stringify({
                    success: true,
                    deleted,
                }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            // GET /request/:requestUri - Get PAR request info
            if (path.startsWith('/request/') && request.method === 'GET') {
                const requestUri = decodeURIComponent(path.substring(9));
                const data = await this.getRequest(requestUri);
                if (!data) {
                    return new Response(JSON.stringify({
                        error: 'not_found',
                        error_description: 'Request not found or expired',
                    }), {
                        status: 404,
                        headers: { 'Content-Type': 'application/json' },
                    });
                }
                // Don't expose sensitive data in GET requests
                return new Response(JSON.stringify({
                    client_id: data.client_id,
                    createdAt: data.createdAt,
                    expiresAt: data.expiresAt,
                    consumed: data.consumed,
                }), {
                    headers: { 'Content-Type': 'application/json' },
                });
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
                return new Response(JSON.stringify({
                    status: 'ok',
                    requests: {
                        total: this.requests.size,
                        active: activeCount,
                        consumed: this.requests.size - activeCount,
                    },
                    timestamp: now,
                }), {
                    headers: { 'Content-Type': 'application/json' },
                });
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
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    }
}
