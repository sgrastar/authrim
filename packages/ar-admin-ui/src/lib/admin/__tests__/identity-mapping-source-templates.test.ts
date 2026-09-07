import { describe, expect, it } from 'vitest';
import { scimSourceTemplates } from '../identity-mapping-source-templates/scim';

describe('identity mapping source templates', () => {
	it('provides minimal, core, and enterprise SCIM User patterns', () => {
		expect(scimSourceTemplates.map((template) => template.id)).toEqual([
			'template_source_scim_minimal_user',
			'template_source_scim_core_user',
			'template_source_scim_enterprise_user'
		]);
	});

	it('keeps template paths aligned with the inbound SCIM adapter', () => {
		const enterprise = scimSourceTemplates.find(
			(template) => template.id === 'template_source_scim_enterprise_user'
		);
		const paths = enterprise?.schema.attributes.map((attribute) => attribute.name) ?? [];

		expect(paths).toEqual(
			expect.arrayContaining([
				'userName',
				'emails.value',
				'groups',
				'enterprise.employeeNumber',
				'enterprise.costCenter',
				'enterprise.manager.value'
			])
		);
		expect(new Set(paths).size).toBe(paths.length);
	});

	it('marks userName and primary email as required in every template', () => {
		for (const template of scimSourceTemplates) {
			expect(template.schema.attributes).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: 'userName', required: true }),
					expect.objectContaining({ name: 'emails.value', required: true })
				])
			);
		}
	});

	it('marks userName as mapping-required in every template', () => {
		for (const template of scimSourceTemplates) {
			expect(template.schema.attributes).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: 'userName', mappingRequired: true })
				])
			);
		}
	});
});
