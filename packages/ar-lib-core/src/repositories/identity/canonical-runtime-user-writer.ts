import type { DatabaseAdapter } from '../../db/adapter';
import { getCurrentTimestamp } from '../base';
import {
  CanonicalIdentityRepository,
  type CanonicalIdentityGraph,
  type CreateProfileAttributeValueInput,
  type IdentityLifecycleState,
} from './canonical-identity';
import type { AccountDirectoryPublication } from '../../services/lookup-directory/publication';
import {
  encodeCanonicalSensitiveValueRef,
  type CanonicalSensitiveUserField,
} from './canonical-runtime-user-projection';

export interface CanonicalRuntimeUserWriteInput {
  userId: string;
  tenantId: string;
  active: boolean;
  emailVerified?: boolean;
  phoneNumberVerified?: boolean;
  userType?: 'end_user' | 'admin' | 'm2m' | 'anonymous' | string;
  displayName?: string | null;
  locale?: string | null;
  zoneinfo?: string | null;
  sourceRef?: string | null;
  externalId?: string | null;
  passwordHash?: string | null;
  piiFields?: Partial<Record<CanonicalSensitiveUserField, boolean>>;
  sensitiveValues?: Partial<Record<CanonicalSensitiveUserField, unknown>>;
  inlineProfileFields?: Record<string, string | number | boolean | null>;
  addressJson?: string | null;
  customAttributesJson?: string | null;
}

export interface CanonicalRuntimeUserWriteResult {
  graph: CanonicalIdentityGraph | null;
  profileAttributeCount: number;
  contactPointCount: number;
  created: boolean;
}

const PROFILE_FIELD_TO_CATALOG_ID: Partial<Record<CanonicalSensitiveUserField, string>> = {
  name: 'field.canonical.name',
  given_name: 'field.canonical.given_name',
  family_name: 'field.canonical.family_name',
  middle_name: 'field.canonical.middle_name',
  nickname: 'field.canonical.nickname',
  preferred_username: 'field.canonical.preferred_username',
  profile: 'field.canonical.profile',
  picture: 'field.canonical.picture',
  website: 'field.canonical.website',
  gender: 'field.canonical.gender',
  birthdate: 'field.canonical.birthdate',
  zoneinfo: 'field.canonical.zoneinfo',
  locale: 'field.canonical.locale',
};

const ADDRESS_CATALOG_ENTRY_ID = 'field.canonical.address';
const CUSTOM_ATTRIBUTES_CATALOG_ENTRY_ID = 'field.canonical.custom_attributes';

function toLifecycleState(active: boolean): IdentityLifecycleState {
  return active ? 'active' : 'deprovisioned';
}

function accountTypeFromUserType(userType: string | undefined): string {
  if (userType === 'admin') {
    return 'admin';
  }
  if (userType === 'm2m') {
    return 'service_account';
  }
  if (userType === 'anonymous') {
    return 'anonymous';
  }
  return 'user';
}

function buildAccountMetadata(input: CanonicalRuntimeUserWriteInput): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (input.externalId !== undefined) {
    metadata.external_id = input.externalId;
  }
  if (input.passwordHash !== undefined) {
    metadata.password_hash = input.passwordHash;
  }
  return metadata;
}

/**
 * Creates the canonical identity graph for a runtime user write.
 *
 * This class does not write users_core/users_pii runtime rows. It writes canonical graph rows to
 * the core database and canonical sensitive values to the PII database, preserving the existing
 * PII/non-PII storage boundary.
 */
export class CanonicalRuntimeUserWriter {
  constructor(
    private readonly repository: CanonicalIdentityRepository,
    private readonly sensitiveValueAdapter: DatabaseAdapter
  ) {}

