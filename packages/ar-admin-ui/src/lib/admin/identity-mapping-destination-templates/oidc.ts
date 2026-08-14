import type { DestinationTemplate } from './types';

export const oidcDestinationTemplates: DestinationTemplate[] = [
	{
		id: 'template_destination_oidc_standard',
		destinationType: 'oidc',
		category: 'General settings',
		profileKey: 'standard_oidc_claims',
		displayName: 'Standard OIDC claims',
		version: 'v1',
		updatedAt: '2026-06-26',
		description: 'OpenID Connect Core and profile claims for ID Token and UserInfo output.',
		schema: {
			destinationType: 'oidc',
			subjectContract: {
				required: true,
				strategySource: 'tenant_default_with_client_override'
			},
			claims: [
				{
					claimName: 'sub',
					label: 'Subject',
					valueType: 'string',
					required: true,
					classification: 'internal',
					surfaces: ['id_token', 'userinfo'],
					requiredScopes: []
				},
				{
					claimName: 'name',
					label: 'Full name',
					valueType: 'string',
					classification: 'pii',
					surfaces: ['userinfo'],
					requiredScopes: ['profile']
				},
				{
					claimName: 'given_name',
					label: 'Given name',
					valueType: 'string',
					classification: 'pii',
					surfaces: ['userinfo'],
					requiredScopes: ['profile']
				},
				{
					claimName: 'family_name',
					label: 'Family name',
					valueType: 'string',
					classification: 'pii',
					surfaces: ['userinfo'],
					requiredScopes: ['profile']
				},
				{
					claimName: 'middle_name',
					label: 'Middle name',
					valueType: 'string',
					classification: 'pii',
					surfaces: ['userinfo'],
					requiredScopes: ['profile']
				},
				{
					claimName: 'nickname',
					label: 'Nickname',
					valueType: 'string',
					classification: 'pii',
					surfaces: ['userinfo'],
					requiredScopes: ['profile']
				},
				{
					claimName: 'preferred_username',
					label: 'Preferred username',
					valueType: 'string',
					classification: 'pii',
					surfaces: ['userinfo'],
					requiredScopes: ['profile']
				},
				{
					claimName: 'profile',
					label: 'Profile URL',
					valueType: 'string',
					classification: 'pii',
					surfaces: ['userinfo'],
					requiredScopes: ['profile']
				},
				{
					claimName: 'picture',
					label: 'Picture URL',
					valueType: 'string',
					classification: 'pii',
					surfaces: ['userinfo'],
					requiredScopes: ['profile']
				},
				{
					claimName: 'website',
					label: 'Website URL',
					valueType: 'string',
					classification: 'pii',
					surfaces: ['userinfo'],
					requiredScopes: ['profile']
				},
				{
					claimName: 'gender',
					label: 'Gender',
					valueType: 'string',
					classification: 'pii',
					surfaces: ['userinfo'],
					requiredScopes: ['profile']
				},
				{
					claimName: 'birthdate',
					label: 'Birthdate',
					valueType: 'date',
					classification: 'pii',
					surfaces: ['userinfo'],
					requiredScopes: ['profile']
				},
				{
					claimName: 'zoneinfo',
					label: 'Time zone',
					valueType: 'string',
					classification: 'pii',
					surfaces: ['userinfo'],
					requiredScopes: ['profile']
				},
				{
					claimName: 'locale',
					label: 'Locale',
					valueType: 'string',
					classification: 'pii',
					surfaces: ['userinfo'],
					requiredScopes: ['profile']
				},
				{
					claimName: 'updated_at',
					label: 'Profile updated at',
					valueType: 'number',
					classification: 'internal',
					surfaces: ['userinfo'],
					requiredScopes: ['profile']
				},
				{
					claimName: 'email',
					label: 'Email',
					valueType: 'email',
					classification: 'pii',
					surfaces: ['userinfo'],
					requiredScopes: ['email']
				},
				{
					claimName: 'email_verified',
					label: 'Email verified',
					valueType: 'boolean',
					classification: 'internal',
					surfaces: ['userinfo'],
					requiredScopes: ['email']
				},
				{
					claimName: 'phone_number',
					label: 'Phone number',
					valueType: 'phone',
					classification: 'pii',
					surfaces: ['userinfo'],
					requiredScopes: ['phone']
				},
				{
					claimName: 'phone_number_verified',
					label: 'Phone number verified',
					valueType: 'boolean',
					classification: 'internal',
					surfaces: ['userinfo'],
					requiredScopes: ['phone']
				},
				{
					claimName: 'address',
					label: 'Address',
					valueType: 'json',
					classification: 'pii',
					surfaces: ['userinfo'],
					requiredScopes: ['address']
				}
			]
		}
	}
];
