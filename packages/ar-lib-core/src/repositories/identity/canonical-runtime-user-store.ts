import type { DatabaseAdapter } from '../../db/adapter';
import type { AccountAuthenticationLifecycle } from '../../durable-objects/SessionRevocationStore';
import {
  CanonicalIdentityRepository,
  type IdentityAccountRow,
  type JsonObject,
} from './canonical-identity';
import {
  CanonicalRuntimeUserProjectionRepository,
  CanonicalSensitiveValueResolver,
  type CanonicalRuntimeUserProjection,
  type CanonicalSensitiveUserField,
} from './canonical-runtime-user-projection';
import {
  CanonicalRuntimeUserWriter,
  type CanonicalRuntimeUserWriteInput,
  type CanonicalRuntimeUserWriteResult,
} from './canonical-runtime-user-writer';

export interface CanonicalRuntimeUserStoreOptions {
  coreAdapter: DatabaseAdapter;
  piiAdapter: DatabaseAdapter;
  tenantId: string;
}

export interface CanonicalRuntimeUserCreateInput {
  userId: string;
  email?: string | null;
  name?: string | null;
  active?: boolean;
  emailVerified?: boolean;
  phoneNumberVerified?: boolean;
  userType?: 'end_user' | 'admin' | 'm2m' | 'anonymous' | string;
  sourceRef?: string | null;
  externalId?: string | null;
  passwordHash?: string | null;
  customAttributesJson?: string | null;
  addressJson?: string | null;
  piiFields?: Partial<Record<CanonicalSensitiveUserField, boolean>>;
  sensitiveValues?: Partial<Record<CanonicalSensitiveUserField, unknown>>;
  inlineProfileFields?: Record<string, string | number | boolean | null>;
  metadata?: JsonObject;
}

export interface CanonicalOtpLoginUser {
  id: string;
  email: string;
  name: string | null;
  active: 0 | 1;
  email_verified: 0 | 1;
  account_type: string;
  created_at: string;
}

export interface CanonicalAccountAuthenticationState {
  userId: string;
  accountType: string;
  lifecycle: AccountAuthenticationLifecycle;
  sourceVersionMs: number;
}

export interface CanonicalAuthenticationResponseUser {
  id: string;
  email: string | null;
  name: string | null;
  emailVerified: 0 | 1;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: number | null;
}

export async function markOtpLoginEmailVerified(
  coreAdapter: DatabaseAdapter,
  tenantId: string,
  userId: string,
  timestamp = Date.now()
): Promise<boolean> {
  const result = await coreAdapter.execute(
    `UPDATE contact_points
        SET verification_state = 'verified', updated_at = ?
      WHERE tenant_id = ?
        AND contact_type = 'email'
        AND lifecycle_state = 'active'
        AND verification_state <> 'verified'
        AND (
          account_id IN (
            SELECT id
              FROM identity_accounts
             WHERE tenant_id = ? AND legacy_user_id = ?
          ) OR
          subject_id IN (
            SELECT primary_subject_id
              FROM identity_accounts
             WHERE tenant_id = ? AND legacy_user_id = ?
          )
        )`,
    [timestamp, tenantId, tenantId, userId, tenantId, userId]
  );
  return result.success;
}

interface CanonicalOtpLoginUserRow {
  id: string;
  account_type: string;
  account_lifecycle_state: string;
  subject_lifecycle_state: string;
  directory_publication_state: string;
  display_name: string | null;
  email_verified: number;
  created_at: number;
}

interface CanonicalAccountAuthenticationStateRow {
  user_id: string;
  account_type: string;
  account_lifecycle_state: string;
  subject_lifecycle_state: string;
  directory_publication_state: string;
  account_updated_at: number;
  subject_updated_at: number;
}

function runtimeTimestampToIso(value: number): string {
  const absolute = Math.abs(value);
  const milliseconds =
    absolute < 100_000_000_000
      ? value * 1000
      : absolute < 100_000_000_000_000
        ? value
        : absolute < 100_000_000_000_000_000
          ? value / 1000
          : value / 1_000_000;
  return new Date(milliseconds).toISOString();
}

function runtimeTimestampToMilliseconds(value: number): number {
  const parsed = Date.parse(runtimeTimestampToIso(value));
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('canonical_account_authentication_timestamp_invalid');
  }
  return parsed;
}

function toAccountAuthenticationLifecycle(
  row: CanonicalAccountAuthenticationStateRow
): AccountAuthenticationLifecycle {
  if (
    row.account_lifecycle_state === 'active' &&
    row.subject_lifecycle_state === 'active' &&
    row.directory_publication_state === 'active'
  ) {
    return 'active';
  }
  const candidate =
    row.account_lifecycle_state !== 'active'
      ? row.account_lifecycle_state
      : row.subject_lifecycle_state !== 'active'
        ? row.subject_lifecycle_state
        : 'inactive';
  if (
    candidate === 'suspended' ||
    candidate === 'locked' ||
    candidate === 'deleting' ||
    candidate === 'deleted'
  ) {
    return candidate;
  }
  return 'inactive';
}

