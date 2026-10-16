/**
 * Diagnostic Log Redaction
 *
 * The protection every diagnostic log entry gets in every storage mode, whatever its step or
 * category and whoever wrote it (the server, or an SDK through ingest), plus the text and address
 * helpers the privacy modes share:
 *
 * - secrets (tokens, codes, client secrets, passwords, cookies, authorization headers) are
 *   replaced by a SHA-256 fingerprint or a marker: by key name (camelCase, snake_case and
 *   kebab-case alike, escaped or not), in object keys, inside URLs, query strings, form bodies and
 *   JSON text, and as compact JWTs;
 * - identifiers an entry carries (request id, session id, ...) are validated, not trusted;
 * - personal data in text (emails, phone numbers, cards) is found on a Unicode-normalised view and
 *   redacted in the original text.
 *
 * Principles: when in doubt, or over a processing limit, REDACT; never pass the original text
 * through. Every scan is a single linear pass (no backtracking regexes over untrusted text), each
 * step is counted in `redactionWork`, and an entry has an overall budget (characters, nodes,
 * fingerprints) after which the rest is replaced by a marker.
 *
 * This module imports nothing from diagnostic-security.ts, which builds on it.
 */

/** Nesting deeper than this is cut, not copied. */
export const MAX_REDACTION_DEPTH = 24;
/** A string longer than this keeps its (cleaned) head and ends with a marker. */
export const MAX_TEXT_LENGTH = 65_536;
/** Characters of text one entry may have scanned in all; the rest becomes a marker. */
export const ENTRY_TEXT_BUDGET = 1_048_576;
/** Objects, arrays and values one entry may hold; the rest becomes a marker. */
export const MAX_NODES = 50_000;
/** Fingerprints one entry may compute; later secrets become a marker. */
export const MAX_FINGERPRINTS = 2_000;

const MAX_KEY_LENGTH = 256;

const SECRET_MARKER = '[SECRET_REDACTED]';
const TRUNCATED_MARKER = '[TRUNCATED]';
const INVALID_MARKER = '[INVALID]';
const CIRCULAR_MARKER = '[CIRCULAR]';
const UNREADABLE_MARKER = '[UNREADABLE]';
const IP_MARKER = '[IP_REDACTED]';
const JWT_MARKER = '[JWT_REDACTED]';

/**
 * How many steps the scanners took (characters examined). Tests assert that the work grows
 * linearly with the input, which a clock cannot show reliably.
 */
export const redactionWork = { units: 0 };
function work(units = 1): void {
  redactionWork.units += units;
}

// ---------------------------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------------------------

/** SHA-256 of a string as lowercase hex. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** `sha256:<prefix>` of a value: stable, so entries still correlate, and irreversible. */
export async function fingerprint(value: string, prefixLength = 12): Promise<string> {
  const hex = await sha256Hex(value);
  return `sha256:${hex.slice(0, Math.max(8, Math.min(64, prefixLength)))}`;
}

// ---------------------------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------------------------

export interface RedactionBudget {
  text: number;
  nodes: number;
  fingerprints: number;
}

export function newRedactionBudget(): RedactionBudget {
  return { text: ENTRY_TEXT_BUDGET, nodes: MAX_NODES, fingerprints: MAX_FINGERPRINTS };
}

async function fingerprintWithin(
  value: string,
  prefixLength: number,
  budget: RedactionBudget
): Promise<string> {
  if (budget.fingerprints <= 0 || value.length > MAX_TEXT_LENGTH) return SECRET_MARKER;
  budget.fingerprints -= 1;
  work(value.length);
  return fingerprint(value, prefixLength);
}

/** A character a text may be cut at: it ends a token, so nothing is split. */
function isCutDelimiter(c: string): boolean {
  return (
    c === ' ' ||
    c === '\t' ||
    c === '\n' ||
    c === '\r' ||
    c === '"' ||
    c === "'" ||
    c === ',' ||
    c === ';' ||
    c === '&' ||
    c === '#' ||
    c === '<' ||
    c === '>' ||
    c === '(' ||
    c === ')' ||
    c === '[' ||
    c === ']' ||
    c === '{' ||
    c === '}' ||
    c === '|'
  );
}

/**
 * The cap on a text, applied AFTER it was protected (a transform can make a text longer, and a
 * cut can never fall inside a token that was not protected yet). A text over the limit is cut
 * back to the delimiter before the cut point, so no token (a JWT, a long run, a `[..._REDACTED]`
 * marker) is split, and ends with `[TRUNCATED]`: never longer than the limit, and what is left is
 * whole, so protecting it again changes nothing. A text with no delimiter before the cut point
 * is dropped whole.
 */
export function capLength(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) return text;
  const limit = MAX_TEXT_LENGTH - TRUNCATED_MARKER.length;
  let cut = 0;
  for (let j = limit; j >= 0; j -= 1) {
    work();
    const c = text[j];
    if (!isCutDelimiter(c)) continue;
    if (c === ']') {
      // Inside a marker when it is the first dropped character; otherwise keep the bracket.
      if (j === limit) continue;
      cut = j + 1;
    } else {
      cut = j;
    }
    break;
  }
  return text.slice(0, cut) + TRUNCATED_MARKER;
}

/**
 * Run a text transform within the entry's budget. The whole text is protected first (a text the
 * budget cannot cover is replaced whole), then capped (see capLength), so the output is never
 * longer than the limit and protecting twice changes nothing.
 */
function withinBudget(
  text: string,
  budget: RedactionBudget,
  transform: (value: string) => string
): string {
  if (text.length === 0) return text;
  if (text.length > budget.text) return TRUNCATED_MARKER;
  budget.text -= text.length;
  return capLength(transform(text));
}

// ---------------------------------------------------------------------------------------------
// Forms this code produces itself
// ---------------------------------------------------------------------------------------------

const FINGERPRINT_FORM = /^sha256:[0-9a-f]{8,64}$/;
const HMAC_FORM = /^hmac:[0-9a-f]{8,64}$/;
const MARKER_FORM = /^\[[A-Z_]*(?:REDACTED|TRUNCATED|INVALID|CIRCULAR|UNREADABLE)\]$/;
const MASKED_VALUE_FORM = /^[^\r\n]{0,6}\.\.\.[^\r\n]{0,4} \(hmac:[0-9a-f]{8,64}\)$/;
const MASKED_EMAIL_FORM = /^[^\s@]?\*\*\*@[\p{L}\p{N}\p{M}.-]+ \(hmac:[0-9a-f]{8,64}\)$/u;
const MASKED_PHONE_FORM = /^\*\*\*-\*\*\*-\d{0,4} \(hmac:[0-9a-f]{8,64}\)$/;
const MASKED_IPV4_FORM = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.0\/24$/;
const MASKED_IPV6_FORM = /^[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}::\/48$/;

/**
 * Whether the ENTIRE string is one of the forms this code writes when it protects a value. Only
 * then is a value left alone when it is protected again; a string that merely contains or ends
 * with such a form (as a sender could write) is protected like any other.
 */
export function isProtectedForm(value: string): boolean {
  return (
    FINGERPRINT_FORM.test(value) ||
    HMAC_FORM.test(value) ||
    MARKER_FORM.test(value) ||
    MASKED_VALUE_FORM.test(value) ||
    MASKED_EMAIL_FORM.test(value) ||
    MASKED_PHONE_FORM.test(value) ||
    MASKED_IPV4_FORM.test(value) ||
    MASKED_IPV6_FORM.test(value)
  );
}

/**
 * What a secret leaves behind: a fingerprint or a marker. A partial mask (`abc...xyz (hmac:..)`)
 * keeps the shell of the value and is NOT accepted as protection for a secret.
 */
export function isFingerprintOrMarker(value: string): boolean {
  return FINGERPRINT_FORM.test(value) || MARKER_FORM.test(value);
}

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

/** The longest name (an object key, a JSON member, a parameter name) that is inspected. */
const MAX_NAME_LENGTH = MAX_KEY_LENGTH;
/** Most combining marks a name may hold and still be inspected (a name made of them is no name). */
const MAX_NAME_MARKS = 32;
/** Work units charged per character for Unicode normalisation (it costs more than a scan). */
const NFKC_WORK_PER_CHAR = 16;
const COMBINING_MARKS = /\p{M}/gu;

/**
 * The NFKC form of a name, or null when it is not safe to normalise: longer than
 * MAX_NAME_LENGTH, or holding more than MAX_NAME_MARKS combining marks. Normalisation can be
 * super-linear in a long run of combining marks, so BOTH limits are checked first, on the raw
 * name, and the caller treats a null name as a secret (it cannot be judged). The normalisation is
 * charged to the work budget at NFKC_WORK_PER_CHAR per character.
 */
