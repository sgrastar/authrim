/**
 * Strict CBOR reader for App Attest objects (RFC 8949 subset).
 *
 * Accepted: unsigned and negative integers, byte strings, text strings, arrays, maps with integer
 * or text
 * keys. Refused: indefinite lengths, tags, floats and simple values, duplicate map keys, nesting
 * deeper
 * than `MAX_DEPTH`, more than `MAX_ITEMS` items in total, lengths that run past the input. The
 * reader
 * never allocates by a declared length before checking it against the remaining input.
 */

import type { Bytes } from './bytes';

export type CborKey = string | number;
export type CborValue = number | Bytes | string | CborValue[] | Map<CborKey, CborValue>;

export class CborError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'CborError';
  }
}

const MAX_DEPTH = 8;
const MAX_ITEMS = 256;

interface State {
  bytes: Bytes;
  offset: number;
  items: number;
}

function readLength(state: State, additional: number): number {
  if (additional < 24) return additional;
  const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : 0;
  // 27 (8-byte lengths) and 28-31 (including indefinite) are not accepted.
  if (width === 0) throw new CborError('cbor_unsupported_length');
  if (state.offset + width > state.bytes.length) throw new CborError('cbor_truncated');
  let value = 0;
  for (let index = 0; index < width; index += 1)
    value = value * 256 + state.bytes[state.offset + index];
  state.offset += width;
  return value;
}

function readItem(state: State, depth: number): CborValue {
  if (depth > MAX_DEPTH) throw new CborError('cbor_too_deep');
  state.items += 1;
  if (state.items > MAX_ITEMS) throw new CborError('cbor_too_many_items');
  if (state.offset >= state.bytes.length) throw new CborError('cbor_truncated');
  const initial = state.bytes[state.offset];
  state.offset += 1;
  const major = initial >> 5;
  const additional = initial & 0x1f;
  switch (major) {
    case 0:
      return readLength(state, additional);
    case 1:
      return -1 - readLength(state, additional);
    case 2:
    case 3: {
      const length = readLength(state, additional);
      if (state.offset + length > state.bytes.length) throw new CborError('cbor_truncated');
      const slice = state.bytes.slice(state.offset, state.offset + length);
      state.offset += length;
      if (major === 2) return slice;
      try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(slice);
      } catch {
        throw new CborError('cbor_invalid_utf8');
      }
    }
    case 4: {
      const length = readLength(state, additional);
      if (length > state.bytes.length - state.offset) throw new CborError('cbor_truncated');
      const items: CborValue[] = [];
      for (let index = 0; index < length; index += 1) items.push(readItem(state, depth + 1));
      return items;
    }
    case 5: {
      const length = readLength(state, additional);
      if (length > state.bytes.length - state.offset) throw new CborError('cbor_truncated');
      const map = new Map<CborKey, CborValue>();
      for (let index = 0; index < length; index += 1) {
        const key = readItem(state, depth + 1);
        if (typeof key !== 'string' && typeof key !== 'number') throw new CborError('cbor_bad_key');
        if (map.has(key)) throw new CborError('cbor_duplicate_key');
        map.set(key, readItem(state, depth + 1));
      }
      return map;
    }
    default:
      throw new CborError('cbor_unsupported_type'); // tags (6), floats and simple values (7)
  }
}

/**
 * Decodes the first item; `length` tells how many bytes it used (App Attest concatenates items).
 */
export function decodeCborPrefix(bytes: Bytes): { value: CborValue; length: number } {
  const state: State = { bytes, offset: 0, items: 0 };
  const value = readItem(state, 0);
  return { value, length: state.offset };
}

/** Decodes exactly one item; trailing bytes are an error. */
export function decodeCbor(bytes: Bytes): CborValue {
  const { value, length } = decodeCborPrefix(bytes);
  if (length !== bytes.length) throw new CborError('cbor_trailing_bytes');
  return value;
}
