/**
 * The answer of admin views whose settings cannot be read.
 *
 * Runtime refuses requests whose settings cannot be read, so these views must not answer with
 * env or default values as if they were the ones in effect: they answer 503 instead.
 */

import type { Context } from 'hono';

export function settingsUnavailableResponse(c: Context) {
  return c.json(
    {
      error: 'temporarily_unavailable',
      error_description: 'Settings cannot be read, so the values in effect are unknown; try again',
    },
    503
  );
}