function foldName(name: string): string | null {
  if (name.length > MAX_NAME_LENGTH) {
    work(name.length);
    return null;
  }
  let ascii = true;
  for (let i = 0; i < name.length; i += 1) {
    if (name.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    work(name.length);
    return name;
  }
  work(name.length * NFKC_WORK_PER_CHAR);
  if ((name.match(COMBINING_MARKS)?.length ?? 0) > MAX_NAME_MARKS) return null;
  return name.normalize('NFKC');
}

/** A key without case or separators: accessToken, access_token and Access-Token alike. */
export function normalizeKey(key: string): string {
  // NFKC first: a full-width or otherwise decorated spelling (ｃｏｄｅ_ｖｅｒｉｆｉｅｒ) is the same name.
  // A name that cannot be normalised safely (see foldName) is only lower-cased, which is linear.
  return (foldName(key) ?? key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

const SECRET_KEYS = new Set([
  'accesstoken',
  'idtoken',
  'refreshtoken',
  'codeverifier',
  'clientsecret',
  'clientassertion',
  'assertion',
  'devicecode',
  'logouttoken',
  'idtokenhint',
  'authorizationcode',
  'authreqid',
  'token',
  'password',
  'passwd',
  'passphrase',
  'secret',
  'apikey',
  'privatekey',
  'privatejwk',
  'authorization',
  'proxyauthorization',
  'authentication',
  'wwwauthenticate',
  'cookie',
  'setcookie',
  'samlresponse',
  'otp',
  'passcode',
  'pwd',
  'pin',
  'credential',
]);
const SECRET_KEY_WORDS = [...SECRET_KEYS];

/**
 * The secret words that name a TOKEN: a credential that is issued, sent and checked by its value.
 * A hash or fingerprint of a token is a public handle on it (at_hash, token_hash, tokenHash): it
 * says which token, and cannot be used as one. For every other secret word (password, secret,
 * client_secret, private_key, api_key, pin, otp, code_verifier ...) a hash or digest is the value
 * the secret is checked against or derived into (an Argon2 string), and stays a secret.
 */
const TOKEN_WORDS = new Set([
  'accesstoken',
  'idtoken',
  'refreshtoken',
  'logouttoken',
  'idtokenhint',
  'token',
]);

/** Short secret words are only secret words on their own, not glued to another (spin, hotp). */
const SHORT_SECRET_WORD = 3;

/**
 * Secret words that are also plain nouns in the names of metadata (authorization_details,
 * authentication_method, authentication_time): they name a secret only as the LAST word of a name
 * or before a word that says the value is the credential itself (authorization_header).
 */
const ENDING_ONLY_WORDS = new Set(['authorization', 'authentication']);
const CREDENTIAL_NOUNS = new Set([
  'header',
  'value',
  'string',
  'bearer',
  'credential',
  'credentials',
]);

/**
 * Words that, right after a secret word, make the name one of METADATA about the secret: its type,
 * size, expiry, where it is fetched, how it is authenticated. The value of such a name is not a
 * secret (token_type, token_count, token_hash, token_expires_in, secret_name, secret_version,
 * cookie_policy, password_policy, token_endpoint, client_secret_basic ...). Anything not listed is
 * a secret: when in doubt, the value is hidden.
 */
const METADATA_AFTER = new Set([
  'type',
  'types',
  'count',
  'counts',
  'expires',
  'expiry',
  'expiration',
  'expired',
  'exp',
  'iat',
  'nbf',
  'issued',
  'lifetime',
  'ttl',
  'endpoint',
  'endpoints',
  'url',
  'uri',
  'policy',
  'policies',
  'name',
  'names',
  'version',
  'length',
  'size',
  'status',
  'age',
  'algorithm',
  'alg',
  'method',
  'methods',
  'format',
  'kind',
  'basic',
  'post',
  'jwt',
  'signed',
  'encrypted',
  'valid',
  'validation',
  'validated',
  'used',
  'usage',
  'limit',
  'domain',
  'path',
  'secure',
  'samesite',
  'httponly',
]);
/**
 * Metadata that is only metadata after a TOKEN word (see TOKEN_WORDS): a fingerprint of the
 * token. After any other secret word the same words name the stored form of the secret
 * (password_hash, client_secret_hash, pin_hash, api_key_digest) and the value stays hidden.
 */
const TOKEN_METADATA_AFTER = new Set(['hash', 'hashes', 'fingerprint', 'fingerprints', 'digest']);
/** Words right before a secret word that make the name a limit or a flag (max_token_lifetime). */
const METADATA_BEFORE = new Set(['max', 'min', 'has', 'is', 'num']);

/** How many words at most one secret word spans (id + token + hint). */
const MAX_SECRET_WORD_SPAN = 4;

/**
 * Characters that join the words of ONE name (`status_code`, `error.code`, `page+size`, a space
 * as + or %20). Any other character ends a name for the purpose of the weak word `code`.
 */
const NAME_WORD_JOINER = /[^A-Za-z0-9_\-.+%[\]]+/;

/**
 * `secret`: the value is a secret. `plural`: the name is a plural (`tokens`), whose strings and
 * structures are secrets but whose numbers are counts (`total_tokens: 120`).
 */
export type SecretNameKind = 'secret' | 'plural';

/** The words of a name: split at anything but letters and digits and at camelCase boundaries. */
function nameWords(text: string): string[] {
  return (
    text
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .map((word) => word.toLowerCase())
      // an array index (access_token[0], access_token.0) is no part of the name
      .filter((word) => word.length > 0 && !/^[0-9]+$/.test(word))
  );
}

/** Whether a secret word found in a name is only metadata about the secret (see above). */
function isMetadataHit(words: string[], first: number, last: number, secretWord: string): boolean {
  const next = words[last + 1];
  const previous = first > 0 ? words[first - 1] : undefined;
  if (next !== undefined && METADATA_AFTER.has(next)) return true;
  if (next !== undefined && TOKEN_METADATA_AFTER.has(next) && TOKEN_WORDS.has(secretWord))
    return true;
  if (next === 'id' && secretWord === 'secret') return true;
  if (previous !== undefined && METADATA_BEFORE.has(previous)) return true;
  if (ENDING_ONLY_WORDS.has(secretWord)) {
    return next !== undefined && !CREDENTIAL_NOUNS.has(next);
  }
  return false;
}

function judgeName(name: string): SecretNameKind | null {
  const text = foldName(name);
  // A name that cannot be inspected (too long, a heap of combining marks) is a secret
  if (text === null) return 'secret';
  const whole = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (whole.length === 0) return null;
  // `code` is too common a word to match anywhere (`status_code`, `error.code`): it is a secret
  // as the whole name (spaces, separators and control characters around it do not count: `code `,
  // `code_`, `code%20`) or as the last name after a character that does not join words
  // (`a^code`, `x|code`, `x,code`).
  if (whole === 'code') return 'secret';
  const segments = text.split(NAME_WORD_JOINER).filter((part) => /[A-Za-z0-9]/.test(part));
  if (
    segments.length > 0 &&
    segments[segments.length - 1].replace(/[^A-Za-z0-9]/g, '').toLowerCase() === 'code'
  )
    return 'secret';

  const words = nameWords(text);
  work(words.length * 8);
  let kind: SecretNameKind | null = null;
  for (let last = 0; last < words.length; last += 1) {
    let joined = '';
    for (let first = last; first >= 0 && first > last - MAX_SECRET_WORD_SPAN; first -= 1) {
      joined = words[first] + joined;
      for (const secretWord of SECRET_KEY_WORDS) {
        // Matches the end of the words joined: a word glued to a secret word (xxcookie) is a
        // secret word too, one that merely CONTAINS a secret word (tokenizer, secretary) is not.
        let plural = false;
        if (!joined.endsWith(secretWord)) {
          if (ENDING_ONLY_WORDS.has(secretWord) || !joined.endsWith(`${secretWord}s`)) continue;
          plural = true;
        }
        const length = secretWord.length + (plural ? 1 : 0);
        // the word the secret word starts in
        let start = last;
        let covered = words[last].length;
        while (covered < length && start > first) {
          start -= 1;
          covered += words[start].length;
        }
        // a short word (pin, otp, pwd) counts only as a word of its own, not glued to another
        if (secretWord.length <= SHORT_SECRET_WORD && covered !== length) continue;
        if (isMetadataHit(words, start, last, secretWord)) continue;
        if (!plural) return 'secret';
        kind = 'plural';
      }
    }
  }
  return kind;
}

/**
 * A name as written and as percent-decoded (`code%20` is `code `): a key that comes from an
 * unparsed query string keeps its escapes. A name that cannot be decoded in full is a secret.
 */
function judgeNameAndEncodings(name: string): SecretNameKind | null {
  const written = judgeName(name);
  if (name.length > MAX_NAME_LENGTH || name.indexOf('%') < 0) return written;
  // The decoded name is judged whatever the name as written is: a plural (`tokens.%70assword`)
  // must not end the judgement before the decoding and its fail-closed cases (`tokens.%FF`).
  const decoded = decodeParameterName(name);
  if (!decoded.complete) return 'secret';
  const unescaped = decoded.name === name ? written : judgeName(decoded.name);
  // A secret in either reading is a secret. The exception for numbers of a plural name holds
  // only when both readings are that plural and nothing else.
  if (written === unescaped) return written;
  return 'secret';
}

const NAME_CACHE_LIMIT = 2_048;
const nameCache = new Map<string, SecretNameKind | null>();

/**
 * Whether a name (an object key, a JSON member, a parameter name) names a secret, and how.
 *  - The words of the name are found whatever separates them (`_ - . + ~ ! * ( ) $ , ^ |`, `%20`,
 *    camelCase and acronyms: HTTPAuthorization, XMLHttpToken, APIKey), an array index is dropped
 *    (access_token[0]), and a secret word ANYWHERE in the name makes it a secret (secret_value,
 *    session_cookie, my.authorization, x+api+key), unless it is metadata about the secret.
 *  - A secret word must start at a word boundary: `tokenizer`, `secretary` and `monkey` hold none.
 *    Where there is no boundary (an all-lowercase run such as xxcookie) only a whole known secret
 *    word at the END of the run counts.
 *  - `code` (an authorization code) counts as the whole name or as the last name after a character
 *    that does not join words (`a^code`); `status_code` and `error.code` are not secrets.
 *  - A name too long to inspect is a secret.
 */
export function secretNameKind(name: string): SecretNameKind | null {
  work(name.length);
  if (name.length > 64) return judgeNameAndEncodings(name);
  const cached = nameCache.get(name);
  if (cached !== undefined) return cached;
  const kind = judgeNameAndEncodings(name);
  if (nameCache.size >= NAME_CACHE_LIMIT) nameCache.clear();
  nameCache.set(name, kind);
  return kind;
}

export function isSecretName(name: string): boolean {
  return secretNameKind(name) !== null;
}

/** In text, a name is judged as any other: `code` is a secret wherever it is a key or parameter. */
function isSecretTextKey(name: string): boolean {
  return isSecretName(name);
}

export type PiiKeyKind = 'email' | 'phone' | 'name' | 'opaque' | 'ip';

const PII_KEY_KINDS = new Map<string, PiiKeyKind>([
  ...['email', 'emailaddress', 'mail', 'preferredemail', 'workemail'].map(
    (key) => [key, 'email'] as [string, PiiKeyKind]
  ),
  ...[
    'phonenumber',
    'phone',
    'mobile',
    'mobilenumber',
    'tel',
    'telephone',
    'cellphone',
    'msisdn',
  ].map((key) => [key, 'phone'] as [string, PiiKeyKind]),
  ...[
    'name',
    'givenname',
    'familyname',
    'middlename',
    'nickname',
    'preferredusername',
    'fullname',
    'displayname',
    'firstname',
    'lastname',
    'surname',
    'username',
  ].map((key) => [key, 'name'] as [string, PiiKeyKind]),
  ...[
    'address',
    'streetaddress',
    'postalcode',
    'zipcode',
    'locality',
    'birthdate',
    'birthday',
    'dateofbirth',
    'dob',
    'gender',
  ].map((key) => [key, 'opaque'] as [string, PiiKeyKind]),
  ...[
    'ip',
    'ipaddress',
    'clientip',
    'remoteaddr',
    'remoteaddress',
    'xforwardedfor',
    'xrealip',
    'cfconnectingip',
    'trueclientip',
    'forwardedfor',
  ].map((key) => [key, 'ip'] as [string, PiiKeyKind]),
]);

/** What kind of personal data a key names, by normalized spelling (givenName == given_name). */
export function piiKeyKind(key: string): PiiKeyKind | undefined {
  return PII_KEY_KINDS.get(normalizeKey(key));
}

// ---------------------------------------------------------------------------------------------
// A plain copy that is safe to walk
// ---------------------------------------------------------------------------------------------

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function snapshotValue(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
  budget: RedactionBudget
): unknown {
  // Every visited value counts, null, undefined and the holes of a sparse array included: a long
  // array of numbers, of nulls or with a huge length is cut too.
  work();
  if (budget.nodes <= 0) return TRUNCATED_MARKER;
  budget.nodes -= 1;
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return undefined;
  }
  const object = value as Record<string, unknown>;
  if (ancestors.has(object)) return CIRCULAR_MARKER;
  if (depth >= MAX_REDACTION_DEPTH) return TRUNCATED_MARKER;
  ancestors.add(object);
  try {
    if (object instanceof Date) {
      return Number.isNaN(object.getTime()) ? null : object.toISOString();
    }
    const toJson = (object as { toJSON?: unknown }).toJSON;
    if (typeof toJson === 'function') {
      const json: unknown = (toJson as () => unknown).call(object);
      return json === object
        ? UNREADABLE_MARKER
        : snapshotValue(json, depth + 1, ancestors, budget);
    }
    if (object instanceof Map) {
      const result: Record<string, unknown> = {};
      for (const [key, item] of object) {
        if (budget.nodes <= 0) {
          setOwn(result, TRUNCATED_MARKER, TRUNCATED_MARKER);
          break;
        }
        const copied = snapshotValue(item, depth + 1, ancestors, budget);
        if (copied !== undefined) setOwn(result, String(key), copied);
      }
      return result;
    }
    if (Array.isArray(object) || object instanceof Set) {
      const result: unknown[] = [];
      const add = (item: unknown): boolean => {
        if (budget.nodes <= 0) {
          result.push(TRUNCATED_MARKER);
          return false;
        }
        const copied = snapshotValue(item, depth + 1, ancestors, budget);
        result.push(copied === undefined ? null : copied);
        return true;
      };
      if (Array.isArray(object)) {
        for (let i = 0; i < object.length; i += 1) {
          if (!add(object[i])) break;
        }
      } else {
        for (const item of object as unknown as Set<unknown>) {
          if (!add(item)) break;
        }
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const key in object) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
      if (budget.nodes <= 0) {
        setOwn(result, TRUNCATED_MARKER, TRUNCATED_MARKER);
        break;
      }
      let item: unknown;
      try {
        item = object[key];
      } catch {
        item = UNREADABLE_MARKER;
      }
      const copied = snapshotValue(item, depth + 1, ancestors, budget);
      if (copied !== undefined) setOwn(result, key, copied);
    }
    return result;
  } catch {
    return UNREADABLE_MARKER;
  } finally {
    ancestors.delete(object);
  }
}

/**
 * A plain JSON-like copy of a value that is safe to walk: cycles become `[CIRCULAR]`, nesting
 * beyond the bound (checked before anything is stringified) and anything past the node budget
 * become `[TRUNCATED]`, Maps and Sets become objects and arrays, `toJSON` is called and its result
 * copied, and a getter or `toJSON` that throws becomes `[UNREADABLE]`.
 */
export function safeSnapshot<T>(value: T, budget: RedactionBudget = newRedactionBudget()): T {
  return snapshotValue(value, 0, new Set<object>(), budget) as T;
}

// ---------------------------------------------------------------------------------------------
// Compact JWTs
// ---------------------------------------------------------------------------------------------

const MAX_JWT_LENGTH = 16_384;
const MAX_JWT_SEGMENT_LENGTH = 8_192;
const JOSE_HEADER_MEMBERS = ['alg', 'enc', 'typ', 'cty', 'kid', 'crit', 'zip'];

function isBase64UrlCode(c: number): boolean {
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95
  );
}

/** The bytes of the first base64url characters of a segment (a multiple of four of them). */
function leadingBytes(segment: string): string | null {
  const length = Math.min(segment.length, 16);
  const prefix = segment.slice(0, length - (length % 4 === 1 ? 1 : 0));
  try {
    const base64 = prefix.replace(/-/g, '+').replace(/_/g, '/');
    return atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  } catch {
    return null;
  }
}

/**
 * Whether a segment may be a JSON object: its first byte that is not JSON whitespace is `{`
 * (so a header written with leading spaces, which base64 starts with `IH`, still counts). A
 * segment whose first bytes are all whitespace is undecided, and so is decoded in full.
 */
function startsLikeJsonObject(segment: string): boolean {
  const bytes = leadingBytes(segment);
  if (bytes === null) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    const c = bytes.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) continue;
    return c === 123;
  }
  return true;
}

