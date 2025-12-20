/**
 * Credential Offer Store Durable Object
 *
 * Manages credential offer state for OpenID4VCI.
 */

interface CredentialOfferState {
  id: string;
  tenantId: string;
  userId: string;
  credentialConfigurationId: string;
  preAuthorizedCode: string;
  txCode?: string;
  status: 'pending' | 'claimed' | 'expired';
  createdAt: number;
  expiresAt: number;
}

export class CredentialOfferStore {
  private state: DurableObjectState;
  private offer: CredentialOfferState | null = null;

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
        case '/claim':
          return this.handleClaim();
        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (error) {
      console.error('[CredentialOfferStore] Error:', error);
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * Create a new credential offer
   */
  private async handleCreate(request: Request): Promise<Response> {
    const offer = (await request.json()) as CredentialOfferState;

    this.offer = offer;
    await this.state.storage.put('offer', offer);

    // Set alarm for expiration
    await this.state.storage.setAlarm(offer.expiresAt);

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Get the credential offer
   */
  private async handleGet(): Promise<Response> {
    if (!this.offer) {
      this.offer = (await this.state.storage.get<CredentialOfferState>('offer')) || null;
    }

    if (!this.offer) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(this.offer), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Mark offer as claimed
   */
  private async handleClaim(): Promise<Response> {
    if (!this.offer) {
      this.offer = (await this.state.storage.get<CredentialOfferState>('offer')) || null;
    }

    if (!this.offer) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (this.offer.status !== 'pending') {
      return new Response(JSON.stringify({ error: `Offer is ${this.offer.status}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    this.offer.status = 'claimed';
    await this.state.storage.put('offer', this.offer);

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Handle alarm (mark as expired)
   */
  async alarm(): Promise<void> {
    if (!this.offer) {
      this.offer = (await this.state.storage.get<CredentialOfferState>('offer')) || null;
    }

    if (this.offer && this.offer.status === 'pending') {
      this.offer.status = 'expired';
      await this.state.storage.put('offer', this.offer);
    }
  }
}
