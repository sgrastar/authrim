/**
 * Whether the path of a request URL holds a `%` that does not start a two-digit escape.
 *
 * Why this is checked on the RAW path, before a decision is made on `c.req.path`:
 *
 * - Hono routes on `getPath()`, which runs `decodeURI` over the raw path. When the whole decode
 *   fails (a malformed escape), it falls back to decoding only the runs of well-formed escapes and
 *   leaves the rest in place. That REPAIRS some malformed input: raw `%6%34cr` becomes the text
 *   `%64cr`, raw `%2%35` becomes `%25`. Route params are then decoded a second time by
 *   `c.req.param()` (`decodeURIComponent`, same per-run fallback), so `%64cr` becomes `dcr` in the
 *   handler while a decision made on the path text saw `%64cr`, which is not the name `dcr`.
 * - A raw path in which every `%` starts a two-digit escape cannot be repaired this way: stage one
 *   keeps `%25` (it pre-replaces it with `%2525` so `decodeURI` returns `%25` again, never `%`),
 *   keeps the escapes of reserved characters (`%2F`, `%40`, ...), and decodes the rest, so the path
 *   text holds only ordinary characters, reserved-character escapes, `%25`, and runs that are not
 *   valid UTF-8 (left as they are). Stage two (a route param) decodes those remaining escapes once:
 *   the result differs from the path text only where a reserved character or a `%` was escaped,
 *   or where an invalid run stays invalid. None of those can spell a name made of letters, digits,
 *   `-`, `_` or `.`, so a param can equal a static route name only if the path text already did.
 *
 * A malformed escape is therefore refused (or treated as the strictest case), not repaired.
 */
export function hasMalformedPercentEscape(requestUrl: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    return true;
  }
  return /%(?![0-9A-Fa-f]{2})/.test(pathname);
}
