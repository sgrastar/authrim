import { describe, expect, it } from 'vitest';

import {
	createLoginUiRuntimeContractPreview,
	formatLoginUiRuntimeContractPreview,
	getNewFlowTemplate,
	type LoginUiRuntimeContractPreview,
	type NewFlowTemplate
} from '../new-flow-templates';

function requireTemplate(
	id: 'oidc-login' | 'oidc-registration' | 'academic-saml-login'
): NewFlowTemplate {
	const template = getNewFlowTemplate(id);
	if (!template) {
		throw new Error(`Missing test fixture template: ${id}`);
	}
	return template;
}

function parsePreviewContract(value: string): LoginUiRuntimeContractPreview {
	const parsed: unknown = JSON.parse(value);
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!('runtime' in parsed) ||
		typeof parsed.runtime !== 'object' ||
		parsed.runtime === null ||
		!('ui' in parsed.runtime) ||
		typeof parsed.runtime.ui !== 'object' ||
		parsed.runtime.ui === null ||
		!('steps' in parsed.runtime.ui) ||
		!Array.isArray(parsed.runtime.ui.steps)
	) {
		throw new Error('Preview contract JSON did not contain UI steps');
	}
	return parsed as LoginUiRuntimeContractPreview;
}

describe('new flow templates', () => {
	it('creates a LoginUI runtime contract preview for the login flow', () => {
		const template = requireTemplate('oidc-login');

		const contract = createLoginUiRuntimeContractPreview(template);

		expect(contract).toMatchObject({
			schema_version: 'authrim.login_ui.contract.v1',
			mode: 'preview',
			runtime: {
				flow_id: 'preview:oidc-login',
				flow_kind: 'login',
				runtime_bindings: {
					authentication_method_profile: 'default',
					consent_policy_ref: 'Login and authorization consent policy'
				},
				protocol_context: {
					protocol: 'oidc'
				}
			},
			preview: {
				contract_id: 'preview:oidc-login',
				flow: {
					id: 'oidc-login',
					kind: 'login',
					protocol: 'oidc'
				}
			}
		});
		expect(contract.runtime.ui.steps.map((step) => step.component)).toEqual([
			'interaction_context',
			'session_check',
			'authentication_method_selector',
			'consent_policy',
			'completion'
		]);
		expect(
			contract.runtime.ui.steps.find((step) => step.source_node_id === 'authentication')?.config
				.outputs
		).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'totp' })]));
		expect(
			contract.editor.edges.some(
				(edge) => edge.source === 'authentication' && edge.source_handle === 'totp'
			)
		).toBe(true);
		expect(contract.runtime.capabilities).toHaveLength(2);
		expect(contract.editor.nodes.map((node) => node.id)).toContain('authentication');
		expect(
			contract.editor.nodes.find((node) => node.id === 'oidc-authorization-consent')?.config
		).toMatchObject({
			completion_block: {
				id: 'oidc-authorization-completion',
				protocol: 'oidc',
				purpose: 'authorization',
				role: 'consent'
			}
		});
		expect(
			contract.editor.nodes.find((node) => node.id === 'oidc-authorization-complete')?.config
		).toMatchObject({
			completion_block: {
				id: 'oidc-authorization-completion',
				protocol: 'oidc',
				purpose: 'authorization',
				role: 'output'
			}
		});
		expect(
			contract.editor.nodes.find((node) => node.id === 'saml-attribute-release-consent')?.config
		).toMatchObject({
			completion_block: {
				id: 'saml-attribute-release-completion',
				protocol: 'saml',
				purpose: 'attribute_release',
				role: 'consent'
			}
		});
	});

	it('serializes the registration preview as readable JSON', () => {
		const template = requireTemplate('oidc-registration');

		const parsed = parsePreviewContract(formatLoginUiRuntimeContractPreview(template));

		expect(parsed.runtime.runtime_bindings).toMatchObject({
			authentication_method_profile: 'default',
			consent_statement_ref: 'terms_of_service / privacy_policy'
		});
		expect(parsed.runtime.ui.steps.map((step) => step.component)).toContain('profile_form');
		expect(parsed.runtime.ui.steps.map((step) => step.component)).toContain('account_action');
		expect(parsed.editor.edges.some((edge) => edge.source_handle === 'passkey')).toBe(true);
		expect(parsed.editor.edges.some((edge) => edge.source_handle === 'totp')).toBe(true);
		expect(parsed.editor.nodes.find((node) => node.id === 'consent')?.config).toMatchObject({
			completion_block: {
				id: 'oidc-registration-completion',
				protocol: 'oidc',
				purpose: 'registration'
			}
		});
	});

	it('creates an Academic SAML login template with a single Entry node and SAML completion', () => {
		const template = requireTemplate('academic-saml-login');

		const contract = createLoginUiRuntimeContractPreview(template);

		expect(contract).toMatchObject({
			runtime: {
				flow_id: 'preview:academic-saml-login',
				flow_kind: 'login',
				protocol_context: {
					protocol: 'saml'
				}
			},
			preview: {
				flow: {
					id: 'academic-saml-login',
					kind: 'login',
					protocol: 'saml'
				}
			}
		});
		expect(contract.runtime.ui.steps.map((step) => step.component)).toEqual([
			'interaction_context',
			'session_check',
			'authentication_method_selector',
			'consent_policy',
			'completion'
		]);
		expect(contract.editor.nodes.find((node) => node.id === 'request')).toMatchObject({
			type: 'entry',
			title: 'Entry'
		});
		expect(contract.editor.nodes.map((node) => node.id)).not.toContain('saml-login-request');
		expect(contract.editor.nodes.map((node) => node.id)).not.toContain(
			'oidc-authorization-consent'
		);
		expect(
			contract.editor.nodes.find((node) => node.id === 'saml-attribute-release-consent')?.config
		).toMatchObject({
			consent_policy_ref: 'saml_attribute_release_policy',
			completion_block: {
				id: 'saml-attribute-release-completion',
				protocol: 'saml',
				purpose: 'attribute_release',
				role: 'consent'
			}
		});
	});
});
