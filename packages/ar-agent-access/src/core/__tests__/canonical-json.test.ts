import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from '../canonical-json';
import { computeAgentElevationArgsHash } from '../elevation';

describe('canonicalizeJson', () => {
  it('sorts object keys recursively while preserving array order', () => {
    expect(canonicalizeJson({ z: 1, a: { y: 2, x: [3, 1] } })).toBe(
      '{"a":{"x":[3,1],"y":2},"z":1}'
    );
  });

  it.each(['\ud800', '\udc00'])('rejects lone surrogate %s', (value) => {
    expect(() => canonicalizeJson(value)).toThrow(/lone/u);
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalizeJson(Number.NaN)).toThrow(/finite/u);
  });
});

describe('computeAgentElevationArgsHash', () => {
  it('binds the complete authorization context and arguments', async () => {
    const context = {
      purpose: 'authrim-mcp-elevation-v1' as const,
      tenant_id: 'tenant-1',
      grant_id: 'grant-1',
      delegator_id: 'admin-1',
      actor_sub: 'client:client-1',
      client_id: 'client-1',
      tool_name: 'delete_user',
      tool_schema_version: '1',
      args: { user_id: 'user-1' },
    };
    const hash = await computeAgentElevationArgsHash(context);
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(
      computeAgentElevationArgsHash({ ...context, args: { user_id: 'user-2' } })
    ).resolves.not.toBe(hash);
  });
});
