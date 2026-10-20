import { expect, it } from 'vitest';
import { ResumableSha256 } from '../resumable-sha256';

async function native(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

it('matches WebCrypto across block boundaries and arbitrary update splits', async () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 70_001]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 31 + 7) & 0xff);
    const expected = await native(bytes);
    expect(ResumableSha256.create().update(bytes).digestHex()).toBe(expected);
    const split = ResumableSha256.create();
    for (let offset = 0; offset < length; offset += 1 + (offset % 97))
      split.update(bytes.subarray(offset, Math.min(length, offset + 1 + (offset % 97))));
    expect(split.digestHex()).toBe(expected);
  }
});

it('resumes from a saved midstate as if it had never stopped', async () => {
  const bytes = Uint8Array.from({ length: 5000 }, (_, index) => (index * 13) & 0xff);
  for (const cut of [0, 1, 63, 64, 65, 4999, 5000]) {
    const first = ResumableSha256.create().update(bytes.subarray(0, cut));
    const state = first.save();
    expect(state).toMatch(/^[a-f0-9]{64}\.\d+\.[a-f0-9]*$/);
    const resumed = ResumableSha256.restore(state);
    expect(resumed.byteLength).toBe(cut);
    expect(resumed.update(bytes.subarray(cut)).digestHex()).toBe(await native(bytes));
  }
  // digestHex does not finalize the running state.
  const running = ResumableSha256.create().update(bytes.subarray(0, 10));
  running.digestHex();
  expect(running.update(bytes.subarray(10)).digestHex()).toBe(await native(bytes));
});

it('rejects malformed or inconsistent states', () => {
  const valid = ResumableSha256.create().update(new Uint8Array(3)).save();
  for (const state of [
    '',
    valid.toUpperCase(),
    valid.replace(/\.3\./, '.4.'),
    valid.replace(/\.3\./, '.03.'),
    `${'0'.repeat(64)}.64.00`,
    `${'0'.repeat(64)}.${2 ** 51}.`,
    `${'0'.repeat(63)}.0.`,
  ])
    expect(() => ResumableSha256.restore(state)).toThrow('invalid_resumable_sha256_state');
});
