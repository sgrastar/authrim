/**
 * User PII Repository
 *
 * Repository for PII (Personal Identifiable Information) stored in D1_PII.
 * Contains personal information separated from Core DB for:
 * - GDPR/CCPA compliance
 * - Regional data residency
 * - Fine-grained access control
 *
 * Fields stored in PII DB:
 * - id: User ID (same as users_core.id, logical FK)
 * - tenant_id: Tenant ID
 * - pii_class: Sensitivity classification
 * - email, phone_number: Contact info (IDENTITY_CORE)
 * - name, picture: Profile info (PROFILE)
 * - gender, birthdate: Demographic info (DEMOGRAPHIC)
 * - address_*: Location info (LOCATION)
 * - declared_residence: User-declared residence for partition routing
 *
 * Note: This repository accepts a DatabaseAdapter which should be
 * the correct PII partition adapter from PIIPartitionRouter.
 */

import type { DatabaseAdapter, PIIClass } from '../../db/adapter';
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
 * User PII entity
 */
export interface UserPII extends BaseEntity {
  tenant_id: string;
  pii_class: PIIClass;
  email: string;
  email_blind_index: string | null;
  phone_number: string | null;
  name: string | null;
  given_name: string | null;
  family_name: string | null;
  nickname: string | null;
  preferred_username: string | null;
  picture: string | null;
  website: string | null;
  gender: string | null;
  birthdate: string | null;
  locale: string | null;
  zoneinfo: string | null;
  address_formatted: string | null;
  address_street_address: string | null;
  address_locality: string | null;
  address_region: string | null;
  address_postal_code: string | null;
  address_country: string | null;
  declared_residence: string | null;
}

/**
 * User PII create input
 */
export interface CreateUserPIIInput {
  id: string; // Must match users_core.id
  tenant_id?: string;
  pii_class?: PIIClass;
  email: string;
  email_blind_index?: string | null;
  phone_number?: string | null;
  name?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  nickname?: string | null;
  preferred_username?: string | null;
  picture?: string | null;
  website?: string | null;
  gender?: string | null;
  birthdate?: string | null;
  locale?: string | null;
  zoneinfo?: string | null;
  address_formatted?: string | null;
  address_street_address?: string | null;
  address_locality?: string | null;
  address_region?: string | null;
  address_postal_code?: string | null;
  address_country?: string | null;
  declared_residence?: string | null;
}

/**
 * User PII update input
 */
export interface UpdateUserPIIInput {
  pii_class?: PIIClass;
  email?: string;
  email_blind_index?: string | null;
  phone_number?: string | null;
  name?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  nickname?: string | null;
  preferred_username?: string | null;
  picture?: string | null;
  website?: string | null;
  gender?: string | null;
  birthdate?: string | null;
  locale?: string | null;
  zoneinfo?: string | null;
  address_formatted?: string | null;
  address_street_address?: string | null;
  address_locality?: string | null;
  address_region?: string | null;
  address_postal_code?: string | null;
  address_country?: string | null;
  declared_residence?: string | null;
}

/**
 * OIDC Standard Claims subset
 * Returned from /userinfo endpoint
 */
export interface OIDCUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  phone_number?: string;
  phone_number_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  nickname?: string;
  preferred_username?: string;
  picture?: string;
  website?: string;
  gender?: string;
  birthdate?: string;
  locale?: string;
  zoneinfo?: string;
  address?: {
    formatted?: string;
    street_address?: string;
    locality?: string;
    region?: string;
    postal_code?: string;
    country?: string;
  };
}

/**
 * Allowed fields for UserPII updates (whitelist for SQL injection prevention)
 */
const USER_PII_UPDATABLE_FIELDS = new Set([
  'pii_class',
  'email',
  'email_blind_index',
  'phone_number',
  'name',
  'given_name',
  'family_name',
  'nickname',
  'preferred_username',
  'picture',
  'website',
  'gender',
  'birthdate',
  'locale',
  'zoneinfo',
  'address_formatted',
  'address_street_address',
  'address_locality',
  'address_region',
  'address_postal_code',
  'address_country',
  'declared_residence',
  'updated_at',
]);

/**
 * User PII Repository
 *
 * Note: Unlike other repositories, methods may accept an optional adapter
 * to support partition-specific queries. If not provided, uses the default adapter.
 */
