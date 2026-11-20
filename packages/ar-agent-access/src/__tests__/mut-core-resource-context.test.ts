import { describe, expect, it } from 'vitest';
import { buildAgentToolResourceContext } from '../core/resource-context';
import type { AgentResourceRequestContext, JsonObject } from '../core/types';

const base: AgentResourceRequestContext = {
  tenantId: 'tenant-1',
  domain: 'fallback',
  resourceId: 'base-resource',
};
const build = (toolId: string, args: JsonObject = {}, tenantId?: string) =>
  buildAgentToolResourceContext({ base, toolId, arguments: args, tenantId });

describe('buildAgentToolResourceContext domain mapping', () => {
  it.each([
    ['admin.read.runtime.diagnostics', 'runtime_diagnostics'],
    ['admin.read.users.search', 'users'],
    ['admin.write.users.suspend', 'users'],
    ['admin.read.clients.list', 'clients'],
    ['admin.write.clients.metadata', 'clients'],
    ['admin.read.identity-providers.list', 'identity_providers'],
    ['admin.read.authorization.policies', 'authorization'],
    ['admin.read.flows.list', 'flows'],
    ['admin.read.consent.list', 'consent'],
    ['admin.read.sessions.list', 'sessions'],
    ['admin.read.assurance.get', 'assurance'],
    ['admin.read.protocol-security.get', 'protocol_security'],
    ['admin.read.oauth.get', 'protocol_security'],
    ['admin.read.token-exchange.get', 'protocol_security'],
    ['admin.write.protocol-security.update', 'protocol_security'],
    ['admin.write.oauth.update', 'protocol_security'],
    ['admin.write.token-exchange.update', 'protocol_security'],
    ['admin.read.logout.get', 'logout'],
    ['admin.write.session.revoke', 'logout'],
    ['admin.read.login-ui.get', 'login_ui'],
    ['admin.write.login-ui.update', 'login_ui'],
    ['admin.read.conformance.get', 'conformance'],
    ['admin.read.webhooks.list', 'webhooks'],
    ['admin.read.audit.list', 'admin_audit'],
    ['admin.read.agent-settings.get', 'agent_settings'],
    ['admin.read.configuration.plan.get', 'configuration'],
    ['admin.write.configuration.plan.apply', 'configuration'],
    ['admin.read.bulk.plan.get', 'bulk_plans'],
    ['admin.write.bulk.plan.create', 'bulk_plans'],
    ['admin.read.unknown.thing', 'fallback'],
    ['x.admin.read.users.', 'fallback'],
  ])('maps %s to %s', (toolId, domain) => {
    expect(build(toolId).domain).toBe(domain);
  });
});

describe('buildAgentToolResourceContext resource and fields', () => {
  it('builds the exact context for a read tool', () => {
    expect(
      build('admin.read.clients.list', { client_id: 'c1', client_name: 'x', page_size: 25 })
    ).toStrictEqual({
      tenantId: 'tenant-1',
      domain: 'clients',
      resourceId: 'c1',
      quantity: 25,
      requestsUnmaskedPii: false,
    });
  });

  it('prefers user_id, falls back to the base resource and replaces the tenant', () => {
    expect(build('admin.read.users.get', { user_id: 'u1', client_id: 'c1' })).toMatchObject({
      resourceId: 'u1',
    });
    expect(build('admin.read.users.get', { user_id: 7 })).toMatchObject({
      resourceId: 'base-resource',
      quantity: 1,
    });
    expect(build('admin.read.users.get', {}, 'tenant-2')).toMatchObject({ tenantId: 'tenant-2' });
    expect(build('admin.read.users.get', { page_size: '5' })).toMatchObject({ quantity: 1 });
  });

  it('keeps only allowlisted metadata fields for client metadata writes', () => {
    expect(
      build('admin.write.clients.metadata', {
        client_id: 'c1',
        client_name: 'n',
        description: 'd',
        logo_uri: 'l',
        client_uri: 'u',
        redirect_uris: [],
      }).requestedFields
    ).toEqual(['client_name', 'description', 'logo_uri', 'client_uri']);
    expect(build('admin.write.clients.metadata', { client_id: 'c1' })).not.toHaveProperty(
      'requestedFields'
    );
  });

  it('pins the suspend tool to the status field', () => {
    expect(
      build('admin.write.users.suspend', { user_id: 'u1', reason: 'x' }).requestedFields
    ).toEqual(['status']);
  });

  it('derives generic write fields excluding control fields and skips plan tools', () => {
    expect(
      build('admin.write.login-ui.update', {
        client_id: 'c',
        user_id: 'u',
        resource_version: 'v',
        theme: 't',
      }).requestedFields
    ).toEqual(['theme']);
    expect(build('admin.write.login-ui.update', { resource_version: 'v' })).not.toHaveProperty(
      'requestedFields'
    );
    expect(build('admin.write.configuration.plan.apply', { theme: 't' })).not.toHaveProperty(
      'requestedFields'
    );
  });
});
