/**
 * DID Document Cache Repository
 *
 * Repository for caching resolved DID documents.
 * Reduces external DID resolution calls and improves performance.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { getCurrentTimestamp } from '../base';

/**
 * DID Document Cache entity
 */
export interface DIDDocumentCache {
  did: string;
  document: string; // JSON
  resolved_at: number;
  expires_at: number;
}

/**
 * DID Document Cache Repository
 *
 * Note: Does not extend BaseRepository because:
 * - Primary key is 'did' not 'id'
 * - No created_at/updated_at semantics
 * - Simple cache-only operations
 */
export class DIDDocumentCacheRepository {
  protected readonly adapter: DatabaseAdapter;
  protected readonly tableName = 'did_document_cache';

  constructor(adapter: DatabaseAdapter) {
    this.adapter = adapter;
  }

  /**
   * Get a cached DID document if it exists and is not expired
   */
  async getValidCache(did: string): Promise<{
    document: Record<string, unknown>;
    metadata: { retrieved: number; cached: boolean };
  } | null> {
    const now = getCurrentTimestamp();
    const row = await this.adapter.queryOne<DIDDocumentCache>(
      `SELECT document, resolved_at, expires_at
       FROM did_document_cache
       WHERE did = ? AND expires_at > ?`,
      [did, now]
    );

    if (!row) {
      return null;
    }

    return {
      document: JSON.parse(row.document) as Record<string, unknown>,
      metadata: {
        retrieved: row.resolved_at,
        cached: true,
      },
    };
  }

  /**
   * Cache a resolved DID document
   *
   * @param did The DID being cached
   * @param document The resolved DID document
   * @param ttlSeconds Time to live in seconds (default: 1 hour)
   */
  async cacheDocument(
    did: string,
    document: Record<string, unknown>,
    ttlSeconds: number = 3600
  ): Promise<void> {
    const now = getCurrentTimestamp();
    const expiresAt = now + ttlSeconds * 1000;

    await this.adapter.execute(
      `INSERT OR REPLACE INTO did_document_cache (did, document, resolved_at, expires_at)
       VALUES (?, ?, ?, ?)`,
      [did, JSON.stringify(document), now, expiresAt]
    );
  }

  /**
   * Invalidate a cached DID document
   */
  async invalidate(did: string): Promise<boolean> {
    const result = await this.adapter.execute('DELETE FROM did_document_cache WHERE did = ?', [
      did,
    ]);
    return result.rowsAffected > 0;
  }

  /**
   * Clear all expired cache entries
   */
  async clearExpired(): Promise<number> {
    const now = getCurrentTimestamp();
    const result = await this.adapter.execute(
      'DELETE FROM did_document_cache WHERE expires_at < ?',
      [now]
    );
    return result.rowsAffected;
  }

  /**
   * Clear all cache entries
   */
  async clearAll(): Promise<number> {
    const result = await this.adapter.execute('DELETE FROM did_document_cache', []);
    return result.rowsAffected;
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    total: number;
    expired: number;
    valid: number;
  }> {
    const now = getCurrentTimestamp();

    const totalResult = await this.adapter.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM did_document_cache',
      []
    );

    const expiredResult = await this.adapter.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM did_document_cache WHERE expires_at < ?',
      [now]
    );

    const total = totalResult?.count ?? 0;
    const expired = expiredResult?.count ?? 0;

    return {
      total,
      expired,
      valid: total - expired,
    };
  }

  /**
   * Check if a DID document is cached and valid
   */
  async isCached(did: string): Promise<boolean> {
    const now = getCurrentTimestamp();
    const row = await this.adapter.queryOne<{ did: string }>(
      'SELECT did FROM did_document_cache WHERE did = ? AND expires_at > ?',
      [did, now]
    );
    return row !== null;
  }
}
