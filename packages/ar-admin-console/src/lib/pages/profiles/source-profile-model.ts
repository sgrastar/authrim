import { t } from '#lib/i18n/i18n.svelte.js';
import type { SourceKind } from '#lib/api/source-profiles.js';

/**
 * What the input-source editor holds, and how it turns into and back from the schema the server
 * stores: the attributes of a SCIM user or the columns of a CSV file as table rows. Keys the table
 * does not edit (examples, notes, the parser, the schema URIs) are kept as they were.
 */
export interface SourceRow extends Record<string, unknown> {
	/** The attribute name (SCIM) or the column header (CSV). */
	key: string;
	label: string;
	valueType: string;
	required: boolean;
	mappingRequired: boolean;
	classification: string;
	multiplicity: string;
	nullable: boolean;
	extra: Record<string, unknown>;
}

export interface SourceForm {
	kind: SourceKind;
	displayName: string;
	rows: SourceRow[];
	/** The schema's other top-level keys, kept as they are. */
	rest: Record<string, unknown>;
}

export const SOURCE_VALUE_TYPES = [
	'string',
	'email',
	'phone',
	'number',
	'boolean',
	'json',
	'date',
	'datetime'
] as const;

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const text = (value: unknown, fallback = ''): string =>
	typeof value === 'string' ? value : fallback;

export function emptySourceRow(): SourceRow {
	return {
		key: '',
		label: '',
		valueType: 'string',
		required: false,
		mappingRequired: false,
		classification: 'internal',
		multiplicity: 'single',
		nullable: true,
		extra: {}
	};
}

export function emptySourceForm(kind: SourceKind): SourceForm {
	return {
		kind,
		displayName: '',
		rows: [],
		rest:
			kind === 'scim'
				? {
						resourceType: 'User',
						schemaUris: ['urn:ietf:params:scim:schemas:core:2.0:User']
					}
				: {}
	};
}

const SCIM_EDITED = [
	'name',
	'label',
	'type',
	'required',
	'mappingRequired',
	'classification',
	'valueMultiplicity',
	'nullable'
];
const CSV_EDITED = [
	'headerName',
	'label',
	'valueType',
	'required',
	'mappingRequired',
	'classification',
	'valueMultiplicity',
	'nullable'
];
const restOf = (entry: Record<string, unknown>, edited: readonly string[]) =>
	Object.fromEntries(Object.entries(entry).filter(([key]) => !edited.includes(key)));

export function sourceFormFromSchema(
	kind: SourceKind,
	displayName: string,
	schema: Record<string, unknown>
): SourceForm {
	const form = emptySourceForm(kind);
	form.displayName = displayName;
	const scim = kind === 'scim';
	form.rest = restOf(schema, ['sourceType', scim ? 'attributes' : 'columns']);
	const entries = (scim ? schema.attributes : schema.columns) as unknown;
	form.rows = (Array.isArray(entries) ? entries : []).map((item) => {
		const entry = record(item);
		return {
			...emptySourceRow(),
			key: text(scim ? entry.name : entry.headerName),
			label: text(entry.label),
			valueType: text(scim ? entry.type : entry.valueType, 'string'),
			required: entry.required === true,
			mappingRequired: entry.mappingRequired === true,
			classification: text(entry.classification, 'internal'),
			multiplicity: text(entry.valueMultiplicity, 'single'),
			nullable: entry.nullable !== false,
			extra: restOf(entry, scim ? SCIM_EDITED : CSV_EDITED)
		};
	});
	return form;
}

/** A stable id for a new CSV column, from its header, that is not in `taken` (and is then taken). */
function freshColumnId(header: string, index: number, taken: Set<string>): string {
	const slug = header
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	let n = index + 1;
	while (taken.has(`${slug || 'column'}_${n}`)) n += 1;
	const id = `${slug || 'column'}_${n}`;
	taken.add(id);
	return id;
}

export function sourceSchemaFromForm(form: SourceForm): Record<string, unknown> {
	if (form.kind === 'scim') {
		return {
			...form.rest,
			sourceType: 'scim',
			attributes: form.rows.map((row) => ({
				...row.extra,
				name: row.key.trim(),
				label: row.label.trim() || row.key.trim(),
				type: row.valueType || 'string',
				classification: row.classification || 'internal',
				required: row.required,
				mappingRequired: row.mappingRequired,
				valueMultiplicity: row.multiplicity === 'multi' ? 'multi' : 'single',
				nullable: row.required ? false : row.nullable
			}))
		};
	}
	// A column keeps the id it has; a new one gets an id no other column holds (a renamed or
	// removed column leaves its id behind, so the position is not enough).
	const taken = new Set(form.rows.map((row) => text(row.extra.stableColumnId)).filter(Boolean));
	const columns = form.rows.map((row, index) => ({
		...row.extra,
		stableColumnId: text(row.extra.stableColumnId) || freshColumnId(row.key, index, taken),
		headerName: row.key.trim(),
		label: row.label.trim() || row.key.trim(),
		valueType: row.valueType || 'string',
		classification: row.classification || 'internal',
		required: row.required,
		mappingRequired: row.mappingRequired,
		valueMultiplicity: row.multiplicity === 'multi' ? 'multi' : 'single',
		nullable: row.required ? false : row.nullable
	}));
	return {
		...form.rest,
		sourceType: 'csv',
		columns,
		warnings: Array.isArray(form.rest.warnings) ? form.rest.warnings : [],
		summary: {
			...record(form.rest.summary),
			columnCount: columns.length,
			requiredCandidateCount: columns.filter((column) => column.required).length,
			blockingWarningCount: 0
		}
	};
}

export type SourceProblemKey = 'name' | 'rows' | 'empty' | 'duplicate';

export function sourceProblems(form: SourceForm): { key: SourceProblemKey; message: string }[] {
	const problems: { key: SourceProblemKey; message: string }[] = [];
	if (!form.displayName.trim()) problems.push({ key: 'name', message: t('sf.dp.error.name') });
	if (form.rows.length === 0) problems.push({ key: 'rows', message: t('sf.sp.error.rows') });
	if (form.rows.some((row) => !row.key.trim()))
		problems.push({ key: 'empty', message: t('sf.dp.error.emptyKey') });
	const keys = form.rows.map((row) => row.key.trim()).filter(Boolean);
	if (new Set(keys).size !== keys.length)
		problems.push({ key: 'duplicate', message: t('sf.dp.error.duplicate') });
	return problems;
}
