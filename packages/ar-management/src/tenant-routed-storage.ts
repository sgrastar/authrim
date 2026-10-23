/**
 * Whether the tenant's accounts are routed to their own databases. One definition for every
 * Worker: see usesRoutedAccountStorage in ar-lib-core (ar-auth decides with it too). Re-exported
 * here so this Worker's modules (and their tests) keep one place to import it from.
 */
export { usesRoutedAccountStorage } from '@authrim/ar-lib-core';
