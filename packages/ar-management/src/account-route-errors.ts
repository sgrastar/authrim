/**
 * Errors of resolving an account's route through Lookup.
 */

/**
 * Whether resolving an account's route failed because the account there is no longer active
 * (suspended, locked, being deleted): account routes resolve active accounts only.
 */
export function isInactiveAccountRouteError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === 'lookup_destination_revalidation_failed' &&
    error.cause === 'account_inactive'
  );
}