  async createFromRuntimeUser(
    input: CanonicalRuntimeUserWriteInput,
    directoryPublication?: AccountDirectoryPublication
  ): Promise<CanonicalRuntimeUserWriteResult> {
    const lifecycleState = toLifecycleState(input.active);
    const graph = await this.repository.createIdentityGraph(
      {
        subject: {
          id: `subject:${input.userId}`,
          tenant_id: input.tenantId,
          subject_type: input.userType === 'm2m' ? 'service_account' : 'person',
          lifecycle_state: lifecycleState,
          display_label: null,
        },
        account: {
          id: `account:${input.userId}`,
          tenant_id: input.tenantId,
          account_type: accountTypeFromUserType(input.userType),
          lifecycle_state: lifecycleState,
          legacy_user_id: input.userId,
          display_label: null,
          metadata: buildAccountMetadata(input),
        },
        link: {
          id: `subject-account-link:${input.userId}`,
          tenant_id: input.tenantId,
          lifecycle_state: lifecycleState,
          source_ref: input.sourceRef ?? null,
        },
        profile: {
          id: `profile:${input.userId}`,
          tenant_id: input.tenantId,
          lifecycle_state: lifecycleState,
          locale: null,
          zoneinfo: null,
        },
      },
      directoryPublication
    );

    let profileAttributeCount = 0;
    let contactPointCount = 0;
    if (graph.profile) {
      profileAttributeCount += await this.createPiiProfileAttributeRefs(input, graph.profile.id);
      profileAttributeCount += await this.createInlineProfileAttributes(input, graph.profile.id);
      profileAttributeCount += await this.createCustomAttributes(input, graph.profile.id);
      profileAttributeCount += await this.createAddressAttribute(input, graph.profile.id);
    }
    contactPointCount += await this.createContactRefs(input, graph.subject.id, graph.account.id);

    return {
      graph,
      profileAttributeCount,
      contactPointCount,
      created: true,
    };
  }

  async syncFromRuntimeUser(
    input: CanonicalRuntimeUserWriteInput
  ): Promise<CanonicalRuntimeUserWriteResult | null> {
    const account = await this.repository.findAccountByLegacyUserId(input.userId, {
      includeInactive: true,
    });
    if (!account) {
      return this.createFromRuntimeUser(input);
    }

    const lifecycleState = toLifecycleState(input.active);
    const accountRuntimeUpdate: {
      lifecycleState: IdentityLifecycleState;
      displayLabel?: string | null;
      metadata?: Record<string, unknown> | null;
    } = {
      lifecycleState,
      displayLabel: null,
    };
    const accountMetadata = buildAccountMetadata(input);
    if (Object.keys(accountMetadata).length > 0) {
      accountRuntimeUpdate.metadata = accountMetadata;
    }
    await this.repository.updateAccountRuntimeFields(account.id, accountRuntimeUpdate);
    if (account.primary_subject_id) {
      await this.repository.updateSubjectRuntimeFields(account.primary_subject_id, {
        lifecycleState,
        displayLabel: null,
      });
    }
    const profile = account.primary_subject_id
      ? await this.ensureProfile(account.primary_subject_id, input, lifecycleState)
      : null;
    let profileAttributeCount = 0;
    let contactPointCount = 0;
    if (profile) {
      profileAttributeCount += await this.upsertPiiProfileAttributeRefs(input, profile.id);
      profileAttributeCount += await this.upsertInlineProfileAttributes(input, profile.id);
      profileAttributeCount += await this.upsertCustomAttributes(input, profile.id);
      profileAttributeCount += await this.upsertAddressAttribute(input, profile.id);
    }
    if (account.primary_subject_id) {
      contactPointCount += await this.upsertContactRefs(
        input,
        account.primary_subject_id,
        account.id
      );
    }

    return {
      graph: null,
      profileAttributeCount,
      contactPointCount,
      created: false,
    };
  }

  async deleteRuntimeUser(userId: string): Promise<boolean> {
    const account = await this.repository.findAccountByLegacyUserId(userId, {
      includeInactive: true,
    });
    if (!account) {
      return false;
    }
    const accountTransitioned = await this.repository.transitionAccountLifecycle(
      account.id,
      'deleted'
    );
    if (account.primary_subject_id) {
      await this.repository.transitionSubjectLifecycle(account.primary_subject_id, 'deleted');
    }
    await this.sensitiveValueAdapter.execute(
      `UPDATE identity_sensitive_values SET lifecycle_state = ?, updated_at = ?
        WHERE tenant_id = ? AND owner_type = 'runtime_user' AND owner_id = ?`,
      ['deleted', getCurrentTimestamp(), account.tenant_id, userId]
    );
    return accountTransitioned;
  }

