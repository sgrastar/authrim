import type { DestinationTemplate } from './types';

const URI_NAME_FORMAT = 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri';
const BASIC_NAME_FORMAT = 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic';
const PERSISTENT_NAME_ID = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
const EMAIL_NAME_ID = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

type Classification = 'internal' | 'public' | 'pii' | 'regulated';

interface SamlAttributeTemplate {
	name: string;
	label: string;
	nameFormat: string;
	valueType: string;
	format?: string;
	classification: Classification;
	required?: boolean;
	examples?: string[];
	note?: string;
	allowedValues?: string[];
	valueMultiplicity?: 'single' | 'multi';
	nullable?: boolean;
	releasePolicy: {
		legalBasis: 'consent' | 'contract';
		purpose: 'attribute_release';
	};
}

const EDU_PERSON_AFFILIATION_VALUES = [
	'faculty',
	'student',
	'staff',
	'alum',
	'member',
	'affiliate',
	'employee',
	'library-walk-in'
];
const GAKUNIN_AFFILIATION_VALUES = ['faculty', 'staff', 'student', 'member'];
const KAFE_AFFILIATION_VALUES = [
	'student',
	'faculty',
	'staff',
	'employee',
	'member',
	'affiliate',
	'alum'
];
const SWITCH_AFFILIATION_VALUES = [
	'faculty',
	'student',
	'staff',
	'alum',
	'member',
	'affiliate',
	'library-walk-in'
];
const SWISS_HOME_ORGANIZATION_TYPE_VALUES = [
	'university',
	'uas',
	'hospital',
	'library',
	'tertiaryb',
	'uppersecondary',
	'vho',
	'others'
];

function withMeta(
	attribute: SamlAttributeTemplate,
	meta: Partial<
		Pick<
			SamlAttributeTemplate,
			'examples' | 'note' | 'allowedValues' | 'valueMultiplicity' | 'nullable'
		>
	>
): SamlAttributeTemplate {
	return { ...attribute, ...meta };
}

function uriAttribute(
	oid: string,
	label: string,
	valueType = 'string',
	classification: Classification = 'pii',
	required = false
): SamlAttributeTemplate {
	return {
		name: `urn:oid:${oid}`,
		label,
		nameFormat: URI_NAME_FORMAT,
		valueType,
		classification,
		required,
		releasePolicy: { legalBasis: 'consent', purpose: 'attribute_release' }
	};
}

function basicAttribute(
	name: string,
	label: string,
	valueType = 'string',
	classification: Classification = 'pii',
	required = false
): SamlAttributeTemplate {
	return {
		name,
		label,
		nameFormat: BASIC_NAME_FORMAT,
		valueType,
		classification,
		required,
		releasePolicy: { legalBasis: 'consent', purpose: 'attribute_release' }
	};
}

function contractAttribute(
	name: string,
	label: string,
	valueType = 'string',
	required = false
): SamlAttributeTemplate {
	return {
		name,
		label,
		nameFormat: BASIC_NAME_FORMAT,
		valueType,
		classification: 'pii',
		required,
		releasePolicy: { legalBasis: 'contract', purpose: 'attribute_release' }
	};
}

function vendorAttribute(
	name: string,
	label: string,
	valueType = 'string',
	classification: Classification = 'pii',
	required = false,
	format?: string
): SamlAttributeTemplate {
	return {
		name,
		label,
		nameFormat: BASIC_NAME_FORMAT,
		valueType,
		...(format ? { format } : {}),
		classification,
		required,
		releasePolicy: { legalBasis: 'contract', purpose: 'attribute_release' }
	};
}

function vendorUriAttribute(
	name: string,
	label: string,
	valueType = 'string',
	classification: Classification = 'pii',
	required = false,
	format?: string
): SamlAttributeTemplate {
	return {
		name,
		label,
		nameFormat: URI_NAME_FORMAT,
		valueType,
		...(format ? { format } : {}),
		classification,
		required,
		releasePolicy: { legalBasis: 'contract', purpose: 'attribute_release' }
	};
}

