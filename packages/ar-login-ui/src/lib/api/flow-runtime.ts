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
	consent_version?: string;
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

/** Going back to a screen (`/back`): the request, and an answer shaped like a submit's. */
export interface FlowRuntimeBackRequest {
	step_id: string;
	node_id?: string;
	contract_hash: string;
	signature: string;
	/** The key of the screen to go back to (a link part's `link_screen`). */
	target_screen: string;
}
export type FlowRuntimeBackResponse = FlowRuntimeSubmitResponse & { back_screens?: string[] };

/** The screen keys an answer says a link can go back to (`back_screens`); none otherwise. */
export function backScreensOf(answer: unknown): string[] {
	const value =
		answer && typeof answer === 'object' ? (answer as Record<string, unknown>).back_screens : null;
	return Array.isArray(value)
		? value.filter(
				(key): key is string => typeof key === 'string' && /^[a-z0-9_-]{1,96}$/u.test(key)
			)
		: [];
}

/** Going back to the application (`/cancel`): the request, and an answer shaped like a consent denial's. */
export interface FlowRuntimeCancelRequest {
	contract_hash: string;
	signature: string;
	/** The step the person is on, when there is one (a failed start has none). */
	step_id?: string;
	node_id?: string;
}
export interface FlowRuntimeCancelResponse {
	redirect_url?: string;
	/** An authorization response in `form_post` mode, asked for with `X-Authrim-Relay`. */
	form_post?: { action: string; fields: Array<[string, string]> };
}

/** Whether a start answer says the sign-in can be left for the application (`cancel_available`). */
export function cancelAvailableOf(answer: unknown): boolean {
	const interaction =
		answer && typeof answer === 'object' ? (answer as Record<string, unknown>).interaction : null;
	return (
		!!interaction &&
		typeof interaction === 'object' &&
		(interaction as Record<string, unknown>).cancel_available === true
	);
}

/** A POST on an interaction (`/back`, `/cancel`): its answer, or the error it gave. */
async function postInteractionAction<T>(
	interactionId: string,
	action: 'back' | 'cancel',
	input: object,
	failedCode: string,
	failedMessage: string,
	extraHeaders: Record<string, string> = {}
): Promise<FlowRuntimeApiResult<T>> {
	try {
		const response = await flowRuntimeHttpClient.fetch<
			T & {
				error?: string;
				error_description?: string;
				error_details?: { category?: string; action?: string; interaction_id?: string };
			}
		>(
			`${resolveApiBaseUrl()}/api/v1/login/interactions/${encodeURIComponent(interactionId)}/${action}`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...Object.fromEntries(buildDiagnosticHeaders().entries()),
					...extraHeaders
				},
				body: JSON.stringify(input)
			}
		);
		if (response.ok) return { data: response.data };
		const body = response.data;
		return {
			error: {
				error: body?.error ?? failedCode,
				error_description: body?.error_description ?? failedMessage,
				category: body?.error_details?.category,
				action: body?.error_details?.action,
				interaction_id: body?.error_details?.interaction_id
			}
		};
	} catch {
		return { error: { error: 'network_error', error_description: 'Network error occurred' } };
	}
}

export const flowRuntimeAPI = {
	start(input: FlowRuntimeStartRequest & { saml_login_nonce?: string }) {
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

	/** From the current screen back to one passed before (the backend decides whether it may). */
	back(
		interactionId: string,
		input: FlowRuntimeBackRequest
	): Promise<FlowRuntimeApiResult<FlowRuntimeBackResponse>> {
		return postInteractionAction<FlowRuntimeBackResponse>(
			interactionId,
			'back',
			input,
			'back_failed',
			'Could not go back'
		);
	},

	/**
	 * Out of the sign-in and back to the application (`/cancel`, only for a Flow that says
	 * `cancel_available`). The answer is the consent denial's: where to send the browser.
	 */
	cancel(
		interactionId: string,
		input: FlowRuntimeCancelRequest
	): Promise<FlowRuntimeApiResult<FlowRuntimeCancelResponse>> {
		return postInteractionAction<FlowRuntimeCancelResponse>(
			interactionId,
			'cancel',
			input,
			'cancel_failed',
			'Could not go back to the app',
			// A form post as data (response_mode=form_post) instead of an HTML page the SPA cannot use.
			{ 'X-Authrim-Relay': 'structured' }
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
