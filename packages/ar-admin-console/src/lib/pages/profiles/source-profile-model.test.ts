import { describe, expect, it } from 'vitest';
import {
	emptySourceForm,
	emptySourceRow,
	sourceFormFromSchema,
	sourceProblems,
	sourceSchemaFromForm
} from './source-profile-model';
import { scimSourceTemplates } from './source-templates';

describe('the SCIM templates', () => {
	it.each(scimSourceTemplates.map((template) => [template.displayName, template] as const))(
		'%s: every key of every attribute survives the table',
		(_name, template) => {
			const out = sourceSchemaFromForm(sourceFormFromSchema('scim', '', template.schema));
			const original = template.schema.attributes as Record<string, unknown>[];
			const attributes = out.attributes as Record<string, unknown>[];
			expect(attributes).toHaveLength(original.length);
			original.forEach((entry, index) => {
				for (const [key, value] of Object.entries(entry))
					if (key !== 'nullable')
						expect(attributes[index][key], `${key} of #${index}`).toEqual(value);
			});
			expect(out.schemaUris).toEqual(template.schema.schemaUris);
			expect(
				sourceProblems(sourceFormFromSchema('scim', template.displayName, template.schema))
			).toEqual([]);
		}
	);
});

describe('an input source form', () => {
	it('is saved as the CSV schema the server stores, with a stable id for each column', () => {
		const form = emptySourceForm('csv');
		form.displayName = 'Staff';
		form.rows = [
			{ ...emptySourceRow(), key: 'Employee ID', required: true },
			{ ...emptySourceRow(), key: 'Mail', valueType: 'email' }
		];
		const schema = sourceSchemaFromForm(form);
		expect(schema.sourceType).toBe('csv');
		const columns = schema.columns as Record<string, unknown>[];
		expect(columns.map((column) => column.headerName)).toEqual(['Employee ID', 'Mail']);
		expect(columns[0]).toMatchObject({
			stableColumnId: 'employee_id_1',
			required: true,
			nullable: false
		});
		expect(columns[1].stableColumnId).toBe('mail_2');
		expect(schema.summary).toMatchObject({ columnCount: 2, requiredCandidateCount: 1 });
		// Round trip keeps the id a column already has.
		const again = sourceSchemaFromForm(sourceFormFromSchema('csv', '', schema));
		expect((again.columns as Record<string, unknown>[])[0].stableColumnId).toBe('employee_id_1');
	});

	it('says what stops it from being saved', () => {
		const form = emptySourceForm('scim');
		expect(sourceProblems(form).map((problem) => problem.key)).toEqual(['name', 'rows']);
		form.displayName = 'x';
		form.rows = [
			{ ...emptySourceRow(), key: 'a' },
			{ ...emptySourceRow(), key: 'a' },
			{ ...emptySourceRow(), key: '' }
		];
		expect(sourceProblems(form).map((problem) => problem.key)).toEqual(['empty', 'duplicate']);
	});
});

describe('CSV column ids', () => {
	it('a new column never takes an id another column holds', () => {
		const form = emptySourceForm('csv');
		form.rows = [
			{ ...emptySourceRow(), key: 'A', extra: { stableColumnId: 'a_1' } },
			{ ...emptySourceRow(), key: 'Mail' }
		];
		const first = sourceSchemaFromForm(form);
		// "Mail" was column two: it is renamed, "A" goes, and another "Mail" is added.
		const reopened = sourceFormFromSchema('csv', '', first);
		reopened.rows[1].key = 'Contact';
		reopened.rows.splice(0, 1);
		reopened.rows.push({ ...emptySourceRow(), key: 'Mail' });
		const ids = (sourceSchemaFromForm(reopened).columns as Record<string, unknown>[]).map(
			(column) => column.stableColumnId
		);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids[0]).toBe('mail_2');
	});
});
