/**
 * PII Field Encryption Utility
 *
 * Provides encryption and decryption for PII fields using configurable algorithms.
 * Supports:
 * - AES-256-GCM (recommended, authenticated encryption)
 * - AES-256-CBC (legacy compatibility)
 *
 * Encrypted format:
 * - GCM: enc:v{version}:gcm:{base64(iv || ciphertext || tag)}
 * - CBC: enc:v{version}:cbc:{base64(iv || ciphertext)}
 *
 * This format allows:
 * - Detection of encrypted vs plaintext values
 * - Algorithm identification for decryption
 * - Key version tracking for rotation
 */
import { createLogger } from './logger';
const log = createLogger().module('PII_ENCRYPTION');
const IV_LENGTH_GCM = 12; // 96 bits for GCM (NIST recommended)
const IV_LENGTH_CBC = 16; // 128 bits for CBC
const KEY_LENGTH = 32; // 256 bits
/**
 * Encrypted value prefix pattern
 */
const ENCRYPTED_PREFIX_REGEX = /^enc:v(\d+):(gcm|cbc):(.+)$/;
/**
 * Check if a value is encrypted
 */
export function isEncrypted(value) {
    if (!value)
        return false;
    return ENCRYPTED_PREFIX_REGEX.test(value);
}
/**
 * Parse encrypted value metadata
 */
export function parseEncryptedValue(value) {
    const match = value.match(ENCRYPTED_PREFIX_REGEX);
    if (!match)
        return null;
    return {
        keyVersion: parseInt(match[1], 10),
        algorithm: match[2],
        payload: match[3],
    };
}
/**
 * Derive a CryptoKey from hex-encoded key string
 */
async function deriveKey(hexKey, algorithm) {
    if (!hexKey || hexKey.length !== KEY_LENGTH * 2) {
        throw new Error(`Invalid encryption key: expected ${KEY_LENGTH * 2} hex characters, got ${hexKey?.length || 0}`);
    }
    const keyBytes = new Uint8Array(KEY_LENGTH);
    for (let i = 0; i < KEY_LENGTH; i++) {
        keyBytes[i] = parseInt(hexKey.substring(i * 2, i * 2 + 2), 16);
    }
    return crypto.subtle.importKey('raw', keyBytes, { name: algorithm }, false, [
        'encrypt',
        'decrypt',
    ]);
}
/**
 * Encrypt using AES-256-GCM
 */
async function encryptGCM(plaintext, hexKey, keyVersion) {
    const key = await deriveKey(hexKey, 'AES-GCM');
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_GCM));
    const encoder = new TextEncoder();
    const plaintextBytes = encoder.encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, plaintextBytes);
    // Combine iv + ciphertext (includes tag)
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    const payload = btoa(String.fromCharCode(...combined));
    return `enc:v${keyVersion}:gcm:${payload}`;
}
/**
 * Decrypt using AES-256-GCM
 */
async function decryptGCM(payload, hexKey) {
    const key = await deriveKey(hexKey, 'AES-GCM');
    const combined = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    if (combined.length < IV_LENGTH_GCM + 16) {
        throw new Error('Invalid encrypted data: too short for GCM');
    }
    const iv = combined.slice(0, IV_LENGTH_GCM);
    const ciphertext = combined.slice(IV_LENGTH_GCM);
    const plaintextBytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, ciphertext);
    const decoder = new TextDecoder();
    return decoder.decode(plaintextBytes);
}
/**
 * Encrypt using AES-256-CBC
 */
async function encryptCBC(plaintext, hexKey, keyVersion) {
    const key = await deriveKey(hexKey, 'AES-CBC');
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_CBC));
    const encoder = new TextEncoder();
    const plaintextBytes = encoder.encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plaintextBytes);
    // Combine iv + ciphertext
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    const payload = btoa(String.fromCharCode(...combined));
    return `enc:v${keyVersion}:cbc:${payload}`;
}
/**
 * Decrypt using AES-256-CBC
 */
async function decryptCBC(payload, hexKey) {
    const key = await deriveKey(hexKey, 'AES-CBC');
    const combined = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    if (combined.length < IV_LENGTH_CBC + 16) {
        throw new Error('Invalid encrypted data: too short for CBC');
    }
    const iv = combined.slice(0, IV_LENGTH_CBC);
    const ciphertext = combined.slice(IV_LENGTH_CBC);
    const plaintextBytes = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ciphertext);
    const decoder = new TextDecoder();
    return decoder.decode(plaintextBytes);
}
/**
 * Encrypt a plaintext value using the specified algorithm
 */
export async function encryptValue(plaintext, hexKey, algorithm, keyVersion) {
    if (algorithm === 'NONE') {
        return { encrypted: plaintext, algorithm: 'NONE', keyVersion };
    }
    if (!plaintext) {
        return { encrypted: plaintext, algorithm, keyVersion };
    }
    let encrypted;
    switch (algorithm) {
        case 'AES-256-GCM':
            encrypted = await encryptGCM(plaintext, hexKey, keyVersion);
            break;
        case 'AES-256-CBC':
            encrypted = await encryptCBC(plaintext, hexKey, keyVersion);
            break;
        default: {
            // Exhaustive check - should never reach here
            const exhaustiveCheck = algorithm;
            throw new Error(`Unsupported algorithm: ${String(exhaustiveCheck)}`);
        }
    }
    return { encrypted, algorithm, keyVersion };
}
/**
 * Decrypt an encrypted value
 * Returns original value if not encrypted
 */
