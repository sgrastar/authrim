import { t } from '#lib/i18n/i18n.svelte.js';
import type { DestinationProtocol } from './templates/types';

/**
 * What the output-source editor holds while a profile is made or changed, and how it turns into
 * and back from the schema the server stores. The table edits the columns a person needs; every
 * other key of an entry (the release policy, examples, formatters) is kept as it was, so editing
 * a template never drops what the table does not show.
 */

export const NAME_ID_FORMATS = [
	'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
	'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
	'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
	'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
	'urn:oasis:names:tc:SAML:2.0:nameid-format:entity'
] as const;
export const NAME_ID_SOURCES = [
	'subject_identifier',
	'email',
	'eduPersonTargetedID',
	'eduPersonPrincipalName',
	'pairwise_id'
] as const;
export const ATTRIBUTE_NAME_FORMATS = [
	'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
	'urn:oasis:names:tc:SAML:2.0:attrname-format:basic',
	'urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified'
] as const;
export const VALUE_TYPES = [
	'string',
	'email',
	'phone',
	'number',
	'boolean',
	'json',
	'date',
	'datetime'
] as const;
/** The kind a persistent identifier (eduPersonTargetedID) takes: SAML only, a value of its own. */
export const PERSISTENT_NAMEID_TYPE = 'saml:persistent-nameid';
export const CLASSIFICATIONS = ['internal', 'public', 'pii', 'regulated', 'secret'] as const;
export const MULTIPLICITIES = ['single', 'multi'] as const;
export const LEGAL_BASES = [
	'consent',
	'contract',
	'legal_obligation',
	'legitimate_interest'
] as const;

const DEFAULT_NAME_FORMAT = ATTRIBUTE_NAME_FORMATS[0];
const DEFAULT_NAME_ID_FORMAT = NAME_ID_FORMATS[0];

/** One attribute (SAML) or claim (OIDC) of a profile, as a row of the table. */
export interface ProfileRow extends Record<string, unknown> {
	/** The attribute name (SAML) or the claim name (OIDC). */
	key: string;
	label: string;
	valueType: string;
	/** Comma separated; empty: anything. */
	allowedValues: string;
	/** SAML: sample values to show what a value looks like, comma separated. */
	examples: string;
	/** What the sample values were when loaded, and as text: unchanged text keeps them exactly. */
	examplesRaw: unknown[];
	examplesLoaded: string;
	multiplicity: string;
	nullable: boolean;
	required: boolean;
	/** SAML only. */
	nameFormat: string;
	classification: string;
	/** OIDC: the scopes a claim is released under, comma separated. */
	scopes: string;
	/** SAML: the legal basis the attribute is released on. */
	legalBasis: string;
	/** OIDC only: where the claim is released. */
	idToken: boolean;
	userinfo: boolean;
	/** What the table does not edit, kept as it is. */
	extra: Record<string, unknown>;
}

export interface ProfileForm {
	protocol: DestinationProtocol;
	displayName: string;
	/** SAML: the NameID. */
	nameIdFormat: string;
	nameIdSource: string;
	/** The NameID's other keys (its classification), kept as they are. */
	nameIdExtra: Record<string, unknown>;
	rows: ProfileRow[];
	/** The schema's other top-level keys (an OIDC profile's subject contract), kept as they are. */
	rest: Record<string, unknown>;
}

export function emptyRow(_protocol: DestinationProtocol): ProfileRow {
	return {
		key: '',
		label: '',
		valueType: 'string',
		allowedValues: '',
		examples: '',
		examplesRaw: [],
		examplesLoaded: '',
		multiplicity: 'single',
		nullable: true,
		required: false,
		nameFormat: DEFAULT_NAME_FORMAT,
		classification: 'internal',
		scopes: '',
		legalBasis: '',
		idToken: true,
		userinfo: true,
		extra: {}
	};
}

export function emptyProfileForm(protocol: DestinationProtocol): ProfileForm {
	return {
		protocol,
		displayName: '',
		nameIdFormat: DEFAULT_NAME_ID_FORMAT,
		nameIdSource: 'subject_identifier',
		nameIdExtra: {},
		rows: [],
		rest: protocol === 'oidc' ? { subjectContract: { required: true } } : {}
	};
}

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const text = (value: unknown, fallback = ''): string =>
	typeof value === 'string' ? value : fallback;
