/**
 * Session-client logout target repository.
 *
 * Session-to-client associations are authoritative in SessionClientStore Durable Objects. This
 * repository only hydrates those business-state records with tenant-scoped OAuth client logout
 * configuration from the routed tenant Core database.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import type { SessionClientWithWebhook } from '../../types/logout';
import { requireTenantId } from '../tenant';

export interface SessionClient {
  id: string;
  tenant_id: string;
  session_id: string;
  client_id: string;
  oidc_sid?: string;
  first_token_at: number;
  last_token_at: number;
  last_seen_at: number | null;
}

export interface CreateSessionClientInput {
  session_id: string;
  client_id: string;
  oidc_sid?: string;
}

export interface SessionClientWithDetails extends SessionClient {
  client_name: string | null;
  backchannel_logout_uri: string | null;
  backchannel_logout_session_required: boolean;
  frontchannel_logout_uri: string | null;
  frontchannel_logout_session_required: boolean;
}

interface SessionClientLogoutDetailsRow {
  client_id: string;
  client_name: string | null;
  backchannel_logout_uri: string | null;
  backchannel_logout_session_required: number;
  frontchannel_logout_uri: string | null;
  frontchannel_logout_session_required: number;
  logout_webhook_uri: string | null;
  logout_webhook_secret_encrypted: string | null;
}

export interface HydratedSessionClientLogoutTargets {
  backchannelClients: SessionClientWithDetails[];
  frontchannelClients: SessionClientWithDetails[];
  webhookClients: SessionClientWithWebhook[];
}

export class SessionClientRepository {
  private readonly tenantId: string;

  constructor(
    private readonly adapter: DatabaseAdapter,
    tenantId: string
  ) {
    this.tenantId = requireTenantId(tenantId, 'SessionClientRepository');
  }

  async listLogoutCandidateClientIds(): Promise<string[]> {
    const rows = await this.adapter.query<{ client_id: string }>(
      `
        SELECT client_id
        FROM oauth_clients
        WHERE tenant_id = ?
          AND (
            backchannel_logout_uri IS NOT NULL
            OR frontchannel_logout_uri IS NOT NULL
            OR logout_webhook_uri IS NOT NULL
          )
      `,
      [this.tenantId]
    );
    return [...new Set(rows.map((row) => row.client_id).filter(Boolean))];
  }

  async hydrateLogoutTargetsFromSessionClients(
    sessionClients: SessionClient[]
  ): Promise<HydratedSessionClientLogoutTargets> {
    const tenantScopedClients = sessionClients.filter(
      (client) => client.tenant_id === this.tenantId
    );
    const clientIds = [...new Set(tenantScopedClients.map((client) => client.client_id))];
    if (clientIds.length === 0) {
      return {
        backchannelClients: [],
        frontchannelClients: [],
        webhookClients: [],
      };
    }

    const placeholders = clientIds.map(() => '?').join(', ');
    const rows = await this.adapter.query<SessionClientLogoutDetailsRow>(
      `
        SELECT
          client_id,
          client_name,
          backchannel_logout_uri,
          backchannel_logout_session_required,
          frontchannel_logout_uri,
          frontchannel_logout_session_required,
          logout_webhook_uri,
          logout_webhook_secret_encrypted
        FROM oauth_clients
        WHERE tenant_id = ? AND client_id IN (${placeholders})
      `,
      [this.tenantId, ...clientIds]
    );
    const detailsByClientId = new Map(rows.map((row) => [row.client_id, row]));
    const withDetails = tenantScopedClients.flatMap((client): SessionClientWithDetails[] => {
      const details = detailsByClientId.get(client.client_id);
      if (!details) return [];
      return [
        {
          ...client,
          client_name: details.client_name,
          backchannel_logout_uri: details.backchannel_logout_uri,
          backchannel_logout_session_required: Boolean(details.backchannel_logout_session_required),
          frontchannel_logout_uri: details.frontchannel_logout_uri,
          frontchannel_logout_session_required: Boolean(
            details.frontchannel_logout_session_required
          ),
        },
      ];
    });

    return {
      backchannelClients: withDetails.filter((client) => Boolean(client.backchannel_logout_uri)),
      frontchannelClients: withDetails.filter((client) => Boolean(client.frontchannel_logout_uri)),
      webhookClients: tenantScopedClients.flatMap((client): SessionClientWithWebhook[] => {
        const details = detailsByClientId.get(client.client_id);
        if (!details?.logout_webhook_uri) return [];
        return [
          {
            id: client.id,
            session_id: client.session_id,
            client_id: client.client_id,
            oidc_sid: client.oidc_sid,
            client_name: details.client_name,
            logout_webhook_uri: details.logout_webhook_uri,
            logout_webhook_secret_encrypted: details.logout_webhook_secret_encrypted,
          },
        ];
      }),
    };
  }
}
