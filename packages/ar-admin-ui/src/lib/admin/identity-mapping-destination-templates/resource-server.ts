import type { DestinationTemplate } from './types';

export const resourceServerDestinationTemplates: DestinationTemplate[] = [
	{
		id: 'template_destination_resource_server_standard',
		destinationType: 'resource_server',
		category: 'General settings',
		profileKey: 'standard_introspection',
		displayName: 'Standard Resource Server introspection',
		version: 'v1',
		updatedAt: '2026-08-13',
		description:
			'Fail-closed Introspection release profile with protocol metadata and scoped extension claims.',
		schema: {
			destinationType: 'resource_server',
			claims: [
				{
					claimName: 'active',
					label: 'Active',
					valueType: 'boolean',
					required: true,
					classification: 'internal',
					requiredScopes: []
				},
				{
					claimName: 'roles',
					label: 'Roles',
					valueType: 'string',
					valueMultiplicity: 'multi',
					classification: 'internal',
					requiredScopes: ['roles']
				},
				{
					claimName: 'permissions',
					label: 'Permissions',
					valueType: 'string',
					valueMultiplicity: 'multi',
					classification: 'internal',
					requiredScopes: ['permissions']
				}
			]
		}
	}
];
