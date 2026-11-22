import { describe, expect, it } from 'vitest';
import { jaServiceFlows } from '#lib/i18n/messages/service-flows/ja.js';
import { mockProfile } from '#lib/api/fake/destination-profiles-fake.js';
import { codecContext, profileDescriptor } from '../connection-mapping-fields';
import {
	emptyProfileForm,
	emptyRow,
	formFromSchema,
	profileKeyFor,
	profileProblems,
	schemaFromForm,
	splitValues
} from './destination-profile-model';
import { destinationTemplates, templatesFor } from './templates';

describe('the templates', () => {
	it('come in both kinds, in the categories the old screen had', () => {
		expect(templatesFor('saml').length).toBeGreaterThanOrEqual(10);
		expect(templatesFor('oidc').length).toBeGreaterThanOrEqual(1);
		expect(new Set(templatesFor('saml').map((template) => template.category))).toEqual(
			new Set(['General settings', 'Academic federation', 'Vendor specific'])
		);
		expect(templatesFor('saml').map((template) => template.displayName)).toContain(
			'GakuNin application standard'
		);
	});

	it.each(destinationTemplates.map((template) => [template.displayName, template] as const))(
		'%s survives the table: what is saved is what the template said',
		(_name, template) => {
			const form = formFromSchema(template.destinationType, template.displayName, template.schema);
			const once = schemaFromForm(form);
			// Going round again changes nothing: the table loses nothing it does not show.
			expect(schemaFromForm(formFromSchema(template.destinationType, '', once))).toEqual(once);
			const entries = (template.destinationType === 'saml' ? once.attributes : once.claims) as {
				name?: string;
				claimName?: string;
			}[];
			const original = (
				template.destinationType === 'saml' ? template.schema.attributes : template.schema.claims
			) as { name?: string; claimName?: string }[];
			expect(entries.map((entry) => entry.name ?? entry.claimName)).toEqual(
				original.map((entry) => entry.name ?? entry.claimName)
			);
			expect(profileProblems(form).map((problem) => problem.key)).toEqual([]);
		}
	);

	it('keep the keys the table does not edit', () => {
		const gakunin = templatesFor('saml').find(
			(t) => t.displayName === 'GakuNin application standard'
		)!;
		const schema = schemaFromForm(formFromSchema('saml', '', gakunin.schema));
		const attributes = schema.attributes as { releasePolicy?: unknown }[];
		expect(attributes.every((attribute) => attribute.releasePolicy !== undefined)).toBe(true);
		const oidc = schemaFromForm(formFromSchema('oidc', '', templatesFor('oidc')[0].schema));
		expect(oidc.subjectContract).toBeDefined();
	});
});

describe('a form', () => {
	it('is saved as the SAML schema the server stores', () => {
		const form = emptyProfileForm('saml');
		form.displayName = 'Mine';
		form.rows = [
			{
				...emptyRow('saml'),
				key: ' mail ',
				label: '',
				allowedValues: 'a, b ,a',
				multiplicity: 'multi'
			}
		];
		expect(schemaFromForm(form)).toEqual({
			destinationType: 'saml',
			nameId: {
				format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
				source: 'subject_identifier'
			},
			attributes: [
				{
					name: 'mail',
					label: 'mail',
					nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
					valueType: 'string',
					classification: 'internal',
					allowedValues: ['a', 'b'],
					valueMultiplicity: 'multi',
					nullable: true
				}
			]
		});
	});

	it('makes an OIDC claim non-null when it is required and keeps the places it is released', () => {
		const form = emptyProfileForm('oidc');
		form.rows = [{ ...emptyRow('oidc'), key: 'email', required: true, idToken: false }];
		const claim = (schemaFromForm(form).claims as Record<string, unknown>[])[0];
		expect(claim).toMatchObject({ claimName: 'email', required: true, nullable: false });
		expect(claim.surfaces).toEqual(['userinfo']);
	});

	it('says what stops it from being saved', () => {
		const form = emptyProfileForm('oidc');
		expect(profileProblems(form).map((problem) => problem.key)).toEqual(['name', 'rows']);
		form.displayName = 'x';
		form.rows = [
			{ ...emptyRow('oidc'), key: 'a', idToken: false, userinfo: false },
			{ ...emptyRow('oidc'), key: 'a' },
			{ ...emptyRow('oidc'), key: '' }
		];
		expect(profileProblems(form).map((problem) => problem.key)).toEqual([
			'empty',
			'duplicate',
			'surface'
		]);
	});
});

describe('keys and values', () => {
	it('splits allowed values without blanks or repeats', () => {
		expect(splitValues('a, b,,a ')).toEqual(['a', 'b']);
		expect(splitValues('')).toEqual([]);
	});

	it('makes a key from the name that does not repeat', () => {
		expect(profileKeyFor('GakuNin 標準')).toMatch(/^gakunin_[a-z0-9]{1,6}$/);
		expect(profileKeyFor('標準')).toMatch(/^profile_[a-z0-9]+$/);
		expect(profileKeyFor('Same')).not.toEqual(profileKeyFor('Same'));
	});
});