const list = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * The sample values of an entry as text for the table, with the values as they were: a sample that
 * has a comma in it, or is not text, comes back unchanged when its text is not edited.
 */
function sampleValues(
	value: unknown
): Pick<ProfileRow, 'examples' | 'examplesRaw' | 'examplesLoaded'> {
	const raw = Array.isArray(value) ? value : [];
	const examples = raw.map((item) => String(item)).join(', ');
	return { examples, examplesRaw: raw, examplesLoaded: examples };
}

/** "a, b ,,c" → ["a", "b", "c"], without repeats. */
export function splitValues(value: string): string[] {
	return [
		...new Set(
			value
				.split(',')
				.map((item) => item.trim())
				.filter(Boolean)
		)
	];
}

/** The keys a row edits; every other key of an entry goes to `extra`. */
const SAML_EDITED = [
	'name',
	'label',
	'valueType',
	'allowedValues',
	'examples',
	'valueMultiplicity',
	'nullable',
	'nameFormat',
	'classification',
	'releasePolicy'
];
const OIDC_EDITED = [
	'claimName',
	'label',
	'valueType',
	'allowedValues',
	'valueMultiplicity',
	'nullable',
	'required',
	'classification',
	'surfaces',
	'requiredScopes'
];

function restOf(
	entry: Record<string, unknown>,
	edited: readonly string[]
): Record<string, unknown> {
	return Object.fromEntries(Object.entries(entry).filter(([key]) => !edited.includes(key)));
}

/** The form for a stored schema (a template's, a profile's). */
export function formFromSchema(
	protocol: DestinationProtocol,
	displayName: string,
	schema: Record<string, unknown>
): ProfileForm {
	const form = emptyProfileForm(protocol);
	form.displayName = displayName;
	if (protocol === 'saml') {
		const nameId = record(schema.nameId);
		form.nameIdFormat = text(nameId.format, DEFAULT_NAME_ID_FORMAT);
		form.nameIdSource = text(nameId.source, 'subject_identifier');
		form.nameIdExtra = restOf(nameId, ['format', 'source']);
		form.rest = restOf(schema, ['destinationType', 'nameId', 'attributes']);
		form.rows = (Array.isArray(schema.attributes) ? schema.attributes : []).map((item) => {
			const entry = record(item);
			return {
				...emptyRow('saml'),
				key: text(entry.name),
				label: text(entry.label),
				valueType: text(entry.valueType, 'string'),
				allowedValues: list(entry.allowedValues).join(', '),
				...sampleValues(entry.examples),
				multiplicity: text(entry.valueMultiplicity, 'single'),
				nullable: entry.nullable !== false,
				nameFormat: text(entry.nameFormat, DEFAULT_NAME_FORMAT),
				classification: text(entry.classification, 'internal'),
				legalBasis: text(record(entry.releasePolicy).legalBasis),
				extra: {
					...restOf(entry, SAML_EDITED),
					...(record(entry.releasePolicy).purpose
						? { releasePurpose: record(entry.releasePolicy).purpose }
						: {})
				}
			};
		});
	} else {
		form.rest = restOf(schema, ['destinationType', 'claims']);
		form.rows = (Array.isArray(schema.claims) ? schema.claims : []).map((item) => {
			const entry = record(item);
			const surfaces = list(entry.surfaces);
			return {
				...emptyRow('oidc'),
				key: text(entry.claimName),
				label: text(entry.label),
				valueType: text(entry.valueType, 'string'),
				allowedValues: list(entry.allowedValues).join(', '),
				multiplicity: text(entry.valueMultiplicity, 'single'),
				nullable: entry.nullable !== false,
				required: entry.required === true,
				classification: text(entry.classification, 'internal'),
				scopes: list(entry.requiredScopes).join(', '),
				idToken: surfaces.length === 0 || surfaces.includes('id_token'),
				userinfo: surfaces.length === 0 || surfaces.includes('userinfo'),
				extra: restOf(entry, OIDC_EDITED)
			};
		});
	}
	return form;
}

