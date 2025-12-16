/**
 * DeviceCodeStore Durable Object (V2)
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 *
 * Manages device authorization codes with strong consistency guarantees:
 * - One-time use verification
 * - Immediate status updates (pending → approved/denied)
 * - Polling rate limiting (slow_down detection)
 *
 * V2 Architecture:
 * - Explicit initialization with Durable Storage bulk load
 * - Granular storage with prefix-based keys
 * - Audit logging with batch flush and synchronous critical events
 * - D1 retry for improved reliability
 *
 * Storage Strategy:
 * - Durable Storage as primary (for atomic operations)
 * - In-memory cache for hot data (active device codes)
 * - D1 for persistence, recovery, and audit trail
 * - Dual mapping: device_code → metadata, user_code → device_code
 */

import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env } from '../types/env';
import type { DeviceCodeMetadata } from '../types/oidc';
import { isDeviceCodeExpired } from '../utils/device-flow';
import { retryD1Operation } from '../utils/d1-retry';

/**
 * Device Code V2 - Enhanced state for V2 architecture
 */
export interface DeviceCodeV2 extends DeviceCodeMetadata {
  // V2 additions for tracking
  token_issued?: boolean; // One-time use enforcement
  token_issued_at?: number; // When tokens were issued
}

/**
 * D1 Row type (SQLite stores booleans as integers)
 */
interface DeviceCodeRow extends Omit<DeviceCodeV2, 'token_issued'> {
  token_issued?: number; // 0 = false, 1 = true
}

/**
 * Storage key prefixes
 */
const STORAGE_PREFIX = {
  DEVICE: 'd:', // d:{device_code} → DeviceCodeV2
  USER: 'u:', // u:{user_code} → device_code (mapping)
  META: 'm:', // m:initialized → boolean
} as const;

/**
 * Audit log entry for device flow events
 */
