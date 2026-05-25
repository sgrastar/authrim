/**
 * Structured Logger with Tenant Context
 *
 * Provides JSON-structured logging with automatic tenant ID inclusion.
 * This ensures all logs can be filtered by tenant for future multi-tenant support.
 *
 * Output format:
 * {"timestamp":"2024-01-01T00:00:00.000Z","level":"info","tenantId":"default","message":"..."}
 */

const DEFAULT_LOG_TENANT_ID = 'default';

/**
 * Log levels in order of severity (lowest to highest).
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log output format.
 */
export type LogFormat = 'json' | 'pretty';

/**
 * Logger configuration for level filtering and output format.
 */
export interface LoggerConfig {
  /** Minimum log level to output (default: 'info') */
  level: LogLevel;
  /** Output format: 'json' for structured logs, 'pretty' for human-readable (default: 'json') */
  format: LogFormat;
  /** If true, hash userId in logs for privacy (default: true) */
  hashUserId: boolean;
  /** Optional deployment-specific salt for log identifier hashes */
  hashSalt?: string;
  /** If true, include error stack traces in logs (default: false) */
  includeErrorStack?: boolean;
  /** Per-tenant level overrides (optional) */
  tenantOverrides?: Record<string, { level?: LogLevel }>;
}

/**
 * Default logger configuration.
 */
export const DEFAULT_LOGGER_CONFIG: LoggerConfig = {
  level: 'info',
  format: 'json',
  hashUserId: true,
  includeErrorStack: false,
};

/**
 * Log level numeric values for filtering.
 */
const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Global logger configuration (can be overridden at runtime).
 */
let globalLoggerConfig: LoggerConfig = { ...DEFAULT_LOGGER_CONFIG };

/**
 * Set global logger configuration.
 * @param config - Partial configuration to merge with defaults
 */
export function setLoggerConfig(config: Partial<LoggerConfig>): void {
  globalLoggerConfig = { ...DEFAULT_LOGGER_CONFIG, ...config };
}

/**
 * Get current global logger configuration.
 */
export function getLoggerConfig(): LoggerConfig {
  return { ...globalLoggerConfig };
}

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
  /** Hashed user identifier for privacy (used when hashUserId is enabled) */
  userIdHash?: string;
  /** OAuth client identifier */
  clientId?: string;
  /** Session identifier for correlation */
  sessionId?: string;
  /** Hashed session identifier for privacy */
  sessionIdHash?: string;
  /** Module/component name for log categorization */
  module?: string;
  /** Action being performed */
  action?: string;
  /** Operation duration in milliseconds */
  durationMs?: number;
  /** Additional context fields */
  [key: string]: unknown;
}

/**
 * Logger interface for structured logging.
 */
export interface Logger {
  /** Log informational messages */
  info(message: string, context?: Partial<LogContext>): void;
  /** Log warning messages with optional error object */
  warn(message: string, context?: Partial<LogContext>, error?: Error): void;
  /** Log error messages with optional error object */
  error(message: string, context?: Partial<LogContext>, error?: Error): void;
  /** Log debug messages (useful for development) */
  debug(message: string, context?: Partial<LogContext>): void;
  /** Create a child logger with additional context merged in */
  child(additionalContext: Partial<LogContext>): Logger;
  /** Create a child logger with module name set */
  module(moduleName: string): Logger;
  /** Start a timer and return a function to log the duration */
  startTimer(label: string): () => void;
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
  userIdHash?: string;
  clientId?: string;
  sessionId?: string;
  sessionIdHash?: string;
  module?: string;
  action?: string;
  durationMs?: number;
  error?: {
    message: string;
    stack?: string;
  };
  [key: string]: unknown;
}

/**
 * Check if a log level should be output based on current configuration.
 */
function shouldLog(level: LogLevel, tenantId: string): boolean {
  const config = globalLoggerConfig;
  const tenantOverride = config.tenantOverrides?.[tenantId];
  const effectiveLevel = tenantOverride?.level ?? config.level;
  return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[effectiveLevel];
}

/**
 * Format a log entry for output.
 */
function formatLogEntry(entry: LogEntry, format: LogFormat): string {
  if (format === 'pretty') {
    const levelColor: Record<string, string> = {
      debug: '\x1b[90m', // gray
      info: '\x1b[36m', // cyan
      warn: '\x1b[33m', // yellow
      error: '\x1b[31m', // red
    };
    const reset = '\x1b[0m';
    const color = levelColor[entry.level] ?? '';
    const timestamp = entry.timestamp.substring(11, 23); // HH:mm:ss.SSS
    const module = entry.module ? `[${entry.module}] ` : '';
    const duration = entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : '';
    return `${color}${timestamp} ${entry.level.toUpperCase().padEnd(5)}${reset} ${module}${entry.message}${duration}`;
  }
  return JSON.stringify(entry);
}

