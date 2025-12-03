/**
 * SCIM 2.0 Resource Mapping Utilities
 *
 * Maps between internal database models and SCIM resource formats
 */

import type {
  ScimUser,
  ScimGroup,
  ScimName,
  ScimEmail,
  ScimPhoneNumber,
  ScimAddress,
  UserToScimContext,
  GroupToScimContext,
} from '../types/scim';
import { SCIM_SCHEMAS } from '../types/scim';

/**
 * Internal User model (from database)
 */
export interface InternalUser {
  id: string;
  email: string;
  email_verified: number;
  name?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  middle_name?: string | null;
  nickname?: string | null;
  preferred_username?: string | null;
  profile?: string | null;
  picture?: string | null;
  website?: string | null;
  gender?: string | null;
  birthdate?: string | null;
  zoneinfo?: string | null;
  locale?: string | null;
  phone_number?: string | null;
  phone_number_verified?: number;
  address_json?: string | null;
  updated_at: string;
  created_at: string;
  custom_attributes_json?: string | null;
  password_hash?: string | null;
  external_id?: string | null;
  active?: number;
}

/**
 * Internal Group/Role model (from database)
 */
export interface InternalGroup {
  id: string;
  name: string;
  description?: string | null;
  created_at: string;
  updated_at?: string;
  external_id?: string | null;
}

/**
 * Convert internal user to SCIM User resource
 */
export function userToScim(user: InternalUser, context: UserToScimContext): ScimUser {
  const { baseUrl, includeGroups = false } = context;

  // Parse address if present
  let addresses: ScimAddress[] | undefined;
  if (user.address_json) {
    try {
      const addr = JSON.parse(user.address_json);
      addresses = [
        {
          formatted: addr.formatted,
          streetAddress: addr.street_address,
          locality: addr.locality,
          region: addr.region,
          postalCode: addr.postal_code,
          country: addr.country,
          primary: true,
        },
      ];
    } catch {
      // Ignore invalid JSON
    }
  }

  // Build name object
  const name: ScimName | undefined =
    user.given_name || user.family_name || user.middle_name
      ? {
          formatted: user.name || undefined,
          givenName: user.given_name || undefined,
          familyName: user.family_name || undefined,
          middleName: user.middle_name || undefined,
        }
      : undefined;

  // Build emails array
  const emails: ScimEmail[] = [
    {
      value: user.email,
      type: 'work',
      primary: true,
    },
  ];

  // Build phone numbers array
  const phoneNumbers: ScimPhoneNumber[] | undefined = user.phone_number
    ? [
        {
          value: user.phone_number,
          type: 'work',
          primary: true,
        },
      ]
    : undefined;

  // Parse custom attributes for enterprise extension
  let enterpriseExtension: any = undefined;
  if (user.custom_attributes_json) {
    try {
      const customAttrs = JSON.parse(user.custom_attributes_json);
      if (
        customAttrs.employeeNumber ||
        customAttrs.costCenter ||
        customAttrs.organization ||
        customAttrs.division ||
        customAttrs.department ||
        customAttrs.manager
      ) {
        enterpriseExtension = {
          employeeNumber: customAttrs.employeeNumber,
          costCenter: customAttrs.costCenter,
          organization: customAttrs.organization,
          division: customAttrs.division,
          department: customAttrs.department,
          manager: customAttrs.manager
            ? {
                value: customAttrs.manager,
                $ref: `${baseUrl}/scim/v2/Users/${customAttrs.manager}`,
              }
            : undefined,
        };
      }
    } catch {
      // Ignore invalid JSON
    }
  }

  const scimUser: ScimUser = {
    schemas: [SCIM_SCHEMAS.USER],
    id: user.id,
    externalId: user.external_id || undefined,
    userName: user.preferred_username || user.email,
    name,
    displayName: user.name || undefined,
    nickName: user.nickname || undefined,
    profileUrl: user.profile || undefined,
    title: undefined, // Not in our schema
    userType: undefined, // Not in our schema
    preferredLanguage: user.locale || undefined,
    locale: user.locale || undefined,
    timezone: user.zoneinfo || undefined,
    active: user.active !== undefined ? Boolean(user.active) : true,
    emails,
    phoneNumbers,
    addresses,
    meta: {
      resourceType: 'User',
      created: new Date(user.created_at).toISOString(),
      lastModified: new Date(user.updated_at).toISOString(),
      location: `${baseUrl}/scim/v2/Users/${user.id}`,
      version: generateEtag(user),
    },
  };

  // Add enterprise extension if present
  if (enterpriseExtension) {
    scimUser.schemas.push(SCIM_SCHEMAS.ENTERPRISE_USER);
    scimUser['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'] = enterpriseExtension;
  }

  // TODO: Add groups if requested
  if (includeGroups) {
    // This would require a JOIN or separate query
    scimUser.groups = [];
  }

  return scimUser;
}

