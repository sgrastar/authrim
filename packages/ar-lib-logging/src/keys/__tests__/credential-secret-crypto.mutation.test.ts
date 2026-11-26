import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CredentialSecretBackendError,
  R2EncryptedCredentialSecretBackend,
  assertCredentialRefVersion,
  buildCredentialSecretRef,
  decryptCredentialSecret,
  encryptCredentialSecret,
  parseCredentialSecretRef,
  type CredentialSecretR2Bucket,
  type EncryptedCredentialSecretEnvelope,
} from '../credential-secret-backend';

const rootKeyHex = 'ab'.repeat(32);
const MAX = 64 * 1024;

afterEach(() => {
  vi.restoreAllMocks();
});

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The AES-GCM key an HKDF-SHA-256 derivation of the root key gives, computed here independently. */
async function derivedKey(
  salt: string,
  info: string,
  usages: Array<'encrypt' | 'decrypt'>
): Promise<CryptoKey> {
  const root = Uint8Array.from({ length: 32 }, (_, i) =>
    Number.parseInt(rootKeyHex.slice(i * 2, i * 2 + 2), 16)
  );
  const material = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveKey']);
  const encode = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encode(salt), info: encode(info) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

function mockRandom(byte: number): void {
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(
    <T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint8Array) array.fill(byte);
      return array;
    }
  );
}

async function rejection(promise: Promise<unknown>): Promise<CredentialSecretBackendError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CredentialSecretBackendError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

const encryptOptions = {
  rootKeyHex,
  backend: 'd1_encrypted_table' as const,
  keyVersion: 2,
  contentType: 'text/plain',
  credentialRef: 'd1secret://admin/x#v1',
  destinationId: 'dest_1',
  version: 1,
};

