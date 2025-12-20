/**
 * Trusted Issuer Repository
 *
 * Repository for managing trusted VC issuers.
 * Stores issuer DIDs and their trust configurations.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import {
  BaseRepository,
  type BaseEntity,
  type FilterCondition,
  type PaginationOptions,
  type PaginationResult,
  generateId,
  getCurrentTimestamp,
} from '../base';

/**
 * Trust level for issuers
 */
export type TrustLevel = 'standard' | 'high';

/**
 * Issuer status
 */
export type IssuerStatus = 'active' | 'suspended' | 'revoked';

/**
 * Trusted Issuer entity
 */
export interface TrustedIssuer extends BaseEntity {
  tenant_id: string;
  issuer_did: string;
  display_name: string | null;
  credential_types: string | null; // JSON array of VCT strings
  trust_level: TrustLevel;
  jwks_uri: string | null;
  status: IssuerStatus;
}

/**
 * Input for creating a trusted issuer
 */
export interface CreateTrustedIssuerInput {
  id?: string;
  tenant_id: string;
  issuer_did: string;
  display_name?: string | null;
  credential_types?: string[];
  trust_level?: TrustLevel;
  jwks_uri?: string | null;
  status?: IssuerStatus;
}

/**
 * Input for updating a trusted issuer
 */
export interface UpdateTrustedIssuerInput {
  display_name?: string | null;
  credential_types?: string[];
  trust_level?: TrustLevel;
  jwks_uri?: string | null;
  status?: IssuerStatus;
}

/**
 * Filter options for trusted issuers
 */
export interface TrustedIssuerFilterOptions {
  tenant_id?: string;
  issuer_did?: string;
  trust_level?: TrustLevel;
  status?: IssuerStatus;
}

/**
 * Trusted Issuer Repository
 */
export class TrustedIssuerRepository extends BaseRepository<TrustedIssuer> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'trusted_issuers',
      primaryKey: 'id',
      softDelete: false, // Use status field instead
      allowedFields: [
        'tenant_id',
        'issuer_did',
        'display_name',
        'credential_types',
        'trust_level',
        'jwks_uri',
        'status',
      ],
    });
  }

  /**
   * Create a new trusted issuer
   */
  async createTrustedIssuer(input: CreateTrustedIssuerInput): Promise<TrustedIssuer> {
    const id = input.id ?? generateId();
    const now = getCurrentTimestamp();

    const issuer: TrustedIssuer = {
      id,
      tenant_id: input.tenant_id,
      issuer_did: input.issuer_did,
      display_name: input.display_name ?? null,
      credential_types: input.credential_types ? JSON.stringify(input.credential_types) : null,
      trust_level: input.trust_level ?? 'standard',
      jwks_uri: input.jwks_uri ?? null,
      status: input.status ?? 'active',
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO trusted_issuers (
        id, tenant_id, issuer_did, display_name, credential_types,
        trust_level, jwks_uri, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.adapter.execute(sql, [
      issuer.id,
      issuer.tenant_id,
      issuer.issuer_did,
      issuer.display_name,
      issuer.credential_types,
      issuer.trust_level,
      issuer.jwks_uri,
      issuer.status,
      issuer.created_at,
      issuer.updated_at,
    ]);

    return issuer;
  }

  /**
   * Find a trusted issuer by tenant and DID
   */
  async findByTenantAndDid(tenantId: string, issuerDid: string): Promise<TrustedIssuer | null> {
    const row = await this.adapter.queryOne<TrustedIssuer>(
      'SELECT * FROM trusted_issuers WHERE tenant_id = ? AND issuer_did = ?',
      [tenantId, issuerDid]
    );
    return row;
  }

  /**
   * Find an active trusted issuer by tenant and DID
   */
  async findActiveTrustedIssuer(
    tenantId: string,
    issuerDid: string
  ): Promise<TrustedIssuer | null> {
    const row = await this.adapter.queryOne<TrustedIssuer>(
      `SELECT * FROM trusted_issuers
       WHERE tenant_id = ? AND issuer_did = ? AND status = 'active'`,
      [tenantId, issuerDid]
    );
    return row;
  }

  /**
   * Find all trusted issuers for a tenant
   */
  async findByTenant(
    tenantId: string,
    options?: PaginationOptions
  ): Promise<PaginationResult<TrustedIssuer>> {
    return this.findAll([{ field: 'tenant_id', operator: 'eq', value: tenantId }], options);
  }

  /**
   * Search trusted issuers with filters
   */
  async searchIssuers(
    filters: TrustedIssuerFilterOptions,
    options?: PaginationOptions
  ): Promise<PaginationResult<TrustedIssuer>> {
    const conditions: FilterCondition[] = [];

    if (filters.tenant_id) {
      conditions.push({ field: 'tenant_id', operator: 'eq', value: filters.tenant_id });
    }
    if (filters.issuer_did) {
      conditions.push({ field: 'issuer_did', operator: 'eq', value: filters.issuer_did });
    }
    if (filters.trust_level) {
      conditions.push({ field: 'trust_level', operator: 'eq', value: filters.trust_level });
    }
    if (filters.status) {
      conditions.push({ field: 'status', operator: 'eq', value: filters.status });
    }

    return this.findAll(conditions, options);
  }

  /**
   * Update issuer status
   */
  async updateStatus(id: string, status: IssuerStatus): Promise<boolean> {
    const result = await this.adapter.execute(
      'UPDATE trusted_issuers SET status = ?, updated_at = ? WHERE id = ?',
      [status, getCurrentTimestamp(), id]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Check if an issuer is trusted (active status) for a tenant
   */
  async isTrusted(tenantId: string, issuerDid: string): Promise<boolean> {
    const issuer = await this.findActiveTrustedIssuer(tenantId, issuerDid);
    return issuer !== null;
  }

  /**
   * Parse credential types JSON
   */
  parseCredentialTypes(issuer: TrustedIssuer): string[] {
    if (!issuer.credential_types) {
      return [];
    }
    try {
      return JSON.parse(issuer.credential_types) as string[];
    } catch {
      return [];
    }
  }
}
