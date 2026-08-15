import type {
	IdentityMappingScimSourceAttribute,
	IdentityMappingScimSourceProfileSchema
} from '$lib/api/admin-identity-mapping';
import type { ScimSourceTemplate } from './types';

const CORE_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const ENTERPRISE_USER_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

function attribute(
	name: string,
	label: string,
	type = 'string',
	classification = 'internal',
	required = false,
	valueMultiplicity: 'single' | 'multi' = 'single',
	note?: string
): IdentityMappingScimSourceAttribute {
	return {
		name,
		label,
		type,
		classification,
		required,
		valueMultiplicity,
		nullable: !required,
		note: note ?? null
	};
}

const minimalAttributes: IdentityMappingScimSourceAttribute[] = [
	{ ...attribute('userName', 'User name', 'string', 'pii', true), mappingRequired: true },
	attribute('externalId', 'External ID'),
	attribute('active', 'Active', 'boolean'),
	attribute('displayName', 'Display name', 'string', 'pii'),
	attribute('emails.value', 'Primary email', 'email', 'pii', true)
];

const coreAttributes: IdentityMappingScimSourceAttribute[] = [
	...minimalAttributes,
	attribute('nickName', 'Nickname', 'string', 'pii'),
	attribute('profileUrl', 'Profile URL', 'string', 'public'),
	attribute('title', 'Title'),
	attribute('userType', 'User type'),
	attribute('preferredLanguage', 'Preferred language', 'string', 'public'),
	attribute('locale', 'Locale', 'string', 'public'),
	attribute('timezone', 'Timezone', 'string', 'public'),
	attribute('name.formatted', 'Formatted name', 'string', 'pii'),
	attribute('name.givenName', 'Given name', 'string', 'pii'),
	attribute('name.familyName', 'Family name', 'string', 'pii'),
	attribute('name.middleName', 'Middle name', 'string', 'pii'),
	attribute('name.honorificPrefix', 'Honorific prefix', 'string', 'pii'),
	attribute('name.honorificSuffix', 'Honorific suffix', 'string', 'pii'),
	attribute('emails', 'Email addresses', 'json', 'pii', false, 'multi'),
	attribute('phoneNumbers', 'Phone numbers', 'json', 'pii', false, 'multi'),
	attribute('phoneNumbers.value', 'Primary phone number', 'phone', 'pii'),
	attribute('addresses', 'Addresses', 'json', 'pii', false, 'multi'),
	attribute('addresses.primary', 'Primary address', 'json', 'pii'),
	attribute('groups', 'Group memberships', 'json', 'internal', false, 'multi')
];

const enterpriseAttributes: IdentityMappingScimSourceAttribute[] = [
	attribute('enterprise.employeeNumber', 'Employee number', 'string', 'pii'),
	attribute('enterprise.costCenter', 'Cost center'),
	attribute('enterprise.organization', 'Organization', 'string', 'public'),
	attribute('enterprise.division', 'Division'),
	attribute('enterprise.department', 'Department'),
	attribute('enterprise.manager.value', 'Manager ID', 'string', 'pii')
];

function schema(
	attributes: IdentityMappingScimSourceAttribute[],
	schemaUris = [CORE_USER_SCHEMA]
): IdentityMappingScimSourceProfileSchema {
	return {
		sourceType: 'scim',
		resourceType: 'User',
		schemaUris,
		attributes
	};
}

export const scimSourceTemplates: ScimSourceTemplate[] = [
	{
		id: 'template_source_scim_minimal_user',
		sourceType: 'scim',
		category: 'General settings',
		profileKey: 'scim_minimal_user',
		displayName: 'Minimal SCIM User',
		version: 'v1',
		updatedAt: '2026-08-15',
		description: 'Account provisioning with user name, status, display name, and primary email.',
		schema: schema(minimalAttributes)
	},
	{
		id: 'template_source_scim_core_user',
		sourceType: 'scim',
		category: 'General settings',
		profileKey: 'scim_core_user',
		displayName: 'SCIM Core User',
		version: 'v1',
		updatedAt: '2026-08-15',
		description: 'Common SCIM 2.0 User attributes supported by the inbound mapping adapter.',
		schema: schema(coreAttributes)
	},
	{
		id: 'template_source_scim_enterprise_user',
		sourceType: 'scim',
		category: 'Workforce',
		profileKey: 'scim_enterprise_user',
		displayName: 'SCIM Enterprise User',
		version: 'v1',
		updatedAt: '2026-08-15',
		description:
			'Core User plus employee, organization, department, cost center, and manager attributes.',
		schema: schema(
			[...coreAttributes, ...enterpriseAttributes],
			[CORE_USER_SCHEMA, ENTERPRISE_USER_SCHEMA]
		)
	}
];
