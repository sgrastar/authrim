/** Test-only DER and CBOR encoders for building Apple-shaped fixtures. Not shipped. */

export type B = Uint8Array;

export const cat = (...parts: B[]): B => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export const enc = (text: string): B => new TextEncoder().encode(text);

function lengthBytes(n: number): B {
  if (n < 0x80) return Uint8Array.of(n);
  if (n < 0x100) return Uint8Array.of(0x81, n);
  return Uint8Array.of(0x82, n >> 8, n & 0xff);
}

export const tlv = (tag: number, ...body: B[]): B => {
  const content = cat(...body);
  return cat(Uint8Array.of(tag), lengthBytes(content.length), content);
};
export const seq = (...b: B[]): B => tlv(0x30, ...b);
export const octet = (b: B): B => tlv(0x04, b);
export const bits = (b: B, unused = 0): B => tlv(0x03, Uint8Array.of(unused), b);
export const int = (n: number): B => tlv(0x02, Uint8Array.of(n));
export const bool = (v: boolean): B => tlv(0x01, Uint8Array.of(v ? 0xff : 0));

export function oid(dotted: string): B {
  const arcs = dotted.split('.').map(Number);
  const out: number[] = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const stack = [arc & 0x7f];
    let rest = arc >> 7;
    while (rest > 0) {
      stack.unshift((rest & 0x7f) | 0x80);
      rest >>= 7;
    }
    out.push(...stack);
  }
  return tlv(0x06, Uint8Array.from(out));
}

export function utcTime(seconds: number): B {
  const d = new Date(seconds * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  if (d.getUTCFullYear() >= 2050) {
    return tlv(
      0x18,
      enc(
        `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
      )
    );
  }
  return tlv(
    0x17,
    enc(
      `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
    )
  );
}

export function derEcdsa(raw: B): B {
  const half = raw.length / 2;
  const part = (v: B): B => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i += 1;
    let t: B = v.slice(i);
    if (t[0] & 0x80) t = cat(Uint8Array.of(0), t);
    return tlv(0x02, t);
  };
  return seq(part(raw.slice(0, half)), part(raw.slice(half)));
}

// --- CBOR encoder (definite lengths only) ---
export type CV = number | B | string | CV[] | Map<string | number, CV>;
function head(major: number, n: number): B {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 0x100) return Uint8Array.of((major << 5) | 24, n);
  if (n < 0x10000) return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff);
  return Uint8Array.of(
    (major << 5) | 26,
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff
  );
}
export function cbor(v: CV): B {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return cat(head(3, enc(v).length), enc(v));
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  if (Array.isArray(v)) return cat(head(4, v.length), ...v.map(cbor));
  return cat(head(5, v.size), ...[...v].flatMap(([k, val]) => [cbor(k), cbor(val)]));
}
