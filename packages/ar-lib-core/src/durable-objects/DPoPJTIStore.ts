/**
 * DPoPJTIStore Durable Object
 *
 * Manages DPoP JTI (JWT ID) replay protection with atomic operations.
 * Solves issue #12: DPoP JTI Replay Protection race condition.
 *
 * DPoP (Demonstrating Proof-of-Possession) Requirements:
 * - Each DPoP proof JWT MUST have a unique jti (JWT ID)
 * - jti MUST NOT be reused (replay protection)
 * - jti should be tracked for a reasonable time window
 *
 * Security Features:
 * - Atomic check-and-store operation
 * - Prevents parallel replay attacks
 * - TTL enforcement (e.g., 1 hour)
 * - Automatic cleanup of expired JTIs (alarm over an expiry index)
 * - One storage key per JTI, so a store does not rewrite the whole window
 *
 * Benefits over KV-based JTI tracking:
 * - ✅ No race conditions on concurrent requests with same JTI
 * - ✅ Perfect replay protection (100% accuracy)
 * - ✅ Immediate consistency (no eventual consistency issues)
 * - ✅ DPoP specification compliance
 */

import type { Env } from '../types/env';
import { createLogger, type Logger } from '../utils/logger';

/**
 * DPoP JTI record
 */
export interface DPoPJTIRecord {
  jti: string;
  client_id?: string; // Optional: bind JTI to client
  iat: number; // Issued at timestamp (from DPoP proof)
  createdAt: number; // When this record was created
  expiresAt: number; // When this record expires
}

/**
 * Check and store JTI request
 */
export interface CheckAndStoreJTIRequest {
  jti: string;
  client_id?: string;
  iat: number; // DPoP proof iat claim
  ttl: number; // Time to live in seconds (typically 3600 = 1 hour)
}

/**
 * Legacy layout: every JTI in one `state` value, rewritten on each store. It is moved to
 * per-JTI keys on first use, since one value grows with the window and has a size limit.
 */
interface LegacyDPoPJTIStoreState {
  jtis: Record<string, DPoPJTIRecord>;
  lastCleanup: number;
}

const LEGACY_STATE_KEY = 'state';
/** `jti:<sha256(jti)>` → record. Hashed so any JTI fits the 2 KiB key limit. */
const RECORD_PREFIX = 'jti:';
/** `exp:<expiresAt, zero-padded>:<hash>` → hash, so cleanup reads only what has expired. */
const EXPIRY_PREFIX = 'exp:';
/** Storage put/delete accept at most 128 keys per call; each JTI has two. */
const JTIS_PER_WRITE = 64;

class DPoPJTIReplayError extends Error {}

async function jtiHash(jti: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(jti));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Rounded up, so cleanup never removes a JTI before its own expiry. */
function expiryKey(expiresAt: number, hash: string): string {
  return `${EXPIRY_PREFIX}${String(Math.max(0, Math.ceil(expiresAt))).padStart(16, '0')}:${hash}`;
}

function expiryOf(key: string): number {
  return Number(key.slice(EXPIRY_PREFIX.length, EXPIRY_PREFIX.length + 16));
}

/**
 * DPoPJTIStore Durable Object
 *
 * Provides atomic JTI replay protection for DPoP.
 */
export class DPoPJTIStore {
  private state: DurableObjectState;
  private env: Env;
  private initialization: Promise<void> | null = null;
  private alarmScheduled = false;
  private readonly log: Logger = createLogger().module('DPoPJTIStore');

  // Configuration
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private readonly CLEANUP_BATCH = 1000; // Expired JTIs read per list call
  private readonly CLEANUP_MAX_BATCHES = 10; // Per alarm; the rest is picked up right after

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /**
   * Move a legacy `state` value to per-JTI keys (once) and make sure stored JTIs have a cleanup
   * alarm, even if scheduling failed before. A failure is retried on the next call.
   */
  private initializeState(): Promise<void> {
    this.initialization ??= this.initialize().catch((error: unknown) => {
      this.initialization = null;
      this.log.error('Failed to initialize from Durable Storage', {}, error as Error);
      throw error;
    });
    return this.initialization;
  }

