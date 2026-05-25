export type LoggingIdPrefix =
  | 'dest'
  | 'dhe'
  | 'cred'
  | 'evt'
  | 'pol'
  | 'sda'
  | 'snap'
  | 'obj'
  | 'chk'
  | 'man'
  | 'lde'
  | 'dlq'
  | 'lmj'
  | 'qpl'
  | 'rec'
  | 'lexp'
  | 'lkey'
  | 'lrw'
  | 'loh'
  | 'rw'
  | 'acp'
  | 'sdp'
  | 'tdp'
  | 'lqp'
  | 'lqe'
  | 'lcrj'
  | 'indr'
  | 'inda';

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function createUuidV7(
  now: number = Date.now(),
  random: Uint8Array = randomBytes(10)
): string {
  if (random.length !== 10) {
    throw new Error('uuidv7_random_must_be_10_bytes');
  }

  const bytes = new Uint8Array(16);
  const timestamp = Math.max(0, Math.min(Math.trunc(now), 0xffffffffffff));
  bytes[0] = (timestamp / 0x10000000000) & 0xff;
  bytes[1] = (timestamp / 0x100000000) & 0xff;
  bytes[2] = (timestamp / 0x1000000) & 0xff;
  bytes[3] = (timestamp / 0x10000) & 0xff;
  bytes[4] = (timestamp / 0x100) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes.set(random, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`;
}

export function createLoggingId(prefix: LoggingIdPrefix, now: number = Date.now()): string {
  return `${prefix}_${createUuidV7(now)}`;
}
