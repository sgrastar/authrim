const UNKNOWN_FATAL_ERROR = 'Unknown fatal error';

export function formatFatalError(reason: unknown): string {
  try {
    if (reason instanceof Error) {
      if (typeof reason.stack === 'string' && reason.stack.trim().length > 0) {
        return reason.stack;
      }
      const name = typeof reason.name === 'string' && reason.name ? reason.name : 'Error';
      const message = typeof reason.message === 'string' ? reason.message : '';
      return message ? `${name}: ${message}` : name;
    }
    if (typeof reason === 'string') return reason;
    if (reason === null) return 'null';
    if (reason === undefined) return 'undefined';
    if (
      typeof reason === 'number' ||
      typeof reason === 'boolean' ||
      typeof reason === 'bigint' ||
      typeof reason === 'symbol'
    ) {
      return String(reason);
    }
    if (typeof reason === 'function') return '[function]';
    return JSON.stringify(reason) || UNKNOWN_FATAL_ERROR;
  } catch {
    return UNKNOWN_FATAL_ERROR;
  }
}
