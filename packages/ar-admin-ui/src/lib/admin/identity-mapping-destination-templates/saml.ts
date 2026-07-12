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
		nameId: {
			format: PERSISTENT_NAME_ID,
			source: nameIdSource
		},
		attributes
	};
}

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
		id: 'template_destination_saml_enterprise_basic',
		destinationType: 'saml',
		category: 'Vendor specific',
		profileKey: 'enterprise_saml_basic',
		displayName: 'Enterprise SAML basic',
		version: 'v1',
		updatedAt: '2026-06-02',
		description: 'Common enterprise SAML profile for workforce SaaS integrations.',
		schema: {
			destinationType: 'saml',
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
