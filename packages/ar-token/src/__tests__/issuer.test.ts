import { describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { getRequestIssuer } from '../issuer';

function createIssuerContext(tenantId: unknown): Context<{ Bindings: Env }> {
  return {
    get: () => tenantId,
    req: {
      raw: new Request('https://auth.example.com/token'),
    },
    env: {},
  } as unknown as Context<{ Bindings: Env }>;
}

describe('request issuer tenant boundary', () => {
  it.each([undefined, null, '', '   '])('rejects missing tenant context value %#', (tenantId) => {
    expect(() => getRequestIssuer(createIssuerContext(tenantId))).toThrow(
      'Request issuer requires tenant context'
    );
  });

  it('rejects a context without a tenant getter', () => {
    const context = {
      req: { raw: new Request('https://auth.example.com/token') },
      env: {},
    } as unknown as Context<{ Bindings: Env }>;

    expect(() => getRequestIssuer(context)).toThrow('Request issuer requires tenant context');
  });

  it('trims tenant context before issuer resolution', () => {
    expect(getRequestIssuer(createIssuerContext('  tenant-a  '))).toBe('https://auth.example.com');
  });
});
