import type { AgentScope } from './types';

export type AgentConsentType = 'delegation' | 'oauth_client';

export interface AgentConsentContract {
  id: string;
  tenantId: string;
  grantId: string;
  userId: string;
  clientId: string;
  type: AgentConsentType;
  consentVersion: number;
  scopes: readonly AgentScope[];
  grantedAt: number;
  revokedAt?: number;
  revokedReason?: 'user' | 'grant_updated' | 'grant_revoked' | 'admin';
}

export function hasCurrentAgentConsent(
  consents: readonly AgentConsentContract[],
  grantConsentVersion: number
): boolean {
  const active = consents.filter((consent) => consent.revokedAt === undefined);
  const delegation = active.find((consent) => consent.type === 'delegation');
  const oauthClient = active.find((consent) => consent.type === 'oauth_client');
  return Boolean(
    delegation &&
    oauthClient &&
    delegation.tenantId === oauthClient.tenantId &&
    delegation.grantId === oauthClient.grantId &&
    delegation.userId === oauthClient.userId &&
    delegation.clientId === oauthClient.clientId &&
    delegation.consentVersion === grantConsentVersion
  );
}
