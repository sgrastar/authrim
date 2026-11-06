import { describe, expect, it } from 'vitest';
import { localizeRuntimeScreen } from './runtime-screen-localization';

/** A select or radio part's choices follow a change of language without asking the server. */
describe('localizeRuntimeScreen: choices', () => {
	const screen = {
		display_name: 'Profile',
		localizations: { ja: { fields: { b1: { label: '部署' } } } },
		fields: [
			{
				field: 'department',
				block_id: 'b1',
				block_type: 'select',
				label: 'Department',
				options: [
					{
						value: 'sales',
						label: 'Ventes',
						default_label: 'Sales',
						labels: { fr: 'Ventes', ja: '営業', pt: 'Vendas', en: 'Sales (en)' }
					},
					{ value: 'eng', label: 'eng', default_label: 'Engineering', labels: {} },
					{ value: 'legacy', label: 'Legacy' }
				]
			},
			{ field: 'given_name', label: 'Given name' }
		]
	};

	const labels = (locale: string) =>
		(
			localizeRuntimeScreen(screen, locale)?.fields as Array<{
				options?: Array<{ label: string }>;
			}>
		)[0].options?.map((option) => option.label);

	it('shows each choice in the new language, else its default label', () => {
		expect(labels('ja')).toEqual(['営業', 'Engineering', 'Legacy']);
	});

	it('takes the base language of a regional one, never English', () => {
		expect(labels('pt-BR')).toEqual(['Vendas', 'Engineering', 'Legacy']);
		expect(labels('de')).toEqual(['Sales', 'Engineering', 'Legacy']);
	});

	it('leaves a part without choices without any', () => {
		const fields = localizeRuntimeScreen(screen, 'ja')?.fields as Array<Record<string, unknown>>;
		expect(fields[1]).not.toHaveProperty('options');
		expect(fields[0].label).toBe('部署');
	});
});