describe('CredentialSecretBackendError', () => {
  it('carries its name, code, message and cause', () => {
    const cause = new Error('inner');
    const error = new CredentialSecretBackendError('secret_not_found', 'gone', { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CredentialSecretBackendError');
    expect(error.code).toBe('secret_not_found');
    expect(error.message).toBe('gone');
    expect(error.cause).toBe(cause);
  });
});

describe('encryptCredentialSecret and decryptCredentialSecret', () => {
  it('encrypts with the key derived from the root key, and binds the reference', async () => {
    const envelope = await encryptCredentialSecret('s3cret', encryptOptions);
    expect(envelope).toMatchObject({
      version: 1,
      algorithm: 'AES-256-GCM',
      backend: 'd1_encrypted_table',
      keyVersion: 2,
      contentType: 'text/plain',
    });

    const key = await derivedKey(
      'authrim-credential-secret-root',
      'authrim:d1_encrypted_table:v2',
      ['decrypt']
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64UrlToBytes(envelope.iv),
        additionalData: new TextEncoder().encode(
          '{"credential_ref":"d1secret://admin/x#v1","destination_id":"dest_1","version":1}'
        ),
        tagLength: 128,
      },
      key,
      base64UrlToBytes(envelope.ciphertext)
    );
    expect(new TextDecoder().decode(plaintext)).toBe('s3cret');
    expect(base64UrlToBytes(envelope.iv)).toHaveLength(12);
  });

  it('accepts bytes and returns the same text', async () => {
    const envelope = await encryptCredentialSecret(
      new TextEncoder().encode('bytes'),
      encryptOptions
    );
    const plaintext = await decryptCredentialSecret(envelope, {
      rootKeyHex,
      credentialRef: encryptOptions.credentialRef,
      destinationId: 'dest_1',
      version: 1,
    });
    expect(plaintext).toBe('bytes');
  });

  it('writes URL-safe base64 without padding, whatever the bytes', async () => {
    mockRandom(0xfb);
    const plus = await encryptCredentialSecret('', encryptOptions);
    expect(plus.iv).toBe('-_v7'.repeat(4));
    expect(plus.ciphertext).toMatch(/^[A-Za-z0-9_-]{22}$/);
    mockRandom(0xff);
    const slash = await encryptCredentialSecret('abc', encryptOptions);
    expect(slash.iv).toBe('_'.repeat(16));
    expect(slash.ciphertext).toMatch(/^[A-Za-z0-9_-]{26}$/);
  });

  it('reads back what it wrote, including IVs written with - and _', async () => {
    for (const byte of [0xfb, 0xff, 0x00]) {
      mockRandom(byte);
      const envelope = await encryptCredentialSecret('hello world', encryptOptions);
      const plaintext = await decryptCredentialSecret(envelope, {
        rootKeyHex,
        credentialRef: encryptOptions.credentialRef,
        destinationId: 'dest_1',
        version: 1,
      });
      expect(plaintext).toBe('hello world');
    }
  });

  it('refuses a root key that is not 64 hex characters', async () => {
    for (const bad of [
      '',
      'ab'.repeat(31),
      'ab'.repeat(33),
      `g${'a'.repeat(63)}`,
      `${'a'.repeat(63)}g`,
      `${'a'.repeat(63)}!`,
      `!${'a'.repeat(63)}`,
      ' '.repeat(64),
    ]) {
      const error = await rejection(
        encryptCredentialSecret('s', { ...encryptOptions, rootKeyHex: bad })
      );
      expect(error.code).toBe('encryption_failed');
      expect(error.message).toBe('Credential secret root key must be 64 hex characters.');
    }
    await expect(
      encryptCredentialSecret('s', { ...encryptOptions, rootKeyHex: 'AbCdEf0123456789'.repeat(4) })
    ).resolves.toBeDefined();
  });

  it('reports a failed decryption with its cause', async () => {
    const envelope = await encryptCredentialSecret('s', encryptOptions);
    const ok = {
      rootKeyHex,
      credentialRef: encryptOptions.credentialRef,
      destinationId: 'dest_1',
      version: 1,
    };
    const wrong: Array<[string, Parameters<typeof decryptCredentialSecret>[1]]> = [
      ['key', { ...ok, rootKeyHex: 'cd'.repeat(32) }],
      ['ref', { ...ok, credentialRef: 'd1secret://admin/other#v1' }],
      ['destination', { ...ok, destinationId: 'dest_2' }],
      ['version', { ...ok, version: 2 }],
    ];
    for (const [, options] of wrong) {
      const error = await rejection(decryptCredentialSecret(envelope, options));
      expect(error.code).toBe('decryption_failed');
      expect(error.message).toBe('Credential secret could not be decrypted.');
      expect(error.cause).toBeInstanceOf(Error);
    }
    const otherKeyVersion: EncryptedCredentialSecretEnvelope = { ...envelope, keyVersion: 3 };
    expect((await rejection(decryptCredentialSecret(otherKeyVersion, ok))).code).toBe(
      'decryption_failed'
    );
    const otherBackend: EncryptedCredentialSecretEnvelope = {
      ...envelope,
      backend: 'r2_encrypted_object',
    };
    expect((await rejection(decryptCredentialSecret(otherBackend, ok))).code).toBe(
      'decryption_failed'
    );
  });
});

describe('credential refs', () => {
  it('builds a ref with or without a version, and with a normalised path', () => {
    expect(buildCredentialSecretRef({ scheme: 'd1secret', authority: 'admin', path: 'a/b' })).toBe(
      'd1secret://admin/a/b'
    );
    expect(
      buildCredentialSecretRef({ scheme: 'd1secret', authority: 'admin', path: '/a/b', version: 7 })
    ).toBe('d1secret://admin/a/b#v7');
  });

  it('parses every supported scheme', () => {
    for (const scheme of ['r2secret', 'd1secret', 'cfsecret', 'extsecret']) {
      expect(parseCredentialSecretRef(`${scheme}://auth/p#v1`)).toStrictEqual({
        scheme,
        authority: 'auth',
        path: '/p',
        version: 1,
      });
    }
  });

  it('refuses text that is not a URI, and unsupported schemes', () => {
    const notUri = (() => {
      try {
        parseCredentialSecretRef('not a uri');
      } catch (error) {
        return error as CredentialSecretBackendError;
      }
      throw new Error('expected a throw');
    })();
    expect(notUri.code).toBe('invalid_credential_ref');
    expect(notUri.message).toBe('Credential ref is not a URI.');
    expect(notUri.cause).toBeInstanceOf(Error);
    for (const ref of ['https://auth/p', 'file:///tmp/x', 'r2secrets://auth/p']) {
      const error = (() => {
        try {
          parseCredentialSecretRef(ref);
        } catch (thrown) {
          return thrown as CredentialSecretBackendError;
        }
        throw new Error('expected a throw');
      })();
      expect(error.code).toBe('invalid_credential_ref');
      expect(error.message).toBe('Credential ref scheme is not supported.');
    }
  });

  it('reads a version only from a whole #v<digits> fragment', () => {
    const version = (hash: string): number | undefined =>
      parseCredentialSecretRef(`r2secret://auth/p${hash}`).version;
    expect(version('#v12')).toBe(12);
    expect(version('#v0')).toBe(0);
    expect(version('')).toBeUndefined();
    expect(version('#')).toBeUndefined();
    expect(version('#v')).toBeUndefined();
    expect(version('#v3x')).toBeUndefined();
    expect(version('#xv3')).toBeUndefined();
    expect(version('#3')).toBeUndefined();
    expect(version(`#v${'9'.repeat(400)}`)).toBeUndefined();
  });

  it('checks the version of a ref only when one is expected and the ref has one', () => {
    expect(() => assertCredentialRefVersion('not a uri')).not.toThrow();
    expect(() => assertCredentialRefVersion('r2secret://a/p#v2', 2)).not.toThrow();
    expect(() => assertCredentialRefVersion('r2secret://a/p', 2)).not.toThrow();
    expect(() => assertCredentialRefVersion('r2secret://a/p#v2', 0)).toThrow(
      'Credential ref version does not match the expected version.'
    );
    try {
      assertCredentialRefVersion('r2secret://a/p#v2', 3);
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialSecretBackendError);
      expect((error as CredentialSecretBackendError).code).toBe('version_mismatch');
    }
  });
});

