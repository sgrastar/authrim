import type { DestinationTemplate } from './types';

export const csvDestinationTemplates: DestinationTemplate[] = [
	{
		id: 'template_destination_csv_basic_export',
		destinationType: 'csv',
		category: 'General settings',
		profileKey: 'basic_csv_export',
		displayName: 'Basic CSV export',
		version: 'v1',
		updatedAt: '2026-06-02',
		description: 'Simple CSV destination profile with email and display name columns.',
		schema: {
			destinationType: 'csv',
			defaults: {
				encoding: 'utf-8',
				includeHeader: true,
				nullHandling: 'empty',
				requiredMissingPolicy: 'review'
			},
			columns: [
				{
					columnName: 'email',
					label: 'Email',
					order: 1,
					valueType: 'email',
					classification: 'pii',
					required: true,
					nullHandling: 'empty',
					requiredMissingPolicy: 'review',
					exportPolicy: { legalBasis: 'consent', purpose: 'attribute_release' }
				},
				{
					columnName: 'display_name',
					label: 'Display name',
					order: 2,
					valueType: 'string',
					classification: 'pii',
					required: false,
					nullHandling: 'empty',
					requiredMissingPolicy: 'omit',
					exportPolicy: { legalBasis: 'consent', purpose: 'attribute_release' }
				}
			]
		}
	}
];
