import { afterEach, describe, expect, it, vi } from 'vitest';
import { callDOWithRetry, DOOverloadedError, getOIDCErrorForDOError } from '../do-retry';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('callDOWithRetry', () => {
  it('returns the first result without scheduling a retry', async () => {
    const operation = vi.fn().mockResolvedValue({ id: 'session-1' });
    const timeout = vi.spyOn(globalThis, 'setTimeout');

    await expect(callDOWithRetry(operation, { operationName: 'session.read' })).resolves.toEqual({
      id: 'session-1',
    });
    expect(operation).toHaveBeenCalledOnce();
    expect(timeout).not.toHaveBeenCalled();
  });

  it.each(['DO overloaded', 'Too many requests', 'Rate limit exceeded'])(
    'retries an overloaded response: %s',
    async (message) => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      const operation = vi.fn().mockRejectedValueOnce(new Error(message)).mockResolvedValue('ok');

      const result = callDOWithRetry(operation, {
        operationName: 'session.read',
        initialDelayMs: 25,
      });
      await vi.advanceTimersByTimeAsync(24);
      expect(operation).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);

      await expect(result).resolves.toBe('ok');
      expect(operation).toHaveBeenCalledTimes(2);
    }
  );

  it.each([
    Object.assign(new Error('upstream unavailable'), { retryable: true }),
    new Error('network connection reset'),
    new Error('request timeout'),
    new Error('temporary failure'),
  ])('retries a transient failure and preserves the eventual result', async (failure) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const operation = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue('recovered');

    const result = callDOWithRetry(operation, {
      operationName: 'session.read',
      initialDelayMs: 10,
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('uses exponential backoff and caps the second delay', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('overloaded'))
      .mockRejectedValueOnce(new Error('overloaded'))
      .mockResolvedValue('recovered');

    const result = callDOWithRetry(operation, {
      operationName: 'session.read',
      maxRetries: 2,
      initialDelayMs: 100,
      maxDelayMs: 150,
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(operation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(149);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(timeout.mock.calls.map((call) => call[1])).toEqual([100, 150]);
  });

  it('does not replay a non-retryable operation or change its error', async () => {
    vi.useFakeTimers();
    const failure = new Error('invalid_grant');
    const operation = vi.fn().mockRejectedValue(failure);

    await expect(callDOWithRetry(operation, { operationName: 'session.read' })).rejects.toBe(
      failure
    );
    expect(operation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('wraps an exhausted overloaded failure with its cause and makes no extra attempt', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const failure = new Error('DO overloaded');
    const operation = vi.fn().mockRejectedValue(failure);

    const result = callDOWithRetry(operation, {
      operationName: 'session.read',
      maxRetries: 2,
      initialDelayMs: 10,
    });
    const rejection = expect(result).rejects.toMatchObject({
      name: 'DOOverloadedError',
      message: 'Service temporarily unavailable: session.read',
      retryable: false,
      cause: failure,
    });
    await vi.runAllTimersAsync();
    await rejection;
    expect(operation).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats zero retries as one attempt and normalizes a non-Error rejection', async () => {
    const operation = vi.fn().mockRejectedValue('invalid_request');

    await expect(
      callDOWithRetry(operation, { operationName: 'session.read', maxRetries: 0 })
    ).rejects.toThrow('invalid_request');
    expect(operation).toHaveBeenCalledOnce();
  });
});

describe('getOIDCErrorForDOError', () => {
  it('maps exhausted overloads to a stable 503 response without leaking the cause', () => {
    const cause = new Error('secret connection string');
    expect(getOIDCErrorForDOError(new DOOverloadedError('internal details', cause))).toEqual({
      error: 'temporarily_unavailable',
      errorDescription: 'The authorization server is currently unable to handle the request',
      httpStatus: 503,
    });
  });

  it('maps other failures to a generic 500 response', () => {
    const response = getOIDCErrorForDOError(new Error('private database host'));
    expect(response).toEqual({
      error: 'server_error',
      errorDescription: 'Internal server error',
      httpStatus: 500,
    });
    expect(JSON.stringify(response)).not.toContain('private database host');
  });
});
