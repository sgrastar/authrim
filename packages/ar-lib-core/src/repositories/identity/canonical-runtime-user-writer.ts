import {
  CanonicalIdentityRepository,
  type CanonicalIdentityGraph,
  type CreateProfileAttributeValueInput,
  type IdentityLifecycleState,
} from './canonical-identity';
import {
  encodeLegacyUsersPiiValueRef,
  type LegacyUsersPiiField,
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
  piiFields?: Partial<Record<LegacyUsersPiiField, boolean>>;
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

const PROFILE_FIELD_TO_CATALOG_ID: Partial<Record<LegacyUsersPiiField, string>> = {
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

/**
 * Creates the canonical identity graph for a runtime user write.
 *
 * This class does not write users_core/users_pii. It is the write-side counterpart to
 * CanonicalRuntimeUserProjectionRepository and gives SCIM/JIT/import paths a single canonical
 * target before route-level runtime cutover is enabled.
 */
export class CanonicalRuntimeUserWriter {
  constructor(private readonly repository: CanonicalIdentityRepository) {}

  async createFromRuntimeUser(
    input: CanonicalRuntimeUserWriteInput
  ): Promise<CanonicalRuntimeUserWriteResult> {
    const lifecycleState = toLifecycleState(input.active);
    const graph = await this.repository.createIdentityGraph({
      subject: {
        id: `subject:${input.userId}`,
        tenant_id: input.tenantId,
        subject_type: input.userType === 'm2m' ? 'service_account' : 'person',
        lifecycle_state: lifecycleState,
        display_label: input.displayName ?? null,
      },
      account: {
        id: `account:${input.userId}`,
        tenant_id: input.tenantId,
        account_type: accountTypeFromUserType(input.userType),
        lifecycle_state: lifecycleState,
        legacy_user_id: input.userId,
        display_label: input.displayName ?? null,
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
        locale: input.locale ?? null,
        zoneinfo: input.zoneinfo ?? null,
      },
    });

    let profileAttributeCount = 0;
    let contactPointCount = 0;
    if (graph.profile) {
      profileAttributeCount += await this.createPiiProfileAttributeRefs(input, graph.profile.id);
      profileAttributeCount += await this.createInlineProfileAttributes(input, graph.profile.id);
      profileAttributeCount += await this.createCustomAttributes(input, graph.profile.id);
      await this.createStructuredAddress(input, graph.profile.id);
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
    await this.repository.updateAccountRuntimeFields(account.id, {
      lifecycleState,
      displayLabel: input.displayName ?? null,
    });
    if (account.primary_subject_id) {
      await this.repository.updateSubjectRuntimeFields(account.primary_subject_id, {
        lifecycleState,
        displayLabel: input.displayName ?? null,
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
      await this.upsertStructuredAddress(input, profile.id);
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
      const catalogEntryId = PROFILE_FIELD_TO_CATALOG_ID[field as LegacyUsersPiiField];
      if (!catalogEntryId) {
        continue;
      }
      await this.repository.createProfileAttributeValue({
        id: `profile-attribute:${input.userId}:${field}`,
        tenant_id: input.tenantId,
        profile_id: profileId,
        catalog_entry_id: catalogEntryId,
        value_type: 'reference',
        value_storage_ref: encodeLegacyUsersPiiValueRef({
          tenantId: input.tenantId,
          userId: input.userId,
          field: field as LegacyUsersPiiField,
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
      const catalogEntryId = PROFILE_FIELD_TO_CATALOG_ID[field as LegacyUsersPiiField];
      if (!catalogEntryId) {
        continue;
      }
      await this.repository.upsertProfileAttributeValue({
        id: `profile-attribute:${input.userId}:${field}`,
        tenant_id: input.tenantId,
        profile_id: profileId,
        catalog_entry_id: catalogEntryId,
        value_type: 'reference',
        value_storage_ref: encodeLegacyUsersPiiValueRef({
          tenantId: input.tenantId,
          userId: input.userId,
          field: field as LegacyUsersPiiField,
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
    await this.repository.createProfileAttributeValue({
      id: `profile-attribute:${input.userId}:custom_attributes`,
      tenant_id: input.tenantId,
      profile_id: profileId,
      catalog_entry_id: CUSTOM_ATTRIBUTES_CATALOG_ENTRY_ID,
      value_type: 'json',
      value: customAttributes,
      classification: 'internal',
      purpose: 'profile',
      display_order: 10_000,
    });
    return 1;
  }

  private async upsertCustomAttributes(
    input: CanonicalRuntimeUserWriteInput,
    profileId: string
  ): Promise<number> {
    const attributeValueId = `profile-attribute:${input.userId}:custom_attributes`;
    const customAttributes = parseJsonObject(input.customAttributesJson);
    if (!customAttributes) {
      await this.repository.transitionProfileAttributeValueLifecycle(attributeValueId, 'deleted');
      return 0;
    }
    await this.repository.upsertProfileAttributeValue({
      id: attributeValueId,
      tenant_id: input.tenantId,
      profile_id: profileId,
      catalog_entry_id: CUSTOM_ATTRIBUTES_CATALOG_ENTRY_ID,
      value_type: 'json',
      value: customAttributes,
      classification: 'internal',
      purpose: 'profile',
      display_order: 10_000,
    });
    return 1;
  }

  private async createStructuredAddress(
    input: CanonicalRuntimeUserWriteInput,
    profileId: string
  ): Promise<void> {
    const address = parseJsonObject(input.addressJson);
    if (!address) {
      return;
    }
    await this.repository.createStructuredAttributeValue({
      id: `structured-attribute:${input.userId}:address`,
      tenant_id: input.tenantId,
      owner_type: 'profile',
      owner_id: profileId,
      catalog_entry_id: ADDRESS_CATALOG_ENTRY_ID,
      canonical: address,
      classification: 'confidential',
      lifecycle_state: 'active',
    });
  }

  private async upsertStructuredAddress(
    input: CanonicalRuntimeUserWriteInput,
    profileId: string
  ): Promise<void> {
    const structuredValueId = `structured-attribute:${input.userId}:address`;
    const address = parseJsonObject(input.addressJson);
    if (!address) {
      await this.repository.transitionStructuredAttributeValueLifecycle(
        structuredValueId,
        'deleted'
      );
      return;
    }
    await this.repository.upsertStructuredAttributeValue({
      id: structuredValueId,
      tenant_id: input.tenantId,
      owner_type: 'profile',
      owner_id: profileId,
      catalog_entry_id: ADDRESS_CATALOG_ENTRY_ID,
      canonical: address,
      classification: 'confidential',
      lifecycle_state: 'active',
    });
  }

  private async createContactRefs(
    input: CanonicalRuntimeUserWriteInput,
    subjectId: string,
    accountId: string
  ): Promise<number> {
    let count = 0;
    if (input.piiFields?.email) {
      await this.repository.createContactPoint({
        id: `contact:${input.userId}:email`,
        tenant_id: input.tenantId,
        subject_id: subjectId,
        account_id: accountId,
        contact_type: 'email',
        purpose: 'primary',
        normalized_hash: `legacy-users-pii:${input.userId}:email`,
        value_storage_ref: encodeLegacyUsersPiiValueRef({
          tenantId: input.tenantId,
          userId: input.userId,
          field: 'email',
        }),
        is_primary: true,
        verification_state: input.emailVerified ? 'verified' : 'unverified',
      });
      count += 1;
    }
    if (input.piiFields?.phone_number) {
      await this.repository.createContactPoint({
        id: `contact:${input.userId}:phone`,
        tenant_id: input.tenantId,
        subject_id: subjectId,
        account_id: accountId,
        contact_type: 'phone',
        purpose: 'primary',
        normalized_hash: `legacy-users-pii:${input.userId}:phone`,
        value_storage_ref: encodeLegacyUsersPiiValueRef({
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
    if (input.piiFields?.email) {
      await this.repository.upsertContactPoint({
        id: `contact:${input.userId}:email`,
        tenant_id: input.tenantId,
        subject_id: subjectId,
        account_id: accountId,
        contact_type: 'email',
        purpose: 'primary',
        normalized_hash: `legacy-users-pii:${input.userId}:email`,
        value_storage_ref: encodeLegacyUsersPiiValueRef({
          tenantId: input.tenantId,
          userId: input.userId,
          field: 'email',
        }),
        is_primary: true,
        verification_state: input.emailVerified ? 'verified' : 'unverified',
      });
      count += 1;
    }
    if (input.piiFields?.phone_number) {
      await this.repository.upsertContactPoint({
        id: `contact:${input.userId}:phone`,
        tenant_id: input.tenantId,
        subject_id: subjectId,
        account_id: accountId,
        contact_type: 'phone',
        purpose: 'primary',
        normalized_hash: `legacy-users-pii:${input.userId}:phone`,
        value_storage_ref: encodeLegacyUsersPiiValueRef({
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
        locale: input.locale ?? null,
        zoneinfo: input.zoneinfo ?? null,
      });
      return existingProfile;
    }
    return this.repository.createProfile({
      id: `profile:${input.userId}`,
      tenant_id: input.tenantId,
      subject_id: subjectId,
      lifecycle_state: lifecycleState,
      locale: input.locale ?? null,
      zoneinfo: input.zoneinfo ?? null,
    });
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
