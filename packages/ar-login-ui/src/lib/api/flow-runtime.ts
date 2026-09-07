import {
	AuthrimError,
	FlowRuntimeClient,
	type FlowRuntimeComponent,
	type FlowRuntimeConsentPolicyContent,
	type FlowRuntimeConsentPolicyItem,
	type FlowRuntimeConsentPolicyOption,
	type FlowRuntimeContract,
	type FlowRuntimeEmailVerificationChallenge,
	type FlowRuntimeInteraction,
	type FlowRuntimeStartRequest,
	type FlowRuntimeStartResponse,
	type FlowRuntimeStep,
	type FlowRuntimeSubmitRequest,
	type FlowRuntimeSubmitResponse,
	type HttpClient,
	type HttpOptions,
	type HttpResponse
} from '@authrim/core';
import { authrimFetch } from '../authrim/fetch';
import { buildDiagnosticHeaders, resolveApiBaseUrl, type APIError } from './client';

export type {
	FlowRuntimeComponent,
	FlowRuntimeConsentPolicyContent,
	FlowRuntimeConsentPolicyItem,
	FlowRuntimeConsentPolicyOption,
	FlowRuntimeContract,
	FlowRuntimeEmailVerificationChallenge,
	FlowRuntimeInteraction,
	FlowRuntimeStartRequest,
	FlowRuntimeStartResponse,
	FlowRuntimeStep,
	FlowRuntimeSubmitRequest,
	FlowRuntimeSubmitResponse
};

export interface FlowRuntimeDestinationFieldConsentItem {
	key: string;
	label: string;
	required: boolean;
	nullable: boolean;
	classification: string;
	surfaces: string[];
	required_scopes: string[];
}

export interface FlowRuntimeDestinationFieldConsentContent {
	profile_id: string;
	profile_version_id: string;
	destination_type: 'oidc' | 'saml';
	consent_mode?: 'once' | 'every_time' | 'until_attributes_change' | null;
	fields: FlowRuntimeDestinationFieldConsentItem[];
}

export interface FlowRuntimeApiResult<T> {
	data?: T;
	error?: APIError & {
		category?: string;
		action?: string;
		interaction_id?: string;
	};
}

const flowRuntimeHttpClient: HttpClient = {
	async fetch<T = unknown>(url: string, options: HttpOptions = {}): Promise<HttpResponse<T>> {
		const baseUrl = resolveApiBaseUrl();
		const input = url.startsWith(baseUrl) ? url.slice(baseUrl.length) || '/' : url;
		const response = await authrimFetch(input, {
			baseUrl,
			method: options.method,
			headers: options.headers,
			body: options.body,
			signal: options.signal
		});
		const headers = Object.fromEntries(response.headers.entries());
		const payload = (await response.json().catch(() => ({}))) as T & Record<string, unknown>;
		const data =
			!response.ok && payload && typeof payload === 'object'
				? ({
						...payload,
						error_details: {
							...(typeof payload.error_details === 'object' && payload.error_details
								? payload.error_details
								: {}),
							category: payload.category,
							action: payload.action,
							interaction_id: payload.interaction_id
						}
					} as T)
				: (payload as T);
		return {
			status: response.status,
			statusText: response.statusText,
			headers,
			data,
			ok: response.ok
		};
	}
};

function createFlowRuntimeClient(): FlowRuntimeClient {
	return new FlowRuntimeClient({
		issuer: resolveApiBaseUrl(),
		baseUrl: resolveApiBaseUrl(),
		http: flowRuntimeHttpClient
	});
}

async function withFlowRuntimeResult<T>(
	operation: () => Promise<T>
): Promise<FlowRuntimeApiResult<T>> {
	try {
		return { data: await operation() };
	} catch (error) {
		if (error instanceof AuthrimError) {
			const errorDetails =
				error.details?.errorDetails && typeof error.details.errorDetails === 'object'
					? (error.details.errorDetails as Record<string, unknown>)
					: {};
			return {
				error: {
					error: error.code,
					error_description: error.message,
					category: typeof errorDetails.category === 'string' ? errorDetails.category : undefined,
					action: typeof errorDetails.action === 'string' ? errorDetails.action : undefined,
					interaction_id:
						typeof errorDetails.interaction_id === 'string'
							? errorDetails.interaction_id
							: undefined
				}
			};
		}
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
		return withFlowRuntimeResult(() =>
			createFlowRuntimeClient().start(input, {
				headers: Object.fromEntries(buildDiagnosticHeaders().entries())
			})
		);
	},

	submit(interactionId: string, input: FlowRuntimeSubmitRequest) {
		return withFlowRuntimeResult(() =>
			createFlowRuntimeClient().submit(interactionId, input, {
				headers: Object.fromEntries(buildDiagnosticHeaders().entries())
			})
		);
	},

	createEmailVerificationChallenge(
		interactionId: string,
		input: Pick<FlowRuntimeSubmitRequest, 'step_id' | 'contract_hash' | 'signature'>
	) {
		return withFlowRuntimeResult(() =>
			createFlowRuntimeClient().createEmailVerificationChallenge(interactionId, input, {
				headers: Object.fromEntries(buildDiagnosticHeaders().entries())
			})
		);
	}
};
