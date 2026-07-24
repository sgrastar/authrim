import { describe, expect, it } from 'vitest';
import { createAdminReadToolCatalog } from '../admin-read-tools';
import { McpSdkJsonSchemaValidator } from '../json-schema-validator';
import { computeAgentToolContractDigest } from '../../../core';

describe('Phase 1 Admin read tool catalog', () => {
  it('binds every catalog entry to the canonical input schema digest', () => {
    for (const tool of createAdminReadToolCatalog().list()) {
      expect(tool.schemaDigest).toBe(computeAgentToolContractDigest(tool));
    }
  });
  it('publishes the reviewed read and Agent authority tools with fixed security contracts', () => {
    const catalog = createAdminReadToolCatalog();
    expect(catalog.list().map((tool) => tool.name)).toEqual([
      'search_users',
      'get_user',
      'list_clients',
      'get_client',
      'list_agent_grants',
      'explain_agent_access',
      'search_audit_logs',
      'get_agent_settings',
    ]);
    for (const tool of catalog.list()) {
      expect(tool.riskLevel).toBe(tool.id.startsWith('admin.read.users.') ? 'high' : 'low');
      expect(tool.requiredScope).toBe(
        tool.id.startsWith('admin.read.users.') ? 'agent:user-data:read' : 'agent:read'
      );
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.taskSupport).toBe('forbidden');
    }
    expect(catalog.get('search_users')?.requiredScope).toBe('agent:user-data:read');
    expect(catalog.get('get_user')?.requiredScope).toBe('agent:user-data:read');
    expect(catalog.get('search_users')?.riskLevel).toBe('high');
    expect(catalog.get('get_user')?.riskLevel).toBe('high');
  });

  it('rejects page sizes above 50 and non-allowlisted input fields', () => {
    const validator = new McpSdkJsonSchemaValidator();
    const schema = createAdminReadToolCatalog().get('search_users')?.inputSchema;
    expect(schema).toBeDefined();
    expect(validator.validate(schema!, { page_size: 51 }).valid).toBe(false);
    expect(validator.validate(schema!, { arbitrary_sql: 'select *' }).valid).toBe(false);
  });

  it('accepts an HTTPS CIMD metadata URL as a client ID without accepting arbitrary URLs', () => {
    const validator = new McpSdkJsonSchemaValidator();
    const schema = createAdminReadToolCatalog().get('get_client')?.inputSchema;
    expect(schema).toBeDefined();
    expect(
      validator.validate(schema!, {
        client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
      }).valid
    ).toBe(true);
    expect(validator.validate(schema!, { client_id: 'opaque_client-1' }).valid).toBe(true);
    expect(validator.validate(schema!, { client_id: 'http://metadata.example/client' }).valid).toBe(
      false
    );
    expect(
      validator.validate(schema!, { client_id: 'https://metadata.example/client#fragment' }).valid
    ).toBe(false);
  });
});