describe('what a template says reaches the saved schema', () => {
	const entriesOf = (schema: Record<string, unknown>) =>
		(Array.isArray(schema.attributes) ? schema.attributes : (schema.claims as unknown[])) as Record<
			string,
			unknown
		>[];

	it.each(destinationTemplates.map((template) => [template.displayName, template] as const))(
		'%s: every key of every entry is still there after one pass through the table',
		(_name, template) => {
			const out = entriesOf(
				schemaFromForm(formFromSchema(template.destinationType, '', template.schema))
			);
			const original = entriesOf(template.schema);
			expect(out).toHaveLength(original.length);
			original.forEach((entry, index) => {
				for (const [key, value] of Object.entries(entry))
					if (key !== 'nullable') expect(out[index][key], `${key} of #${index}`).toEqual(value);
			});
		}
	);

	it('keeps the NameID keys that are not edited', () => {
		const schema = {
			destinationType: 'saml',
			nameId: { format: 'f', source: 's', classification: 'pii' },
			attributes: []
		};
		const out = schemaFromForm(formFromSchema('saml', '', schema));
		expect(out.nameId).toEqual({ format: 'f', source: 's', classification: 'pii' });
	});

	it.each(destinationTemplates.map((template) => [template.displayName, template] as const))(
		'%s: a mapping can be made into it',
		(_name, template) => {
			const schema = schemaFromForm(formFromSchema(template.destinationType, '', template.schema));
			const descriptor = profileDescriptor(
				mockProfile(template.destinationType, 'p', template.displayName, schema)
			);
			expect(() =>
				codecContext(template.destinationType, descriptor, { entries: [] } as never, {
					catalogVersionId: 'c',
					rules: []
				})
			).not.toThrow();
		}
	);

	it('gives a personal SAML attribute a legal basis and asks a personal OIDC claim for a scope', () => {
		const saml = emptyProfileForm('saml');
		saml.rows = [{ ...emptyRow('saml'), key: 'mail', classification: 'pii' }];
		expect((schemaFromForm(saml).attributes as Record<string, unknown>[])[0].releasePolicy).toEqual(
			{
				legalBasis: 'consent',
				purpose: 'attribute_release'
			}
		);
		const oidc = emptyProfileForm('oidc');
		oidc.displayName = 'x';
		oidc.rows = [{ ...emptyRow('oidc'), key: 'email', classification: 'pii' }];
		expect(profileProblems(oidc).map((problem) => problem.key)).toEqual(['scope']);
		oidc.rows[0].scopes = 'email';
		expect(profileProblems(oidc)).toEqual([]);
		expect((schemaFromForm(oidc).claims as Record<string, unknown>[])[0].requiredScopes).toEqual([
			'email'
		]);
	});
});

describe('the template texts', () => {
	it('every template has its description in the message catalogue (all four languages are typed against it)', () => {
		for (const template of destinationTemplates)
			expect(Object.keys(jaServiceFlows), template.id).toContain(
				`sf.dp.tpl.${template.id.replace('template_destination_', '')}`
			);
	});
});

describe('sample values', () => {
	const attributes = (schema: Record<string, unknown>) =>
		schema.attributes as Array<Record<string, unknown>>;

	it('every SAML template attribute has sample values, and they survive the table', () => {
		for (const template of templatesFor('saml')) {
			for (const attribute of attributes(template.schema))
				expect(attribute.examples, `${template.displayName} ${attribute.label}`).toBeTruthy();
			const again = schemaFromForm(formFromSchema('saml', '', template.schema));
			expect(attributes(again).map((attribute) => attribute.examples)).toEqual(
				attributes(template.schema).map((attribute) => attribute.examples)
			);
		}
	});

	it('are in the language and place of the federation they belong to', () => {
		const by = (key: string, label: string) =>
			attributes(templatesFor('saml').find((template) => template.profileKey === key)!.schema).find(
				(attribute) => attribute.label === label
			)?.examples;
		expect(by('gakunin_application_standard_v2_8', 'jaSn')).toEqual(['山田']);
		expect(by('surfconext_attribute_overview', 'schacHomeOrganization')).toEqual(['example.nl']);
		expect(by('kafe_attribute_map', 'mail')).toEqual(['gildong.hong@example.ac.kr']);
	});

	it('are edited as a comma separated list, and left out when there are none', () => {
		const form = emptyProfileForm('saml');
		form.displayName = 'x';
		form.rows = [{ ...emptyRow('saml'), key: 'mail', examples: 'a@example.org, b@example.org' }];
		expect(attributes(schemaFromForm(form))[0].examples).toEqual([
			'a@example.org',
			'b@example.org'
		]);
		form.rows[0].examples = '';
		expect('examples' in attributes(schemaFromForm(form))[0]).toBe(false);
	});

	it('are kept exactly when their text is not edited, even with commas or non-text values', () => {
		const schema = {
			destinationType: 'saml',
			nameId: {
				format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
				source: 'subject_identifier'
			},
			attributes: [{ name: 'sn', label: 'sn', valueType: 'string', examples: ['Doe, Jane', 5] }]
		};
		const form = formFromSchema('saml', 'x', schema);
		expect(attributes(schemaFromForm(form))[0].examples).toEqual(['Doe, Jane', 5]);
		// Edited, they are what the text says.
		form.rows[0].examples = 'Smith';
		expect(attributes(schemaFromForm(form))[0].examples).toEqual(['Smith']);
	});
});
