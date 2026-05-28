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
    await this.repository.transitionAccountLifecycle(account.id, lifecycleState);
    if (account.primary_subject_id) {
      await this.repository.transitionSubjectLifecycle(account.primary_subject_id, lifecycleState);
    }

    return {
      graph: null,
      profileAttributeCount: 0,
      contactPointCount: 0,
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
}
