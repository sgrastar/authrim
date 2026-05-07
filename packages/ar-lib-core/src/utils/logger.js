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
 * Default logger configuration.
 */
export const DEFAULT_LOGGER_CONFIG = {
    level: 'info',
    format: 'json',
    hashUserId: false,
    includeErrorStack: false,
};
/**
 * Log level numeric values for filtering.
 */
const LOG_LEVEL_VALUES = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
/**
 * Global logger configuration (can be overridden at runtime).
 */
let globalLoggerConfig = { ...DEFAULT_LOGGER_CONFIG };
/**
 * Set global logger configuration.
 * @param config - Partial configuration to merge with defaults
 */
export function setLoggerConfig(config) {
    globalLoggerConfig = { ...DEFAULT_LOGGER_CONFIG, ...config };
}
/**
 * Get current global logger configuration.
 */
export function getLoggerConfig() {
    return { ...globalLoggerConfig };
}
/**
 * Check if a log level should be output based on current configuration.
 */
function shouldLog(level, tenantId) {
    const config = globalLoggerConfig;
    const tenantOverride = config.tenantOverrides?.[tenantId];
    const effectiveLevel = tenantOverride?.level ?? config.level;
    return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[effectiveLevel];
}
/**
 * Format a log entry for output.
 */
function formatLogEntry(entry, format) {
    if (format === 'pretty') {
        const levelColor = {
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
/**
 * Hash a user ID for privacy-preserving logging.
 * Uses a simple hash (not cryptographically secure, just for log correlation).
 */
function hashUserIdForLog(userId) {
    // Simple hash using djb2 algorithm
    let hash = 5381;
    for (let i = 0; i < userId.length; i++) {
        hash = (hash * 33) ^ userId.charCodeAt(i);
    }
    return 'uid_' + (hash >>> 0).toString(16).padStart(8, '0');
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
export function createLogger(baseContext = {}, config) {
    const ctx = {
        tenantId: DEFAULT_LOG_TENANT_ID,
        ...baseContext,
    };
    const effectiveConfig = config ? { ...globalLoggerConfig, ...config } : globalLoggerConfig;
    const log = (level, message, extra, error) => {
        // Check if this log level should be output
        if (!shouldLog(level, ctx.tenantId)) {
            return;
        }
        // Apply userId hashing if configured
        let effectiveUserId = ctx.userId;
        let userIdHash = ctx.userIdHash;
        if (effectiveConfig.hashUserId && effectiveUserId && !userIdHash) {
            userIdHash = hashUserIdForLog(effectiveUserId);
            effectiveUserId = undefined; // Don't log raw userId
        }
        const errorPayload = error
            ? {
                message: error.message,
                ...(effectiveConfig.includeErrorStack === true ? { stack: error.stack } : {}),
            }
            : undefined;
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            tenantId: ctx.tenantId,
            message,
            ...(ctx.requestId && { requestId: ctx.requestId }),
            ...(effectiveUserId && { userId: effectiveUserId }),
            ...(userIdHash && { userIdHash }),
            ...(ctx.clientId && { clientId: ctx.clientId }),
            ...(ctx.sessionId && { sessionId: ctx.sessionId }),
            ...(ctx.module && { module: ctx.module }),
            ...(ctx.action && { action: ctx.action }),
            ...(ctx.durationMs !== undefined && { durationMs: ctx.durationMs }),
            ...extra,
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
    const logger = {
        info: (msg, extra) => log('info', msg, extra),
        warn: (msg, extra, err) => log('warn', msg, extra, err),
        error: (msg, extra, err) => log('error', msg, extra, err),
        debug: (msg, extra) => log('debug', msg, extra),
        child: (additionalContext) => {
            return createLogger({ ...ctx, ...additionalContext }, config);
        },
        module: (moduleName) => {
            return createLogger({ ...ctx, module: moduleName }, config);
        },
        startTimer: (label) => {
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
export function createChildLogger(parentContext, additionalContext) {
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
export function structuredLog(level, message, context = {}) {
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
 * - ENABLE_LOG_HASH_USER_ID: "true" to hash user IDs (default: false)
 *
 * @param env - Environment object with optional LOG_* variables
 *
 * @example
 * // In worker entry point:
 * initLoggerFromEnv(env);
 */
export function initLoggerFromEnv(env) {
    const validLevels = ['debug', 'info', 'warn', 'error'];
    const validFormats = ['json', 'pretty'];
    const level = validLevels.includes(env.LOG_LEVEL)
        ? env.LOG_LEVEL
        : DEFAULT_LOGGER_CONFIG.level;
    const format = validFormats.includes(env.LOG_FORMAT)
        ? env.LOG_FORMAT
        : DEFAULT_LOGGER_CONFIG.format;
    const hashUserId = env.ENABLE_LOG_HASH_USER_ID === 'true';
    setLoggerConfig({ level, format, hashUserId });
}
// Note: getLogger is exported from './middleware/request-context' to avoid
// dependency on Hono types in this base utility module.