/** Decodes a segment to a JSON object, or null. `budget` bounds the decodes one scan may make. */
function decodeJsonObject(
  segment: string,
  budget?: { decodes: number }
): Record<string, unknown> | null {
  if (!segment || segment.length > MAX_JWT_SEGMENT_LENGTH || segment.length % 4 === 1) return null;
  work(segment.length);
  if (!startsLikeJsonObject(segment)) return null;
  if (budget) budget.decodes -= 1;
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    );
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasJoseHeader(segment: string, budget?: { decodes: number }): boolean {
  const header = decodeJsonObject(segment, budget);
  return header !== null && JOSE_HEADER_MEMBERS.some((member) => member in header);
}

/**
 * Whether a string is a compact JWS (three segments) or JWE (five): not by its look but because
 * its header decodes to a JSON object with a JOSE member, or its payload to a JSON object. A
 * detached or empty payload is fine.
 */
export function isCompactJwt(candidate: string): boolean {
  if (candidate.length > MAX_JWT_LENGTH) return false;
  const segments = candidate.split('.');
  if (segments.length !== 3 && segments.length !== 5) return false;
  if (hasJoseHeader(segments[0])) return true;
  return segments.length === 3 && decodeJsonObject(segments[1]) !== null;
}

/** A segment too long to inspect is JWT-shaped when it starts like a JSON object. */
function looksLikeJoseHeader(segment: string): boolean {
  return segment.length >= 8 && startsLikeJsonObject(segment);
}