/**
 * Convert SCIM User to internal user model
 */
export function scimToUser(scimUser: Partial<ScimUser>): Partial<InternalUser> {
  const user: Partial<InternalUser> = {};

  if (scimUser.externalId) user.external_id = scimUser.externalId;
  if (scimUser.userName) user.preferred_username = scimUser.userName;
  if (scimUser.active !== undefined) user.active = scimUser.active ? 1 : 0;

  // Name fields
  if (scimUser.name) {
    if (scimUser.name.givenName) user.given_name = scimUser.name.givenName;
    if (scimUser.name.familyName) user.family_name = scimUser.name.familyName;
    if (scimUser.name.middleName) user.middle_name = scimUser.name.middleName;
    if (scimUser.name.formatted) user.name = scimUser.name.formatted;
  }

  if (scimUser.displayName) user.name = scimUser.displayName;
  if (scimUser.nickName) user.nickname = scimUser.nickName;
  if (scimUser.profileUrl) user.profile = scimUser.profileUrl;
  if (scimUser.preferredLanguage) user.locale = scimUser.preferredLanguage;
  if (scimUser.timezone) user.zoneinfo = scimUser.timezone;

  // Email (primary)
  if (scimUser.emails && scimUser.emails.length > 0) {
    const primaryEmail = scimUser.emails.find((e) => e.primary) || scimUser.emails[0];
    user.email = primaryEmail.value;
    // Note: email_verified is not set here, as SCIM doesn't provide this info
  }

  // Phone number (primary)
  if (scimUser.phoneNumbers && scimUser.phoneNumbers.length > 0) {
    const primaryPhone = scimUser.phoneNumbers.find((p) => p.primary) || scimUser.phoneNumbers[0];
    user.phone_number = primaryPhone.value;
  }

  // Address (primary)
  if (scimUser.addresses && scimUser.addresses.length > 0) {
    const primaryAddress = scimUser.addresses.find((a) => a.primary) || scimUser.addresses[0];
    user.address_json = JSON.stringify({
      formatted: primaryAddress.formatted,
      street_address: primaryAddress.streetAddress,
      locality: primaryAddress.locality,
      region: primaryAddress.region,
      postal_code: primaryAddress.postalCode,
      country: primaryAddress.country,
    });
  }

  // Password (write-only)
  if (scimUser.password) {
    // Password hashing should be done separately
    user.password_hash = scimUser.password; // Placeholder
  }

  // Enterprise extension
  const enterpriseExt = scimUser['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'];
  if (enterpriseExt) {
    const customAttrs: any = {};
    if (enterpriseExt.employeeNumber) customAttrs.employeeNumber = enterpriseExt.employeeNumber;
    if (enterpriseExt.costCenter) customAttrs.costCenter = enterpriseExt.costCenter;
    if (enterpriseExt.organization) customAttrs.organization = enterpriseExt.organization;
    if (enterpriseExt.division) customAttrs.division = enterpriseExt.division;
    if (enterpriseExt.department) customAttrs.department = enterpriseExt.department;
    if (enterpriseExt.manager?.value) customAttrs.manager = enterpriseExt.manager.value;

    if (Object.keys(customAttrs).length > 0) {
      user.custom_attributes_json = JSON.stringify(customAttrs);
    }
  }

  return user;
}

