import { describe, expect, it, vi } from 'vitest';
import type { AgentDownscopeExchangeRequest } from '@authrim/ar-agent-access/core';
import {
  AgentDownscopeEntrypoint,
  SAML_DR_WRITER_SURFACES,
  exchangeAgentAccessToken,
} from '../entrypoints/AgentDownscopeEntrypoint';

const request: AgentDownscopeExchangeRequest = {
  subjectToken: 'mcp-token',
  tenantId: 'tenant-1',
  issuerOrigin: 'https://tenant-1.authrim.example',
  audience: 'authrim:admin-api',
  permissions: ['admin:users:read'],
  grantId: 'grant-1',
  grantGeneration: 3,
  delegatorId: 'admin-1',
  consentVersion: 2,
  actorSub: 'client:client-1',
  actorMode: 'mode_a',
  actorAssurance: 'public_client_transaction',
  clientId: 'client-1',
  correlationId: 'correlation-1',
};

const reachedVerification = new Error('feature_enabled');

/** Resolves true when the default feature flag let the exchange reach subject verification. */
async function featureEnabled(env: Record<string, unknown>): Promise<boolean> {
  const verifySubjectToken = vi.fn().mockRejectedValue(reachedVerification);
  try {
    await exchangeAgentAccessToken(env as never, request, { verifySubjectToken });
  } catch (error) {
    if (error === reachedVerification) return true;
    if (error instanceof Error && error.message === 'agent_mcp_disabled') return false;
    throw error;
  }
  throw new Error('unreachable');
}

function kv(value: string | null | Error) {
  return {
    get: vi.fn(async () => {
      if (value instanceof Error) throw value;
      return value;
    }),
  };
}

describe('default Agent MCP feature flag', () => {
  it('falls back to the environment flag when no settings store is bound', async () => {
    await expect(featureEnabled({ ENABLE_AGENT_MCP: 'true' })).resolves.toBe(true);
    await expect(featureEnabled({})).resolves.toBe(false);
    await expect(featureEnabled({ ENABLE_AGENT_MCP: 'false' })).resolves.toBe(false);
  });

  it('reads the tenant agent-access document from SETTINGS', async () => {
    const settings = kv(JSON.stringify({ 'agent.mcp.enabled': true }));
    await expect(featureEnabled({ SETTINGS: settings })).resolves.toBe(true);
    expect(settings.get).toHaveBeenCalledWith('settings:tenant:tenant-1:agent-access');
  });

  it('falls back to AUTHRIM_CONFIG when SETTINGS is not bound', async () => {
    const config = kv(JSON.stringify({ 'agent.mcp.enabled': true }));
    await expect(featureEnabled({ AUTHRIM_CONFIG: config })).resolves.toBe(true);
    expect(config.get).toHaveBeenCalledWith('settings:tenant:tenant-1:agent-access');
  });

  it('lets an explicit tenant opt-out override an enabled environment', async () => {
    await expect(
      featureEnabled({
        ENABLE_AGENT_MCP: 'true',
        SETTINGS: kv(JSON.stringify({ 'agent.mcp.enabled': false })),
      })
    ).resolves.toBe(false);
  });

  it('uses the environment flag when the tenant has no stored document', async () => {
    await expect(featureEnabled({ ENABLE_AGENT_MCP: 'true', SETTINGS: kv(null) })).resolves.toBe(
      true
    );
    await expect(featureEnabled({ SETTINGS: kv(null) })).resolves.toBe(false);
  });

  it('uses the environment flag when the document does not set the key', async () => {
    await expect(
      featureEnabled({ ENABLE_AGENT_MCP: 'true', SETTINGS: kv(JSON.stringify({ other: 1 })) })
    ).resolves.toBe(true);
  });

  it('treats a bare boolean document as the tenant value', async () => {
    await expect(featureEnabled({ SETTINGS: kv('true') })).resolves.toBe(true);
  });

  it.each([
    ['an array document', '[true]'],
    ['a null document', 'null'],
    ['a non-boolean key value', JSON.stringify({ 'agent.mcp.enabled': 'yes' })],
  ])('fails closed on %s even when the environment enables it', async (_name, raw) => {
    await expect(featureEnabled({ ENABLE_AGENT_MCP: 'true', SETTINGS: kv(raw) })).resolves.toBe(
      false
    );
  });

  it.each([
    ['an unreadable store', new Error('kv down')],
    ['malformed JSON', '{not json'],
  ])('fails closed on %s', async (_name, value) => {
    await expect(featureEnabled({ ENABLE_AGENT_MCP: 'true', SETTINGS: kv(value) })).resolves.toBe(
      false
    );
  });
});

describe('AgentDownscopeEntrypoint RPC facade', () => {
  const entrypoint = () => new AgentDownscopeEntrypoint({} as ExecutionContext, {} as never);

  it('runs the downscope exchange when SAML DR admission is not configured', async () => {
    await expect(entrypoint().exchangeAgentAccessToken({} as never)).rejects.toThrow(
      'invalid_agent_downscope_request'
    );
  });

  it('runs the Bulk child issuance when SAML DR admission is not configured', async () => {
    await expect(entrypoint().issueAgentBulkChildToken({} as never)).rejects.toThrow(
      'invalid_agent_bulk_child_request'
    );
  });

  it('declares both RPC methods as SAML DR writer surfaces', () => {
    expect(SAML_DR_WRITER_SURFACES).toEqual([
      'rpc:AgentDownscopeEntrypoint.exchangeAgentAccessToken',
      'rpc:AgentDownscopeEntrypoint.issueAgentBulkChildToken',
    ]);
  });
});
