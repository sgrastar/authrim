/**
 * Storage Infrastructure
 *
 * Exports storage infrastructure implementations.
 */

// Cloudflare implementation
export { CloudflareStorageInfra, CloudflareStorageAdapter } from './cloudflare';

// Factory function
export { createStorageInfra, type StorageInfraOptions } from './factory';
