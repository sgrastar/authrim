import { describe, expect, it } from 'vitest';
import type { CloudflareAgentAccessMcpProps } from '../mcp-props';
import { sanitizeCloudflareAgentAccessMcpPropsForStorage } from '../mcp-props';

const props: CloudflareAgentAccessMcpProps = {
  sourceAccessToken: 'raw-bearer-token',
  context: {
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
  },
};

describe('Cloudflare McpAgent props persistence boundary', () => {
  it('removes the source token while retaining only verified context', () => {
    const stored = sanitizeCloudflareAgentAccessMcpPropsForStorage(props);
    expect(stored).toEqual({ context: props.context });
    expect(stored).not.toHaveProperty('sourceAccessToken');
    expect(JSON.stringify(stored)).not.toContain('raw-bearer-token');
  });
});
