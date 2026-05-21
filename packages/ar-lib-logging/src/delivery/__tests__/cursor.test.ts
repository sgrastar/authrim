import { describe, expect, it } from 'vitest';

import { decodeLoggingCursor, encodeLoggingCursor, type LoggingCursorPayload } from '../index';

const secret = 'test-cursor-secret';

function basePayload(overrides: Partial<LoggingCursorPayload> = {}): LoggingCursorPayload {
  return {
    sort: {
      occurred_at: '2026-05-19T00:00:00.000Z',
      id: 'lde_01HX0000000000000000000000',
    },
    direction: 'next',
    filterHash: 'sha256:filter',
    expiresAt: 1_800_000_000_000,
    ...overrides,
  };
}

describe('logging delivery cursor', () => {
  it('round-trips a signed cursor payload', async () => {
    const payload = basePayload();
    const cursor = await encodeLoggingCursor(payload, secret);

    const result = await decodeLoggingCursor(cursor, secret, 1_700_000_000_000);

    expect(result).toEqual({
      valid: true,
      payload,
    });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('rejects a cursor with a modified signature', async () => {
    const cursor = await encodeLoggingCursor(basePayload(), secret);
    const [payload] = cursor.split('.');
    const tampered = `${payload}.x`;

    const result = await decodeLoggingCursor(tampered, secret, 1_700_000_000_000);

    expect(result).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('rejects an expired cursor', async () => {
    const cursor = await encodeLoggingCursor(basePayload({ expiresAt: 1_700_000_000_000 }), secret);

    const result = await decodeLoggingCursor(cursor, secret, 1_700_000_000_000);

    expect(result).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it('uses stable JSON so equivalent sort/filter payloads produce the same cursor', async () => {
    const first = basePayload({
      sort: {
        occurred_at: '2026-05-19T00:00:00.000Z',
        id: 'lde_01HX0000000000000000000000',
      },
    });
    const second = basePayload({
      sort: {
        id: 'lde_01HX0000000000000000000000',
        occurred_at: '2026-05-19T00:00:00.000Z',
      },
    });

    await expect(encodeLoggingCursor(first, secret)).resolves.toBe(
      await encodeLoggingCursor(second, secret)
    );
  });

  it('rejects malformed cursor payloads', async () => {
    const cursor = await encodeLoggingCursor(
      {
        sort: [] as unknown as LoggingCursorPayload['sort'],
        direction: 'sideways' as LoggingCursorPayload['direction'],
        filterHash: '',
        expiresAt: 'later' as unknown as number,
      },
      secret
    );

    const result = await decodeLoggingCursor(cursor, secret, 1_700_000_000_000);

    expect(result).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });
});
