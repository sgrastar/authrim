import { authrimFetch } from '../authrim/fetch';
import { buildDiagnosticHeaders, resolveApiBaseUrl, type APIError } from './client';

export type FlowRuntimeComponent =
	| 'interaction_context'
	| 'session_check'
	| 'registration_method_selector'
	| 'authentication_method_selector'
	| 'email_verification'
	| 'screen'
	| 'consent_policy'
	| 'account_action'
	| 'completion'
	| 'condition'
	| `custom:${string}`;

export interface FlowRuntimeStep {
	id: string;
	source_node_id: string;
	component: FlowRuntimeComponent;
	render: boolean;
	capability_ids?: string[];
	bindings?: Record<string, unknown>;
	content?: Record<string, unknown>;
	config?: Record<string, unknown>;
}

export interface FlowRuntimeConsentPolicyItem {
	statement_id: string;
	slug: string;
	category: string;
	title: string;
	description: string;
	document_url: string | null;
	inline_content: string | null;
	version: string;
	version_id: string;
	is_required: boolean;
	content_mode?: 'display_only' | 'checkbox' | 'radio';
	options?: FlowRuntimeConsentPolicyOption[];
	attribute_value_display?: 'names' | 'masked_values' | 'full_values' | null;
	checkbox_mode: 'none' | 'required' | 'optional';
	checkbox_default_checked: boolean;
	display_order: number;
}

export interface FlowRuntimeConsentPolicyOption {
	id: string;
	value: string;
	label: string;
	description: string;
}

export interface FlowRuntimeConsentPolicyContent {
	id: string;
	display_name: string;
	description: string | null;
	language: string;
	default_language: string;
	items: FlowRuntimeConsentPolicyItem[];
}

export interface FlowRuntimeContract {
	flow_kind: string;
	flow_id?: string;
	flow_version_id?: string;
	ui: {
		steps: FlowRuntimeStep[];
	};
	capabilities?: Record<string, unknown>[];
	runtime_bindings?: Record<string, unknown>;
	protocol_context?: Record<string, unknown>;
}

export interface FlowRuntimeInteraction {
	id: string;
	state: string;
	flow_id: string;
	flow_version_id: string;
	current_node_id: string | null;
	current_step_id: string | null;
	expires_at: number;
}

export interface FlowRuntimeStartRequest {
	flow_kind?: 'login' | 'registration' | 'approve' | 'account' | `custom:${string}`;
	target_type?: 'tenant' | 'oidc_client' | 'saml_sp';
	target_id?: string | null;
	client_id?: string;
	saml_sp_id?: string;
	scope?: string | string[];
	requested_scope?: string | string[];
	locale?: string;
	requested_locale?: string;
	authorization_challenge_id?: string;
	saml_request_id?: string;
	saml_sp_entity_id?: string;
	return_to?: string;
	resume_interaction_id?: string;
	contract_hash?: string;
	signature?: string;
}

export interface FlowRuntimeStartResponse {
	schema_version: string;
	interaction: FlowRuntimeInteraction;
	assignment?: {
		target_type: string;
		target_id: string | null;
		flow_kind: string;
	};
	contract: FlowRuntimeContract;
	contract_hash: string;
	signature: string;
	expires_in: number;
	resumed: boolean;
}

export interface FlowRuntimeSubmitRequest {
	step_id: string;
	node_id?: string;
	selected_handle?: string;
	contract_hash: string;
	signature: string;
	input?: unknown;
}

export interface FlowRuntimeSubmitResponse {
	schema_version: string;
	interaction: FlowRuntimeInteraction;
	step: FlowRuntimeStep | null;
	completed: boolean;
	output: {
		action: string;
		protocol_continuation?: Record<string, unknown>;
		redirect_url?: string;
	} | null;
}

export interface FlowRuntimeEmailVerificationChallenge {
	available: boolean;
	challenge_id?: string;
	nonce?: string;
	expires_in?: number;
	interaction_id?: string;
	step_id?: string;
}

export interface FlowRuntimeApiResult<T> {
	data?: T;
	error?: APIError & {
		category?: string;
		action?: string;
		interaction_id?: string;
	};
}

async function flowRuntimeFetch<T>(
	endpoint: string,
	body: object
): Promise<FlowRuntimeApiResult<T>> {
	try {
		const headers = buildDiagnosticHeaders();
		headers.set('Content-Type', 'application/json');
		const response = await authrimFetch(endpoint, {
			baseUrl: resolveApiBaseUrl(),
			method: 'POST',
			headers,
			body: JSON.stringify(body)
		});
		const payload = (await response.json().catch(() => ({}))) as T &
			FlowRuntimeApiResult<T>['error'];
		if (!response.ok) {
			return { error: payload };
		}
		return { data: payload as T };
	} catch {
		return {
			error: {
				error: 'network_error',
				error_description: 'Network error occurred'
			}
		};
	}
}

export const flowRuntimeAPI = {
	start(input: FlowRuntimeStartRequest) {
		return flowRuntimeFetch<FlowRuntimeStartResponse>('/api/v1/login/interactions/start', input);
	},

	submit(interactionId: string, input: FlowRuntimeSubmitRequest) {
		return flowRuntimeFetch<FlowRuntimeSubmitResponse>(
			`/api/v1/login/interactions/${encodeURIComponent(interactionId)}/submit`,
			input
		);
	},

	createEmailVerificationChallenge(
		interactionId: string,
		input: Pick<FlowRuntimeSubmitRequest, 'step_id' | 'contract_hash' | 'signature'>
	) {
		return flowRuntimeFetch<FlowRuntimeEmailVerificationChallenge>(
			`/api/v1/login/interactions/${encodeURIComponent(interactionId)}/email-verification/challenge`,
			input
		);
	}
};