const SENSITIVE_LOG_KEY_PARTS = [
  'password',
  'passcode',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'privatekey',
  'clientsecret',
  'codeverifier',
  'assertion',
  'credential',
];

const PROTECTED_LOG_EXTRA_KEYS = new Set(['timestamp', 'level', 'message', 'tenantId', 'error']);
const MAX_LOG_SANITIZE_DEPTH = 8;

const RESERVED_LOG_CONTEXT_KEYS = new Set([
  ...PROTECTED_LOG_EXTRA_KEYS,
  'requestId',
  'userId',
  'userIdHash',
  'clientId',
  'sessionId',
  'sessionIdHash',
  'module',
  'action',
  'durationMs',
]);

function rightRotate(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function sha256HexSync(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Array<number>(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rightRotate(w[i - 15], 7) ^ rightRotate(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rightRotate(w[i - 2], 17) ^ rightRotate(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + k[i] + w[i]) >>> 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((part) => part.toString(16).padStart(8, '0'))
    .join('');
}

function hashIdentifierForLog(prefix: string, value: string, salt?: string): string {
  return `${prefix}_${sha256HexSync(`${salt ?? ''}\0${value}`).slice(0, 16)}`;
}

function hashUserIdForLog(userId: string, salt?: string): string {
  return hashIdentifierForLog('uid', userId, salt);
}

function hashSessionIdForLog(sessionId: string, salt?: string): string {
  return hashIdentifierForLog('sid', sessionId, salt);
}

function isSensitiveLogKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_LOG_KEY_PARTS.some((part) => normalized.includes(part));
}

function redactLogString(value: string): string {
  return value
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL_REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[JWT_REDACTED]');
}

function sanitizeLogValue(
  value: unknown,
  key?: string,
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0
): unknown {
  if (key && isSensitiveLogKey(key)) {
    return '[redacted]';
  }
  if (typeof value === 'string') {
    return redactLogString(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[circular]';
    }
    if (depth >= MAX_LOG_SANITIZE_DEPTH) {
      return '[truncated]';
    }
    seen.add(value);
    return value.map((item) => sanitizeLogValue(item, undefined, seen, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return '[circular]';
    }
    if (depth >= MAX_LOG_SANITIZE_DEPTH) {
      return '[truncated]';
    }
    return sanitizeLogFields(
      value as Record<string, unknown>,
      RESERVED_LOG_CONTEXT_KEYS,
      seen,
      depth + 1
    );
  }
  return value;
}

function sanitizeLogFields(
  fields: Record<string, unknown>,
  omittedKeys: ReadonlySet<string> = PROTECTED_LOG_EXTRA_KEYS,
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  if (seen.has(fields)) {
    return { value: '[circular]' };
  }
  seen.add(fields);
  for (const [key, value] of Object.entries(fields)) {
    if (omittedKeys.has(key)) {
      continue;
    }
    sanitized[key] = sanitizeLogValue(value, key, seen, depth);
  }
  return sanitized;
}

/**
 * Create a logger instance with base context.
 *
 * @param baseContext - Default context to include in all log entries
 * @param config - Optional logger configuration override
 * @returns Logger instance
 *
 * @example
 * const logger = createLogger({ requestId: 'abc123', tenantId: 'default' });
 * logger.info('User logged in', { userId: 'user-1' });
 * // Output: {"timestamp":"...","level":"info","tenantId":"default","requestId":"abc123","message":"User logged in","userId":"user-1"}
 */
export function createLogger(
  baseContext: Partial<LogContext> = {},
  config?: Partial<LoggerConfig>
): Logger {
  const ctx: LogContext = {
    tenantId: DEFAULT_LOG_TENANT_ID,
    ...baseContext,
  };

  const effectiveConfig = config ? { ...globalLoggerConfig, ...config } : globalLoggerConfig;

  const log = (
    level: LogLevel,
    message: string,
    extra?: Partial<LogContext>,
    error?: Error
  ): void => {
    // Check if this log level should be output
    if (!shouldLog(level, ctx.tenantId)) {
      return;
    }

    const mergedContext = { ...ctx, ...extra };
    const hashSalt = effectiveConfig.hashSalt;

    // Apply userId hashing if configured
    let effectiveUserId =
      typeof mergedContext.userId === 'string' ? mergedContext.userId : undefined;
    let userIdHash =
      typeof mergedContext.userIdHash === 'string' ? mergedContext.userIdHash : undefined;
    if (effectiveConfig.hashUserId && effectiveUserId && !userIdHash) {
      userIdHash = hashUserIdForLog(effectiveUserId, hashSalt);
      effectiveUserId = undefined; // Don't log raw userId
    }

    const sessionIdHash =
      typeof mergedContext.sessionIdHash === 'string'
        ? mergedContext.sessionIdHash
        : typeof mergedContext.sessionId === 'string'
          ? hashSessionIdForLog(mergedContext.sessionId, hashSalt)
          : undefined;

    const sanitizedExtra = extra
      ? sanitizeLogFields(extra as Record<string, unknown>, RESERVED_LOG_CONTEXT_KEYS)
      : {};

    const errorPayload = error
      ? {
          message: error.message,
          ...(effectiveConfig.includeErrorStack === true ? { stack: error.stack } : {}),
        }
      : undefined;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      tenantId: ctx.tenantId,
      message,
      ...(typeof mergedContext.requestId === 'string' && { requestId: mergedContext.requestId }),
      ...(effectiveUserId && { userId: effectiveUserId }),
      ...(userIdHash && { userIdHash }),
      ...(typeof mergedContext.clientId === 'string' && { clientId: mergedContext.clientId }),
      ...(sessionIdHash && { sessionIdHash }),
      ...(typeof mergedContext.module === 'string' && { module: mergedContext.module }),
      ...(typeof mergedContext.action === 'string' && { action: mergedContext.action }),
      ...(typeof mergedContext.durationMs === 'number' && { durationMs: mergedContext.durationMs }),
      ...sanitizedExtra,
      ...(errorPayload && { error: errorPayload }),
    };

    const output = formatLogEntry(entry, effectiveConfig.format);

    // Use appropriate console method based on level
    switch (level) {
      case 'error':
        console.error(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      case 'debug':
        console.debug(output);
        break;
      default:
        console.log(output);
    }
  };

  const logger: Logger = {
    info: (msg, extra) => log('info', msg, extra),
    warn: (msg, extra, err) => log('warn', msg, extra, err),
    error: (msg, extra, err) => log('error', msg, extra, err),
    debug: (msg, extra) => log('debug', msg, extra),

    child: (additionalContext: Partial<LogContext>): Logger => {
      return createLogger({ ...ctx, ...additionalContext }, config);
    },

    module: (moduleName: string): Logger => {
      return createLogger({ ...ctx, module: moduleName }, config);
    },

    startTimer: (label: string): (() => void) => {
      const startTime = Date.now();
      return () => {
        const durationMs = Date.now() - startTime;
        log('info', `${label} completed`, { durationMs });
      };
    },
  };

  return logger;
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

/**
 * Initialize logger configuration from environment variables.
 * Should be called once at application startup.
 *
 * Environment variables:
 * - LOG_LEVEL: "debug" | "info" | "warn" | "error" (default: "info")
 * - LOG_FORMAT: "json" | "pretty" (default: "json")
 * - ENABLE_LOG_HASH_USER_ID: "false" to allow raw user IDs (default: hashed)
 * - LOG_HASH_SALT: optional deployment-specific salt for identifier hashes
 *
 * @param env - Environment object with optional LOG_* variables
 *
 * @example
 * // In worker entry point:
 * initLoggerFromEnv(env);
 */
export function initLoggerFromEnv(env: {
  LOG_LEVEL?: string;
  LOG_FORMAT?: string;
  ENABLE_LOG_HASH_USER_ID?: string;
  LOG_HASH_SALT?: string;
}): void {
  const validLevels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  const validFormats: LogFormat[] = ['json', 'pretty'];

  const level = validLevels.includes(env.LOG_LEVEL as LogLevel)
    ? (env.LOG_LEVEL as LogLevel)
    : DEFAULT_LOGGER_CONFIG.level;

  const format = validFormats.includes(env.LOG_FORMAT as LogFormat)
    ? (env.LOG_FORMAT as LogFormat)
    : DEFAULT_LOGGER_CONFIG.format;

  const hashUserId = env.ENABLE_LOG_HASH_USER_ID !== 'false';

  setLoggerConfig({ level, format, hashUserId, hashSalt: env.LOG_HASH_SALT });
}

// Note: getLogger is exported from './middleware/request-context' to avoid
// dependency on Hono types in this base utility module.
