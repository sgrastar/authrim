import type { AgentActorAssurance } from './types';

export interface ModeAAgentAccessTokenClaims {
  sub: string;
  jti: string;
  scope: string;
  client_id: string;
  tenant_id: string;
  grant_id: string;
  grant_generation: number;
  consent_version: number;
  actor_mode: 'mode_a';
  actor_assurance: Exclude<AgentActorAssurance, 'machine_key'>;
  token_binding: 'bearer' | 'dpop';
  act: { sub: string };
  cnf?: { jkt: string };
}

export interface ModeBAgentAccessTokenClaims extends Omit<
  ModeAAgentAccessTokenClaims,
  'actor_mode' | 'actor_assurance' | 'token_binding'
> {
  actor_mode: 'mode_b';
  actor_assurance: 'machine_key';
  token_binding: 'dpop';
  act_principal_id: string;
  act_credential_id: string;
  cnf: { jkt: string };
}

export type AgentAccessTokenClaims = ModeAAgentAccessTokenClaims | ModeBAgentAccessTokenClaims;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parses claims only after the caller has cryptographically verified issuer and audience. */
export function parseModeAAgentAccessTokenClaims(
  value: unknown
): ModeAAgentAccessTokenClaims | null {
  if (!isRecord(value) || !isRecord(value.act)) return null;
  const assurance = value.actor_assurance;
  const tokenBinding = value.token_binding;
  const requiredStrings = [
    value.sub,
    value.jti,
    value.scope,
    value.client_id,
    value.tenant_id,
    value.grant_id,
    value.act.sub,
  ];
  if (
    requiredStrings.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
    !Number.isSafeInteger(value.grant_generation) ||
    !Number.isSafeInteger(value.consent_version) ||
    value.actor_mode !== 'mode_a' ||
    (assurance !== 'public_client_transaction' && assurance !== 'confidential_client') ||
    (tokenBinding !== 'bearer' && tokenBinding !== 'dpop')
  ) {
    return null;
  }
  if (value.cnf !== undefined && (!isRecord(value.cnf) || typeof value.cnf.jkt !== 'string')) {
    return null;
  }
  return value as unknown as ModeAAgentAccessTokenClaims;
}

export function parseAgentAccessTokenClaims(value: unknown): AgentAccessTokenClaims | null {
  const modeA = parseModeAAgentAccessTokenClaims(value);
  if (modeA) return modeA;
  if (!isRecord(value) || !isRecord(value.act) || !isRecord(value.cnf)) return null;
  const requiredStrings = [
    value.sub,
    value.jti,
    value.scope,
    value.client_id,
    value.tenant_id,
    value.grant_id,
    value.act.sub,
    value.act_principal_id,
    value.act_credential_id,
    value.cnf.jkt,
  ];
  if (
    requiredStrings.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
    !Number.isSafeInteger(value.grant_generation) ||
    !Number.isSafeInteger(value.consent_version) ||
    value.actor_mode !== 'mode_b' ||
    value.actor_assurance !== 'machine_key' ||
    value.token_binding !== 'dpop' ||
    value.act.sub !== `machine:${value.act_principal_id}`
  ) {
    return null;
  }
  return value as unknown as ModeBAgentAccessTokenClaims;
}