  private async createPiiProfileAttributeRefs(
    input: CanonicalRuntimeUserWriteInput,
    profileId: string
  ): Promise<number> {
    let count = 0;
    for (const [field, enabled] of Object.entries(input.piiFields ?? {})) {
      if (!enabled) {
        continue;
      }
      const catalogEntryId = PROFILE_FIELD_TO_CATALOG_ID[field as CanonicalSensitiveUserField];
      if (!catalogEntryId) {
        continue;
      }
      const value = input.sensitiveValues?.[field as CanonicalSensitiveUserField];
      if (value === undefined || value === null) {
        continue;
      }
      await this.upsertSensitiveValue(input, field as CanonicalSensitiveUserField, value);
      await this.repository.createProfileAttributeValue({
        id: `profile-attribute:${input.userId}:${field}`,
        tenant_id: input.tenantId,
        profile_id: profileId,
        catalog_entry_id: catalogEntryId,
        value_type: 'reference',
        value_storage_ref: encodeCanonicalSensitiveValueRef({
          tenantId: input.tenantId,
          userId: input.userId,
          field: field as CanonicalSensitiveUserField,
        }),
        classification: 'sensitive',
        purpose: 'profile',
        display_order: count,
      });
      count += 1;
    }
    return count;
  }

  private async upsertPiiProfileAttributeRefs(
    input: CanonicalRuntimeUserWriteInput,
    profileId: string
  ): Promise<number> {
    let count = 0;
    for (const [field, enabled] of Object.entries(input.piiFields ?? {})) {
      if (!enabled) {
        continue;
      }
      const catalogEntryId = PROFILE_FIELD_TO_CATALOG_ID[field as CanonicalSensitiveUserField];
      if (!catalogEntryId) {
        continue;
      }
      const value = input.sensitiveValues?.[field as CanonicalSensitiveUserField];
      if (value === undefined) {
        continue;
      }
      const attributeValueId = `profile-attribute:${input.userId}:${field}`;
      if (value === null) {
        await this.transitionSensitiveValue(input, field as CanonicalSensitiveUserField, 'deleted');
        await this.repository.transitionProfileAttributeValueLifecycle(attributeValueId, 'deleted');
        continue;
      }
      await this.upsertSensitiveValue(input, field as CanonicalSensitiveUserField, value);
      await this.repository.upsertProfileAttributeValue({
        id: attributeValueId,
        tenant_id: input.tenantId,
        profile_id: profileId,
        catalog_entry_id: catalogEntryId,
        value_type: 'reference',
        value_storage_ref: encodeCanonicalSensitiveValueRef({
          tenantId: input.tenantId,
          userId: input.userId,
          field: field as CanonicalSensitiveUserField,
        }),
        classification: 'sensitive',
        purpose: 'profile',
        display_order: count,
      });
      count += 1;
    }
    return count;
  }

  private async createInlineProfileAttributes(
    input: CanonicalRuntimeUserWriteInput,
    profileId: string
  ): Promise<number> {
    let count = 0;
    for (const [field, value] of Object.entries(input.inlineProfileFields ?? {})) {
      if (value === null) {
        continue;
      }
      const attribute: CreateProfileAttributeValueInput = {
        id: `profile-attribute:${input.userId}:${field}`,
        tenant_id: input.tenantId,
        profile_id: profileId,
        catalog_entry_id: field,
        value_type: typeof value,
        value,
        classification: 'internal',
        purpose: 'profile',
        display_order: count,
      };
      await this.repository.createProfileAttributeValue(attribute);
      count += 1;
    }
    return count;
  }

