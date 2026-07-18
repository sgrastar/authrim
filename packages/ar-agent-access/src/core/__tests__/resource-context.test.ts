import { describe, expect, it } from 'vitest';
import { buildAgentToolResourceContext } from '../resource-context';

describe('buildAgentToolResourceContext', () => {
  it('derives client write constraints only from the fixed Tool contract and validated input', () => {
    expect(
      buildAgentToolResourceContext({
        base: { tenantId: 'tenant-1', domain: 'caller-controlled' },
        toolId: 'admin.write.clients.metadata',
        arguments: {
          client_id: 'client-1',
          resource_version: 'version-1',
          client_name: 'Updated',
          description: 'Description',
        },
      })
    ).toEqual({
      tenantId: 'tenant-1',
      domain: 'clients',
      resourceId: 'client-1',
      requestedFields: ['client_name', 'description'],
      quantity: 1,
      requestsUnmaskedPii: false,
    });
  });

  it('derives domains and fields for runtime, Login UI, and client security tools', () => {
    expect(
      buildAgentToolResourceContext({
        base: { tenantId: 'tenant-1' },
        toolId: 'admin.read.runtime.diagnostics',
        arguments: {},
      })
    ).toMatchObject({ domain: 'runtime_diagnostics' });
    expect(
      buildAgentToolResourceContext({
        base: { tenantId: 'tenant-1' },
        toolId: 'admin.write.login-ui.update',
        arguments: { resource_version: 'v1', brandName: 'Example' },
      })
    ).toMatchObject({ domain: 'login_ui', requestedFields: ['brandName'] });
    expect(
      buildAgentToolResourceContext({
        base: { tenantId: 'tenant-1' },
        toolId: 'admin.write.clients.protocol-security',
        arguments: { client_id: 'client-1', resource_version: 'v1', require_pkce: true },
      })
    ).toMatchObject({
      domain: 'clients',
      resourceId: 'client-1',
      requestedFields: ['require_pkce'],
    });
  });

  it('uses a trusted resolved Bulk tenant instead of the base request tenant', () => {
    expect(
      buildAgentToolResourceContext({
        base: { tenantId: 'control' },
        tenantId: 'target',
        toolId: 'admin.read.clients.get',
        arguments: { client_id: 'client-1' },
      })
    ).toMatchObject({ tenantId: 'target', domain: 'clients', resourceId: 'client-1' });
  });

  it('maps user suspension to the server-owned status field only', () => {
    expect(
      buildAgentToolResourceContext({
        base: { tenantId: 'tenant-1' },
        toolId: 'admin.write.users.suspend',
        arguments: {
          user_id: 'user-1',
          reason_code: 'security_review',
          revoke_sessions: true,
          revoke_tokens: true,
        },
      })
    ).toEqual({
      tenantId: 'tenant-1',
      domain: 'users',
      resourceId: 'user-1',
      requestedFields: ['status'],
      quantity: 1,
      requestsUnmaskedPii: false,
    });
  });
});
