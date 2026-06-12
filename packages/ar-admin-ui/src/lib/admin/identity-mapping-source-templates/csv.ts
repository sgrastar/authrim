import type { SourceTemplate } from './types';

export const csvSourceTemplates: SourceTemplate[] = [
	{
		id: 'template_source_csv_basic_roster',
		sourceType: 'csv',
		category: 'General settings',
		profileKey: 'basic_csv_roster',
		displayName: 'Basic CSV roster',
		version: 'v1',
		updatedAt: '2026-06-11',
		description: 'Simple CSV source profile for email, display name, and group membership imports.',
		schema: {
			sourceType: 'csv',
			columns: [
				{
					stableColumnId: 'csv.template.email',
					headerName: 'email',
					label: 'Email',
					valueType: 'email',
					required: true,
					classification: 'pii',
					examples: ['person@example.com'],
					note: 'Mailbox address used as an input identity or matching key.',
					allowedValues: [],
					valueMultiplicity: 'single',
					nullable: false,
					candidates: {},
					warnings: [],
					emptyRate: 0,
					observedNonEmptyRows: 0
				},
				{
					stableColumnId: 'csv.template.display_name',
					headerName: 'display_name',
					label: 'Display name',
					valueType: 'string',
					required: false,
					classification: 'pii',
					examples: ['Taro Yamada'],
					note: 'Human-readable name from the source file.',
					allowedValues: [],
					valueMultiplicity: 'single',
					nullable: true,
					candidates: {},
					warnings: [],
					emptyRate: 0,
					observedNonEmptyRows: 0
				},
				{
					stableColumnId: 'csv.template.groups',
					headerName: 'groups',
					label: 'Groups',
					valueType: 'string',
					required: false,
					classification: 'public',
					examples: ['Engineering,Admins'],
					note: 'Source group names, usually split later by a transform or import rule.',
					allowedValues: [],
					valueMultiplicity: 'multi',
					nullable: true,
					candidates: {},
					warnings: [],
					emptyRate: 0,
					observedNonEmptyRows: 0
				}
			],
			warnings: [],
			summary: {
				columnCount: 3,
				rowSampleCount: 0,
				piiCandidateCount: 2,
				regulatedCandidateCount: 0,
				requiredCandidateCount: 1,
				blockingWarningCount: 0
			}
		}
	}
];
