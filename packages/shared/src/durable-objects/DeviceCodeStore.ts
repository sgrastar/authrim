/**
 * DeviceCodeStore Durable Object
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 *
 * Manages device authorization codes with strong consistency guarantees:
 * - One-time use verification
 * - Immediate status updates (pending → approved/denied)
 * - Polling rate limiting (slow_down detection)
 *
 * Storage Strategy:
 * - In-memory cache for hot data (active device codes)
 * - D1 for persistence and recovery
 * - User code → Device code mapping for lookup
 */

import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env } from '../types/env';
import type { DeviceCodeMetadata } from '../types/oidc';
import { isDeviceCodeExpired, DEVICE_FLOW_CONSTANTS } from '../utils/device-flow';

export class DeviceCodeStore {
  private state: DurableObjectState;
  private env: Env;

  // In-memory storage for active device codes
  private deviceCodes: Map<string, DeviceCodeMetadata> = new Map();
  // User code → Device code mapping for quick lookup
  private userCodeToDeviceCode: Map<string, string> = new Map();

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

      // Delete device code (consumed or expired)
      if (path === '/delete' && request.method === 'POST') {
        const { device_code } = (await request.json()) as { device_code: string };
        await this.deleteDeviceCode(device_code);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
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
    // Store in memory
    this.deviceCodes.set(metadata.device_code, metadata);
    this.userCodeToDeviceCode.set(metadata.user_code, metadata.device_code);

    // Persist to D1
    if (this.env.DB) {
      await this.env.DB.prepare(
        `INSERT INTO device_codes (
          device_code, user_code, client_id, scope, status,
          created_at, expires_at, poll_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          metadata.device_code,
          metadata.user_code,
          metadata.client_id,
          metadata.scope,
          metadata.status,
          metadata.created_at,
          metadata.expires_at,
          metadata.poll_count || 0
        )
        .run();
    }

    // Set expiration alarm to clean up expired codes
    const expiresIn = metadata.expires_at - Date.now();
    if (expiresIn > 0) {
      await this.state.storage.setAlarm(Date.now() + expiresIn);
    }
  }

  /**
   * Get device code metadata by device_code
   */
  private async getByDeviceCode(deviceCode: string): Promise<DeviceCodeMetadata | null> {
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

    // Fallback to D1
    if (this.env.DB) {
      const result = await this.env.DB.prepare('SELECT * FROM device_codes WHERE device_code = ?')
        .bind(deviceCode)
        .first<DeviceCodeMetadata>();

      if (result) {
        // Check if expired
        if (isDeviceCodeExpired(result)) {
          await this.deleteDeviceCode(deviceCode);
          return null;
        }

        // Warm up cache
        this.deviceCodes.set(deviceCode, result);
        this.userCodeToDeviceCode.set(result.user_code, deviceCode);
        return result;
      }
    }

    return null;
  }

  /**
   * Get device code metadata by user_code
   */
  private async getByUserCode(userCode: string): Promise<DeviceCodeMetadata | null> {
    // Check mapping first
    const deviceCode = this.userCodeToDeviceCode.get(userCode);

    if (deviceCode) {
      return this.getByDeviceCode(deviceCode);
    }

    // Fallback to D1
    if (this.env.DB) {
      const result = await this.env.DB.prepare('SELECT * FROM device_codes WHERE user_code = ?')
        .bind(userCode)
        .first<DeviceCodeMetadata>();

      if (result) {
        // Check if expired
        if (isDeviceCodeExpired(result)) {
          await this.deleteDeviceCode(result.device_code);
          return null;
        }

        // Warm up cache
        this.deviceCodes.set(result.device_code, result);
        this.userCodeToDeviceCode.set(userCode, result.device_code);
        return result;
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

    // Update in D1
    if (this.env.DB) {
      await this.env.DB.prepare(
        `UPDATE device_codes
         SET status = ?, user_id = ?, sub = ?
         WHERE device_code = ?`
      )
        .bind('approved', userId, sub, metadata.device_code)
        .run();
    }
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

    // Update in D1
    if (this.env.DB) {
      await this.env.DB.prepare('UPDATE device_codes SET status = ? WHERE device_code = ?')
        .bind('denied', metadata.device_code)
        .run();
    }
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

    // Update in D1 (periodic update to reduce writes)
    // Only update every 5 polls to reduce D1 load
    if (metadata.poll_count % 5 === 0 && this.env.DB) {
      await this.env.DB.prepare(
        'UPDATE device_codes SET last_poll_at = ?, poll_count = ? WHERE device_code = ?'
      )
        .bind(metadata.last_poll_at, metadata.poll_count, deviceCode)
        .run();
    }
  }

  /**
   * Delete device code (consumed or expired)
   */
  private async deleteDeviceCode(deviceCode: string): Promise<void> {
    const metadata = this.deviceCodes.get(deviceCode);

    if (metadata) {
      // Remove from in-memory storage
      this.deviceCodes.delete(deviceCode);
      this.userCodeToDeviceCode.delete(metadata.user_code);
    }

    // Delete from D1
    if (this.env.DB) {
      await this.env.DB.prepare('DELETE FROM device_codes WHERE device_code = ?')
        .bind(deviceCode)
        .run();
    }
  }

  /**
   * Alarm handler for cleaning up expired device codes
   */
  async alarm(): Promise<void> {
    console.log('DeviceCodeStore alarm: Cleaning up expired device codes');

    const now = Date.now();
    const expiredCodes: string[] = [];

    // Find expired codes in memory
    for (const [deviceCode, metadata] of this.deviceCodes.entries()) {
      if (isDeviceCodeExpired(metadata)) {
        expiredCodes.push(deviceCode);
      }
    }

    // Delete expired codes
    for (const deviceCode of expiredCodes) {
      await this.deleteDeviceCode(deviceCode);
    }

    // Clean up expired codes in D1
    if (this.env.DB) {
      await this.env.DB.prepare('DELETE FROM device_codes WHERE expires_at < ?').bind(now).run();
    }

    console.log(`DeviceCodeStore: Cleaned up ${expiredCodes.length} expired device codes`);

    // Schedule next cleanup (every 5 minutes)
    await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
  }
}