  private async initialize(): Promise<void> {
    await this.migrateLegacyState();
    const stored = await this.state.storage.list({ prefix: EXPIRY_PREFIX, limit: 1 });
    if (stored.size > 0) await this.ensureCleanupAlarm();
  }

  private async migrateLegacyState(): Promise<void> {
    const legacy = await this.state.storage.get<LegacyDPoPJTIStoreState>(LEGACY_STATE_KEY);
    if (!legacy) return;

    const now = Date.now();
    const live = Object.values(legacy.jtis ?? {}).filter((record) => record.expiresAt > now);
    for (let i = 0; i < live.length; i += JTIS_PER_WRITE) {
      const entries: Record<string, unknown> = {};
      for (const record of live.slice(i, i + JTIS_PER_WRITE)) {
        const hash = await jtiHash(record.jti);
        entries[RECORD_PREFIX + hash] = record;
        entries[expiryKey(record.expiresAt, hash)] = hash;
      }
      await this.state.storage.put(entries);
    }
    await this.state.storage.delete(LEGACY_STATE_KEY);
    this.log.info('Moved JTIs to per-JTI storage', { count: live.length });
  }

  private async ensureCleanupAlarm(): Promise<void> {
    if (this.alarmScheduled) return;
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + this.CLEANUP_INTERVAL);
    }
    this.alarmScheduled = true;
  }

  private async deleteRecord(hash: string, record: DPoPJTIRecord): Promise<void> {
    await this.state.storage.delete([RECORD_PREFIX + hash, expiryKey(record.expiresAt, hash)]);
  }

  /**
   * Delete expired JTIs, reading only the expiry index up to now, and schedule the next run.
   */
  async alarm(): Promise<void> {
    this.alarmScheduled = false;
    await this.initializeState();

    const now = Date.now();
    const end = expiryKey(now + 1, '');
    let cleaned = 0;
    let more = false;
    for (let batch = 0; batch < this.CLEANUP_MAX_BATCHES; batch++) {
      const expired = await this.state.storage.list<string>({
        prefix: EXPIRY_PREFIX,
        end,
        limit: this.CLEANUP_BATCH,
      });
      if (expired.size === 0) break;
      const keys = [...expired.entries()].flatMap(([key, hash]) => [key, RECORD_PREFIX + hash]);
      for (let i = 0; i < keys.length; i += JTIS_PER_WRITE * 2) {
        await this.state.storage.delete(keys.slice(i, i + JTIS_PER_WRITE * 2));
      }
      cleaned += expired.size;
      more = expired.size === this.CLEANUP_BATCH;
      if (!more) break;
    }
    if (cleaned > 0) this.log.info('Cleaned up expired JTIs', { count: cleaned });

    const next = await this.state.storage.list<string>({ prefix: EXPIRY_PREFIX, limit: 1 });
    const [firstKey] = next.keys();
    if (more) {
      await this.state.storage.setAlarm(Date.now() + 1000);
      this.alarmScheduled = true;
    } else if (firstKey !== undefined) {
      // At most one interval away, so a shorter-lived JTI stored later is not left waiting
      // behind a long-lived one.
      await this.state.storage.setAlarm(
        Math.min(
          Math.max(expiryOf(firstKey) + 1, Date.now() + 1000),
          Date.now() + this.CLEANUP_INTERVAL
        )
      );
      this.alarmScheduled = true;
    }
  }

  /**
   * Check if JTI exists (replay detection)
   */
  async checkJTI(jti: string): Promise<DPoPJTIRecord | null> {
    await this.initializeState();

    const hash = await jtiHash(jti);
    const record = await this.state.storage.get<DPoPJTIRecord>(RECORD_PREFIX + hash);
    if (!record) {
      return null;
    }

    // Check if expired
    if (record.expiresAt <= Date.now()) {
      await this.deleteRecord(hash, record);
      return null;
    }

    return record;
  }

  /**
   * Atomically check and store JTI
   *
   * CRITICAL: This operation is atomic within the DO
   * - Checks if JTI already exists
   * - If exists: throws error (replay detected)
   * - If not exists: stores JTI
   *
   * This is the solution to issue #12: DPoP JTI race condition.
   * Parallel requests with the same JTI will be serialized,
   * ensuring only the first one succeeds.
   */
  async checkAndStoreJTI(request: CheckAndStoreJTIRequest): Promise<void> {
    await this.initializeState();

    // Check if JTI already exists (ATOMIC CHECK)
    const existing = await this.checkJTI(request.jti);
    if (existing) {
      throw new DPoPJTIReplayError('DPoP replay detected: JTI already used');
    }

    // Store new JTI (ATOMIC STORE)
    const now = Date.now();
    const record: DPoPJTIRecord = {
      jti: request.jti,
      client_id: request.client_id,
      iat: request.iat,
      createdAt: now,
      expiresAt: now + request.ttl * 1000,
    };

    const hash = await jtiHash(request.jti);
    await this.state.storage.put({
      [RECORD_PREFIX + hash]: record,
      [expiryKey(record.expiresAt, hash)]: hash,
    });
    await this.ensureCleanupAlarm();
  }

  /**
   * Delete a JTI (for cleanup or testing)
   */
  async deleteJTI(jti: string): Promise<boolean> {
    await this.initializeState();

    const hash = await jtiHash(jti);
    const record = await this.state.storage.get<DPoPJTIRecord>(RECORD_PREFIX + hash);
    if (!record) return false;
    await this.deleteRecord(hash, record);
    return true;
  }

  /**
   * Handle HTTP requests to the DPoPJTIStore Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // POST /check - Check if JTI exists
      if (path === '/check' && request.method === 'POST') {
        const body = await request.json<{ jti: string }>();

        if (!body.jti) {
          return new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'Missing jti',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const record = await this.checkJTI(body.jti);

        if (record) {
          return new Response(
            JSON.stringify({
              exists: true,
              record: {
                iat: record.iat,
                createdAt: record.createdAt,
                expiresAt: record.expiresAt,
              },
            }),
            {
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        return new Response(JSON.stringify({ exists: false }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /check-and-store - Atomic check and store
      if (path === '/check-and-store' && request.method === 'POST') {
        const body = await request.json<Partial<CheckAndStoreJTIRequest>>();

        if (!body.jti || !body.iat || !body.ttl) {
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
          await this.checkAndStoreJTI(body as CheckAndStoreJTIRequest);

          return new Response(JSON.stringify({ success: true }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (error) {
          if (!(error instanceof DPoPJTIReplayError)) {
            throw error;
          }
          this.log.warn('checkAndStoreJTI replay detected', {}, error);
          return new Response(
            JSON.stringify({
              error: 'replay_detected',
              // SECURITY: Do not expose internal error details
              error_description: 'DPoP proof replay detected or JTI already used',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
      }

      // DELETE /jti/:jti - Delete JTI
      if (path.startsWith('/jti/') && request.method === 'DELETE') {
        const jti = decodeURIComponent(path.substring(5)); // Remove '/jti/'
        const deleted = await this.deleteJTI(jti);

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

      // GET /health - Health check
      if (path === '/health' && request.method === 'GET') {
        await this.initializeState();
        const now = Date.now();
        // Diagnostic only: reads the whole expiry index.
        const index = await this.state.storage.list<string>({ prefix: EXPIRY_PREFIX });
        let total = 0;
        let activeCount = 0;
        for (const key of index.keys()) {
          total++;
          if (expiryOf(key) > now) activeCount++;
        }

        return new Response(
          JSON.stringify({
            status: 'ok',
            jtis: {
              total,
              active: activeCount,
              expired: total - activeCount,
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
}
