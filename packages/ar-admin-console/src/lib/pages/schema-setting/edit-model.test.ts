import { describe, expect, it } from 'vitest';
import { createFakeSchemaSetting } from '$lib/api/fake/schema-setting-fake';
import type { Schema } from '$lib/api/schema-setting';
import { changeOf, formOf, problemsOf } from './edit-model';

async function load(id: string): Promise<Schema> {
	return (await createFakeSchemaSetting().get('acme', id)).schema;
}

describe('the change Save sends', () => {
	it('is empty when nothing differs, for a custom and for a base attribute', async () => {
		for (const id of ['s-employee', 's-name', 's-department', 's-cost']) {
			const schema = await load(id);
			expect(changeOf(schema, formOf(schema)), id).toEqual({});
		}
	});

	it('does not send rules that only came back in another key order', async () => {
		const schema = await load('s-employee');
		const reordered = {
			...schema,
			validation: { pattern: '^E\\d+$', max_length: 8, min_length: 4 }
		};
		const form = formOf(reordered);
		form.label = 'Staff ID';
		expect(changeOf(reordered, form)).toEqual({ label: 'Staff ID' });
	});

	it('has only what differs', async () => {
		const schema = await load('s-employee');
		const form = formOf(schema);
		form.label = '  Staff ID ';
		form.isRequired = false;
		form.rules.maxLength = '10';
		form.description = '';
		expect(changeOf(schema, form)).toEqual({
			label: 'Staff ID',
			isRequired: false,
			description: null,
			validation: { min_length: 4, max_length: 10, pattern: '^E\\d+$' }
		});
	});

	it('never sends a locked field of a base attribute, even when it was typed over', async () => {
		const schema = await load('s-name');
		const form = formOf(schema);
		form.label = 'Other';
		form.type = 'number';
		form.cardinality = 'multi';
		form.isSearchable = false;
		const change = changeOf(schema, form);
		expect(change).toEqual({ isSearchable: false });
		expect('label' in change || 'type' in change || 'cardinality' in change).toBe(false);
	});

	it('sends the rules for the new type when the type changes, even if there are none', async () => {
		const schema = await load('s-cost');
		const form = formOf(schema);
		form.type = 'string';
		form.rules = { ...form.rules, min: '', max: '' };
		expect(changeOf(schema, form)).toEqual({ type: 'string', validation: null });
	});

	it('sends the registration order and example only for an attribute asked at sign-up', async () => {
		const schema = await load('s-department');
		const form = formOf(schema);
		form.registrationOrder = '5';
		form.registrationPlaceholder = 'x';
		expect(changeOf(schema, form)).toEqual({});
		form.showOnRegistration = true;
		expect(changeOf(schema, form)).toEqual({
			showOnRegistration: true,
			registrationOrder: 5,
			registrationPlaceholder: 'x'
		});
	});
});

describe('what cannot be sent', () => {
	it('is told per field', async () => {
		const schema = await load('s-employee');
		const form = formOf(schema);
		expect(problemsOf(form)).toEqual({});
		form.label = ' ';
		form.rules.minLength = '9';
		form.showOnRegistration = true;
		form.registrationOrder = 'x';
		expect(problemsOf(form)).toEqual({
			label: 'empty',
			registrationOrder: 'integer',
			rules: { maxLength: 'length_order' }
		});
	});

	it('does not check the order of a sign-up field that is not asked', async () => {
		const schema = await load('s-department');
		const form = formOf(schema);
		form.registrationOrder = 'x';
		expect(problemsOf(form)).toEqual({});
	});
});
