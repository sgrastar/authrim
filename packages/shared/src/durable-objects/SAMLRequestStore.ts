/**
 * SAMLRequestStore Durable Object
 *
 * Manages SAML Request IDs and Assertion IDs for:
 * - Replay attack prevention (one-time use guarantee)
 * - InResponseTo validation
 * - RelayState preservation
 *
 * Sharding Strategy: By issuer Entity ID
 * Instance name format: `issuer:{entityId}`
 */

import type { Env } from '../types/env';
import type { SAMLRequestData, SAMLArtifactData } from '../types/saml';

/**
 * SAMLRequestStore Durable Object State
 */
interface SAMLRequestStoreState {
  /** Pending SAML requests (AuthnRequest, LogoutRequest) */
  requests: Map<string, SAMLRequestData>;
  /** SAML artifacts (for Artifact Binding) */
  artifacts: Map<string, SAMLArtifactData>;
  /** Consumed assertion IDs (for replay prevention) */
  consumedAssertionIds: Set<string>;
}

/**
 * Request expiry time in milliseconds (5 minutes)
 */
const REQUEST_EXPIRY_MS = 5 * 60 * 1000;

/**
 * Artifact expiry time in milliseconds (5 minutes)
 */
const ARTIFACT_EXPIRY_MS = 5 * 60 * 1000;

/**
 * Assertion ID retention time in milliseconds (30 minutes)
 * Kept longer than assertion validity for overlap protection
 */
const ASSERTION_ID_RETENTION_MS = 30 * 60 * 1000;

/**
 * SAMLRequestStore Durable Object
 */
export class SAMLRequestStore {
  private state: DurableObjectState;
  private env: Env;
  private storeState: SAMLRequestStoreState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /**
   * Initialize state from storage
   */
  private async initializeState(): Promise<void> {
    if (this.storeState !== null) {
      return;
    }

    const stored = await this.state.storage.get<{
      requests: Array<[string, SAMLRequestData]>;
      artifacts: Array<[string, SAMLArtifactData]>;
      consumedAssertionIds: string[];
    }>('state');

    if (stored) {
      this.storeState = {
        requests: new Map(stored.requests),
        artifacts: new Map(stored.artifacts),
        consumedAssertionIds: new Set(stored.consumedAssertionIds),
      };
    } else {
      this.storeState = {
        requests: new Map(),
        artifacts: new Map(),
        consumedAssertionIds: new Set(),
      };
    }

    // Schedule cleanup
    await this.cleanupExpired();
  }

  /**
   * Get state with assertion
   */
  private getState(): SAMLRequestStoreState {
    if (!this.storeState) {
      throw new Error('SAMLRequestStore state not initialized');
    }
    return this.storeState;
  }

  /**
   * Save state to storage
   */
  private async saveState(): Promise<void> {
    if (!this.storeState) return;

    await this.state.storage.put('state', {
      requests: Array.from(this.storeState.requests.entries()),
      artifacts: Array.from(this.storeState.artifacts.entries()),
      consumedAssertionIds: Array.from(this.storeState.consumedAssertionIds),
    });
  }

  /**
   * Store a SAML request
   */
  async storeRequest(request: SAMLRequestData): Promise<void> {
    await this.initializeState();
    const state = this.getState();

    state.requests.set(request.requestId, {
      ...request,
      createdAt: Date.now(),
      expiresAt: request.expiresAt || Date.now() + REQUEST_EXPIRY_MS,
    });

    await this.saveState();
  }

  /**
   * Get and consume a SAML request (one-time use)
   */
  async consumeRequest(requestId: string): Promise<SAMLRequestData | null> {
    await this.initializeState();
    const state = this.getState();

    const request = state.requests.get(requestId);
    if (!request) {
      return null;
    }

    // Check if expired
    if (Date.now() > request.expiresAt) {
      state.requests.delete(requestId);
      await this.saveState();
      return null;
    }

    // Check if already used
    if (request.used) {
      console.warn(`SAML request replay detected: ${requestId}`);
      return null;
    }

    // Mark as used (don't delete immediately for audit)
    request.used = true;
    await this.saveState();

    return request;
  }

  /**
   * Check if a request exists and is valid (without consuming)
   */
  async checkRequest(requestId: string): Promise<boolean> {
    await this.initializeState();
    const state = this.getState();

    const request = state.requests.get(requestId);
    if (!request) {
      return false;
    }

    return !request.used && Date.now() <= request.expiresAt;
  }

