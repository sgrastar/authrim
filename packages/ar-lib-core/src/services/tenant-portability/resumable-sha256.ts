const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const W = new Uint32Array(64);
// Keeps the bit length (length * 8) an exact double; 1 PiB is far above any backup container.
const MAX_BYTES = 2 ** 50;
// 8 words, a 53-bit byte length and up to 63 pending bytes, all lowercase hex.
const STATE = /^([a-f0-9]{64})\.(0|[1-9][0-9]{0,15})\.((?:[a-f0-9]{2}){0,63})$/;

function invalid(): never {
  throw new Error('invalid_resumable_sha256_state');
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function compress(h: Uint32Array, data: Uint8Array, start: number, end: number): void {
  for (let offset = start; offset + 64 <= end; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      W[i] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15];
      const y = W[i - 2];
      W[i] =
        (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) +
        W[i - 7] +
        (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) +
        W[i - 16];
    }
    let a = h[0],
      b = h[1],
      c = h[2],
      d = h[3],
      e = h[4],
      f = h[5],
      g = h[6],
      k = h[7];
    for (let i = 0; i < 64; i++) {
      const t1 =
        (k +
          (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) +
          ((e & f) ^ (~e & g)) +
          K[i] +
          W[i]) |
        0;
      const t2 =
        ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) +
          ((a & b) ^ (a & c) ^ (b & c))) |
        0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += k;
  }
}

/**
 * SHA-256 whose midstate can be saved in an operation checkpoint and resumed by another
 * invocation. WebCrypto and DigestStream cannot export a midstate. About 8x slower than native.
 */
export class ResumableSha256 {
  private readonly pending = new Uint8Array(64);
  private constructor(
    private readonly h: Uint32Array,
    private length: number,
    private pendingBytes: number
  ) {}

  static create(): ResumableSha256 {
    return new ResumableSha256(Uint32Array.from(INITIAL), 0, 0);
  }

  static restore(state: string): ResumableSha256 {
    const match = typeof state === 'string' ? STATE.exec(state) : null;
    if (!match) invalid();
    const length = Number(match[2]);
    const pending = match[3].length / 2;
    if (!Number.isSafeInteger(length) || length > MAX_BYTES || length % 64 !== pending) invalid();
    const h = new Uint32Array(8);
    for (let i = 0; i < 8; i++) h[i] = parseInt(match[1].slice(i * 8, i * 8 + 8), 16);
    const value = new ResumableSha256(h, length, pending);
    for (let i = 0; i < pending; i++)
      value.pending[i] = parseInt(match[3].slice(i * 2, i * 2 + 2), 16);
    return value;
  }

  get byteLength(): number {
    return this.length;
  }

  update(bytes: Uint8Array): this {
    if (!(bytes instanceof Uint8Array)) invalid();
    const length = this.length + bytes.length;
    if (length > MAX_BYTES) invalid();
    let offset = 0;
    if (this.pendingBytes) {
      const take = Math.min(64 - this.pendingBytes, bytes.length);
      this.pending.set(bytes.subarray(0, take), this.pendingBytes);
      this.pendingBytes += take;
      offset = take;
      if (this.pendingBytes < 64) {
        this.length = length;
        return this;
      }
      compress(this.h, this.pending, 0, 64);
      this.pendingBytes = 0;
    }
    const whole = offset + Math.floor((bytes.length - offset) / 64) * 64;
    compress(this.h, bytes, offset, whole);
    this.pending.set(bytes.subarray(whole), 0);
    this.pendingBytes = bytes.length - whole;
    this.length = length;
    return this;
  }

  save(): string {
    const words = new Uint8Array(32);
    const view = new DataView(words.buffer);
    for (let i = 0; i < 8; i++) view.setUint32(i * 4, this.h[i]);
    return `${hex(words)}.${this.length}.${hex(this.pending.subarray(0, this.pendingBytes))}`;
  }

  /** Lowercase hex digest. The instance itself is left unchanged. */
  digestHex(): string {
    const h = Uint32Array.from(this.h);
    const tail = new Uint8Array(this.pendingBytes + 9 > 64 ? 128 : 64);
    tail.set(this.pending.subarray(0, this.pendingBytes));
    tail[this.pendingBytes] = 0x80;
    const view = new DataView(tail.buffer);
    const bits = this.length * 8;
    view.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(tail.length - 4, bits >>> 0);
    compress(h, tail, 0, tail.length);
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
    return hex(out);
  }
}