const attr = {
	mail: (required = false) =>
		withMeta(uriAttribute('0.9.2342.19200300.100.1.3', 'mail', 'email', 'pii', required), {
			examples: ['person@example.edu'],
			note: 'Mailbox address for the subject. Many federation profiles treat this as personal data.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	sn: (required = false) =>
		withMeta(uriAttribute('2.5.4.4', 'sn', 'string', 'pii', required), {
			examples: ['Yamada'],
			note: 'Surname or family name.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	o: (required = false) =>
		withMeta(uriAttribute('2.5.4.10', 'o', 'string', 'public', required), {
			examples: ['Example University'],
			note: 'Organization name associated with the subject.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	organizationName: (required = false) =>
		withMeta(uriAttribute('2.5.4.10', 'organizationName', 'string', 'public', required), {
			examples: ['Korea Advanced Institute of Science and Technology'],
			note: 'KAFE uses this as the organization name attribute.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	ou: (required = false) =>
		withMeta(uriAttribute('2.5.4.11', 'ou', 'string', 'public', required), {
			examples: ['Library Services'],
			note: 'Organizational unit name.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	givenName: (required = false) =>
		withMeta(uriAttribute('2.5.4.42', 'givenName', 'string', 'pii', required), {
			examples: ['Taro'],
			note: 'Given name or first name.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	cn: (required = false) =>
		withMeta(uriAttribute('2.5.4.3', 'cn', 'string', 'pii', required), {
			examples: ['Taro Yamada'],
			note: 'Common name. This can be multi-valued in directory schemas, but many SAML releases send one display-friendly value.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	displayName: (required = false) =>
		withMeta(uriAttribute('2.16.840.1.113730.3.1.241', 'displayName', 'string', 'pii', required), {
			examples: ['Taro Yamada'],
			note: 'Preferred display name for white-pages-like applications.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	uid: (required = false) =>
		withMeta(uriAttribute('0.9.2342.19200300.100.1.1', 'uid', 'string', 'pii', required), {
			examples: ['taro.yamada'],
			note: 'Local user identifier. KAFE recommends avoiding UID for cross-organization services.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	preferredLanguage: (required = false) =>
		withMeta(
			uriAttribute('2.16.840.1.113730.3.1.39', 'preferredLanguage', 'string', 'public', required),
			{
				examples: ['ja', 'en-US'],
				note: 'Preferred language tag for the subject.',
				valueMultiplicity: 'single',
				nullable: !required
			}
		),
	eduPersonAffiliation: (required = false) => ({
		...uriAttribute(
			'1.3.6.1.4.1.5923.1.1.1.1',
			'eduPersonAffiliation',
			'string',
			'public',
			required
		),
		allowedValues: EDU_PERSON_AFFILIATION_VALUES,
		valueMultiplicity: 'multi' as const,
		nullable: !required,
		examples: ['student', 'member'],
		note: 'Controlled eduPerson affiliation vocabulary. A subject can carry more than one affiliation.'
	}),
	eduPersonPrincipalName: (required = false) =>
		withMeta(
			uriAttribute('1.3.6.1.4.1.5923.1.1.1.6', 'eduPersonPrincipalName', 'string', 'pii', required),
			{
				examples: ['taro.yamada@example.ac.jp'],
				note: 'Scoped identifier in user@scope form. It may be reassigned depending on local policy.',
				valueMultiplicity: 'single',
				nullable: !required
			}
		),
	eduPersonEntitlement: (required = false) =>
		withMeta(
			uriAttribute(
				'1.3.6.1.4.1.5923.1.1.1.7',
				'eduPersonEntitlement',
				'string',
				'public',
				required
			),
			{
				examples: ['urn:mace:dir:entitlement:common-lib-terms'],
				note: 'URI value, usually URL or URN, representing a right to a resource.',
				valueMultiplicity: 'multi',
				nullable: !required
			}
		),
	eduPersonScopedAffiliation: (required = false) =>
		withMeta(
			uriAttribute(
				'1.3.6.1.4.1.5923.1.1.1.9',
				'eduPersonScopedAffiliation',
				'string',
				'public',
				required
			),
			{
				examples: ['student@example.ac.jp', 'member@example.ac.jp'],
				note: `Scoped affiliation in role@scope form. The role component should be one of: ${EDU_PERSON_AFFILIATION_VALUES.join(', ')}.`,
				valueMultiplicity: 'multi',
				nullable: !required
			}
		),
	eduPersonTargetedID: (required = false) =>
		withMeta(
			uriAttribute(
				'1.3.6.1.4.1.5923.1.1.1.10',
				'eduPersonTargetedID',
				'saml:persistent-nameid',
				'internal',
				required
			),
			{
				examples: ['https://idp.example.edu/idp/shibboleth!https://sp.example.org!a6c2c4d4'],
				note: 'Persistent, non-reassigned, opaque identifier scoped to an IdP/SP relationship. Deprecated in newer eduPerson guidance in favor of subject-id/pairwise-id.',
				valueMultiplicity: 'single',
				nullable: !required
			}
		),
	eduPersonAssurance: (required = false) =>
		withMeta(
			uriAttribute('1.3.6.1.4.1.5923.1.1.1.11', 'eduPersonAssurance', 'string', 'public', required),
			{
				examples: ['https://refeds.org/assurance/ID/unique'],
				note: 'URI asserting an identity assurance profile. Relying parties should ignore unrecognized values.',
				valueMultiplicity: 'multi',
				nullable: !required
			}
		),
	eduPersonUniqueId: (required = false) =>
		withMeta(
			uriAttribute('1.3.6.1.4.1.5923.1.1.1.13', 'eduPersonUniqueId', 'string', 'pii', required),
			{
				examples: ['28c5353b8bb34984a8bd4169ba94c606@example.edu'],
				note: 'Long-lived, non-reassignable, omnidirectional scoped identifier.',
				valueMultiplicity: 'single',
				nullable: !required
			}
		),
	eduPersonOrcid: (required = false) =>
		withMeta(
			uriAttribute('1.3.6.1.4.1.5923.1.1.1.16', 'eduPersonOrcid', 'string', 'public', required),
			{
				examples: ['https://orcid.org/0000-0002-1825-0097'],
				note: 'ORCID iD in ORCID-preferred URL representation.',
				valueMultiplicity: 'multi',
				nullable: !required
			}
		),
	isMemberOf: (required = false) =>
		withMeta(uriAttribute('1.3.6.1.4.1.5923.1.5.1.1', 'isMemberOf', 'string', 'public', required), {
			examples: ['https://groups.example.edu/library-users'],
			note: 'Group identifiers for groups to which the subject belongs. Use well-formed URIs when global uniqueness matters.',
			valueMultiplicity: 'multi',
			nullable: !required
		}),
	schacHomeOrganization: (required = false) =>
		withMeta(
			uriAttribute(
				'1.3.6.1.4.1.25178.1.2.9',
				'schacHomeOrganization',
				'string',
				'public',
				required
			),
			{
				examples: ['example.edu'],
				note: 'Home organization DNS domain. SAML issuers should publish matching Scope metadata.',
				valueMultiplicity: 'single',
				nullable: !required
			}
		),
	schacHomeOrganizationType: (required = false) =>
		withMeta(
			uriAttribute(
				'1.3.6.1.4.1.25178.1.2.10',
				'schacHomeOrganizationType',
				'string',
				'public',
				required
			),
			{
				examples: [
					'urn:schac:homeOrganizationType:jp:university',
					'urn:schac:homeOrganizationType:int:other'
				],
				note: 'SCHAC URN in urn:schac:homeOrganizationType:<country-code>:<string> form.',
				valueMultiplicity: 'multi',
				nullable: !required
			}
		),
	schacPersonalUniqueCode: (required = false) =>
		withMeta(
			uriAttribute(
				'1.3.6.1.4.1.25178.1.2.14',
				'schacPersonalUniqueCode',
				'string',
				'pii',
				required
			),
			{
				examples: ['urn:schac:personalUniqueCode:int:esi:example.edu:123456'],
				note: 'SCHAC personal unique code in urn:schac:personalUniqueCode:<country-code>:<string> form.',
				valueMultiplicity: 'multi',
				nullable: !required
			}
		),
	jaSn: (required = false) =>
		withMeta(uriAttribute('1.3.6.1.4.1.32264.1.1.1', 'jaSn', 'string', 'pii', required), {
			examples: ['山田'],
			note: 'GakuNin Japanese surname attribute.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	jaGivenName: (required = false) =>
		withMeta(uriAttribute('1.3.6.1.4.1.32264.1.1.2', 'jaGivenName', 'string', 'pii', required), {
			examples: ['太郎'],
			note: 'GakuNin Japanese given name attribute.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	jaDisplayName: (required = false) =>
		withMeta(uriAttribute('1.3.6.1.4.1.32264.1.1.3', 'jaDisplayName', 'string', 'pii', required), {
			examples: ['山田 太郎'],
			note: 'GakuNin Japanese display name attribute.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	jaOrganizationName: (required = false) =>
		withMeta(
			uriAttribute('1.3.6.1.4.1.32264.1.1.4', 'jaOrganizationName', 'string', 'public', required),
			{
				examples: ['国立情報学研究所'],
				note: 'GakuNin Japanese organization name attribute.',
				valueMultiplicity: 'single',
				nullable: !required
			}
		),
	jaOrganizationalUnitName: (required = false) =>
		withMeta(
			uriAttribute(
				'1.3.6.1.4.1.32264.1.1.5',
				'jaOrganizationalUnitName',
				'string',
				'public',
				required
			),
			{
				examples: ['学術基盤推進部'],
				note: 'GakuNin Japanese organizational unit name attribute.',
				valueMultiplicity: 'single',
				nullable: !required
			}
		),
	gakuninScopedPersonalUniqueCode: (required = false) =>
		withMeta(
			uriAttribute(
				'1.3.6.1.4.1.32264.1.1.6',
				'gakuninScopedPersonalUniqueCode',
				'string',
				'pii',
				required
			),
			{
				examples: ['faculty:12345@example.ac.jp', 'student:abcdefg@example.ac.jp'],
				note: 'GakuNin scoped personal unique code in affiliation:identifier@scope form. GakuNin examples use affiliation values such as faculty and student.',
				valueMultiplicity: 'multi',
				nullable: !required
			}
		),
	koCommonName: (required = false) =>
		withMeta(
			uriAttribute('1.3.6.1.4.1.14305.1.10.1.4.3', 'koCommonName', 'string', 'pii', required),
			{
				examples: ['홍길동'],
				note: 'KAFE Korean common name attribute.',
				valueMultiplicity: 'single',
				nullable: !required
			}
		),
	koGivenName: (required = false) =>
		withMeta(
			uriAttribute('1.3.6.1.4.1.14305.1.10.1.4.22', 'koGivenName', 'string', 'pii', required),
			{
				examples: ['길동'],
				note: 'KAFE Korean given name attribute.',
				valueMultiplicity: 'single',
				nullable: !required
			}
		),
	koSurname: (required = false) =>
		withMeta(uriAttribute('1.3.6.1.4.1.14305.1.10.1.4.4', 'koSurname', 'string', 'pii', required), {
			examples: ['홍'],
			note: 'KAFE Korean surname attribute.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	koOrganizationName: (required = false) =>
		withMeta(
			uriAttribute(
				'1.3.6.1.4.1.14305.1.10.1.4.10',
				'koOrganizationName',
				'string',
				'public',
				required
			),
			{
				examples: ['한국과학기술정보연구원'],
				note: 'KAFE Korean organization name attribute.',
				valueMultiplicity: 'single',
				nullable: !required
			}
		),
	koOrganizationUnitName: (required = false) =>
		withMeta(
			uriAttribute(
				'1.3.6.1.4.1.14305.1.10.1.4.11',
				'koOrganizationUnitName',
				'string',
				'public',
				required
			),
			{
				examples: ['디지털서비스센터'],
				note: 'KAFE Korean organizational unit name attribute.',
				valueMultiplicity: 'single',
				nullable: !required
			}
		),
	koHomePostalAddress: (required = false) =>
		withMeta(
			uriAttribute(
				'1.3.6.1.4.1.14305.1.10.1.1.39',
				'koHomePostalAddress',
				'string',
				'pii',
				required
			),
			{
				examples: ['대전광역시 유성구 대학로 245'],
				note: 'KAFE Korean home postal address attribute.',
				valueMultiplicity: 'single',
				nullable: !required
			}
		),
	koPostalAddress: (required = false) =>
		withMeta(
			uriAttribute('1.3.6.1.4.1.14305.1.10.1.4.16', 'koPostalAddress', 'string', 'pii', required),
			{
				examples: ['대전광역시 유성구 대학로 245'],
				note: 'KAFE Korean postal address for company or school address.',
				valueMultiplicity: 'single',
				nullable: !required
			}
		),
	koResearcherNumber: (required = false) =>
		withMeta(
			uriAttribute(
				'1.3.6.1.4.1.14305.1.10.1.1.16',
				'koResearcherNumber',
				'string',
				'pii',
				required
			),
			{
				examples: ['12345678'],
				note: 'KAFE researcher registration number attribute.',
				valueMultiplicity: 'single',
				nullable: !required
			}
		),
	koOrganizationCode: (required = false) =>
		withMeta(
			uriAttribute(
				'1.3.6.1.4.1.14305.1.10.1.4.12',
				'koOrganizationCode',
				'string',
				'public',
				required
			),
			{
				examples: ['B551179'],
				note: 'KAFE Korean organization code attribute.',
				valueMultiplicity: 'single',
				nullable: !required
			}
		),
	swissEduPersonUniqueID: (required = false) =>
		withMeta(
			uriAttribute('2.16.756.1.2.5.1.1.1', 'swissEduPersonUniqueID', 'string', 'pii', required),
			{
				examples: ['123456789@example.ch'],
				note: 'SWITCH edu-ID organizational unique identifier.',
				valueMultiplicity: 'single',
				nullable: !required
			}
		),
	swissEduPersonHomeOrganization: (required = false) =>
		withMeta(
			uriAttribute(
				'2.16.756.1.2.5.1.1.4',
				'swissEduPersonHomeOrganization',
				'string',
				'public',
				required
			),
			{
				examples: ['ethz.ch', 'unil.ch'],
				note: 'SWITCH edu-ID home organization domain name.',
				valueMultiplicity: 'single',
				nullable: !required
			}
		),
	swissEduPersonHomeOrganizationType: (required = false) =>
		withMeta(
			uriAttribute(
				'2.16.756.1.2.5.1.1.5',
				'swissEduPersonHomeOrganizationType',
				'string',
				'public',
				required
			),
			{
				examples: ['university', 'vho', 'hospital'],
				note: 'SWITCH edu-ID controlled vocabulary for home organization type.',
				allowedValues: SWISS_HOME_ORGANIZATION_TYPE_VALUES,
				valueMultiplicity: 'single',
				nullable: !required
			}
		)
};

function affiliationForProfile(
	attribute: SamlAttributeTemplate,
	values: string[],
	profileName: string
): SamlAttributeTemplate {
	return withMeta(attribute, {
		allowedValues: values,
		examples: values.includes('member') ? ['student', 'member'] : [values[0]],
		note: `${profileName} affiliation vocabulary: ${values.join(', ')}.`,
		valueMultiplicity: 'multi',
		nullable: !attribute.required
	});
}

function scopedAffiliationForProfile(
	attribute: SamlAttributeTemplate,
	values: string[],
	profileName: string,
	scope: string
): SamlAttributeTemplate {
	const examples = values.slice(0, 2).map((value) => `${value}@${scope}`);
	return withMeta(attribute, {
		examples,
		note: `${profileName} scoped affiliation in role@scope form. Allowed role component: ${values.join(', ')}.`,
		valueMultiplicity: 'multi',
		nullable: !attribute.required
	});
}

function switchAffiliation(attribute: SamlAttributeTemplate): SamlAttributeTemplate {
	return affiliationForProfile(attribute, SWITCH_AFFILIATION_VALUES, 'SWITCH edu-ID');
}

function switchScopedAffiliation(attribute: SamlAttributeTemplate): SamlAttributeTemplate {
	return scopedAffiliationForProfile(
		attribute,
		SWITCH_AFFILIATION_VALUES,
		'SWITCH edu-ID',
		'ethz.ch'
	);
}

function samlSchema(nameIdSource: string, attributes: SamlAttributeTemplate[]) {
	return {
		destinationType: 'saml',
		samlFlow: 'outbound',
		nameId: {
			format: PERSISTENT_NAME_ID,
			source: nameIdSource
		},
		attributes
	};
}

function emailNameIdSchema(nameIdSource: string, attributes: SamlAttributeTemplate[]) {
	return {
		destinationType: 'saml',
		samlFlow: 'outbound',
		nameId: {
			format: EMAIL_NAME_ID,
			source: nameIdSource
		},
		attributes
	};
}

const vendor = {
	email: (name = 'email', required = true) =>
		withMeta(vendorAttribute(name, 'Email', 'email', 'pii', required, 'email'), {
			examples: ['person@example.com'],
			note: 'Email address used by the service provider for account lookup, notification, or just-in-time account creation.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	firstName: (name = 'firstName', required = false) =>
		withMeta(vendorAttribute(name, 'First name', 'string', 'pii', required), {
			examples: ['Taro'],
			note: 'Given name released to populate the user profile in the service provider.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	lastName: (name = 'lastName', required = false) =>
		withMeta(vendorAttribute(name, 'Last name', 'string', 'pii', required), {
			examples: ['Yamada'],
			note: 'Family name released to populate the user profile in the service provider.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	displayName: (name = 'displayName', required = false) =>
		withMeta(vendorAttribute(name, 'Display name', 'string', 'pii', required), {
			examples: ['Taro Yamada'],
			note: 'Human-readable name displayed by the service provider.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	groups: (name = 'groups', required = false) =>
		withMeta(vendorAttribute(name, 'Groups', 'string', 'public', required), {
			examples: ['Engineering', 'Admins'],
			note: 'Group names or identifiers used by the service provider for authorization or provisioning decisions.',
			valueMultiplicity: 'multi',
			nullable: !required
		}),
	role: (name = 'role', required = false) =>
		withMeta(vendorAttribute(name, 'Role', 'string', 'public', required), {
			examples: ['agent', 'admin'],
			note: 'Application role or license class to assign in the service provider.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	externalId: (name = 'external_id', required = false) =>
		withMeta(vendorAttribute(name, 'External ID', 'identifier', 'internal', required), {
			examples: ['emp-10042'],
			note: 'Stable external identifier used to correlate the user with an existing service-provider account.',
			valueMultiplicity: 'single',
			nullable: !required
		}),
	employeeId: (name = 'employeeID', required = false) =>
		withMeta(vendorAttribute(name, 'Employee ID', 'identifier', 'pii', required), {
			examples: ['E10042'],
			note: 'Workforce employee identifier used by HR or enterprise applications.',
			valueMultiplicity: 'single',
			nullable: !required
		})
};

export const samlDestinationTemplates: DestinationTemplate[] = [
	{
		id: 'template_destination_saml_standard',
		destinationType: 'saml',
		category: 'General settings',
		profileKey: 'standard_saml_attributes',
		displayName: 'Standard SAML attributes',
		version: 'v1',
		updatedAt: '2026-06-02',
		description: 'Common SAML NameID and attribute release profile for SP assertions.',
		schema: samlSchema('subject_identifier', [attr.mail(true)])
	},
	{
		id: 'template_destination_saml_refeds_rs',
		destinationType: 'saml',
		category: 'Academic federation',
		profileKey: 'refeds_research_and_scholarship',
		displayName: 'REFEDS Research and Scholarship',
		version: 'v1',
		updatedAt: '2026-06-02',
		description:
			'Research and Scholarship bundle with identifier, person name, mail, and affiliation.',
		schema: samlSchema('subject_identifier', [
			attr.eduPersonPrincipalName(true),
			attr.mail(true),
			attr.displayName(true),
			attr.givenName(),
			attr.sn(),
			attr.eduPersonTargetedID(),
			attr.eduPersonScopedAffiliation()
		])
	},
	{
		id: 'template_destination_saml_gakunin_application_standard',
		destinationType: 'saml',
		category: 'Academic federation',
		profileKey: 'gakunin_application_standard_v2_8',
		displayName: 'GakuNin application standard',
		version: 'v2.8',
		updatedAt: '2024-03',
		description:
			'GakuNin academic federation attributes including Japanese name and organization attributes.',
		schema: samlSchema('subject_identifier', [
			attr.eduPersonPrincipalName(true),
			attr.eduPersonTargetedID(),
			attr.mail(),
			attr.displayName(),
			attr.givenName(),
			attr.sn(),
			attr.o(),
			attr.ou(),
			affiliationForProfile(attr.eduPersonAffiliation(), GAKUNIN_AFFILIATION_VALUES, 'GakuNin'),
			scopedAffiliationForProfile(
				attr.eduPersonScopedAffiliation(),
				GAKUNIN_AFFILIATION_VALUES,
				'GakuNin',
				'example.ac.jp'
			),
			attr.eduPersonEntitlement(),
			attr.eduPersonUniqueId(),
			attr.eduPersonAssurance(),
			attr.eduPersonOrcid(),
			attr.isMemberOf(),
			attr.jaDisplayName(),
			attr.jaGivenName(),
			attr.jaSn(),
			attr.jaOrganizationName(),
			attr.jaOrganizationalUnitName(),
			attr.gakuninScopedPersonalUniqueCode()
		])
	},
	{
		id: 'template_destination_saml_kafe_attribute_map',
		destinationType: 'saml',
		category: 'Academic federation',
		profileKey: 'kafe_attribute_map',
		displayName: 'KAFE attribute map',
		version: '2023-03-28',
		updatedAt: '2023-03-28',
		description:
			'KAFE core, recommended, and Korean extension attributes for academic federation SPs.',
		schema: samlSchema('subject_identifier', [
			attr.eduPersonTargetedID(true),
			attr.eduPersonPrincipalName(true),
			attr.sn(),
			attr.givenName(),
			attr.cn(),
			attr.displayName(),
			attr.mail(),
			scopedAffiliationForProfile(
				attr.eduPersonScopedAffiliation(),
				KAFE_AFFILIATION_VALUES,
				'KAFE',
				'kafe.net'
			),
			attr.eduPersonUniqueId(),
			attr.isMemberOf(),
			attr.schacHomeOrganization(),
			attr.schacHomeOrganizationType(),
			attr.eduPersonEntitlement(),
			affiliationForProfile(attr.eduPersonAffiliation(), KAFE_AFFILIATION_VALUES, 'KAFE'),
			attr.organizationName(),
			attr.koCommonName(),
			attr.koGivenName(),
			attr.koSurname(),
			attr.koOrganizationName(),
			attr.koOrganizationUnitName(),
			attr.koHomePostalAddress(),
			attr.koPostalAddress(),
			attr.koResearcherNumber(),
			attr.koOrganizationCode()
		])
	},
	{
		id: 'template_destination_saml_uk_federation_core',
		destinationType: 'saml',
		category: 'Academic federation',
		profileKey: 'uk_federation_core',
		displayName: 'UK federation core attributes',
		version: 'TRP 1.5',
		updatedAt: '2026-06-02',
		description:
			'UK federation core eduPerson attributes for affiliation, pseudonym, identifier, and entitlement.',
		schema: samlSchema('subject_identifier', [
			attr.eduPersonScopedAffiliation(true),
			attr.eduPersonTargetedID(true),
			attr.eduPersonPrincipalName(),
			attr.eduPersonEntitlement()
		])
	},
	{
		id: 'template_destination_saml_switch_eduid_core',
		destinationType: 'saml',
		category: 'Academic federation',
		profileKey: 'switch_eduid_core',
		displayName: 'Switch edu-ID core attributes',
		version: 'v1',
		updatedAt: '2026-06-02',
		description: 'Core SAML attributes from the Switch edu-ID federation attribute specification.',
		schema: samlSchema('subject_identifier', [
			switchAffiliation(attr.eduPersonAffiliation(true)),
			attr.mail(true),
			attr.givenName(true),
			attr.swissEduPersonHomeOrganization(true),
			attr.swissEduPersonHomeOrganizationType(true),
			switchScopedAffiliation(attr.eduPersonScopedAffiliation(true)),
			attr.sn(true),
			attr.eduPersonTargetedID(true),
			attr.swissEduPersonUniqueID(true),
			attr.cn(true),
			attr.displayName(true),
			attr.eduPersonUniqueId(true),
			attr.eduPersonPrincipalName(true),
			attr.schacHomeOrganization(true),
			attr.schacHomeOrganizationType(true)
		])
	},
	{
		id: 'template_destination_saml_surfconext_attribute_overview',
		destinationType: 'saml',
		category: 'Academic federation',
		profileKey: 'surfconext_attribute_overview',
		displayName: 'SURFconext attribute overview',
		version: 'v1',
		updatedAt: '2026-06-02',
		description:
			'Common SURFconext SAML attributes for identifiers, person data, organization, and groups.',
		schema: samlSchema('subject_identifier', [
			attr.eduPersonTargetedID(true),
			attr.sn(),
			attr.givenName(),
			attr.cn(),
			attr.displayName(),
			attr.mail(),
			attr.schacHomeOrganization(),
			attr.schacHomeOrganizationType(),
			attr.schacPersonalUniqueCode(),
			attr.eduPersonAffiliation(),
			attr.eduPersonScopedAffiliation(),
			attr.eduPersonEntitlement(),
			attr.eduPersonPrincipalName(),
			attr.isMemberOf(),
			attr.uid(),
			attr.preferredLanguage(),
			attr.eduPersonOrcid(),
			attr.eduPersonAssurance()
		])
	},
	{
		id: 'template_destination_saml_aaf_core',
		destinationType: 'saml',
		category: 'Academic federation',
		profileKey: 'aaf_core_attributes',
		displayName: 'Australian Access Federation core',
		version: '2024-01-01',
		updatedAt: '2024-01-01',
		description: 'AAF core attributes for Australian research and education federation services.',
		schema: samlSchema('subject_identifier', [
			withMeta(basicAttribute('auEduPersonSharedToken', 'AAF shared token', 'string', 'internal'), {
				examples: ['ZsiAvfxaIOXULgcz7QXknbGtfxk'],
				note: 'AAF-specific shared token. AAF guidance indicates its use is restricted and subject-id/pairwise-id are preferred future identifiers.',
				valueMultiplicity: 'single',
				nullable: true
			}),
			attr.displayName(),
			attr.eduPersonAffiliation(),
			attr.eduPersonEntitlement(),
			attr.eduPersonScopedAffiliation(),
			attr.eduPersonTargetedID(),
			attr.eduPersonAssurance(),
			attr.o(),
			attr.mail(),
			attr.sn(),
			attr.givenName(),
			attr.schacHomeOrganization(),
			attr.schacHomeOrganizationType(),
			attr.eduPersonPrincipalName(),
			withMeta(basicAttribute('SAMLSubjectID', 'SAML subject ID', 'string', 'pii'), {
				examples: ['taro.yamada@example.edu.au'],
				note: 'SAML subject-id identifier intended as a modern stable subject identifier.',
				valueMultiplicity: 'single',
				nullable: true
			}),
			withMeta(basicAttribute('SAMLPairwiseID', 'SAML pairwise ID', 'string', 'internal'), {
				examples: ['VZ2mh0JfQYKIqK9nXr9k@example.edu.au'],
				note: 'SAML pairwise-id identifier intended as a modern pairwise replacement for targeted identifiers.',
				valueMultiplicity: 'single',
				nullable: true
			})
		])
	},
	{
		id: 'template_destination_saml_sifulan_minimum',
		destinationType: 'saml',
		category: 'Academic federation',
		profileKey: 'sifulan_minimum_attributes',
		displayName: 'SIFULAN minimum attributes',
		version: 'v1',
		updatedAt: '2026-06-02',
		description: 'Minimum attributes published by the SIFULAN Malaysian Access Federation.',
		schema: samlSchema('subject_identifier', [
			attr.displayName(true),
			attr.mail(true),
			attr.eduPersonPrincipalName(true),
			attr.eduPersonScopedAffiliation(true),
			attr.eduPersonAffiliation(true),
			attr.eduPersonTargetedID(true),
			attr.givenName(true),
			attr.sn(true)
		])
	},
	{
		id: 'template_destination_saml_slack',
		destinationType: 'saml',
		category: 'Vendor specific / outbound',
		profileKey: 'slack_saml_workspace',
		displayName: 'Slack SAML workspace',
		version: 'v1',
		updatedAt: '2026-06-11',
		description:
			'Slack workspace or Enterprise Grid SAML release contract using email NameID and optional profile or group attributes.',
		schema: emailNameIdSchema('email', [
			vendor.email('email', true),
			vendor.firstName('first_name'),
			vendor.lastName('last_name'),
			vendor.displayName('displayName'),
			vendor.groups('groups')
		])
	},
	{
		id: 'template_destination_saml_microsoft_entra_custom_app',
		destinationType: 'saml',
		category: 'Vendor specific / outbound',
		profileKey: 'microsoft_entra_custom_saml_app',
		displayName: 'Microsoft Entra custom SAML app',
		version: 'v1',
		updatedAt: '2026-06-11',
		description:
			'Microsoft Entra-style custom SAML application contract with UPN or email NameID and common user, object, employee, and group claims.',
		schema: {
			destinationType: 'saml',
			samlFlow: 'outbound',
			nameId: {
				format: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
				source: 'userprincipalname'
			},
			attributes: [
				withMeta(
					vendorUriAttribute(
						'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
						'User principal name',
						'email',
						'pii',
						true,
						'upn'
					),
					{
						examples: ['person@example.com'],
						note: 'User principal name or immutable internal identifier used as the Microsoft-style primary user claim.',
						valueMultiplicity: 'single',
						nullable: false
					}
				),
				withMeta(
					vendorUriAttribute(
						'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
						'Email address',
						'email',
						'pii',
						true,
						'email'
					),
					{
						examples: ['person@example.com'],
						note: 'Mailbox address for applications that consume the Microsoft emailaddress claim URI.',
						valueMultiplicity: 'single',
						nullable: false
					}
				),
				withMeta(
					vendorUriAttribute(
						'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
						'Given name',
						'string',
						'pii'
					),
					{
						examples: ['Taro'],
						note: 'Given name mapped from the user profile.',
						valueMultiplicity: 'single',
						nullable: true
					}
				),
				withMeta(
					vendorUriAttribute(
						'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
						'Surname',
						'string',
						'pii'
					),
					{
						examples: ['Yamada'],
						note: 'Family name mapped from the user profile.',
						valueMultiplicity: 'single',
						nullable: true
					}
				),
				withMeta(vendorAttribute('objectid', 'Object ID', 'identifier', 'internal'), {
					examples: ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
					note: 'Directory object identifier for applications that need a stable tenant-local user key.',
					valueMultiplicity: 'single',
					nullable: true
				}),
				vendor.employeeId('employeeid'),
				vendor.groups('http://schemas.microsoft.com/ws/2008/06/identity/claims/groups', false)
			]
		}
	},
	{
		id: 'template_destination_saml_salesforce',
		destinationType: 'saml',
		category: 'Vendor specific / outbound',
		profileKey: 'salesforce_saml_sso',
		displayName: 'Salesforce SAML SSO',
		version: 'v1',
		updatedAt: '2026-06-11',
		description:
			'Salesforce SAML SSO release profile using Federation ID or username as NameID and common User attributes for login or JIT provisioning.',
		schema: {
			destinationType: 'saml',
			samlFlow: 'outbound',
			nameId: {
				format: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
				source: 'federation_identifier'
			},
			attributes: [
				withMeta(
					vendorAttribute('User.FederationIdentifier', 'Federation ID', 'identifier', 'pii', true),
					{
						examples: ['emp-10042'],
						note: 'Stable Salesforce Federation ID used to match the SAML subject to a Salesforce user.',
						valueMultiplicity: 'single',
						nullable: false
					}
				),
				withMeta(vendorAttribute('User.Username', 'Username', 'email', 'pii', true, 'email'), {
					examples: ['person@example.com'],
					note: 'Salesforce username, commonly an email-shaped globally unique login value.',
					valueMultiplicity: 'single',
					nullable: false
				}),
				withMeta(vendorAttribute('User.Email', 'Email', 'email', 'pii', true, 'email'), {
					examples: ['person@example.com'],
					note: 'Email address for Salesforce user profile and notification delivery.',
					valueMultiplicity: 'single',
					nullable: false
				}),
				vendor.firstName('User.FirstName', true),
				vendor.lastName('User.LastName', true),
				vendor.role('User.ProfileId'),
				vendor.role('User.RoleId')
			]
		}
	},
	{
		id: 'template_destination_saml_sap_successfactors',
		destinationType: 'saml',
		category: 'Vendor specific / outbound',
		profileKey: 'sap_successfactors_saml',
		displayName: 'SAP SuccessFactors SAML',
		version: 'v1',
		updatedAt: '2026-06-11',
		description:
			'SAP SuccessFactors workforce SAML release contract centered on personIdExternal, userId, email, and HR profile attributes.',
		schema: {
			destinationType: 'saml',
			samlFlow: 'outbound',
			nameId: {
				format: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
				source: 'personIdExternal'
			},
			attributes: [
				withMeta(
					vendorAttribute('personIdExternal', 'Person ID External', 'identifier', 'pii', true),
					{
						examples: ['100042'],
						note: 'External person identifier used by SAP SuccessFactors to correlate workforce identities.',
						valueMultiplicity: 'single',
						nullable: false
					}
				),
				withMeta(vendorAttribute('userId', 'User ID', 'identifier', 'pii', true), {
					examples: ['taro.yamada'],
					note: 'SAP SuccessFactors user identifier for login and profile correlation.',
					valueMultiplicity: 'single',
					nullable: false
				}),
				vendor.email('email', true),
				vendor.firstName('firstName', true),
				vendor.lastName('lastName', true),
				withMeta(vendorAttribute('department', 'Department', 'string', 'public'), {
					examples: ['Engineering'],
					note: 'Department name used for workforce profile enrichment or authorization.',
					valueMultiplicity: 'single',
					nullable: true
				}),
				vendor.groups('groups')
			]
		}
	},
	{
		id: 'template_destination_saml_sap_btp_ias',
		destinationType: 'saml',
		category: 'Vendor specific / outbound',
		profileKey: 'sap_btp_ias_saml',
		displayName: 'SAP BTP / IAS SAML',
		version: 'v1',
		updatedAt: '2026-06-11',
		description:
			'SAP BTP and Identity Authentication Service style SAML contract with user name, mail, display name, and Groups.',
		schema: {
			destinationType: 'saml',
			samlFlow: 'outbound',
			nameId: {
				format: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
				source: 'mail'
			},
			attributes: [
				vendor.email('mail', true),
				withMeta(vendorAttribute('userName', 'User name', 'identifier', 'pii', true), {
					examples: ['taro.yamada'],
					note: 'Application user name released for SAP account correlation.',
					valueMultiplicity: 'single',
					nullable: false
				}),
				vendor.firstName('firstName'),
				vendor.lastName('lastName'),
				vendor.displayName('displayName'),
				vendor.groups('Groups')
			]
		}
	},
	{
		id: 'template_destination_saml_zendesk',
		destinationType: 'saml',
		category: 'Vendor specific / outbound',
		profileKey: 'zendesk_saml_sso',
		displayName: 'Zendesk SAML SSO',
		version: 'v1',
		updatedAt: '2026-06-11',
		description:
			'Zendesk SAML release contract for email-based login, JIT profile creation, organization assignment, tags, and role mapping.',
		schema: emailNameIdSchema('email', [
			vendor.email('email', true),
			vendor.displayName('name', true),
			vendor.firstName('first_name'),
			vendor.lastName('last_name'),
			withMeta(vendorAttribute('phone', 'Phone', 'phone', 'pii', false, 'phone'), {
				examples: ['+1-415-555-0100'],
				note: 'Phone number for the Zendesk user profile.',
				valueMultiplicity: 'single',
				nullable: true
			}),
			withMeta(vendorAttribute('organization', 'Organization', 'string', 'public'), {
				examples: ['Example Corp'],
				note: 'Zendesk organization name to associate with the user.',
				valueMultiplicity: 'single',
				nullable: true
			}),
			vendor.role('role'),
			withMeta(vendorAttribute('tags', 'Tags', 'string', 'public'), {
				examples: ['premium', 'apac'],
				note: 'Zendesk tags assigned to the user during sign-in or provisioning.',
				valueMultiplicity: 'multi',
				nullable: true
			}),
			vendor.externalId('external_id')
		])
	},
	{
		id: 'template_destination_saml_box',
		destinationType: 'saml',
		category: 'Vendor specific / outbound',
		profileKey: 'box_saml_sso',
		displayName: 'Box SAML SSO',
		version: 'v1',
		updatedAt: '2026-06-11',
		description:
			'Box SAML SSO release contract with primary email, optional aliases, first and last name for auto-provisioning, and SSO group sync.',
		schema: emailNameIdSchema('primary_email', [
			vendor.email('primary_email', true),
			withMeta(vendorAttribute('email_aliases', 'Email aliases', 'email', 'pii', false, 'email'), {
				examples: ['alias1@example.com', 'alias2@example.com'],
				note: 'Multi-value email alias attribute accepted by Box for managed-domain aliases.',
				valueMultiplicity: 'multi',
				nullable: true
			}),
			vendor.firstName('firstName', true),
			vendor.lastName('lastName', true),
			withMeta(
				vendorUriAttribute('http://schemas.xmlsoap.org/claims/Group', 'Groups', 'string', 'public'),
				{
					examples: ['Finance', 'Admins'],
					note: 'Multi-value Box SSO group assertion used to add or remove group memberships on login.',
					valueMultiplicity: 'multi',
					nullable: true
				}
			)
		])
	},
	{
		id: 'template_destination_saml_atlassian',
		destinationType: 'saml',
		category: 'Vendor specific / outbound',
		profileKey: 'atlassian_cloud_saml',
		displayName: 'Atlassian Cloud SAML',
		version: 'v1',
		updatedAt: '2026-06-11',
		description:
			'Atlassian Cloud SAML contract with non-email internal user ID claim, first and last name claims, and email or UPN NameID.',
		schema: {
			destinationType: 'saml',
			samlFlow: 'outbound',
			nameId: {
				format: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
				source: 'email'
			},
			attributes: [
				withMeta(
					vendorUriAttribute(
						'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
						'Given name',
						'string',
						'pii',
						true
					),
					{
						examples: ['Taro'],
						note: 'First name claim required by Atlassian Cloud SAML setup guidance.',
						valueMultiplicity: 'single',
						nullable: false
					}
				),
				withMeta(
					vendorUriAttribute(
						'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
						'Surname',
						'string',
						'pii',
						true
					),
					{
						examples: ['Yamada'],
						note: 'Last name claim required by Atlassian Cloud SAML setup guidance.',
						valueMultiplicity: 'single',
						nullable: false
					}
				),
				withMeta(
					vendorUriAttribute(
						'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
						'Internal user ID',
						'identifier',
						'internal',
						true
					),
					{
						examples: ['emp-10042'],
						note: 'Stable internal ID for the user. Atlassian guidance states this value should not be the user email address.',
						valueMultiplicity: 'single',
						nullable: false
					}
				),
				withMeta(
					vendorUriAttribute(
						'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
						'User principal name',
						'email',
						'pii',
						false,
						'upn'
					),
					{
						examples: ['person@example.com'],
						note: 'UPN alternative used by some Microsoft Azure AD or nested group configurations.',
						valueMultiplicity: 'single',
						nullable: true
					}
				)
			]
		}
	},
	{
		id: 'template_destination_saml_aws',
		destinationType: 'saml',
		category: 'Vendor specific / outbound',
		profileKey: 'aws_saml_console',
		displayName: 'AWS SAML console federation',
		version: 'v1',
		updatedAt: '2026-06-11',
		description:
			'AWS IAM SAML federation contract with Role, RoleSessionName, optional SessionDuration, and principal tag attributes.',
		schema: {
			destinationType: 'saml',
			samlFlow: 'outbound',
			nameId: {
				format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
				source: 'subject_identifier'
			},
			attributes: [
				withMeta(
					vendorAttribute(
						'https://aws.amazon.com/SAML/Attributes/Role',
						'AWS role pairs',
						'string',
						'internal',
						true,
						'aws-role-pair'
					),
					{
						examples: [
							'arn:aws:iam::123456789012:role/Admin,arn:aws:iam::123456789012:saml-provider/Authrim'
						],
						note: 'AWS requires one or more role/principal ARN pairs in this exact case-sensitive attribute name.',
						valueMultiplicity: 'multi',
						nullable: false
					}
				),
				withMeta(
					vendorAttribute(
						'https://aws.amazon.com/SAML/Attributes/RoleSessionName',
						'Role session name',
						'identifier',
						'internal',
						true,
						'aws-role-session-name'
					),
					{
						examples: ['person@example.com', 'taro.yamada'],
						note: 'AWS role session name. Use a compact user ID or email-shaped value without spaces.',
						valueMultiplicity: 'single',
						nullable: false
					}
				),
				withMeta(
					vendorAttribute(
						'https://aws.amazon.com/SAML/Attributes/SessionDuration',
						'Session duration',
						'number',
						'internal',
						false,
						'integer-seconds'
					),
					{
						examples: ['3600'],
						note: 'Optional AWS console session duration in seconds. AWS accepts values from 900 to 43200.',
						valueMultiplicity: 'single',
						nullable: true
					}
				),
				withMeta(
					vendorAttribute(
						'https://aws.amazon.com/SAML/Attributes/PrincipalTag:Email',
						'Principal tag: Email',
						'email',
						'pii',
						false,
						'email'
					),
					{
						examples: ['person@example.com'],
						note: 'Optional session principal tag for AWS ABAC policies.',
						valueMultiplicity: 'single',
						nullable: true
					}
				),
				withMeta(
					vendorAttribute(
						'https://aws.amazon.com/SAML/Attributes/TransitiveTagKeys',
						'Transitive tag keys',
						'string',
						'internal',
						false
					),
					{
						examples: ['Email', 'Department'],
						note: 'Optional multi-value list of principal tag keys that remain transitive across role chaining.',
						valueMultiplicity: 'multi',
						nullable: true
					}
				)
			]
		}
	},
	{
		id: 'template_destination_saml_servicenow',
		destinationType: 'saml',
		category: 'Vendor specific / outbound',
		profileKey: 'servicenow_saml_sso',
		displayName: 'ServiceNow SAML SSO',
		version: 'v1',
		updatedAt: '2026-06-11',
		description:
			'ServiceNow SAML SSO profile using user_name or email NameID plus profile, department, title, and group attributes.',
		schema: {
			destinationType: 'saml',
			samlFlow: 'outbound',
			nameId: {
				format: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
				source: 'user_name'
			},
			attributes: [
				withMeta(vendorAttribute('user_name', 'User name', 'identifier', 'pii', true), {
					examples: ['taro.yamada'],
					note: 'ServiceNow user_name used as the account correlation key.',
					valueMultiplicity: 'single',
					nullable: false
				}),
				vendor.email('email', true),
				vendor.firstName('first_name'),
				vendor.lastName('last_name'),
				withMeta(vendorAttribute('department', 'Department', 'string', 'public'), {
					examples: ['IT Operations'],
					note: 'Department value for ServiceNow user profile enrichment or access rules.',
					valueMultiplicity: 'single',
					nullable: true
				}),
				withMeta(vendorAttribute('title', 'Title', 'string', 'public'), {
					examples: ['Service Desk Manager'],
					note: 'Job title released to the ServiceNow user profile.',
					valueMultiplicity: 'single',
					nullable: true
				}),
				vendor.groups('groups')
			]
		}
	},
	{
		id: 'template_destination_saml_google_workspace_custom_app',
		destinationType: 'saml',
		category: 'Vendor specific / outbound',
		profileKey: 'google_workspace_custom_saml_app',
		displayName: 'Google Workspace custom SAML app',
		version: 'v1',
		updatedAt: '2026-06-11',
		description:
			'Google Workspace custom SAML application style contract with primary email NameID and common profile or group attributes.',
		schema: emailNameIdSchema('primaryEmail', [
			vendor.email('primaryEmail', true),
			vendor.firstName('firstName'),
			vendor.lastName('lastName'),
			vendor.displayName('displayName'),
			vendor.groups('groups'),
			withMeta(vendorAttribute('orgUnitPath', 'Org unit path', 'string', 'public'), {
				examples: ['/Engineering/Platform'],
				note: 'Google Workspace organizational unit path for applications that consume org-unit routing.',
				valueMultiplicity: 'single',
				nullable: true
			})
		])
	},
	{
		id: 'template_destination_saml_enterprise_basic',
		destinationType: 'saml',
		category: 'Vendor specific / outbound',
		profileKey: 'enterprise_saml_basic',
		displayName: 'Enterprise SAML basic',
		version: 'v1',
		updatedAt: '2026-06-02',
		description: 'Common enterprise SAML profile for workforce SaaS integrations.',
		schema: {
			destinationType: 'saml',
			samlFlow: 'outbound',
			nameId: {
				format: EMAIL_NAME_ID,
				source: 'email'
			},
			attributes: [
				withMeta(contractAttribute('email', 'mail', 'email', true), {
					examples: ['person@example.com'],
					note: 'Enterprise SAML email attribute used as a mailbox and often as a login identifier.',
					valueMultiplicity: 'single',
					nullable: false
				}),
				withMeta(contractAttribute('displayName', 'displayName'), {
					examples: ['Taro Yamada'],
					note: 'Enterprise SAML display name attribute.',
					valueMultiplicity: 'single',
					nullable: true
				})
			]
		}
	}
];
