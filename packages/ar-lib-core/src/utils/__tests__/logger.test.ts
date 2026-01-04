import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createLogger,
  setLoggerConfig,
  getLoggerConfig,
  initLoggerFromEnv,
  DEFAULT_LOGGER_CONFIG,
  structuredLog,
  createChildLogger,
  type LoggerConfig,
} from '../logger';

/**
 * Logger Utility Tests
 *
 * Tests for structured logging including:
 * - Log level filtering
 * - Log output formatting (JSON/Pretty)
 * - User ID hashing for privacy
 * - Tenant-level overrides
 * - Child loggers and module tagging
 * - Timer functionality
 */

describe('Logger', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Reset config before each test
    setLoggerConfig({ ...DEFAULT_LOGGER_CONFIG });

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createLogger', () => {
    it('should create a logger with default context', () => {
      const logger = createLogger();
      logger.info('Test message');

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.level).toBe('info');
      expect(output.message).toBe('Test message');
      expect(output.tenantId).toBe('default');
    });

    it('should include base context in all log entries', () => {
      const logger = createLogger({
        tenantId: 'tenant-1',
        requestId: 'req-123',
      });
      logger.info('Test message');

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.tenantId).toBe('tenant-1');
      expect(output.requestId).toBe('req-123');
    });

    it('should merge extra context with base context', () => {
      const logger = createLogger({ tenantId: 'tenant-1' });
      logger.info('Test message', { userId: 'user-123', action: 'login' });

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.tenantId).toBe('tenant-1');
      expect(output.userId).toBe('user-123');
      expect(output.action).toBe('login');
    });
  });

  describe('Log levels', () => {
    it('should call console.log for info level', () => {
      const logger = createLogger();
      logger.info('Info message');

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    });

    it('should call console.warn for warn level', () => {
      const logger = createLogger();
      logger.warn('Warning message');

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    });

    it('should call console.error for error level', () => {
      const logger = createLogger();
      logger.error('Error message');

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });

    it('should call console.debug for debug level', () => {
      setLoggerConfig({ level: 'debug', format: 'json', hashUserId: false });
      const logger = createLogger();
      logger.debug('Debug message');

      expect(consoleDebugSpy).toHaveBeenCalledTimes(1);
    });

    it('should include error object in error logs', () => {
      const logger = createLogger();
      const error = new Error('Something went wrong');
      logger.error('Operation failed', {}, error);

      const output = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(output.error).toBeDefined();
      expect(output.error.message).toBe('Something went wrong');
      expect(output.error.stack).toBeDefined();
    });
  });

  describe('Log level filtering', () => {
    it('should filter debug logs when level is info', () => {
      setLoggerConfig({ level: 'info', format: 'json', hashUserId: false });
      const logger = createLogger();
      logger.debug('Debug message');

      expect(consoleDebugSpy).not.toHaveBeenCalled();
    });

    it('should allow debug logs when level is debug', () => {
      setLoggerConfig({ level: 'debug', format: 'json', hashUserId: false });
      const logger = createLogger();
      logger.debug('Debug message');

      expect(consoleDebugSpy).toHaveBeenCalledTimes(1);
    });

    it('should filter info and debug when level is warn', () => {
      setLoggerConfig({ level: 'warn', format: 'json', hashUserId: false });
      const logger = createLogger();
      logger.debug('Debug message');
      logger.info('Info message');
      logger.warn('Warn message');

      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    });

    it('should only log errors when level is error', () => {
      setLoggerConfig({ level: 'error', format: 'json', hashUserId: false });
      const logger = createLogger();
      logger.debug('Debug message');
      logger.info('Info message');
      logger.warn('Warn message');
      logger.error('Error message');

      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Tenant-level overrides', () => {
    it('should apply tenant-specific log level override', () => {
      setLoggerConfig({
        level: 'info',
        format: 'json',
        hashUserId: false,
        tenantOverrides: {
          'debug-tenant': { level: 'debug' },
        },
      });

      // Default tenant should filter debug
      const defaultLogger = createLogger({ tenantId: 'default' });
      defaultLogger.debug('Should be filtered');
      expect(consoleDebugSpy).not.toHaveBeenCalled();

      // Debug-tenant should allow debug
      const debugLogger = createLogger({ tenantId: 'debug-tenant' });
      debugLogger.debug('Should be logged');
      expect(consoleDebugSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('User ID hashing', () => {
    it('should hash userId when hashUserId is enabled', () => {
      setLoggerConfig({ level: 'info', format: 'json', hashUserId: true });
      const logger = createLogger({ userId: 'user-123' });
      logger.info('Test message');

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.userId).toBeUndefined();
      expect(output.userIdHash).toBeDefined();
      expect(output.userIdHash).toMatch(/^uid_[0-9a-f]{8}$/);
    });

    it('should not hash userId when hashUserId is disabled', () => {
      setLoggerConfig({ level: 'info', format: 'json', hashUserId: false });
      const logger = createLogger({ userId: 'user-123' });
      logger.info('Test message');

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.userId).toBe('user-123');
      expect(output.userIdHash).toBeUndefined();
    });

    it('should generate consistent hash for same userId', () => {
      setLoggerConfig({ level: 'info', format: 'json', hashUserId: true });
      const logger1 = createLogger({ userId: 'user-123' });
      const logger2 = createLogger({ userId: 'user-123' });

      logger1.info('First log');
      logger2.info('Second log');

      const output1 = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      const output2 = JSON.parse(consoleLogSpy.mock.calls[1][0]);
      expect(output1.userIdHash).toBe(output2.userIdHash);
    });

    it('should generate different hashes for different userIds', () => {
      setLoggerConfig({ level: 'info', format: 'json', hashUserId: true });
      const logger1 = createLogger({ userId: 'user-123' });
      const logger2 = createLogger({ userId: 'user-456' });

      logger1.info('First log');
      logger2.info('Second log');

      const output1 = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      const output2 = JSON.parse(consoleLogSpy.mock.calls[1][0]);
      expect(output1.userIdHash).not.toBe(output2.userIdHash);
    });
  });

  describe('Pretty format', () => {
    it('should output human-readable format when format is pretty', () => {
      setLoggerConfig({ level: 'info', format: 'pretty', hashUserId: false });
      const logger = createLogger({ module: 'TEST' });
      logger.info('Test message');

      const output = consoleLogSpy.mock.calls[0][0];
      // Pretty format includes ANSI colors and module tag
      expect(output).toContain('[TEST]');
      expect(output).toContain('Test message');
      expect(output).toContain('INFO');
    });

    it('should include duration in pretty format', () => {
      setLoggerConfig({ level: 'info', format: 'pretty', hashUserId: false });
      const logger = createLogger();
      logger.info('Operation completed', { durationMs: 150 });

      const output = consoleLogSpy.mock.calls[0][0];
      expect(output).toContain('(150ms)');
    });
  });

  describe('Child loggers', () => {
    it('should create child logger with merged context', () => {
      const parentLogger = createLogger({ tenantId: 'tenant-1', requestId: 'req-123' });
      const childLogger = parentLogger.child({ userId: 'user-456' });

      childLogger.info('Child log');

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.tenantId).toBe('tenant-1');
      expect(output.requestId).toBe('req-123');
      expect(output.userId).toBe('user-456');
    });

    it('should not affect parent logger when child is created', () => {
      const parentLogger = createLogger({ tenantId: 'tenant-1' });
      parentLogger.child({ userId: 'user-456' });

      parentLogger.info('Parent log');

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.userId).toBeUndefined();
    });
  });

  describe('Module tagging', () => {
    it('should create logger with module name', () => {
      const logger = createLogger().module('AUTH');
      logger.info('Authentication started');

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.module).toBe('AUTH');
    });

    it('should allow chaining module with child', () => {
      const logger = createLogger({ tenantId: 'tenant-1' })
        .module('TOKEN')
        .child({ userId: 'user-1' });
      logger.info('Token issued');

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.tenantId).toBe('tenant-1');
      expect(output.module).toBe('TOKEN');
      expect(output.userId).toBe('user-1');
    });
  });

  describe('Timer functionality', () => {
    it('should measure and log duration', () => {
      vi.useFakeTimers();
      const logger = createLogger();
      const endTimer = logger.startTimer('Database query');

      vi.advanceTimersByTime(100);
      endTimer();

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.message).toBe('Database query completed');
      expect(output.durationMs).toBe(100);

      vi.useRealTimers();
    });
  });

  describe('setLoggerConfig', () => {
    it('should update global logger configuration', () => {
      setLoggerConfig({ level: 'debug', format: 'pretty', hashUserId: true });
      const config = getLoggerConfig();

      expect(config.level).toBe('debug');
      expect(config.format).toBe('pretty');
      expect(config.hashUserId).toBe(true);
    });

    it('should merge with default config', () => {
      setLoggerConfig({ level: 'warn' });
      const config = getLoggerConfig();

      expect(config.level).toBe('warn');
      expect(config.format).toBe('json'); // default
      expect(config.hashUserId).toBe(false); // default
    });
  });

  describe('initLoggerFromEnv', () => {
    it('should initialize from environment variables', () => {
      initLoggerFromEnv({
        LOG_LEVEL: 'debug',
        LOG_FORMAT: 'pretty',
        LOG_HASH_USER_ID: 'true',
      });

      const config = getLoggerConfig();
      expect(config.level).toBe('debug');
      expect(config.format).toBe('pretty');
      expect(config.hashUserId).toBe(true);
    });

    it('should use defaults for invalid values', () => {
      initLoggerFromEnv({
        LOG_LEVEL: 'invalid',
        LOG_FORMAT: 'invalid',
        LOG_HASH_USER_ID: 'invalid',
      });

      const config = getLoggerConfig();
      expect(config.level).toBe('info'); // default
      expect(config.format).toBe('json'); // default
      expect(config.hashUserId).toBe(false); // default (not 'true')
    });

    it('should use defaults when env vars are not provided', () => {
      initLoggerFromEnv({});

      const config = getLoggerConfig();
      expect(config.level).toBe('info');
      expect(config.format).toBe('json');
      expect(config.hashUserId).toBe(false);
    });
  });

  describe('structuredLog', () => {
    it('should log one-off messages', () => {
      structuredLog('info', 'Server started', { tenantId: 'default' });

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.message).toBe('Server started');
    });
  });

  describe('createChildLogger', () => {
    it('should create child logger with merged context', () => {
      const parentContext = { tenantId: 'tenant-1', requestId: 'req-123' };
      const childLogger = createChildLogger(parentContext, { userId: 'user-456' });

      childLogger.info('Child log');

      const output = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(output.tenantId).toBe('tenant-1');
      expect(output.requestId).toBe('req-123');
      expect(output.userId).toBe('user-456');
    });
  });
});