  private async upsertInlineProfileAttributes(
    input: CanonicalRuntimeUserWriteInput,
    profileId: string
  ): Promise<number> {
    let count = 0;
    for (const [field, value] of Object.entries(input.inlineProfileFields ?? {})) {
      if (value === null) {
        continue;
      }
      await this.repository.upsertProfileAttributeValue({
        id: `profile-attribute:${input.userId}:${field}`,
        tenant_id: input.tenantId,
        profile_id: profileId,
        catalog_entry_id: field,
        value_type: typeof value,
        value,
        classification: 'internal',
        purpose: 'profile',
        display_order: count,
      });
      count += 1;
    }
    return count;
  }

  private async createCustomAttributes(
    input: CanonicalRuntimeUserWriteInput,
    profileId: string
  ): Promise<number> {
    const customAttributes = parseJsonObject(input.customAttributesJson);
    if (!customAttributes) {
      return 0;
    }
    await this.upsertSensitiveValue(input, 'custom_attributes_json', customAttributes);
    await this.repository.createProfileAttributeValue({
      id: `profile-attribute:${input.userId}:custom_attributes`,
      tenant_id: input.tenantId,
      profile_id: profileId,
      catalog_entry_id: CUSTOM_ATTRIBUTES_CATALOG_ENTRY_ID,
      value_type: 'reference',
      value_storage_ref: encodeCanonicalSensitiveValueRef({
        tenantId: input.tenantId,
        userId: input.userId,
        field: 'custom_attributes_json',
      }),
      classification: 'sensitive',
      purpose: 'profile',
      display_order: 10_000,
    });
    return 1;
  }

  private async upsertCustomAttributes(
    input: CanonicalRuntimeUserWriteInput,
    profileId: string
  ): Promise<number> {
    if (input.customAttributesJson === undefined) {
      return 0;
    }
    const attributeValueId = `profile-attribute:${input.userId}:custom_attributes`;
    const customAttributes = parseJsonObject(input.customAttributesJson);
    if (!customAttributes) {
      await this.transitionSensitiveValue(input, 'custom_attributes_json', 'deleted');
      await this.repository.transitionProfileAttributeValueLifecycle(attributeValueId, 'deleted');
      return 0;
    }
    await this.upsertSensitiveValue(input, 'custom_attributes_json', customAttributes);
    await this.repository.upsertProfileAttributeValue({
      id: attributeValueId,
      tenant_id: input.tenantId,
      profile_id: profileId,
      catalog_entry_id: CUSTOM_ATTRIBUTES_CATALOG_ENTRY_ID,
      value_type: 'reference',
      value_storage_ref: encodeCanonicalSensitiveValueRef({
        tenantId: input.tenantId,
        userId: input.userId,
        field: 'custom_attributes_json',
      }),
      classification: 'sensitive',
      purpose: 'profile',
      display_order: 10_000,
    });
    return 1;
  }

  private async createAddressAttribute(
    input: CanonicalRuntimeUserWriteInput,
    profileId: string
  ): Promise<number> {
    const address = parseJsonObject(input.addressJson);
    if (!address) {
      return 0;
    }
    await this.upsertSensitiveValue(input, 'address_json', address);
    await this.repository.createProfileAttributeValue({
      id: `profile-attribute:${input.userId}:address`,
      tenant_id: input.tenantId,
      profile_id: profileId,
      catalog_entry_id: ADDRESS_CATALOG_ENTRY_ID,
      value_type: 'reference',
      value_storage_ref: encodeCanonicalSensitiveValueRef({
        tenantId: input.tenantId,
        userId: input.userId,
        field: 'address_json',
      }),
      classification: 'sensitive',
      purpose: 'profile',
      display_order: 9_000,
    });
    return 1;
  }

