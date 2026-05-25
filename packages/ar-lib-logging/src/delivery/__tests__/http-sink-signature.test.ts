import { describe, expect, it } from 'vitest';

import {
  createHttpSinkCanonicalString,
  getHttpSinkSignatureProfile,
  sha256Hex,
  signHttpSinkPayload,
} from '../index';

describe('HTTP sink signature helpers', () => {
  it('builds the default Authrim signature headers', async () => {
    const result = await signHttpSinkPayload({
      method: 'post',
      path: '/collector/logs',
      body: '{"event":"test"}',
      secret: 'sink-secret',
      deliveryId: 'lde_123',
      now: new Date('2026-05-19T00:00:00.000Z'),
    });

    expect(result.headers).toEqual({
      'X-Authrim-Timestamp': '1779148800',
      'X-Authrim-Signature-256': expect.stringMatching(/^sha256=[0-9a-f]{64}$/),
      'X-Authrim-Signature-Version': 'v1',
      'X-Authrim-Delivery': 'lde_123',
    });
    expect(result.canonicalString).toBe(
      ['1779148800', 'POST', '/collector/logs', await sha256Hex('{"event":"test"}')].join('\n')
    );
  });

  it('supports the legacy webhook header profile', async () => {
    const result = await signHttpSinkPayload({
      method: 'POST',
      path: '/webhook',
      body: '{}',
      secret: 'sink-secret',
      deliveryId: 'delivery-1',
      now: new Date('2026-05-19T00:00:00.000Z'),
      profile: getHttpSinkSignatureProfile('webhook_legacy'),
    });

    expect(result.headers).toEqual({
      'X-Webhook-Timestamp': '1779148800',
      'X-Webhook-Signature': expect.stringMatching(/^sha256=[0-9a-f]{64}$/),
      'X-Webhook-Delivery': 'delivery-1',
    });
  });

  it('allows custom header names and ISO8601 timestamps', async () => {
    const result = await signHttpSinkPayload({
      method: 'PUT',
      path: '/custom',
      body: new TextEncoder().encode('payload'),
      secret: 'sink-secret',
      now: new Date('2026-05-19T00:00:00.000Z'),
      profile: {
        name: 'custom',
        signatureHeader: 'X-Custom-Signature',
        timestampHeader: 'X-Custom-Time',
        timestampFormat: 'iso8601',
        signatureValueFormat: 'hex',
      },
    });

    expect(result.headers).toEqual({
      'X-Custom-Time': '2026-05-19T00:00:00.000Z',
      'X-Custom-Signature': expect.stringMatching(/^[0-9a-f]{64}$/),
      'X-Authrim-Signature-Version': 'v1',
    });
  });

  it('uses the documented canonical string order', () => {
    expect(
      createHttpSinkCanonicalString({
        timestamp: '1779148800',
        method: 'post',
        path: '/sink',
        bodySha256Hex: 'abc123',
      })
    ).toBe(['1779148800', 'POST', '/sink', 'abc123'].join('\n'));
  });
});
