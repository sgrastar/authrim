import { describe, expect, it } from 'vitest';

import {
	createLoginUiRuntimeContractPreview,
	formatLoginUiRuntimeContractPreview,
	getNewFlowTemplate,
	newFlowTemplates,
	type LoginUiRuntimeContractPreview,
	type NewFlowTemplate
} from '../new-flow-templates';

function requireTemplate(
	id:
		| 'default-login'
		| 'default-login-no-consent'
		| 'default-registration'
		| 'default-registration-no-consent'
		| 'academic-saml-login'
		| 'saml-sp-oidc-rp'
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
	it('assigns screen references to every renderable Login UI screen step', () => {
		const screenBackedComponents = new Set([
			'authentication_method_selector',
			'registration_method_selector',
			'screen'
		]);

		expect(newFlowTemplates.length).toBeGreaterThan(0);
		for (const template of newFlowTemplates) {
			const contract = createLoginUiRuntimeContractPreview(template);

			for (const step of contract.runtime.ui.steps) {
				if (!step.render || !screenBackedComponents.has(step.component)) continue;
				expect(step.config, `${template.id}:${step.source_node_id}`).toMatchObject({
					screen_ref: expect.any(String)
				});
				expect((step.config.screen_ref as string).trim()).not.toEqual('');
			}

			for (const node of contract.editor.nodes) {
				if (!['authentication', 'registration', 'screen'].includes(node.type)) continue;
				expect(node.config, `${template.id}:${node.id}`).toMatchObject({
					screen_ref: expect.any(String)
				});
				expect((node.config.screen_ref as string).trim()).not.toEqual('');
			}
		}
	});

	it('creates a LoginUI runtime contract preview for the login flow', () => {
		const template = requireTemplate('default-login');

		const contract = createLoginUiRuntimeContractPreview(template);

		expect(contract).toMatchObject({
			schema_version: 'authrim.login_ui.contract.v1',
			mode: 'preview',
			runtime: {
				flow_id: 'preview:default-login',
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
				contract_id: 'preview:default-login',
				flow: {
					id: 'default-login',
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
		const template = requireTemplate('default-registration');

		const parsed = parsePreviewContract(formatLoginUiRuntimeContractPreview(template));

		expect(parsed.runtime.runtime_bindings).toMatchObject({
			authentication_method_profile: 'default',
			consent_statement_ref: 'terms_of_service / privacy_policy'
		});
		expect(parsed.runtime.ui.steps.map((step) => step.component)).toContain('screen');
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

	it('creates a login template without consent confirmation', () => {
		const template = requireTemplate('default-login-no-consent');

		const contract = createLoginUiRuntimeContractPreview(template);

		expect(contract).toMatchObject({
			runtime: {
				flow_id: 'preview:default-login-no-consent',
				flow_kind: 'login',
				runtime_bindings: {
					authentication_method_profile: 'default'
				}
			},
			preview: {
				flow: {
					id: 'default-login-no-consent',
					title: 'Login (No consent)'
				}
			}
		});
		expect(contract.runtime.runtime_bindings).not.toHaveProperty('consent_policy_ref');
		expect(contract.runtime.runtime_bindings).not.toHaveProperty('consent_statement_ref');
		expect(contract.runtime.ui.steps.map((step) => step.component)).toEqual([
			'interaction_context',
			'session_check',
			'authentication_method_selector',
			'completion',
			'completion'
		]);
		expect(
			contract.runtime.ui.steps.find((step) => step.source_node_id === 'authentication')?.config
		).toMatchObject({
			screen_ref: 'login'
		});
		expect(
			contract.editor.nodes.find((node) => node.id === 'authentication')?.config
		).toMatchObject({
			screen_ref: 'login'
		});
		expect(contract.runtime.ui.steps.map((step) => step.source_node_id)).not.toContain('consent');
		expect(contract.runtime.capabilities).toHaveLength(1);
		expect(contract.editor.nodes.map((node) => node.id)).not.toContain(
			'oidc-authorization-consent'
		);
		expect(contract.editor.nodes.map((node) => node.id)).toEqual(
			expect.arrayContaining(['saml-attribute-release-complete', 'oidc-authorization-complete'])
		);
		expect(
			contract.editor.edges.some(
				(edge) =>
					edge.source === 'authentication' &&
					edge.source_handle === 'passkey' &&
					edge.target === 'oidc-authorization-complete'
			)
		).toBe(true);
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
	});

	it('creates a registration template without profile input or consent', () => {
		const template = requireTemplate('default-registration-no-consent');

		const parsed = parsePreviewContract(formatLoginUiRuntimeContractPreview(template));

		expect(parsed.runtime.runtime_bindings).not.toHaveProperty('consent_policy_ref');
		expect(parsed.runtime.runtime_bindings).not.toHaveProperty('consent_statement_ref');
		expect(parsed.runtime.ui.steps.map((step) => step.component)).toEqual([
			'interaction_context',
			'registration_method_selector',
			'account_action',
			'completion'
		]);
		expect(parsed.runtime.ui.steps.map((step) => step.component)).not.toContain('screen');
		expect(parsed.runtime.ui.steps.map((step) => step.component)).not.toContain('consent_policy');
		expect(
			parsed.runtime.ui.steps.find((step) => step.source_node_id === 'registration-method')?.config
		).toMatchObject({
			screen_ref: 'registration'
		});
		expect(parsed.runtime.capabilities).toHaveLength(1);
		expect(parsed.editor.nodes.map((node) => node.id)).not.toContain('profile-input');
		expect(parsed.editor.nodes.map((node) => node.id)).not.toContain('consent');
		expect(
			parsed.editor.edges.some(
				(edge) =>
					edge.source === 'registration-method' &&
					edge.source_handle === 'passkey' &&
					edge.target === 'account-create'
			)
		).toBe(true);
		expect(parsed.editor.nodes.find((node) => node.id === 'output')?.config).toMatchObject({
			completion_block: {
				id: 'oidc-registration-completion',
				protocol: 'oidc',
				purpose: 'registration',
				role: 'output'
			}
		});
	});

	it('creates the SAML SP/OIDC RP preset with one protocol branch and no consent', () => {
		const template = requireTemplate('saml-sp-oidc-rp');

		const contract = createLoginUiRuntimeContractPreview(template);
		const condition = contract.editor.nodes.find((node) => node.id === 'protocol-condition');

		expect(contract).toMatchObject({
			runtime: {
				flow_kind: 'login',
				runtime_bindings: { authentication_method_profile: 'default' },
				protocol_context: { protocol: 'custom:saml-oidc' }
			},
			preview: {
				flow: {
					id: 'saml-sp-oidc-rp',
					title: 'SAML SP/OIDC RP Flow'
				}
			}
		});
		expect(contract.runtime.runtime_bindings).not.toHaveProperty('consent_policy_ref');
		expect(contract.runtime.runtime_bindings).not.toHaveProperty('consent_statement_ref');
		expect(contract.editor.nodes.some((node) => node.type === 'consent')).toBe(false);
		expect(
			contract.runtime.ui.steps.find((step) => step.source_node_id === 'protocol-condition')
		).toMatchObject({ component: 'condition', render: false });
		expect(condition).toMatchObject({
			type: 'condition',
			config: {
				conditions: {
					rows: [
						{ condition: { type: 'protocol', value: 'saml' }, output_handle: 'saml' },
						{ condition: { type: 'protocol', value: 'oidc' }, output_handle: 'oidc' }
					]
				}
			}
		});
		expect(contract.editor.edges.filter((edge) => edge.target === 'protocol-condition')).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: 'session-check', source_handle: 'continue' }),
				expect.objectContaining({ source: 'authentication', source_handle: 'mail_otp' }),
				expect.objectContaining({ source: 'authentication', source_handle: 'totp' }),
				expect.objectContaining({ source: 'authentication', source_handle: 'passkey' }),
				expect.objectContaining({ source: 'authentication', source_handle: 'facebook' })
			])
		);
		expect(contract.editor.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: 'protocol-condition',
					source_handle: 'saml',
					target: 'saml-complete'
				}),
				expect.objectContaining({
					source: 'protocol-condition',
					source_handle: 'oidc',
					target: 'oidc-complete'
				})
			])
		);
		expect(contract.editor.nodes.find((node) => node.id === 'saml-complete')).toMatchObject({
			title: 'SAML End',
			config: { completion_block: { protocol: 'saml', role: 'output' } }
		});
		expect(contract.editor.nodes.find((node) => node.id === 'oidc-complete')).toMatchObject({
			title: 'OIDC End',
			config: { completion_block: { protocol: 'oidc', role: 'output' } }
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
