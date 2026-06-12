import { samlDestinationTemplates } from '../identity-mapping-destination-templates/saml';
import type { SourceTemplate } from './types';

const inboundVendorProfileKeys = new Set([
	'slack_saml_workspace',
	'microsoft_entra_custom_saml_app',
	'salesforce_saml_sso',
	'sap_successfactors_saml',
	'sap_btp_ias_saml',
	'zendesk_saml_sso',
	'box_saml_sso',
	'atlassian_cloud_saml',
	'aws_saml_console',
	'servicenow_saml_sso',
	'google_workspace_custom_saml_app',
	'enterprise_saml_basic'
]);

export const samlSourceTemplates: SourceTemplate[] = samlDestinationTemplates
	.filter(
		(template) =>
			template.destinationType === 'saml' && inboundVendorProfileKeys.has(template.profileKey)
	)
	.map((template) => {
		const schema = template.schema as {
			nameId?: Record<string, unknown>;
			attributes?: Array<Record<string, unknown>>;
		};
		return {
			id: template.id.replace('template_destination_', 'template_source_'),
			sourceType: 'saml',
			category: template.category.replace('outbound', 'inbound'),
			profileKey: `${template.profileKey}_inbound`,
			displayName: template.displayName.replace(' SAML', ' inbound SAML'),
			version: template.version,
			updatedAt: template.updatedAt,
			description: template.description.replace(
				/SAML release contract|SAML contract|SAML profile|release profile/i,
				'inbound SAML assertion profile'
			),
			schema: {
				sourceType: 'saml',
				samlFlow: 'inbound',
				nameId: schema.nameId,
				attributes: (schema.attributes ?? []).map((attribute) => ({
					name: attribute.name,
					label: attribute.label,
					nameFormat: attribute.nameFormat,
					valueType: attribute.valueType,
					format: attribute.format,
					examples: attribute.examples,
					note: attribute.note,
					allowedValues: attribute.allowedValues,
					valueMultiplicity: attribute.valueMultiplicity,
					nullable: attribute.nullable,
					classification: attribute.classification,
					required: attribute.required
				}))
			}
		};
	});