export async function decryptValue(value, hexKey) {
    if (!value) {
        return { decrypted: value, wasEncrypted: false };
    }
    const parsed = parseEncryptedValue(value);
    if (!parsed) {
        return { decrypted: value, wasEncrypted: false };
    }
    let decrypted;
    try {
        switch (parsed.algorithm) {
            case 'gcm':
                decrypted = await decryptGCM(parsed.payload, hexKey);
                break;
            case 'cbc':
                decrypted = await decryptCBC(parsed.payload, hexKey);
                break;
            default: {
                // Exhaustive check - should never reach here
                const exhaustiveCheck = parsed.algorithm;
                throw new Error(`Unsupported algorithm: ${String(exhaustiveCheck)}`);
            }
        }
    }
    catch (error) {
        throw new Error(`Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    return {
        decrypted,
        wasEncrypted: true,
        algorithm: parsed.algorithm === 'gcm' ? 'AES-256-GCM' : 'AES-256-CBC',
        keyVersion: parsed.keyVersion,
    };
}
/**
 * PII Encryption Service
 *
 * High-level service for encrypting/decrypting PII fields
 */
export class PIIEncryptionService {
    configManager;
    encryptionKey;
    constructor(configManager, encryptionKey) {
        this.configManager = configManager;
        this.encryptionKey = encryptionKey;
    }
    /**
     * Check if encryption is available (key configured and enabled)
     */
    async isAvailable() {
        if (!this.encryptionKey)
            return false;
        return this.configManager.isEncryptionEnabled();
    }
    /**
     * Encrypt a single PII field if encryption is enabled
     */
    async encryptField(fieldName, value) {
        if (!value)
            return value;
        // Check if already encrypted
        if (isEncrypted(value))
            return value;
        // Check if encryption is enabled and field should be encrypted
        const shouldEncrypt = await this.configManager.shouldEncryptField(fieldName);
        if (!shouldEncrypt)
            return value;
        if (!this.encryptionKey) {
            log.warn('Encryption enabled but PII_ENCRYPTION_KEY not configured');
            return value;
        }
        const algorithm = await this.configManager.getAlgorithm();
        const keyVersion = await this.configManager.getKeyVersion();
        const result = await encryptValue(value, this.encryptionKey, algorithm, keyVersion);
        return result.encrypted;
    }
    /**
     * Decrypt a single PII field
     */
    async decryptField(value) {
        if (!value)
            return value;
        if (!isEncrypted(value))
            return value;
        if (!this.encryptionKey) {
            throw new Error('Cannot decrypt: PII_ENCRYPTION_KEY not configured');
        }
        const result = await decryptValue(value, this.encryptionKey);
        return result.decrypted;
    }
    /**
     * Encrypt multiple PII fields in an object
     */
    async encryptFields(data, fieldNames) {
        const enabled = await this.configManager.isEncryptionEnabled();
        if (!enabled || !this.encryptionKey)
            return data;
        const algorithm = await this.configManager.getAlgorithm();
        if (algorithm === 'NONE')
            return data;
        const encryptionFields = await this.configManager.getEncryptionFields();
        const keyVersion = await this.configManager.getKeyVersion();
        const result = { ...data };
        for (const fieldName of fieldNames) {
            if (!encryptionFields.includes(fieldName))
                continue;
            const value = data[fieldName];
            if (typeof value !== 'string' || !value)
                continue;
            if (isEncrypted(value))
                continue;
            const encrypted = await encryptValue(value, this.encryptionKey, algorithm, keyVersion);
            result[fieldName] = encrypted.encrypted;
        }
        return result;
    }
    /**
     * Decrypt multiple PII fields in an object
     */
    async decryptFields(data, fieldNames) {
        if (!this.encryptionKey)
            return data;
        const result = { ...data };
        for (const fieldName of fieldNames) {
            const value = data[fieldName];
            if (typeof value !== 'string' || !value)
                continue;
            if (!isEncrypted(value))
                continue;
            const decrypted = await decryptValue(value, this.encryptionKey);
            result[fieldName] = decrypted.decrypted;
        }
        return result;
    }
    /**
     * Re-encrypt a field with new algorithm or key version
     * Useful for key rotation or algorithm migration
     */
    async reEncryptField(value, newAlgorithm, newKeyVersion, newKey) {
        if (!value)
            return value;
        // Decrypt with current key
        const decrypted = await this.decryptField(value);
        if (!decrypted)
            return value;
        // Re-encrypt with new settings
        const keyToUse = newKey || this.encryptionKey;
        if (!keyToUse) {
            throw new Error('No encryption key available for re-encryption');
        }
        const result = await encryptValue(decrypted, keyToUse, newAlgorithm, newKeyVersion);
        return result.encrypted;
    }
}
/**
 * Create a PII encryption service
 */
export function createPIIEncryptionService(configManager, env) {
    return new PIIEncryptionService(configManager, env.PII_ENCRYPTION_KEY);
}