/** Decodes one scan may make before the rest of a run that looks like JWTs is redacted whole. */
const MAX_JWT_DECODES = 512;

function jwtsInRun(
  text: string,
  from: number,
  to: number,
  budget: { decodes: number }
): Array<[number, number]> {
  let start = from;
  while (start < to && text.charCodeAt(start) === 46) start += 1;
  const starts: number[] = [start];
  const ends: number[] = [];
  for (let k = start; k < to; k += 1) {
    if (text.charCodeAt(k) === 46) {
      ends.push(k);
      starts.push(k + 1);
    }
  }
  ends.push(to);
  const count = starts.length;
  if (count < 3) return [];

  const found: Array<[number, number]> = [];
  const headerCache = new Map<number, boolean>();
  const headerOf = (index: number): boolean => {
    let ok = headerCache.get(index);
    if (ok === undefined) {
      ok = hasJoseHeader(text.slice(starts[index], ends[index]), budget);
      headerCache.set(index, ok);
    }
    return ok;
  };

  let w = 0;
  while (w + 3 <= count) {
    work();
    if (budget.decodes <= 0) {
      // Too many candidates to inspect one by one: the safe side is to redact the rest.
      found.push([starts[w], to]);
      break;
    }
    let matched = 0;
    for (const length of [5, 3]) {
      if (w + length > count) continue;
      const total = ends[w + length - 1] - starts[w];
      const headLength = ends[w] - starts[w];
      const payloadLength = ends[w + 1] - starts[w + 1];
      if (total > MAX_JWT_LENGTH || headLength > MAX_JWT_SEGMENT_LENGTH) {
        // Too long to inspect, and shaped like a JWT: the safe side is to redact it.
        if (looksLikeJoseHeader(text.slice(starts[w], Math.min(ends[w], starts[w] + 16)))) {
          matched = length;
          break;
        }
        continue;
      }
      if (headerOf(w)) {
        matched = length;
        break;
      }
      if (length === 3) {
        if (payloadLength > MAX_JWT_SEGMENT_LENGTH) {
          if (looksLikeJoseHeader(text.slice(starts[w + 1], starts[w + 1] + 16))) matched = 3;
        } else if (decodeJsonObject(text.slice(starts[w + 1], ends[w + 1]), budget) !== null) {
          matched = 3;
        }
      }
      if (matched) break;
    }
    if (matched) {
      found.push([starts[w], ends[w + matched - 1]]);
      w += matched;
    } else {
      w += 1;
    }
  }
  return found;
}

/** Replace every compact JWT in a text with a marker (single pass). */
export function redactCompactJwts(text: string): string {
  if (text.indexOf('.') < 0) return text;
  const n = text.length;
  let out = '';
  let last = 0;
  let i = 0;
  const budget = { decodes: MAX_JWT_DECODES };
  work(n);
  while (i < n) {
    const c = text.charCodeAt(i);
    if (!(isBase64UrlCode(c) || c === 46)) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (isBase64UrlCode(d) || d === 46) j += 1;
      else break;
    }
    for (const [start, end] of jwtsInRun(text, i, j, budget)) {
      out += text.slice(last, start) + JWT_MARKER;
      last = end;
    }
    i = j;
  }
  return last === 0 ? text : out + text.slice(last);
}

// ---------------------------------------------------------------------------------------------
// Secrets in text: JSON, URLs, query strings, form bodies, bearer credentials
// ---------------------------------------------------------------------------------------------

function isWhitespaceCode(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/** Rounds of decoding a key may take (text stringified or percent-encoded that many times). */
const MAX_DECODE_ROUNDS = 64;

/**
 * Undo JSON string escapes (\uXXXX, \", \\ ...) as often as it takes: text stringified N times
 * has its escapes escaped N times, and each round undoes one. `complete` is false when the cap
 * on rounds was reached with escapes still left: the caller then treats the key as a secret.
 * Every round is counted in the work budget.
 */
function unescapeKey(raw: string): { key: string; complete: boolean } {
  let current = raw;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    if (current.indexOf('\\') < 0) return { key: current, complete: true };
    work(current.length);
    let out = '';
    for (let i = 0; i < current.length; i += 1) {
      const ch = current[i];
      if (ch !== '\\' || i === current.length - 1) {
        out += ch;
        continue;
      }
      i += 1;
      const next = current[i];
      if (next === 'u') {
        const hex = current.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += 'u';
        }
      } else if (next === 'n' || next === 'r' || next === 't' || next === 'b' || next === 'f') {
        out += ' ';
      } else {
        out += next;
      }
    }
    // a lone trailing backslash is all that is left: nothing more to undo
    if (out === current) return { key: current, complete: true };
    current = out;
  }
  return { key: current, complete: current.indexOf('\\') < 0 };
}

/**
 * The end (exclusive) of the JSON-ish value starting at `v`: a string, a bracketed value, or a
 * bare token. `depth` is the number of backslashes before the quotes of the key.
 */
function scanJsonValue(text: string, v: number, quote: string, depth: number): number {
  const n = text.length;
  if (v >= n) return v;
  // `depth` is the number of backslashes before the quotes of the key (JSON stringified `depth`+1
  // times has \"-style quotes with 2^k-1 backslashes). The value is read the same way.
  let run = 0;
  while (v + run < n && text[v + run] === '\\') run += 1;
  const quoted = text[v + run] === quote;
  if (quoted && depth === 0 && run === 0) {
    let i = v + 1;
    while (i < n) {
      work();
      const ch = text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) return i + 1;
      i += 1;
    }
    return n;
  }
  if (quoted && depth > 0 && run === depth) {
    // Stringified JSON: the value closes at a quote behind exactly as many backslashes as the
    // one that opened it; a quote behind other counts is a quote (or a backslash) of the inner
    // text, which is part of the value.
    let i = v + run + 1;
    while (i < n) {
      work();
      if (text[i] === '\\') {
        let count = 0;
        while (i < n && text[i] === '\\') {
          count += 1;
          i += 1;
        }
        if (text[i] === quote) {
          if (count === depth) return i + 1;
          i += 1;
        }
        continue;
      }
      i += 1;
    }
    return n;
  }
  // A quoted value that does not read like the key (a different number of backslashes), or a
  // structure inside stringified text: the structure cannot be followed with certainty, so the
  // value runs to the end of the text.
  if (quoted || (depth > 0 && (text[v] === '{' || text[v] === '['))) return n;
  const c = text[v];
  if (c === '{' || c === '[') {
    let level = 0;
    let i = v;
    while (i < n) {
      work();
      const ch = text[i];
      if (ch === '"' || ch === "'") {
        i += 1;
        while (i < n && text[i] !== ch) {
          work();
          i += text[i] === '\\' ? 2 : 1;
        }
      } else if (ch === '{' || ch === '[') {
        level += 1;
      } else if (ch === '}' || ch === ']') {
        level -= 1;
        if (level === 0) return i + 1;
      }
      i += 1;
    }
    return n;
  }
  let i = v;
  while (i < n) {
    work();
    const ch = text.charCodeAt(i);
    // , } ] \ whitespace & ; " '
    if (
      ch === 44 ||
      ch === 125 ||
      ch === 93 ||
      ch === 92 ||
      isWhitespaceCode(ch) ||
      ch === 38 ||
      ch === 59 ||
      ch === 34 ||
      ch === 39
    ) {
      break;
    }
    i += 1;
  }
  return i;
}

function jsonValueProtected(
  text: string,
  v: number,
  end: number,
  quote: string,
  depth: number
): boolean {
  const open = depth + 1;
  if (text[v + depth] === quote && text.slice(v, v + depth) === '\\'.repeat(depth)) {
    const inner = text.slice(v + open, Math.max(v + open, end - open));
    return inner === '' || isFingerprintOrMarker(inner);
  }
  return false;
}

/**
 * Replace the values of secret members in JSON text (`"client_secret": ...`), whatever the value
 * (a string with escapes, however long; a number; true, false, null; an object or array), with
 * escaped key names decoded first. Every pair of neighbouring quotes is a key candidate, so a
 * stray quote earlier in the text hides nothing. Text may hold stringified JSON (`\"key\":`).
 */
function redactJsonSecrets(text: string): string {
  if (text.indexOf(':') < 0) return text;
  let result = text;
  for (const quote of ['"', "'"]) {
    const n = result.length;
    let prev = result.indexOf(quote);
    if (prev < 0) continue;
    let out = '';
    let last = 0;
    while (prev !== -1) {
      work();
      const next = result.indexOf(quote, prev + 1);
      if (next === -1) break;
      work(next - prev);
      let k = next + 1;
      while (k < n && isWhitespaceCode(result.charCodeAt(k))) k += 1;
      if (result.charCodeAt(k) === 58) {
        let rawKey = result.slice(prev + 1, next);
        // the backslashes in front of the closing quote: how many times the JSON was stringified
        let depth = 0;
        while (depth < rawKey.length && rawKey[rawKey.length - 1 - depth] === '\\') depth += 1;
        rawKey = rawKey.slice(0, rawKey.length - depth);
        const decoded = unescapeKey(rawKey);
        // A key that cannot be decoded in full (too many rounds) is taken for a secret
        if (!decoded.complete || isSecretTextKey(decoded.key)) {
          let v = k + 1;
          while (v < n && isWhitespaceCode(result.charCodeAt(v))) v += 1;
          const end = scanJsonValue(result, v, quote, depth);
          if (end > v && !jsonValueProtected(result, v, end, quote, depth)) {
            const slashes = '\\'.repeat(depth);
            const marker = `${slashes}${quote}${SECRET_MARKER}${slashes}${quote}`;
            out += result.slice(last, v) + marker;
            last = end;
            prev = result.indexOf(quote, end);
            continue;
          }
        }
      }
      prev = next;
    }
    if (last > 0) result = out + result.slice(last);
  }
  return result;
}

