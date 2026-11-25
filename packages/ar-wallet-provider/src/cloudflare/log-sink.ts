/** The only place that writes logs: one JSON line per event (Workers Logs picks it up). */

import type { ProviderLogger } from '../service/logger';

declare const console: { log(message: string): void };

export const consoleLogger: ProviderLogger = {
  log(event) {
    // The single, audited log sink; the event type is the allow-list of design section 11.
    console.log(JSON.stringify({ service: 'wallet-provider', ...event }));
  },
};
