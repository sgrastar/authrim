/**
 * Unbiased random characters.
 *
 * `byte % charset.length` favours the first `256 % charset.length` characters, because 256 is not
 * a multiple of the alphabet size. Rejection sampling drops the bytes above the largest multiple
 * of the alphabet size, so every character is equally likely.
 */

/** Returns `length` random bytes. */
export type RandomBytesSource = (length: number) => Uint8Array;

const cryptoRandomBytes: RandomBytesSource = (length) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

/** Rounds of fresh bytes after which a source that only yields rejected values is given up. */
const MAX_ROUNDS = 1000;

/**
 * Pick `length` characters of `charset` uniformly at random.
 *
 * @param charset - Alphabet of 1 to 256 distinct characters
 * @param length - Number of characters to produce
 * @param source - Byte source (defaults to the Web Crypto generator); replaceable in tests
 */
export function randomCharacters(
  charset: string,
  length: number,
  source: RandomBytesSource = cryptoRandomBytes
): string {
  if (charset.length < 1 || charset.length > 256) {
    throw new RangeError('charset must hold between 1 and 256 characters');
  }
  // The bytes below this limit map evenly onto the alphabet.
  const limit = 256 - (256 % charset.length);
  let result = '';
  for (let round = 0; result.length < length; round++) {
    if (round >= MAX_ROUNDS) {
      throw new Error('Random byte source did not yield usable values');
    }
    for (const byte of source(length - result.length)) {
      if (byte < limit) {
        result += charset[byte % charset.length];
        if (result.length === length) break;
      }
    }
  }
  return result;
}