/**
 * A character that ends the NAME of a parameter when the name is read backwards from its `=`:
 * whitespace and other control characters, quotes, angle brackets and the delimiters of a URL or
 * a form (`/ : @ ? # & ; =`). Every other character (the punctuation of a form name, `^ | ~ ! *`,
 * a dash or a symbol of any script, an unusual space) is part of the name, so the name is judged
 * as a whole and not by whatever follows its last unusual character. A comma is part of a name.
 */
function isParameterNameBoundary(c: number): boolean {
  return (
    c <= 32 ||
    c === 127 ||
    c === 34 ||
    c === 39 ||
    c === 96 ||
    c === 47 ||
    c === 58 ||
    c === 64 ||
    c === 63 ||
    c === 35 ||
    c === 38 ||
    c === 59 ||
    c === 61 ||
    c === 60 ||
    c === 62
  );
}

/** Whitespace or a control character: it may sit between a parameter name and its `=`. */
function isParameterNameGap(c: number): boolean {
  return c <= 32 || c === 127;
}

/**
 * White space between a name and its value: spaces, tabs and line breaks of every kind (LF, CR,
 * VT, FF, NEL, U+2028, U+2029) and the other Unicode spaces (no-break, ideographic ...).
 */
function isValueGap(c: number): boolean {
  return (
    (c >= 9 && c <= 13) ||
    c === 32 ||
    c === 0x85 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

/** A character that ends a parameter value: & ; # whitespace, quotes, angle brackets. Not a comma. */
function isParameterDelimiter(c: number): boolean {
  return (
    c === 38 ||
    c === 59 ||
    c === 35 ||
    c === 34 ||
    c === 39 ||
    c === 60 ||
    c === 62 ||
    isWhitespaceCode(c)
  );
}

/**
 * One round of percent-decoding: each run of %XX escapes is decoded as UTF-8; a run that is not
 * valid UTF-8 is decoded byte by byte instead (so what is readable still counts) and `valid` is
 * false. A `%` that starts no escape stays as it is.
 */
function percentDecode(value: string): { decoded: string; valid: boolean } {
  let valid = true;
  const decoded = value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      valid = false;
      return run.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
        String.fromCharCode(parseInt(hex, 16))
      );
    }
  });
  return { decoded, valid };
}

/**
 * Percent-decode a parameter name as often as it takes (a name encoded N times needs N rounds).
 * `complete` is false when the cap on rounds was reached with the name still changing: the caller
 * then treats the parameter as a secret.
 */
function decodeParameterName(value: string): { name: string; complete: boolean } {
  let current = value;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    work(current.length);
    const { decoded, valid } = percentDecode(current);
    // A name with a percent-escape that is not valid UTF-8 (%ED%A0%80, %C0%AF, a lone %FF, a
    // sequence cut short) cannot be judged with certainty: it is decoded byte by byte so that
    // the readable part counts, and the caller takes it for a secret.
    if (!valid) return { name: decoded, complete: false };
    if (decoded === current) return { name: current, complete: true };
    current = decoded;
  }
  return { name: current, complete: false };
}

/**
 * Replace the value of secret parameters in URLs, query strings, fragments and form bodies
 * (`code=...&client_secret=...`): the WHOLE value, up to the next parameter delimiter. A comma is
 * part of a value.
 */
function redactParameters(text: string): string {
  let p = text.indexOf('=');
  if (p < 0) return text;
  const n = text.length;
  let out = '';
  let last = 0;
  while (p !== -1) {
    work();
    // Spaces and control characters between the name and `=` do not end the name (`code =x`,
    // `code\t=x`): the name is read back from the last character that is not one.
    let end = p;
    while (end > last && isParameterNameGap(text.charCodeAt(end - 1))) end -= 1;
    work(p - end);
    let s = end;
    while (s > last && end - s < MAX_KEY_LENGTH && !isParameterNameBoundary(text.charCodeAt(s - 1)))
      s -= 1;
    work(end - s);
    // A name too long to inspect (it goes on to the left): the safe side is a secret.
    const overlong =
      s > last && end - s >= MAX_KEY_LENGTH && !isParameterNameBoundary(text.charCodeAt(s - 1));
    let next = p + 1;
    const decodedName = s < end ? decodeParameterName(text.slice(s, end)) : null;
    if (
      decodedName !== null &&
      (overlong || !decodedName.complete || isSecretTextKey(decodedName.name))
    ) {
      // `code = value`, `code =\nvalue`: white space (line breaks too, of any kind) after the `=`
      // is not the value. An empty value followed by a line break therefore takes the next word
      // for the value: when in doubt the word is hidden. `code=&x=1` and `code=` at the end of
      // the text have nothing to hide and stay.
      let v = p + 1;
      while (v < n && isValueGap(text.charCodeAt(v))) v += 1;
      work(v - p);
      let e = v;
      while (e < n && !isParameterDelimiter(text.charCodeAt(e))) e += 1;
      work(e - p);
      const value = text.slice(v, e);
      if (value !== '' && !isFingerprintOrMarker(value)) {
        out += text.slice(last, v) + SECRET_MARKER;
        last = e;
      }
      next = Math.max(e, p + 1);
    }
    p = text.indexOf('=', next);
  }
  return last === 0 ? text : out + text.slice(last);
}

/**
 * Stored password hashes: the value of a password check, secret under any name and in any text.
 *  - Authrim's own (hashPassword in utils/crypto.ts): `pbkdf2v1$600000$<salt>$<hash>`, version,
 *    iteration count, then salt and hash in base64url. The pattern allows later versions
 *    (pbkdf2v2 ...), any iteration count and any salt and hash length from 16 characters.
 *  - Argon2, bcrypt, scrypt, PBKDF2 (passlib) and the `$id$salt$hash` forms of crypt, which other
 *    systems (imports, migrations) bring.
 * Other things Authrim stores are not found by their shape: a client secret hash, an initial
 * access token hash and a SCIM token hash are plain SHA-256 in hex (hashClientSecret,
 * hashInitialAccessToken), the same shape as any digest, and are protected by their names
 * (client_secret_hash ...). Refresh and access token ids (`rt_<uuid>`, `at_<uuid>`) are
 * identifiers, not secrets.
 */
const PASSWORD_HASH = new RegExp(
  [
    String.raw`(?<![A-Za-z0-9_$])pbkdf2v\d+\$\d{1,9}\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{16,}`,
    String.raw`\$(?:argon2(?:id|i|d)|pbkdf2(?:-[a-z0-9]+)?|scrypt)\$[A-Za-z0-9$=,+/.\-]{8,}`,
    String.raw`\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{20,}`,
    String.raw`\$(?:[156y7]|md5|sha1|sha256|sha512)\$(?:[A-Za-z0-9./,=\-]{1,40}\$){1,2}[./A-Za-z0-9]{8,}`,
  ].join('|'),
  'gi'
);

function redactPasswordHashes(text: string): string {
  return text.indexOf('$') < 0 ? text : text.replace(PASSWORD_HASH, SECRET_MARKER);
}

/**
 * The private members of a JSON Web Key written in text (RFC 7517/7518: `d`, the RSA primes and
 * CRT values, `k` of a symmetric key): a JWK is recognised by its "kty" member, and the value of
 * these members is the key material. Plain quotes only: a JWK stringified again is a limit.
 */
