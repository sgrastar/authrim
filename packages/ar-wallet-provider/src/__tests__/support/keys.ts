/** Test helper: typed ECDSA key pair generation (the Workers typings return a union for generateKey). */
export interface Pair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

export async function genPair(curve: 'P-256' | 'P-384'): Promise<Pair> {
  return (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, [
    'sign',
    'verify',
  ])) as unknown as Pair;
}

export async function exportSpki(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array((await crypto.subtle.exportKey('spki', key)) as ArrayBuffer);
}

export async function exportRaw(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array((await crypto.subtle.exportKey('raw', key)) as ArrayBuffer);
}
