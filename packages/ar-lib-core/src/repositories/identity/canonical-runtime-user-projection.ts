import type { DatabaseAdapter } from '../../db/adapter';
import type {
  ContactPointRow,
  IdentityAccountRow,
  IdentitySubjectRow,
  ProfileAttributeValueRow,
  ProfileRow,
  StructuredAttributeValueRow,
} from './canonical-identity';

export interface CanonicalRuntimeValueResolver {
  resolveValue(
    valueStorageRef: string,
    context: {
      tenantId: string;
      subjectId: string;
      accountId: string;
      catalogEntryId?: string;
      contactType?: string;
    }
  ): Promise<unknown>;
}

export type LegacyUsersPiiField =
  | 'email'
  | 'phone_number'
  | 'name'
  | 'given_name'
  | 'family_name'
  | 'middle_name'
  | 'nickname'
  | 'preferred_username'
  | 'profile'
  | 'picture'
  | 'website'
  | 'gender'
  | 'birthdate'
  | 'zoneinfo'
  | 'locale'
  | 'address_formatted'
  | 'address_street_address'
  | 'address_locality'
  | 'address_region'
  | 'address_postal_code'
  | 'address_country'
  | 'custom_attributes_json';

export interface LegacyUsersPiiValueRefInput {
  tenantId: string;
  userId: string;
  field: LegacyUsersPiiField;
}