  /**
   * Store a SAML artifact
   */
  async storeArtifact(artifact: SAMLArtifactData): Promise<void> {
    await this.initializeState();
    const state = this.getState();

    state.artifacts.set(artifact.artifact, {
      ...artifact,
      createdAt: Date.now(),
      expiresAt: artifact.expiresAt || Date.now() + ARTIFACT_EXPIRY_MS,
    });

    await this.saveState();
  }

  /**
   * Resolve and consume a SAML artifact (one-time use)
   */
  async resolveArtifact(artifactValue: string): Promise<SAMLArtifactData | null> {
    await this.initializeState();
    const state = this.getState();

    const artifact = state.artifacts.get(artifactValue);
    if (!artifact) {
      return null;
    }

    // Check if expired
    if (Date.now() > artifact.expiresAt) {
      state.artifacts.delete(artifactValue);
      await this.saveState();
      return null;
    }

    // Check if already used
    if (artifact.used) {
      console.warn(`SAML artifact replay detected: ${artifactValue}`);
      return null;
    }

    // Mark as used and return
    artifact.used = true;
    await this.saveState();

    return artifact;
  }

  /**
   * Check if an assertion ID has been consumed (replay detection)
   */
  async checkAssertionId(assertionId: string): Promise<boolean> {
    await this.initializeState();
    const state = this.getState();

    return state.consumedAssertionIds.has(assertionId);
  }

  /**
   * Mark an assertion ID as consumed
   */
  async consumeAssertionId(assertionId: string): Promise<boolean> {
    await this.initializeState();
    const state = this.getState();

    // Check if already consumed (replay attack)
    if (state.consumedAssertionIds.has(assertionId)) {
      console.warn(`SAML assertion replay detected: ${assertionId}`);
      return false;
    }

    // Mark as consumed
    state.consumedAssertionIds.add(assertionId);
    await this.saveState();

    return true;
  }

  /**
   * Clean up expired entries
   */
  private async cleanupExpired(): Promise<void> {
    const state = this.getState();
    const now = Date.now();
    let changed = false;

    // Clean up expired requests
    for (const [id, request] of state.requests) {
      if (now > request.expiresAt + 60000) {
        // Keep for 1 minute after expiry for debugging
        state.requests.delete(id);
        changed = true;
      }
    }

    // Clean up expired artifacts
    for (const [id, artifact] of state.artifacts) {
      if (now > artifact.expiresAt + 60000) {
        state.artifacts.delete(id);
        changed = true;
      }
    }

    // Note: consumedAssertionIds are not automatically cleaned up
    // In production, you might want a scheduled cleanup based on timestamp

    if (changed) {
      await this.saveState();
    }
  }

  /**
   * Handle HTTP requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // POST /store - Store a SAML request
      if (path === '/store' && request.method === 'POST') {
        const body = (await request.json()) as SAMLRequestData;
        await this.storeRequest(body);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /consume/:requestId - Consume a SAML request
      if (path.startsWith('/consume/') && request.method === 'POST') {
        const requestId = path.substring('/consume/'.length);
        const result = await this.consumeRequest(requestId);

        if (!result) {
          return new Response(JSON.stringify({ error: 'Request not found or already used' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // GET /check/:requestId - Check if request exists
      if (path.startsWith('/check/') && request.method === 'GET') {
        const requestId = path.substring('/check/'.length);
        const exists = await this.checkRequest(requestId);

        return new Response(JSON.stringify({ exists }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /artifact - Store an artifact
      if (path === '/artifact' && request.method === 'POST') {
        const body = (await request.json()) as SAMLArtifactData;
        await this.storeArtifact(body);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /artifact/resolve - Resolve an artifact
      if (path === '/artifact/resolve' && request.method === 'POST') {
        const body = (await request.json()) as { artifact: string };
        const result = await this.resolveArtifact(body.artifact);

        if (!result) {
          return new Response(JSON.stringify({ error: 'Artifact not found or already used' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /assertion/consume - Consume an assertion ID
      if (path === '/assertion/consume' && request.method === 'POST') {
        const body = (await request.json()) as { assertionId: string };
        const success = await this.consumeAssertionId(body.assertionId);

        return new Response(JSON.stringify({ success }), {
          headers: { 'Content-Type': 'application/json' },
          status: success ? 200 : 409,
        });
      }

      // GET /assertion/check/:assertionId - Check if assertion was consumed
      if (path.startsWith('/assertion/check/') && request.method === 'GET') {
        const assertionId = path.substring('/assertion/check/'.length);
        const consumed = await this.checkAssertionId(assertionId);

        return new Response(JSON.stringify({ consumed }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('SAMLRequestStore error:', error);
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}
