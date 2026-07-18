import { describe, expect, it } from 'vitest';
import type { AgentAccessMcpRequestContext } from '../../../protocol/mcp';
import {
  decodeCloudflareAgentAccessRequestContext,
  encodeCloudflareAgentAccessRequestContext,
  getCloudflareAgentAccessCurrentRequest,
  runWithCloudflareAgentAccessRequest,
} from '../mcp-request-context';

const context: AgentAccessMcpRequestContext = {
  actor: {
    mode: 'mode_a',
    sub: 'client:client-1',
    assurance: 'public_client_transaction',
    tokenBinding: 'bearer',
    clientId: 'client-1',
  },
  grant: {
    grantId: 'grant-1',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    grantorId: 'admin-1',
    delegatorId: 'admin-1',
    permissions: ['admin:users:read'],
    scopes: ['agent:read'],
    resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
    consentVersion: 1,
    generation: 1,
    status: 'active',
    delegationMode: 'user_consent',
  },
  resource: { tenantId: 'tenant-1' },
  issuerOrigin: 'https://tenant-1.authrim.example',
  correlationId: 'correlation-1',
};

describe('Cloudflare Agent request-local context', () => {
  it('round-trips the verified non-secret context through the internal header', () => {
    expect(
      decodeCloudflareAgentAccessRequestContext(encodeCloudflareAgentAccessRequestContext(context))
    ).toEqual(context);
  });

  it('rejects malformed or oversized internal context values', () => {
    expect(decodeCloudflareAgentAccessRequestContext('not-json')).toBeNull();
    expect(decodeCloudflareAgentAccessRequestContext('a'.repeat(30_000))).toBeNull();
  });

  it('keeps the source token request-local instead of putting it in persistent props', async () => {
    expect(getCloudflareAgentAccessCurrentRequest()).toBeUndefined();
    await runWithCloudflareAgentAccessRequest(
      { context, sourceAccessToken: 'raw-token' },
      async () => {
        await Promise.resolve();
        expect(getCloudflareAgentAccessCurrentRequest()).toEqual({
          context,
          sourceAccessToken: 'raw-token',
        });
      }
    );
    expect(getCloudflareAgentAccessCurrentRequest()).toBeUndefined();
  });
});
