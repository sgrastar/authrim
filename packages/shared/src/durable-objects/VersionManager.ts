/**
 * VersionManager Durable Object
 *
 * Manages code version identifiers for Cloudflare Workers to detect and
 * reject stale bundles. Each Worker's version is tracked independently,
 * allowing partial deployments.
 *
 * Key Features:
 * - UUID-based version identification (CODE_VERSION_UUID)
 * - Worker-specific version tracking
 * - Deploy timestamp tracking (DEPLOY_TIME_UTC)
 * - Forced shutdown of outdated Worker bundles
 *
 * Security:
 * - Version information is never exposed to external clients
 * - All write operations require Bearer token authentication
 * - Used only for internal deployment tracking
 */

import type { Env } from '../types/env';
import { timingSafeEqual } from '../utils/crypto';

/**
 * Version record for a single Worker
 */
interface VersionRecord {
  uuid: string;
  deployTime: string; // ISO 8601 format
  registeredAt: number; // Unix timestamp of registration
}

/**
 * VersionManager Durable Object State
 */
interface VersionManagerState {
  versions: Record<string, VersionRecord>; // workerName -> VersionRecord
}

/**
 * VersionManager Durable Object
 *
 * Centralized version management for all Workers in the deployment.
 */
export class VersionManager {
  private state: DurableObjectState;
  private env: Env;
  private versionManagerState: VersionManagerState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /**
   * Initialize the VersionManager state
   */
  private async initializeState(): Promise<void> {
    if (this.versionManagerState !== null) {
      return;
    }

    const stored = await this.state.storage.get<VersionManagerState>('state');

    if (stored) {
      this.versionManagerState = stored;
    } else {
      // Initialize with empty state
      this.versionManagerState = {
        versions: {},
      };
      await this.saveState();
    }
  }

  /**
   * Get state with assertion that it has been initialized
   */
  private getState(): VersionManagerState {
    if (!this.versionManagerState) {
      throw new Error('VersionManager state not initialized');
    }
    return this.versionManagerState;
  }

  /**
   * Save state to durable storage
   */
  private async saveState(): Promise<void> {
    if (this.versionManagerState) {
      await this.state.storage.put('state', this.versionManagerState);
    }
  }

  /**
   * Register a new version for a Worker
   */
  async registerVersion(workerName: string, uuid: string, deployTime: string): Promise<void> {
    await this.initializeState();

    const state = this.getState();
    state.versions[workerName] = {
      uuid,
      deployTime,
      registeredAt: Date.now(),
    };

    await this.saveState();

    console.log(`[VersionManager] Registered version for ${workerName}`, {
      uuid,
      deployTime,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get the latest version for a Worker
   */
  async getVersion(workerName: string): Promise<VersionRecord | null> {
    await this.initializeState();

    const state = this.getState();
    return state.versions[workerName] || null;
  }

  /**
   * Get all registered versions
   */
  async getAllVersions(): Promise<Record<string, VersionRecord>> {
    await this.initializeState();

    const state = this.getState();
    return { ...state.versions };
  }

  /**
   * Authenticate requests using Bearer token
   */
  private authenticate(request: Request): boolean {
    const authHeader = request.headers.get('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return false;
    }

    const token = authHeader.substring(7);
    const secret = this.env.ADMIN_API_SECRET;

    // If no secret is configured, deny all requests
    if (!secret) {
      console.error('[VersionManager] ADMIN_API_SECRET is not configured');
      return false;
    }

    // Constant-time comparison to prevent timing attacks
    return timingSafeEqual(token, secret);
  }

  /**
   * Create an unauthorized response
   */
  private unauthorizedResponse(): Response {
    return new Response(
      JSON.stringify({
        error: 'Unauthorized',
        message: 'Valid authentication token required',
      }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="VersionManager"',
        },
      }
    );
  }

  /**
   * Handle HTTP requests to the VersionManager Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /version/:workerName - Get version for a specific Worker (no auth required for read)
      const versionMatch = path.match(/^\/version\/([a-z0-9-]+)$/);
      if (versionMatch && request.method === 'GET') {
        const workerName = versionMatch[1];
        const version = await this.getVersion(workerName);

        if (!version) {
          return new Response(JSON.stringify({ error: 'Version not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify(version), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /version/:workerName - Register version for a Worker (auth required)
      if (versionMatch && request.method === 'POST') {
        if (!this.authenticate(request)) {
          return this.unauthorizedResponse();
        }

        const workerName = versionMatch[1];
        const body = (await request.json()) as { uuid: string; deployTime: string };

        if (!body.uuid || !body.deployTime) {
          return new Response(
            JSON.stringify({
              error: 'Bad Request',
              message: 'uuid and deployTime are required',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        await this.registerVersion(workerName, body.uuid, body.deployTime);

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // GET /version-manager/status - Get all versions (auth required)
      if (path === '/version-manager/status' && request.method === 'GET') {
        if (!this.authenticate(request)) {
          return this.unauthorizedResponse();
        }

        const versions = await this.getAllVersions();

        return new Response(
          JSON.stringify({
            versions,
            workerCount: Object.keys(versions).length,
            timestamp: new Date().toISOString(),
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('[VersionManager] Error:', error);
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}
