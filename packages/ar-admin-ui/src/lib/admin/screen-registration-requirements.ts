import type { ScreenField, ScreenKind, ScreenValueType } from '$lib/api/admin-screens';

export interface RegistrationSchemaFieldOption {
	field: string;
	label: string;
	valueType: ScreenValueType;
	registrationRequired: boolean;
	schemaId?: string;
}

export function normalizeRegistrationFieldKey(field: string): string {
	const normalized = field.trim().toLowerCase();
	return normalized.startsWith('field.canonical.')
		? normalized.slice('field.canonical.'.length)
		: normalized;
}

export function findMissingRequiredRegistrationFields(
	screenKind: ScreenKind,
	fields: ScreenField[],
	schemaFields: RegistrationSchemaFieldOption[]
): RegistrationSchemaFieldOption[] {
	if (screenKind !== 'registration') return [];

	const placedFields = new Set(
		fields
			.filter((field) => (field.block_type ?? 'identity_field') === 'identity_field')
			.map((field) => normalizeRegistrationFieldKey(field.field))
	);

	return schemaFields.filter(
		(field) =>
			field.registrationRequired && !placedFields.has(normalizeRegistrationFieldKey(field.field))
	);
}
