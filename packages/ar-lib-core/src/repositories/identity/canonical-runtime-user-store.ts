import type { DatabaseAdapter } from '../../db/adapter';
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
    const verified = await this.markEmailVerified(userId);
    await this.touchLastLogin(userId, timestamp);
    return verified;
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
