import type { Flow } from './admin-flows';

const CREATED_AT = 1766707200;
const UPDATED_AT = 1782604800;

export const LEGACY_PREVIEW_FLOW_PREFIX = 'legacy-preview-';

export function isLegacyPreviewFlowId(id: string): boolean {
	return id.startsWith(LEGACY_PREVIEW_FLOW_PREFIX);
}

export function listLegacyPreviewFlows(): Flow[] {
	return legacyPreviewFlows.map((flow) => ({
		...flow,
		graph_definition: flow.graph_definition
			? {
					...flow.graph_definition,
					nodes: flow.graph_definition.nodes.map((node) => ({ ...node, data: { ...node.data } })),
					edges: flow.graph_definition.edges.map((edge) => ({
						...edge,
						data: edge.data ? { ...edge.data } : undefined
					})),
					metadata: { ...flow.graph_definition.metadata }
				}
			: null,
		compiled_plan: flow.compiled_plan ? { ...flow.compiled_plan } : null
	}));
}

export function getLegacyPreviewFlow(id: string): Flow | null {
	return listLegacyPreviewFlows().find((flow) => flow.id === id) ?? null;
}

export function createLegacyPreviewCompiledPlan(id: string): Record<string, unknown> {
	const flow = getLegacyPreviewFlow(id);
	return {
		id: `${id}-compiled-preview`,
		preview: true,
		version: flow?.version ?? '1.0.0',
		nodeCount: flow?.graph_definition?.nodes.length ?? 0,
		compiledAt: new Date().toISOString(),
		note: 'Legacy preview only. This plan is not connected to runtime execution.'
	};
}