export interface CanonicalRuntimeUserProjection {
  id: string;
  tenant_id: string;
  subject_id: string;
  account_id: string;
  email: string | null;
  email_verified: number;
  name: string | null;
  given_name: string | null;
  family_name: string | null;
  middle_name: string | null;
  nickname: string | null;
  preferred_username: string | null;
  profile: string | null;
  picture: string | null;
  website: string | null;
  gender: string | null;
  birthdate: string | null;
  zoneinfo: string | null;
  locale: string | null;
  phone_number: string | null;
  phone_number_verified: number;
  address_json: string | null;
  password_hash: string | null;
  external_id: string | null;
  active: number;
  custom_attributes_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface CanonicalRuntimeUserProjectionOptions {
  includeInactive?: boolean;
}

const PROFILE_ATTRIBUTE_TO_RUNTIME_FIELD: Record<
  string,
  keyof Pick<
    CanonicalRuntimeUserProjection,
    | 'email'
    | 'name'
    | 'given_name'
    | 'family_name'
    | 'middle_name'
    | 'nickname'
    | 'preferred_username'
    | 'profile'
    | 'picture'
    | 'website'
    | 'gender'
    | 'birthdate'
    | 'zoneinfo'
    | 'locale'
    | 'phone_number'
  >
> = {
  email: 'email',
  'field.canonical.email': 'email',
  name: 'name',
  'field.canonical.name': 'name',
  given_name: 'given_name',
  'field.canonical.given_name': 'given_name',
  family_name: 'family_name',
  'field.canonical.family_name': 'family_name',
  middle_name: 'middle_name',
  'field.canonical.middle_name': 'middle_name',
  nickname: 'nickname',
  'field.canonical.nickname': 'nickname',
  preferred_username: 'preferred_username',
  'field.canonical.preferred_username': 'preferred_username',
  profile: 'profile',
  'field.canonical.profile': 'profile',
  picture: 'picture',
  'field.canonical.picture': 'picture',
  website: 'website',
  'field.canonical.website': 'website',
  gender: 'gender',
  'field.canonical.gender': 'gender',
  birthdate: 'birthdate',
  'field.canonical.birthdate': 'birthdate',
  zoneinfo: 'zoneinfo',
  'field.canonical.zoneinfo': 'zoneinfo',
  locale: 'locale',
  'field.canonical.locale': 'locale',
  phone_number: 'phone_number',
  'field.canonical.phone_number': 'phone_number',
};

const ADDRESS_CATALOG_IDS = new Set(['address', 'field.canonical.address']);
const CUSTOM_ATTRIBUTES_CATALOG_IDS = new Set([
  'custom_attributes',
  'custom_attributes_json',
  'field.canonical.custom_attributes',
]);
const LEGACY_USERS_PII_REF_SCHEME = 'legacy-users-pii:';
const LEGACY_USERS_PII_FIELDS = new Set<string>([
  'email',
  'phone_number',
  'name',
  'given_name',
  'family_name',
  'middle_name',
  'nickname',
  'preferred_username',
  'profile',
  'picture',
  'website',
  'gender',
  'birthdate',
  'zoneinfo',
  'locale',
  'address_formatted',
  'address_street_address',
  'address_locality',
  'address_region',
  'address_postal_code',
  'address_country',
  'custom_attributes_json',
]);

export function encodeLegacyUsersPiiValueRef(input: LegacyUsersPiiValueRefInput): string {
  if (!LEGACY_USERS_PII_FIELDS.has(input.field)) {
    throw new Error('Unsupported legacy users_pii value ref field');
  }
  return `legacy-users-pii://${encodeURIComponent(input.tenantId)}/${encodeURIComponent(
    input.userId
  )}/${encodeURIComponent(input.field)}`;
}

export function decodeLegacyUsersPiiValueRef(valueStorageRef: string): LegacyUsersPiiValueRefInput {
  const parsed = new URL(valueStorageRef);
  if (parsed.protocol !== LEGACY_USERS_PII_REF_SCHEME) {
    throw new Error('Unsupported value storage ref scheme');
  }
  const [userId, field, ...extra] = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  if (!parsed.hostname || !userId || !field || extra.length > 0) {
    throw new Error('Invalid legacy users_pii value ref');
  }
  if (!LEGACY_USERS_PII_FIELDS.has(field)) {
    throw new Error('Unsupported legacy users_pii value ref field');
  }
  return {
    tenantId: decodeURIComponent(parsed.hostname),
    userId,
    field: field as LegacyUsersPiiField,
  };
}

function requireTenantId(tenantId: string): string {
  const normalized = tenantId.trim();
  if (!normalized) {
    throw new Error('CanonicalRuntimeUserProjectionRepository requires tenantId');
  }
  return normalized;
}

function activeClause(includeInactive: boolean | undefined): string {
  return includeInactive ? '' : " AND lifecycle_state = 'active'";
}

function unixToIso(value: number | null | undefined): string {
  return new Date((value ?? 0) * 1000).toISOString();
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

/**
 * Builds the runtime user shape from canonical identity tables.
 *
 * This class is intentionally read-only and does not query users_core/users_pii directly.
 * PII materialization must go through CanonicalRuntimeValueResolver so the cutover can keep
 * canonical identity tables as the runtime source of truth while preserving PII storage boundaries.
 */
export class CanonicalRuntimeUserProjectionRepository {
  private readonly tenantId: string;

  constructor(
    private readonly adapter: DatabaseAdapter,
    tenantId: string,
    private readonly valueResolver: CanonicalRuntimeValueResolver
  ) {
    this.tenantId = requireTenantId(tenantId);
  }

  async findByLegacyUserId(
    legacyUserId: string,
    options?: CanonicalRuntimeUserProjectionOptions
  ): Promise<CanonicalRuntimeUserProjection | null> {
    const account = await this.adapter.queryOne<IdentityAccountRow>(
      `SELECT *
         FROM identity_accounts
        WHERE legacy_user_id = ? AND tenant_id = ?${activeClause(options?.includeInactive)}
        LIMIT 1`,
      [legacyUserId, this.tenantId]
    );
    if (!account) {
      return null;
    }
    return this.projectAccount(account, options);
  }

  async findByAccountId(
    accountId: string,
    options?: CanonicalRuntimeUserProjectionOptions
  ): Promise<CanonicalRuntimeUserProjection | null> {
    const account = await this.adapter.queryOne<IdentityAccountRow>(
      `SELECT *
         FROM identity_accounts
        WHERE id = ? AND tenant_id = ?${activeClause(options?.includeInactive)}
        LIMIT 1`,
      [accountId, this.tenantId]
    );
    if (!account) {
      return null;
    }
    return this.projectAccount(account, options);
  }

  private async projectAccount(
    account: IdentityAccountRow,
    options?: CanonicalRuntimeUserProjectionOptions
  ): Promise<CanonicalRuntimeUserProjection | null> {
    if (!account.primary_subject_id) {
      return null;
    }

    const subject = await this.adapter.queryOne<IdentitySubjectRow>(
      `SELECT *
         FROM identity_subjects
        WHERE id = ? AND tenant_id = ?${activeClause(options?.includeInactive)}
        LIMIT 1`,
      [account.primary_subject_id, this.tenantId]
    );
    if (!subject) {
      return null;
    }

    const profile = await this.adapter.queryOne<ProfileRow>(
      `SELECT *
         FROM profiles
        WHERE subject_id = ? AND tenant_id = ?${activeClause(options?.includeInactive)}
        ORDER BY profile_type ASC, created_at ASC
        LIMIT 1`,
      [subject.id, this.tenantId]
    );

    const projection = this.emptyProjection(account, subject, profile);
    if (profile) {
      await this.applyProfileAttributes(projection, subject, account, profile);
      await this.applyStructuredAddress(projection, profile);
    }
    await this.applyContactPoints(projection, subject, account);
    return projection;
  }

  private emptyProjection(
    account: IdentityAccountRow,
    subject: IdentitySubjectRow,
    profile: ProfileRow | null
  ): CanonicalRuntimeUserProjection {
    return {
      id: account.legacy_user_id ?? account.id,
      tenant_id: this.tenantId,
      subject_id: subject.id,
      account_id: account.id,
      email: null,
      email_verified: 0,
      name: subject.display_label ?? account.display_label,
      given_name: null,
      family_name: null,
      middle_name: null,
      nickname: null,
      preferred_username: null,
      profile: null,
      picture: null,
      website: null,
      gender: null,
      birthdate: null,
      zoneinfo: profile?.zoneinfo ?? null,
      locale: profile?.locale ?? null,
      phone_number: null,
      phone_number_verified: 0,
      address_json: null,
      password_hash: null,
      external_id: null,
      active: account.lifecycle_state === 'active' && subject.lifecycle_state === 'active' ? 1 : 0,
      custom_attributes_json: null,
      created_at: unixToIso(account.created_at),
      updated_at: unixToIso(Math.max(account.updated_at, subject.updated_at)),
    };
  }

  private async applyProfileAttributes(
    projection: CanonicalRuntimeUserProjection,
    subject: IdentitySubjectRow,
    account: IdentityAccountRow,
    profile: ProfileRow
  ): Promise<void> {
    const attributes = await this.adapter.query<ProfileAttributeValueRow>(
      `SELECT *
         FROM profile_attribute_values
        WHERE profile_id = ? AND tenant_id = ?${activeClause(false)}
        ORDER BY display_order ASC, created_at ASC`,
      [profile.id, this.tenantId]
    );
    const customAttributes: Record<string, unknown> = {};

    for (const attribute of attributes) {
      const value = await this.resolveAttributeValue(attribute, subject, account);
      const field = PROFILE_ATTRIBUTE_TO_RUNTIME_FIELD[attribute.catalog_entry_id];
      if (field) {
        projection[field] = toStringOrNull(value);
      } else if (CUSTOM_ATTRIBUTES_CATALOG_IDS.has(attribute.catalog_entry_id)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          Object.assign(customAttributes, value);
        }
      } else if (!ADDRESS_CATALOG_IDS.has(attribute.catalog_entry_id)) {
        customAttributes[attribute.catalog_entry_id] = value;
      }
    }

    if (Object.keys(customAttributes).length > 0) {
      projection.custom_attributes_json = JSON.stringify(customAttributes);
    }
  }

  private async resolveAttributeValue(
    attribute: ProfileAttributeValueRow,
    subject: IdentitySubjectRow,
    account: IdentityAccountRow
  ): Promise<unknown> {
    if (attribute.value_storage_ref) {
      return this.valueResolver.resolveValue(attribute.value_storage_ref, {
        tenantId: this.tenantId,
        subjectId: subject.id,
        accountId: account.id,
        catalogEntryId: attribute.catalog_entry_id,
      });
    }
    return parseJson(attribute.value_json);
  }

  private async applyStructuredAddress(
    projection: CanonicalRuntimeUserProjection,
    profile: ProfileRow
  ): Promise<void> {
    const rows = await this.adapter.query<StructuredAttributeValueRow>(
      `SELECT *
         FROM structured_attribute_values
        WHERE owner_type = ? AND owner_id = ? AND tenant_id = ?${activeClause(false)}
        ORDER BY created_at ASC`,
      ['profile', profile.id, this.tenantId]
    );
    const address = rows.find((row) => ADDRESS_CATALOG_IDS.has(row.catalog_entry_id));
    if (address) {
      projection.address_json = address.canonical_json;
    }
  }

  private async applyContactPoints(
    projection: CanonicalRuntimeUserProjection,
    subject: IdentitySubjectRow,
    account: IdentityAccountRow
  ): Promise<void> {
    const subjectContacts = await this.adapter.query<ContactPointRow>(
      `SELECT *
         FROM contact_points
        WHERE subject_id = ? AND tenant_id = ?${activeClause(false)}
        ORDER BY is_primary DESC, created_at ASC`,
      [subject.id, this.tenantId]
    );
    const accountContacts = subjectContacts.filter((contact) => contact.account_id === account.id);
    const contacts =
      accountContacts.length > 0
        ? accountContacts
        : subjectContacts.filter((contact) => contact.account_id === null);

    for (const contact of contacts) {
      const value = toStringOrNull(
        await this.valueResolver.resolveValue(contact.value_storage_ref, {
          tenantId: this.tenantId,
          subjectId: subject.id,
          accountId: account.id,
          contactType: contact.contact_type,
        })
      );

      if (contact.contact_type === 'email' && projection.email === null) {
        projection.email = value;
        projection.email_verified = contact.verification_state === 'verified' ? 1 : 0;
      }
      if (contact.contact_type === 'phone' && projection.phone_number === null) {
        projection.phone_number = value;
        projection.phone_number_verified = contact.verification_state === 'verified' ? 1 : 0;
      }
    }
  }
}

export class LegacyUsersPiiValueResolver implements CanonicalRuntimeValueResolver {
  constructor(private readonly piiAdapter: DatabaseAdapter) {}

  async resolveValue(valueStorageRef: string, context: { tenantId: string }): Promise<unknown> {
    const ref = decodeLegacyUsersPiiValueRef(valueStorageRef);
    if (ref.tenantId !== context.tenantId) {
      throw new Error('legacy users_pii value ref tenant mismatch');
    }
    const row = await this.piiAdapter.queryOne<Record<string, unknown>>(
      `SELECT ${ref.field} FROM users_pii WHERE id = ? AND tenant_id = ?`,
      [ref.userId, ref.tenantId]
    );
    return row?.[ref.field] ?? null;
  }
}
