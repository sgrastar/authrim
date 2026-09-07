import { describe, expect, it } from 'vitest';
import { computeAgentToolContractDigest } from '../../../core';
import { ADMIN_BULK_TOOL_DEFINITIONS } from '../admin-bulk-tools';

describe('Admin Bulk MCP Tool contracts', () => {
  it('pins every complete Tool contract digest', () => {
    for (const tool of ADMIN_BULK_TOOL_DEFINITIONS) {
      expect(tool.schemaDigest).toBe(computeAgentToolContractDigest(tool));
    }
  });
});
