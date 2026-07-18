import { describe, expect, it } from 'vitest';
import { createAgentToolCatalog } from '../tool-catalog';

describe('createAgentToolCatalog', () => {
  it('takes an immutable snapshot of authorization-relevant tool fields', () => {
    const permissions = ['admin:users:read'];
    const inputSchema = { type: 'object', properties: { id: { type: 'string' } } };
    const catalog = createAgentToolCatalog('1', [
      {
        id: 'users.get',
        name: 'get_user',
        title: 'Get user',
        description: 'Gets a user.',
        contractVersion: '1',
        requiredPermissions: permissions,
        riskLevel: 'low',
        requiredScope: 'agent:read',
        schemaDigest: 'sha256:test',
        inputSchema,
      },
    ]);

    permissions.length = 0;
    inputSchema.properties.id.type = 'number';
    expect(catalog.get('get_user')?.requiredPermissions).toEqual(['admin:users:read']);
    expect(catalog.get('get_user')?.inputSchema).toEqual({
      properties: { id: { type: 'string' } },
      type: 'object',
    });
    expect(Object.isFrozen(catalog.get('get_user')?.requiredPermissions)).toBe(true);
  });
});
