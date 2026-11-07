/**
 * The tenant's Identity Schema as the screen pages use it: the attributes a part can store its
 * answer in (with their types), and the choices of each enum attribute, labelled in the console's
 * language. Read once per tenant; a failure leaves it empty (the pages still work, without the
 * attributes' choices in the preview).
 */
import {
	httpSchemaSetting,
	type EnumOption,
	type FieldType,
	type Schema,
	type SchemaSettingClient
} from '#lib/api/schema-setting.js';
import { i18n } from '#lib/i18n/i18n.svelte.js';
import type { ChoiceSource, PartOption, SchemaField, SchemaType } from './screen-model.js';

const TYPES: Record<FieldType, SchemaType> = {
	string: 'String',
	number: 'Number',
	boolean: 'Boolean',
	date: 'Date',
	enum: 'Enum'
};

/** At most this many pages of 100 attributes are read (the API's page size limit). */
const MAX_PAGES = 10;

/** An enum choice's label in `locale`: its own for the locale, its default, or its value. */
export function choiceLabel(option: EnumOption, locale: string): string {
	return option.labels?.[locale] || option.label || option.value;
}

/** The choices of an attribute, as the console shows them in `locale`. */
export function schemaChoicesOf(schema: Schema, locale: string): PartOption[] {
	const options =
		schema.validation?.enum_options ??
		(schema.validation?.enum_values ?? []).map((value) => ({ value }));
	return options.map((option) => ({ value: option.value, label: choiceLabel(option, locale) }));
}

/** The active, single-valued attributes a part can be linked to. */
export function schemaFieldsOf(schemas: readonly Schema[], locale: string): SchemaField[] {
	return schemas
		.filter((schema) => schema.isActive && schema.cardinality !== 'multi')
		.map((schema) => ({
			key: schema.fieldKey,
			type: TYPES[schema.type] ?? 'String',
			...(schema.type === 'enum' ? { choices: schemaChoicesOf(schema, locale) } : {})
		}));
}

export async function loadSchemas(
	client: SchemaSettingClient,
	tenantId: string,
	signal?: AbortSignal
): Promise<Schema[]> {
	const schemas: Schema[] = [];
	for (let page = 1; page <= MAX_PAGES; page += 1) {
		const result = await client.list(tenantId, { page, limit: 100 }, signal);
		schemas.push(...result.schemas);
		if (page >= result.totalPages) break;
	}
	return schemas;
}

/**
 * The schema of the tenant `tenantOf()` names, read when it changes: `fields` the attributes,
 * `choices` an enum attribute's choices by key (in the console's language as it changes).
 */
export function useSchemaChoices(
	tenantOf: () => string | null,
	client: SchemaSettingClient = httpSchemaSetting
) {
	let schemas = $state<Schema[]>([]);
	let loaded = $state(false);

	$effect(() => {
		const tenantId = tenantOf();
		schemas = [];
		loaded = false;
		if (!tenantId) return;
		const controller = new AbortController();
		loadSchemas(client, tenantId, controller.signal)
			.then((read) => {
				if (!controller.signal.aborted) schemas = read;
			})
			.catch(() => {
				// The pages work without it: the preview shows no attribute's choices.
			})
			.finally(() => {
				if (!controller.signal.aborted) loaded = true;
			});
		return () => controller.abort();
	});

	const fields = $derived(schemaFieldsOf(schemas, i18n.locale));
	/** The attributes a person must give at sign-up (the sign-up screen should ask them). */
	const requiredAtSignUp = $derived(
		schemas
			.filter((schema) => schema.isActive && schema.registrationRequired)
			.map((schema) => schema.fieldKey)
	);
	const choices: ChoiceSource = (key) => fields.find((field) => field.key === key)?.choices ?? [];

	return {
		get fields() {
			return fields;
		},
		get loaded() {
			return loaded;
		},
		get requiredAtSignUp() {
			return requiredAtSignUp;
		},
		choices
	};
}
