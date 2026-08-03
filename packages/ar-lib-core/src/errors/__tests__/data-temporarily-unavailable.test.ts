import { describe, expect, it } from 'vitest';
import { D1OperationError } from '../../utils/d1-retry';
import {
  createDataTemporarilyUnavailableResponse,
  isDataTemporarilyUnavailableError,
} from '../data-temporarily-unavailable';

function context() {
  return {
    json: (body: unknown, status: number, headers: Record<string, string>) =>
      Response.json(body, { status, headers }),
  } as never;
}

describe('data temporarily unavailable response', () => {
  it('returns a retryable redacted 503 for exhausted transient D1 work', async () => {
    const error = new D1OperationError(
      'D1Adapter.query[users]',
      2,
      new Error('D1 DB is overloaded'),
      true
    );

    const response = createDataTemporarilyUnavailableResponse(context(), error);

    expect(response?.status).toBe(503);
    expect(response?.headers.get('Retry-After')).toBe('1');
    await expect(response?.json()).resolves.toMatchObject({
      error: 'temporarily_unavailable',
      extensions: { reason: 'data_store_overloaded', retryable: true },
    });
  });

  it('does not reinterpret permanent SQL or application errors', () => {
    expect(isDataTemporarilyUnavailableError(new Error('UNIQUE constraint failed'))).toBe(false);
    expect(isDataTemporarilyUnavailableError(new Error('account_data_route_not_found'))).toBe(
      false
    );
    expect(
      isDataTemporarilyUnavailableError(
        new D1OperationError('D1Adapter.execute[core]', 1, new Error('syntax error'), false)
      )
    ).toBe(false);
  });
});