  private async upsertAddressAttribute(
    input: CanonicalRuntimeUserWriteInput,
    profileId: string
  ): Promise<number> {
    if (input.addressJson === undefined) {
      return 0;
    }
    const attributeValueId = `profile-attribute:${input.userId}:address`;
    const address = parseJsonObject(input.addressJson);
    if (!address) {
      await this.transitionSensitiveValue(input, 'address_json', 'deleted');
      await this.repository.transitionProfileAttributeValueLifecycle(attributeValueId, 'deleted');
      return 0;
    }
    await this.upsertSensitiveValue(input, 'address_json', address);
    await this.repository.upsertProfileAttributeValue({
      id: attributeValueId,
      tenant_id: input.tenantId,
      profile_id: profileId,
      catalog_entry_id: ADDRESS_CATALOG_ENTRY_ID,
      value_type: 'reference',
      value_storage_ref: encodeCanonicalSensitiveValueRef({
        tenantId: input.tenantId,
        userId: input.userId,
        field: 'address_json',
      }),
      classification: 'sensitive',
      purpose: 'profile',
      display_order: 9_000,
    });
    return 1;
  }

  private async createContactRefs(
    input: CanonicalRuntimeUserWriteInput,
    subjectId: string,
    accountId: string
  ): Promise<number> {
    let count = 0;
    if (
      input.piiFields?.email &&
      input.sensitiveValues?.email !== undefined &&
      input.sensitiveValues.email !== null
    ) {
      await this.upsertSensitiveValue(input, 'email', input.sensitiveValues.email);
      await this.repository.createContactPoint({
        id: `contact:${input.userId}:email`,
        tenant_id: input.tenantId,
        subject_id: subjectId,
        account_id: accountId,
        contact_type: 'email',
        purpose: 'primary',
        normalized_hash: `canonical-sensitive:${input.userId}:email`,
        value_storage_ref: encodeCanonicalSensitiveValueRef({
          tenantId: input.tenantId,
          userId: input.userId,
          field: 'email',
        }),
        is_primary: true,
        verification_state: input.emailVerified ? 'verified' : 'unverified',
      });
      count += 1;
    }
    if (
      input.piiFields?.phone_number &&
      input.sensitiveValues?.phone_number !== undefined &&
      input.sensitiveValues.phone_number !== null
    ) {
      await this.upsertSensitiveValue(input, 'phone_number', input.sensitiveValues.phone_number);
      await this.repository.createContactPoint({
        id: `contact:${input.userId}:phone`,
        tenant_id: input.tenantId,
        subject_id: subjectId,
        account_id: accountId,
        contact_type: 'phone',
        purpose: 'primary',
        normalized_hash: `canonical-sensitive:${input.userId}:phone`,
        value_storage_ref: encodeCanonicalSensitiveValueRef({
          tenantId: input.tenantId,
          userId: input.userId,
          field: 'phone_number',
        }),
        is_primary: true,
        verification_state: input.phoneNumberVerified ? 'verified' : 'unverified',
      });
      count += 1;
    }
    return count;
  }

