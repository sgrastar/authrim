import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from '../../../core';
import { ADMIN_BULK_TOOL_DEFINITIONS } from '../admin-bulk-tools';

describe('Admin Bulk MCP Tool contracts', () => {
  it('pins every input schema digest', () => {
    const actual = Object.fromEntries(
      ADMIN_BULK_TOOL_DEFINITIONS.map((tool) => [
        tool.id,
        `sha256:${createHash('sha256').update(canonicalizeJson(tool.inputSchema)).digest('hex')}`,
      ])
    );
    expect(actual).toEqual(
      Object.fromEntries(ADMIN_BULK_TOOL_DEFINITIONS.map((tool) => [tool.id, tool.schemaDigest]))
    );
  });
});
