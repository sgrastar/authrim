/**
 * VP Request Store Durable Object
 *
 * Manages VP authorization request state.
 * Ensures single-use nonces and request lifecycle.
 */

import type { VPRequestState } from '../../types';

export class VPRequestStore {
  private state: DurableObjectState;
  private request: VPRequestState | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case '/create':
          return this.handleCreate(request);
        case '/get':
          return this.handleGet();
        case '/update':
          return this.handleUpdate(request);
        case '/update-status':
          return this.handleUpdateStatus(request);
        case '/consume-nonce':
          return this.handleConsumeNonce(request);
        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (error) {
      console.error('[VPRequestStore] Error:', error);
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * Create a new VP request
   */
  private async handleCreate(request: Request): Promise<Response> {
    const vpRequest = (await request.json()) as VPRequestState;

    // Store the request
    this.request = vpRequest;
    await this.state.storage.put('request', vpRequest);

    // Store nonce for single-use check
    await this.state.storage.put(`nonce:${vpRequest.nonce}`, {
      createdAt: Date.now(),
      consumed: false,
    });

    // Set alarm for expiration cleanup
    await this.state.storage.setAlarm(vpRequest.expiresAt);

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Get the VP request
   */
  private async handleGet(): Promise<Response> {
    if (!this.request) {
      this.request = (await this.state.storage.get<VPRequestState>('request')) || null;
    }

    if (!this.request) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(this.request), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Update the VP request
   */
  private async handleUpdate(request: Request): Promise<Response> {
    const updates = (await request.json()) as Partial<VPRequestState>;

    if (!this.request) {
      this.request = (await this.state.storage.get<VPRequestState>('request')) || null;
    }

    if (!this.request) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Merge updates
    this.request = { ...this.request, ...updates };
    await this.state.storage.put('request', this.request);

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Update just the status
   */
  private async handleUpdateStatus(request: Request): Promise<Response> {
    const { status } = (await request.json()) as { status: VPRequestState['status'] };

    if (!this.request) {
      this.request = (await this.state.storage.get<VPRequestState>('request')) || null;
    }

    if (!this.request) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    this.request.status = status;
    await this.state.storage.put('request', this.request);

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Consume a nonce (single-use enforcement)
   */
  private async handleConsumeNonce(request: Request): Promise<Response> {
    const { nonce } = (await request.json()) as { nonce: string };

    const nonceData = await this.state.storage.get<{ createdAt: number; consumed: boolean }>(
      `nonce:${nonce}`
    );

    if (!nonceData) {
      return new Response(JSON.stringify({ consumed: false, error: 'Nonce not found' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (nonceData.consumed) {
      return new Response(JSON.stringify({ consumed: false, error: 'Nonce already consumed' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Mark as consumed
    await this.state.storage.put(`nonce:${nonce}`, {
      ...nonceData,
      consumed: true,
      consumedAt: Date.now(),
    });

    return new Response(JSON.stringify({ consumed: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Handle alarm (cleanup expired requests)
   */
  async alarm(): Promise<void> {
    if (!this.request) {
      this.request = (await this.state.storage.get<VPRequestState>('request')) || null;
    }

    if (this.request && this.request.status === 'pending') {
      this.request.status = 'expired';
      await this.state.storage.put('request', this.request);
    }

    // Clean up after some time
    // In production, you might want to keep records longer for audit
  }
}
