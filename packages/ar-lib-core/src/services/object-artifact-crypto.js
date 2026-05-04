import { PII_ENCRYPTION_KEY_LENGTH } from '../utils/encryption-config';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const OBJECT_STORAGE_PLANES = ['EXPORT_ARTIFACTS', 'SENSITIVE_DETAILS'];
function assertRootKeyFormat(rootKeyHex) {
    if (rootKeyHex.length !== PII_ENCRYPTION_KEY_LENGTH) {
        throw new Error(`OBJECT_ENCRYPTION_ROOT_KEY must be ${PII_ENCRYPTION_KEY_LENGTH} hex characters`);
    }
    if (!/^[0-9a-fA-F]+$/.test(rootKeyHex)) {
        throw new Error('OBJECT_ENCRYPTION_ROOT_KEY must contain only hex characters');
    }
}
function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
}
function toBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromBase64Url(value) {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
function buildAdditionalData(context) {
    return encoder.encode(JSON.stringify({
        tenant_id: context.tenantId,
        object_key: context.objectKey,
        object_class: context.objectClass,
    }));
}
async function derivePlaneKey(rootKeyHex, plane, keyVersion) {
    assertRootKeyFormat(rootKeyHex);
    const material = await crypto.subtle.importKey('raw', hexToBytes(rootKeyHex), 'HKDF', false, [
        'deriveKey',
    ]);
    return crypto.subtle.deriveKey({
        name: 'HKDF',
        hash: 'SHA-256',
        salt: encoder.encode('authrim-object-plane-root'),
        info: encoder.encode(`authrim:${plane}:v${keyVersion}`),
    }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptObjectArtifact(plaintext, options) {
    const key = await derivePlaneKey(options.rootKeyHex, options.plane, options.keyVersion);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({
        name: 'AES-GCM',
        iv,
        additionalData: buildAdditionalData(options.context),
        tagLength: 128,
    }, key, encoder.encode(plaintext));
    return {
        version: 1,
        algorithm: 'AES-256-GCM',
        plane: options.plane,
        objectClass: options.context.objectClass,
        keyVersion: options.keyVersion,
        contentType: options.contentType,
        iv: toBase64Url(iv),
        ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    };
}
export async function decryptObjectArtifact(envelope, options) {
    const key = await derivePlaneKey(options.rootKeyHex, envelope.plane, envelope.keyVersion);
    const plaintext = await crypto.subtle.decrypt({
        name: 'AES-GCM',
        iv: fromBase64Url(envelope.iv),
        additionalData: buildAdditionalData(options.context),
        tagLength: 128,
    }, key, fromBase64Url(envelope.ciphertext));
    return decoder.decode(plaintext);
}
