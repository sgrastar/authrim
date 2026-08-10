import { describe, expect, it } from 'vitest';
import type { ScreenField } from '$lib/api/admin-screens';
import {
	findMissingRequiredRegistrationFields,
	normalizeRegistrationFieldKey,
	type RegistrationSchemaFieldOption
} from './screen-registration-requirements';

const schemas: RegistrationSchemaFieldOption[] = [
	{
		field: 'email',
		label: 'Email',
		valueType: 'text',
		registrationRequired: true,
		schemaId: 'schema-email'
	},
	{
		field: 'department',
		label: 'Department',
		valueType: 'text',
		registrationRequired: true,
		schemaId: 'schema-department'
	},
	{
		field: 'locale',
		label: 'Locale',
		valueType: 'text',
		registrationRequired: false,
		schemaId: 'schema-locale'
	}
];

describe('screen registration requirements', () => {
	it('reports required schema fields that are missing from a registration screen', () => {
		const fields: ScreenField[] = [
			{
				field: 'email',
				label: 'Email',
				required: true,
				block_type: 'identity_field'
			}
		];

		expect(findMissingRequiredRegistrationFields('registration', fields, schemas)).toEqual([
			schemas[1]
		]);
	});

	it('treats canonical aliases as the same identity field', () => {
		const fields: ScreenField[] = [
			{
				field: 'field.canonical.email',
				label: 'Email',
				required: true,
				block_type: 'identity_field'
			},
			{
				field: 'department',
				label: 'Department',
				required: true,
				block_type: 'identity_field'
			}
		];

		expect(findMissingRequiredRegistrationFields('registration', fields, schemas)).toEqual([]);
		expect(normalizeRegistrationFieldKey('field.canonical.email')).toBe('email');
	});

	it('does not apply registration requirements to other screen kinds', () => {
		expect(findMissingRequiredRegistrationFields('login', [], schemas)).toEqual([]);
	});

	it('requires an actual identity input instead of a block with the same field key', () => {
		const fields: ScreenField[] = [
			{
				field: 'email',
				label: 'Email action',
				required: false,
				block_type: 'auth_widget'
			},
			{
				field: 'department',
				label: 'Department',
				required: true,
				block_type: 'identity_field'
			}
		];

		expect(findMissingRequiredRegistrationFields('registration', fields, schemas)).toEqual([
			schemas[0]
		]);
	});
});
