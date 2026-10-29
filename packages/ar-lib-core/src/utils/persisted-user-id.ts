const PERSISTED_USER_ID_PATTERN = /^(?:[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}|[A-Za-z0-9_-]{21})$/u;

/** Validate persisted user IDs without loading runtime settings or Worker bindings. */
export function isValidPersistedUserId(id: unknown): id is string {
  return typeof id === 'string' && PERSISTED_USER_ID_PATTERN.test(id);
}