describe('reading a secret object from R2', () => {
  async function envelopeText(padTo?: number): Promise<string> {
    const envelope = await encryptCredentialSecret('s3cret', {
      ...encryptOptions,
      backend: 'r2_encrypted_object',
      credentialRef: 'r2secret://admin-secrets/destinations/dest_1/credentials/v1.json#v1',
    });
    const text = JSON.stringify(envelope);
    return padTo === undefined
      ? text
      : text + ' '.repeat(padTo - new TextEncoder().encode(text).length);
  }

  const ref = 'r2secret://admin-secrets/destinations/dest_1/credentials/v1.json#v1';

  function backendWith(object: unknown) {
    const bucket = {
      put: vi.fn(),
      get: vi.fn(async () => object),
      delete: vi.fn(),
    } as unknown as CredentialSecretR2Bucket;
    return new R2EncryptedCredentialSecretBackend({ bucket, rootKeyHex });
  }

  function streamOf(...chunks: Array<Uint8Array | undefined>) {
    const reads: Array<{ done: boolean; value?: Uint8Array }> = [
      ...chunks.map((value) => ({ done: false, value })),
      { done: true },
    ];
    const releaseLock = vi.fn();
    const cancel = vi.fn(async () => {});
    const getReader = vi.fn(() => ({
      read: async () => reads.shift() ?? { done: true },
      releaseLock,
      cancel,
    }));
    return { body: { getReader }, releaseLock, cancel, getReader };
  }

  it('reads a body in several chunks and releases the reader', async () => {
    const bytes = new TextEncoder().encode(await envelopeText());
    const third = Math.floor(bytes.length / 3);
    const stream = streamOf(
      bytes.slice(0, third),
      undefined,
      bytes.slice(third, 2 * third),
      bytes.slice(2 * third)
    );
    const backend = backendWith({ body: stream.body, text: async () => 'unused' });
    expect((await backend.getSecret(ref)).plaintext).toBe('s3cret');
    expect(stream.releaseLock).toHaveBeenCalledTimes(1);
    expect(stream.cancel).not.toHaveBeenCalled();
  });

  it('accepts a body of exactly the maximum size and refuses one byte more', async () => {
    const exact = new TextEncoder().encode(await envelopeText(MAX));
    expect(exact.length).toBe(MAX);
    const ok = streamOf(exact);
    expect(
      (await backendWith({ body: ok.body, text: async () => '' }).getSecret(ref)).plaintext
    ).toBe('s3cret');

    const over = streamOf(new TextEncoder().encode(await envelopeText(MAX + 1)));
    const error = await rejection(
      backendWith({ body: over.body, text: async () => '' }).getSecret(ref)
    );
    expect(error.code).toBe('invalid_secret_envelope');
    expect(error.message).toBe('Credential secret envelope exceeds maximum size.');
    expect(over.cancel).toHaveBeenCalledTimes(1);
    expect(over.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('refuses a body that grows past the maximum over several chunks', async () => {
    const half = new Uint8Array(MAX / 2 + 1).fill(32);
    const stream = streamOf(half, half);
    const error = await rejection(
      backendWith({ body: stream.body, text: async () => '' }).getSecret(ref)
    );
    expect(error.code).toBe('invalid_secret_envelope');
  });

  it('refuses an object that says it is too large before reading it', async () => {
    const stream = streamOf(new TextEncoder().encode(await envelopeText()));
    const error = await rejection(
      backendWith({ size: MAX + 1, body: stream.body, text: async () => '' }).getSecret(ref)
    );
    expect(error.code).toBe('invalid_secret_envelope');
    expect(error.message).toBe('Credential secret envelope exceeds maximum size.');
    expect(stream.getReader).not.toHaveBeenCalled();
    const ok = streamOf(new TextEncoder().encode(await envelopeText()));
    await expect(
      backendWith({ size: MAX, body: ok.body, text: async () => '' }).getSecret(ref)
    ).resolves.toBeDefined();
  });

  it('reads the text of an object without a body, and refuses text over the maximum in bytes', async () => {
    const exact = await envelopeText(MAX);
    expect(
      (await backendWith({ body: null, text: async () => exact }).getSecret(ref)).plaintext
    ).toBe('s3cret');
    const over = await envelopeText(MAX + 1);
    const error = await rejection(backendWith({ text: async () => over }).getSecret(ref));
    expect(error.code).toBe('invalid_secret_envelope');
    expect(error.message).toBe('Credential secret envelope exceeds maximum size.');
    const wide = `${await envelopeText()}${'あ'.repeat(MAX / 3)}`;
    expect(wide.length).toBeLessThan(MAX);
    expect((await rejection(backendWith({ text: async () => wide }).getSecret(ref))).code).toBe(
      'invalid_secret_envelope'
    );
  });
});
