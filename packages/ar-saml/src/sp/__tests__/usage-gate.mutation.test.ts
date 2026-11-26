/** The refusal returned when the per-IdP usage switches cannot be read. */

import { describe, expect, it } from 'vitest';
import { samlUsageUnavailableResponse } from '../usage-gate';

describe('samlUsageUnavailableResponse', () => {
  it('answers 503 with a retry hint and no caching', async () => {
    let captured: { body: unknown; status: number; headers: Record<string, string> } | undefined;
    const context = {
      json: (body: unknown, status: number, headers: Record<string, string>) => {
        captured = { body, status, headers };
        return new Response(JSON.stringify(body), { status, headers });
      },
    };

    const response = samlUsageUnavailableResponse(context as never);

    expect(response.status).toBe(503);
    expect(captured?.headers).toEqual({
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'Retry-After': '5',
    });
    expect(await response.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'The service is temporarily unavailable. Please try again later.',
    });
    expect(response.headers.get('retry-after')).toBe('5');
  });
});
