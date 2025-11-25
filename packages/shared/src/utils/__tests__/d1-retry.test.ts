/**
 * Unit tests for D1 Retry Utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  retryD1Operation,
  retryD1Batch,
  type D1PreparedStatement,
  type D1Result,
} from '../d1-retry';

describe('D1 Retry Utilities', () => {
  // Mock console methods
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('retryD1Operation', () => {
    it('should succeed on first attempt without retry', async () => {
      const operation = vi.fn().mockResolvedValue('success');

      const promise = retryD1Operation(operation, 'test-operation');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it('should retry and succeed on second attempt', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new Error('Transient error'))
        .mockResolvedValueOnce('success');

      const promise = retryD1Operation(operation, 'test-operation');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'test-operation: Attempt 1/4 failed, retrying in 100ms...',
        expect.objectContaining({
          error: 'Transient error',
          attempt: 1,
          maxRetries: 4,
          nextDelay: 100,
        })
      );
    });

    it('should retry multiple times and succeed on third attempt', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockResolvedValueOnce('success');

      const promise = retryD1Operation(operation, 'test-operation');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(3);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
    });

    it('should return null after all retries exhausted', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('Persistent error'));

      const promise = retryD1Operation(operation, 'test-operation', { maxRetries: 2 });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBeNull();
      expect(operation).toHaveBeenCalledTimes(3); // Initial + 2 retries
      expect(consoleWarnSpy).toHaveBeenCalledTimes(2); // Warnings for retry attempts 1 and 2
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'test-operation: All 3 attempts failed',
        expect.objectContaining({
          error: 'Persistent error',
          operationName: 'test-operation',
        })
      );
    });

    it('should use exponential backoff for delays', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockRejectedValueOnce(new Error('Error 3'))
        .mockResolvedValueOnce('success');

      const promise = retryD1Operation(operation, 'test-operation', {
        initialDelayMs: 100,
        backoffMultiplier: 2,
      });
      await vi.runAllTimersAsync();
      await promise;

      // Verify exponential backoff delays: 100ms, 200ms, 400ms
      expect(consoleWarnSpy).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        expect.objectContaining({ nextDelay: 100 })
      );
      expect(consoleWarnSpy).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        expect.objectContaining({ nextDelay: 200 })
      );
      expect(consoleWarnSpy).toHaveBeenNthCalledWith(
        3,
        expect.any(String),
        expect.objectContaining({ nextDelay: 400 })
      );
    });

    it('should cap delay at maxDelayMs', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockRejectedValueOnce(new Error('Error 3'))
        .mockResolvedValueOnce('success');

      const promise = retryD1Operation(operation, 'test-operation', {
        initialDelayMs: 1000,
        backoffMultiplier: 3,
        maxDelayMs: 2000,
      });
      await vi.runAllTimersAsync();
      await promise;

      // Verify delays are capped: 1000ms, 2000ms (capped), 2000ms (capped)
      expect(consoleWarnSpy).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        expect.objectContaining({ nextDelay: 1000 })
      );
      expect(consoleWarnSpy).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        expect.objectContaining({ nextDelay: 2000 })
      );
      expect(consoleWarnSpy).toHaveBeenNthCalledWith(
        3,
        expect.any(String),
        expect.objectContaining({ nextDelay: 2000 })
      );
    });

    it('should handle non-Error objects as errors', async () => {
      const operation = vi
        .fn()
        .mockRejectedValueOnce('string error')
        .mockResolvedValueOnce('success');

      const promise = retryD1Operation(operation, 'test-operation');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBe('success');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          error: 'string error',
        })
      );
    });

    it('should use custom retry configuration', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('Error'));

      const promise = retryD1Operation(operation, 'test-operation', {
        maxRetries: 1,
        initialDelayMs: 50,
      });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBeNull();
      expect(operation).toHaveBeenCalledTimes(2); // Initial + 1 retry
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'test-operation: Attempt 1/2 failed, retrying in 50ms...',
        expect.objectContaining({
          nextDelay: 50,
        })
      );
    });

    it('should handle maxRetries = 0 (no retries)', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('Error'));

      const promise = retryD1Operation(operation, 'test-operation', { maxRetries: 0 });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBeNull();
      expect(operation).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).not.toHaveBeenCalled(); // No retry warnings
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('retryD1Batch', () => {
    it('should successfully execute batch operations', async () => {
      const mockResult1: D1Result = { success: true, meta: { changes: 1 } };
      const mockResult2: D1Result = { success: true, meta: { changes: 1 } };

      const stmt1: D1PreparedStatement = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue(mockResult1),
        all: vi.fn().mockResolvedValue(mockResult1),
        first: vi.fn().mockResolvedValue(null),
      };

      const stmt2: D1PreparedStatement = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue(mockResult2),
        all: vi.fn().mockResolvedValue(mockResult2),
        first: vi.fn().mockResolvedValue(null),
      };

      const promise = retryD1Batch([stmt1, stmt2], 'batch-operation');
      await vi.runAllTimersAsync();
      const results = await promise;

      expect(results).toEqual([mockResult1, mockResult2]);
      expect(stmt1.run).toHaveBeenCalledTimes(1);
      expect(stmt2.run).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('should retry batch operations on failure', async () => {
      const mockResult: D1Result = { success: true, meta: { changes: 2 } };

      const stmt1: D1PreparedStatement = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockRejectedValueOnce(new Error('D1 error')).mockResolvedValue(mockResult),
        all: vi.fn().mockResolvedValue(mockResult),
        first: vi.fn().mockResolvedValue(null),
      };

      const stmt2: D1PreparedStatement = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue(mockResult),
        all: vi.fn().mockResolvedValue(mockResult),
        first: vi.fn().mockResolvedValue(null),
      };

      const promise = retryD1Batch([stmt1, stmt2], 'batch-operation');
      await vi.runAllTimersAsync();
      const results = await promise;

      expect(results).toEqual([mockResult, mockResult]);
      expect(stmt1.run).toHaveBeenCalledTimes(2); // Failed once, succeeded on retry
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    });

    it('should return null after all batch retries exhausted', async () => {
      const stmt1: D1PreparedStatement = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockRejectedValue(new Error('Persistent D1 error')),
        all: vi.fn().mockRejectedValue(new Error('Persistent D1 error')),
        first: vi.fn().mockRejectedValue(new Error('Persistent D1 error')),
      };

      const promise = retryD1Batch([stmt1], 'batch-operation', { maxRetries: 1 });
      await vi.runAllTimersAsync();
      const results = await promise;

      expect(results).toBeNull();
      expect(stmt1.run).toHaveBeenCalledTimes(2); // Initial + 1 retry
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });

    it('should handle empty batch array', async () => {
      const promise = retryD1Batch([], 'empty-batch');
      await vi.runAllTimersAsync();
      const results = await promise;

      expect(results).toEqual([]);
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('should use custom retry configuration for batch operations', async () => {
      const stmt: D1PreparedStatement = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockRejectedValue(new Error('Error')),
        all: vi.fn().mockRejectedValue(new Error('Error')),
        first: vi.fn().mockRejectedValue(new Error('Error')),
      };

      const promise = retryD1Batch([stmt], 'batch-operation', {
        maxRetries: 2,
        initialDelayMs: 200,
      });
      await vi.runAllTimersAsync();
      await promise;

      expect(stmt.run).toHaveBeenCalledTimes(3); // Initial + 2 retries
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'batch-operation: Attempt 1/3 failed, retrying in 200ms...',
        expect.objectContaining({
          nextDelay: 200,
        })
      );
    });
  });
});