export async function findCanonicalAccountAuthenticationState(
  coreAdapter: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<CanonicalAccountAuthenticationState | null> {
  const row = await coreAdapter.queryOne<CanonicalAccountAuthenticationStateRow>(
    `SELECT account.legacy_user_id AS user_id,
            account.account_type AS account_type,
            account.lifecycle_state AS account_lifecycle_state,
            subject.lifecycle_state AS subject_lifecycle_state,
            account.directory_publication_state AS directory_publication_state,
            account.updated_at AS account_updated_at,
            subject.updated_at AS subject_updated_at
       FROM identity_accounts account
       JOIN identity_subjects subject
         ON subject.id = account.primary_subject_id
        AND subject.tenant_id = account.tenant_id
      WHERE account.tenant_id = ?
        AND account.legacy_user_id = ?
      LIMIT 1`,
    [tenantId, userId]
  );
  if (!row) return null;
  return {
    userId: row.user_id,
    accountType: row.account_type,
    lifecycle: toAccountAuthenticationLifecycle(row),
    sourceVersionMs: Math.max(
      runtimeTimestampToMilliseconds(row.account_updated_at),
      runtimeTimestampToMilliseconds(row.subject_updated_at)
    ),
  };
}

function parseJsonObject(value: string | null | undefined): JsonObject {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

function parseJsonValue(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function accountTypeToRuntimeUserType(accountType: string): string {
  if (accountType === 'admin') {
    return 'admin';
  }
  if (accountType === 'service_account') {
    return 'm2m';
  }
  if (accountType === 'anonymous') {
    return 'anonymous';
  }
  return 'end_user';
}

function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized || null;
}

function toCreateInput(input: CanonicalRuntimeUserCreateInput): CanonicalRuntimeUserWriteInput {
  const email = normalizeEmail(input.email);
  return {
    userId: input.userId,
    tenantId: '',
    active: input.active ?? true,
    emailVerified: input.emailVerified ?? false,
    phoneNumberVerified: input.phoneNumberVerified ?? false,
    userType: input.userType ?? 'end_user',
    sourceRef: input.sourceRef ?? null,
    externalId: input.externalId,
    passwordHash: input.passwordHash,
    customAttributesJson: input.customAttributesJson,
    addressJson: input.addressJson,
    piiFields: {
      email: email !== null,
      name: input.name !== undefined && input.name !== null,
      ...(input.piiFields ?? {}),
    },
    sensitiveValues: {
      ...(email !== null ? { email } : {}),
      ...(input.name !== undefined && input.name !== null ? { name: input.name } : {}),
      ...(input.sensitiveValues ?? {}),
    },
    inlineProfileFields: input.inlineProfileFields,
  };
}

/**
 * Canonical runtime-user facade for protocol surfaces.
 *
 * This keeps runtime protocol code off users_core/users_pii while preserving the existing
 * PII/non-PII split: graph rows live in core, sensitive values live in the PII database.
 */
export class CanonicalRuntimeUserStore {
  private readonly repository: CanonicalIdentityRepository;
  private readonly projection: CanonicalRuntimeUserProjectionRepository;
  private readonly writer: CanonicalRuntimeUserWriter;

  constructor(private readonly options: CanonicalRuntimeUserStoreOptions) {
    this.repository = new CanonicalIdentityRepository(options.coreAdapter, options.tenantId);
    this.projection = new CanonicalRuntimeUserProjectionRepository(
      options.coreAdapter,
      options.tenantId,
      new CanonicalSensitiveValueResolver(options.piiAdapter)
    );
    this.writer = new CanonicalRuntimeUserWriter(this.repository, options.piiAdapter);
  }

  async findById(
    userId: string,
    options?: { includeInactive?: boolean }
  ): Promise<CanonicalRuntimeUserProjection | null> {
    return this.projection.findByLegacyUserId(userId, options);
  }

  async findAccountAuthenticationState(
    userId: string
  ): Promise<CanonicalAccountAuthenticationState | null> {
    return findCanonicalAccountAuthenticationState(
      this.options.coreAdapter,
      this.options.tenantId,
      userId
    );
  }

  async findAuthenticationResponseUser(
    userId: string
  ): Promise<CanonicalAuthenticationResponseUser> {
    const [rows, account] = await Promise.all([
      this.options.piiAdapter.query<{ value_key: string; value_json: string | null }>(
        `SELECT value_key, value_json
         FROM identity_sensitive_values
        WHERE tenant_id = ?
          AND owner_type = 'runtime_user'
          AND owner_id = ?
          AND value_key IN ('email', 'name')
          AND lifecycle_state = 'active'`,
        [this.options.tenantId, userId]
      ),
      this.options.coreAdapter.queryOne<{
        created_at: number;
        updated_at: number;
        metadata_json: string | null;
        email_verified: number;
      }>(
        `SELECT account.created_at,
                account.updated_at,
                account.metadata_json,
                COALESCE((
                  SELECT CASE WHEN contact.verification_state = 'verified' THEN 1 ELSE 0 END
                    FROM contact_points contact
                   WHERE contact.tenant_id = account.tenant_id
                     AND (contact.account_id = account.id OR contact.subject_id = account.primary_subject_id)
                     AND contact.contact_type = 'email'
                     AND contact.lifecycle_state = 'active'
                   LIMIT 1
                ), 0) AS email_verified
           FROM identity_accounts account
          WHERE account.tenant_id = ? AND account.legacy_user_id = ?
          LIMIT 1`,
        [this.options.tenantId, userId]
      ),
    ]);
    if (!account) throw new Error('canonical_authentication_response_user_not_found');
    const values = new Map(rows.map((row) => [row.value_key, parseJsonValue(row.value_json)]));
    const email = values.get('email');
    const name = values.get('name');
    const metadata = parseJsonObject(account.metadata_json);
    return {
      id: userId,
      email: typeof email === 'string' ? email : null,
      name: typeof name === 'string' ? name : null,
      emailVerified: account.email_verified ? 1 : 0,
      createdAt: runtimeTimestampToIso(account.created_at),
      updatedAt: runtimeTimestampToIso(account.updated_at),
      lastLoginAt:
        typeof metadata.last_login_at === 'number' && Number.isFinite(metadata.last_login_at)
          ? metadata.last_login_at
          : null,
    };
  }

  async findByEmail(
    email: string,
    options?: { includeInactive?: boolean }
  ): Promise<CanonicalRuntimeUserProjection | null> {
    const normalized = normalizeEmail(email);
    if (!normalized) {
      return null;
    }
    const row = await this.options.piiAdapter.queryOne<{ owner_id: string }>(
      `SELECT owner_id
         FROM identity_sensitive_values
        WHERE tenant_id = ?
          AND owner_type = 'runtime_user'
          AND value_key = 'email'
          AND value_json = ?
          AND lifecycle_state = 'active'
        LIMIT 1`,
      [this.options.tenantId, JSON.stringify(normalized)]
    );
    if (!row) {
      return null;
    }
    return this.findById(row.owner_id, options);
  }

  /**
   * Read only the Core fields needed after an OTP identifier route has already bound the
   * request email to a canonical account. The trusted email comes from that route/challenge,
   * so this avoids a second PII lookup and the full runtime-user projection fan-out.
   */
  async findForOtpLogin(
    userId: string,
    trustedEmail: string,
    options?: { includeInactive?: boolean }
  ): Promise<CanonicalOtpLoginUser | null> {
    const email = normalizeEmail(trustedEmail);
    if (!email) {
      return null;
    }
    const row = await this.options.coreAdapter.queryOne<CanonicalOtpLoginUserRow>(
      `SELECT account.legacy_user_id AS id,
              account.account_type AS account_type,
              account.lifecycle_state AS account_lifecycle_state,
              subject.lifecycle_state AS subject_lifecycle_state,
              account.directory_publication_state AS directory_publication_state,
              account.created_at AS created_at,
              COALESCE(subject.display_label, account.display_label) AS display_name,
              COALESCE(
                (
                  SELECT CASE WHEN contact.verification_state = 'verified' THEN 1 ELSE 0 END
                    FROM contact_points contact
                   WHERE contact.tenant_id = account.tenant_id
                     AND contact.subject_id = subject.id
                     AND contact.contact_type = 'email'
                     AND contact.lifecycle_state = 'active'
                   LIMIT 1
                ),
                (
                  SELECT CASE WHEN contact.verification_state = 'verified' THEN 1 ELSE 0 END
                    FROM contact_points contact
                   WHERE contact.tenant_id = account.tenant_id
                     AND contact.account_id = account.id
                     AND contact.contact_type = 'email'
                     AND contact.lifecycle_state = 'active'
                   LIMIT 1
                ),
                0
              ) AS email_verified
         FROM identity_accounts account
         JOIN identity_subjects subject
           ON subject.id = account.primary_subject_id
          AND subject.tenant_id = account.tenant_id
        WHERE account.tenant_id = ?
          AND account.legacy_user_id = ?
        LIMIT 1`,
      [this.options.tenantId, userId]
    );
    if (!row) {
      return null;
    }
    const active =
      row.account_lifecycle_state === 'active' &&
      row.subject_lifecycle_state === 'active' &&
      row.directory_publication_state === 'active';
    if (!active && !options?.includeInactive) {
      return null;
    }
    return {
      id: row.id,
      email,
      name: row.display_name,
      active: active ? 1 : 0,
      email_verified: row.email_verified ? 1 : 0,
      account_type: row.account_type,
      created_at: runtimeTimestampToIso(row.created_at),
    };
  }

  async findByPreferredUsername(
    preferredUsername: string,
    options?: { includeInactive?: boolean }
  ): Promise<CanonicalRuntimeUserProjection | null> {
    const normalized = preferredUsername.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    const row = await this.options.piiAdapter.queryOne<{ owner_id: string }>(
      `SELECT owner_id
         FROM identity_sensitive_values
        WHERE tenant_id = ?
          AND owner_type = 'runtime_user'
          AND value_key = 'preferred_username'
          AND LOWER(value_json) = ?
          AND lifecycle_state = 'active'
        LIMIT 1`,
      [this.options.tenantId, JSON.stringify(normalized)]
    );
    if (!row) {
      return null;
    }
    return this.findById(row.owner_id, options);
  }

  async syncUser(
    input: CanonicalRuntimeUserCreateInput
  ): Promise<CanonicalRuntimeUserWriteResult | null> {
    const writeInput = toCreateInput(input);
    return this.writer.syncFromRuntimeUser({
      ...writeInput,
      tenantId: this.options.tenantId,
    });
  }

  async deleteUser(userId: string): Promise<boolean> {
    return this.writer.deleteRuntimeUser(userId);
  }

  async markEmailVerified(userId: string): Promise<boolean> {
    const user = await this.findById(userId, { includeInactive: true });
    if (!user) {
      return false;
    }
    await this.writer.syncFromRuntimeUser({
      userId,
      tenantId: this.options.tenantId,
      active: user.active === 1,
      emailVerified: true,
      userType: accountTypeToRuntimeUserType(user.account_type),
      externalId: user.external_id,
      passwordHash: user.password_hash,
      piiFields: {
        email: user.email !== null,
      },
      sensitiveValues: {
        ...(user.email !== null ? { email: user.email } : {}),
      },
    });
    return true;
  }

  async touchLastLogin(userId: string, timestamp = Date.now()): Promise<boolean> {
    const account = await this.repository.findAccountByLegacyUserId(userId, {
      includeInactive: true,
    });
    if (!account) {
      return false;
    }
    await this.updateAccountMetadata(account, { last_login_at: timestamp });
    return true;
  }

  async markEmailVerifiedAndTouchLastLogin(
    userId: string,
    timestamp = Date.now()
  ): Promise<boolean> {
    const account = await this.repository.findAccountByLegacyUserId(userId, {
      includeInactive: true,
    });
    if (!account) {
      return false;
    }
    const metadata = {
      ...parseJsonObject(account.metadata_json),
      last_login_at: timestamp,
    };
    const results = await this.options.coreAdapter.batch([
      {
        sql: `UPDATE contact_points
                 SET verification_state = 'verified', updated_at = ?
               WHERE tenant_id = ?
                 AND contact_type = 'email'
                 AND lifecycle_state = 'active'
                 AND (
                   account_id = ? OR
                   subject_id = ?
                 )`,
        params: [timestamp, this.options.tenantId, account.id, account.primary_subject_id],
      },
      {
        sql: `UPDATE identity_accounts
                 SET metadata_json = ?, updated_at = ?
               WHERE id = ? AND tenant_id = ?`,
        params: [JSON.stringify(metadata), timestamp, account.id, this.options.tenantId],
      },
    ]);
    return results.length === 2 && results[1].success && results[1].rowsAffected > 0;
  }

  /**
   * Mark only the routed account's active email contact as verified.
   *
   * OTP login already resolved the account route and stores last-login state in the
   * user-scoped session revocation DO. Keeping this as one portable DatabaseAdapter statement
   * avoids re-reading the account and rewriting its complete metadata document.
   */
  async markEmailVerifiedForOtpLogin(userId: string, timestamp = Date.now()): Promise<boolean> {
    return markOtpLoginEmailVerified(
      this.options.coreAdapter,
      this.options.tenantId,
      userId,
      timestamp
    );
  }

  private async updateAccountMetadata(
    account: IdentityAccountRow,
    patch: JsonObject
  ): Promise<boolean> {
    const metadata = {
      ...parseJsonObject(account.metadata_json),
      ...patch,
    };
    return this.repository.updateAccountRuntimeFields(account.id, {
      lifecycleState: account.lifecycle_state,
      displayLabel: account.display_label,
      metadata,
    });
  }
}
