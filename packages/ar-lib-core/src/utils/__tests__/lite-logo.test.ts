import { describe, expect, it } from 'vitest';
import { checkLiteLogoDataUri, LITE_LOGO_MAX_BYTES } from '../lite-logo';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function le32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function chars(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function pngChunk(type: string, data: number[]): number[] {
  return [...be32(data.length), ...chars(type), ...data, 0, 0, 0, 0];
}

function png(width: number, height: number, extra: number[][] = []): Uint8Array {
  const ihdr = [...be32(width), ...be32(height), 8, 6, 0, 0, 0];
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...pngChunk('IHDR', ihdr),
    ...extra.flat(),
    ...pngChunk('IDAT', [1, 2, 3]),
    ...pngChunk('IEND', []),
  ]);
}

function riff(chunks: number[][]): Uint8Array {
  const body = [...chars('WEBP'), ...chunks.flat()];
  return new Uint8Array([...chars('RIFF'), ...le32(body.length), ...body]);
}

function webpChunk(type: string, data: number[]): number[] {
  return [...chars(type), ...le32(data.length), ...data, ...(data.length % 2 ? [0] : [])];
}

function vp8l(width: number, height: number): number[] {
  const bits = (width - 1) | ((height - 1) << 14);
  return webpChunk('VP8L', [0x2f, ...le32(bits >>> 0), 0, 0, 0]);
}

function vp8x(width: number, height: number, flags = 0): number[] {
  const w = width - 1;
  const h = height - 1;
  return webpChunk('VP8X', [
    flags,
    0,
    0,
    0,
    w & 0xff,
    (w >> 8) & 0xff,
    (w >> 16) & 0xff,
    h & 0xff,
    (h >> 8) & 0xff,
    (h >> 16) & 0xff,
  ]);
}

const pngUri = (bytes: Uint8Array) => `data:image/png;base64,${bytesToBase64(bytes)}`;
const webpUri = (bytes: Uint8Array) => `data:image/webp;base64,${bytesToBase64(bytes)}`;

describe('checkLiteLogoDataUri', () => {
  it('accepts a still PNG within the limits', () => {
    expect(checkLiteLogoDataUri(pngUri(png(640, 160)))).toMatchObject({
      ok: true,
      mimeType: 'image/png',
      width: 640,
      height: 160,
    });
  });

  it('accepts a still lossless WebP and an extended WebP without the animation flag', () => {
    expect(checkLiteLogoDataUri(webpUri(riff([vp8l(120, 40)])))).toMatchObject({
      ok: true,
      mimeType: 'image/webp',
      width: 120,
      height: 40,
    });
    expect(checkLiteLogoDataUri(webpUri(riff([vp8x(200, 60), vp8l(200, 60)])))).toMatchObject({
      ok: true,
      width: 200,
      height: 60,
    });
  });

  it('refuses animations', () => {
    expect(
      checkLiteLogoDataUri(pngUri(png(10, 10, [pngChunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0])])))
    ).toEqual({
      ok: false,
      reason: 'animated',
    });
    expect(checkLiteLogoDataUri(webpUri(riff([vp8x(10, 10, 0x02)])))).toEqual({
      ok: false,
      reason: 'animated',
    });
    expect(
      checkLiteLogoDataUri(webpUri(riff([vp8x(10, 10), webpChunk('ANIM', [0, 0, 0, 0, 0, 0])])))
    ).toEqual({ ok: false, reason: 'animated' });
  });

  it('refuses images larger than 640×160', () => {
    expect(checkLiteLogoDataUri(pngUri(png(641, 10)))).toEqual({ ok: false, reason: 'too_wide' });
    expect(checkLiteLogoDataUri(pngUri(png(10, 161)))).toEqual({ ok: false, reason: 'too_tall' });
    expect(checkLiteLogoDataUri(webpUri(riff([vp8l(641, 10)])))).toEqual({
      ok: false,
      reason: 'too_wide',
    });
  });

  it('refuses files over 8 KB', () => {
    const big = png(10, 10, [
      pngChunk(
        'tEXt',
        Array.from({ length: LITE_LOGO_MAX_BYTES }, () => 0x41)
      ),
    ]);
    expect(checkLiteLogoDataUri(pngUri(big))).toEqual({ ok: false, reason: 'too_large' });
  });

  it('refuses SVG, other types, and values that are not data URIs', () => {
    expect(checkLiteLogoDataUri('data:image/svg+xml;base64,PHN2Zz4=')).toEqual({
      ok: false,
      reason: 'unsupported_type',
    });
    expect(checkLiteLogoDataUri('https://cdn.example/logo.png')).toEqual({
      ok: false,
      reason: 'not_data_uri',
    });
    expect(checkLiteLogoDataUri(42)).toEqual({ ok: false, reason: 'not_data_uri' });
  });

  it('refuses bad base64 and a container that does not hold together', () => {
    expect(checkLiteLogoDataUri('data:image/png;base64,abc')).toEqual({
      ok: false,
      reason: 'invalid_base64',
    });
    expect(checkLiteLogoDataUri('data:image/png;base64,ab c')).toEqual({
      ok: false,
      reason: 'invalid_base64',
    });
    const truncated = png(10, 10).slice(0, -6);
    expect(checkLiteLogoDataUri(pngUri(truncated))).toEqual({ ok: false, reason: 'malformed' });
    const trailing = new Uint8Array([...png(10, 10), 0, 0, 0, 0]);
    expect(checkLiteLogoDataUri(pngUri(trailing))).toEqual({ ok: false, reason: 'malformed' });
    // A PNG declared as WebP is not a WebP.
    expect(checkLiteLogoDataUri(webpUri(png(10, 10)))).toEqual({ ok: false, reason: 'malformed' });
    const badRiffSize = riff([vp8l(10, 10)]);
    badRiffSize[4] += 2;
    expect(checkLiteLogoDataUri(webpUri(badRiffSize))).toEqual({ ok: false, reason: 'malformed' });
  });
});
