const UNKNOWN_FATAL_ERROR = 'Unknown fatal error';

/**
 * Operator guidance for failures whose cause is not obvious from the stable error code. The codes
 * are matched as substrings so the hint also covers errors wrapped by the caller.
 */
const FATAL_ERROR_HINTS: ReadonlyArray<readonly [code: string, hint: string]> = [
  [
    'release_rollout_blocked:release_target_set_mismatch',
    'Control found a database outside the set that update had verified (the set of databases ' +
      'changed while the rollout was being prepared), so it blocked the rollout before running ' +
      'any migration SQL on the Control-managed (tenant and lookup) databases of this release. ' +
      'Databases that setup owns itself, such as the Control database, may already have had ' +
      'this release applied. Check that provisioning has settled, then run update again: it ' +
      'recomputes and re-verifies the database set and hands it to Control as a new snapshot. ' +
      'If a database the lock does not know remains (for example one provisioned in the ' +
      'meantime), the re-run still stops with control_target_set_mismatch / unknown_to_lock ' +
      'until the lock and its recorded migration evidence match that database; confirm which ' +
      'database it is and whether its migration history matches the draft.',
  ],
];

function withHint(text: string, message: string): string {
  const hint = FATAL_ERROR_HINTS.find(([code]) => message.includes(code))?.[1];
  return hint ? `${text}\n${hint}` : text;
}

export function formatFatalError(reason: unknown): string {
  try {
    if (reason instanceof Error) {
      const message = typeof reason.message === 'string' ? reason.message : '';
      if (typeof reason.stack === 'string' && reason.stack.trim().length > 0) {
        return withHint(reason.stack, message);
      }
      const name = typeof reason.name === 'string' && reason.name ? reason.name : 'Error';
      return withHint(message ? `${name}: ${message}` : name, message);
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