/**
 * Convert internal group/role to SCIM Group resource
 */
export function groupToScim(
  group: InternalGroup,
  context: GroupToScimContext,
  members?: Array<{ user_id: string; email: string }>
): ScimGroup {
  const { baseUrl, includeMembers = true } = context;

  const scimGroup: ScimGroup = {
    schemas: [SCIM_SCHEMAS.GROUP],
    id: group.id,
    externalId: group.external_id || undefined,
    displayName: group.name,
    meta: {
      resourceType: 'Group',
      created: new Date(group.created_at).toISOString(),
      lastModified: new Date(group.updated_at || group.created_at).toISOString(),
      location: `${baseUrl}/scim/v2/Groups/${group.id}`,
      version: generateEtag(group),
    },
  };

  if (includeMembers && members && members.length > 0) {
    scimGroup.members = members.map((m) => ({
      value: m.user_id,
      $ref: `${baseUrl}/scim/v2/Users/${m.user_id}`,
      type: 'User',
      display: m.email,
    }));
  }

  return scimGroup;
}

/**
 * Convert SCIM Group to internal group model
 */
export function scimToGroup(scimGroup: Partial<ScimGroup>): Partial<InternalGroup> {
  const group: Partial<InternalGroup> = {};

  if (scimGroup.externalId) group.external_id = scimGroup.externalId;
  if (scimGroup.displayName) group.name = scimGroup.displayName;

  return group;
}

/**
 * Generate ETag for versioning
 */
export function generateEtag(resource: any): string {
  // Simple implementation: hash of updated_at timestamp
  const timestamp = resource.updated_at || resource.created_at;
  const date = new Date(timestamp).getTime();
  return `W/"${date}"`;
}

/**
 * Parse ETag from If-Match header
 */
export function parseEtag(etag: string): string {
  return etag.replace(/^W\/"|"$/g, '');
}

/**
 * Apply SCIM Patch operations to a resource
 */
export function applyPatchOperations(
  resource: any,
  operations: Array<{ op: 'add' | 'remove' | 'replace'; path?: string; value?: any }>
): any {
  const result = { ...resource };

  for (const operation of operations) {
    const { op, path, value } = operation;

    if (!path) {
      // No path means replace entire attributes
      if (op === 'replace' || op === 'add') {
        Object.assign(result, value);
      }
      continue;
    }

    // Parse path (simple implementation, doesn't handle complex paths)
    const pathParts = path.split('.');

    switch (op) {
      case 'add':
      case 'replace': {
        let current = result;
        for (let i = 0; i < pathParts.length - 1; i++) {
          const part = pathParts[i];
          if (!current[part]) {
            current[part] = {};
          }
          current = current[part];
        }
        current[pathParts[pathParts.length - 1]] = value;
        break;
      }

      case 'remove': {
        let current = result;
        for (let i = 0; i < pathParts.length - 1; i++) {
          const part = pathParts[i];
          if (!current[part]) {
            break;
          }
          current = current[part];
        }
        delete current[pathParts[pathParts.length - 1]];
        break;
      }
    }
  }

  return result;
}

/**
 * Validate required SCIM User fields
 */
export function validateScimUser(user: Partial<ScimUser>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!user.userName) {
    errors.push('userName is required');
  }

  if (!user.emails || user.emails.length === 0) {
    errors.push('At least one email is required');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate required SCIM Group fields
 */
export function validateScimGroup(group: Partial<ScimGroup>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!group.displayName) {
    errors.push('displayName is required');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