/** The schema a form stands for (what is saved). */
export function schemaFromForm(form: ProfileForm): Record<string, unknown> {
	if (form.protocol === 'saml') {
		return {
			...form.rest,
			destinationType: 'saml',
			nameId: { ...form.nameIdExtra, format: form.nameIdFormat, source: form.nameIdSource },
			attributes: form.rows.map(({ extra: { releasePurpose, ...extra }, ...row }) => ({
				...extra,
				name: row.key.trim(),
				label: row.label.trim() || row.key.trim(),
				nameFormat: row.nameFormat || DEFAULT_NAME_FORMAT,
				valueType: row.valueType || 'string',
				classification: row.classification || 'internal',
				...(splitValues(row.allowedValues).length > 0
					? { allowedValues: splitValues(row.allowedValues) }
					: {}),
				...(sampleValuesToSave(row).length > 0 ? { examples: sampleValuesToSave(row) } : {}),
				valueMultiplicity: row.multiplicity === 'multi' ? 'multi' : 'single',
				nullable: row.nullable,
				// What is personal is released on a basis: one is given when none was chosen.
				...(row.legalBasis || PERSONAL.has(row.classification)
					? {
							releasePolicy: {
								legalBasis: row.legalBasis || 'consent',
								purpose: typeof releasePurpose === 'string' ? releasePurpose : 'attribute_release'
							}
						}
					: {})
			}))
		};
	}
	return {
		...form.rest,
		destinationType: 'oidc',
		claims: form.rows.map((row) => ({
			...row.extra,
			claimName: row.key.trim(),
			label: row.label.trim() || row.key.trim(),
			valueType: row.valueType || 'string',
			classification: row.classification || 'internal',
			...(splitValues(row.allowedValues).length > 0
				? { allowedValues: splitValues(row.allowedValues) }
				: {}),
			valueMultiplicity: row.multiplicity === 'multi' ? 'multi' : 'single',
			requiredScopes: splitValues(row.scopes),
			required: row.required,
			nullable: row.required ? false : row.nullable,
			surfaces: [...(row.idToken ? ['id_token'] : []), ...(row.userinfo ? ['userinfo'] : [])]
		}))
	};
}

/** The sample values to keep: as loaded while the text is as loaded, else what the text says. */
function sampleValuesToSave(
	row: Pick<ProfileRow, 'examples' | 'examplesRaw' | 'examplesLoaded'>
): unknown[] {
	return row.examples === row.examplesLoaded ? row.examplesRaw : splitValues(row.examples);
}

const PERSONAL = new Set(['pii', 'regulated']);

export type ProfileProblemKey = 'name' | 'rows' | 'duplicate' | 'empty' | 'surface' | 'scope';

/** What stops a profile from being saved, in words. */
export function profileProblems(form: ProfileForm): { key: ProfileProblemKey; message: string }[] {
	const problems: { key: ProfileProblemKey; message: string }[] = [];
	if (!form.displayName.trim()) problems.push({ key: 'name', message: t('sf.dp.error.name') });
	if (form.rows.length === 0) problems.push({ key: 'rows', message: t('sf.dp.error.rows') });
	if (form.rows.some((row) => !row.key.trim()))
		problems.push({ key: 'empty', message: t('sf.dp.error.emptyKey') });
	const keys = form.rows.map((row) => row.key.trim()).filter(Boolean);
	if (new Set(keys).size !== keys.length)
		problems.push({ key: 'duplicate', message: t('sf.dp.error.duplicate') });
	if (form.protocol === 'oidc' && form.rows.some((row) => !row.idToken && !row.userinfo))
		problems.push({ key: 'surface', message: t('sf.dp.error.surface') });
	if (
		form.protocol === 'oidc' &&
		form.rows.some(
			(row) => PERSONAL.has(row.classification) && splitValues(row.scopes).length === 0
		)
	)
		problems.push({ key: 'scope', message: t('sf.dp.error.scope') });
	return problems;
}

/** A key for a new profile: the name made into a key, with a short suffix so two never collide. */
export function profileKeyFor(displayName: string): string {
	const slug = displayName
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 48);
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${slug || 'profile'}_${suffix}`;
}
