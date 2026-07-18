import { describe, expect, it } from 'vitest';
import { createAdminReadToolCatalog } from '../admin-read-tools';
import { McpSdkJsonSchemaValidator } from '../json-schema-validator';
import { createHash } from 'node:crypto';
import { canonicalizeJson } from '../../../core';

describe('Phase 1 Admin read tool catalog', () => {
  it('binds every catalog entry to the canonical input schema digest', () => {
    for (const tool of createAdminReadToolCatalog().list()) {
      const digest = createHash('sha256').update(canonicalizeJson(tool.inputSchema)).digest('hex');
      expect(tool.schemaDigest).toBe(`sha256:${digest}`);
    }
  });
  it('publishes only the six reviewed read tools with fixed security contracts', () => {
    const catalog = createAdminReadToolCatalog();
    expect(catalog.list().map((tool) => tool.name)).toEqual([
      'search_users',
      'get_user',
      'list_clients',
      'get_client',
      'search_audit_logs',
      'get_agent_settings',
    ]);
    for (const tool of catalog.list()) {
      expect(tool.riskLevel).toBe('low');
      expect(tool.requiredScope).toBe('agent:read');
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.taskSupport).toBe('forbidden');
    }
  });

  it('rejects page sizes above 50 and non-allowlisted input fields', () => {
    const validator = new McpSdkJsonSchemaValidator();
    const schema = createAdminReadToolCatalog().get('search_users')?.inputSchema;
    expect(schema).toBeDefined();
    expect(validator.validate(schema!, { page_size: 51 }).valid).toBe(false);
    expect(validator.validate(schema!, { arbitrary_sql: 'select *' }).valid).toBe(false);
  });
});