  private async upsertContactRefs(
    input: CanonicalRuntimeUserWriteInput,
    subjectId: string,
    accountId: string
  ): Promise<number> {
    let count = 0;
    if (input.piiFields?.email && input.sensitiveValues?.email !== undefined) {
      if (input.sensitiveValues.email === null) {
        await this.transitionSensitiveValue(input, 'email', 'deleted');
        await this.repository.upsertContactPoint({
          id: `contact:${input.userId}:email`,
          tenant_id: input.tenantId,
          subject_id: subjectId,
          account_id: accountId,
          contact_type: 'email',
          purpose: 'primary',
          normalized_hash: `canonical-sensitive:${input.userId}:email`,
          value_storage_ref: encodeCanonicalSensitiveValueRef({
            tenantId: input.tenantId,
            userId: input.userId,
            field: 'email',
          }),
          is_primary: true,
          verification_state: input.emailVerified ? 'verified' : 'unverified',
          lifecycle_state: 'deleted',
        });
      } else {
        await this.upsertSensitiveValue(input, 'email', input.sensitiveValues.email);
        await this.repository.upsertContactPoint({
          id: `contact:${input.userId}:email`,
          tenant_id: input.tenantId,
          subject_id: subjectId,
          account_id: accountId,
          contact_type: 'email',
          purpose: 'primary',
          normalized_hash: `canonical-sensitive:${input.userId}:email`,
          value_storage_ref: encodeCanonicalSensitiveValueRef({
            tenantId: input.tenantId,
            userId: input.userId,
            field: 'email',
          }),
          is_primary: true,
          verification_state: input.emailVerified ? 'verified' : 'unverified',
        });
        count += 1;
      }
    }
    if (input.piiFields?.phone_number && input.sensitiveValues?.phone_number !== undefined) {
      if (input.sensitiveValues.phone_number === null) {
        await this.transitionSensitiveValue(input, 'phone_number', 'deleted');
        await this.repository.upsertContactPoint({
          id: `contact:${input.userId}:phone`,
          tenant_id: input.tenantId,
          subject_id: subjectId,
          account_id: accountId,
          contact_type: 'phone',
          purpose: 'primary',
          normalized_hash: `canonical-sensitive:${input.userId}:phone`,
          value_storage_ref: encodeCanonicalSensitiveValueRef({
            tenantId: input.tenantId,
            userId: input.userId,
            field: 'phone_number',
          }),
          is_primary: true,
          verification_state: input.phoneNumberVerified ? 'verified' : 'unverified',
          lifecycle_state: 'deleted',
        });
      } else {
        await this.upsertSensitiveValue(input, 'phone_number', input.sensitiveValues.phone_number);
        await this.repository.upsertContactPoint({
          id: `contact:${input.userId}:phone`,
          tenant_id: input.tenantId,
          subject_id: subjectId,
          account_id: accountId,
          contact_type: 'phone',
          purpose: 'primary',
          normalized_hash: `canonical-sensitive:${input.userId}:phone`,
          value_storage_ref: encodeCanonicalSensitiveValueRef({
            tenantId: input.tenantId,
            userId: input.userId,
            field: 'phone_number',
          }),
          is_primary: true,
          verification_state: input.phoneNumberVerified ? 'verified' : 'unverified',
        });
        count += 1;
      }
    }
    return count;
  }

  private async ensureProfile(
    subjectId: string,
    input: CanonicalRuntimeUserWriteInput,
    lifecycleState: IdentityLifecycleState
  ) {
    const existingProfile = (
      await this.repository.findProfilesForSubject(subjectId, { includeInactive: true })
    )[0];
    if (existingProfile) {
      await this.repository.updateProfileRuntimeFields(existingProfile.id, {
        lifecycleState,
        locale: null,
        zoneinfo: null,
      });
      return existingProfile;
    }
    return this.repository.createProfile({
      id: `profile:${input.userId}`,
      tenant_id: input.tenantId,
      subject_id: subjectId,
      lifecycle_state: lifecycleState,
      locale: null,
      zoneinfo: null,
    });
  }

  private async upsertSensitiveValue(
    input: CanonicalRuntimeUserWriteInput,
    field: CanonicalSensitiveUserField,
    value: unknown
  ): Promise<void> {
    const now = getCurrentTimestamp();
    await this.sensitiveValueAdapter.execute(
      `INSERT INTO identity_sensitive_values (
        id, tenant_id, owner_type, owner_id, value_key, value_json, value_hash,
        classification, lifecycle_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, owner_type, owner_id, value_key) DO UPDATE SET
        value_json = excluded.value_json,
        value_hash = excluded.value_hash,
        classification = excluded.classification,
        lifecycle_state = excluded.lifecycle_state,
        updated_at = excluded.updated_at`,
      [
        `sensitive-value:${input.userId}:${field}`,
        input.tenantId,
        'runtime_user',
        input.userId,
        field,
        JSON.stringify(value),
        null,
        'sensitive',
        'active',
        now,
        now,
      ]
    );
  }

  private async transitionSensitiveValue(
    input: CanonicalRuntimeUserWriteInput,
    field: CanonicalSensitiveUserField,
    lifecycleState: IdentityLifecycleState
  ): Promise<void> {
    const now = getCurrentTimestamp();
    await this.sensitiveValueAdapter.execute(
      `UPDATE identity_sensitive_values SET lifecycle_state = ?, updated_at = ?
        WHERE tenant_id = ? AND owner_type = 'runtime_user' AND owner_id = ? AND value_key = ?`,
      [lifecycleState, now, input.tenantId, input.userId, field]
    );
  }
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}
