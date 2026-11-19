import { describe, expect, it } from 'vitest';
import {
  decodeCloudflareAgentAccessRequestContext,
  encodeCloudflareAgentAccessRequestContext,
} from '../platform/cloudflare/mcp-request-context';
import { agentContext } from './helpers/mut-worker-agent-context';

const MAX = 16 * 1024;

function base64url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

function contextOfBytes(size: number) {
  const empty = JSON.stringify({ ...agentContext, correlationId: '' });
  const context = { ...agentContext, correlationId: 'x'.repeat(size - empty.length) };
  expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBe(size);
  return context;
}

describe('request context encoding', () => {
  it('produces unpadded base64url that round-trips characters encoded as + and /', () => {
    let found = false;
    for (let index = 0; index < 64 && !found; index += 1) {
      const context = { ...agentContext, correlationId: `?>~${'?'.repeat(index % 7)}${index}` };
      const standard = btoa(JSON.stringify(context));
      if (!/\+/u.test(standard) || !/\//u.test(standard) || !standard.endsWith('==')) continue;
      found = true;
      const encoded = encodeCloudflareAgentAccessRequestContext(context);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(encoded).toBe(standard.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, ''));
      expect(decodeCloudflareAgentAccessRequestContext(encoded)).toEqual(context);
    }
    expect(found).toBe(true);
  });

  it('encodes exactly 16 KiB and refuses one byte more', () => {
    const atLimit = contextOfBytes(MAX);
    expect(
      decodeCloudflareAgentAccessRequestContext(encodeCloudflareAgentAccessRequestContext(atLimit))
    ).toEqual(atLimit);
    expect(() => encodeCloudflareAgentAccessRequestContext(contextOfBytes(MAX + 1))).toThrow(
      new TypeError('Agent Access request context is too large')
    );
  });
});

describe('request context decoding', () => {
  it('refuses a payload just over 16 KiB even when its encoding fits the length guard', () => {
    const encoded = base64url(JSON.stringify(contextOfBytes(MAX + 2)));
    expect(encoded.length).toBeLessThanOrEqual(Math.ceil((MAX * 4) / 3) + 4);
    expect(decodeCloudflareAgentAccessRequestContext(encoded)).toBeNull();
  });

  it.each([
    ['null', 'null'],
    ['an array', JSON.stringify([agentContext])],
    ['an array actor', JSON.stringify({ ...agentContext, actor: [] })],
    ['a null grant', JSON.stringify({ ...agentContext, grant: null })],
    ['a missing resource', JSON.stringify({ ...agentContext, resource: undefined })],
    ['a numeric issuer origin', JSON.stringify({ ...agentContext, issuerOrigin: 1 })],
    ['a missing correlation id', JSON.stringify({ ...agentContext, correlationId: undefined })],
  ])('refuses %s', (_name, json) => {
    expect(decodeCloudflareAgentAccessRequestContext(base64url(json))).toBeNull();
  });

  it('refuses empty, oversized and non-base64 input', () => {
    expect(decodeCloudflareAgentAccessRequestContext(null)).toBeNull();
    expect(decodeCloudflareAgentAccessRequestContext('')).toBeNull();
    expect(decodeCloudflareAgentAccessRequestContext('A'.repeat(21_851))).toBeNull();
    expect(decodeCloudflareAgentAccessRequestContext('***')).toBeNull();
  });
});
