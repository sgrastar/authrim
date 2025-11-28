/**
 * Structured Logger with Tenant Context
 *
 * Provides JSON-structured logging with automatic tenant ID inclusion.
 * This ensures all logs can be filtered by tenant for future multi-tenant support.
 *
 * Output format:
 * {"timestamp":"2024-01-01T00:00:00.000Z","level":"info","tenantId":"default","message":"..."}
 */

import { DEFAULT_TENANT_ID } from './tenant-context';

/**
 * Log context that is included with every log entry.
 */
export interface LogContext {
  /** Tenant identifier (defaults to 'default' in single-tenant mode) */
  tenantId: string;
  /** Unique request identifier for correlation */
  requestId?: string;
  /** User identifier if authenticated */
  userId?: string;
  /** OAuth client identifier */
  clientId?: string;
  /** Action being performed */
  action?: string;
  /** Additional context fields */
  [key: string]: unknown;
}

/**
 * Logger interface for structured logging.
 */
export interface Logger {
  /** Log informational messages */
  info(message: string, context?: Partial<LogContext>): void;
  /** Log warning messages */
  warn(message: string, context?: Partial<LogContext>): void;
  /** Log error messages with optional error object */
  error(message: string, context?: Partial<LogContext>, error?: Error): void;
  /** Log debug messages (useful for development) */
  debug(message: string, context?: Partial<LogContext>): void;
}

/**
 * Log entry structure written to console.
 */
interface LogEntry {
  timestamp: string;
  level: string;
  tenantId: string;
  message: string;
  requestId?: string;
  userId?: string;
  clientId?: string;
  action?: string;
  error?: {
    message: string;
    stack?: string;
  };
  [key: string]: unknown;
}

/**
 * Create a logger instance with base context.
 *
 * @param baseContext - Default context to include in all log entries
 * @returns Logger instance
 *
 * @example
 * const logger = createLogger({ requestId: 'abc123', tenantId: 'default' });
 * logger.info('User logged in', { userId: 'user-1' });
 * // Output: {"timestamp":"...","level":"info","tenantId":"default","requestId":"abc123","message":"User logged in","userId":"user-1"}
 */
export function createLogger(baseContext: Partial<LogContext> = {}): Logger {
  const ctx: LogContext = {
    tenantId: DEFAULT_TENANT_ID,
    ...baseContext,
  };

  const log = (
    level: string,
    message: string,
    extra?: Partial<LogContext>,
    error?: Error
  ): void => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      tenantId: ctx.tenantId,
      message,
      ...(ctx.requestId && { requestId: ctx.requestId }),
      ...(ctx.userId && { userId: ctx.userId }),
      ...(ctx.clientId && { clientId: ctx.clientId }),
      ...(ctx.action && { action: ctx.action }),
      ...extra,
      ...(error && {
        error: {
          message: error.message,
          stack: error.stack,
        },
      }),
    };

    // Use appropriate console method based on level
    switch (level) {
      case 'error':
        console.error(JSON.stringify(entry));
        break;
      case 'warn':
        console.warn(JSON.stringify(entry));
        break;
      case 'debug':
        console.debug(JSON.stringify(entry));
        break;
      default:
        console.log(JSON.stringify(entry));
    }
  };

  return {
    info: (msg, extra) => log('info', msg, extra),
    warn: (msg, extra) => log('warn', msg, extra),
    error: (msg, extra, err) => log('error', msg, extra, err),
    debug: (msg, extra) => log('debug', msg, extra),
  };
}

/**
 * Create a child logger with additional context merged in.
 *
 * @param parent - Parent logger's context
 * @param additionalContext - Additional context to merge
 * @returns New logger with merged context
 *
 * @example
 * const requestLogger = createLogger({ requestId: 'abc' });
 * const userLogger = createChildLogger(requestLogger, { userId: 'user-1' });
 */
export function createChildLogger(
  parentContext: Partial<LogContext>,
  additionalContext: Partial<LogContext>
): Logger {
  return createLogger({
    ...parentContext,
    ...additionalContext,
  });
}

/**
 * Simple one-off structured log (for cases where you don't need a logger instance).
 *
 * @param level - Log level
 * @param message - Log message
 * @param context - Log context
 *
 * @example
 * structuredLog('info', 'Server started', { tenantId: 'default' });
 */
export function structuredLog(
  level: 'info' | 'warn' | 'error' | 'debug',
  message: string,
  context: Partial<LogContext> = {}
): void {
  const logger = createLogger(context);
  logger[level](message);
}
