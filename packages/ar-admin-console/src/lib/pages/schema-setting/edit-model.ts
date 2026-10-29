import type {
	Cardinality,
	FieldType,
	Schema,
	SchemaChange,
	ValidationRules
} from '$lib/api/schema-setting';
import { sameValue } from '$lib/ui/save/draft.svelte';
import {
	checkLabel,
	checkLength,
	checkRules,
	DESCRIPTION_MAX,
	formFromRules,
	rulesFromForm,
	type RulesForm,
	type RulesProblem
} from './schema-validation';

/**
 * What the detail screen edits: an attribute as text and booleans (numbers as text, so a
 * half-typed one can be shown), and the change that Save sends, which is only what differs.
 */
export interface EditForm {
	label: string;
	type: FieldType;
	cardinality: Cardinality;
	isRequired: boolean;
	isActive: boolean;
	description: string;
	rules: RulesForm;
	isSearchable: boolean;
	isExportable: boolean;
	showOnRegistration: boolean;
	registrationRequired: boolean;
	registrationOrder: string;
	registrationPlaceholder: string;
}

export function formOf(schema: Schema): EditForm {
	return {
		label: schema.label,
		type: schema.type,
		cardinality: schema.cardinality,
		isRequired: schema.isRequired,
		isActive: schema.isActive,
		description: schema.description ?? '',
		rules: formFromRules(schema.validation),
		isSearchable: schema.isSearchable,
		isExportable: schema.isExportable,
		showOnRegistration: schema.showOnRegistration,
		registrationRequired: schema.registrationRequired,
		registrationOrder: String(schema.registrationOrder),
		registrationPlaceholder: schema.registrationPlaceholder ?? ''
	};
}

export type EditProblems = Partial<{
	label: 'empty' | 'too_long';
	description: 'too_long';
	rules: Partial<Record<string, RulesProblem>>;
	registrationOrder: 'integer';
}>;

const isInteger = (value: string) => /^-?\d+$/.test(value.trim());

/** What cannot be sent as it stands. The sign-up order of a field that is not asked is not checked. */
export function problemsOf(form: EditForm): EditProblems {
	const problems: EditProblems = {};
	const label = checkLabel(form.label);
	if (label) problems.label = label;
	if (checkLength(form.description, DESCRIPTION_MAX)) problems.description = 'too_long';
	const rules = checkRules(form.type, form.rules);
	if (Object.keys(rules).length > 0) problems.rules = rules;
	if (form.showOnRegistration && !isInteger(form.registrationOrder))
		problems.registrationOrder = 'integer';
	return problems;
}

/** By structure, whatever order the keys are in: the API keeps the rules as the text it was given. */
const sameRules = (a: ValidationRules | null, b: ValidationRules | null) =>
	sameValue(a ?? null, b ?? null);

/**
 * The change that Save sends: only the fields that differ from the saved attribute. A base
 * attribute's locked fields (label, type, cardinality) are never in it: the API refuses a locked
 * field that is sent at all, equal or not.
 */
export function changeOf(schema: Schema, form: EditForm): SchemaChange {
	const change: SchemaChange = {};
	if (!schema.isSystem) {
		if (form.label.trim() !== schema.label) change.label = form.label.trim();
		if (form.type !== schema.type) change.type = form.type;
		if (form.cardinality !== schema.cardinality) change.cardinality = form.cardinality;
	}
	if (form.isRequired !== schema.isRequired) change.isRequired = form.isRequired;
	if (form.isActive !== schema.isActive) change.isActive = form.isActive;
	const description = form.description.trim() === '' ? null : form.description.trim();
	if (description !== schema.description) change.description = description;
	// The rules are sent when they differ, or when the type changed (they are for the new type).
	const rules = rulesFromForm(form.type, form.rules);
	if (!sameRules(rules, schema.validation) || (!schema.isSystem && form.type !== schema.type))
		change.validation = rules;
	if (form.isSearchable !== schema.isSearchable) change.isSearchable = form.isSearchable;
	if (form.isExportable !== schema.isExportable) change.isExportable = form.isExportable;
	if (form.showOnRegistration !== schema.showOnRegistration)
		change.showOnRegistration = form.showOnRegistration;
	if (form.registrationRequired !== schema.registrationRequired)
		change.registrationRequired = form.registrationRequired;
	if (form.showOnRegistration || schema.showOnRegistration) {
		if (
			isInteger(form.registrationOrder) &&
			Number(form.registrationOrder) !== schema.registrationOrder
		)
			change.registrationOrder = Number(form.registrationOrder);
		const placeholder = form.registrationPlaceholder === '' ? null : form.registrationPlaceholder;
		if (placeholder !== schema.registrationPlaceholder)
			change.registrationPlaceholder = placeholder;
	}
	return change;
}
