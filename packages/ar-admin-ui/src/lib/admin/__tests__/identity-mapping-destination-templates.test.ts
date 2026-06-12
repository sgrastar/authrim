import { describe, expect, it } from 'vitest';
import { destinationTemplates } from '../identity-mapping-destination-templates';
import { sourceTemplates } from '../identity-mapping-source-templates';
import { buildIdentityMappingFlowSamples } from '../../components/identity-mapping/flow-data';

describe('field mapping destination templates', () => {
	it('carries preset examples and notes into Flow Editor destination nodes', () => {
		for (const template of destinationTemplates) {
			const samples = buildIdentityMappingFlowSamples({
				policies: [],
				catalogs: [],
				sourceProfiles: [],
				destinationProfiles: [
					{
						id: `destination_${template.id}`,
						tenantId: 'tenant_a',
						destinationType: template.destinationType,
						profileKey: template.profileKey,
						displayName: template.displayName,
						ownerScopeType: 'tenant',
						lifecycleState: 'active',
						version: {
							id: `version_${template.id}`,
							versionLabel: template.version,
							lifecycleState: 'active',
							schema: template.schema
						}
					}
				],
				protocolSchemas: [],
				externalSchemas: [],
				schemaReadinessRows: []
			});
			const destinationNodes = samples[0].nodes.filter((node) => node.role === 'destination');

			expect(destinationNodes.length, template.id).toBeGreaterThan(0);
			expect(
				destinationNodes.some((node) => (node.examples?.length ?? 0) > 0),
				template.id
			).toBe(true);
			expect(
				destinationNodes.some((node) => Boolean(node.note)),
				template.id
			).toBe(true);
			if (schemaAttributes(template.schema).some((attribute) => Boolean(attribute.format))) {
				expect(
					destinationNodes.some((node) => Boolean(node.format)),
					template.id
				).toBe(true);
			}
		}
	});

	it('preserves eduPersonTargetedID as a persistent SAML NameID value type', () => {
		for (const template of destinationTemplates) {
			const templateAttributes = schemaAttributes(template.schema);
			const targetedIdAttribute = templateAttributes.find(
				(attribute) => attribute.label === 'eduPersonTargetedID'
			);
			if (!targetedIdAttribute) {
				continue;
			}

			expect(targetedIdAttribute.valueType, template.id).toBe('saml:persistent-nameid');

			const samples = buildIdentityMappingFlowSamples({
				policies: [],
				catalogs: [],
				sourceProfiles: [],
				destinationProfiles: [
					{
						id: `destination_${template.id}`,
						tenantId: 'tenant_a',
						destinationType: template.destinationType,
						profileKey: template.profileKey,
						displayName: template.displayName,
						ownerScopeType: 'tenant',
						lifecycleState: 'active',
						version: {
							id: `version_${template.id}`,
							versionLabel: template.version,
							lifecycleState: 'active',
							schema: template.schema
						}
					}
				],
				protocolSchemas: [],
				externalSchemas: [],
				schemaReadinessRows: []
			});
			const targetedIdNode = samples[0].nodes.find(
				(node) => node.role === 'destination' && node.label === 'eduPersonTargetedID'
			);

			expect(targetedIdNode?.valueType, template.id).toBe('saml:persistent-nameid');
			expect(targetedIdNode?.type, template.id).toBe('Saml:Persistent Nameid');
		}
	});

	it('keeps vendor SAML destination templates separated as outbound profiles with formats', () => {
		const vendorTemplates = destinationTemplates.filter(
			(template) =>
				template.destinationType === 'saml' &&
				template.category === 'Vendor specific / outbound' &&
				template.profileKey !== 'enterprise_saml_basic'
		);

		expect(vendorTemplates.map((template) => template.profileKey)).toEqual(
			expect.arrayContaining([
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
				'google_workspace_custom_saml_app'
			])
		);
		expect(vendorTemplates.length).toBeGreaterThanOrEqual(11);

		for (const template of vendorTemplates) {
			expect(template.schema.samlFlow, template.id).toBe('outbound');
			expect(schemaAttributes(template.schema).some((attribute) => Boolean(attribute.format))).toBe(
				true
			);
		}
	});

	it('keeps source templates separated as CSV or inbound SAML profiles', () => {
		expect(sourceTemplates.some((template) => template.sourceType === 'csv')).toBe(true);

		const samlSourceTemplates = sourceTemplates.filter(
			(template) => template.sourceType === 'saml'
		);
		expect(samlSourceTemplates.map((template) => template.profileKey)).toEqual(
			expect.arrayContaining([
				'slack_saml_workspace_inbound',
				'microsoft_entra_custom_saml_app_inbound',
				'salesforce_saml_sso_inbound',
				'sap_successfactors_saml_inbound',
				'sap_btp_ias_saml_inbound',
				'zendesk_saml_sso_inbound',
				'box_saml_sso_inbound',
				'atlassian_cloud_saml_inbound',
				'aws_saml_console_inbound',
				'servicenow_saml_sso_inbound',
				'google_workspace_custom_saml_app_inbound'
			])
		);

		for (const template of samlSourceTemplates) {
			expect(template.category, template.id).toContain('inbound');
			expect(template.schema.samlFlow, template.id).toBe('inbound');
			expect(schemaAttributes(template.schema).length, template.id).toBeGreaterThan(0);
		}
	});

	it('keeps inbound SAML source templates aligned with outbound destination SAML attributes', () => {
		const destinationTemplatesByProfileKey = new Map(
			destinationTemplates
				.filter((template) => template.destinationType === 'saml')
				.map((template) => [template.profileKey, template])
		);
		const samlSourceTemplates = sourceTemplates.filter(
			(template) => template.sourceType === 'saml'
		);

		for (const sourceTemplate of samlSourceTemplates) {
			const destinationProfileKey = sourceTemplate.profileKey.replace(/_inbound$/, '');
			const destinationTemplate = destinationTemplatesByProfileKey.get(destinationProfileKey);
			expect(destinationTemplate, sourceTemplate.profileKey).toBeDefined();

			const sourceAttributes = comparableSamlAttributes(sourceTemplate.schema);
			const destinationAttributes = comparableSamlAttributes(destinationTemplate?.schema);
			expect(sourceAttributes, sourceTemplate.profileKey).toEqual(destinationAttributes);
		}
	});
});

function schemaAttributes(
	schema: unknown
): Array<{ label?: string; valueType?: string; format?: string }> {
	if (!schema || typeof schema !== 'object' || !('attributes' in schema)) {
		return [];
	}
	const attributes = (schema as { attributes?: unknown }).attributes;
	if (!Array.isArray(attributes)) {
		return [];
	}
	return attributes
		.filter((attribute): attribute is { label?: unknown; valueType?: unknown; format?: unknown } =>
			Boolean(attribute && typeof attribute === 'object')
		)
		.map((attribute) => ({
			label: typeof attribute.label === 'string' ? attribute.label : undefined,
			valueType: typeof attribute.valueType === 'string' ? attribute.valueType : undefined,
			format: typeof attribute.format === 'string' ? attribute.format : undefined
		}));
}

function comparableSamlAttributes(schema: unknown) {
	if (!schema || typeof schema !== 'object' || !('attributes' in schema)) {
		return [];
	}
	const attributes = (schema as { attributes?: unknown }).attributes;
	if (!Array.isArray(attributes)) {
		return [];
	}
	return attributes.filter(isRecord).map((attribute) => ({
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
	}));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