const JWK_PRIVATE_MEMBERS = new Set(['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']);
const JWK_PRIVATE_MEMBER = /(["'])(d|p|q|dp|dq|qi|k)\1(\s*:\s*)(["'])[A-Za-z0-9_-]{8,}\4/g;

function redactJwkPrivateMembers(text: string): string {
  if (text.indexOf('kty') < 0) return text;
  return text.replace(
    JWK_PRIVATE_MEMBER,
    (_match, q1: string, name: string, colon: string, q2: string) =>
      `${q1}${name}${q1}${colon}${q2}${SECRET_MARKER}${q2}`
  );
}

const CREDENTIAL = /\b(Bearer|Basic|DPoP)(\s+)([A-Za-z0-9._~+/=-]+)/gi;

function decodesToUserAndPassword(credential: string): boolean {
  try {
    const base64 = credential.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (base64.length === 0 || base64.length % 4 === 1) return false;
    const decoded = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    if (decoded.indexOf(':') < 0) return false;
    for (let i = 0; i < decoded.length; i += 1) {
      const c = decoded.charCodeAt(i);
      if (c < 9 || (c > 13 && c < 32)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** `Bearer <credential>`, `DPoP <credential>` and `Basic <user:password in base64>` in free text. */
function redactCredentials(text: string): string {
  if (!/bearer|basic|dpop/i.test(text)) return text;
  work(text.length);
  return text.replace(CREDENTIAL, (match, scheme: string, space: string, credential: string) => {
    const kind = scheme.toLowerCase();
    const looksLikeCredential = /[0-9._~+/=-]/.test(credential);
    if (kind === 'basic') {
      if (
        !decodesToUserAndPassword(credential) &&
        !(credential.length >= 8 && looksLikeCredential)
      ) {
        return match;
      }
    } else if (!looksLikeCredential) {
      return match;
    }
    return `${scheme}${space}[TOKEN_REDACTED]`;
  });
}

/**
 * Replace the secrets in a text: compact JWTs, secret members of JSON text, the values of secret
 * parameters in URLs and form bodies, and `Bearer`/`DPoP`/`Basic` credentials. Everything else is
 * left as it is. Linear in the length of the text.
 */
export function redactSecretsInText(text: string): string {
  return capLength(redactSecretsCore(text));
}

/** The secrets pass without the length cap (callers cap the result, see capLength). */
function redactSecretsCore(text: string): string {
  // Known limit: a pair written as `name: value` in free text (YAML, a log line) is not scanned.
  // The colon is too common in prose (`Invalid token: expired`, `password: required`) to tell a
  // value from an explanation, and every exception for explanations would be a hole. Pairs with
  // `=`, JSON members and object keys, URL parameters and credentials are protected.
  if (text.length === 0) return text;
  work(text.length);
  return redactCredentials(
    redactParameters(
      redactJsonSecrets(redactJwkPrivateMembers(redactPasswordHashes(redactCompactJwts(text))))
    )
  );
}

// ---------------------------------------------------------------------------------------------
// Personal data in text, found on a normalised view and redacted in the original
// ---------------------------------------------------------------------------------------------

interface ScanView {
  norm: string;
  /** For each unit of `norm`, where its character begins and ends in the original (null: same). */
  starts: number[] | null;
  ends: number[] | null;
}

/**
 * The text as the detectors see it: NFKC-normalised per character (full-width digits, hyphens
 * and `@` become ASCII; the ideographic full stop becomes a dot), with a map back to the original.
 */
function scanView(text: string): ScanView {
  work(text.length);
  let ascii = true;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (ascii) return { norm: text, starts: null, ends: null };
  const starts: number[] = [];
  const ends: number[] = [];
  let norm = '';
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) ?? 0;
    const length = cp > 0xffff ? 2 : 1;
    let piece = text.slice(i, i + length);
    piece = cp === 0x3002 ? '.' : piece.normalize('NFKC');
    for (let k = 0; k < piece.length; k += 1) {
      starts.push(i);
      ends.push(i + length);
    }
    norm += piece;
    i += length;
  }
  return { norm, starts, ends };
}

interface Range {
  start: number;
  end: number;
  marker: string;
}

function isDigitCode(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isAsciiLetterCode(c: number): boolean {
  const lower = c | 32;
  return lower >= 97 && lower <= 122;
}

const UNICODE_WORD = /[\p{L}\p{N}\p{M}]/u;

function isWordLikeCode(c: number, text: string, index: number): boolean {
  if (c < 128) return isDigitCode(c) || isAsciiLetterCode(c);
  if (c >= 0xd800 && c <= 0xdfff) {
    // half of a surrogate pair: judge the whole character
    const start = c >= 0xdc00 ? index - 1 : index;
    const cp = start >= 0 ? text.codePointAt(start) : undefined;
    return cp !== undefined && UNICODE_WORD.test(String.fromCodePoint(cp));
  }
  return UNICODE_WORD.test(text[index]);
}

/** Email addresses: Unicode local part and (internationalised) domain, found around each `@`. */
function findEmails(norm: string, covered: Uint8Array, ranges: Range[]): void {
  const n = norm.length;
  let lastEnd = 0;
  for (let p = norm.indexOf('@'); p !== -1; p = norm.indexOf('@', p + 1)) {
    work();
    if (p < lastEnd) continue;
    let l = p;
    while (l > lastEnd) {
      const c = norm.charCodeAt(l - 1);
      work();
      if (
        isWordLikeCode(c, norm, l - 1) ||
        c === 46 ||
        c === 95 ||
        c === 37 ||
        c === 43 ||
        c === 45
      ) {
        l -= 1;
      } else {
        break;
      }
    }
    let r = p + 1;
    while (r < n) {
      const c = norm.charCodeAt(r);
      work();
      if (isWordLikeCode(c, norm, r) || c === 46 || c === 45) r += 1;
      else break;
    }
    while (r > p + 1 && (norm.charCodeAt(r - 1) === 46 || norm.charCodeAt(r - 1) === 45)) r -= 1;
    if (l === p || r === p + 1) continue;
    const domain = norm.slice(p + 1, r);
    const lastDot = domain.lastIndexOf('.');
    if (lastDot <= 0 || domain.indexOf('..') >= 0) continue;
    const tld = domain.slice(lastDot + 1);
    if (tld.length < 2 || !/^\p{L}+$/u.test(tld)) continue;
    ranges.push({ start: l, end: r, marker: '[EMAIL_REDACTED]' });
    for (let k = l; k < r; k += 1) covered[k] = 1;
    lastEnd = r;
  }
}

function isPhoneSeparatorCode(c: number): boolean {
  // space, tab, CR, LF, hyphen, dot, parentheses
  return (
    c === 32 || c === 9 || c === 13 || c === 10 || c === 45 || c === 46 || c === 40 || c === 41
  );
}

function isWhitespaceSeparatorCode(c: number): boolean {
  return c === 32 || c === 9 || c === 13 || c === 10;
}

interface DigitGroup {
  start: number;
  end: number;
  /** The separator before this group holds whitespace: a possible gap between two numbers. */
  breaksBefore: boolean;
}

function isGluedCode(norm: string, index: number): boolean {
  const c = norm.charCodeAt(index);
  return isAsciiLetterCode(c) || c === 95 || isDigitCode(c);
}

function acceptPhoneNumber(norm: string, start: number, end: number): boolean {
  const text = norm.slice(start, end);
  const digits = text.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return false;
  const hasPlus = text.startsWith('+');
  const hasSeparator = /[ ().\t\r\n-]/.test(text);
  if (!hasPlus && !hasSeparator && digits.length !== 10 && digits.length !== 11) return false;
  if (
    text.indexOf('.') >= 0 &&
    !/[ ()\t\r\n-]/.test(text) &&
    !/^\+?\d{3}\.\d{3}\.\d{4}$/.test(text)
  ) {
    return false;
  }
  return true;
}

/**
 * Phone numbers: an international prefix, parentheses, spaces, hyphens, dots and line breaks
 * between groups of digits, 9 to 15 digits per number. A run of digit groups that holds several
 * numbers (`2025550199 2025550188`) is split at whitespace into numbers of 9 to 15 digits each.
 * Not numbers: IPv4 addresses, dates, a run of digits without separators that is not 10 or 11
 * digits long, anything glued to letters, underscores or hyphens (UUIDs, ids).
 */
function findPhones(norm: string, covered: Uint8Array, ranges: Range[]): void {
  const n = norm.length;
  let i = 0;
  while (i < n) {
    work();
    const c = norm.charCodeAt(i);
    if (!(isDigitCode(c) || c === 43 || c === 40)) {
      i += 1;
      continue;
    }
    if (i > 0) {
      const before = norm.charCodeAt(i - 1);
      if (isAsciiLetterCode(before) || isDigitCode(before) || before === 95 || before === 45) {
        i += 1;
        continue;
      }
    }
    let j = i;
    if (norm.charCodeAt(j) === 43) j += 1;
    if (norm.charCodeAt(j) === 40) j += 1;
    if (!isDigitCode(norm.charCodeAt(j))) {
      i += 1;
      continue;
    }
    const groups: DigitGroup[] = [];
    let breaksBefore = false;
    for (;;) {
      const start = j;
      while (j < n && isDigitCode(norm.charCodeAt(j))) j += 1;
      work(j - start);
      groups.push({ start, end: j, breaksBefore });
      let k = j;
      let separators = 0;
      let whitespace = false;
      while (k < n && separators <= 3 && isPhoneSeparatorCode(norm.charCodeAt(k))) {
        if (isWhitespaceSeparatorCode(norm.charCodeAt(k))) whitespace = true;
        k += 1;
        separators += 1;
      }
      if (separators >= 1 && separators <= 3 && k < n && isDigitCode(norm.charCodeAt(k))) {
        breaksBefore = whitespace;
        j = k;
        continue;
      }
      break;
    }
    const spanEnd = groups[groups.length - 1].end;
    const glued =
      spanEnd < n &&
      (isGluedCode(norm, spanEnd) ||
        (norm.charCodeAt(spanEnd) === 45 &&
          spanEnd + 1 < n &&
          (isGluedCode(norm, spanEnd + 1) || norm.charCodeAt(spanEnd + 1) === 45)));
    if (!glued) {
      // words: groups joined without whitespace; numbers: words gathered up to 9..15 digits
      let numberStart = i;
      let digits = 0;
      let numberEnd = -1;
      const flush = () => {
        if (numberEnd > numberStart && digits >= 9) {
          let free = true;
          for (let k = numberStart; k < numberEnd; k += 1) {
            if (covered[k]) {
              free = false;
              break;
            }
          }
          if (free && acceptPhoneNumber(norm, numberStart, numberEnd)) {
            ranges.push({ start: numberStart, end: numberEnd, marker: '[PHONE_REDACTED]' });
            for (let k = numberStart; k < numberEnd; k += 1) covered[k] = 1;
          }
        }
        digits = 0;
        numberEnd = -1;
      };
      for (let g = 0; g < groups.length; ) {
        let w = g + 1;
        let wordDigits = groups[g].end - groups[g].start;
        while (w < groups.length && !groups[w].breaksBefore) {
          wordDigits += groups[w].end - groups[w].start;
          w += 1;
        }
        const wordStart = groups[g].start;
        const wordEnd = groups[w - 1].end;
        if (digits > 0 && digits + wordDigits > 15) flush();
        if (digits === 0) numberStart = g === 0 ? i : wordStart;
        digits += wordDigits;
        numberEnd = wordEnd;
        if (digits >= 9) flush();
        g = w;
      }
      flush();
    }
    i = Math.max(spanEnd, i + 1);
  }
}

const CARD_PATTERNS = [/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, /\b3[47]\d{2}[-\s]?\d{6}[-\s]?\d{5}\b/g];
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

function findPatterns(
  norm: string,
  pattern: RegExp,
  marker: string,
  covered: Uint8Array,
  ranges: Range[]
): void {
  work(norm.length);
  pattern.lastIndex = 0;
  for (let match = pattern.exec(norm); match !== null; match = pattern.exec(norm)) {
    const start = match.index;
    const end = start + match[0].length;
    let free = true;
    for (let k = start; k < end; k += 1) {
      if (covered[k]) {
        free = false;
        break;
      }
    }
    if (free) {
      ranges.push({ start, end, marker });
      for (let k = start; k < end; k += 1) covered[k] = 1;
    }
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
}

function applyRanges(text: string, view: ScanView, ranges: Range[]): string {
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a.start - b.start);
  let out = '';
  let last = 0;
  for (const range of ranges) {
    const start = view.starts ? view.starts[range.start] : range.start;
    const end = view.ends ? view.ends[range.end - 1] : range.end;
    if (start < last) {
      if (end <= last) continue;
      out += range.marker;
      last = end;
      continue;
    }
    out += text.slice(last, start) + range.marker;
    last = end;
  }
  return out + text.slice(last);
}

export interface PiiTextOptions {
  emails?: boolean;
  cards?: boolean;
  phones?: boolean;
}

function redactPii(text: string, options: PiiTextOptions): string {
  if (text.length === 0) return text;
  const view = scanView(text);
  const covered = new Uint8Array(view.norm.length);
  const ranges: Range[] = [];
  if (options.emails !== false) findEmails(view.norm, covered, ranges);
  if (options.cards !== false) {
    for (const pattern of CARD_PATTERNS) {
      findPatterns(view.norm, pattern, '[CC_REDACTED]', covered, ranges);
    }
    findPatterns(view.norm, SSN_PATTERN, '[SSN_REDACTED]', covered, ranges);
  }
  if (options.phones !== false) findPhones(view.norm, covered, ranges);
  return applyRanges(text, view, ranges);
}

/** Replace emails, card numbers, social security numbers and phone numbers in a text. */
export function redactPiiText(text: string): string {
  return capLength(redactPii(text, {}));
}

/** Replace email addresses only. */
export function redactEmails(text: string): string {
  return capLength(redactPii(text, { cards: false, phones: false }));
}

/** Replace phone numbers only (see findPhones for what counts). */
export function redactPhoneNumbers(text: string): string {
  return capLength(redactPii(text, { emails: false, cards: false }));
}

/** Whether a text holds an email, card, social security or phone number. */
export function containsPiiText(text: string): boolean {
  return redactPii(text, {}) !== text;
}

// ---------------------------------------------------------------------------------------------
// IP addresses
// ---------------------------------------------------------------------------------------------

function parseIpv4(value: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
  const octets = value.split('.').map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function parseIpv6(value: string): number[] | null {
  let text = value;
  if (text.includes('.')) {
    const split = text.lastIndexOf(':');
    const embedded = parseIpv4(text.slice(split + 1));
    if (split < 0 || !embedded) return null;
    const high = ((embedded[0] << 8) | embedded[1]).toString(16);
    const low = ((embedded[2] << 8) | embedded[3]).toString(16);
    text = `${text.slice(0, split + 1)}${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  if (head.length + tail.length > 7) return null;
  return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/** Mask an address, or, for anything that does not mask to a network (not an address), a marker. */
export function maskIpOrMarker(ip: string): string {
  const masked = maskIpAddress(ip);
  return masked === IP_MARKER || MASKED_IPV4_FORM.test(masked) || MASKED_IPV6_FORM.test(masked)
    ? masked
    : IP_MARKER;
}

/**
 * Mask an IP address to its network: IPv4 to /24 (`203.0.113.0/24`), IPv6 to /48 (`2001:db8:abcd::/48`,
 * every `::` compression, embedded IPv4 and zone id expanded first), an IPv4-mapped IPv6 address
 * as the IPv4 it carries. An address that cannot be parsed becomes a marker, never itself. A
 * string that is not an address at all is returned as it is.
 */
export function maskIpAddress(ip: string): string {
  let value = ip.trim();
  if (MASKED_IPV4_FORM.test(value) || MASKED_IPV6_FORM.test(value)) return value;
  // A network written with its prefix length (203.0.113.42/32) is masked like the address.
  const slash = value.lastIndexOf('/');
  if (slash > 0 && /^\d{1,3}$/.test(value.slice(slash + 1))) value = value.slice(0, slash);
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return IP_MARKER;
    value = value.slice(1, end);
  }
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);

  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(value);
  if (withPort) value = withPort[1];

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    const octets = parseIpv4(value);
    return octets ? `${octets[0]}.${octets[1]}.${octets[2]}.0/24` : IP_MARKER;
  }
  if (value.includes(':')) {
    const groups = parseIpv6(value);
    if (!groups) return IP_MARKER;
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
      return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.0/24`;
    }
    return `${groups[0].toString(16)}:${groups[1].toString(16)}:${groups[2].toString(16)}::/48`;
  }
  return ip;
}

// ---------------------------------------------------------------------------------------------
// The universal pass
// ---------------------------------------------------------------------------------------------

/** Identifiers an entry carries: bounded, a safe charset, else replaced by a fingerprint. */
const IDENTIFIER_FIELDS = new Set([
  'id',
  'diagnosticSessionId',
  'flowId',
  'requestId',
  'anonymizedUserId',
]);
const IDENTIFIER_FORM = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN_HASH_FORM = /^(?:sha256:)?[0-9a-f]{8,64}$/;
/** Fields that name a kind of event. */
const LABEL_FIELDS = new Set(['category', 'level', 'storageMode', 'source', 'result', 'decision']);
const LABEL_FORM = /^[A-Za-z0-9_:-]{1,64}$/;
const METHOD_FORM = /^[A-Za-z]{1,16}$/;
const NUMBER_FIELDS = new Set(['timestamp', 'status', 'durationMs']);
/** Strings of an entry that are free text: secrets are taken out, and emails when asked. */
const FREE_TEXT_FIELDS = new Set([
  'path',
  'clientId',
  'tenantId',
  'step',
  'tokenType',
  'grantType',
  'flow',
]);
/** Entry fields that hold OAuth parameters (a known field name; `code` is a secret anywhere). */
const PARAMETER_FIELDS = new Set(['query', 'bodySummary', 'details', 'context']);

/** Other field names an entry carries; any other name is checked like an object key. */
const ENTRY_FIELDS = new Set([
  'tokenHash',
  'method',
  'headers',
  'remoteAddress',
  'errorMessage',
  'reason',
  'metadata',
  'expected',
  'actual',
  'tokenType',
  'flow',
  'grantType',
  'bodySummary',
  'anonymizedUserId',
]);

/** The longest run of letters and digits in a value (a token or key, rather than a word or an id). */
function longestAlphanumericRun(value: string): number {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    work();
    if (isDigitCode(c) || isAsciiLetterCode(c)) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

/**
 * Whether a client-supplied value is a plain identifier, safe to store and export as it is: a
 * bounded safe charset (dots, dates and versions are fine: `run-2026.10.16-001`), no unbroken run
 * of 40 or more letters and digits (a token or key rather than an id), and no secret in it (a
 * compact JWT is recognised by decoding it, not by its dots).
 */
export function isSafeIdentifier(value: string): boolean {
  // The canonical fingerprint is what this code stores for an id that is not plain: it is an id
  // (whatever its length, 8 to 64 hex), not a token to hash again.
  if (FINGERPRINT_FORM.test(value)) return true;
  return (
    IDENTIFIER_FORM.test(value) &&
    longestAlphanumericRun(value) < 40 &&
    redactSecretsInText(value) === value
  );
}

/** A label (a level, a result, a storage mode ...): a short word, nothing token-shaped. */
function isPlainLabel(value: string): boolean {
  return (
    LABEL_FORM.test(value) &&
    longestAlphanumericRun(value) < 24 &&
    redactSecretsInText(value) === value
  );
}

/** The value if it is a plain identifier, else a fingerprint of it (or a marker for a non-string). */
export async function identifierOrFingerprint(value: unknown, prefixLength = 12): Promise<string> {
  if (typeof value !== 'string') return INVALID_MARKER;
  if (value.length <= 128 && isSafeIdentifier(value)) return value;
  return value.length > MAX_TEXT_LENGTH ? INVALID_MARKER : fingerprint(value, prefixLength);
}

export interface UniversalProtectionOptions {
  /** How many characters of a fingerprint to keep (8 to 64, default 12). */
  hashPrefixLength?: number;
  /**
   * Also take personal data (emails, phone numbers, card numbers) out of the free-text fields of
   * an entry (path, clientId, ...) and of its object keys.
   */
  redactPersonalDataInFreeText?: boolean;
  /** Same as redactPersonalDataInFreeText (older name; emails and phone numbers are covered). */
  redactEmailsInFreeText?: boolean;
  /**
   * Replace object keys that hold a secret or personal data (default true). A pass that runs
   * before the privacy mode turns it off: the mode classifies values by their ORIGINAL keys
   * (a key too long to keep would otherwise lose its meaning), and the pass after it replaces
   * the keys.
   */
  protectKeys?: boolean;
}

interface WalkContext {
  hashPrefixLength: number;
  redactPii: boolean;
  protectKeys: boolean;
  budget: RedactionBudget;
}

async function protectIdentifier(
  field: string,
  value: unknown,
  context: WalkContext
): Promise<unknown> {
  if (value === undefined || value === null) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return INVALID_MARKER;
  if (isFingerprintOrMarker(value)) return value;
  if (field === 'tokenHash') {
    return TOKEN_HASH_FORM.test(value)
      ? value
      : fingerprintWithin(value, context.hashPrefixLength, context.budget);
  }
  return value.length <= 128 && isSafeIdentifier(value)
    ? value
    : fingerprintWithin(value, context.hashPrefixLength, context.budget);
}

const KEYS_MARKER = '[KEYS_REDACTED]';
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * An object key that holds a secret or personal data is replaced by a fingerprint. Null: the key
 * cannot be fingerprinted (the entry's fingerprint budget is spent, or the key is too long), and
 * the caller collapses it into one aggregate key.
 */
async function protectKey(key: string, context: WalkContext): Promise<string | null> {
  work();
  if (key.length === 0 || isProtectedForm(key)) return key;
  // A plain word (letters, digits, underscores, starting with a letter) holds no email, phone,
  // JWT, parameter or credential: the common key needs no scan.
  if (key.length <= 64 && PLAIN_KEY.test(key)) return key;
  let needsFingerprint: boolean;
  if (key.length > MAX_KEY_LENGTH) {
    needsFingerprint = true;
  } else {
    work(key.length);
    needsFingerprint =
      redactSecretsCore(key) !== key || (context.redactPii && redactPii(key, {}) !== key);
  }
  if (!needsFingerprint) return key;
  if (context.budget.fingerprints <= 0 || key.length > MAX_TEXT_LENGTH) return null;
  return fingerprintWithin(key, context.hashPrefixLength, context.budget);
}

/** Hands out object keys without collision: the next free suffix of a key is remembered. */
export class KeyAllocator {
  private readonly used = new Set<string>();
  private readonly next = new Map<string, number>();

  take(key: string): string {
    work();
    if (!this.used.has(key)) {
      this.used.add(key);
      return key;
    }
    let n = this.next.get(key) ?? 2;
    let candidate = `${key}~${n}`;
    while (this.used.has(candidate)) {
      work();
      n += 1;
      candidate = `${key}~${n}`;
    }
    this.next.set(key, n + 1);
    this.used.add(candidate);
    return candidate;
  }
}

async function protectValue(
  value: unknown,
  key: string,
  context: WalkContext,
  depth: number
): Promise<unknown> {
  if (value === null || value === undefined) return value;
  const secretKind = secretNameKind(key);

  if (secretKind !== null) {
    if (typeof value === 'string') {
      // An empty string holds nothing to hide (and must not turn into something that is there)
      return value === '' || isFingerprintOrMarker(value)
        ? value
        : fingerprintWithin(value, context.hashPrefixLength, context.budget);
    }
    if (typeof value === 'boolean') return value;
    // A number is a secret too (an OTP, a PIN: code: 321), except under a plural name, where it
    // is a count (total_tokens: 120). Nothing keeps a number under `code`: a status goes by
    // another name (status, statusCode, http_status ...).
    if (typeof value === 'number' && secretKind === 'plural') return value;
    return SECRET_MARKER;
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_REDACTION_DEPTH) return TRUNCATED_MARKER;
    const items: unknown[] = [];
    for (const item of value) {
      work();
      items.push(await protectValue(item, key, context, depth + 1));
    }
    return items;
  }
  if (typeof value === 'object') {
    if (depth >= MAX_REDACTION_DEPTH) return TRUNCATED_MARKER;
    const result: Record<string, unknown> = {};
    const keys = new KeyAllocator();
    let collapsed = 0;
    const isJwk = typeof (value as Record<string, unknown>).kty === 'string';
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      const protectedKey = context.protectKeys ? await protectKey(childKey, context) : childKey;
      if (protectedKey === null) {
        collapsed += 1;
        continue;
      }
      setOwn(
        result,
        keys.take(protectedKey),
        await protectValue(
          childValue,
          // the private members of a JWK are key material (RFC 7518 sections 6.2.2, 6.3.2, 6.4)
          isJwk && JWK_PRIVATE_MEMBERS.has(childKey) ? 'privateKey' : childKey,
          context,
          depth + 1
        )
      );
    }
    if (collapsed > 0) setOwn(result, keys.take(KEYS_MARKER), collapsed);
    return result;
  }
  if (typeof value === 'string') {
    return withinBudget(value, context.budget, redactSecretsCore);
  }
  return value;
}

/**
 * The protection every entry gets in every storage mode, before it is stored or exported:
 * secrets by key (any nesting, any key spelling, any value type), in object keys and in text,
 * validated identifiers and labels, and a work budget past which the rest becomes a marker.
 * Cycles, Maps, `toJSON` and throwing getters are handled (see safeSnapshot). Idempotent.
 * Returns a copy.
 */
export async function protectDiagnosticEntry<T extends object>(
  entry: T,
  options: UniversalProtectionOptions = {}
): Promise<T> {
  const budget = newRedactionBudget();
  const source = safeSnapshot(entry, budget) as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const keys = new KeyAllocator();
  let collapsed = 0;
  const base: WalkContext = {
    hashPrefixLength: options.hashPrefixLength ?? 12,
    redactPii: Boolean(options.redactPersonalDataInFreeText ?? options.redactEmailsInFreeText),
    protectKeys: options.protectKeys !== false,
    budget,
  };

  for (const [field, value] of Object.entries(source)) {
    let protectedValue: unknown;
    if (IDENTIFIER_FIELDS.has(field) || field === 'tokenHash') {
      protectedValue = await protectIdentifier(field, value, base);
    } else if (LABEL_FIELDS.has(field)) {
      protectedValue =
        typeof value === 'string' && isPlainLabel(value)
          ? value
          : value === undefined || value === null
            ? value
            : INVALID_MARKER;
    } else if (field === 'method') {
      protectedValue =
        typeof value === 'string' && METHOD_FORM.test(value)
          ? value
          : value === undefined || value === null
            ? value
            : INVALID_MARKER;
    } else if (NUMBER_FIELDS.has(field)) {
      if (typeof value === 'number' && Number.isFinite(value)) protectedValue = value;
      else if (field === 'timestamp') protectedValue = 0;
      else continue;
    } else {
      protectedValue = await protectValue(value, field, base, 0);
      if (base.redactPii && FREE_TEXT_FIELDS.has(field) && typeof protectedValue === 'string') {
        protectedValue = redactEmails(protectedValue);
      }
    }
    const isKnown =
      IDENTIFIER_FIELDS.has(field) ||
      LABEL_FIELDS.has(field) ||
      NUMBER_FIELDS.has(field) ||
      FREE_TEXT_FIELDS.has(field) ||
      PARAMETER_FIELDS.has(field) ||
      ENTRY_FIELDS.has(field);
    const protectedField = isKnown || !base.protectKeys ? field : await protectKey(field, base);
    if (protectedField === null) {
      collapsed += 1;
      continue;
    }
    setOwn(result, keys.take(protectedField), protectedValue);
  }
  if (collapsed > 0) setOwn(result, keys.take(KEYS_MARKER), collapsed);
  return result as T;
}
