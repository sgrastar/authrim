/**
 * zod for the Admin API, with zod 3's English error messages installed.
 *
 * Admin API error bodies embed zod's default issue messages (`reason`, `details`,
 * `error_description`), so they keep the wording they had before the zod 4 migration.
 * Import `z` from here, not from 'zod', so the error map is in place before any schema
 * parses. The map is process-global for the zod instance, so it also covers the
 * ar-lib-plugin schemas this worker validates.
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
 * An ISO 8601 date-time string as zod 3's `z.string().datetime()` accepted it (seconds
 * optional; with `offset`, `+09:00`/`+0900` too). zod 4's `z.iso.datetime()` requires
 * seconds and a colon in offsets, which would reject requests zod 3 accepted.
 */
export function legacyDatetimeString(options: { offset?: boolean; error?: string } = {}) {
  return z
    .string()
    .regex(
      legacyZodDatetimeRegex({ offset: options.offset }),
      options.error ?? LEGACY_ZOD_DATETIME_MESSAGE
    );
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
