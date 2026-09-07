import { describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { getRequestIssuer } from '../issuer';

function context(get?: (key: string) => unknown): Context<{ Bindings: Env }> {
  return {
    ...(get ? { get } : {}),
    req: { raw: new Request('https://request.example.com/authorize') },
    env: { ISSUER_URL: 'https://issuer.example.com' },
  } as unknown as Context<{ Bindings: Env }>;
}

describe('request issuer tenant boundary', () => {
  it.each([
    ['missing context getter', context()],
    ['missing tenant value', context(() => undefined)],
    ['blank tenant value', context(() => '   ')],
  ])('fails closed for %s', (_name, c) => {
    expect(() => getRequestIssuer(c)).toThrow('Request issuer requires tenant context');
  });

  it('trims the trusted tenant context before building the issuer', () => {
    expect(getRequestIssuer(context(() => ' default '))).toBe('https://issuer.example.com');
  });
});