interface AuditLogEntry {
  action:
    | 'device_code_created'
    | 'device_code_approved'
    | 'device_code_denied'
    | 'device_code_expired'
    | 'device_code_consumed'
    | 'slow_down_triggered';
  deviceCode: string;
  userCode?: string;
  clientId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export class DeviceCodeStore {
  private state: DurableObjectState;
  private env: Env;

  // In-memory storage for active device codes
  private deviceCodes: Map<string, DeviceCodeV2> = new Map();
  // User code → Device code mapping for quick lookup
  private userCodeToDeviceCode: Map<string, string> = new Map();

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
    // Critical for device code verification and one-time use guarantee
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
      // Load all device codes from granular storage
      const deviceEntries = await this.state.storage.list<DeviceCodeV2>({
        prefix: STORAGE_PREFIX.DEVICE,
      });

      for (const [key, metadata] of deviceEntries) {
        const deviceCode = key.substring(STORAGE_PREFIX.DEVICE.length);
        this.deviceCodes.set(deviceCode, metadata);
      }

      // Load user code mappings
      const userMappings = await this.state.storage.list<string>({
        prefix: STORAGE_PREFIX.USER,
      });

      for (const [key, deviceCode] of userMappings) {
        const userCode = key.substring(STORAGE_PREFIX.USER.length);
        this.userCodeToDeviceCode.set(userCode, deviceCode);
      }

      console.log(
        `DeviceCodeStore: Loaded ${this.deviceCodes.size} device codes, ${this.userCodeToDeviceCode.size} user mappings`
      );
    } catch (error) {
      console.error('DeviceCodeStore: Failed to initialize:', error);
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
      'DeviceCodeStore: initializeState called but not initialized - this should not happen'
    );
    await this.initializeStateBlocking();
  }

  /**
   * Build storage key for device code
   */
  private buildDeviceKey(deviceCode: string): string {
    return `${STORAGE_PREFIX.DEVICE}${deviceCode}`;
  }

  /**
   * Build storage key for user code mapping
   */
  private buildUserKey(userCode: string): string {
    return `${STORAGE_PREFIX.USER}${userCode}`;
  }

  /**
   * Save device code to Durable Storage
   */
  private async saveDeviceCode(deviceCode: string, metadata: DeviceCodeV2): Promise<void> {
    const key = this.buildDeviceKey(deviceCode);
    await this.state.storage.put(key, metadata);
  }

  /**
   * Save user code mapping to Durable Storage
   */
  private async saveUserMapping(userCode: string, deviceCode: string): Promise<void> {
    const key = this.buildUserKey(userCode);
    await this.state.storage.put(key, deviceCode);
  }

  /**
   * Delete device code from Durable Storage
   */
  private async deleteDeviceCodeFromStorage(deviceCode: string, userCode?: string): Promise<void> {
    const keysToDelete = [this.buildDeviceKey(deviceCode)];
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
      // Store device code
      if (path === '/store' && request.method === 'POST') {
        const metadata: DeviceCodeMetadata = await request.json();
        await this.storeDeviceCode(metadata);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Get device code by device_code
      if (path === '/get-by-device-code' && request.method === 'POST') {
        const { device_code } = (await request.json()) as { device_code: string };
        const metadata = await this.getByDeviceCode(device_code);
        return new Response(JSON.stringify(metadata), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Get device code by user_code
      if (path === '/get-by-user-code' && request.method === 'POST') {
        const { user_code } = (await request.json()) as { user_code: string };
        const metadata = await this.getByUserCode(user_code);
        return new Response(JSON.stringify(metadata), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Approve device code (user approved the request)
      if (path === '/approve' && request.method === 'POST') {
        const { user_code, user_id, sub } = (await request.json()) as {
          user_code: string;
          user_id: string;
          sub: string;
        };
        await this.approveDeviceCode(user_code, user_id, sub);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Deny device code (user denied the request)
      if (path === '/deny' && request.method === 'POST') {
        const { user_code } = (await request.json()) as { user_code: string };
        await this.denyDeviceCode(user_code);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Update last poll time (for rate limiting)
      if (path === '/update-poll' && request.method === 'POST') {
        const { device_code } = (await request.json()) as { device_code: string };
        await this.updatePollTime(device_code);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Mark token as issued (one-time use)
      if (path === '/mark-token-issued' && request.method === 'POST') {
        const { device_code } = (await request.json()) as { device_code: string };
        await this.markTokenIssued(device_code);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Delete device code (consumed or expired)
      if (path === '/delete' && request.method === 'POST') {
        const { device_code } = (await request.json()) as { device_code: string };
        await this.deleteDeviceCode(device_code);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // V2: Status endpoint
      if (path === '/status' && request.method === 'GET') {
        const now = Date.now();
        let activeCount = 0;

        for (const metadata of this.deviceCodes.values()) {
          if (!isDeviceCodeExpired(metadata)) {
            activeCount++;
          }
        }

        return new Response(
          JSON.stringify({
            status: 'ok',
            version: 'v2',
            deviceCodes: {
              total: this.deviceCodes.size,
              active: activeCount,
            },
            userMappings: this.userCodeToDeviceCode.size,
            timestamp: now,
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('DeviceCodeStore error:', error);
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
   * Store a new device code
   */
  private async storeDeviceCode(metadata: DeviceCodeMetadata): Promise<void> {
    const v2Metadata: DeviceCodeV2 = {
      ...metadata,
      token_issued: false,
    };

    // Store in memory
    this.deviceCodes.set(metadata.device_code, v2Metadata);
    this.userCodeToDeviceCode.set(metadata.user_code, metadata.device_code);

    // V2: Persist to Durable Storage (primary)
    await this.saveDeviceCode(metadata.device_code, v2Metadata);
    await this.saveUserMapping(metadata.user_code, metadata.device_code);

    // Persist to D1 (backup/audit)
    if (this.env.DB) {
      await retryD1Operation(
        async () => {
          await this.env.DB.prepare(
            `INSERT INTO device_codes (
              device_code, user_code, client_id, scope, status,
              created_at, expires_at, poll_count, token_issued
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              metadata.device_code,
              metadata.user_code,
              metadata.client_id,
              metadata.scope,
              metadata.status,
              metadata.created_at,
              metadata.expires_at,
              metadata.poll_count || 0,
              0 // token_issued = false
            )
            .run();
        },
        'DeviceCodeStore.storeDeviceCode',
        { maxRetries: 3 }
      );
    }

    // V2: Audit log (non-critical, fire-and-forget)
    void this.logToD1({
      action: 'device_code_created',
      deviceCode: metadata.device_code,
      userCode: metadata.user_code,
      clientId: metadata.client_id,
      metadata: { scope: metadata.scope },
      timestamp: Date.now(),
    });

    // Set expiration alarm to clean up expired codes
    const expiresIn = metadata.expires_at - Date.now();
    if (expiresIn > 0) {
      await this.state.storage.setAlarm(Date.now() + expiresIn);
    }
  }

  /**
   * Get device code metadata by device_code
   */
  private async getByDeviceCode(deviceCode: string): Promise<DeviceCodeV2 | null> {
    // Check in-memory cache first
    let metadata = this.deviceCodes.get(deviceCode);

    if (metadata) {
      // Check if expired
      if (isDeviceCodeExpired(metadata)) {
        await this.deleteDeviceCode(deviceCode);
        return null;
      }
      return metadata;
    }

    // V2: Fallback to Durable Storage
    const storedMetadata = await this.state.storage.get<DeviceCodeV2>(
      this.buildDeviceKey(deviceCode)
    );

    if (storedMetadata) {
      // Check if expired
      if (isDeviceCodeExpired(storedMetadata)) {
        await this.deleteDeviceCode(deviceCode);
        return null;
      }

      // Warm up cache
      this.deviceCodes.set(deviceCode, storedMetadata);
      this.userCodeToDeviceCode.set(storedMetadata.user_code, deviceCode);
      return storedMetadata;
    }

    // Fallback to D1 (for recovery after data loss)
    if (this.env.DB) {
      const result = await this.env.DB.prepare('SELECT * FROM device_codes WHERE device_code = ?')
        .bind(deviceCode)
        .first<DeviceCodeRow>();

      if (result) {
        // Convert D1 row to V2 metadata
        const v2Metadata: DeviceCodeV2 = {
          ...result,
          token_issued: result.token_issued === 1,
        };

        // Check if expired
        if (isDeviceCodeExpired(v2Metadata)) {
          await this.deleteDeviceCode(deviceCode);
          return null;
        }

        // Warm up cache and Durable Storage
        this.deviceCodes.set(deviceCode, v2Metadata);
        this.userCodeToDeviceCode.set(result.user_code, deviceCode);
        await this.saveDeviceCode(deviceCode, v2Metadata);
        await this.saveUserMapping(result.user_code, deviceCode);
        return v2Metadata;
      }
    }

    return null;
  }

  /**
   * Get device code metadata by user_code
   */
  private async getByUserCode(userCode: string): Promise<DeviceCodeV2 | null> {
    // Check mapping first
    let deviceCode = this.userCodeToDeviceCode.get(userCode);

    if (!deviceCode) {
      // Check Durable Storage
      deviceCode = await this.state.storage.get<string>(this.buildUserKey(userCode));
    }

    if (deviceCode) {
      return this.getByDeviceCode(deviceCode);
    }

    // Fallback to D1 (for recovery)
    if (this.env.DB) {
      const result = await this.env.DB.prepare('SELECT * FROM device_codes WHERE user_code = ?')
        .bind(userCode)
        .first<DeviceCodeRow>();

      if (result) {
        // Convert D1 row to V2 metadata
        const v2Metadata: DeviceCodeV2 = {
          ...result,
          token_issued: result.token_issued === 1,
        };

        // Check if expired
        if (isDeviceCodeExpired(v2Metadata)) {
          await this.deleteDeviceCode(result.device_code);
          return null;
        }

        // Warm up cache and Durable Storage
        this.deviceCodes.set(result.device_code, v2Metadata);
        this.userCodeToDeviceCode.set(userCode, result.device_code);
        await this.saveDeviceCode(result.device_code, v2Metadata);
        await this.saveUserMapping(userCode, result.device_code);
        return v2Metadata;
      }
    }

    return null;
  }

  /**
   * Approve device code (user approved the authorization request)
   */
  private async approveDeviceCode(userCode: string, userId: string, sub: string): Promise<void> {
    const metadata = await this.getByUserCode(userCode);

    if (!metadata) {
      throw new Error('Device code not found');
    }

    if (isDeviceCodeExpired(metadata)) {
      throw new Error('Device code expired');
    }

    if (metadata.status !== 'pending') {
      throw new Error(`Device code already ${metadata.status}`);
    }

    // Update status to approved
    metadata.status = 'approved';
    metadata.user_id = userId;
    metadata.sub = sub;

    // Update in memory
    this.deviceCodes.set(metadata.device_code, metadata);

    // V2: Update in Durable Storage
    await this.saveDeviceCode(metadata.device_code, metadata);

    // Update in D1
    if (this.env.DB) {
      await retryD1Operation(
        async () => {
          await this.env.DB.prepare(
            `UPDATE device_codes
             SET status = ?, user_id = ?, sub = ?
             WHERE device_code = ?`
          )
            .bind('approved', userId, sub, metadata.device_code)
            .run();
        },
        'DeviceCodeStore.approveDeviceCode',
        { maxRetries: 3 }
      );
    }

    // V2: Audit log (critical - synchronous)
    await this.logCritical({
      action: 'device_code_approved',
      deviceCode: metadata.device_code,
      userCode: userCode,
      clientId: metadata.client_id,
      userId: userId,
      metadata: { sub },
      timestamp: Date.now(),
    });
  }

  /**
   * Deny device code (user denied the authorization request)
   */
  private async denyDeviceCode(userCode: string): Promise<void> {
    const metadata = await this.getByUserCode(userCode);

    if (!metadata) {
      throw new Error('Device code not found');
    }

    if (metadata.status !== 'pending') {
      throw new Error(`Device code already ${metadata.status}`);
    }

    // Update status to denied
    metadata.status = 'denied';

    // Update in memory
    this.deviceCodes.set(metadata.device_code, metadata);

    // V2: Update in Durable Storage
    await this.saveDeviceCode(metadata.device_code, metadata);

    // Update in D1
    if (this.env.DB) {
      await retryD1Operation(
        async () => {
          await this.env.DB.prepare('UPDATE device_codes SET status = ? WHERE device_code = ?')
            .bind('denied', metadata.device_code)
            .run();
        },
        'DeviceCodeStore.denyDeviceCode',
        { maxRetries: 3 }
      );
    }

    // V2: Audit log (critical - synchronous)
    await this.logCritical({
      action: 'device_code_denied',
      deviceCode: metadata.device_code,
      userCode: userCode,
      clientId: metadata.client_id,
      timestamp: Date.now(),
    });
  }

  /**
   * Update last poll time (for rate limiting)
   */
  private async updatePollTime(deviceCode: string): Promise<void> {
    const metadata = await this.getByDeviceCode(deviceCode);

    if (!metadata) {
      throw new Error('Device code not found');
    }

    // Update poll tracking
    metadata.last_poll_at = Date.now();
    metadata.poll_count = (metadata.poll_count || 0) + 1;

    // Update in memory
    this.deviceCodes.set(deviceCode, metadata);

    // V2: Update in Durable Storage
    await this.saveDeviceCode(deviceCode, metadata);

    // Update in D1 (periodic update to reduce writes)
    // Only update every 5 polls to reduce D1 load
    if (metadata.poll_count % 5 === 0 && this.env.DB) {
      await retryD1Operation(
        async () => {
          await this.env.DB.prepare(
            'UPDATE device_codes SET last_poll_at = ?, poll_count = ? WHERE device_code = ?'
          )
            .bind(metadata.last_poll_at, metadata.poll_count, deviceCode)
            .run();
        },
        'DeviceCodeStore.updatePollTime',
        { maxRetries: 2 }
      );
    }
  }

  /**
   * Mark token as issued (one-time use enforcement) - V2
   */
  private async markTokenIssued(deviceCode: string): Promise<void> {
    const metadata = await this.getByDeviceCode(deviceCode);

    if (!metadata) {
      throw new Error('Device code not found');
    }

    if (metadata.token_issued) {
      throw new Error('Token already issued for this device code');
    }

    if (metadata.status !== 'approved') {
      throw new Error('Device code not approved');
    }

    // Mark as issued
    metadata.token_issued = true;
    metadata.token_issued_at = Date.now();

    // Update in memory
    this.deviceCodes.set(deviceCode, metadata);

    // V2: Update in Durable Storage
    await this.saveDeviceCode(deviceCode, metadata);

    // Update in D1
    if (this.env.DB) {
      await retryD1Operation(
        async () => {
          await this.env.DB.prepare(
            'UPDATE device_codes SET token_issued = ?, status = ? WHERE device_code = ?'
          )
            .bind(1, 'consumed', deviceCode)
            .run();
        },
        'DeviceCodeStore.markTokenIssued',
        { maxRetries: 3 }
      );
    }

    // V2: Audit log (critical - synchronous)
    await this.logCritical({
      action: 'device_code_consumed',
      deviceCode: deviceCode,
      userCode: metadata.user_code,
      clientId: metadata.client_id,
      userId: metadata.user_id,
      timestamp: Date.now(),
    });
  }

  /**
   * Delete device code (consumed or expired)
   */
  private async deleteDeviceCode(deviceCode: string): Promise<void> {
    const metadata = this.deviceCodes.get(deviceCode);
    const userCode = metadata?.user_code;

    // Remove from in-memory storage
    this.deviceCodes.delete(deviceCode);
    if (userCode) {
      this.userCodeToDeviceCode.delete(userCode);
    }

    // V2: Delete from Durable Storage
    await this.deleteDeviceCodeFromStorage(deviceCode, userCode);

    // Delete from D1
    if (this.env.DB) {
      await retryD1Operation(
        async () => {
          await this.env.DB.prepare('DELETE FROM device_codes WHERE device_code = ?')
            .bind(deviceCode)
            .run();
        },
        'DeviceCodeStore.deleteDeviceCode',
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
            `device_flow.${entry.action}`,
            'device_code',
            entry.deviceCode,
            entry.metadata ? JSON.stringify(entry.metadata) : null,
            Math.floor(entry.timestamp / 1000)
          )
          .run();
      },
      'DeviceCodeStore.logCritical',
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
          `device_flow.${entry.action}`,
          'device_code',
          entry.deviceCode,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
          Math.floor(entry.timestamp / 1000)
        )
      );

      await this.env.DB.batch(statements);
    } catch (error) {
      console.error('DeviceCodeStore: Failed to flush audit logs:', error);
      // Re-queue (limited to prevent memory leak)
      if (this.pendingAuditLogs.length < 100) {
        this.pendingAuditLogs.push(...logsToFlush);
        this.scheduleAuditFlush();
      }
    }
  }

  /**
   * Alarm handler for cleaning up expired device codes
   *
   * Idempotent: Checks lastCleanup timestamp to prevent duplicate execution
   * Alarms may fire multiple times in rare cases (DO restart, etc.)
   */
  async alarm(): Promise<void> {
    await this.initializeState();

    const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    const IDEMPOTENCY_BUFFER_MS = 10 * 1000; // 10 second buffer for clock skew

    // Check for duplicate execution (idempotency)
    const lastCleanupKey = `${STORAGE_PREFIX.META}lastCleanup`;
    const lastCleanup = (await this.state.storage.get<number>(lastCleanupKey)) || 0;
    const now = Date.now();

    if (now - lastCleanup < CLEANUP_INTERVAL_MS - IDEMPOTENCY_BUFFER_MS) {
      console.log('DeviceCodeStore alarm: Skipping duplicate execution');
      // Reschedule from last cleanup time
      await this.state.storage.setAlarm(lastCleanup + CLEANUP_INTERVAL_MS);
      return;
    }

    console.log('DeviceCodeStore alarm: Cleaning up expired device codes');

    const expiredCodes: string[] = [];

    // Find expired codes in memory
    for (const [deviceCode, metadata] of this.deviceCodes.entries()) {
      if (isDeviceCodeExpired(metadata)) {
        expiredCodes.push(deviceCode);
      }
    }

    // Delete expired codes (idempotent - delete is safe on non-existent keys)
    for (const deviceCode of expiredCodes) {
      await this.deleteDeviceCode(deviceCode);

      // Log expiration
      void this.logToD1({
        action: 'device_code_expired',
        deviceCode: deviceCode,
        timestamp: now,
      });
    }

    // Clean up expired codes in D1 (idempotent - WHERE clause ensures safety)
    if (this.env.DB) {
      await retryD1Operation(
        async () => {
          await this.env.DB.prepare('DELETE FROM device_codes WHERE expires_at < ?')
            .bind(now)
            .run();
        },
        'DeviceCodeStore.alarm.cleanup',
        { maxRetries: 2 }
      );
    }

    // Record last cleanup time
    await this.state.storage.put(lastCleanupKey, now);

    console.log(`DeviceCodeStore: Cleaned up ${expiredCodes.length} expired device codes`);

    // Schedule next cleanup
    await this.state.storage.setAlarm(now + CLEANUP_INTERVAL_MS);
  }
}
