/**
 * zod for the setup CLI, with zod 3's English error messages installed.
 *
 * CLI output, lock-file errors and the setup web API embed zod's default messages, so
 * they keep the wording they had before the zod 4 migration. Import `z` from here, not
 * from 'zod', so the error map is in place before any schema parses.
 */
import { z } from 'zod';
import {
  LEGACY_ZOD_DATETIME_MESSAGE,
  legacyZodDatetimeRegex,
  legacyZodErrorMessage,
} from '@authrim/ar-lib-core/utils/zod-legacy-errors';

z.config({ customError: legacyZodErrorMessage });

export { z };

/**
 * An ISO 8601 date-time string as zod 3's `z.string().datetime()` accepted it (UTC `Z`,
 * seconds optional). zod 4's `z.iso.datetime()` requires seconds, which would reject
 * lock files and configs that zod 3 accepted.
 */
export function legacyDatetimeString() {
  return z.string().regex(legacyZodDatetimeRegex(), LEGACY_ZOD_DATETIME_MESSAGE);
}

/**
 * A URL string as zod 3's `z.string().url()` validated it: anything `new URL()` parses,
 * with the value left as sent. zod 4's `z.url()` trims the value first, so
 * `' https://x'` would pass a following `startsWith('https://')` refinement that
 * rejected it before.
 */
export function legacyUrlString() {
  return z.string().check((payload) => {
    try {
      new URL(payload.value);
    } catch {
      payload.issues.push({
        code: 'invalid_format',
        format: 'url',
        input: payload.value,
        continue: true,
      });
    }
  });
}
