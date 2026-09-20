export class TenantBundleCipherError extends Error {
  constructor() {
    super('invalid_tenant_bundle_ciphertext');
    this.name = 'TenantBundleCipherError';
  }
}
export function tenantBundleCipherParameters(
  hash: Uint8Array<ArrayBuffer>,
  sequence: number,
  type: number
) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(sequence));
  const additionalData = new Uint8Array(hash.length + 9);
  additionalData.set(hash);
  new DataView(additionalData.buffer).setBigUint64(hash.length, BigInt(sequence));
  additionalData[additionalData.length - 1] = type;
  return { name: 'AES-GCM', iv, additionalData, tagLength: 128 };
}