const legacyPreviewFlows: Flow[] = [
	{
		id: 'legacy-preview-registration',
		tenant_id: 'preview',
		client_id: null,
		profile_id: 'human-basic',
		name: 'Legacy Registration Flow Preview',
		description:
			'Old server-driven registration concept: identify user, collect profile fields, capture consent, create account, and redirect.',
		version: '1.0.0',
		is_active: false,
		is_builtin: false,
		created_by: 'legacy-preview',
		created_at: CREATED_AT,
		updated_by: 'legacy-preview',
		updated_at: UPDATED_AT,
		compiled_plan: null,
		graph_definition: {
			id: 'legacy-preview-registration',
			flowVersion: '1.0.0',
			name: 'Legacy Registration Flow Preview',
			description:
				'Old server-driven registration concept: identify user, collect profile fields, capture consent, create account, and redirect.',
			profileId: 'human-basic',
			nodes: [
				{
					id: 'start',
					type: 'start',
					position: { x: 80, y: 160 },
					data: { label: 'Start' }
				},
				{
					id: 'identifier',
					type: 'identifier',
					position: { x: 300, y: 160 },
					data: { label: 'Identifier', config: { type: 'email' } }
				},
				{
					id: 'profile',
					type: 'profile_input',
					position: { x: 540, y: 160 },
					data: { label: 'Profile Input', config: { fields: ['name', 'email'] } }
				},
				{
					id: 'consent',
					type: 'consent',
					position: { x: 800, y: 160 },
					data: { label: 'Terms / Privacy Consent', config: { policy_id: 'account-signup' } }
				},
				{
					id: 'register',
					type: 'register',
					position: { x: 1080, y: 160 },
					data: { label: 'Create Account', config: { auto_login: true } }
				},
				{
					id: 'redirect',
					type: 'redirect',
					position: { x: 1320, y: 160 },
					data: { label: 'Post Registration', config: { to: 'post_register' } }
				}
			],
			edges: [
				{ id: 'start-identifier', source: 'start', target: 'identifier', type: 'success' },
				{ id: 'identifier-profile', source: 'identifier', target: 'profile', type: 'success' },
				{ id: 'profile-consent', source: 'profile', target: 'consent', type: 'success' },
				{ id: 'consent-register', source: 'consent', target: 'register', type: 'success' },
				{ id: 'register-redirect', source: 'register', target: 'redirect', type: 'success' }
			],
			metadata: {
				createdAt: '2025-12-26T00:00:00.000Z',
				updatedAt: '2026-06-27T00:00:00.000Z',
				createdBy: 'legacy-preview'
			}
		}
	},
	{
		id: 'legacy-preview-login',
		tenant_id: 'preview',
		client_id: null,
		profile_id: 'human-basic',
		name: 'Legacy Login Flow Preview',
		description:
			'Old login concept: check session, select authentication method, run login, optionally step up, then issue session/tokens.',
		version: '1.0.0',
		is_active: false,
		is_builtin: false,
		created_by: 'legacy-preview',
		created_at: CREATED_AT,
		updated_by: 'legacy-preview',
		updated_at: UPDATED_AT,
		compiled_plan: null,
		graph_definition: {
			id: 'legacy-preview-login',
			flowVersion: '1.0.0',
			name: 'Legacy Login Flow Preview',
			description:
				'Old login concept: check session, select authentication method, run login, optionally step up, then issue session/tokens.',
			profileId: 'human-basic',
			nodes: [
				{
					id: 'start',
					type: 'start',
					position: { x: 80, y: 160 },
					data: { label: 'Start' }
				},
				{
					id: 'check-session',
					type: 'check_session',
					position: { x: 300, y: 160 },
					data: { label: 'Check Session', config: { fact: 'session.authenticated' } }
				},
				{
					id: 'auth-methods',
					type: 'auth_method_select',
					position: { x: 540, y: 160 },
					data: {
						label: 'Choose Auth Method',
						config: { available_methods: ['passkey', 'email_otp', 'external_idp'] }
					}
				},
				{
					id: 'login',
					type: 'login',
					position: { x: 820, y: 160 },
					data: { label: 'Authenticate', config: { method: 'selected' } }
				},
				{
					id: 'step-up',
					type: 'mfa',
					position: { x: 1080, y: 80 },
					data: { label: 'Step-up If Required', config: { factors: ['passkey'] } }
				},
				{
					id: 'issue-tokens',
					type: 'issue_tokens',
					position: { x: 1340, y: 160 },
					data: { label: 'Issue Session / Tokens' }
				}
			],
			edges: [
				{ id: 'start-check-session', source: 'start', target: 'check-session', type: 'success' },
				{
					id: 'check-session-auth-methods',
					source: 'check-session',
					target: 'auth-methods',
					type: 'conditional',
					data: { label: 'No session' }
				},
				{
					id: 'check-session-issue-tokens',
					source: 'check-session',
					target: 'issue-tokens',
					type: 'conditional',
					data: { label: 'Session ok' }
				},
				{ id: 'auth-methods-login', source: 'auth-methods', target: 'login', type: 'success' },
				{
					id: 'login-step-up',
					source: 'login',
					target: 'step-up',
					type: 'conditional',
					data: { label: 'Fresh auth required' }
				},
				{ id: 'login-issue-tokens', source: 'login', target: 'issue-tokens', type: 'success' },
				{ id: 'step-up-issue-tokens', source: 'step-up', target: 'issue-tokens', type: 'success' }
			],
			metadata: {
				createdAt: '2025-12-26T00:00:00.000Z',
				updatedAt: '2026-06-27T00:00:00.000Z',
				createdBy: 'legacy-preview'
			}
		}
	},
	{
		id: 'legacy-preview-authorization-consent',
		tenant_id: 'preview',
		client_id: 'preview-client',
		profile_id: 'human-org',
		name: 'Legacy Authorization / Consent Preview',
		description:
			'Old authorization concept: resolve client and mapping, check consent, show consent if needed, record evidence, then continue protocol.',
		version: '1.0.0',
		is_active: false,
		is_builtin: false,
		created_by: 'legacy-preview',
		created_at: CREATED_AT,
		updated_by: 'legacy-preview',
		updated_at: UPDATED_AT,
		compiled_plan: null,
		graph_definition: {
			id: 'legacy-preview-authorization-consent',
			flowVersion: '1.0.0',
			name: 'Legacy Authorization / Consent Preview',
			description:
				'Old authorization concept: resolve client and mapping, check consent, show consent if needed, record evidence, then continue protocol.',
			profileId: 'human-org',
			nodes: [
				{
					id: 'start',
					type: 'start',
					position: { x: 80, y: 180 },
					data: { label: 'Authorization Start' }
				},
				{
					id: 'resolve-policy',
					type: 'resolve_policy',
					position: { x: 340, y: 180 },
					data: { label: 'Resolve Client / Policy', config: { policy_type: 'authorization' } }
				},
				{
					id: 'mapping',
					type: 'policy_check',
					position: { x: 620, y: 180 },
					data: { label: 'Schema Mapping / Release Set', config: { target: 'field_mapping_set' } }
				},
				{
					id: 'check-consent',
					type: 'check_consent_status',
					position: { x: 920, y: 180 },
					data: { label: 'Check Consent', config: { consent_type: 'attribute_release' } }
				},
				{
					id: 'consent',
					type: 'consent',
					position: { x: 1210, y: 80 },
					data: { label: 'User Consent', config: { policy_id: 'sp-attribute-release' } }
				},
				{
					id: 'record',
					type: 'record_consent',
					position: { x: 1480, y: 80 },
					data: { label: 'Record Evidence', config: { evidence_profile: 'release_decision' } }
				},
				{
					id: 'continue',
					type: 'redirect',
					position: { x: 1760, y: 180 },
					data: { label: 'Continue Protocol', config: { to: 'post_consent' } }
				}
			],
			edges: [
				{ id: 'start-resolve-policy', source: 'start', target: 'resolve-policy', type: 'success' },
				{
					id: 'resolve-policy-mapping',
					source: 'resolve-policy',
					target: 'mapping',
					type: 'success'
				},
				{
					id: 'mapping-check-consent',
					source: 'mapping',
					target: 'check-consent',
					type: 'success'
				},
				{
					id: 'check-consent-consent',
					source: 'check-consent',
					target: 'consent',
					type: 'conditional',
					data: { label: 'Needs interaction' }
				},
				{
					id: 'check-consent-continue',
					source: 'check-consent',
					target: 'continue',
					type: 'conditional',
					data: { label: 'Already satisfied' }
				},
				{ id: 'consent-record', source: 'consent', target: 'record', type: 'success' },
				{ id: 'record-continue', source: 'record', target: 'continue', type: 'success' }
			],
			metadata: {
				createdAt: '2025-12-26T00:00:00.000Z',
				updatedAt: '2026-06-27T00:00:00.000Z',
				createdBy: 'legacy-preview'
			}
		}
	}
];