export class UserPIIRepository extends BaseRepository<UserPII> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'users_pii',
      primaryKey: 'id',
      softDelete: false, // PII uses hard delete (GDPR requirement)
      allowedFields: [
        'tenant_id',
        'pii_class',
        'email',
        'email_blind_index',
        'phone_number',
        'name',
        'given_name',
        'family_name',
        'nickname',
        'preferred_username',
        'picture',
        'website',
        'gender',
        'birthdate',
        'locale',
        'zoneinfo',
        'address_formatted',
        'address_street_address',
        'address_locality',
        'address_region',
        'address_postal_code',
        'address_country',
        'declared_residence',
      ],
    });
  }

  /**
   * Validate field name for update operations (prevents SQL injection)
   *
   * @param field - Field name to validate
   * @returns True if field is allowed for update
   */
  private isValidUpdateField(field: string): boolean {
    return USER_PII_UPDATABLE_FIELDS.has(field);
  }

  /**
   * Create user PII record
   *
   * @param input - PII data
   * @param adapter - Optional partition-specific adapter
   * @returns Created PII record
   */
  async createPII(input: CreateUserPIIInput, adapter?: DatabaseAdapter): Promise<UserPII> {
    const db = adapter ?? this.adapter;
    const now = getCurrentTimestamp();

    const pii: UserPII = {
      id: input.id,
      tenant_id: input.tenant_id ?? 'default',
      pii_class: input.pii_class ?? 'PROFILE',
      email: input.email,
      email_blind_index: input.email_blind_index ?? null,
      phone_number: input.phone_number ?? null,
      name: input.name ?? null,
      given_name: input.given_name ?? null,
      family_name: input.family_name ?? null,
      nickname: input.nickname ?? null,
      preferred_username: input.preferred_username ?? null,
      picture: input.picture ?? null,
      website: input.website ?? null,
      gender: input.gender ?? null,
      birthdate: input.birthdate ?? null,
      locale: input.locale ?? null,
      zoneinfo: input.zoneinfo ?? null,
      address_formatted: input.address_formatted ?? null,
      address_street_address: input.address_street_address ?? null,
      address_locality: input.address_locality ?? null,
      address_region: input.address_region ?? null,
      address_postal_code: input.address_postal_code ?? null,
      address_country: input.address_country ?? null,
      declared_residence: input.declared_residence ?? null,
      created_at: now,
      updated_at: now,
    };

    const sql = `
      INSERT INTO users_pii (
        id, tenant_id, pii_class, email, email_blind_index, phone_number,
        name, given_name, family_name, nickname, preferred_username,
        picture, website, gender, birthdate, locale, zoneinfo,
        address_formatted, address_street_address, address_locality,
        address_region, address_postal_code, address_country,
        declared_residence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await db.execute(sql, [
      pii.id,
      pii.tenant_id,
      pii.pii_class,
      pii.email,
      pii.email_blind_index,
      pii.phone_number,
      pii.name,
      pii.given_name,
      pii.family_name,
      pii.nickname,
      pii.preferred_username,
      pii.picture,
      pii.website,
      pii.gender,
      pii.birthdate,
      pii.locale,
      pii.zoneinfo,
      pii.address_formatted,
      pii.address_street_address,
      pii.address_locality,
      pii.address_region,
      pii.address_postal_code,
      pii.address_country,
      pii.declared_residence,
      pii.created_at,
      pii.updated_at,
    ]);

    return pii;
  }

  /**
   * Find PII by user ID
   *
   * @param userId - User ID
   * @param adapter - Optional partition-specific adapter
   * @returns PII record or null
   */
  async findByUserId(userId: string, adapter?: DatabaseAdapter): Promise<UserPII | null> {
    const db = adapter ?? this.adapter;
    return db.queryOne<UserPII>('SELECT * FROM users_pii WHERE id = ?', [userId]);
  }

  /**
   * Find PII by email blind index
   *
   * @param blindIndex - Email blind index
   * @param tenantId - Tenant ID
   * @param adapter - Optional partition-specific adapter
   * @returns PII record or null
   */
  async findByEmailBlindIndex(
    blindIndex: string,
    tenantId: string,
    adapter?: DatabaseAdapter
  ): Promise<UserPII | null> {
    const db = adapter ?? this.adapter;
    return db.queryOne<UserPII>(
      'SELECT * FROM users_pii WHERE email_blind_index = ? AND tenant_id = ?',
      [blindIndex, tenantId]
    );
  }

  /**
   * Update PII record
   *
   * @param userId - User ID
   * @param data - Fields to update
   * @param adapter - Optional partition-specific adapter
   * @returns Updated PII or null if not found
   * @throws Error if invalid field names are provided
   */
  async updatePII(
    userId: string,
    data: UpdateUserPIIInput,
    adapter?: DatabaseAdapter
  ): Promise<UserPII | null> {
    const db = adapter ?? this.adapter;

    // Check if exists
    const existing = await this.findByUserId(userId, db);
    if (!existing) {
      return null;
    }

    const now = getCurrentTimestamp();
    const updateData = { ...data, updated_at: now };

    // Filter and validate field names to prevent SQL injection
    const fields = Object.keys(updateData).filter((k) => {
      const value = updateData[k as keyof typeof updateData];
      if (value === undefined) return false;

      // Validate field name against whitelist
      if (!this.isValidUpdateField(k)) {
        console.warn(`UserPIIRepository.updatePII: Invalid field '${k}' ignored`);
        return false;
      }

      // Additional validation: field name must be alphanumeric + underscore
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
        console.warn(`UserPIIRepository.updatePII: Malformed field '${k}' ignored`);
        return false;
      }

      return true;
    });

    if (fields.length === 0) {
      // No valid fields to update
      return existing;
    }

    const setClause = fields.map((f) => `${f} = ?`).join(', ');
    const values = fields.map((f) => updateData[f as keyof typeof updateData]);

    await db.execute(`UPDATE users_pii SET ${setClause} WHERE id = ?`, [...values, userId]);

    return this.findByUserId(userId, db);
  }

  /**
   * Delete PII record (hard delete for GDPR)
   *
   * @param userId - User ID
   * @param adapter - Optional partition-specific adapter
   * @returns True if deleted
   */
  async deletePII(userId: string, adapter?: DatabaseAdapter): Promise<boolean> {
    const db = adapter ?? this.adapter;
    const result = await db.execute('DELETE FROM users_pii WHERE id = ?', [userId]);
    return result.rowsAffected > 0;
  }

  /**
   * Convert PII to OIDC UserInfo format
   *
   * @param pii - PII record
   * @param emailVerified - From users_core
   * @param phoneNumberVerified - From users_core
   * @returns OIDC UserInfo object
   */
  toOIDCUserInfo(pii: UserPII, emailVerified: boolean, phoneNumberVerified: boolean): OIDCUserInfo {
    const userInfo: OIDCUserInfo = {
      sub: pii.id,
    };

    // Add claims if present
    if (pii.email) {
      userInfo.email = pii.email;
      userInfo.email_verified = emailVerified;
    }
    if (pii.phone_number) {
      userInfo.phone_number = pii.phone_number;
      userInfo.phone_number_verified = phoneNumberVerified;
    }
    if (pii.name) userInfo.name = pii.name;
    if (pii.given_name) userInfo.given_name = pii.given_name;
    if (pii.family_name) userInfo.family_name = pii.family_name;
    if (pii.nickname) userInfo.nickname = pii.nickname;
    if (pii.preferred_username) userInfo.preferred_username = pii.preferred_username;
    if (pii.picture) userInfo.picture = pii.picture;
    if (pii.website) userInfo.website = pii.website;
    if (pii.gender) userInfo.gender = pii.gender;
    if (pii.birthdate) userInfo.birthdate = pii.birthdate;
    if (pii.locale) userInfo.locale = pii.locale;
    if (pii.zoneinfo) userInfo.zoneinfo = pii.zoneinfo;

    // Address claim (only if any address field is present)
    if (
      pii.address_formatted ||
      pii.address_street_address ||
      pii.address_locality ||
      pii.address_region ||
      pii.address_postal_code ||
      pii.address_country
    ) {
      userInfo.address = {};
      if (pii.address_formatted) userInfo.address.formatted = pii.address_formatted;
      if (pii.address_street_address) userInfo.address.street_address = pii.address_street_address;
      if (pii.address_locality) userInfo.address.locality = pii.address_locality;
      if (pii.address_region) userInfo.address.region = pii.address_region;
      if (pii.address_postal_code) userInfo.address.postal_code = pii.address_postal_code;
      if (pii.address_country) userInfo.address.country = pii.address_country;
    }

    return userInfo;
  }

  /**
   * Search users by tenant
   *
   * @param tenantId - Tenant ID
   * @param options - Pagination options
   * @param adapter - Optional partition-specific adapter
   * @returns Paginated PII records
   */
  async findByTenant(
    tenantId: string,
    options?: PaginationOptions,
    adapter?: DatabaseAdapter
  ): Promise<PaginationResult<UserPII>> {
    const db = adapter ?? this.adapter;
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.min(100, Math.max(1, options?.limit ?? 20));
    const offset = (page - 1) * limit;

    // Count
    const countResult = await db.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM users_pii WHERE tenant_id = ?',
      [tenantId]
    );
    const total = countResult?.count ?? 0;

    // Data
    const items = await db.query<UserPII>(
      'SELECT * FROM users_pii WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [tenantId, limit, offset]
    );

    const totalPages = Math.ceil(total / limit);

    return {
      items,
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  /**
   * Find PII by tenant and email
   *
   * Used for email uniqueness checks during user creation.
   *
   * @param tenantId - Tenant ID
   * @param email - Email address
   * @param adapter - Optional partition-specific adapter
   * @returns PII record or null
   */
  async findByTenantAndEmail(
    tenantId: string,
    email: string,
    adapter?: DatabaseAdapter
  ): Promise<UserPII | null> {
    const db = adapter ?? this.adapter;
    return db.queryOne<UserPII>('SELECT * FROM users_pii WHERE tenant_id = ? AND email = ?', [
      tenantId,
      email,
    ]);
  }

  /**
   * Check if email exists in tenant
   *
   * More efficient than findByTenantAndEmail when only checking existence.
   *
   * @param tenantId - Tenant ID
   * @param email - Email address
   * @param adapter - Optional partition-specific adapter
   * @returns True if email exists
   */
  async emailExists(tenantId: string, email: string, adapter?: DatabaseAdapter): Promise<boolean> {
    const db = adapter ?? this.adapter;
    const result = await db.queryOne<{ id: string }>(
      'SELECT id FROM users_pii WHERE tenant_id = ? AND email = ?',
      [tenantId, email]
    );
    return result !== null;
  }
}
